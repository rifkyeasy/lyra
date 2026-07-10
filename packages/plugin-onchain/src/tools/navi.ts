/**
 * NAVI lending tools (the largest Sui lending market by TVL): markets + position
 * (read) and SUI supply/withdraw (policy-gated writes).
 *
 * NAVI's SDK is v1-compatible and exposes PTB builders (`depositCoin`,
 * `withdrawCoin`) that take a @mysten/sui Transaction, so writes flow through the
 * SAME policy → simulate → execute pipeline as sui.send. The dry-run simulate is
 * the safety net for a malformed or out-of-funds action.
 */

import { Transaction } from '@mysten/sui/transactions'
import type { ToolDef } from 'lyra-core'
import { NAVISDKClient, borrowCoin, depositCoin, pool, repayDebt, withdrawCoin } from 'navi-sdk'
import { z } from 'zod'
import { checkMinimum } from '../minimums'
import { evaluatePolicy, suiToMist } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'
import { fundSui, returnSuiToVault } from '../vault-fund'

const SUI_TYPE = '0x2::sui::SUI'

function ensureMainnet(ctx: OnchainRuntimeContext): string | null {
  return ctx.network === 'mainnet' ? null : 'NAVI SDK supports mainnet only'
}

// --- navi.markets ----------------------------------------------------------

export function makeNaviMarkets(ctx: OnchainRuntimeContext): ToolDef<Record<string, never>> {
  return {
    name: 'navi.markets',
    description:
      'Read NAVI lending markets on Sui (the largest Sui money market by TVL): supply/borrow APY and reserves per asset. Read-only discovery.',
    searchHint: 'navi lending market supply borrow apy yield reserves rates earn largest tvl',
    schema: z.object({}),
    handler: async () => {
      const err = ensureMainnet(ctx)
      if (err) return { ok: false, error: err }
      try {
        const c = new NAVISDKClient({ networkType: 'mainnet' })
        const info = (await c.getPoolInfo()) as Record<string, unknown>
        const pools = Object.values(info)
          .map(p => {
            const r = p as {
              coinType?: string
              symbol?: string
              supplyIncentiveApyInfo?: { apy?: number }
              borrowIncentiveApyInfo?: { apy?: number }
              base_supply_rate?: number
              base_borrow_rate?: number
            }
            return {
              symbol: r.symbol ?? r.coinType,
              supplyApy: r.base_supply_rate ?? r.supplyIncentiveApyInfo?.apy ?? null,
              borrowApy: r.base_borrow_rate ?? r.borrowIncentiveApyInfo?.apy ?? null,
            }
          })
          .filter(p => p.symbol)
          .slice(0, 12)
        return { ok: true, data: { protocol: 'navi', network: 'mainnet', pools } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// --- navi.position ---------------------------------------------------------

export function makeNaviPosition(ctx: OnchainRuntimeContext): ToolDef<Record<string, never>> {
  return {
    name: 'navi.position',
    description:
      "The agent's NAVI position: supplied/borrowed balances and health factor (lower = closer to liquidation). Read-only.",
    searchHint: 'navi position portfolio supplied borrowed debt health factor liquidation',
    schema: z.object({}),
    handler: async () => {
      const err = ensureMainnet(ctx)
      if (err) return { ok: false, error: err }
      try {
        const c = new NAVISDKClient({ networkType: 'mainnet' })
        const [health, portfolios] = await Promise.all([
          c.getHealthFactor(ctx.agentAddress).catch(() => null),
          // .d.ts declares 0 args but it accepts an address at runtime.
          (c as { getAllNaviPortfolios(a: string): Promise<unknown> })
            .getAllNaviPortfolios(ctx.agentAddress)
            .catch(() => null),
        ])
        return {
          ok: true,
          data: {
            protocol: 'navi',
            healthFactor: health,
            portfolios: portfolios ? Object.fromEntries(portfolios as Map<string, unknown>) : null,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// --- navi.supply / navi.withdraw (SUI) -------------------------------------

const AmountSchema = z.object({ amount: z.string().min(1).describe('Amount of SUI, e.g. "1.5".') })
type AmountArgs = z.infer<typeof AmountSchema>

async function runNaviWrite(
  ctx: OnchainRuntimeContext,
  amount: string,
  kind: 'supply' | 'withdraw' | 'borrow' | 'repay',
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const err = ensureMainnet(ctx)
  if (err) return { ok: false, error: err }
  const amountMist = suiToMist(amount)
  if (amountMist === undefined || amountMist <= 0n)
    return { ok: false, error: `invalid amount "${amount}"` }
  // Minimum guard for value-moving actions (withdraw brings value back in).
  const minAction = kind === 'borrow' ? 'borrow' : kind === 'withdraw' ? null : 'supply'
  if (minAction) {
    const tooSmall = checkMinimum(minAction, amountMist)
    if (tooSmall) return { ok: false, error: tooSmall }
  }

  // Policy gate on value-moving actions (borrow creates debt + hands out funds;
  // repay/supply move SUI out). Withdraw pulls the agent's own funds back.
  if (ctx.policy && kind !== 'withdraw') {
    const verdict = evaluatePolicy(
      {
        kind: 'transfer',
        coinType: SUI_TYPE,
        amountMist,
        protocol: kind === 'borrow' ? 'borrow' : 'navi',
      },
      ctx.policy,
    )
    if (!verdict.allowed)
      return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
  }

  try {
    const tx = new Transaction()
    const suiPool = (pool as Record<string, unknown>).Sui
    if (kind === 'supply') {
      // Source the supply from the treasury vault (policy-enforced) when wired.
      const coin = fundSui(tx, ctx, amountMist, {
        protocol: '0x0',
        kind: 'supply',
        memo: 'navi supply',
      })
      await depositCoin(tx as never, suiPool as never, coin as never, Number(amountMist))
    } else if (kind === 'withdraw') {
      // navi-sdk's withdrawCoin already wraps the withdrawn Balance into a Coin
      // (via coin::from_balance) and returns [coin]. Option 1: cycle it back into
      // the vault (treasury stays intact); fall back to the agent when no vault.
      const [coin] = await withdrawCoin(tx as never, suiPool as never, Number(amountMist))
      if (!returnSuiToVault(tx, ctx, coin as never))
        tx.transferObjects([coin as never], ctx.agentAddress)
    } else if (kind === 'borrow') {
      // Borrow against supplied collateral; park the borrowed SUI in the vault
      // (spendable under policy) when wired, else hand it to the agent.
      const [coin] = await borrowCoin(tx as never, suiPool as never, Number(amountMist))
      if (!returnSuiToVault(tx, ctx, coin as never))
        tx.transferObjects([coin as never], ctx.agentAddress)
    } else {
      // repay: draw the repayment from the vault (policy-enforced) and pay the debt.
      const coin = fundSui(tx, ctx, amountMist, {
        protocol: '0x0',
        kind: 'repay',
        memo: 'navi repay',
      })
      await repayDebt(tx as never, suiPool as never, coin as never, Number(amountMist))
    }

    const sim = await simulate(ctx.client, tx, ctx.agentAddress)
    if (!sim.ok) return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }

    const res = await ctx.client.signAndExecuteTransaction({
      signer: ctx.keypair,
      transaction: tx,
      options: { showEffects: true },
    })
    if (res.effects?.status?.status !== 'success') {
      return { ok: false, error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}` }
    }
    // Wait for the tx to settle/index so a follow-up action (e.g. an immediate
    // withdraw after a supply) doesn't race NAVI's not-yet-settled accounting.
    await ctx.client.waitForTransaction({ digest: res.digest })
    return {
      ok: true,
      data: {
        protocol: 'navi',
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

export function makeNaviSupply(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'navi.supply',
    description:
      'Supply (deposit) idle SUI into NAVI to earn lending yield. Policy-checked, simulated, then executed.',
    searchHint: 'navi supply deposit lend sui earn yield idle',
    schema: AmountSchema,
    handler: async args => runNaviWrite(ctx, args.amount, 'supply'),
  }
}

export function makeNaviWithdraw(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'navi.withdraw',
    description: 'Withdraw supplied SUI from NAVI back to the agent. Simulated, then executed.',
    searchHint: 'navi withdraw redeem unlend remove sui',
    schema: AmountSchema,
    handler: async args => runNaviWrite(ctx, args.amount, 'withdraw'),
  }
}

export function makeNaviBorrow(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'navi.borrow',
    description:
      'Borrow SUI from NAVI against supplied collateral. Requires an existing supply position with enough health factor; the pre-flight simulation fails cleanly if under-collateralized. Policy-checked, simulated, then executed.',
    searchHint: 'navi borrow loan leverage debt against collateral sui',
    schema: AmountSchema,
    handler: async args => runNaviWrite(ctx, args.amount, 'borrow'),
  }
}

export function makeNaviRepay(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'navi.repay',
    description: 'Repay borrowed SUI debt on NAVI. Simulated, then executed.',
    searchHint: 'navi repay pay back debt loan close sui',
    schema: AmountSchema,
    handler: async args => runNaviWrite(ctx, args.amount, 'repay'),
  }
}
