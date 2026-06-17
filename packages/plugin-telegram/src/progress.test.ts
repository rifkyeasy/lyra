import { describe, expect, it } from 'bun:test'
import type { Bot } from 'grammy'
import { PROGRESS_EDIT_INTERVAL, ProgressTracker } from './progress'

interface CallLog {
  sendMessage: { text: string; messageId: number }[]
  editMessageText: { messageId: number; text: string }[]
  /** Reject the editMessageText this many times before succeeding. Use to drive the flood-mode fallback. */
  rejectEditNTimes?: number
  /** Reject editMessageText with this exact error each time it's called. */
  editError?: string
}

function makeStubBot(log: CallLog): Bot {
  let nextMessageId = 1000
  return {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        const id = nextMessageId++
        log.sendMessage.push({ text, messageId: id })
        return { message_id: id, chat: { id: _chatId } } as unknown as Awaited<
          ReturnType<Bot['api']['sendMessage']>
        >
      },
      editMessageText: async (_chatId: number, messageId: number, text: string) => {
        if (log.rejectEditNTimes && log.rejectEditNTimes > 0) {
          log.rejectEditNTimes -= 1
          throw new Error(log.editError ?? 'Bad Request: 429 Too Many Requests')
        }
        log.editMessageText.push({ messageId, text })
        return true as const
      },
    },
  } as unknown as Bot
}

describe('ProgressTracker', () => {
  it('first push sends a new message and records messageId', async () => {
    const log: CallLog = { sendMessage: [], editMessageText: [] }
    const bot = makeStubBot(log)
    const t = new ProgressTracker(bot, 999)
    await t.push({ kind: 'start', tool: 'shell.run', callId: 'c1', argsPreview: 'date' })
    expect(log.sendMessage.length).toBe(1)
    expect(log.editMessageText.length).toBe(0)
    expect(t.hasRendered()).toBe(true)
    expect(log.sendMessage[0]?.text).toContain('shell\\.run')
    expect(log.sendMessage[0]?.text).toContain('date')
  })

  it('subsequent push within throttle does NOT immediately edit', async () => {
    const log: CallLog = { sendMessage: [], editMessageText: [] }
    const bot = makeStubBot(log)
    const t = new ProgressTracker(bot, 999)
    await t.push({ kind: 'start', tool: 'shell.run', callId: 'c1' })
    await t.push({ kind: 'start', tool: 'web.fetch', callId: 'c2' })
    expect(log.sendMessage.length).toBe(1)
    expect(log.editMessageText.length).toBe(0)
    await t.finalize()
    // finalize forces a flush of the pending edit.
    expect(log.editMessageText.length).toBe(1)
    expect(log.editMessageText[0]?.text).toContain('shell\\.run')
    expect(log.editMessageText[0]?.text).toContain('web\\.fetch')
  })

  it('end event marks the line with a check', async () => {
    const log: CallLog = { sendMessage: [], editMessageText: [] }
    const bot = makeStubBot(log)
    const t = new ProgressTracker(bot, 999)
    await t.push({ kind: 'start', tool: 'shell.run', callId: 'c1' })
    await t.push({ kind: 'end', tool: 'shell.run', callId: 'c1', ok: true })
    await t.finalize()
    expect(log.editMessageText.length).toBe(1)
    expect(log.editMessageText[0]?.text).toContain('✓')
  })

  it('end event with ok=false marks the line with an X', async () => {
    const log: CallLog = { sendMessage: [], editMessageText: [] }
    const bot = makeStubBot(log)
    const t = new ProgressTracker(bot, 999)
    await t.push({ kind: 'start', tool: 'shell.run', callId: 'c1' })
    await t.push({ kind: 'end', tool: 'shell.run', callId: 'c1', ok: false })
    await t.finalize()
    expect(log.editMessageText.length).toBe(1)
    expect(log.editMessageText[0]?.text).toContain('✗')
  })

  it('finalize is idempotent', async () => {
    const log: CallLog = { sendMessage: [], editMessageText: [] }
    const bot = makeStubBot(log)
    const t = new ProgressTracker(bot, 999)
    await t.push({ kind: 'start', tool: 'shell.run', callId: 'c1' })
    await t.finalize()
    await t.finalize()
    await t.finalize()
    expect(log.sendMessage.length).toBe(1)
    // No additional edits triggered by repeated finalize.
    expect(log.editMessageText.length).toBeLessThanOrEqual(0)
  })

  it('flood error flips canEdit off and falls back to sendMessage', async () => {
    const log: CallLog = {
      sendMessage: [],
      editMessageText: [],
      rejectEditNTimes: 99,
      editError: 'Bad Request: 429 Too Many Requests',
    }
    const bot = makeStubBot(log)
    const t = new ProgressTracker(bot, 999)
    // 1st push: sendMessage (new message)
    await t.push({ kind: 'start', tool: 'shell.run', callId: 'c1' })
    expect(log.sendMessage.length).toBe(1)
    // Wait past throttle to force an edit attempt on next push.
    await new Promise(r => setTimeout(r, PROGRESS_EDIT_INTERVAL + 50))
    // 2nd push triggers editMessageText, which rejects with 429 → canEdit=false
    await t.push({ kind: 'start', tool: 'web.fetch', callId: 'c2' })
    // Wait past throttle again so 3rd push goes through.
    await new Promise(r => setTimeout(r, PROGRESS_EDIT_INTERVAL + 50))
    // 3rd push: now canEdit=false, falls back to sendMessage of the latest line.
    await t.push({ kind: 'start', tool: 'fs.read', callId: 'c3' })
    expect(log.sendMessage.length).toBe(2)
  })

  it('end event before start event is silently ignored', async () => {
    const log: CallLog = { sendMessage: [], editMessageText: [] }
    const bot = makeStubBot(log)
    const t = new ProgressTracker(bot, 999)
    // Receiving an 'end' for a callId we never saw 'start' for.
    await t.push({ kind: 'end', tool: 'shell.run', callId: 'unknown', ok: true })
    expect(log.sendMessage.length).toBe(0)
    expect(t.hasRendered()).toBe(false)
  })
})
