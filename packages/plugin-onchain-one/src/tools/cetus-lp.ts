/**
 * `cetus.add_liquidity` — open a FULL-RANGE Cetus CLMM position, zap-funded from the
 * vault's SUI. In one PTB: draw SUI (policy-gated `vault_spend_capped`) → keep part as
 * one side, swap the rest to the pair coin via the 7k aggregator → open the position
 * via `pool_script_v2::open_position_with_liquidity_by_fix_coin`. The position NFT +
 * any leftover coins land with the agent.
 *
 * Safety: the position amounts are FIXED on the SUI side (which we split to an exact
 * amount), and the swapped side is provided as a SURPLUS (we swap ~52% of the SUI, and
 * a full-range position at the current price needs ~50%), so the add never reverts on
 * an under-funded side — the extra is returned. The whole PTB is SIMULATED before it's
 * signed, so a bad ratio or price move fails cleanly with NO funds moved.
 *
 * The pool ids + Cetus package/config were discovered + verified once with the Cetus
 * CLMM SDK (see cetus-pools.ts); the runtime needs no SDK — full-range ticks are plain
 * arithmetic and Cetus's Move code computes the amounts on-chain.
 */

import { MetaAg } from '@7kprotocol/sdk-ts'
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import {
  CETUS_GLOBAL_CONFIG,
  CETUS_INTEGRATE,
  CETUS_POOLS,
  type CetusPool,
  fullRangeTicks,
  resolveCetusPool,
  tickToU32,
} from '../cetus-pools'
import { decimalToBase } from '../coins'
import { submit } from '../execute'
import { checkMinimum } from '../minimums'
import { policyBlock } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'
import { fundSui } from '../vault-fund'

const SUI_TYPE = '0x2::sui::SUI'
const CLOCK = '0x6'
// Swap this share of the SUI to the pair coin; keep the rest as the fixed side. >50%
// so the swapped (non-fixed) side is a surplus — the add can't revert under-funded.
const SWAP_BPS = 5200n
const SLIPPAGE_BPS = 100 // 1% on the internal zap swap
const LP_GAS_BUDGET = 250_000_000
const HERMES = process.env.LYRA_HERMES_API ?? 'https://hermes.pyth.network'

interface BuiltLp {
  tx: Transaction
  route: string
  swapMist: bigint
}

// Build the full zap PTB: draw → split → swap → open full-range position.
async function buildZapLpTx(
  ctx: OnchainRuntimeContext,
  pool: CetusPool,
  amountMist: bigint,
  swapMist: bigint,
): Promise<BuiltLp> {
  const me = ctx.agentAddress
  const suiIsB = pool.coinTypeB === SUI_TYPE
  const pairType = suiIsB ? pool.coinTypeA : pool.coinTypeB
  const keptMist = amountMist - swapMist

  const tx = new Transaction()
  tx.setSender(me)
  tx.setGasBudget(LP_GAS_BUDGET)

  // Draw the whole SUI amount from the vault (policy-gated), then split off the swap leg.
  const suiCoin = fundSui(tx, ctx, amountMist, {
    protocol: CETUS_INTEGRATE,
    kind: 'lp',
    memo: `lp ${pool.label}`,
  })
  const [swapCoin] = tx.splitCoins(suiCoin, [swapMist]) // suiCoin is now the kept side

  const ag = new MetaAg({ slippageBps: SLIPPAGE_BPS, hermesApi: HERMES })
  const quotes = (
    await ag.quote({
      coinTypeIn: SUI_TYPE,
      coinTypeOut: pairType,
      amountIn: swapMist.toString(),
      signer: me,
    })
  )
    .filter(Boolean)
    .sort((a, b) => Number(b.amountOut ?? 0) - Number(a.amountOut ?? 0))
  const q = quotes[0]
  if (!q?.amountOut) throw new Error(`no swap route SUI → ${pairType.split('::').pop()}`)
  const pairCoin = await ag.swap({ quote: q, signer: me, tx, coinIn: swapCoin as never })
  const pairOut = BigInt(Math.floor(Number(q.amountOut ?? 0)))

  // Map to the pool's A/B ordering and FIX on the SUI side (exact); the swapped side is
  // the surplus max. fixAmountA = true iff SUI is coinA.
  const ticks = fullRangeTicks(pool.tickSpacing)
  const coinA = (suiIsB ? pairCoin : suiCoin) as TransactionObjectArgument
  const coinB = (suiIsB ? suiCoin : pairCoin) as TransactionObjectArgument
  const amountA = suiIsB ? pairOut : keptMist
  const amountB = suiIsB ? keptMist : pairOut

  tx.moveCall({
    target: `${CETUS_INTEGRATE}::pool_script_v2::open_position_with_liquidity_by_fix_coin`,
    typeArguments: [pool.coinTypeA, pool.coinTypeB],
    arguments: [
      tx.object(CETUS_GLOBAL_CONFIG),
      tx.object(pool.poolId),
      tx.pure.u32(tickToU32(ticks.lower)),
      tx.pure.u32(tickToU32(ticks.upper)),
      coinA,
      coinB,
      tx.pure.u64(amountA),
      tx.pure.u64(amountB),
      tx.pure.bool(!suiIsB),
      tx.object(CLOCK),
    ],
  })
  return { tx, route: String(q.provider), swapMist }
}

const Schema = z.object({
  amount: z.string().min(1).describe('SUI to deploy into the position, whole units, e.g. "5".'),
  pool: z
    .string()
    .optional()
    .describe('Pool key (default "sui-usdc") or a Cetus pool id. Only SUI-paired pools.'),
})
type Args = z.infer<typeof Schema>

interface Preflight {
  pool: CetusPool
  amountMist: bigint
  swapMist: bigint
}

// Resolve pool, parse the amount, and run the policy/minimum gates. Kept out of the
// handler so it stays flat. Returns an error string the handler surfaces verbatim.
function preflight(ctx: OnchainRuntimeContext, args: Args): Preflight | { error: string } {
  const pool = resolveCetusPool(args.pool ?? 'sui-usdc')
  if (!pool)
    return {
      error: `unknown pool "${args.pool}". Available: ${CETUS_POOLS.map(p => p.key).join(', ')}`,
    }
  const amountMist = decimalToBase(args.amount, 9)
  if (amountMist === undefined || amountMist <= 0n)
    return { error: `invalid amount "${args.amount}"` }
  const swapMist = (amountMist * SWAP_BPS) / 10_000n
  const tooSmall = checkMinimum('swap', swapMist)
  if (tooSmall) return { error: `amount too small to LP: ${tooSmall}` }
  const pairType = pool.coinTypeB === SUI_TYPE ? pool.coinTypeA : pool.coinTypeB
  const blocked = policyBlock(ctx.policy, {
    kind: 'swap',
    coinType: SUI_TYPE,
    amountMist,
    toCoinType: pairType,
    protocol: CETUS_INTEGRATE,
    slippageBps: SLIPPAGE_BPS,
  })
  if (blocked) return { error: blocked }
  return { pool, amountMist, swapMist }
}

export function makeCetusLp(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'cetus.add_liquidity',
    description:
      'Provide FULL-RANGE liquidity to a Cetus pool, funded from your vault SUI (zaps: keeps half as SUI, swaps half to the pair coin, then adds liquidity). Policy-checked → simulated → executed. Use for "LP into SUI/USDC", "provide liquidity", "add liquidity on Cetus". Only SUI-paired pools.',
    searchHint: 'lp liquidity provide add cetus clmm pool position full range yield farm sui usdc',
    schema: Schema,
    handler: async args => {
      if (ctx.network !== 'mainnet') return { ok: false, error: 'LP supports mainnet only' }
      try {
        const pre = preflight(ctx, args)
        if ('error' in pre) return { ok: false, error: pre.error }
        const { pool, amountMist, swapMist } = pre

        const built = await buildZapLpTx(ctx, pool, amountMist, swapMist)
        // Simulate the whole zap first: a bad ratio / price move fails HERE, no funds moved.
        const sim = await simulate(ctx.client, built.tx, ctx.agentAddress)
        if (!sim.ok)
          return { ok: false, error: `simulation failed (no funds moved): ${sim.reason}` }

        const res = await submit(ctx, built.tx, { showEffects: true })
        if (res.effects?.status?.status !== 'success')
          return {
            ok: false,
            error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}`,
          }
        await ctx.client.waitForTransaction({ digest: res.digest })
        return {
          ok: true,
          data: {
            pool: pool.label,
            poolId: pool.poolId,
            amountInSui: args.amount,
            swappedSui: (Number(built.swapMist) / 1e9).toString(),
            route: built.route,
            range: 'full',
            digest: res.digest,
            note: 'Full-range position opened; the position NFT and any leftover coins are held by your agent. (Remove-liquidity is a separate tool, coming next.)',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
