// sendMessage / setMessageReaction retry classifier.
//
// RULE: timeout errors are NOT retryable, because the message MAY have been
// delivered already. Retrying could double-send. Connection errors (ECONNRESET,
// ENETUNREACH) are retryable because the server never received the request.
//
// Pattern from hermes (`base.py:1302` `_send_with_retry`).

export type RetryClassification = 'retry' | 'fail' | 'fail-silent'

/** Substrings that signal a transient network/connection failure. */
export const RETRYABLE_PATTERNS = [
  'connecterror',
  'connectionerror',
  'connectionreset',
  'connectionrefused',
  'connecttimeout',
  'network',
  'broken pipe',
  'remotedisconnected',
  'eoferror',
  'enetunreach',
  'eai_again',
  'socket hang up',
  'econnreset',
  'econnrefused',
] as const

/** Substrings that signal a true delivery-status-unknown timeout (NOT retryable). */
export const TIMEOUT_PATTERNS = [
  'timed out',
  'readtimeout',
  'writetimeout',
  'etimedout',
  'request timeout',
  'aborted',
] as const

/** User-facing notice when retries exhaust mid-stream. Hermes-aligned text. */
export const DELIVERY_FAILURE_NOTICE =
  '⚠️ Message delivery failed after multiple attempts. Please try again. Your request was processed but the response could not be sent.'

export function isRetryable(err: unknown): boolean {
  const lower = errorMessage(err).toLowerCase()
  return RETRYABLE_PATTERNS.some(p => lower.includes(p))
}

export function isTimeout(err: unknown): boolean {
  const lower = errorMessage(err).toLowerCase()
  return TIMEOUT_PATTERNS.some(p => lower.includes(p))
}

export function isReplyNotFound(err: unknown): boolean {
  const lower = errorMessage(err).toLowerCase()
  return (
    lower.includes('reply message not found') ||
    lower.includes('replied message not found') ||
    lower.includes('message to be replied')
  )
}

export function isThreadNotFound(err: unknown): boolean {
  const lower = errorMessage(err).toLowerCase()
  return lower.includes('thread') && lower.includes('not found')
}

export function classifyError(err: unknown): RetryClassification {
  if (isTimeout(err)) return 'fail'
  if (isRetryable(err)) return 'retry'
  const lower = errorMessage(err).toLowerCase()
  if (
    lower.includes('forbidden') ||
    lower.includes('chat not found') ||
    lower.includes('blocked')
  ) {
    return 'fail-silent'
  }
  if (lower.includes('bad request') || lower.includes('400')) return 'fail'
  return 'retry'
}

export interface RetryOpts {
  /** Max retry attempts. Default 2 (so 3 total attempts). */
  maxRetries?: number
  /** Base delay in ms; doubles per attempt. Default 250. */
  baseDelayMs?: number
}

export async function sendWithRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2
  const baseDelay = opts.baseDelayMs ?? 250
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const verdict = classifyError(err)
      if (verdict !== 'retry' || attempt === maxRetries) throw err
      await new Promise(r => setTimeout(r, baseDelay * 2 ** attempt))
    }
  }
  throw lastErr
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
