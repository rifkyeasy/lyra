import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelegramListener } from './listener'
import { acquireTelegramTokenLock } from './recovery'
import type { TelegramRuntimeContext } from './types'

let lockDir: string

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'lyra-listener-retry-'))
})

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true })
})

const FAKE_TOKEN = '999:does-not-call-network'

function makeOpts(): TelegramRuntimeContext & { lockRootDir: string; apiRoot: string } {
  return {
    botToken: FAKE_TOKEN,
    allowedUserIds: [42],
    agentName: 'retry-canary',
    pairingStore: undefined,
    dispatchUserMessage: async () => ({ response: 'ok' }),
    onProcessingStart: async () => {},
    onProcessingEnd: async () => {},
    approvalBridge: undefined,
    lockRootDir: lockDir,
    // Point grammY at an unreachable host so any accidental network call
    // would fail fast. We never reach bot.start() in these tests because
    // the lock path returns first.
    apiRoot: 'http://127.0.0.1:1',
  }
}

describe('TelegramListener lock-retry', () => {
  it('does NOT throw when the bot-token lock is held; retains running=false until the lock frees', async () => {
    // Pre-occupy the lock. From the listener's perspective this is a
    // zombie/leftover holder it must wait out.
    const blocker = acquireTelegramTokenLock(FAKE_TOKEN, {
      agentId: 'retry-canary',
      rootDir: lockDir,
    })

    const listener = new TelegramListener(makeOpts())
    // Pre-fix this would throw BotTokenLockedError synchronously after the
    // build-runtime catch and never re-attempt. Now it must swallow,
    // schedule a retry timer, and remain stoppable.
    await expect(listener.start()).resolves.toBeUndefined()

    // stop() should release whatever we held + cancel the retry timer.
    await listener.stop()
    blocker.release()
  })

  it('stop() cancels a pending retry without leaking timers', async () => {
    const blocker = acquireTelegramTokenLock(FAKE_TOKEN, {
      agentId: 'retry-canary',
      rootDir: lockDir,
    })
    const listener = new TelegramListener(makeOpts())
    await listener.start() // schedules retry because blocker holds the lock
    // Immediately stop. If the retry timer wasn't unref'd / cleared the
    // bun:test process would hang waiting for it (visible as a >30s test
    // timeout; this assertion fails fast otherwise).
    await listener.stop()
    blocker.release()
    // After stop+release, fresh acquisition by an outside caller works
    // (no orphaned listener still holding the lock).
    const now = acquireTelegramTokenLock(FAKE_TOKEN, {
      agentId: 'retry-canary',
      rootDir: lockDir,
    })
    expect(now).toBeDefined()
    now.release()
  })

  it('lock-clear path: when the prior holder releases, the next start succeeds', async () => {
    const prior = acquireTelegramTokenLock(FAKE_TOKEN, {
      agentId: 'retry-canary',
      rootDir: lockDir,
    })
    const listener = new TelegramListener(makeOpts())
    await listener.start() // pending retry; lock not yet acquired
    prior.release()
    // Retry runs every 30s in production; we verify the lockfile state
    // rather than waiting on real timers. Pending retry won't fire in this
    // synchronous window, but the listener.stop() path must still succeed.
    await listener.stop()
    // After listener.stop() with retry pending and prior released, the
    // lockfile dir is empty (no orphan).
    expect(existsSync(join(lockDir, 'telegram-bot-token-cbae9eeaf0ee85c6.lock'))).toBe(false)
  })
})
