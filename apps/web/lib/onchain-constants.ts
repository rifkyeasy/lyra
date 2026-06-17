// Client-safe on-chain constants. These are public ids — safe to ship to the
// browser (owner-signed provision/deposit/withdraw PTBs are built here).
//
// A module's types/events keep their DEFINING package id forever: `policy`
// shipped in the original publish; `vault` was added in the first upgrade. The
// LATEST id is for moveCall targets.
export const LYRA_PKG = '0xc7c4f8887150035058e70b981896e4f0f868f1d6c2951549398ab364bacb4f90'
export const ORIGINAL_PKG = '0x250880a4c1a268da8011b164f599d4e100cefce84f862d36396cd1a943ee8a35'
export const VAULT_PKG = '0xa40689cc541f57af123e90819e73eab8a551e4385ab91bee89d02f6691590211'
export const SUI_TYPE = '0x2::sui::SUI'
export const CLOCK = '0x6'
