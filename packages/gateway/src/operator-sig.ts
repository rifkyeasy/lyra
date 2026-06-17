/**
 * Operator-signature primitives for the gateway's sandbox-remote auth
 * protocol (provision / chat / approval / admin sigs).
 *
 * The operator authenticates remote (non-local) requests with a Sui Ed25519
 * key: each request carries a deterministic digest, signed as a Sui personal
 * message. The harness verifies the signature with
 * `verifyPersonalMessageSignature` from `@mysten/sui/verify` and checks the
 * recovered signer address equals the expected operator. Local-mode gateways
 * skip all of this via `trustLocal: true`; this module only matters for the
 * encrypted sandbox-remote provision flow.
 *
 * NOTE: this is operator-identity auth (a Sui address the operator controls),
 * independent of the agent's own on-chain Sui identity. It is the
 * transport-auth layer, not a chain integration.
 */

import { blake2b } from '@noble/hashes/blake2.js'
import { bytesToHex, hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js'

/** Lowercase `0x`-prefixed hex string. */
export type Hex = `0x${string}`
/** A Sui address: `0x`-prefixed, 32 bytes (64 hex chars). */
export type Address = `0x${string}`

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
}

export function hexToBytes(hex: string): Uint8Array {
  const body = stripHexPrefix(hex)
  if (body.length % 2 !== 0) throw new Error('hex string has odd length')
  return nobleHexToBytes(body)
}

export function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}` as Hex
}

/**
 * Validate + normalize a Sui address to lowercase `0x` + 64 hex chars. Throws
 * on malformed input. Shorter `0x`-hex addresses are left-padded to 32 bytes
 * (matching Sui's canonical address form).
 */
export function normalizeAddress(address: string): Address {
  const raw = stripHexPrefix(address).toLowerCase()
  if (raw.length === 0 || raw.length > 64 || !/^[0-9a-f]+$/.test(raw)) {
    throw new Error(`invalid address: ${address}`)
  }
  return `0x${raw.padStart(64, '0')}` as Address
}

export function isAddress(value: string): boolean {
  try {
    normalizeAddress(value)
    return true
  } catch {
    return false
  }
}

export function isAddressEqual(a: string, b: string): boolean {
  try {
    return normalizeAddress(a) === normalizeAddress(b)
  } catch {
    return false
  }
}

/**
 * A field bound into a signed digest. Mirrors the shape of the prior static
 * encoder so call sites stay readable; the encoder below binds each field's
 * type tag + length so two distinct field tuples can never collide.
 */
export type DigestField =
  | { type: 'bytes32' | 'address' | 'bytes'; name?: string; value: string }
  | { type: 'uint'; name?: string; value: bigint }
  | { type: 'string'; name?: string; value: string }

function uintToBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('uint cannot be negative')
  let hex = n.toString(16)
  if (hex.length % 2 !== 0) hex = `0${hex}`
  return hex === '00' || hex === '' ? new Uint8Array([0]) : nobleHexToBytes(hex)
}

/**
 * Deterministically encode a list of named fields into a single byte string
 * for signing. Each field contributes a 1-byte type tag, a 4-byte big-endian
 * length, then its raw bytes — so distinct field tuples cannot be confused
 * even when adjacent values are reordered or concatenate ambiguously.
 */
export function encodeFields(fields: DigestField[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const tagFor: Record<DigestField['type'], number> = {
    bytes32: 1,
    address: 2,
    bytes: 3,
    uint: 4,
    string: 5,
  }
  for (const f of fields) {
    let data: Uint8Array
    if (f.type === 'string') {
      data = new TextEncoder().encode(f.value)
    } else if (f.type === 'uint') {
      data = uintToBytes(f.value)
    } else if (f.type === 'address') {
      // Canonicalize addresses (left-pad to 32 bytes) so the signer and the
      // verifier agree even if one side carries a shorter `0x`-hex form.
      data = hexToBytes(normalizeAddress(f.value))
    } else {
      data = hexToBytes(f.value)
    }
    const header = new Uint8Array(5)
    header[0] = tagFor[f.type]
    const len = data.length
    header[1] = (len >>> 24) & 0xff
    header[2] = (len >>> 16) & 0xff
    header[3] = (len >>> 8) & 0xff
    header[4] = len & 0xff
    chunks.push(header, data)
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** Blake2b-256 over the encoded fields; the 32-byte digest the operator signs. */
export function digestFields(fields: DigestField[]): Uint8Array {
  return blake2b(encodeFields(fields), { dkLen: 32 })
}
