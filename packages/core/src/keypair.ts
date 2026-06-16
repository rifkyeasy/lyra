import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'

/** Load an Ed25519 keypair from a Bech32 `suiprivkey1...` secret key. */
export function loadKeypair(secret: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(secret.trim())
}

/** Generate a fresh Ed25519 keypair. Use `kp.getSecretKey()` to persist it. */
export function generateKeypair(): Ed25519Keypair {
  return new Ed25519Keypair()
}
