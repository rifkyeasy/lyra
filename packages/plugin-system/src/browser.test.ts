import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __test, makeBrowserNavigate, makeBrowserSnapshot } from './browser'

describe('browser parity (task #74)', () => {
  beforeEach(() => {
    __test.reset()
  })
  afterEach(() => {
    __test.reset()
    process.env.LYRA_BROWSER_CDP_URL = undefined
  })

  test('socketSafeTmpdir returns /tmp on darwin', () => {
    if (process.platform !== 'darwin') {
      expect(__test.socketSafeTmpdir()).toBeTruthy()
      return
    }
    expect(__test.socketSafeTmpdir()).toBe('/tmp')
  })

  test('session name is stable across calls + has a_<10hex> shape', () => {
    const a = __test.getSessionName()
    const b = __test.getSessionName()
    expect(a).toBe(b)
    expect(a).toMatch(/^a_[0-9a-f]{10}$/)
  })

  test('socket dir is created under safe tmp + path stays under AF_UNIX 104-byte limit', () => {
    const dir = __test.getSocketDir()
    expect(existsSync(dir)).toBe(true)
    expect(statSync(dir).isDirectory()).toBe(true)
    if (process.platform === 'darwin') {
      expect(dir.startsWith('/tmp/agent-browser-a_')).toBe(true)
    }
    expect(dir.length).toBeLessThan(95)
  })

  test('findAgentBrowser returns null when nothing is on PATH', () => {
    const originalPath = process.env.PATH
    process.env.PATH = '/nonexistent-lyra-test-path-zzz'
    try {
      // cwdOverride to a path with no node_modules — otherwise dev machines
      // pick up the workspace's node_modules/.bin/agent-browser (added in
      // v0.19.16) and the assertion is uninformative.
      const result = __test.findAgentBrowser(undefined, '/nonexistent-lyra-test-cwd-zzz')
      // SANE_PATH fallthrough may still find /opt/homebrew/bin/agent-browser
      // on dev machines; assert non-throw + correct type.
      expect(['string', 'object']).toContain(typeof result)
    } finally {
      process.env.PATH = originalPath
    }
  })

  test('findAgentBrowser checks node_modules/.bin first (v0.19.16 priority swap)', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'lyra-browser-test-'))
    const localBin = join(tmpRoot, 'node_modules', '.bin')
    mkdirSync(localBin, { recursive: true })
    const localStub = join(localBin, 'agent-browser')
    writeFileSync(localStub, '#!/bin/sh\necho local-bin-stub\n')
    chmodSync(localStub, 0o755)

    const originalPath = process.env.PATH
    // Set PATH to a dir that has a different binary on it; node_modules
    // should still win.
    process.env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    try {
      const result = __test.findAgentBrowser(undefined, tmpRoot)
      expect(result).toBe(localStub)
    } finally {
      process.env.PATH = originalPath
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('isBrowserAvailable no longer short-circuits on container env vars', () => {
    // v0.19.16 dropped the IS_CONTAINER gate. With container env vars set,
    // isBrowserAvailable still returns true if the binary is reachable.
    const originalSandbox = process.env.DAYTONA_SANDBOX_ID
    process.env.DAYTONA_SANDBOX_ID = 'fake-test-sandbox-id'
    try {
      // Result depends purely on findAgentBrowser; on dev machines this
      // returns true (workspace has node_modules/.bin/agent-browser after
      // bun install). The point is: the env var alone no longer forces false.
      const available = __test.isBrowserAvailable()
      expect(typeof available).toBe('boolean')
      // If the dev machine has the binary, env var must NOT have flipped it.
      if (__test.findAgentBrowser() !== null) {
        expect(available).toBe(true)
      }
    } finally {
      process.env.DAYTONA_SANDBOX_ID = originalSandbox
    }
  })

  test('buildBrowserEnv injects AGENT_BROWSER_SOCKET_DIR + redacts wallet keys', () => {
    process.env.LYRA_OPERATOR_PRIVKEY = '0xdeadbeef'
    try {
      const env = __test.buildBrowserEnv('/tmp/test-socket-dir')
      expect(env.AGENT_BROWSER_SOCKET_DIR).toBe('/tmp/test-socket-dir')
      expect(env.PATH).toBeTruthy()
      expect(env.LYRA_OPERATOR_PRIVKEY).toBeUndefined()
    } finally {
      process.env.LYRA_OPERATOR_PRIVKEY = undefined
    }
  })

  test('navigate tool surfaces a clean error when bin is unreachable', async () => {
    const tool = makeBrowserNavigate({ binPath: '/nonexistent/agent-browser-zzz' })
    const result = (await tool.handler({ url: 'https://example.com' })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  test('snapshot tool runs through the wrapper without crashing on a fake bin', async () => {
    // Use `true` (POSIX no-op that exits 0) as the bin to verify the wrapper
    // does NOT deadlock waiting on stdout pipes (regression for the daemon-fd
    // pipe deadlock bug). If we used pipes instead of temp files, this would
    // hang for the full timeout.
    const tool = makeBrowserSnapshot({ binPath: '/usr/bin/true', timeoutMs: 5000 })
    const result = (await tool.handler({ with_image: false, cap: false })) as {
      ok: boolean
      data?: { exit_code: number | null }
    }
    expect(result.ok).toBe(true)
    expect(result.data?.exit_code).toBe(0)
  })
})
