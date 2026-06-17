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
import { NAVISDKClient, depositCoin, pool, withdrawCoin } from 'navi-sdk'
import { z } from 'zod'
import { evaluatePolicy, suiToMist } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'

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
  kind: 'supply' | 'withdraw',
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const err = ensureMainnet(ctx)
  if (err) return { ok: false, error: err }
  const amountMist = suiToMist(amount)
  if (amountMist === undefined || amountMist <= 0n)
    return { ok: false, error: `invalid amount "${amount}"` }

  if (ctx.policy && kind === 'supply') {
    const verdict = evaluatePolicy(
      { kind: 'transfer', coinType: SUI_TYPE, amountMist, protocol: 'navi' },
      ctx.policy,
    )
    if (!verdict.allowed)
      return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
  }

  try {
    const tx = new Transaction()
    const suiPool = (pool as Record<string, unknown>).Sui
    if (kind === 'supply') {
      const [coin] = tx.splitCoins(tx.gas, [amountMist])
      await depositCoin(tx as never, suiPool as never, coin as never, Number(amountMist))
    } else {
      const coin = await withdrawCoin(tx as never, suiPool as never, Number(amountMist))
      tx.transferObjects([coin as never], ctx.agentAddress)
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
