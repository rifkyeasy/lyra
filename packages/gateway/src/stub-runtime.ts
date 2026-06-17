import type { EventHub } from './events'
import type { ChatTurnInput, ChatTurnResult, RuntimeAdapter, RuntimeConfig } from './runtime'

/**
 * Echoes incoming messages, emits a synthetic tool-call indicator for each
 * turn so the SSE bridge can be HTTP-tested without burning real compute.
 *
 * Replace with a real adapter (brain + Sui plugins) before driving live
 * agents.
 */
export class StubRuntime implements RuntimeAdapter {
  #ready = false
  #config: RuntimeConfig | null = null
  #events: EventHub | null = null

  async start(opts: { agentSecret: string; config: RuntimeConfig; events: EventHub }): Promise<void> {
    this.#config = opts.config
    this.#events = opts.events
    this.#events.publish('state-change', { state: 'starting' })
    // Simulate listener startup latency so callers can see the event flow.
    await new Promise(resolve => setTimeout(resolve, 5))
    this.#ready = true
    this.#events.publish('state-change', { state: 'ready' })
  }

  ready(): boolean {
    return this.#ready
  }

  async runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    if (!this.#events || !this.#ready) throw new Error('runtime not ready')
    const start = Date.now()
    this.#events.publish('turn-start', { ts: input.ts, len: input.message.length })

    const toolName = 'echo.stub'
    this.#events.publish('tool-call-start', { name: toolName, args: { len: input.message.length } })
    await new Promise(resolve => setTimeout(resolve, 1))
    this.#events.publish('tool-call-end', { name: toolName, ok: true, durationMs: 1 })

    const response = `[stub-runtime echo on ${this.#config?.network ?? '?'}] ${input.message}`
    const durationMs = Date.now() - start
    this.#events.publish('turn-end', { durationMs })
    return {
      response,
      toolCalls: [{ name: toolName, ok: true, durationMs: 1 }],
      durationMs,
    }
  }

  async flushSync(): Promise<{ tx?: string; slots: string[] }> {
    if (!this.#events) throw new Error('runtime not started')
    this.#events.publish('sync-flush', { slots: [], stub: true })
    return { slots: [] }
  }

  async stop(): Promise<void> {
    this.#ready = false
    this.#events?.publish('state-change', { state: 'stopped' })
  }
}
