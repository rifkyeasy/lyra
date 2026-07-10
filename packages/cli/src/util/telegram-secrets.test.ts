import { afterEach, describe, expect, it } from 'bun:test'
import { looksLikeBotToken, parseAllowedUserIds, telegramSecretsFromEnv } from './telegram-secrets'

describe('looksLikeBotToken', () => {
  it('accepts a real-shaped token', () => {
    expect(looksLikeBotToken('123456789:AAFAKEfixtureTokenForUnitTestsOnly00')).toBe(true)
  })

  it('rejects empty / wrong delimiters', () => {
    expect(looksLikeBotToken('')).toBe(false)
    expect(looksLikeBotToken('123456789-AAFAKEfixtureTokenForUnitTestsOnly00')).toBe(false)
    expect(looksLikeBotToken('AAFAKEfixtureTokenForUnitTestsOnly00')).toBe(false)
  })

  it('rejects too-short secret half', () => {
    expect(looksLikeBotToken('1234567890:short')).toBe(false)
  })

  it('trims surrounding whitespace before checking', () => {
    expect(looksLikeBotToken('  987654321:AAFAKEfixtureTokenForUnitTestsOnly11\n')).toBe(true)
  })
})

describe('parseAllowedUserIds', () => {
  it('returns empty list for blank input', () => {
    const r = parseAllowedUserIds('')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.ids).toEqual([])
  })

  it('parses a comma-separated list', () => {
    const r = parseAllowedUserIds('123, 456, 789')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.ids).toEqual([123, 456, 789])
  })

  it('parses whitespace-only delimiters', () => {
    const r = parseAllowedUserIds('123  456\t789')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.ids).toEqual([123, 456, 789])
  })

  it('dedupes preserving first-seen order', () => {
    const r = parseAllowedUserIds('123, 456, 123')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.ids).toEqual([123, 456])
  })

  it('rejects non-numeric ids', () => {
    const r = parseAllowedUserIds('123, abc')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('abc')
  })

  it('rejects negative ids', () => {
    const r = parseAllowedUserIds('-123')
    expect(r.ok).toBe(false)
  })

  it('rejects zero', () => {
    const r = parseAllowedUserIds('0')
    expect(r.ok).toBe(false)
  })
})

describe('telegramSecretsFromEnv', () => {
  const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_USERNAME'] as const
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) saved[k] = process.env[k]

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k)
      else process.env[k] = saved[k]
    }
  })

  it('returns null when no token is set', () => {
    Reflect.deleteProperty(process.env, 'TELEGRAM_BOT_TOKEN')
    expect(telegramSecretsFromEnv()).toBeNull()
  })

  it('parses token + chat id + username', () => {
    process.env.TELEGRAM_BOT_TOKEN = '987654321:AAFAKEfixtureTokenForUnitTestsOnly11'
    process.env.TELEGRAM_CHAT_ID = '100000001'
    process.env.TELEGRAM_USERNAME = 'lyra_test_bot'
    expect(telegramSecretsFromEnv()).toEqual({
      botToken: '987654321:AAFAKEfixtureTokenForUnitTestsOnly11',
      botUsername: 'lyra_test_bot',
      allowedUserIds: [100000001],
    })
  })

  it('open access (empty allowlist) when no chat id', () => {
    process.env.TELEGRAM_BOT_TOKEN = '987654321:AAFAKEfixtureTokenForUnitTestsOnly11'
    Reflect.deleteProperty(process.env, 'TELEGRAM_CHAT_ID')
    Reflect.deleteProperty(process.env, 'TELEGRAM_USERNAME')
    expect(telegramSecretsFromEnv()).toEqual({
      botToken: '987654321:AAFAKEfixtureTokenForUnitTestsOnly11',
      botUsername: undefined,
      allowedUserIds: [],
    })
  })
})
