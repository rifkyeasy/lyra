import { describe, expect, it } from 'bun:test'
import { deriveAgentAddress, deriveAgentKeypair } from './derive'

const MASTER = 'a'.repeat(64)
const A = '0x46e37419c58981bb69100fa559baa52fd7e219486d75e9dc3f0896fab01d06f5'
const B = '0x250880a4c1a268da8011b164f599d4e100cefce84f862d36396cd1a943ee8a35'

describe('agent derivation', () => {
  it('is deterministic for the same owner + master', () => {
    expect(deriveAgentAddress(A, MASTER)).toBe(deriveAgentAddress(A, MASTER))
  })

  it('gives distinct agents for distinct owners', () => {
    expect(deriveAgentAddress(A, MASTER)).not.toBe(deriveAgentAddress(B, MASTER))
  })

  it('is case-insensitive on the owner address', () => {
    expect(deriveAgentAddress(A.toUpperCase().replace('0X', '0x'), MASTER)).toBe(
      deriveAgentAddress(A, MASTER),
    )
  })

  it('changes with the master secret (no master reuse leaks)', () => {
    expect(deriveAgentAddress(A, MASTER)).not.toBe(deriveAgentAddress(A, `${'b'.repeat(64)}`))
  })

  it('returns a valid 32-byte Sui address', () => {
    expect(deriveAgentAddress(A, MASTER)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('the keypair signs (a real Ed25519 key)', async () => {
    const kp = deriveAgentKeypair(A, MASTER)
    const { signature } = await kp.signPersonalMessage(new TextEncoder().encode('hi'))
    expect(typeof signature).toBe('string')
    expect(signature.length).toBeGreaterThan(0)
  })

  it('rejects a too-short master secret', () => {
    expect(() => deriveAgentAddress(A, 'short')).toThrow()
  })

  it('rejects a malformed owner address', () => {
    expect(() => deriveAgentAddress('not-an-address', MASTER)).toThrow()
  })
})
