import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  bytesToHex as nobleBytesToHex,
  hexToBytes as nobleHexToBytes,
} from '@noble/hashes/utils.js'

/** `0x`-prefixed lowercase hex string. */
type Hex = `0x${string}`

/** Encode bytes as a `0x`-prefixed hex string (legacy wire shape). */
function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${nobleBytesToHex(bytes)}`
}

/** Decode a hex string (with or without `0x` prefix) to bytes. */
function hexToBytes(hex: string): Uint8Array {
  return nobleHexToBytes(hex.startsWith('0x') ? hex.slice(2) : hex)
}

/**
 * Phase 6.6 Option 3: TEE → TEE migration ECIES.
 *
 * The local gateway (which holds the plaintext agent privkey in its RAM)
 * encrypts the privkey to the sandbox container's bootstrap pubkey. The CLI
 * only ever relays ciphertext — the operator's laptop never sees the
 * plaintext during a Local → Sandbox migration.
 *
 * Wire shape (envelope, base64-of):
 *   ephPubKey(33 bytes, compressed) || iv(12) || tag(16) || ct(N)
 *
 * Encryption:
 *   1. Generate ephemeral secp256k1 keypair (ekPriv, ekPub).
 *   2. Compute shared = ECDH(ekPriv, recipientPub) — uncompressed 64-byte point's
 *      x-coordinate (32 bytes).
 *   3. Derive 32-byte AEAD key via HKDF-SHA256(shared, salt=ekPub, info='lyra-option3-v1').
 *   4. AES-256-GCM(key, iv, plaintext).
 *
 * Decryption:
 *   1. Recompute shared = ECDH(recipientPriv, ekPub).
 *   2. Same HKDF derivation.
 *   3. AES-256-GCM decrypt.
 *
 * Where this is wired:
 *   - `POST /migration/encrypt-to`  on the local gateway: takes a container
 *      bootstrap pubkey + operator-signed migration request, returns the
 *      envelope here. Sandbox harness Phase 11 lands the gateway endpoint.
 *   - `POST /bootstrap/provision` on the sandbox container: receives the
 *      envelope and decrypts inside its sealed memory. Phase 11 lands the
 *      container endpoint.
 *
 * MVP caveat: in unsealed sandbox mode the local gateway can't
 * cryptographically verify the container's bootstrap pubkey, so a network
 * MITM could substitute a pubkey it controls and harvest the plaintext.
 * Sealed sandbox mode (Phase 11 stretch) closes the gap via TDX attestation;
 * the gateway verifies the attestation report before encrypting.
 */
const HKDF_INFO = Buffer.from('lyra-option3-v1', 'utf8')

export interface Option3Envelope {
  /** Ephemeral compressed secp256k1 pubkey (33 bytes), hex-encoded. */
  ephPubkeyHex: Hex
  /** Random 12-byte IV, hex-encoded. */
  ivHex: Hex
  /** AES-GCM 16-byte auth tag, hex-encoded. */
  tagHex: Hex
  /** AES-GCM ciphertext, hex-encoded. */
  ciphertextHex: Hex
}

/**
 * Encrypt a plaintext payload to the container's bootstrap pubkey.
 *
 * @param recipientPubkey 33-byte compressed or 65-byte uncompressed secp256k1 pubkey hex.
 * @param plaintext bytes to encrypt (typically the agent privkey, 32 bytes).
 */
export function encryptToPubkey(opts: {
  recipientPubkey: Hex
  plaintext: Uint8Array
}): Option3Envelope {
  const recipientPubBytes = hexToBytes(opts.recipientPubkey)
  if (recipientPubBytes.length !== 33 && recipientPubBytes.length !== 65) {
    throw new Error(
      `Invalid recipient pubkey length: ${recipientPubBytes.length} (expected 33 or 65 bytes)`,
    )
  }

  const eph = secp256k1.keygen()
  const ekPriv = eph.secretKey
  const ekPubCompressed = secp256k1.getPublicKey(ekPriv, true)

  const shared = secp256k1.getSharedSecret(ekPriv, recipientPubBytes, true)
  const ikm = Buffer.from(shared.subarray(1)) // strip 0x02/0x03 sign byte → 32-byte x-coord
  const aeadKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(ekPubCompressed), HKDF_INFO, 32))

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', aeadKey, iv)
  const ct = Buffer.concat([cipher.update(opts.plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    ephPubkeyHex: bytesToHex(ekPubCompressed),
    ivHex: bytesToHex(new Uint8Array(iv)),
    tagHex: bytesToHex(new Uint8Array(tag)),
    ciphertextHex: bytesToHex(new Uint8Array(ct)),
  }
}

export function decryptWithPrivkey(opts: {
  recipientPrivkey: Hex
  envelope: Option3Envelope
}): Uint8Array {
  const ekPubBytes = hexToBytes(opts.envelope.ephPubkeyHex)
  const recipientPrivBytes = hexToBytes(opts.recipientPrivkey)

  const shared = secp256k1.getSharedSecret(recipientPrivBytes, ekPubBytes, true)
  const ikm = Buffer.from(shared.subarray(1))
  const aeadKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(ekPubBytes), HKDF_INFO, 32))

  const iv = hexToBytes(opts.envelope.ivHex)
  const tag = hexToBytes(opts.envelope.tagHex)
  const ct = hexToBytes(opts.envelope.ciphertextHex)

  const decipher = createDecipheriv('aes-256-gcm', aeadKey, iv)
  decipher.setAuthTag(Buffer.from(tag))
  return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]))
}

/** Convenience: derive a fresh container bootstrap keypair (used by sandbox harness). */
export function generateBootstrapKeypair(): {
  privkeyHex: Hex
  pubkeyHexCompressed: Hex
  pubkeyHexUncompressed: Hex
} {
  const { secretKey } = secp256k1.keygen()
  const pubC = secp256k1.getPublicKey(secretKey, true)
  const pubU = secp256k1.getPublicKey(secretKey, false)
  return {
    privkeyHex: bytesToHex(secretKey),
    pubkeyHexCompressed: bytesToHex(pubC),
    pubkeyHexUncompressed: bytesToHex(pubU),
  }
}
