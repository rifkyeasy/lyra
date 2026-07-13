/**
 * `cetus.quote` — best-execution price discovery across Cetus (Sui's largest
 * DEX) via the Cetus aggregator. Read-only: it finds the best route and output
 * for a swap so the agent can compare venues (e.g. vs DeepBook) before acting.
 *
 * Note: on-chain swap execution is intentionally NOT wired here. The Cetus
 * aggregator SDK builds transactions with @mysten/sui v2, which is incompatible
 * with this stack's v1 policy → simulate → execute pipeline. Quoting uses the
 * aggregator's router with our v1 client; executing a Cetus swap would require
 * migrating the whole stack to SDK v2.
 */

import { AggregatorClient } from '@cetusprotocol/aggregator-sdk'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { type CoinInfo, decimalToBase, resolveCoin } from '../coins'
import type { OnchainRuntimeContext } from '../types'

const Schema = z.object({
  from: z.string().min(1).describe('Input coin: symbol (sui, usdc, deep, wal) or full coin type.'),
  to: z.string().min(1).describe('Output coin: symbol or full coin type.'),
  amount: z.string().min(1).describe('Input amount in whole units of `from`, e.g. "1.5".'),
})
type Args = z.infer<typeof Schema>

export function makeCetusQuote(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'cetus.quote',
    description:
      'Quote the best Cetus swap route on Sui (read-only): input → output amount and implied price across Cetus pools. Use to compare execution venues before proposing a swap. Does not execute.',
    searchHint: 'cetus swap quote price route dex best execution exchange convert',
    schema: Schema,
    handler: async args => {
      if (ctx.network !== 'mainnet')
        return { ok: false, error: 'Cetus aggregator supports mainnet only' }
      try {
        const from: CoinInfo | undefined = await resolveCoin(ctx.client, args.from)
        const to: CoinInfo | undefined = await resolveCoin(ctx.client, args.to)
        if (!from) return { ok: false, error: `unknown coin "${args.from}"` }
        if (!to) return { ok: false, error: `unknown coin "${args.to}"` }
        const amountIn = decimalToBase(args.amount, from.decimals)
        if (amountIn === undefined || amountIn <= 0n) {
          return { ok: false, error: `invalid amount "${args.amount}"` }
        }

        // The aggregator accepts our v1 client for read-only routing.
        const agg = new AggregatorClient({ signer: ctx.agentAddress, client: ctx.client as never })
        const route = await agg.findRouters({
          from: from.type,
          target: to.type,
          amount: amountIn,
          byAmountIn: true,
        })
        if (!route || route.amountOut == null) return { ok: false, error: 'no Cetus route found' }

        const out = BigInt(route.amountOut.toString())
        const price = Number(out) / 10 ** to.decimals / (Number(amountIn) / 10 ** from.decimals)
        return {
          ok: true,
          data: {
            venue: 'cetus',
            from: args.from,
            to: args.to,
            amountIn: args.amount,
            amountOut: (Number(out) / 10 ** to.decimals).toString(),
            price: `${price.toPrecision(6)} ${args.to}/${args.from}`,
            note: 'read-only quote; Cetus swap execution not wired (SDK v2 vs stack v1)',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
