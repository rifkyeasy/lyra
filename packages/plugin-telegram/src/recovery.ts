// Listener recovery primitives.
//
// Token lock: only one lyra process per machine can poll a given bot token.
// Cross-machine collisions (laptop + sandbox both polling same bot) still
// produce 409 Conflict on bot.start. We classify those failures so callers
// can decide retry/abort. The 3-retry-409 + 10-retry-network state machines
// hermes runs internally are deferred to v0.19 when we adopt @grammyjs/runner
// for finer-grained polling control. For v0.18.x the lock plus explicit
// classification is sufficient.

import type { Bot } from 'grammy'
import {
  type ClearStaleScopedLockResult,
  DEFAULT_LOCK_TTL_SECONDS,
  type ScopedLockHandle,
  acquireScopedLock,
  clearStaleScopedLock,
} from 'lyra-core'

export const TELEGRAM_TOKEN_LOCK_SCOPE = 'telegram-bot-token'

export class BotTokenLockedError extends Error {
  readonly heldByPid: number
  readonly heldSinceSec: number
  constructor(pid: number, sinceSec: number) {
    super(`telegram bot token already in use by pid ${pid} (started ${sinceSec})`)
    this.name = 'BotTokenLockedError'
    this.heldByPid = pid
    this.heldSinceSec = sinceSec
  }
}

export interface AcquireTokenLockOpts {
  agentId?: string
  ttl?: number
  rootDir?: string
}

export interface TokenLock {
  release: () => void
  refresh: () => boolean
}

export function acquireTelegramTokenLock(
  botToken: string,
  opts: AcquireTokenLockOpts = {},
): TokenLock {
  const identity = `${opts.agentId ?? 'default'}:${botToken}`
  const result = acquireScopedLock({
    scope: TELEGRAM_TOKEN_LOCK_SCOPE,
    identity,
    ttl: opts.ttl ?? DEFAULT_LOCK_TTL_SECONDS,
    rootDir: opts.rootDir,
  })
  if (!(result.acquired && result.handle)) {
    const ex = result.existing ?? { pid: -1, startedAt: 0, updatedAt: 0 }
    throw new BotTokenLockedError(ex.pid, ex.startedAt)
  }
  return wrapLockHandle(result.handle)
}

function wrapLockHandle(handle: ScopedLockHandle): TokenLock {
  return { release: handle.releaseFn, refresh: handle.refreshFn }
}

/**
 * v0.21.5: gateway boot must proactively reap a zombie/crashed listener's
 * bot-token lock before TelegramListener.start() runs. Without this, the
 * acquire path calls scheduleStartRetry which waits 30s × 12 attempts (6 min)
 * for the TTL to expire — operators see "TG silent" the whole time.
 *
 * Returns whether a stale lock was cleared. Never deletes a lock held by a
 * live foreign PID (that's the legitimate "another lyra is polling this bot"
 * case, where the listener should fail loud).
 *
 * Identity hash matches `acquireTelegramTokenLock`: `${agentId ?? 'default'}:${botToken}`.
 */
export function clearStaleTelegramTokenLock(
  botToken: string,
  opts: AcquireTokenLockOpts = {},
): ClearStaleScopedLockResult {
  const identity = `${opts.agentId ?? 'default'}:${botToken}`
  return clearStaleScopedLock({
    scope: TELEGRAM_TOKEN_LOCK_SCOPE,
    identity,
    rootDir: opts.rootDir,
  })
}

/**
 * Pre-polling webhook clear. grammy does this internally on bot.start, but
 * making it explicit lets us surface failures (rare but possible if someone
 * sets a webhook between init and start_polling).
 */
export async function clearWebhookBeforePolling(bot: Bot): Promise<void> {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false })
  } catch {
    // Best-effort; grammy retries on bot.start. Caller can opt in to logging.
  }
}

export type StartFailureKind = 'conflict' | 'network' | 'auth' | 'fatal' | 'cancelled'

export interface StartFailure {
  kind: StartFailureKind
  detail: string
  retryable: boolean
}

export function classifyStartFailure(err: unknown): StartFailure {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  const code = (err as { error_code?: number }).error_code
  if (code === 409) return { kind: 'conflict', detail: msg, retryable: true }
  if (code === 401) return { kind: 'auth', detail: msg, retryable: false }
  if (
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enetunreach') ||
    lower.includes('socket hang up') ||
    lower.includes('eai_again') ||
    lower.includes('network')
  ) {
    return { kind: 'network', detail: msg, retryable: true }
  }
  if (lower.includes('aborted') || lower.includes('cancelled')) {
    return { kind: 'cancelled', detail: msg, retryable: false }
  }
  return { kind: 'fatal', detail: msg, retryable: false }
}
