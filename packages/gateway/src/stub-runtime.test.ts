import { describe, expect, test } from 'bun:test'
import { EventHub } from './events'
import type { RuntimeConfig } from './runtime'
import { StubRuntime } from './stub-runtime'

const CONFIG: RuntimeConfig = {
  network: 'mainnet',
  brain: { provider: 'openai', model: 'gpt-4o-mini' },
  identity: {
    agent: `0x${'11'.repeat(32)}`,
  },
}
const FAKE_SECRET = Buffer.alloc(32, 0xab).toString('base64')

describe('StubRuntime', () => {
  test('start → ready, runChatTurn echoes + emits indicators', async () => {
    const events = new EventHub()
    const runtime = new StubRuntime()
    expect(runtime.ready()).toBe(false)
    await runtime.start({
      agentSecret: FAKE_SECRET,
      config: CONFIG,
      events,
    })
    expect(runtime.ready()).toBe(true)

    const result = await runtime.runChatTurn({
      message: 'hello world',
      ts: Date.now(),
      signature: '0x' as `0x${string}`,
      operatorAddress: '0xCCCCCCCCcccccccccccCCCCCcCCcccccccccccCCC',
    })
    expect(result.response).toContain('hello world')
    expect(result.toolCalls.length).toBeGreaterThan(0)

    const kinds = events.buffer().map(e => e.kind)
    expect(kinds).toContain('turn-start')
    expect(kinds).toContain('tool-call-start')
    expect(kinds).toContain('tool-call-end')
    expect(kinds).toContain('turn-end')
  })

  test('runChatTurn before start throws', async () => {
    const runtime = new StubRuntime()
    await expect(
      runtime.runChatTurn({
        message: 'x',
        ts: Date.now(),
        signature: '0x' as `0x${string}`,
        operatorAddress: '0xCCCCCCCCcccccccccccCCCCCcCCcccccccccccCCC',
      }),
    ).rejects.toThrow(/not ready/)
  })

  test('flushSync emits sync-flush event', async () => {
    const events = new EventHub()
    const runtime = new StubRuntime()
    await runtime.start({
      agentSecret: FAKE_SECRET,
      config: CONFIG,
      events,
    })
    const result = await runtime.flushSync()
    expect(result.slots).toEqual([])
    expect(events.buffer().some(e => e.kind === 'sync-flush')).toBe(true)
  })

  test('stop transitions ready → false + emits state-change', async () => {
    const events = new EventHub()
    const runtime = new StubRuntime()
    await runtime.start({
      agentSecret: FAKE_SECRET,
      config: CONFIG,
      events,
    })
    await runtime.stop()
    expect(runtime.ready()).toBe(false)
  })
})
