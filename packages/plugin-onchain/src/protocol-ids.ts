/**
 * Canonical on-chain protocol ids for the policy's protocol allowlist.
 *
 * When a tool draws from the vault via `vault_spend`, it tags the action with the
 * protocol's package id. The owner's `allowed_protocols` allowlist (settable via
 * `lyra::policy::set_allowed_protocols`) is checked against this tag on-chain — so
 * an owner can restrict the agent to, say, only staking + NAVI. These ids are the
 * SINGLE SOURCE OF TRUTH shared by the tools (which tag) and the console UI (which
 * lets the owner toggle) so the two never drift.
 *
 * They are STABLE labels: a protocol upgrading its package doesn't change the tag
 * (the tag is a self-reported label for the allowlist, not the call target), so an
 * owner's allowlist keeps working across protocol upgrades. Sourced from each
 * protocol's SDK on mainnet.
 *
 * `0x0` is the reserved "no specific protocol" tag used by transfers + swaps —
 * always allowed by the policy (they're bounded by budget/cap/coin/recipient/
 * slippage instead), so restricting protocols never blocks a plain transfer/swap.
 */
export const NO_PROTOCOL = '0x0'

export const PROTOCOL_IDS = {
  suiStaking: '0x3',
  navi: '0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb',
  suilend: '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf',
  volo: '0x68d22cf8bdbcd11ecba1e094922873e4080d4d11133e2443fddda0bfd11dae20',
  scallop: '0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805',
  // The type-defining (original) Walrus package — where `StakedWal` lives — used
  // as the stable allowlist tag for WAL staking (survives Walrus package upgrades).
  walrusStaking: '0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77',
} as const

export type ProtocolKey = keyof typeof PROTOCOL_IDS

/** Human labels for each allowlistable protocol (for the owner UI + receipts). */
export const PROTOCOL_LABELS: Record<string, string> = {
  [PROTOCOL_IDS.suiStaking]: 'Sui staking',
  [PROTOCOL_IDS.navi]: 'NAVI',
  [PROTOCOL_IDS.suilend]: 'Suilend',
  [PROTOCOL_IDS.volo]: 'Volo (vSUI)',
  [PROTOCOL_IDS.scallop]: 'Scallop',
  [PROTOCOL_IDS.walrusStaking]: 'Walrus staking',
}

/** The allowlistable protocols in display order, for building the owner UI. */
export const ALLOWLISTABLE_PROTOCOLS: { key: ProtocolKey; id: string; label: string }[] = [
  { key: 'suiStaking', id: PROTOCOL_IDS.suiStaking, label: 'Sui staking' },
  { key: 'navi', id: PROTOCOL_IDS.navi, label: 'NAVI' },
  { key: 'suilend', id: PROTOCOL_IDS.suilend, label: 'Suilend' },
  { key: 'volo', id: PROTOCOL_IDS.volo, label: 'Volo (vSUI)' },
  { key: 'scallop', id: PROTOCOL_IDS.scallop, label: 'Scallop' },
  { key: 'walrusStaking', id: PROTOCOL_IDS.walrusStaking, label: 'Walrus staking' },
]
