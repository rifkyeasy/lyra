import { afterEach, describe, expect, it } from 'bun:test'
import { looksLikeBotToken, parseAllowedUserIds, telegramSecretsFromEnv } from './telegram-secrets'

describe('looksLikeBotToken', () => {
  it('accepts a real-shaped token', () => {
    expect(looksLikeBotToken('8776805236:AAGgfvp2AwYBvDc3COYfjC9m8w2s0e4t4hw')).toBe(true)
  })

  it('rejects empty / wrong delimiters', () => {
    expect(looksLikeBotToken('')).toBe(false)
    expect(looksLikeBotToken('8776805236-AAGgfvp2AwYBvDc3COYfjC9m8w2s0e4t4hw')).toBe(false)
    expect(looksLikeBotToken('AAGgfvp2AwYBvDc3COYfjC9m8w2s0e4t4hw')).toBe(false)
  })

  it('rejects too-short secret half', () => {
    expect(looksLikeBotToken('1234567890:short')).toBe(false)
  })

  it('trims surrounding whitespace before checking', () => {
    expect(looksLikeBotToken('  8731160904:AAH8FQ3CLrE8-WAfZtDeOTqmpVgOFLg8GyU\n')).toBe(true)
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
    process.env.TELEGRAM_BOT_TOKEN = '8731160904:AAH8FQ3CLrE8-WAfZtDeOTqmpVgOFLg8GyU'
    process.env.TELEGRAM_CHAT_ID = '1140813034'
    process.env.TELEGRAM_USERNAME = 'lyra_test_bot'
    expect(telegramSecretsFromEnv()).toEqual({
      botToken: '8731160904:AAH8FQ3CLrE8-WAfZtDeOTqmpVgOFLg8GyU',
      botUsername: 'lyra_test_bot',
      allowedUserIds: [1140813034],
    })
  })

  it('open access (empty allowlist) when no chat id', () => {
    process.env.TELEGRAM_BOT_TOKEN = '8731160904:AAH8FQ3CLrE8-WAfZtDeOTqmpVgOFLg8GyU'
    Reflect.deleteProperty(process.env, 'TELEGRAM_CHAT_ID')
    Reflect.deleteProperty(process.env, 'TELEGRAM_USERNAME')
    expect(telegramSecretsFromEnv()).toEqual({
      botToken: '8731160904:AAH8FQ3CLrE8-WAfZtDeOTqmpVgOFLg8GyU',
      botUsername: undefined,
      allowedUserIds: [],
    })
  })
})
