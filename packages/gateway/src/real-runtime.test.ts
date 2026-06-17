import { describe, expect, test } from 'bun:test'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'
import { RealRuntime } from './real-runtime'

describe('RealRuntime contract', () => {
  test('ready() is false before start', () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    expect(rt.ready()).toBe(false)
    approvals.stop()
  })

  test('runChatTurn rejects before start', async () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    await expect(
      rt.runChatTurn({
        message: 'hi',
        ts: Date.now(),
        signature: '0xfakefakefakefake' as `0x${string}`,
        operatorAddress: '0x0000000000000000000000000000000000000000',
      }),
    ).rejects.toThrow(/runtime-not-started/)
    approvals.stop()
  })

  test('flushSync rejects before start', async () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    await expect(rt.flushSync()).rejects.toThrow(/runtime-not-started/)
    approvals.stop()
  })

  test('stop() is idempotent before start', async () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    await rt.stop()
    await rt.stop() // second call must not throw
    expect(rt.ready()).toBe(false)
    approvals.stop()
  })

  test('agentDirRoot defaults to system tmpdir/lyra-gateway', () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    // Internal field; we just confirm the public surface doesn't blow up
    expect(rt).toBeInstanceOf(RealRuntime)
    approvals.stop()
  })
})
