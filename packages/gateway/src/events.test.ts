import { describe, expect, test } from 'bun:test'
import { EventHub, type GatewayEvent } from './events'

describe('EventHub', () => {
  test('publishes events in seq order with monotonic ids', () => {
    const hub = new EventHub()
    const a = hub.publish('log', { msg: 'a' })
    const b = hub.publish('log', { msg: 'b' })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(b.ts).toBeGreaterThanOrEqual(a.ts)
    expect(hub.lastSeq()).toBe(2)
  })

  test('subscribers receive future events', () => {
    const hub = new EventHub()
    const got: GatewayEvent[] = []
    const unsub = hub.subscribe(e => got.push(e))
    hub.publish('log', { msg: 'a' })
    hub.publish('log', { msg: 'b' })
    expect(got.length).toBe(2)
    unsub()
    hub.publish('log', { msg: 'c' })
    expect(got.length).toBe(2)
  })

  test('sinceSeq replays buffered events', () => {
    const hub = new EventHub()
    hub.publish('log', { msg: 'a' })
    const b = hub.publish('log', { msg: 'b' })
    hub.publish('log', { msg: 'c' })
    const got: GatewayEvent[] = []
    hub.subscribe(e => got.push(e), b.seq)
    expect(got.map(e => e.seq)).toEqual([3])
  })

  test('buffer respects bufferLimit', () => {
    const hub = new EventHub({ bufferLimit: 3 })
    for (let i = 0; i < 10; i++) hub.publish('log', { i })
    const buf = hub.buffer()
    expect(buf.length).toBe(3)
    expect(buf[0]?.seq).toBe(8)
  })

  test('one slow subscriber does not block the bus', () => {
    const hub = new EventHub()
    const got: GatewayEvent[] = []
    hub.subscribe(() => {
      throw new Error('boom')
    })
    hub.subscribe(e => got.push(e))
    hub.publish('log', { msg: 'a' })
    expect(got.length).toBe(1)
  })

  test('sizeOfKind tracks tagged subscribers independently (v0.24.14)', () => {
    const hub = new EventHub()
    expect(hub.sizeOfKind('tui')).toBe(0)
    expect(hub.sizeOfKind('dashboard')).toBe(0)
    expect(hub.sizeOfKind('other')).toBe(0)

    const unsubA = hub.subscribe(() => {}, undefined, 'tui')
    const unsubB = hub.subscribe(() => {}, undefined, 'dashboard')
    const unsubC = hub.subscribe(() => {}, undefined, 'dashboard')
    const unsubD = hub.subscribe(() => {})

    expect(hub.size()).toBe(4)
    expect(hub.sizeOfKind('tui')).toBe(1)
    expect(hub.sizeOfKind('dashboard')).toBe(2)
    expect(hub.sizeOfKind('other')).toBe(1)

    unsubA()
    expect(hub.sizeOfKind('tui')).toBe(0)
    expect(hub.sizeOfKind('dashboard')).toBe(2)

    unsubB()
    unsubC()
    unsubD()
    expect(hub.size()).toBe(0)
  })

  test('subscribe defaults kind to "other" for back-compat (v0.24.14)', () => {
    const hub = new EventHub()
    hub.subscribe(() => {})
    expect(hub.sizeOfKind('other')).toBe(1)
    expect(hub.sizeOfKind('tui')).toBe(0)
    expect(hub.sizeOfKind('dashboard')).toBe(0)
  })
})
