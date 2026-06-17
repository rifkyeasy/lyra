import { describe, expect, it } from 'bun:test'
import { RateLimiter } from './limits'

describe('RateLimiter', () => {
  it('allows up to capacity', () => {
    const r = new RateLimiter({ capacity: 3, windowMs: 1000 })
    const now = 1_000_000
    expect(r.shouldDrop(1, now)).toBe(false)
    expect(r.shouldDrop(1, now)).toBe(false)
    expect(r.shouldDrop(1, now)).toBe(false)
    expect(r.shouldDrop(1, now)).toBe(true)
  })
  it('drains independently per user', () => {
    const r = new RateLimiter({ capacity: 1, windowMs: 1000 })
    const now = 1_000_000
    expect(r.shouldDrop(1, now)).toBe(false)
    expect(r.shouldDrop(2, now)).toBe(false)
    expect(r.shouldDrop(1, now)).toBe(true)
    expect(r.shouldDrop(2, now)).toBe(true)
  })
  it('refills after window elapses', () => {
    const r = new RateLimiter({ capacity: 2, windowMs: 1000 })
    const t0 = 1_000_000
    expect(r.shouldDrop(1, t0)).toBe(false)
    expect(r.shouldDrop(1, t0)).toBe(false)
    expect(r.shouldDrop(1, t0)).toBe(true)
    // After full window, fully refilled
    expect(r.shouldDrop(1, t0 + 1000)).toBe(false)
    expect(r.shouldDrop(1, t0 + 1000)).toBe(false)
  })
  it('reset clears all buckets', () => {
    const r = new RateLimiter({ capacity: 1, windowMs: 1000 })
    expect(r.shouldDrop(1, 1)).toBe(false)
    expect(r.shouldDrop(1, 1)).toBe(true)
    r.reset()
    expect(r.shouldDrop(1, 1)).toBe(false)
  })
})
