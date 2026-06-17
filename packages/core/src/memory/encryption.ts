import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

/**
 * Phase 6.7 memory file encryption.
 *
 * Key derivation: HKDF-SHA256(ikm = agent privkey bytes, info = "lyra-memory-aead-v1")
 *   → 32-byte AES-256-GCM key.
 *
 * Why agent privkey (not operator wallet)? Memory writes happen mid-chat —
 * thousands of times in a long conversation. Asking the operator wallet to
 * sign per write would be miserable for WC users. The agent privkey is
 * already in RAM during the chat session (decrypted via operator at session
 * start), so deriving a memory key from it is silent and fast.
 *
 * Recovery: anyone who can decrypt the keystore can derive this key, so the
 * security envelope is the same as the keystore's.
 *
 * Format: v(1) || iv(12) || tag(16) || ciphertext  (raw bytes, no JSON wrap).
 *   v=1: plaintext encrypted directly (legacy).
 *   v=2: plaintext gzip-compressed first then encrypted. Decryption gunzips
 *        after AES-GCM. Used for the activity-log slot where JSON content
 *        compresses 5-10x and the Walrus upload is the bottleneck.
 *
 * Both versions are backwards-compatible: decryptMemoryBytes dispatches on
 * the leading version byte and reads either layout.
 */
export const MEMORY_BLOB_VERSION = 1 as const
export const MEMORY_BLOB_VERSION_GZIP = 2 as const

const HKDF_INFO = Buffer.from('lyra-memory-aead-v1', 'utf8')
const KEY_LEN = 32
const IV_LEN = 12
const TAG_LEN = 16

/**
 * Derive the memory AES key from the agent's secret. Accepts the raw secret
 * bytes or a string (Sui bech32 secret `suiprivkey1...`, or legacy `0x` hex);
 * strings are keyed by their UTF-8 bytes so any stable secret representation
 * works. The security envelope is the keystore's: whoever can decrypt the
 * keystore can re-derive this key.
 */
export function deriveMemoryKey(agentSecret: string | Uint8Array): Buffer {
  const ikm =
    typeof agentSecret === 'string' ? Buffer.from(agentSecret, 'utf8') : Buffer.from(agentSecret)
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), HKDF_INFO, KEY_LEN))
}

export interface EncryptOpts {
  /**
   * Gzip the plaintext before encrypting. Reduces blob size 5-10x on JSON-
   * heavy content like the activity log. Costs a few ms of CPU per upload
   * — fine because the network upload it saves is much slower. Default
   * false to preserve byte-for-byte compatibility with v=1 callers.
   */
  compress?: boolean
}

export function encryptMemoryBytes(
  plaintext: Uint8Array,
  key: Buffer,
  opts: EncryptOpts = {},
): Uint8Array {
  if (key.length !== KEY_LEN) throw new Error(`memory key must be ${KEY_LEN} bytes`)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const payload = opts.compress ? gzipSync(plaintext) : plaintext
  const ct = Buffer.concat([cipher.update(payload), cipher.final()])
  const tag = cipher.getAuthTag()
  const version = opts.compress ? MEMORY_BLOB_VERSION_GZIP : MEMORY_BLOB_VERSION
  return new Uint8Array(Buffer.concat([Buffer.from([version]), iv, tag, ct]))
}

export function decryptMemoryBytes(blob: Uint8Array, key: Buffer): Uint8Array {
  if (key.length !== KEY_LEN) throw new Error(`memory key must be ${KEY_LEN} bytes`)
  const buf = Buffer.from(blob)
  if (buf.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error(`memory blob too short: ${buf.length} bytes`)
  }
  const version = buf[0]
  if (version !== MEMORY_BLOB_VERSION && version !== MEMORY_BLOB_VERSION_GZIP) {
    throw new Error(`unsupported memory blob version: ${version}`)
  }
  const iv = buf.subarray(1, 1 + IV_LEN)
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN)
  const ct = buf.subarray(1 + IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()])
  if (version === MEMORY_BLOB_VERSION_GZIP) {
    return new Uint8Array(gunzipSync(decrypted))
  }
  return new Uint8Array(decrypted)
}
