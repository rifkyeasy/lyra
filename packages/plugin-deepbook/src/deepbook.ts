/**
 * DeepBook (Sui mainnet) read-only market context via the public indexer.
 *
 * Gives the agent protocol-aware awareness — live pools, prices, and order-book
 * depth on Sui's native CLOB — so a goal like "what's the SUI/USDC price on
 * DeepBook?" can be answered from real on-chain liquidity. Execution (placing
 * orders) routes through the same policy guard as any other spend.
 */
export const DEEPBOOK_INDEXER = 'https://deepbook-indexer.mainnet.mystenlabs.com'

export interface DeepBookPool {
  pool_id: string
  pool_name: string
  base_asset_symbol?: string
  quote_asset_symbol?: string
}

export interface PoolTicker {
  pool: string
  lastPrice?: number
  baseVolume?: number
  quoteVolume?: number
}

/** List all DeepBook pools on mainnet. */
export async function getPools(): Promise<DeepBookPool[]> {
  const r = await fetch(`${DEEPBOOK_INDEXER}/get_pools`)
  if (!r.ok) throw new Error(`deepbook get_pools failed: ${r.status}`)
  return (await r.json()) as DeepBookPool[]
}

/** 24h summary tickers across all pools. */
export async function getSummary(): Promise<PoolTicker[]> {
  const r = await fetch(`${DEEPBOOK_INDEXER}/summary`)
  if (!r.ok) throw new Error(`deepbook summary failed: ${r.status}`)
  const rows = (await r.json()) as Record<string, unknown>[]
  return rows.map((d) => ({
    pool: String(d.trading_pairs ?? d.pool ?? ''),
    lastPrice: d.last_price != null ? Number(d.last_price) : undefined,
    baseVolume: d.base_volume != null ? Number(d.base_volume) : undefined,
    quoteVolume: d.quote_volume != null ? Number(d.quote_volume) : undefined,
  }))
}

/** Mid price for a pool from its top-of-book (level 1). Returns null if empty. */
export async function getMidPrice(poolName: string): Promise<number | null> {
  const r = await fetch(`${DEEPBOOK_INDEXER}/orderbook/${poolName}?level=1`)
  if (!r.ok) return null
  const ob = (await r.json()) as { bids?: [string, string][]; asks?: [string, string][] }
  const bid = ob.bids?.[0]?.[0] != null ? Number(ob.bids[0][0]) : undefined
  const ask = ob.asks?.[0]?.[0] != null ? Number(ob.asks[0][0]) : undefined
  if (bid != null && ask != null) return (bid + ask) / 2
  return bid ?? ask ?? null
}
