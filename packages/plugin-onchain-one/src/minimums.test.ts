import { describe, expect, test } from 'bun:test'
import { MIN_MIST, checkMinimum } from './minimums'

describe('checkMinimum', () => {
  test('rejects a too-small stake (0.1 SUI < 1 SUI minimum)', () => {
    const err = checkMinimum('stake', 100_000_000n) // 0.1 SUI
    expect(err).not.toBeNull()
    expect(err).toContain('amount too small')
    expect(err).toContain('1 SUI minimum for stake')
  })

  test('accepts a stake at the 1 SUI minimum', () => {
    expect(checkMinimum('stake', MIN_MIST.stake)).toBeNull()
    expect(checkMinimum('stake', 2_000_000_000n)).toBeNull()
  })

  test('rejects dust transfers/swaps/supplies below their minimums', () => {
    expect(checkMinimum('transfer', 1n)).not.toBeNull()
    expect(checkMinimum('swap', 1_000_000n)).not.toBeNull() // 0.001 < 0.01
    expect(checkMinimum('supply', 5_000_000n)).not.toBeNull() // 0.005 < 0.01
    expect(checkMinimum('borrow', 9_999_999n)).not.toBeNull()
  })

  test('accepts amounts at/above the minimum', () => {
    expect(checkMinimum('transfer', MIN_MIST.transfer)).toBeNull()
    expect(checkMinimum('swap', MIN_MIST.swap)).toBeNull()
    expect(checkMinimum('supply', MIN_MIST.supply)).toBeNull()
    expect(checkMinimum('borrow', MIN_MIST.borrow)).toBeNull()
  })

  test('the message names the amount, the minimum, and the action', () => {
    const err = checkMinimum('swap', 5_000_000n) // 0.005 SUI
    expect(err).toContain('0.005 SUI')
    expect(err).toContain('0.01 SUI minimum for swap')
  })
})
