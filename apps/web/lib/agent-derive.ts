// Multi-tenant agent derivation. Each owner wallet gets ONE deterministic agent
// keypair, derived server-side from a single master secret — no per-user key
// storage, stable across web / CLI / Telegram. The owner authenticates (SIWS on
// web, /link on Telegram, local config on CLI); the server derives THEIR agent.
// The on-chain AgentPolicy(owner, agent) records the binding and bounds the agent.
//
// SECURITY: the master secret never leaves the server; the algorithm here MUST
// stay byte-identical to packages/plugin-onchain/src/derive.ts so every surface
// derives the same agent for the same owner.
import 'server-only'

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { createHmac } from 'node:crypto'

const DERIVATION_DOMAIN = 'lyra-agent:v1:'

/** Derive the agent keypair that belongs to `ownerAddress`. */
export function deriveAgentKeypair(ownerAddress: string): Ed25519Keypair {
  const master = process.env.LYRA_MASTER_SECRET
  if (!master || master.length < 32) {
    throw new Error('LYRA_MASTER_SECRET is not configured on the server (need ≥32 chars)')
  }
  const owner = ownerAddress.trim().toLowerCase()
  if (!/^0x[0-9a-f]{1,64}$/.test(owner)) throw new Error(`invalid owner address: ${ownerAddress}`)
  // HMAC-SHA256(master, domain || owner) → 32-byte Ed25519 seed.
  const seed = createHmac('sha256', master).update(DERIVATION_DOMAIN + owner).digest()
  return Ed25519Keypair.fromSecretKey(new Uint8Array(seed))
}

/** The Sui address of the agent that belongs to `ownerAddress`. */
export function deriveAgentAddress(ownerAddress: string): string {
  return deriveAgentKeypair(ownerAddress).toSuiAddress()
}
