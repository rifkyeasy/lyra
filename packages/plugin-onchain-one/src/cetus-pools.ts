/**
 * Curated Cetus CLMM pools + mainnet integrate constants — the data behind the LP
 * tool. Discovered + verified once via the Cetus SDK (see the LP tool's header); the
 * RUNTIME needs no SDK. Pool immutables (coin types, tickSpacing) are fixed at pool
 * creation, and the CURRENT price is read on-chain by Cetus's Move code at execution,
 * so nothing here is fetched live.
 *
 * Integrate package (`published_at`) + GlobalConfig are the values the Cetus SDK
 * resolves for Mainnet; the add-liquidity entry lives at
 * `${CETUS_INTEGRATE}::pool_script_v2::open_position_with_liquidity_by_fix_coin`.
 */

/** Cetus integrate package (the add-liquidity script wrapper), Mainnet published_at. */
export const CETUS_INTEGRATE = '0xb2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d'
/** Cetus CLMM GlobalConfig shared object, Mainnet. */
export const CETUS_GLOBAL_CONFIG =
  '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f'

const SUI = '0x2::sui::SUI'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

export interface CetusPool {
  /** Short key the agent/user names ("sui-usdc"). */
  key: string
  poolId: string
  /** coinTypeA/B in the pool's own ordering (matters for the moveCall type args). */
  coinTypeA: string
  coinTypeB: string
  tickSpacing: number
  feePct: number
  label: string
}

// SUI-paired only for now: the tool zaps from vault SUI, so one side must be SUI.
export const CETUS_POOLS: CetusPool[] = [
  {
    key: 'sui-usdc',
    poolId: '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab',
    coinTypeA: USDC,
    coinTypeB: SUI,
    tickSpacing: 10,
    feePct: 0.05,
    label: 'SUI/USDC 0.05%',
  },
]

export function resolveCetusPool(key: string): CetusPool | undefined {
  const k = key.trim().toLowerCase()
  return CETUS_POOLS.find(p => p.key === k || p.poolId === key.trim())
}

// The CLMM tick bounds; full-range aligns them to the pool's tickSpacing.
const MIN_TICK = -443636
const MAX_TICK = 443636

/** Full-range ticks aligned to `tickSpacing` (a full-range position never leaves range). */
export function fullRangeTicks(tickSpacing: number): { lower: number; upper: number } {
  return {
    lower: Math.ceil(MIN_TICK / tickSpacing) * tickSpacing,
    upper: Math.floor(MAX_TICK / tickSpacing) * tickSpacing,
  }
}

/** Cetus passes tick indices as u32 (2's-complement for negatives). */
export function tickToU32(tick: number): number {
  return Number(BigInt.asUintN(32, BigInt(tick)))
}
