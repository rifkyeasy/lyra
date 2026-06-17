// Active-session tracker for telegram turns.
//
// Mirrors hermes base.py:1417-1488. The synchronous mark-active BEFORE async
// dispatch is the load-bearing detail: without it, two messages in the same
// event-loop tick can both pass the active-check and both spawn brain turns.
//
// Bypass commands: hermes-derived (/approve, /deny, /status, /stop, /new,
// /reset, /background, /restart) plus v0.20.0 additions (/yolo, /perms) so
// operators can flip permission mode from their phone without restarting.

export const BYPASS_COMMANDS = [
  '/stop',
  '/new',
  '/reset',
  '/status',
  '/approve',
  '/deny',
  '/background',
  '/restart',
  '/yolo',
  '/perms',
] as const

export type BypassCommand = (typeof BYPASS_COMMANDS)[number]

export interface ParsedBypass {
  command: BypassCommand
  args: string[]
}

/**
 * Detect a bypass command at the start of an inbound message. Returns the
 * canonical lowercase command + whitespace-split args, or null when the
 * message isn't a bypass command. v0.20.0 changed the return shape from
 * `BypassCommand | null` to `ParsedBypass | null` so handlers (especially
 * `/perms <mode>`) can read the args alongside the name.
 */
export function parseBypassCommand(text: string): ParsedBypass | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const parts = trimmed.split(/\s+/)
  const head = parts[0]?.toLowerCase()
  if (!head) return null
  if ((BYPASS_COMMANDS as readonly string[]).includes(head)) {
    return { command: head as BypassCommand, args: parts.slice(1) }
  }
  return null
}

export interface ActiveSession {
  abortCtrl: AbortController | null
  startedAt: number
}

/**
 * Per-session-key state machine. `markActive` MUST be called synchronously
 * BEFORE any async dispatch (the race-window-closing detail). `markIdle`
 * fires from the dispatch's `finally`. `setPending` queues an interrupt
 * payload; the dispatcher reads it on the next iteration.
 */
export class ActiveSessionTracker {
  readonly #sessions = new Map<string, ActiveSession>()
  readonly #pending = new Map<string, unknown>()

  isActive(key: string): boolean {
    return this.#sessions.has(key)
  }

  markActive(key: string, abortCtrl: AbortController | null = null): void {
    this.#sessions.set(key, { abortCtrl, startedAt: Date.now() })
  }

  markIdle(key: string): void {
    this.#sessions.delete(key)
  }

  getAbortController(key: string): AbortController | null {
    return this.#sessions.get(key)?.abortCtrl ?? null
  }

  /** Called by `/stop` bypass: aborts the active turn for `key` if any. */
  abortActive(key: string): boolean {
    const session = this.#sessions.get(key)
    if (!session?.abortCtrl) return false
    session.abortCtrl.abort()
    return true
  }

  setPending(key: string, event: unknown): void {
    this.#pending.set(key, event)
  }

  takePending(key: string): unknown | undefined {
    const v = this.#pending.get(key)
    this.#pending.delete(key)
    return v
  }

  activeKeys(): string[] {
    return Array.from(this.#sessions.keys())
  }
}
