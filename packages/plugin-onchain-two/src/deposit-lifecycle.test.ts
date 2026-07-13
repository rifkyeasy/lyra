import { describe, expect, test } from 'bun:test'
import { type DepositStatus, canTransition, isTerminal, nextAction } from './deposit-lifecycle'

const ALL: DepositStatus[] = [
  'initiated',
  'source_burned',
  'attested',
  'sui_redeemed',
  'swapped_to_usdc',
  'vault_deposited',
  'failed',
]

describe('isTerminal', () => {
  test('only vault_deposited and failed are terminal', () => {
    expect(ALL.filter(isTerminal).sort()).toEqual(['failed', 'vault_deposited'])
  })
})

describe('canTransition', () => {
  test('happy-path forward steps are legal', () => {
    expect(canTransition('initiated', 'source_burned')).toBe(true)
    expect(canTransition('source_burned', 'attested')).toBe(true)
    expect(canTransition('attested', 'sui_redeemed')).toBe(true)
    expect(canTransition('sui_redeemed', 'vault_deposited')).toBe(true)
    expect(canTransition('sui_redeemed', 'swapped_to_usdc')).toBe(true)
    expect(canTransition('swapped_to_usdc', 'vault_deposited')).toBe(true)
  })

  test('any non-terminal state can fail', () => {
    for (const s of ALL.filter(x => !isTerminal(x))) {
      expect(canTransition(s, 'failed')).toBe(true)
    }
  })

  test('terminal states cannot transition (not even to failed)', () => {
    expect(canTransition('vault_deposited', 'failed')).toBe(false)
    expect(canTransition('failed', 'source_burned')).toBe(false)
    expect(canTransition('vault_deposited', 'source_burned')).toBe(false)
  })

  test('skipping a step is illegal', () => {
    expect(canTransition('initiated', 'attested')).toBe(false)
    expect(canTransition('attested', 'vault_deposited')).toBe(false)
    expect(canTransition('source_burned', 'sui_redeemed')).toBe(false)
  })

  test('going backwards is illegal', () => {
    expect(canTransition('attested', 'source_burned')).toBe(false)
    expect(canTransition('vault_deposited', 'sui_redeemed')).toBe(false)
  })
})

describe('nextAction', () => {
  test('drives each state to the right next action', () => {
    expect(nextAction('initiated', false)).toBe('await_source_burn')
    expect(nextAction('source_burned', false)).toBe('await_attestation')
    expect(nextAction('attested', false)).toBe('submit_sui_redeem')
    expect(nextAction('swapped_to_usdc', false)).toBe('deposit_to_vault')
    expect(nextAction('vault_deposited', false)).toBe('none')
    expect(nextAction('failed', false)).toBe('none')
  })

  test('after redeem, needsSwap decides swap vs direct deposit', () => {
    expect(nextAction('sui_redeemed', true)).toBe('swap_to_usdc')
    expect(nextAction('sui_redeemed', false)).toBe('deposit_to_vault')
  })
})
