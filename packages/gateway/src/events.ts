/**
 * Harness event hub: in-memory broadcast bus that the HTTP /events SSE endpoint
 * subscribes to. Runtime adapters publish; HTTP server forwards to clients.
 */

export type GatewayEventKind =
  | 'tool-call-start'
  | 'tool-call-end'
  | 'turn-start'
  | 'turn-end'
  | 'sync-flush'
  | 'approval-needed'
  | 'approval-resolved'
  | 'approval-expired'
  | 'listener-event'
  | 'log'
  | 'state-change'
  /**
   * v0.20.2: brain ran auto-compaction pre-flight on a channel and folded
   * older history into a summary message. TUI surfaces as ✂︎ system row.
   */
  | 'context-compacted'
  /**
   * v0.21.0: AutoTopupManager fired or tried to fire a topup, OR the agent
   * wallet crossed the notify threshold downward. Data shape is
   * `AutoTopupEvent` (kind: topup-fired | topup-failed | wallet-low).
   */
  | 'auto-topup'

export interface GatewayEvent {
  /** Monotonic per-hub id used for SSE last-event-id reconnects. */
  seq: number
  kind: GatewayEventKind
  ts: number
  data: unknown
}

export type Subscriber = (event: GatewayEvent) => void

/**
 * v0.24.14: subscriber kind so EventHub can distinguish a live operator TUI
 * (chat.tsx attached to the daemon) from passive dashboards (/console web UI,
 * lyra-launch viewer, monitoring scrapers). The TG forward gate in
 * build-runtime.ts only needs to know "is the operator actually watching",
 * not "is anyone polling events." `tui` clients block TG forwarding;
 * `dashboard` and `other` do not.
 */
export type SubscriberKind = 'tui' | 'dashboard' | 'other'

interface SubEntry {
  fn: Subscriber
  kind: SubscriberKind
}

export class EventHub {
  #seq = 0
  #subs = new Set<SubEntry>()
  #buffer: GatewayEvent[] = []
  #bufferLimit: number

  constructor(opts: { bufferLimit?: number } = {}) {
    this.#bufferLimit = opts.bufferLimit ?? 256
  }

  publish(kind: GatewayEventKind, data: unknown): GatewayEvent {
    this.#seq += 1
    const event: GatewayEvent = { seq: this.#seq, kind, ts: Date.now(), data }
    this.#buffer.push(event)
    if (this.#buffer.length > this.#bufferLimit) this.#buffer.shift()
    for (const entry of this.#subs) {
      try {
        entry.fn(event)
      } catch {
        // never let one slow subscriber block the bus
      }
    }
    return event
  }

  /**
   * Subscribe; returns unsubscribe fn. Optionally replay since last-event-id.
   * `kind` (v0.24.14) defaults to `other` so existing callers behave as
   * before. The TG forward gate only checks for `tui` subscribers; passing
   * `dashboard` for /console-style web clients lets the gate fire even when
   * a dashboard tab is open.
   */
  subscribe(sub: Subscriber, sinceSeq?: number, kind: SubscriberKind = 'other'): () => void {
    if (typeof sinceSeq === 'number') {
      for (const e of this.#buffer) {
        if (e.seq > sinceSeq) sub(e)
      }
    }
    const entry: SubEntry = { fn: sub, kind }
    this.#subs.add(entry)
    return () => {
      this.#subs.delete(entry)
    }
  }

  size(): number {
    return this.#subs.size
  }

  /** v0.24.14: count subscribers of a specific kind. */
  sizeOfKind(kind: SubscriberKind): number {
    let n = 0
    for (const entry of this.#subs) {
      if (entry.kind === kind) n += 1
    }
    return n
  }

  lastSeq(): number {
    return this.#seq
  }

  /** Drain buffered events; used in tests + graceful shutdown drains. */
  buffer(): GatewayEvent[] {
    return [...this.#buffer]
  }
}
