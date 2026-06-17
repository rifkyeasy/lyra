import { describe, expect, test } from 'bun:test'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'

describe('ApprovalRelay', () => {
  test('request creates pending + emits approval-needed', () => {
    const events = new EventHub()
    const relay = new ApprovalRelay(events)
    const { id } = relay.request({ kind: 'chain.send', amount: '0.001' })
    expect(id).toMatch(/^apv-/)
    expect(relay.has(id)).toBe(true)
    expect(events.buffer().some(e => e.kind === 'approval-needed')).toBe(true)
    relay.stop()
  })

  test('resolve unblocks promise + emits approval-resolved', async () => {
    const events = new EventHub()
    const relay = new ApprovalRelay(events)
    const { id, promise } = relay.request({ kind: 'shell.run', command: 'rm /tmp/x' })
    expect(relay.resolve(id, 'allow')).toBe(true)
    const decision = await promise
    expect(decision).toBe('allow')
    expect(events.buffer().some(e => e.kind === 'approval-resolved')).toBe(true)
    relay.stop()
  })

  test('resolve unknown id returns false', () => {
    const events = new EventHub()
    const relay = new ApprovalRelay(events)
    expect(relay.resolve('nonexistent', 'allow')).toBe(false)
    relay.stop()
  })

  test('expired pending resolves to deny + emits approval-expired', async () => {
    const events = new EventHub()
    const relay = new ApprovalRelay(events, { ttlMs: 5, sweepIntervalMs: 2 })
    const { promise } = relay.request({ kind: 'shell.run' })
    const decision = await promise
    expect(decision).toBe('deny')
    expect(events.buffer().some(e => e.kind === 'approval-expired')).toBe(true)
    relay.stop()
  })

  test('stop resolves all pending to deny', async () => {
    const events = new EventHub()
    const relay = new ApprovalRelay(events)
    const a = relay.request({ kind: 'a' })
    const b = relay.request({ kind: 'b' })
    relay.stop()
    expect(await a.promise).toBe('deny')
    expect(await b.promise).toBe('deny')
  })
})
