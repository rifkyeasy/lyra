import { beforeEach, describe, expect, test } from 'bun:test'
import { InMemoryDepositStore, type NewDeposit } from './deposit-store'

const SAMPLE: NewDeposit = {
  id: 'dep-1',
  owner: '0xowner',
  sourceChain: 'Ethereum',
  sourceToken: 'USDC',
  amount: '100',
  needsSwap: false,
}

let store: InMemoryDepositStore
beforeEach(() => {
  store = new InMemoryDepositStore()
})

describe('create', () => {
  test('opens a deposit in the initiated state with timestamps', () => {
    const d = store.create(SAMPLE, 1000)
    expect(d.status).toBe('initiated')
    expect(d.createdMs).toBe(1000)
    expect(d.updatedMs).toBe(1000)
    expect(d.owner).toBe('0xowner')
  })

  test('rejects a duplicate id (idempotency key)', () => {
    store.create(SAMPLE, 1000)
    expect(() => store.create(SAMPLE, 1001)).toThrow(/already exists/)
  })
})

describe('get / listByOwner / listActive', () => {
  test('get returns a copy, or null when missing', () => {
    store.create(SAMPLE, 1000)
    const got = store.get('dep-1')
    expect(got?.id).toBe('dep-1')
    got!.amount = 'mutated'
    expect(store.get('dep-1')?.amount).toBe('100') // store is not mutated
    expect(store.get('nope')).toBeNull()
  })

  test('listByOwner filters by owner', () => {
    store.create(SAMPLE, 1000)
    store.create({ ...SAMPLE, id: 'dep-2', owner: '0xother' }, 1000)
    expect(store.listByOwner('0xowner').map(d => d.id)).toEqual(['dep-1'])
  })

  test('listActive excludes terminal deposits', () => {
    store.create(SAMPLE, 1000)
    store.create({ ...SAMPLE, id: 'dep-2' }, 1000)
    store.transition('dep-2', 'failed', { error: 'x' }, 1001)
    expect(store.listActive().map(d => d.id)).toEqual(['dep-1'])
  })
})

describe('transition', () => {
  test('advances through the full happy path, merging artifacts', () => {
    store.create(SAMPLE, 1000)
    store.transition('dep-1', 'source_burned', { burnTxHash: '0xburn' }, 1100)
    store.transition('dep-1', 'attested', { attestation: 'att' }, 1200)
    store.transition('dep-1', 'sui_redeemed', { suiRedeemDigest: 'dig1' }, 1300)
    const done = store.transition('dep-1', 'vault_deposited', { vaultDepositDigest: 'dig2' }, 1400)
    expect(done.status).toBe('vault_deposited')
    expect(done.burnTxHash).toBe('0xburn')
    expect(done.attestation).toBe('att')
    expect(done.vaultDepositDigest).toBe('dig2')
    expect(done.updatedMs).toBe(1400)
    expect(done.createdMs).toBe(1000)
  })

  test('supports the swap branch for long-tail source tokens', () => {
    store.create({ ...SAMPLE, needsSwap: true, sourceToken: 'PEPE' }, 1000)
    store.transition('dep-1', 'source_burned', {}, 1100)
    store.transition('dep-1', 'attested', {}, 1200)
    store.transition('dep-1', 'sui_redeemed', {}, 1300)
    store.transition('dep-1', 'swapped_to_usdc', { suiSwapDigest: 'sdig' }, 1350)
    const done = store.transition('dep-1', 'vault_deposited', {}, 1400)
    expect(done.status).toBe('vault_deposited')
    expect(done.suiSwapDigest).toBe('sdig')
  })

  test('rejects an illegal transition', () => {
    store.create(SAMPLE, 1000)
    expect(() => store.transition('dep-1', 'attested', {}, 1100)).toThrow(/illegal/)
  })

  test('rejects a transition on a missing deposit', () => {
    expect(() => store.transition('ghost', 'source_burned', {}, 1100)).toThrow(/not found/)
  })

  test('a patch cannot rewrite id / owner / createdMs', () => {
    store.create(SAMPLE, 1000)
    const d = store.transition(
      'dep-1',
      'source_burned',
      { id: 'evil', owner: '0xevil', createdMs: 9 } as never,
      1100,
    )
    expect(d.id).toBe('dep-1')
    expect(d.owner).toBe('0xowner')
    expect(d.createdMs).toBe(1000)
  })
})

describe('fail', () => {
  test('terminal-fails from any non-terminal state with a reason', () => {
    store.create(SAMPLE, 1000)
    store.transition('dep-1', 'source_burned', {}, 1100)
    const failed = store.fail('dep-1', 'attestation timeout', 1200)
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('attestation timeout')
  })

  test('cannot fail an already-completed deposit', () => {
    store.create(SAMPLE, 1000)
    store.transition('dep-1', 'source_burned', {}, 1100)
    store.transition('dep-1', 'attested', {}, 1200)
    store.transition('dep-1', 'sui_redeemed', {}, 1300)
    store.transition('dep-1', 'vault_deposited', {}, 1400)
    expect(() => store.fail('dep-1', 'too late', 1500)).toThrow(/illegal/)
  })
})
