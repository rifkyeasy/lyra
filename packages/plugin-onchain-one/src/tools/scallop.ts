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

import type { Transaction } from '@mysten/sui/transactions'
import { Scallop } from '@scallop-io/sui-scallop-sdk'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { simulateAndExecute } from '../execute'
import { checkMinimum } from '../minimums'
import { policyBlock, suiToMist } from '../policy'
import { PROTOCOL_IDS } from '../protocol-ids'
import type { OnchainRuntimeContext } from '../types'
import { fundSui, returnSuiToVault } from '../vault-fund'

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

/**
 * Convert the requested SUI amount to the Scallop SUI MARKET-COIN units to redeem
 * on withdraw (withdrawQuick redeems market coins, not underlying SUI), at the
 * position's rate and clamped to the agent's held balance — so a full/over-withdraw
 * cleanly redeems everything. Returns an error when there is nothing to withdraw.
 */
async function scallopRedeemAmount(
  ctx: OnchainRuntimeContext,
  sdk: Scallop,
  amountMist: bigint,
): Promise<bigint | { error: string }> {
  const [balances, q] = await Promise.all([
    ctx.client.getAllBalances({ owner: ctx.agentAddress }),
    sdk.createScallopQuery().then(async query => {
      await query.init()
      return query
    }),
  ])
  const mc = balances.find(b => MARKET_COIN_SUI_RE.test(b.coinType))
  const heldMc = BigInt(mc?.totalBalance ?? '0')
  if (heldMc <= 0n) return { error: 'no Scallop SUI position to withdraw' }
  const port = (await q.getUserPortfolio({ walletAddress: ctx.agentAddress })) as {
    lendings?: Array<{ coinName?: string; suppliedCoin?: number }>
  }
  const supplied = (port.lendings ?? []).find(l => l.coinName === 'sui')?.suppliedCoin ?? 0
  const suppliedMist = BigInt(Math.floor(supplied * 1e9))
  // redeem = requested/rate, where rate = supplied/heldMc; clamp to heldMc.
  let redeemMc = suppliedMist > 0n ? (amountMist * heldMc) / suppliedMist : heldMc
  if (redeemMc > heldMc || redeemMc <= 0n) redeemMc = heldMc
  return redeemMc
}

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
  // Minimum guard + policy gate on the value-moving supply (withdraw pulls the
  // agent's own funds back).
  if (kind === 'supply') {
    const tooSmall = checkMinimum('supply', amountMist)
    if (tooSmall) return { ok: false, error: tooSmall }
    const blocked = policyBlock(ctx.policy, {
      kind: 'transfer',
      coinType: SUI_TYPE,
      amountMist,
      protocol: 'scallop',
    })
    if (blocked) return { ok: false, error: blocked }
  }

  try {
    const sdk = await newScallop(ctx)
    const built = await buildScallopWriteTx(ctx, sdk, amountMist, kind)
    if ('error' in built) return { ok: false, error: built.error }

    // Simulate-before-write, then execute + wait for indexing (shared helper).
    const exec = await simulateAndExecute(ctx, built.tx)
    if (!exec.ok) return exec
    return {
      ok: true,
      data: {
        protocol: 'scallop',
        action: kind,
        amountSui: amount,
        digest: exec.value.digest,
        simGasUsed: exec.value.gasUsed,
        policyEnforced: ctx.policy != null,
      },
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 240) }
  }
}

/**
 * Build the Scallop supply/withdraw PTB: fund the deposit from the vault (supply)
 * or redeem market coins (withdraw), then route the produced coin — cycling
 * withdrawn SUI back into the vault when possible, else to the agent.
 */
async function buildScallopWriteTx(
  ctx: OnchainRuntimeContext,
  sdk: Scallop,
  amountMist: bigint,
  kind: 'supply' | 'withdraw',
): Promise<{ tx: Transaction } | { error: string }> {
  const builder = await sdk.createScallopBuilder()
  const tx = builder.createTxBlock()
  tx.setSender(ctx.agentAddress)
  let out: unknown
  if (kind === 'supply') {
    // Source the deposit from the treasury vault (policy-enforced) when wired,
    // then hand the vault-drawn Coin<SUI> to Scallop's non-quick `deposit` (the
    // `*Quick` helpers auto-select the agent's own coins, so they can't be vault-
    // funded). `deposit` returns the market coin, sent to the agent below.
    const coin = fundSui(tx.txBlock as never, ctx, amountMist, {
      protocol: PROTOCOL_IDS.scallop,
      kind: 'supply',
      memo: 'scallop supply',
    })
    out = await tx.deposit(coin as never, 'sui')
  } else {
    const redeemMc = await scallopRedeemAmount(ctx, sdk, amountMist)
    if (typeof redeemMc === 'object') return { error: redeemMc.error }
    out = await tx.withdrawQuick(Number(redeemMc), 'sui')
  }
  if (out) {
    // Option 1: cycle withdrawn SUI back into the vault (treasury stays intact);
    // supply's market coin and the no-vault case go to the agent.
    const cycled = kind === 'withdraw' && returnSuiToVault(tx.txBlock as never, ctx, out as never)
    if (!cycled) tx.transferObjects([out as never], ctx.agentAddress)
  }
  return { tx: tx.txBlock as Transaction }
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
