import type { EventHub } from './events'

export interface ApprovalRequestPayload {
  /** Tool kind (chain.send, chain.swap, shell.run, etc). */
  kind: string
  command?: string
  path?: string
  amount?: string
  recipient?: string
  token?: string
  /** Free-form reason for the human. */
  reason?: string
}

export type ApprovalDecision = 'allow' | 'allow-session' | 'deny' | 'expired'

export interface PendingApproval {
  id: string
  payload: ApprovalRequestPayload
  createdAt: number
  expiresAt: number
  resolve: (decision: Exclude<ApprovalDecision, 'expired'>) => void
}

export class ApprovalRelay {
  #pending = new Map<string, PendingApproval>()
  #events: EventHub
  #ttlMs: number
  #idSeq = 0
  #sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(events: EventHub, opts: { ttlMs?: number; sweepIntervalMs?: number } = {}) {
    this.#events = events
    this.#ttlMs = opts.ttlMs ?? 5 * 60 * 1000
    const sweepMs = opts.sweepIntervalMs ?? 5_000
    this.#sweepTimer = setInterval(() => this.#sweepExpired(), sweepMs)
    this.#sweepTimer.unref?.()
  }

  /** Create a pending approval, broadcast event, return a promise resolved by /approval/:id/respond. */
  request(payload: ApprovalRequestPayload): { id: string; promise: Promise<ApprovalDecision> } {
    this.#idSeq += 1
    const id = `apv-${Date.now()}-${this.#idSeq}`
    const createdAt = Date.now()
    const expiresAt = createdAt + this.#ttlMs

    const promise = new Promise<ApprovalDecision>(resolve => {
      this.#pending.set(id, { id, payload, createdAt, expiresAt, resolve })
    })
    this.#events.publish('approval-needed', { id, payload, expiresAt })
    return { id, promise }
  }

  /** Operator's signed decision arrived. Returns false if id unknown / already resolved. */
  resolve(id: string, decision: Exclude<ApprovalDecision, 'expired'>): boolean {
    const p = this.#pending.get(id)
    if (!p) return false
    this.#pending.delete(id)
    p.resolve(decision)
    this.#events.publish('approval-resolved', { id, decision })
    return true
  }

  pendingCount(): number {
    return this.#pending.size
  }

  has(id: string): boolean {
    return this.#pending.has(id)
  }

  stop(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer)
    this.#sweepTimer = null
    for (const p of this.#pending.values()) {
      p.resolve('deny')
    }
    this.#pending.clear()
  }

  #sweepExpired(): void {
    const now = Date.now()
    for (const [id, p] of this.#pending.entries()) {
      if (now >= p.expiresAt) {
        this.#pending.delete(id)
        p.resolve('deny')
        this.#events.publish('approval-expired', { id, expiredAt: now })
      }
    }
  }
}
