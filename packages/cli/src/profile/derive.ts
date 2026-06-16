/**
 * Deterministic agent wallet derivation — MUST stay byte-for-byte identical to
 * the web (apps/web/lib/agent-wallet.ts) so the same operator/main wallet
 * resolves to the SAME agent wallet in the CLI and the browser.
 *
 * The operator signs the fixed message; keccak256 of that signature is the agent
 * private key. Relies on deterministic (RFC-6979) ECDSA, which viem and most
 * wallets use.
 */
import { type Hex, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// KEEP IN SYNC with apps/web/lib/agent-wallet.ts AGENT_DERIVE_MESSAGE.
export const AGENT_DERIVE_MESSAGE =
  'nebula · derive my agent wallet (v1)\n\n' +
  'Signing this proves you own this wallet and unlocks your deterministic Mantle ' +
  'agent wallet. This signature IS your agent key — only ever sign it on nebula.'

export function deriveAgentKeyFromSignature(signature: Hex): Hex {
  return keccak256(signature)
}

export function deriveAgentAccountFromSignature(signature: Hex) {
  return privateKeyToAccount(deriveAgentKeyFromSignature(signature))
}
