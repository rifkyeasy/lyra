import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BotTokenLockedError,
  acquireTelegramTokenLock,
  classifyStartFailure,
  clearStaleTelegramTokenLock,
  clearWebhookBeforePolling,
} from './recovery'

let lockDir: string

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'lyra-recovery-test-'))
})

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true })
})

describe('acquireTelegramTokenLock', () => {
  it('returns release/refresh handle when nothing else holds the token', () => {
    const lock = acquireTelegramTokenLock('123:fake-token-a', { rootDir: lockDir })
    expect(lock.release).toBeFunction()
    expect(lock.refresh).toBeFunction()
    expect(lock.refresh()).toBe(true)
    lock.release()
  })

  it('throws BotTokenLockedError when the same token is held', () => {
    const a = acquireTelegramTokenLock('123:fake-token-a', { rootDir: lockDir })
    expect(() => acquireTelegramTokenLock('123:fake-token-a', { rootDir: lockDir })).toThrow(
      BotTokenLockedError,
    )
    a.release()
  })

  it('different tokens do not collide', () => {
    const a = acquireTelegramTokenLock('111:token-x', { rootDir: lockDir })
    const b = acquireTelegramTokenLock('222:token-y', { rootDir: lockDir })
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    a.release()
    b.release()
  })

  it('release allows re-acquire by another caller', () => {
    const a = acquireTelegramTokenLock('agent:t', { rootDir: lockDir })
    a.release()
    const b = acquireTelegramTokenLock('agent:t', { rootDir: lockDir })
    expect(b).toBeDefined()
    b.release()
  })
})

describe('classifyStartFailure', () => {
  it('classifies error_code 409 as conflict + retryable', () => {
    const v = classifyStartFailure({ error_code: 409, message: 'Conflict' })
    expect(v.kind).toBe('conflict')
    expect(v.retryable).toBe(true)
  })

  it('classifies error_code 401 as auth + non-retryable', () => {
    const v = classifyStartFailure({ error_code: 401, message: 'Unauthorized' })
    expect(v.kind).toBe('auth')
    expect(v.retryable).toBe(false)
  })

  it('classifies ECONNRESET as network + retryable', () => {
    const v = classifyStartFailure(new Error('connect ECONNRESET 1.2.3.4'))
    expect(v.kind).toBe('network')
    expect(v.retryable).toBe(true)
  })

  it('classifies socket hang up as network', () => {
    const v = classifyStartFailure(new Error('socket hang up'))
    expect(v.kind).toBe('network')
  })

  it('classifies aborted as cancelled', () => {
    const v = classifyStartFailure(new Error('AbortError: aborted'))
    expect(v.kind).toBe('cancelled')
    expect(v.retryable).toBe(false)
  })

  it('falls through to fatal for unknown errors', () => {
    const v = classifyStartFailure(new Error('something weird'))
    expect(v.kind).toBe('fatal')
    expect(v.retryable).toBe(false)
  })
})

describe('clearStaleTelegramTokenLock', () => {
  it('returns no-lock when nothing exists', () => {
    const r = clearStaleTelegramTokenLock('token-xyz', { agentId: 'agent-7', rootDir: lockDir })
    expect(r.cleared).toBe(false)
    expect(r.reason).toBe('no-lock')
  })

  it('returns alive-pid when a live owner holds the lock', () => {
    const lock = acquireTelegramTokenLock('token-live', { agentId: 'agent-7', rootDir: lockDir })
    const r = clearStaleTelegramTokenLock('token-live', { agentId: 'agent-7', rootDir: lockDir })
    expect(r.cleared).toBe(false)
    expect(r.reason).toBe('alive-pid')
    lock.release()
  })

  it('clears a dead-PID lock written manually', () => {
    const identity = 'agent-7:token-zombie'
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
    const path = join(lockDir, `telegram-bot-token-${hash}.lock`)
    writeFileSync(
      path,
      JSON.stringify({
        pid: 999_996,
        scope: 'telegram-bot-token',
        identityHash: hash,
        startedAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        ttl: 600,
      }),
    )
    const r = clearStaleTelegramTokenLock('token-zombie', { agentId: 'agent-7', rootDir: lockDir })
    expect(r.cleared).toBe(true)
    expect(r.reason).toBe('cleared-stale')
  })

  it('lets a fresh acquire follow a clear', () => {
    const identity = 'agent-X:token-recoverable'
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
    const path = join(lockDir, `telegram-bot-token-${hash}.lock`)
    writeFileSync(
      path,
      JSON.stringify({
        pid: 999_995,
        scope: 'telegram-bot-token',
        identityHash: hash,
        startedAt: 0,
        updatedAt: 0,
        ttl: 1,
      }),
    )
    const cleanup = clearStaleTelegramTokenLock('token-recoverable', {
      agentId: 'agent-X',
      rootDir: lockDir,
    })
    expect(cleanup.cleared).toBe(true)
    const lock = acquireTelegramTokenLock('token-recoverable', {
      agentId: 'agent-X',
      rootDir: lockDir,
    })
    expect(lock).toBeDefined()
    lock.release()
  })
})

describe('clearWebhookBeforePolling', () => {
  it('calls bot.api.deleteWebhook with drop_pending_updates=false', async () => {
    let called = false
    let receivedArgs: unknown
    const fakeBot = {
      api: {
        deleteWebhook: async (args: unknown) => {
          called = true
          receivedArgs = args
        },
      },
    }
    await clearWebhookBeforePolling(fakeBot as never)
    expect(called).toBe(true)
    expect(receivedArgs).toEqual({ drop_pending_updates: false })
  })

  it('swallows deleteWebhook errors', async () => {
    const fakeBot = {
      api: {
        deleteWebhook: async () => {
          throw new Error('telegram down')
        },
      },
    }
    await expect(clearWebhookBeforePolling(fakeBot as never)).resolves.toBeUndefined()
  })
})
