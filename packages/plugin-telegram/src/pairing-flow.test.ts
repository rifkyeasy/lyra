import { describe, expect, it } from 'bun:test'
import { formatPairingMessage } from './pairing-flow'

describe('formatPairingMessage', () => {
  it('includes the code and the default approve command', () => {
    const msg = formatPairingMessage({ code: 'ABCDEFGH' })
    expect(msg).toContain('ABCDEFGH')
    expect(msg).toContain('lyra pairing approve telegram ABCDEFGH')
  })

  it('greets with the agent name when provided', () => {
    const msg = formatPairingMessage({ code: 'ABCDEFGH', agentName: 'specter' })
    expect(msg).toContain('specter')
  })

  it('mentions 1-hour TTL', () => {
    const msg = formatPairingMessage({ code: 'ABCDEFGH' })
    expect(msg).toContain('1 hour')
  })

  it('honors approveCommand override', () => {
    const msg = formatPairingMessage({ code: 'XX', approveCommand: 'custom-cmd XX' })
    expect(msg).toContain('custom-cmd XX')
    expect(msg).not.toContain('lyra pairing approve')
  })

  it('starts with the lock emoji', () => {
    const msg = formatPairingMessage({ code: 'XX' })
    expect(msg.startsWith('🔐')).toBe(true)
  })
})
