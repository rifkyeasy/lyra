/**
 * Password-based encryption for the CLI profile. The agent private key is
 * encrypted at rest with a key derived from the operator's password via scrypt,
 * sealed with AES-256-GCM (authenticated — a wrong password fails to decrypt
 * rather than returning garbage). No plaintext key is ever written to the
 * profile file.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export interface ProfileCipher {
  v: 1
  kdf: 'scrypt'
  /** scrypt cost params. */
  n: number
  r: number
  p: number
  salt: string // hex
  iv: string // hex
  ct: string // hex (ciphertext)
  tag: string // hex (GCM auth tag)
}

const N = 1 << 15 // 32768
const R = 8
const P = 1
const KEYLEN = 32
// 128 * N * r ≈ 33.5 MB; default maxmem (32 MB) is just under, so bump it.
const MAXMEM = 96 * 1024 * 1024

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
}

/** Encrypt a secret string (e.g. a 0x private key) under a password. */
export function encryptSecret(secret: string, password: string): ProfileCipher {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(password, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    kdf: 'scrypt',
    n: N,
    r: R,
    p: P,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ct: ct.toString('hex'),
    tag: tag.toString('hex'),
  }
}

/** Decrypt a ProfileCipher with a password. Throws on a wrong password (GCM auth failure). */
export function decryptSecret(blob: ProfileCipher, password: string): string {
  const salt = Buffer.from(blob.salt, 'hex')
  const key = scryptSync(password.normalize('NFKC'), salt, KEYLEN, {
    N: blob.n,
    r: blob.r,
    p: blob.p,
    maxmem: MAXMEM,
  })
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'))
  const out = Buffer.concat([decipher.update(Buffer.from(blob.ct, 'hex')), decipher.final()])
  return out.toString('utf8')
}
