import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairingStore } from 'lyra-core'
import { type SanitizeInput, sanitizeInbound } from './sanitize'

const baseInput: SanitizeInput = {
  chatType: 'private',
  chatId: 12345,
  fromId: 12345,
  fromIsBot: false,
  fromUsername: 'elpabl0',
  fromFirstName: 'Alkautsar',
  fromLastName: null,
  text: 'hello',
  messageId: 1,
  forwardedFrom: null,
  mediaGroupId: null,
}

let pairingDir: string

beforeEach(() => {
  pairingDir = mkdtempSync(join(tmpdir(), 'lyra-sanitize-pairing-'))
})

afterEach(() => {
  rmSync(pairingDir, { recursive: true, force: true })
})

describe('sanitizeInbound', () => {
  it('accepts a plain DM from a user in the allowlist', () => {
    const r = sanitizeInbound(baseInput, { allowedUserIds: [12345] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.event.chatId).toBe(12345)
      expect(r.event.text).toBe('hello')
      expect(r.event.username).toBe('elpabl0')
      expect(r.event.displayName).toBe('Alkautsar')
    }
  })

  it('drops not-private chat types', () => {
    const r = sanitizeInbound({ ...baseInput, chatType: 'group' }, { allowedUserIds: [12345] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-private-chat')
  })

  it('drops bots', () => {
    const r = sanitizeInbound({ ...baseInput, fromIsBot: true }, { allowedUserIds: [12345] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('sender-is-bot')
  })

  it('drops forwarded messages', () => {
    const r = sanitizeInbound(
      { ...baseInput, forwardedFrom: { id: 1 } },
      { allowedUserIds: [12345] },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('forwarded-message')
  })

  it('drops media groups', () => {
    const r = sanitizeInbound({ ...baseInput, mediaGroupId: 'xyz' }, { allowedUserIds: [12345] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('media-group')
  })

  it('drops empty/whitespace text', () => {
    const r = sanitizeInbound({ ...baseInput, text: '   ' }, { allowedUserIds: [12345] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no-text')
  })

  it('truncates over-cap text', () => {
    const r = sanitizeInbound(
      { ...baseInput, text: 'x'.repeat(3000) },
      { allowedUserIds: [12345], maxTextLength: 100 },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.event.text.length).toBeLessThan(150)
      expect(r.event.text).toContain('[message truncated]')
    }
  })

  it('rejects null fromId', () => {
    const r = sanitizeInbound({ ...baseInput, fromId: null }, { allowedUserIds: [12345] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no-sender-id')
  })

  it('default-deny: empty allowedUserIds + no pairingStore rejects unknown senders', () => {
    const r = sanitizeInbound({ ...baseInput, fromId: 99999 }, { allowedUserIds: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no-allowlist-default-deny')
  })

  it('default-deny: non-empty allowedUserIds without sender + no pairingStore rejects', () => {
    const r = sanitizeInbound({ ...baseInput, fromId: 99999 }, { allowedUserIds: [12345] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('sender-not-allowed')
  })

  it('pairing flow: unknown sender gets a pairing code', () => {
    const store = new PairingStore({ dir: pairingDir })
    const r = sanitizeInbound(
      { ...baseInput, fromId: 99999 },
      {
        allowedUserIds: [],
        pairingStore: store,
      },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.action).toBe('send-pairing-code')
      expect(r.code).toBeDefined()
      expect(r.code!.length).toBe(8)
      expect(r.pairedUserId).toBe(99999)
    }
  })

  it('pairing flow: approved user passes through even when not in static allowlist', () => {
    const store = new PairingStore({ dir: pairingDir })
    const code = store.generateCode('telegram', '99999', 'phantom')!
    store.approveCode('telegram', code)
    const r = sanitizeInbound(
      { ...baseInput, fromId: 99999 },
      {
        allowedUserIds: [],
        pairingStore: store,
      },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.userId).toBe(99999)
  })

  it('pairing flow: rate-limited unknown sender gets pairing-rate-limited reason', () => {
    const store = new PairingStore({ dir: pairingDir })
    // Burn 3 codes to hit MAX_PENDING_PER_PLATFORM
    for (let i = 0; i < 3; i++) store.generateCode('telegram', `bot-${i}`, '')
    const r = sanitizeInbound(
      { ...baseInput, fromId: 99999 },
      {
        allowedUserIds: [],
        pairingStore: store,
      },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('pairing-rate-limited')
  })

  it('explicit allowlist wins even when pairingStore is present', () => {
    const store = new PairingStore({ dir: pairingDir })
    const r = sanitizeInbound(baseInput, {
      allowedUserIds: [12345],
      pairingStore: store,
    })
    expect(r.ok).toBe(true)
  })
})
