/**
 * Tool-call progress tracker for live TG dispatch surfacing.
 *
 * Mirrors hermes' `send_progress_messages` (run.py:7070-7272): the agent's
 * tool calls accumulate into a single "scratch" TG message that gets edited
 * in place as the brain progresses through the turn. Final answer arrives
 * later as a separate message.
 *
 * Behavior:
 *  - First `push` sends a new message and saves messageId.
 *  - Subsequent pushes within the throttle window are coalesced — a single
 *    trailing edit fires after the throttle elapses.
 *  - On a TG flood error (HTTP 429), `canEdit` flips off and remaining
 *    pushes go as separate messages instead of edits.
 *  - All errors swallowed: progress is best-effort, never blocks dispatch.
 *  - `finalize()` is idempotent and forces any pending edit to flush.
 *
 * Tool emoji mapping is a small allowlist; everything else gets the wrench.
 * Args preview is provided by the brain via `BrainToolEvent.argsPreview`
 * (see `previewToolArgs` in og-compute.ts).
 */
import type { Bot } from 'grammy'
import { escapeMarkdownV2, isMarkdownParseError, stripMarkdownV2 } from './markdown'

const PROGRESS_EDIT_INTERVAL_MS = 1_500
/** TG hard cap is 4096; keep margin for `(N/N)` suffix and edit growth. */
const PROGRESS_TEXT_CAP = 3_800

const TOOL_EMOJI: Record<string, string> = {
  'shell.run': '💻',
  'shell.cd': '📁',
  'shell.process_start': '🚀',
  'shell.process_output': '📥',
  'shell.process_list': '📋',
  'shell.process_kill': '🛑',
  'fs.read': '📄',
  'fs.write': '✏️',
  'fs.patch': '🩹',
  'fs.search': '🔍',
  'web.fetch': '🌐',
  'browser.navigate': '🌐',
  'browser.snapshot': '📸',
  'browser.click': '🖱️',
  'browser.type': '⌨️',
  'browser.scroll': '🖱️',
  'browser.back': '⬅️',
  'browser.press': '⌨️',
  'browser.get_images': '🖼️',
  'browser.console': '🛠',
  'browser.vision': '👁',
  'memory.read': '🧠',
  'memory.save': '💾',
  todo: '📝',
  clarify: '❓',
  'skills.list': '📚',
  'skills.view': '📖',
  'skills.manage': '🛠',
  'session.search': '🔎',
  'code.execute': '🐍',
  'vision.analyze': '👁',
  'delegate.task': '🤝',
  'tool.search': '🔧',
  'chain.gas': '⛽',
  'chain.balance': '💰',
  'chain.contract': '📜',
  'chain.tx': '📝',
  'wallet.transfer': '💸',
  'swap.quote': '🔁',
  'swap.execute': '🔄',
  'stake.delegate': '🥩',
  'comms.send': '📨',
  'comms.list': '📬',
  'market.list': '🛒',
  'market.bid': '🪙',
  'account.info': 'ℹ️',
}

interface ProgressEvent {
  kind: 'start' | 'end'
  tool: string
  callId: string
  argsPreview?: string
  ok?: boolean
}

export class ProgressTracker {
  private messageId: number | null = null
  /** Map of callId → line index in `lines` so 'end' events can mark ✓/✗. */
  private callIndex = new Map<string, number>()
  private lines: string[] = []
  private lastEditTs = 0
  /** Last text we successfully sent or edited; used to skip no-op flushes. */
  private lastFlushedText = ''
  private canEdit = true
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private finalized = false
  /**
   * Serialize all flush operations so the start-event's sendMessage finishes
   * (assigning messageId) before any end-event's flush runs. Without this
   * lock, fast tools that fire start+end within ~5ms (e.g. strict-deny path)
   * would race two parallel sendMessage calls, producing a duplicate "tool
   * starting" message followed by a separate "tool ended ✗" message instead
   * of one in-place edit. v0.22.1 fix.
   */
  private flushLock: Promise<void> = Promise.resolve()

  constructor(
    private readonly bot: Bot,
    private readonly chatId: number,
  ) {}

  /**
   * Add an event to the progress timeline. Drives a sendMessage on first
   * call, editMessageText on subsequent calls (throttled at 1.5s).
   *
   * Returns the in-flight flush promise so dispatch can `await tracker.push`
   * if it wants strict ordering, but normal use is fire-and-forget.
   */
  async push(ev: ProgressEvent): Promise<void> {
    if (this.finalized) return
    if (ev.kind === 'start') {
      const line = formatStartLine(ev)
      this.callIndex.set(ev.callId, this.lines.length)
      this.lines.push(line)
    } else {
      const idx = this.callIndex.get(ev.callId)
      if (idx == null || this.lines[idx] == null) return
      this.lines[idx] = `${this.lines[idx]} ${ev.ok === false ? '✗' : '✓'}`
    }
    // Serialize: subsequent flushes wait for any in-flight sendMessage to
    // resolve so the second flush sees the assigned messageId and routes to
    // editMessageText, not a second sendMessage. v0.22.1 fix for fast-tool
    // double-message regression.
    const previous = this.flushLock
    this.flushLock = previous.then(() => this.flush()).catch(() => {})
    await this.flushLock
  }

  /**
   * Force any pending throttled edit to fire NOW, then mark the tracker
   * closed. Future pushes are no-ops.
   */
  async finalize(): Promise<void> {
    if (this.finalized) return
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    // Serialize through the lock so finalize doesn't race a still-flying
    // push from the brain. Important for fast tools where end-event flush
    // and finalize() race the same scratch message edit.
    const previous = this.flushLock
    this.flushLock = previous.then(() => this.flush(true)).catch(() => {})
    await this.flushLock
    this.finalized = true
  }

  /**
   * Whether the tracker has rendered anything yet. Used by the listener to
   * decide whether to skip the final reply ("..." sandwich UX).
   */
  hasRendered(): boolean {
    return this.messageId !== null
  }

  private async flush(force = false): Promise<void> {
    if (this.lines.length === 0) return
    const text = capProgressText(this.lines.join('\n'))
    // Skip no-op flushes: nothing changed since the last send/edit.
    if (text === this.lastFlushedText) return
    const remaining = PROGRESS_EDIT_INTERVAL_MS - (Date.now() - this.lastEditTs)
    if (!force && remaining > 0 && this.messageId !== null) {
      // Throttle: schedule one trailing edit if not already pending.
      if (!this.pendingTimer) {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null
          void this.flush()
        }, remaining)
      }
      return
    }
    this.pendingTimer = null
    const md = escapeMarkdownV2(text)
    try {
      if (this.messageId === null) {
        const sent = await this.bot.api.sendMessage(this.chatId, md, {
          parse_mode: 'MarkdownV2',
        })
        this.messageId = sent.message_id
      } else if (this.canEdit) {
        await this.bot.api.editMessageText(this.chatId, this.messageId, md, {
          parse_mode: 'MarkdownV2',
        })
      } else {
        // Flood-mode fallback: append the latest line as a new message.
        const lastLine = this.lines[this.lines.length - 1] ?? ''
        await this.bot.api.sendMessage(this.chatId, escapeMarkdownV2(lastLine), {
          parse_mode: 'MarkdownV2',
        })
      }
      this.lastEditTs = Date.now()
      this.lastFlushedText = text
    } catch (err) {
      const msg = String((err as Error).message ?? '').toLowerCase()
      if (msg.includes('flood') || msg.includes('too many requests') || msg.includes('429')) {
        this.canEdit = false
      } else if (isMarkdownParseError(err)) {
        // MarkdownV2 escape miss; retry as plain text once.
        try {
          const plain = stripMarkdownV2(text)
          if (this.messageId === null) {
            const sent = await this.bot.api.sendMessage(this.chatId, plain)
            this.messageId = sent.message_id
          } else {
            await this.bot.api.editMessageText(this.chatId, this.messageId, plain)
          }
          this.lastEditTs = Date.now()
        } catch {
          /* swallow — never block dispatch */
        }
      }
      // All other errors swallowed.
    }
  }
}

function formatStartLine(ev: ProgressEvent): string {
  const emoji = TOOL_EMOJI[ev.tool] ?? '🔧'
  if (ev.argsPreview && ev.argsPreview.length > 0) {
    return `${emoji} ${ev.tool}: ${ev.argsPreview}`
  }
  return `${emoji} ${ev.tool}`
}

function capProgressText(text: string): string {
  if (text.length <= PROGRESS_TEXT_CAP) return text
  return `${text.slice(0, PROGRESS_TEXT_CAP - 1)}…`
}

export const PROGRESS_EDIT_INTERVAL = PROGRESS_EDIT_INTERVAL_MS
