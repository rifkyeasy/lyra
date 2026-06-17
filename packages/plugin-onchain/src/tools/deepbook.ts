/**
 * `deepbook.markets` — read DeepBook spot market data on Sui (mid prices for the
 * core pools). Read-only discovery; never moves funds.
 */

import { DeepBookClient } from '@mysten/deepbook-v3'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import type { OnchainRuntimeContext } from '../types'

/** Core mainnet pool keys shipped with the DeepBook SDK config. */
const DEFAULT_POOLS = ['SUI_USDC', 'DEEP_USDC', 'DEEP_SUI', 'WAL_USDC', 'WAL_SUI']

const Schema = z.object({
  pools: z
    .string()
    .optional()
    .describe('Comma-separated pool keys (e.g. "SUI_USDC,DEEP_USDC"). Omit for the core set.'),
})
type Args = z.infer<typeof Schema>

export function makeDeepbookMarkets(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'deepbook.markets',
    description:
      'Read DeepBook spot market data on Sui: mid price for the core pools (SUI/USDC, DEEP/USDC, WAL/USDC, ...). Read-only market context for execution.',
    searchHint: 'deepbook market price pool spot orderbook mid quote sui usdc liquidity',
    schema: Schema,
    handler: async args => {
      try {
        const db = new DeepBookClient({
          // cast: @mysten/deepbook-v3 bundles a different @mysten/sui minor; the
          // client is runtime-compatible (verified live) but not type-identical.
          client: ctx.client as never,
          address: ctx.agentAddress,
          env: ctx.network,
        })
        const keys = args.pools
          ? args.pools
              .split(',')
              .map(s => s.trim())
              .filter(Boolean)
          : DEFAULT_POOLS
        const markets = await Promise.all(
          keys.map(async pool => {
            try {
              const mid = await db.midPrice(pool)
              return { pool, midPrice: mid }
            } catch (e) {
              return { pool, error: (e as Error).message.slice(0, 120) }
            }
          }),
        )
        return { ok: true, data: { network: ctx.network, markets } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
