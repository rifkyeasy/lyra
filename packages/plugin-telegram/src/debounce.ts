// Per-chat fragment buffer with adaptive quiet-period.
//
// Pattern from hermes telegram.py:2257: 600ms default quiet period; bump to
// 2000ms when the last fragment is >= 4000 chars (TG client splitting a long
// paste into adjacent updates). Carries sender metadata through the flush
// boundary so the dispatcher gets correct username/displayName attribution.

export interface DebounceOpts {
  /** Quiet-period in ms before flushing. Default 600. */
  quietPeriodMs?: number
  /** Adaptive delay when last fragment is >= adaptiveSplitThreshold. Default 2000. */
  adaptiveDelayMs?: number
  /** Char length that triggers adaptive delay. Default 4000. */
  adaptiveSplitThreshold?: number
  /** Max chars to buffer per chat before forced flush. Default 6000. */
  maxBufferChars?: number
}

export interface BufferedFragment {
  text: string
  messageId: number
  ts: number
  userId: number
  username: string | null
  displayName: string | null
}

export interface FlushedBatch {
  /** Joined text with newline separators. */
  text: string
  /** Latest message id in the burst (used for reactions). */
  latestMessageId: number
  /** Earliest fragment timestamp. */
  firstFragmentTs: number
  /** Count of fragments coalesced. */
  fragmentCount: number
  /** Sender userId from the latest fragment. */
  userId: number
  /** Sender username (no `@`) from the latest fragment, or null. */
  username: string | null
  /** Sender display name from the latest fragment, or null. */
  displayName: string | null
}

export class DebounceBuffer {
  private readonly quietPeriodMs: number
  private readonly adaptiveDelayMs: number
  private readonly adaptiveSplitThreshold: number
  private readonly maxBufferChars: number
  private readonly chats = new Map<
    number,
    { fragments: BufferedFragment[]; timer: ReturnType<typeof setTimeout> | null }
  >()
  private readonly onFlush: (chatId: number, batch: FlushedBatch) => void

  constructor(onFlush: (chatId: number, batch: FlushedBatch) => void, opts: DebounceOpts = {}) {
    this.quietPeriodMs = opts.quietPeriodMs ?? 600
    this.adaptiveDelayMs = opts.adaptiveDelayMs ?? 2000
    this.adaptiveSplitThreshold = opts.adaptiveSplitThreshold ?? 4000
    this.maxBufferChars = opts.maxBufferChars ?? 6000
    this.onFlush = onFlush
  }

  push(chatId: number, frag: BufferedFragment): void {
    const entry = this.chats.get(chatId) ?? { fragments: [], timer: null }
    entry.fragments.push(frag)
    if (entry.timer) clearTimeout(entry.timer)
    const totalChars = entry.fragments.reduce((n, f) => n + f.text.length, 0)
    if (totalChars >= this.maxBufferChars) {
      this.chats.set(chatId, entry)
      this.flush(chatId)
      return
    }
    const delay =
      frag.text.length >= this.adaptiveSplitThreshold ? this.adaptiveDelayMs : this.quietPeriodMs
    entry.timer = setTimeout(() => this.flush(chatId), delay)
    this.chats.set(chatId, entry)
  }

  flush(chatId: number): void {
    const entry = this.chats.get(chatId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.fragments.length === 0) {
      this.chats.delete(chatId)
      return
    }
    const last = entry.fragments[entry.fragments.length - 1]!
    const batch: FlushedBatch = {
      text: entry.fragments.map(f => f.text).join('\n'),
      latestMessageId: last.messageId,
      firstFragmentTs: entry.fragments[0]!.ts,
      fragmentCount: entry.fragments.length,
      userId: last.userId,
      username: last.username,
      displayName: last.displayName,
    }
    this.chats.delete(chatId)
    this.onFlush(chatId, batch)
  }

  flushAll(): void {
    for (const chatId of [...this.chats.keys()]) this.flush(chatId)
  }
}
