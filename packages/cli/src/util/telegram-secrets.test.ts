import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OPERATOR_BLOB_SCOPES,
  RawPrivkeyOperatorSigner,
  agentPaths,
  deriveBlobKey,
  placeholderAgentId,
} from 'nebula-ai-core'
import { type Address, generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  loadTelegramHandoffSecrets,
  looksLikeBotToken,
  parseAllowedUserIds,
  saveTelegramSecrets,
  telegramSecretsPath,
} from './telegram-secrets'

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

describe('loadTelegramHandoffSecrets', () => {
  // Each test gets a fresh NEBULA_ROOT tmpdir so `agentPaths.agent(id).dir`
  // resolves somewhere isolated, and `afterEach` cleans it up even on failure.
  const TEST_AGENT_EOA = '0x9e71d79f06f956d4d2666b5c93dafab721c84721' as Address
  const TEST_AGENT_ID = placeholderAgentId(TEST_AGENT_EOA)

  let prevNebulaRoot: string | undefined
  let tmpRoot: string

  beforeAll(() => {
    prevNebulaRoot = process.env.NEBULA_ROOT
  })
  afterAll(() => {
    if (prevNebulaRoot === undefined) Reflect.deleteProperty(process.env, 'NEBULA_ROOT')
    else process.env.NEBULA_ROOT = prevNebulaRoot
  })
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nebula-tg-secrets-test-'))
    process.env.NEBULA_ROOT = tmpRoot
  })
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('returns undefined when no blob exists on disk', async () => {
    const operatorPrivkey = generatePrivateKey()
    const signer = new RawPrivkeyOperatorSigner({ privkey: operatorPrivkey })
    const agentAddress = privateKeyToAccount(generatePrivateKey()).address
    let notices = 0
    const result = await loadTelegramHandoffSecrets({
      signer,
      agentAddress,
      agentId: TEST_AGENT_ID,
      onNotice: () => {
        notices += 1
      },
    })
    expect(result).toBeUndefined()
    expect(notices).toBe(0)
  })

  it('round-trips through saveTelegramSecrets and returns handoff subset', async () => {
    const operatorPrivkey = generatePrivateKey()
    const signer = new RawPrivkeyOperatorSigner({ privkey: operatorPrivkey })
    const agentAddress = privateKeyToAccount(generatePrivateKey()).address
    await saveTelegramSecrets({
      signer,
      agentAddress,
      agentId: TEST_AGENT_ID,
      plaintext: {
        botToken: '8731160904:AAH8FQ3CLrE8-WAfZtDeOTqmpVgOFLg8GyU',
        botUsername: 'nebula_test_bot',
        botId: 8731160904,
        allowedUserIds: [1140813034, 222333444],
      },
    })
    expect(existsSync(telegramSecretsPath(TEST_AGENT_ID))).toBe(true)

    const result = await loadTelegramHandoffSecrets({
      signer,
      agentAddress,
      agentId: TEST_AGENT_ID,
    })
    expect(result).toEqual({
      botToken: '8731160904:AAH8FQ3CLrE8-WAfZtDeOTqmpVgOFLg8GyU',
      allowedUserIds: [1140813034, 222333444],
    })
  })

  it('swallows decrypt errors via onNotice and returns undefined', async () => {
    const operatorPrivkey = generatePrivateKey()
    const signer = new RawPrivkeyOperatorSigner({ privkey: operatorPrivkey })
    const agentAddress = privateKeyToAccount(generatePrivateKey()).address
    // Write a malformed blob: file exists but contents fail decode.
    const path = telegramSecretsPath(TEST_AGENT_ID)
    const agentDir = agentPaths.agent(TEST_AGENT_ID).dir
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(path, 'not-a-valid-operator-blob-payload')

    const notices: string[] = []
    const result = await loadTelegramHandoffSecrets({
      signer,
      agentAddress,
      agentId: TEST_AGENT_ID,
      onNotice: msg => {
        notices.push(msg)
      },
    })
    expect(result).toBeUndefined()
    expect(notices.length).toBe(1)
    expect(notices[0]).toMatch(/telegram secrets read failed:/)
  })

  // v0.24.3: precomputedKey path — used by init wizard so the derived TELEGRAM
  // scope key can be passed to saveTelegramSecrets AND stashed in
  // `.operator-session` in a single derive. Without this, the daemon
  // fail-louds at boot ("telegram secrets present but no telegram scope key").
  it('round-trips with precomputedKey (init-wizard fast path)', async () => {
    const operatorPrivkey = generatePrivateKey()
    const signer = new RawPrivkeyOperatorSigner({ privkey: operatorPrivkey })
    const agentAddress = privateKeyToAccount(generatePrivateKey()).address
    // Derive the TELEGRAM scope key explicitly (mirrors what runTelegramStep
    // does so it can both encrypt AND stash the key in operator-session).
    const tgKey = await deriveBlobKey(signer, agentAddress, OPERATOR_BLOB_SCOPES.TELEGRAM)
    expect(tgKey.length).toBe(32)

    await saveTelegramSecrets({
      signer,
      agentAddress,
      agentId: TEST_AGENT_ID,
      plaintext: {
        botToken: '8152506307:AAFbXSJ0qnfJNbLWkxbmzYEM9fc74uaznJs',
        botUsername: 'nebula_init_test_bot',
        botId: 8152506307,
        allowedUserIds: [1140813034],
      },
      precomputedKey: tgKey,
    })
    expect(existsSync(telegramSecretsPath(TEST_AGENT_ID))).toBe(true)

    const result = await loadTelegramHandoffSecrets({
      signer,
      agentAddress,
      agentId: TEST_AGENT_ID,
    })
    expect(result).toEqual({
      botToken: '8152506307:AAFbXSJ0qnfJNbLWkxbmzYEM9fc74uaznJs',
      allowedUserIds: [1140813034],
    })

    // Independent re-derive must produce the SAME 32-byte key (deterministic
    // HKDF output). This is what lets the daemon load the cached key from
    // `.operator-session` and successfully decrypt the blob the wizard wrote.
    const tgKey2 = await deriveBlobKey(signer, agentAddress, OPERATOR_BLOB_SCOPES.TELEGRAM)
    expect(Buffer.compare(tgKey, tgKey2)).toBe(0)
  })
})
