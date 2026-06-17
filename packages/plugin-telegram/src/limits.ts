/**
 * Per-user token-bucket rate limiter. Defends against a compromised allowed
 * user account spamming the brain (and burning compute credits).
 *
 * Default: 30 messages per 60 seconds. Excess get dropped + a 👎 reaction (the
 * listener handles the reaction; this module just answers shouldDrop).
 */
export interface RateLimiterOpts {
  /** Bucket capacity per user. Default 30. */
  capacity?: number
  /** Refill window in ms. Default 60_000. */
  windowMs?: number
}

interface Bucket {
  /** Remaining tokens. */
  tokens: number
  /** Unix-ms timestamp of the last refill. */
  lastRefill: number
}

export class RateLimiter {
  private readonly capacity: number
  private readonly windowMs: number
  private readonly buckets = new Map<number, Bucket>()

  constructor(opts: RateLimiterOpts = {}) {
    this.capacity = opts.capacity ?? 30
    this.windowMs = opts.windowMs ?? 60_000
  }

  /**
   * Returns true if this user's message should be DROPPED (bucket empty).
   * Side-effect: consumes one token if not dropped.
   */
  shouldDrop(userId: number, now: number = Date.now()): boolean {
    const b = this.buckets.get(userId) ?? { tokens: this.capacity, lastRefill: now }
    // Refill proportional to elapsed time
    const elapsed = now - b.lastRefill
    if (elapsed > 0) {
      const refill = Math.floor((elapsed / this.windowMs) * this.capacity)
      if (refill > 0) {
        b.tokens = Math.min(this.capacity, b.tokens + refill)
        b.lastRefill = now
      }
    }
    if (b.tokens <= 0) {
      this.buckets.set(userId, b)
      return true
    }
    b.tokens -= 1
    this.buckets.set(userId, b)
    return false
  }

  reset(userId?: number): void {
    if (userId === undefined) this.buckets.clear()
    else this.buckets.delete(userId)
  }
}
