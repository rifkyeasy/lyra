import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LyraNetwork } from 'lyra-core'
import { applyPerms, applyYolo, newEventId } from 'lyra-core'
import { keypairFromSecret } from 'lyra-plugin-onchain'
import { type ParsedBypass, parseBypassCommand } from 'lyra-plugin-telegram'
import type { ApprovalRelay } from './approval-relay'
import { type BuiltRuntime, buildLyraRuntime } from './build-runtime'
import type { EventHub } from './events'
import type {
  ChatTurnInput,
  ChatTurnResult,
  RuntimeAdapter,
  RuntimeConfig,
  TriggerTopupTickResult,
} from './runtime'

/**
 * Mirror of dispatchTelegramBypass for the TUI /chat HTTP path. Runs BEFORE
 * brain.infer so /yolo /perms /reset operate without burning compute.
 */
async function dispatchBypass(bypass: ParsedBypass, r: BuiltRuntime): Promise<string> {
  switch (bypass.command) {
    case '/stop':
      return 'no active turn to stop here.'
    case '/new':
    case '/reset':
      try {
        await r.brain.clearChannel('tui:stdin')
        return 'conversation reset (TUI channel cleared).'
      } catch (err) {
        return `reset failed: ${(err as Error).message?.slice(0, 200) ?? 'unknown'}`
      }
    case '/status':
      return 'idle.'
    case '/approve':
    case '/deny':
      return 'inline-keyboard approval is the supported path; click the buttons in the modal.'
    case '/yolo':
      return applyYolo(r.permission).message
    case '/perms':
      return applyPerms(r.permission, bypass.args[0]).message
    case '/background':
    case '/restart':
      return `${bypass.command} is reserved for a future bundle.`
  }
}

export interface RealRuntimeOpts {
  approvals: ApprovalRelay
  /** Optional override of the agent state directory. Default `${TMPDIR}/lyra-gateway/<agentId>`. */
  agentDirRoot?: string
}

/**
 * Production runtime adapter. Builds the full lyra brain + tools + plugins
 * + listeners + memory sync stack inside the sandbox container, exposes the
 * RuntimeAdapter contract that the harness HTTP server uses.
 *
 * Lifecycle:
 *   - `start()`: builds runtime, starts listeners (background), publishes
 *     ready event, transitions Provisioned → Ready.
 *   - `runChatTurn()`: brain.infer with stdin source, drains queued listener
 *     events afterwards, fires per-turn sync flush.
 *   - `flushSync()`: explicit sync.flushAll, surfaces tx + slots.
 *   - `stop()`: stops listeners, drains pending sync, releases plugins.
 */
export class RealRuntime implements RuntimeAdapter {
  #approvals: ApprovalRelay
  #agentDirRoot: string
  #runtime: BuiltRuntime | null = null
  #ready = false
  #stopping = false
  #network: LyraNetwork | null = null
  #events: EventHub | null = null
  #pendingFlush: Promise<void> | null = null
  // v0.21.12: per-listener state for /healthz visibility.
  #listenerStates: Record<string, 'active' | 'disabled' | 'failed'> = {
    telegram: 'disabled',
  }

  constructor(opts: RealRuntimeOpts) {
    this.#approvals = opts.approvals
    this.#agentDirRoot = opts.agentDirRoot ?? join(tmpdir(), 'lyra-gateway')
  }

  async start(opts: {
    agentSecret: string
    config: RuntimeConfig
    events: EventHub
    secrets?: import('./secrets').GatewaySecrets
  }): Promise<void> {
    const agentAddress = keypairFromSecret(opts.agentSecret).toSuiAddress()
    this.#network = opts.config.network
    const agentId = await this.#agentIdFromConfig(opts.config)
    const agentDir = join(this.#agentDirRoot, agentId)
    await mkdir(agentDir, { recursive: true })

    const runtime = await buildLyraRuntime({
      config: opts.config,
      agentSecret: opts.agentSecret,
      agentAddress,
      agentDir,
      events: opts.events,
      approvals: this.#approvals,
      secrets: opts.secrets,
    })
    this.#runtime = runtime
    this.#events = opts.events
    // v0.21.12: surface listener state for /healthz. The telegram listener is
    // 'active' when secrets were provided AND build-runtime registered the
    // listener (which requires both ctx.telegram + secrets.telegram). When
    // secrets.telegram is undefined (no encrypted blob, or missing scope key),
    // it's 'disabled'. Real start failures will be migrated to 'failed' once
    // we plumb startAll outcomes; right now buildLyraRuntime swallows them.
    if (opts.secrets?.telegram && runtime.listeners.some(l => l.name === 'telegram-bot')) {
      this.#listenerStates.telegram = 'active'
    } else {
      this.#listenerStates.telegram = 'disabled'
    }
    this.#ready = true
  }

  listenerStates(): Record<string, 'active' | 'disabled' | 'failed'> {
    return { ...this.#listenerStates }
  }

  permissionMode(): 'off' | 'prompt' | 'strict' | undefined {
    return this.#runtime?.permission.getMode()
  }

  async runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    if (!this.#runtime) throw new Error('runtime-not-started')
    const r = this.#runtime
    await r.refreshUserContext()
    await r.activity.append({
      ts: Date.now(),
      kind: 'wake',
      data: { source: 'stdin', text: input.message },
    })
    const startedAt = Date.now()

    // v0.20.0: bypass commands (/yolo /perms /reset) intercept BEFORE brain.infer
    // so the TUI thin-client gets the same control surface as TG.
    const bypass = parseBypassCommand(input.message)
    if (bypass) {
      const reply = await dispatchBypass(bypass, r)
      return {
        response: reply,
        toolCalls: [],
        durationMs: Date.now() - startedAt,
      }
    }

    const turn = await r.brain.infer({
      event: {
        id: newEventId(),
        source: 'stdin',
        payload: { label: 'user-message', data: input.message },
        ts: input.ts,
      },
      channelKey: 'tui:stdin',
      onCompactionEvent: ev => {
        this.#events?.publish('context-compacted', ev)
        void r.activity
          .append({ ts: Date.now(), kind: 'context-compacted', data: ev })
          .catch(() => {})
      },
    })
    await r.activity.append({
      ts: Date.now(),
      kind: 'brain-response',
      data: {
        content: turn.content,
        toolCalls: turn.toolCalls.length,
        finishReason: turn.finishReason,
        usage: turn.usage,
      },
    })
    const durationMs = Date.now() - startedAt

    // Per-turn sync flush is BACKGROUND. Chain anchor on Sui mainnet takes
    // 30-60s; awaiting here would block the /chat HTTP response past Bun
    // fetch's idle timeout. The TUI subscribes to the `sync-flush` SSE
    // event for the txHash.
    void this.#fireBackgroundFlush()

    return {
      response: turn.content ?? '(no content)',
      toolCalls: turn.toolCalls.map(tc => ({
        name: tc.name,
        ok: true,
        durationMs: 0,
      })),
      durationMs,
    }
  }

  async #fireBackgroundFlush(): Promise<void> {
    const r = this.#runtime
    const events = this.#events
    if (!(r && events)) return
    if (this.#pendingFlush) {
      // Coalesce: a flush is already in flight, the next turn's writes
      // will ride on its (or the next) cycle.
      return
    }
    const p = (async () => {
      try {
        const flush = await r.sync.flushTurn()
        if (flush.txHash && flush.changedSlots.length > 0 && this.#network) {
          events.publish('sync-flush', {
            txHash: flush.txHash,
            slots: flush.changedSlots,
            explorer: suiExplorerTxUrl(this.#network, flush.txHash),
          })
        }
      } catch (err) {
        events.publish('log', {
          level: 'error',
          message: `sync flush failed: ${(err as Error).message}`,
        })
      } finally {
        this.#pendingFlush = null
      }
    })()
    this.#pendingFlush = p
  }

  async flushSync(): Promise<{ tx?: string; slots: string[] }> {
    if (!this.#runtime) throw new Error('runtime-not-started')
    const r = this.#runtime
    if (this.#pendingFlush) {
      await this.#pendingFlush.catch(() => {})
    }
    const result = await r.sync.flushAll()
    return {
      tx: result.txHash ?? undefined,
      slots: result.changedSlots,
    }
  }

  ready(): boolean {
    return this.#ready
  }

  async stop(): Promise<void> {
    if (this.#stopping) return
    this.#stopping = true
    this.#ready = false
    if (this.#pendingFlush) {
      await this.#pendingFlush.catch(() => {})
    }
    if (this.#runtime) {
      await this.#runtime.dispose()
      this.#runtime = null
    }
  }

  /**
   * v0.21.5: manually trigger one AutoTopupManager poll. Used by the admin
   * endpoint POST /admin/autotopup/tick to live-fire topup events without
   * waiting for the 5-minute poll interval. Outcome flows through the
   * existing event/activity-log surfaces, NOT this return value.
   */
  async triggerTopupTick(): Promise<TriggerTopupTickResult> {
    if (!this.#runtime) return { ok: false, reason: 'runtime-not-started' }
    // Auto-topup was removed with the decentralized-compute backend.
    return { ok: false, reason: 'autotopup-disabled' }
  }

  /**
   * v0.23.0: snapshot of every IntelligentData slot's high-level state for
   * /healthz. Populated by the boot-time restore + lazy retries + successful
   * flushes. Empty before the runtime is started.
   */
  slotStatus(): Record<string, { status: string; reason?: string; bytes?: number }> {
    if (!this.#runtime) return {}
    const out: Record<string, { status: string; reason?: string; bytes?: number }> = {}
    for (const [slot, status] of this.#runtime.slotStatus.entries()) {
      out[slot] = status
    }
    return out
  }

  /**
   * v0.23.0: live-flip the operator-scoped PROFILE key. Called by the
   * /admin/profile-key endpoint after operator-sig verification succeeds.
   * Forwards to the BuiltRuntime closure that updates MemorySyncManager +
   * fires a one-shot restore for the profile slot.
   */
  async setProfileKey(
    keyHex: `0x${string}`,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.#runtime) return { ok: false, reason: 'runtime-not-started' }
    return this.#runtime.setProfileKey(keyHex)
  }

  /**
   * v0.24.4: approve a pending pairing code in the container's pairing dir.
   * Called by the `/admin/pairing/approve` endpoint after operator-sig
   * verification succeeds. Forwards to `BuiltRuntime.approvePairing` which
   * wraps `PairingStore.approveCode` with the locked-out vs unknown-code
   * branching the HTTP layer needs.
   */
  approvePairing(
    platform: string,
    code: string,
  ): { ok: true; userId: string; userName: string } | { ok: false; reason: string } {
    if (!this.#runtime) return { ok: false, reason: 'runtime-not-started' }
    return this.#runtime.approvePairing(platform, code)
  }

  async #agentIdFromConfig(config: RuntimeConfig): Promise<string> {
    const { placeholderAgentId } = await import('lyra-core')
    return placeholderAgentId(config.identity.agent ?? '')
  }
}

/** Suiscan transaction-digest URL for the given network. */
function suiExplorerTxUrl(network: LyraNetwork, digest: string): string {
  return `https://suiscan.xyz/${network}/tx/${digest}`
}
