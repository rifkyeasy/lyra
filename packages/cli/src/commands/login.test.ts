import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { type LoginDeps, deviceLink, resolveWebBase } from './login'

// Isolate the agent dir so writeAgentKey() (called on approval) doesn't touch
// the real ~/.lyra.
let prevRoot: string | undefined
beforeEach(() => {
  prevRoot = process.env.LYRA_ROOT
  process.env.LYRA_ROOT = mkdtempSync(join(tmpdir(), 'lyra-login-'))
})
afterEach(() => {
  if (prevRoot === undefined) Reflect.deleteProperty(process.env, 'LYRA_ROOT')
  else process.env.LYRA_ROOT = prevRoot
})

/** Build a mock fetch over a scripted sequence of poll responses. */
function mockFetch(start: unknown, polls: unknown[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  let pollIdx = 0
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/api/cli/login/start')) {
      return new Response(JSON.stringify(start), { status: 200 })
    }
    if (u.includes('/api/cli/login/poll')) {
      const body = polls[Math.min(pollIdx, polls.length - 1)]
      pollIdx += 1
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const baseDeps = (fetchImpl: typeof fetch): LoginDeps => ({
  base: 'https://example.test',
  fetchImpl,
  sleep: async () => {},
  log: () => {},
  openBrowser: () => {},
})

describe('resolveWebBase', () => {
  test('defaults to lyraai.space, env override wins', () => {
    expect(resolveWebBase({})).toBe('https://lyraai.space')
    expect(resolveWebBase({ LYRA_WEB_URL: 'http://localhost:3000' })).toBe('http://localhost:3000')
  })
})

describe('deviceLink contract', () => {
  test('calls start then poll, writes key on approved, returns address', async () => {
    const kp = new Ed25519Keypair()
    const agentKey = kp.getSecretKey()
    const owner = `0x${'a'.repeat(64)}`
    const { fetchImpl, calls } = mockFetch(
      { code: 'ABCD', pollToken: 'tok-1', verifyUrl: 'https://example.test/cli', expiresInSec: 60 },
      [{ status: 'pending' }, { status: 'approved', owner, agentKey }],
    )
    const res = await deviceLink(baseDeps(fetchImpl))
    expect(res.owner).toBe(owner)
    expect(res.address).toBe(kp.toSuiAddress())
    // start first, then at least two polls.
    expect(calls[0]).toContain('/api/cli/login/start')
    expect(calls[1]).toContain('/api/cli/login/poll?pollToken=tok-1')
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })

  test('throws a friendly error on expired', async () => {
    const { fetchImpl } = mockFetch(
      { code: 'X', pollToken: 't', verifyUrl: 'https://example.test/cli', expiresInSec: 60 },
      [{ status: 'expired' }],
    )
    await expect(deviceLink(baseDeps(fetchImpl))).rejects.toThrow(/expired/i)
  })

  test('throws on not_found', async () => {
    const { fetchImpl } = mockFetch(
      { code: 'X', pollToken: 't', verifyUrl: 'https://example.test/cli', expiresInSec: 60 },
      [{ status: 'not_found' }],
    )
    await expect(deviceLink(baseDeps(fetchImpl))).rejects.toThrow(/not found/i)
  })

  test('times out when expiresInSec elapses without approval', async () => {
    const { fetchImpl } = mockFetch(
      { code: 'X', pollToken: 't', verifyUrl: 'https://example.test/cli', expiresInSec: 4 },
      [{ status: 'pending' }],
    )
    // Advancing clock: each read jumps 1s, so a 4s window closes after a few
    // polls without ever hitting the wall clock.
    let t = 0
    const now = (): number => {
      t += 1000
      return t
    }
    const deps: LoginDeps = { ...baseDeps(fetchImpl), now }
    await expect(deviceLink(deps)).rejects.toThrow(/timed out/i)
  })
})
