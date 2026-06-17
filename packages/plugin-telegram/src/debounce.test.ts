import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { DebounceBuffer, type FlushedBatch } from './debounce'

describe('DebounceBuffer', () => {
  let originalSetTimeout: typeof setTimeout
  let originalClearTimeout: typeof clearTimeout
  let scheduled: { fn: () => void; delay: number; id: number }[] = []
  let nextId = 1

  beforeEach(() => {
    originalSetTimeout = global.setTimeout
    originalClearTimeout = global.clearTimeout
    scheduled = []
    nextId = 1
    global.setTimeout = ((fn: () => void, delay: number) => {
      const id = nextId++
      scheduled.push({ fn, delay, id })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    global.clearTimeout = ((id: number) => {
      scheduled = scheduled.filter(s => s.id !== id)
    }) as typeof clearTimeout
  })

  afterEach(() => {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  })

  function fragment(
    overrides: Partial<{
      text: string
      messageId: number
      ts: number
      userId: number
      username: string | null
      displayName: string | null
    }> = {},
  ) {
    return {
      text: overrides.text ?? 'hi',
      messageId: overrides.messageId ?? 1,
      ts: overrides.ts ?? 1,
      userId: overrides.userId ?? 100,
      username: overrides.username ?? null,
      displayName: overrides.displayName ?? null,
    }
  }

  function fireLatestTimer(): void {
    const last = scheduled.pop()
    if (last) last.fn()
  }

  it('coalesces rapid fragments into one batch', () => {
    const flushed: { chatId: number; batch: FlushedBatch }[] = []
    const buf = new DebounceBuffer((chatId, batch) => flushed.push({ chatId, batch }), {
      quietPeriodMs: 100,
    })
    buf.push(1, fragment({ text: 'hello', messageId: 1, ts: 100 }))
    buf.push(1, fragment({ text: 'world', messageId: 2, ts: 200 }))
    buf.push(1, fragment({ text: '!', messageId: 3, ts: 300 }))
    expect(flushed).toHaveLength(0)
    fireLatestTimer()
    expect(flushed).toHaveLength(1)
    expect(flushed[0]!.chatId).toBe(1)
    expect(flushed[0]!.batch.text).toBe('hello\nworld\n!')
    expect(flushed[0]!.batch.fragmentCount).toBe(3)
    expect(flushed[0]!.batch.latestMessageId).toBe(3)
  })

  it('keeps separate buffers per chat', () => {
    const flushed: { chatId: number; batch: FlushedBatch }[] = []
    const buf = new DebounceBuffer((chatId, batch) => flushed.push({ chatId, batch }), {
      quietPeriodMs: 100,
    })
    buf.push(1, fragment({ text: 'a' }))
    buf.push(2, fragment({ text: 'b' }))
    expect(flushed).toHaveLength(0)
    expect(scheduled).toHaveLength(2)
    while (scheduled.length > 0) fireLatestTimer()
    expect(flushed).toHaveLength(2)
    expect(flushed.find(f => f.chatId === 1)?.batch.text).toBe('a')
    expect(flushed.find(f => f.chatId === 2)?.batch.text).toBe('b')
  })

  it('forced flush via flushAll', () => {
    const flushed: { chatId: number; batch: FlushedBatch }[] = []
    const buf = new DebounceBuffer((chatId, batch) => flushed.push({ chatId, batch }))
    buf.push(1, fragment({ text: 'pending' }))
    buf.flushAll()
    expect(flushed).toHaveLength(1)
    expect(flushed[0]!.batch.text).toBe('pending')
  })

  it('exceeding maxBufferChars triggers immediate flush', () => {
    const flushed: { chatId: number; batch: FlushedBatch }[] = []
    const buf = new DebounceBuffer((chatId, batch) => flushed.push({ chatId, batch }), {
      maxBufferChars: 10,
    })
    buf.push(1, fragment({ text: 'aaaaa', messageId: 1, ts: 1 }))
    buf.push(1, fragment({ text: 'bbbbbb', messageId: 2, ts: 2 }))
    expect(flushed).toHaveLength(1)
    expect(flushed[0]!.batch.text).toBe('aaaaa\nbbbbbb')
  })

  it('uses quietPeriodMs delay for short fragments', () => {
    const buf = new DebounceBuffer(() => {}, {
      quietPeriodMs: 600,
      adaptiveDelayMs: 2000,
      adaptiveSplitThreshold: 4000,
    })
    buf.push(1, fragment({ text: 'short' }))
    expect(scheduled[0]!.delay).toBe(600)
  })

  it('uses adaptiveDelayMs delay when last fragment exceeds threshold', () => {
    const buf = new DebounceBuffer(() => {}, {
      quietPeriodMs: 600,
      adaptiveDelayMs: 2000,
      adaptiveSplitThreshold: 100,
    })
    const longText = 'x'.repeat(150)
    buf.push(1, fragment({ text: longText }))
    expect(scheduled[0]!.delay).toBe(2000)
  })

  it('FlushedBatch carries userId, username, displayName from the last fragment', () => {
    const flushed: { chatId: number; batch: FlushedBatch }[] = []
    const buf = new DebounceBuffer((chatId, batch) => flushed.push({ chatId, batch }), {
      quietPeriodMs: 100,
    })
    buf.push(1, fragment({ text: 'a', userId: 111, username: 'alice', displayName: 'Alice' }))
    buf.push(1, fragment({ text: 'b', userId: 111, username: 'alice', displayName: 'Alice' }))
    fireLatestTimer()
    expect(flushed[0]!.batch.userId).toBe(111)
    expect(flushed[0]!.batch.username).toBe('alice')
    expect(flushed[0]!.batch.displayName).toBe('Alice')
  })
})
