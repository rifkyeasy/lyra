/**
 * Scallop lending tools (supporting integration): markets + position (read) and
 * SUI supply/withdraw (policy-gated writes).
 *
 * Scallop is an over-collateralized money market on Sui (mainnet-only SDK).
 * Writes are SUI-denominated so the MIST policy cap applies directly, and they
 * route through the same policy → simulate → execute pipeline as sui.send. The
 * dry-run simulate is the safety net: a malformed or out-of-funds supply/
 * withdraw is caught before broadcast.
 */

import { Scallop } from '@scallop-io/sui-scallop-sdk'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { checkMinimum } from '../minimums'
import { evaluatePolicy, suiToMist } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'

const SUI_TYPE = '0x2::sui::SUI'

function ensureMainnet(ctx: OnchainRuntimeContext): string | null {
  return ctx.network === 'mainnet' ? null : 'Scallop SDK supports mainnet only'
}

async function newScallop(ctx: OnchainRuntimeContext): Promise<Scallop> {
  return new Scallop({ networkType: 'mainnet', walletAddress: ctx.agentAddress })
}

// --- scallop.markets -------------------------------------------------------

const MarketsSchema = z.object({
  coins: z
    .string()
    .optional()
    .describe('Comma-separated coin names, e.g. "sui,usdc,usdt". Default sui,usdc,usdt.'),
})
type MarketsArgs = z.infer<typeof MarketsSchema>

export function makeScallopMarkets(ctx: OnchainRuntimeContext): ToolDef<MarketsArgs> {
  return {
    name: 'scallop.markets',
    description:
      'Read Scallop lending markets on Sui: supply APY, borrow APY, and utilization per asset. Read-only discovery for where idle funds could earn yield.',
    searchHint: 'scallop lending market supply apy borrow yield utilization rates earn',
    schema: MarketsSchema,
    handler: async args => {
      const err = ensureMainnet(ctx)
      if (err) return { ok: false, error: err }
      try {
        const sdk = await newScallop(ctx)
        const q = await sdk.createScallopQuery()
        await q.init()
        const coins = args.coins
          ?.split(',')
          .map(s => s.trim())
          .filter(Boolean) ?? ['sui', 'usdc', 'usdt']
        const pools = await Promise.all(
          coins.map(async coin => {
            try {
              const p = await q.getMarketPool(coin)
              return {
                coin,
                supplyApy: p?.supplyApy ?? null,
                borrowApy: p?.borrowApy ?? null,
                utilization: p?.utilizationRate ?? null,
              }
            } catch (e) {
              return { coin, error: (e as Error).message.slice(0, 100) }
            }
          }),
        )
        return { ok: true, data: { protocol: 'scallop', network: 'mainnet', pools } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// --- scallop.position ------------------------------------------------------

const PositionSchema = z.object({})
type PositionArgs = z.infer<typeof PositionSchema>

export function makeScallopPosition(ctx: OnchainRuntimeContext): ToolDef<PositionArgs> {
  return {
    name: 'scallop.position',
    description:
      "The agent's Scallop position: total supplied, collateral, debt, and per-asset lendings/borrowings. Read-only.",
    searchHint: 'scallop position portfolio supplied collateral debt lending borrowing health',
    schema: PositionSchema,
    handler: async () => {
      const err = ensureMainnet(ctx)
      if (err) return { ok: false, error: err }
      try {
        const sdk = await newScallop(ctx)
        const q = await sdk.createScallopQuery()
        await q.init()
        const p = await q.getUserPortfolio({ walletAddress: ctx.agentAddress })
        return {
          ok: true,
          data: {
            protocol: 'scallop',
            totalSupplyValue: p?.totalSupplyValue ?? 0,
            totalCollateralValue: p?.totalCollateralValue ?? 0,
            totalDebtValue: p?.totalDebtValue ?? 0,
            lendings: (p?.lendings ?? []).map(
              (l: { coinName?: string; suppliedCoin?: number; suppliedValue?: number }) => ({
                coin: l.coinName,
                supplied: l.suppliedCoin,
                value: l.suppliedValue,
              }),
            ),
            borrowings: p?.borrowings ?? [],
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// --- scallop.supply / scallop.withdraw (SUI) -------------------------------

const AmountSchema = z.object({
  amount: z.string().min(1).describe('Amount of SUI, e.g. "1.5".'),
})
type AmountArgs = z.infer<typeof AmountSchema>

// Scallop redeems a MARKET-COIN amount on withdraw (not underlying SUI). We
// find the agent's SUI market coin by type pattern (robust to package upgrades).
const MARKET_COIN_SUI_RE = /::reserve::MarketCoin<0x0*2::sui::SUI>$/

async function runScallopWrite(
  ctx: OnchainRuntimeContext,
  amount: string,
  kind: 'supply' | 'withdraw',
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const err = ensureMainnet(ctx)
  if (err) return { ok: false, error: err }
  const amountMist = suiToMist(amount)
  if (amountMist === undefined || amountMist <= 0n)
    return { ok: false, error: `invalid amount "${amount}"` }
  // Minimum guard on supply (withdraw pulls the agent's own funds back).
  if (kind === 'supply') {
    const tooSmall = checkMinimum('supply', amountMist)
    if (tooSmall) return { ok: false, error: tooSmall }
  }

  // Policy gate on the value-moving supply.
  if (ctx.policy && kind === 'supply') {
    const verdict = evaluatePolicy(
      { kind: 'transfer', coinType: SUI_TYPE, amountMist, protocol: 'scallop' },
      ctx.policy,
    )
    if (!verdict.allowed)
      return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
  }

  try {
    const sdk = await newScallop(ctx)
    const builder = await sdk.createScallopBuilder()
    const tx = builder.createTxBlock()
    tx.setSender(ctx.agentAddress)
    // depositQuick's 3rd arg returnSCoin=false keeps the old market-coin standard.
    let out: unknown
    if (kind === 'supply') {
      out = await tx.depositQuick(Number(amountMist), 'sui', false)
    } else {
      // withdrawQuick redeems a MARKET-COIN amount, not underlying SUI. Convert
      // the requested SUI to market coins at the position's rate and clamp to the
      // held balance, so a full/over-withdraw cleanly redeems everything.
      const [balances, q] = await Promise.all([
        ctx.client.getAllBalances({ owner: ctx.agentAddress }),
        sdk.createScallopQuery().then(async query => {
          await query.init()
          return query
        }),
      ])
      const mc = balances.find(b => MARKET_COIN_SUI_RE.test(b.coinType))
      const heldMc = BigInt(mc?.totalBalance ?? '0')
      if (heldMc <= 0n) return { ok: false, error: 'no Scallop SUI position to withdraw' }
      const port = (await q.getUserPortfolio({ walletAddress: ctx.agentAddress })) as {
        lendings?: Array<{ coinName?: string; suppliedCoin?: number }>
      }
      const supplied = (port.lendings ?? []).find(l => l.coinName === 'sui')?.suppliedCoin ?? 0
      const suppliedMist = BigInt(Math.floor(supplied * 1e9))
      // redeem = requested/rate, where rate = supplied/heldMc; clamp to heldMc.
      let redeemMc = suppliedMist > 0n ? (amountMist * heldMc) / suppliedMist : heldMc
      if (redeemMc > heldMc || redeemMc <= 0n) redeemMc = heldMc
      out = await tx.withdrawQuick(Number(redeemMc), 'sui')
    }
    if (out) tx.transferObjects([out as never], ctx.agentAddress)
    const transaction = tx.txBlock

    const sim = await simulate(ctx.client, transaction, ctx.agentAddress)
    if (!sim.ok) return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }

    const res = await ctx.client.signAndExecuteTransaction({
      signer: ctx.keypair,
      transaction,
      options: { showEffects: true },
    })
    if (res.effects?.status?.status !== 'success') {
      return { ok: false, error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}` }
    }
    // Wait for the tx to settle/index so a follow-up action (e.g. an immediate
    // withdraw after a supply) doesn't race the not-yet-indexed position.
    await ctx.client.waitForTransaction({ digest: res.digest })
    return {
      ok: true,
      data: {
        protocol: 'scallop',
        action: kind,
        amountSui: amount,
        digest: res.digest,
        simGasUsed: sim.gasUsed,
        policyEnforced: ctx.policy != null,
      },
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 240) }
  }
}

export function makeScallopSupply(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'scallop.supply',
    description:
      'Supply (deposit) idle SUI into Scallop to earn lending yield. Policy-checked, simulated, then executed.',
    searchHint: 'scallop supply deposit lend sui earn yield idle',
    schema: AmountSchema,
    handler: async args => runScallopWrite(ctx, args.amount, 'supply'),
  }
}

export function makeScallopWithdraw(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'scallop.withdraw',
    description: 'Withdraw supplied SUI from Scallop back to the agent. Simulated, then executed.',
    searchHint: 'scallop withdraw redeem unlend remove sui',
    schema: AmountSchema,
    handler: async args => runScallopWrite(ctx, args.amount, 'withdraw'),
  }
}

// NOTE: Scallop borrow/repay require opening a Scallop obligation + posting
// collateral (a separate flow from lending deposits — borrowQuick alone aborts
// "No obligation found"). Until that flow is wired, borrowing routes through the
// verified NAVI/Suilend adapters instead, so we don't ship a borrow tool here
// that can't execute.
