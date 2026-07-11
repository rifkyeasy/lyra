/**
 * Canonical on-chain protocol registry — the SINGLE SOURCE OF TRUTH for the
 * policy's protocol allowlist, shared by the tools (which tag a vault_spend with a
 * protocol id), the console UI (which lets the owner toggle each one), and the
 * landing. Adding a protocol is ONE entry in `REGISTRY` below — `PROTOCOL_IDS`,
 * `PROTOCOL_LABELS`, and `ALLOWLISTABLE_PROTOCOLS` are all derived from it, and the
 * web + landing import `ALLOWLISTABLE_PROTOCOLS` from here (via the package's
 * `./protocol-ids` subpath) instead of maintaining their own copies.
 *
 * The ids are STABLE labels: a protocol upgrading its package doesn't change the tag
 * (the tag is a self-reported label for the allowlist, not the call target), so an
 * owner's allowlist keeps working across protocol upgrades. Sourced from each
 * protocol's SDK on mainnet.
 *
 * This file is a dependency-free leaf so the browser can import it safely.
 *
 * `0x0` is the reserved "no specific protocol" tag used by transfers + swaps —
 * always allowed by the policy (they're bounded by budget/cap/coin/recipient/
 * slippage instead), so restricting protocols never blocks a plain transfer/swap.
 */
export const NO_PROTOCOL = '0x0'

/** The one place a protocol is declared. Everything below is derived. */
const REGISTRY = [
  { key: 'suiStaking', id: '0x3', label: 'Sui staking' },
  {
    key: 'navi',
    id: '0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb',
    label: 'NAVI',
  },
  {
    key: 'suilend',
    id: '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf',
    label: 'Suilend',
  },
  {
    key: 'volo',
    id: '0x68d22cf8bdbcd11ecba1e094922873e4080d4d11133e2443fddda0bfd11dae20',
    label: 'Volo (vSUI)',
  },
  {
    key: 'scallop',
    id: '0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805',
    label: 'Scallop',
  },
  // The type-defining (original) Walrus package — where `StakedWal` lives — as the
  // stable tag for WAL staking (survives Walrus package upgrades).
  {
    key: 'walrusStaking',
    id: '0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77',
    label: 'Walrus staking',
  },
] as const

export type ProtocolKey = (typeof REGISTRY)[number]['key']

/** `key → package id`, for the tools that tag a vault_spend. */
export const PROTOCOL_IDS = Object.fromEntries(REGISTRY.map(p => [p.key, p.id])) as Record<
  ProtocolKey,
  string
>

/** `package id → human label`, for the owner UI + receipts. */
export const PROTOCOL_LABELS: Record<string, string> = Object.fromEntries(
  REGISTRY.map(p => [p.id, p.label]),
)

/** The allowlistable protocols in display order, for building the owner UI. */
export const ALLOWLISTABLE_PROTOCOLS: { key: ProtocolKey; id: string; label: string }[] =
  REGISTRY.map(p => ({ key: p.key, id: p.id, label: p.label }))
