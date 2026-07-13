/**
 * `swap` — execute a token swap on Sui via the 7k aggregator (best route across
 * Cetus, FlowX, Bluefin, DeepBook, ...). Runs through the same policy → simulate
 * → execute pipeline as every other write.
 *
 * Why 7k and not the Cetus aggregator directly: Cetus's aggregator SDK pins
 * @mysten/sui v2 (incompatible with this stack's v1.45), and DeepBook's own
 * swap needs DEEP for fees + a 1-SUI min lot. 7k (@7kprotocol/sdk-ts) is
 * v1-compatible and routes across all of them, paying fees from the route.
 */

import { MetaAg } from '@7kprotocol/sdk-ts'
import { Transaction, coinWithBalance } from '@mysten/sui/transactions'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { type CoinInfo, decimalToBase, resolveCoin } from '../coins'
import { checkMinimum } from '../minimums'
import { evaluatePolicy } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'
import { fundSui } from '../vault-fund'

const SUI_TYPE = '0x2::sui::SUI'
/** Default max slippage when neither the call nor the policy specifies one. */
const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%

const Schema = z.object({
  from: z.string().min(1).describe('Input coin: symbol (sui, usdc, deep, wal) or full coin type.'),
  to: z.string().min(1).describe('Output coin: symbol or full coin type.'),
  amount: z.string().min(1).describe('Input amount in whole units of `from`, e.g. "1".'),
  slippageBps: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .describe('Max slippage tolerance in basis points (default 50 = 0.5%). Capped by policy.'),
})
type Args = z.infer<typeof Schema>

export function makeSwap(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'swap',
    description:
      'Swap one coin for another on Sui via the 7k aggregator (best route across Cetus/FlowX/Bluefin/DeepBook). Policy-checked → simulated → executed. Use for "swap 1 SUI to USDC", "trade X for Y".',
    searchHint: 'swap exchange trade convert dex aggregator best route sui usdc buy sell',
    schema: Schema,
    handler: async args => {
      if (ctx.network !== 'mainnet') return { ok: false, error: 'swap supports mainnet only' }
      try {
        // Resolve BOTH coins to their real decimals (registry or on-chain
        // metadata) — never guess, or a 6-decimal coin gets scaled 1000x.
        const from: CoinInfo | undefined = await resolveCoin(ctx.client, args.from)
        const to: CoinInfo | undefined = await resolveCoin(ctx.client, args.to)
        if (!from)
          return {
            ok: false,
            error: `unknown coin "${args.from}" (specify a known symbol or full coin type)`,
          }
        if (!to)
          return {
            ok: false,
            error: `unknown coin "${args.to}" (specify a known symbol or full coin type)`,
          }
        if (from.type === to.type) return { ok: false, error: 'from and to are the same coin' }
        const amountIn = decimalToBase(args.amount, from.decimals)
        if (amountIn === undefined || amountIn <= 0n) {
          return { ok: false, error: `invalid amount "${args.amount}"` }
        }
        // Minimum only bounds SUI-denominated input (amountIn is then in MIST).
        if (from.type === SUI_TYPE) {
          const tooSmall = checkMinimum('swap', amountIn)
          if (tooSmall) return { ok: false, error: tooSmall }
        }

        // The slippage we'll actually enforce on the route: the caller's request
        // (or a tight 0.5% default). The policy check below BLOCKS it if it
        // exceeds the policy's max — so the cap is real, not a comparison of the
        // policy value against itself.
        const requestedSlippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS

        // Policy gate. The MIST per-tx cap is SUI-denominated, so it only bounds
        // SUI-input swaps; the slippage/protocol/expiry checks always apply.
        if (ctx.policy) {
          const verdict = evaluatePolicy(
            {
              kind: 'swap',
              coinType: from.type,
              amountMist: from.type === SUI_TYPE ? amountIn : 0n,
              toCoinType: to.type,
              protocol: 'swap',
              slippageBps: requestedSlippageBps,
            },
            ctx.policy,
          )
          if (!verdict.allowed)
            return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
        }

        const me = ctx.agentAddress
        const ag = new MetaAg({ slippageBps: requestedSlippageBps })
        // Quote without the SDK's internal pre-simulation (it throws on routes it
        // can't simulate); we simulate the chosen route ourselves below.
        const quotes = (
          await ag.quote({
            coinTypeIn: from.type,
            coinTypeOut: to.type,
            amountIn: amountIn.toString(),
            signer: me,
          })
        )
          .filter(Boolean)
          .sort((a, b) => Number(b.amountOut ?? 0) - Number(a.amountOut ?? 0))
        if (quotes.length === 0) return { ok: false, error: 'no swap route found' }

        // Best-execution with reliability: try routes in output order, skipping
        // any that fail simulation (some providers build PTBs that leave an
        // unconsumed value / revert). Use the first that simulates cleanly.
        let used: {
          provider: string
          amountOut: number
          tx: Transaction
          gasUsed?: string
        } | null = null
        const failures: string[] = []
        for (const q of quotes) {
          const tx = new Transaction()
          tx.setSender(me)
          tx.setGasBudget(150_000_000)
          try {
            // SUI input is sourced from the treasury vault (policy-enforced) when
            // wired; non-SUI input comes from the agent's own balance (the vault
            // is SUI-typed). The swapped output goes to the agent.
            const coinIn =
              from.type === SUI_TYPE
                ? fundSui(tx, ctx, amountIn, {
                    protocol: '0x0',
                    kind: 'swap',
                    memo: `swap to ${args.to}`,
                  })
                : coinWithBalance({ type: from.type, balance: amountIn })
            const coinOut = await ag.swap({ quote: q, signer: me, tx, coinIn: coinIn as never })
            tx.transferObjects([coinOut as never], me)
            const sim = await simulate(ctx.client, tx, me)
            if (sim.ok) {
              used = {
                provider: String(q.provider),
                amountOut: Number(q.amountOut ?? 0),
                tx,
                gasUsed: sim.gasUsed,
              }
              break
            }
            failures.push(`${q.provider}: ${sim.reason}`)
          } catch (e) {
            failures.push(`${q.provider}: ${(e as Error).message.slice(0, 60)}`)
          }
        }
        if (!used)
          return { ok: false, error: `no route simulated cleanly — ${failures.join(' | ')}` }

        const res = await ctx.client.signAndExecuteTransaction({
          signer: ctx.keypair,
          transaction: used.tx,
          options: { showEffects: true },
        })
        if (res.effects?.status?.status !== 'success') {
          return {
            ok: false,
            error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}`,
          }
        }
        await ctx.client.waitForTransaction({ digest: res.digest })

        return {
          ok: true,
          data: {
            from: args.from,
            to: args.to,
            amountIn: args.amount,
            amountOut: (used.amountOut / 10 ** to.decimals).toString(),
            route: used.provider,
            slippageBps: requestedSlippageBps,
            digest: res.digest,
            simGasUsed: used.gasUsed,
            policyEnforced: ctx.policy != null,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
