import { describe, expect, test } from 'bun:test'
import { deriveAgentAccountFromSignature, deriveAgentKeyFromSignature } from './derive'

const SIG = `0x${'ab'.repeat(65)}` as `0x${string}`

describe('agent wallet derivation', () => {
  test('is deterministic', () => {
    expect(deriveAgentKeyFromSignature(SIG)).toBe(deriveAgentKeyFromSignature(SIG))
  })

  test('produces a valid agent address', () => {
    const a = deriveAgentAccountFromSignature(SIG)
    expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  test('matches the web derivation (keccak of the signature)', () => {
    // The web derives keccak256(signature) → privateKeyToAccount. This must be
    // the same key, so the CLI and browser resolve to one agent wallet.
    expect(deriveAgentAccountFromSignature(SIG).address).toBe(
      '0xc680a94EC50481863188Fe80d5AA08911b39Cd52',
    )
  })
})
