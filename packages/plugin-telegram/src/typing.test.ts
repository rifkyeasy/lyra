import { describe, expect, it } from 'bun:test'
import type { Bot } from 'grammy'
import { TYPING_REFRESH_INTERVAL_MS, startTypingLoop } from './typing'

function makeStubBot(callLog: { count: number; rejectOnce?: boolean }): Bot {
  return {
    api: {
      sendChatAction: async (_chatId: number, action: string): Promise<true> => {
        if (action !== 'typing') throw new Error(`unexpected action: ${action}`)
        callLog.count += 1
        if (callLog.rejectOnce) {
          callLog.rejectOnce = false
          throw new Error('429 too many requests')
        }
        return true as const
      },
    },
  } as unknown as Bot
}

describe('startTypingLoop', () => {
  it('fires sendChatAction immediately on start', () => {
    const log = { count: 0 }
    const bot = makeStubBot(log)
    const stop = startTypingLoop(bot, 1234)
    stop()
    expect(log.count).toBe(1)
  })

  it('refreshes on the configured interval', async () => {
    const log = { count: 0 }
    const bot = makeStubBot(log)
    const stop = startTypingLoop(bot, 1234)
    // Wait 4.6s real time to see the immediate fire + first refresh.
    await new Promise(r => setTimeout(r, TYPING_REFRESH_INTERVAL_MS + 100))
    stop()
    expect(log.count).toBeGreaterThanOrEqual(2)
  })

  it('cancel fn stops further refreshes', async () => {
    const log = { count: 0 }
    const bot = makeStubBot(log)
    const stop = startTypingLoop(bot, 1234)
    stop()
    await new Promise(r => setTimeout(r, TYPING_REFRESH_INTERVAL_MS + 100))
    expect(log.count).toBe(1)
  })

  it('survives sendChatAction failures', async () => {
    const log = { count: 0, rejectOnce: true }
    const bot = makeStubBot(log)
    const stop = startTypingLoop(bot, 1234)
    // First fire rejects (caught silently); subsequent refresh still happens.
    await new Promise(r => setTimeout(r, TYPING_REFRESH_INTERVAL_MS + 100))
    stop()
    // Total fires: 1 (rejected) + 1 (refresh) = 2
    expect(log.count).toBe(2)
  })

  it('cancel fn is idempotent', () => {
    const log = { count: 0 }
    const bot = makeStubBot(log)
    const stop = startTypingLoop(bot, 1234)
    stop()
    stop() // second call should not throw
    stop() // third call should not throw
    expect(log.count).toBe(1)
  })
})
