/**
 * Central coin resolver. One place that maps a symbol or full coin type to its
 * canonical type + decimals — and, critically, NEVER guesses decimals.
 *
 * The old per-tool `resolve()` defaulted any unknown coin to 9 decimals, so
 * "swap 100 <6-decimal-coin>" computed 100 * 10^9 (1000x the intended amount) —
 * a real fund-loss path. Here, a coin outside the built-in registry has its
 * decimals read from on-chain `CoinMetadata`; if that can't be resolved, we
 * return undefined and the caller refuses the action rather than guessing.
 */

import type { SuiClient } from '@mysten/sui/client'
import { normalizeCoinType } from './policy'

// Re-export so tools import both the resolver and the amount parser from one place.
export { decimalToBase } from './policy'

export interface CoinInfo {
  type: string
  decimals: number
}

/** Canonical mainnet coin types + decimals for common assets (fast, no RPC). */
export const COIN_REGISTRY: Record<string, CoinInfo> = {
  sui: { type: '0x2::sui::SUI', decimals: 9 },
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

const byType = new Map(
  Object.values(COIN_REGISTRY).map(c => [normalizeCoinType(c.type), c] as const),
)
/** Cache of on-chain metadata lookups so we hit the RPC once per coin type. */
const metaCache = new Map<string, CoinInfo>()

/** Registry-only lookup (sync). Returns undefined for anything not built-in. */
export function resolveKnown(input: string): CoinInfo | undefined {
  const k = input.trim().toLowerCase()
  if (COIN_REGISTRY[k]) return COIN_REGISTRY[k]
  const type = input.trim()
  if (type.includes('::')) return byType.get(normalizeCoinType(type))
  return undefined
}

/**
 * Resolve a symbol or full coin type to `{ type, decimals }`. Symbols and known
 * types hit the registry; a full coin type not in the registry has its decimals
 * fetched from on-chain `CoinMetadata`. A bare unknown symbol (no `::`) or a type
 * with no metadata resolves to undefined — the caller must then refuse, never
 * assume a decimals value.
 */
export async function resolveCoin(client: SuiClient, input: string): Promise<CoinInfo | undefined> {
  const known = resolveKnown(input)
  if (known) return known
  const type = input.trim()
  if (!type.includes('::')) return undefined // an unknown bare symbol — can't resolve
  const norm = normalizeCoinType(type)
  const cached = metaCache.get(norm)
  if (cached) return cached
  try {
    const meta = await client.getCoinMetadata({ coinType: type })
    if (meta && typeof meta.decimals === 'number') {
      const info: CoinInfo = { type, decimals: meta.decimals }
      metaCache.set(norm, info)
      return info
    }
  } catch {
    // fall through to undefined — never guess
  }
  return undefined
}
