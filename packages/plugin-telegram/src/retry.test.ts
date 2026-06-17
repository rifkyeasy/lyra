import { describe, expect, it } from 'bun:test'
import {
  DELIVERY_FAILURE_NOTICE,
  RETRYABLE_PATTERNS,
  TIMEOUT_PATTERNS,
  classifyError,
  isReplyNotFound,
  isRetryable,
  isThreadNotFound,
  isTimeout,
  sendWithRetry,
} from './retry'

describe('classifyError', () => {
  it('treats timeouts as fail (NOT retryable)', () => {
    expect(classifyError(new Error('ETIMEDOUT'))).toBe('fail')
    expect(classifyError(new Error('Request Timeout'))).toBe('fail')
    expect(classifyError(new Error('readtimeout'))).toBe('fail')
  })
  it('treats connection errors as retry', () => {
    expect(classifyError(new Error('ECONNRESET'))).toBe('retry')
    expect(classifyError(new Error('ECONNREFUSED'))).toBe('retry')
    expect(classifyError(new Error('Network unreachable'))).toBe('retry')
    expect(classifyError(new Error('socket hang up'))).toBe('retry')
  })
  it('forbidden / blocked surfaces as fail-silent', () => {
    expect(classifyError(new Error('Forbidden: bot was blocked by the user'))).toBe('fail-silent')
    expect(classifyError(new Error('chat not found'))).toBe('fail-silent')
  })
  it('400 bad request is fail (not retried)', () => {
    expect(classifyError(new Error('Bad Request: message is empty'))).toBe('fail')
  })
})

describe('sendWithRetry', () => {
  it('returns on first success', async () => {
    let calls = 0
    const r = await sendWithRetry(async () => {
      calls += 1
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(calls).toBe(1)
  })
  it('retries on retryable error then succeeds', async () => {
    let calls = 0
    const r = await sendWithRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new Error('ECONNRESET')
        return 'ok'
      },
      { maxRetries: 3, baseDelayMs: 1 },
    )
    expect(r).toBe('ok')
    expect(calls).toBe(3)
  })
  it('does NOT retry on timeout', async () => {
    let calls = 0
    await expect(
      sendWithRetry(
        async () => {
          calls += 1
          throw new Error('ETIMEDOUT')
        },
        { maxRetries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('ETIMEDOUT')
    expect(calls).toBe(1)
  })
  it('throws after exhausting retries', async () => {
    let calls = 0
    await expect(
      sendWithRetry(
        async () => {
          calls += 1
          throw new Error('ECONNRESET')
        },
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('ECONNRESET')
    expect(calls).toBe(3)
  })
})

describe('classifier helpers (isRetryable / isTimeout)', () => {
  it('isRetryable matches all RETRYABLE_PATTERNS', () => {
    for (const p of RETRYABLE_PATTERNS) {
      expect(isRetryable(new Error(`error: ${p}`))).toBe(true)
    }
  })

  it('isTimeout matches all TIMEOUT_PATTERNS', () => {
    for (const p of TIMEOUT_PATTERNS) {
      expect(isTimeout(new Error(`error: ${p}`))).toBe(true)
    }
  })

  it('isRetryable is false for timeouts (true delivery-unknown errors)', () => {
    expect(isRetryable(new Error('readtimeout'))).toBe(false)
    expect(isRetryable(new Error('writetimeout'))).toBe(false)
  })

  it('isReplyNotFound matches the BadRequest text', () => {
    expect(isReplyNotFound(new Error('Bad Request: reply message not found'))).toBe(true)
    expect(isReplyNotFound(new Error('Bad Request: message to be replied not found'))).toBe(true)
  })

  it('isReplyNotFound is false for unrelated errors', () => {
    expect(isReplyNotFound(new Error('Forbidden'))).toBe(false)
  })

  it('isThreadNotFound matches the BadRequest text', () => {
    expect(isThreadNotFound(new Error('Bad Request: message thread not found'))).toBe(true)
  })
})

describe('DELIVERY_FAILURE_NOTICE', () => {
  it('starts with the warning sigil and is single-line', () => {
    expect(DELIVERY_FAILURE_NOTICE.startsWith('⚠️')).toBe(true)
    expect(DELIVERY_FAILURE_NOTICE.includes('\n')).toBe(false)
  })

  it('mentions delivery failure', () => {
    expect(DELIVERY_FAILURE_NOTICE.toLowerCase()).toContain('delivery failed')
  })
})
