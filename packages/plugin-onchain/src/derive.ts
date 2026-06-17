/**
 * Multi-tenant agent derivation — the canonical algorithm shared by every Lyra
 * surface (CLI, gateway, Telegram). Each owner wallet gets ONE deterministic
 * agent keypair, derived from a single server master secret. No per-user key
 * storage; the same owner always resolves to the same agent everywhere.
 *
 * The web mirrors this byte-for-byte in `apps/web/lib/agent-derive.ts` — keep the
 * domain string + HMAC construction identical or the two will diverge.
 *
 * The owner authenticates per interface (SIWS on web, /link on Telegram, local
 * config on CLI); the on-chain `lyra::policy` AgentPolicy(owner, agent) records
 * the binding and bounds what the derived agent may spend.
 */

import { createHmac } from 'node:crypto'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'

const DERIVATION_DOMAIN = 'lyra-agent:v1:'

/** Derive the agent keypair belonging to `ownerAddress`. */
export function deriveAgentKeypair(
  ownerAddress: string,
  masterSecret: string | undefined = process.env.LYRA_MASTER_SECRET,
): Ed25519Keypair {
  if (!masterSecret || masterSecret.length < 32) {
    throw new Error('LYRA_MASTER_SECRET is not configured (need ≥32 chars)')
  }
  const owner = ownerAddress.trim().toLowerCase()
  if (!/^0x[0-9a-f]{1,64}$/.test(owner)) throw new Error(`invalid owner address: ${ownerAddress}`)
  const seed = createHmac('sha256', masterSecret)
    .update(DERIVATION_DOMAIN + owner)
    .digest()
  return Ed25519Keypair.fromSecretKey(new Uint8Array(seed))
}

/** The Sui address of the agent belonging to `ownerAddress`. */
export function deriveAgentAddress(ownerAddress: string, masterSecret?: string): string {
  return deriveAgentKeypair(ownerAddress, masterSecret).toSuiAddress()
}
