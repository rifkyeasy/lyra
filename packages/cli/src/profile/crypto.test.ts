import { describe, expect, test } from 'bun:test'
import { decryptSecret, encryptSecret } from './crypto'

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

describe('profile crypto', () => {
  test('round-trips a secret with the right password', () => {
    const blob = encryptSecret(PK, 'correct horse battery staple')
    expect(decryptSecret(blob, 'correct horse battery staple')).toBe(PK)
  })

  test('never stores the plaintext secret in the blob', () => {
    const blob = encryptSecret(PK, 'pw')
    const serialized = JSON.stringify(blob)
    expect(serialized).not.toContain(PK)
    expect(serialized).not.toContain(PK.slice(2))
  })

  test('wrong password fails to decrypt (GCM auth)', () => {
    const blob = encryptSecret(PK, 'right')
    expect(() => decryptSecret(blob, 'wrong')).toThrow()
  })

  test('fresh salt + iv each time (no reuse)', () => {
    const a = encryptSecret(PK, 'pw')
    const b = encryptSecret(PK, 'pw')
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  test('tamper with ciphertext is rejected', () => {
    const blob = encryptSecret(PK, 'pw')
    const flipped = blob.ct.slice(0, -2) + (blob.ct.endsWith('00') ? '11' : '00')
    expect(() => decryptSecret({ ...blob, ct: flipped }, 'pw')).toThrow()
  })
})
