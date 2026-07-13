/**
 * v2 runtime context for the -two stack. Builds a @mysten/sui **v2**
 * Ed25519Keypair from the SAME agent secret the v1 stack uses, so bridge/DeFi-v2
 * tools sign as the identical agent address — only the SDK version differs.
 *
 * Note: @mysten/sui v2 reworked the client (SuiClient → CoreClient/BaseClient).
 * The Wormhole SDK owns the Sui RPC client internally (via `wormhole(network,
 * [sui])`), so the bridge tools only need the keypair here as a signer source.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'

export type V2Network = 'mainnet' | 'testnet'

export interface V2Context {
  keypair: Ed25519Keypair
  agentAddress: string
  network: V2Network
}

/** `secretKey` is the raw 32-byte Ed25519 secret (same bytes the v1 stack derives). */
export function makeV2Context(secretKey: Uint8Array, network: V2Network = 'mainnet'): V2Context {
  const keypair = Ed25519Keypair.fromSecretKey(secretKey)
  return { keypair, agentAddress: keypair.toSuiAddress(), network }
}
