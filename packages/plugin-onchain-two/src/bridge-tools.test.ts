import { beforeEach, describe, expect, test } from 'bun:test'
import { makeBridgeDeposit, makeBridgeStatus } from './bridge-tools'
import { InMemoryDepositStore } from './deposit-store'

const OWNER = `0x${'a'.repeat(64)}`

let store: InMemoryDepositStore
beforeEach(() => {
  store = new InMemoryDepositStore()
})

// Deterministic id factory for assertions.
const fixedId = (id: string) => () => id

describe('bridge.deposit', () => {
  test('opens a tracked USDC deposit and reports the CCTP route', async () => {
    const tool = makeBridgeDeposit(store, OWNER, fixedId('dep-1'))
    const r = await tool.handler({ from: 'Ethereum', token: 'USDC', amount: '50' })
    expect(r.ok).toBe(true)
    const data = r.data as { depositId: string; status: string; route: string }
    expect(data.depositId).toBe('dep-1')
    expect(data.status).toBe('initiated')
    expect(data.route).toMatch(/CCTP/)
    // persisted under the BOUND owner (not something from args)
    const stored = store.get('dep-1')
    expect(stored?.owner).toBe(OWNER)
    expect(stored?.needsSwap).toBe(false)
  })

  test('a non-USDC token takes the bridge+swap route', async () => {
    const tool = makeBridgeDeposit(store, OWNER, fixedId('dep-2'))
    const r = await tool.handler({ from: 'Base', token: 'WETH', amount: '2' })
    expect(r.ok).toBe(true)
    expect((r.data as { route: string }).route).toMatch(/swap/)
    expect(store.get('dep-2')?.needsSwap).toBe(true)
  })

  test('rejects an invalid request without touching the store', async () => {
    const tool = makeBridgeDeposit(store, OWNER, fixedId('dep-3'))
    const r = await tool.handler({ from: 'Bitcoin', token: 'USDC', amount: '10' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unsupported source chain/)
    expect(store.get('dep-3')).toBeNull()
  })

  test('defaults to a random uuid when no id factory is injected', async () => {
    const tool = makeBridgeDeposit(store, OWNER)
    const r = await tool.handler({ from: 'Arbitrum', token: 'USDC', amount: '5' })
    const id = (r.data as { depositId: string }).depositId
    expect(id).toMatch(/^[0-9a-f-]{36}$/) // uuid v4 shape
    expect(store.get(id)).not.toBeNull()
  })
})

describe('bridge.status', () => {
  test("lists only the bound owner's deposits", async () => {
    await makeBridgeDeposit(store, OWNER, fixedId('mine-1')).handler({
      from: 'Ethereum',
      token: 'USDC',
      amount: '1',
    })
    const other = `0x${'b'.repeat(64)}`
    await makeBridgeDeposit(store, other, fixedId('theirs')).handler({
      from: 'Base',
      token: 'USDC',
      amount: '1',
    })

    const r = await makeBridgeStatus(store, OWNER).handler({})
    const ids = (r.data as { deposits: { id: string }[] }).deposits.map(d => d.id)
    expect(ids).toEqual(['mine-1'])
  })

  test('filters by a specific deposit id and surfaces the next step', async () => {
    const dep = makeBridgeDeposit(store, OWNER, fixedId('d'))
    await dep.handler({ from: 'Ethereum', token: 'USDC', amount: '1' })
    const r = await makeBridgeStatus(store, OWNER).handler({ depositId: 'd' })
    const deposits = (r.data as { deposits: { id: string; nextStep: string }[] }).deposits
    expect(deposits).toHaveLength(1)
    expect(deposits[0]?.nextStep).toBe('await_source_burn')
  })

  test('returns an empty list for an owner with no deposits', async () => {
    const r = await makeBridgeStatus(store, OWNER).handler({})
    expect((r.data as { deposits: unknown[] }).deposits).toEqual([])
  })
})
