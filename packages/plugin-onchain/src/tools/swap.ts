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
import { checkMinimum } from '../minimums'
import { evaluatePolicy } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'
import { fundSui } from '../vault-fund'

const SUI_TYPE = '0x2::sui::SUI'

/** Symbol → mainnet coin type + decimals for the common assets. */
const COINS: Record<string, { type: string; decimals: number }> = {
  sui: { type: SUI_TYPE, decimals: 9 },
  usdc: {
    type: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    decimals: 6,
  },
  deep: {
    type: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
    decimals: 6,
  },
  wal: {
    type: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
    decimals: 9,
  },
}

function resolve(input: string): { type: string; decimals: number } {
  const k = input.trim().toLowerCase()
  return COINS[k] ?? { type: input.trim(), decimals: 9 }
}

const Schema = z.object({
  from: z.string().min(1).describe('Input coin: symbol (sui, usdc, deep, wal) or full coin type.'),
  to: z.string().min(1).describe('Output coin: symbol or full coin type.'),
  amount: z.string().min(1).describe('Input amount in whole units of `from`, e.g. "1".'),
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
        const from = resolve(args.from)
        const to = resolve(args.to)
        if (from.type === to.type) return { ok: false, error: 'from and to are the same coin' }
        const amountIn = BigInt(Math.round(Number(args.amount) * 10 ** from.decimals))
        if (amountIn <= 0n) return { ok: false, error: `invalid amount "${args.amount}"` }
        // Minimum only bounds SUI-denominated input (amountIn is then in MIST).
        if (from.type === SUI_TYPE) {
          const tooSmall = checkMinimum('swap', amountIn)
          if (tooSmall) return { ok: false, error: tooSmall }
        }

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
              slippageBps: ctx.policy.maxSlippageBps,
            },
            ctx.policy,
          )
          if (!verdict.allowed)
            return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
        }

        const me = ctx.agentAddress
        const ag = new MetaAg({ slippageBps: ctx.policy?.maxSlippageBps ?? 100 })
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
