import { describe, expect, test } from 'bun:test'
import { policyRequiresApprovalForCall } from './approval'
import { VALUE_MOVING_TOOL_NAMES, isValueMovingTool } from './catalog'
import type { SuiPolicy } from './policy'

describe('isValueMovingTool — fail-closed catalog gate', () => {
  test('read-only tools are NOT value-moving', () => {
    for (const n of [
      'sui.balance',
      'account.info',
      'cetus.quote',
      'navi.position',
      'defi.yields',
    ]) {
      expect(isValueMovingTool(n)).toBe(false)
    }
  })

  test('every write/spend/stake tool IS value-moving (not just sui.send)', () => {
    for (const n of [
      'sui.send',
      'swap',
      'suilend.supply',
      'suilend.borrow',
      'navi.borrow',
      'scallop.withdraw',
      'sui.stake',
      'volo.unstake',
      'walrus.stake',
      'walrus.store',
      'policy.create',
    ]) {
      expect(isValueMovingTool(n)).toBe(true)
    }
  })

  test('unknown / non-onchain tool names are not value-moving', () => {
    expect(isValueMovingTool('memory.save')).toBe(false)
    expect(isValueMovingTool('tool.search')).toBe(false)
    expect(isValueMovingTool('totally.unknown')).toBe(false)
  })

  test('the set covers more than one tool (regression against the old sui.send-only gate)', () => {
    expect(VALUE_MOVING_TOOL_NAMES.size).toBeGreaterThan(10)
  })
})

describe('policyRequiresApprovalForCall — covers all value-moving tools', () => {
  const confirm: SuiPolicy = { autonomy: 'confirm' }
  const autoWithCeiling: SuiPolicy = { autonomy: 'auto', autoMaxMistPerTx: 100_000_000n }

  test('no policy → never forces (operator opted out)', () => {
    expect(policyRequiresApprovalForCall('suilend.borrow', { amount: '5' }, undefined)).toBe(false)
  })

  test('read-only tool → never forces even under confirm', () => {
    expect(policyRequiresApprovalForCall('navi.position', {}, confirm)).toBe(false)
  })

  test('a non-sui.send value-moving tool forces approval under confirm', () => {
    // This is the regression: previously only sui.send mapped to an action, so
    // suilend.borrow/swap/etc. slipped past the approval floor entirely.
    expect(policyRequiresApprovalForCall('suilend.borrow', { amount: '5' }, confirm)).toBe(true)
    expect(policyRequiresApprovalForCall('swap', { amount: '1' }, confirm)).toBe(true)
    expect(policyRequiresApprovalForCall('walrus.stake', { amount: '1' }, confirm)).toBe(true)
  })

  test('under auto+ceiling, an unmappable value-moving tool escalates (can’t prove under cap)', () => {
    expect(policyRequiresApprovalForCall('navi.borrow', { amount: '999' }, autoWithCeiling)).toBe(
      true,
    )
  })

  test('sui.send keeps its precise amount-based verdict', () => {
    // Below the auto ceiling → no forced approval; above → forced.
    expect(policyRequiresApprovalForCall('sui.send', { amount: '0.05' }, autoWithCeiling)).toBe(
      false,
    )
    expect(policyRequiresApprovalForCall('sui.send', { amount: '5' }, autoWithCeiling)).toBe(true)
  })
})
