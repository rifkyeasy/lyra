// Client-safe on-chain constants. These are public ids — safe to ship to the
// browser (owner-signed provision/deposit/withdraw PTBs are built here).
//
// A module's types/events keep their DEFINING package id forever: `policy`
// shipped in the original publish; `vault` was added in the first upgrade. The
// LATEST id is for moveCall targets.
export const LYRA_PKG = '0x8ffdbda0bec2e3604757d435c567d52451317ed5752cef8fc5321a1050872cbf'
export const ORIGINAL_PKG = '0x250880a4c1a268da8011b164f599d4e100cefce84f862d36396cd1a943ee8a35'
export const VAULT_PKG = '0xa40689cc541f57af123e90819e73eab8a551e4385ab91bee89d02f6691590211'
export const SUI_TYPE = '0x2::sui::SUI'
export const CLOCK = '0x6'

// Allowlistable yield protocols for the policy's protocol allowlist. This MIRRORS
// packages/plugin-onchain/src/protocol-ids.ts (the tools' source of truth) — keep
// the two in sync. Duplicated here (rather than imported) so the browser bundle
// never pulls the plugin's Node-only deps: importing `lyra-plugin-onchain` into a
// client component breaks the build on `node:crypto`.
export const NO_PROTOCOL = '0x0'
export const ALLOWLISTABLE_PROTOCOLS: { key: string; id: string; label: string }[] = [
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
]
