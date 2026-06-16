/**
 * Local-mode telegram dispatch wiring for chat.tsx.
 *
 * Two pieces:
 *
 *  1. `buildTelegramRuntimeContext`: composes the side-band context the plugin
 *     consumes via `(ctx as any).telegram`. The context's `dispatchUserMessage`
 *     points at a *deferred* callback ref; chat.tsx populates the ref AFTER
 *     brain init but BEFORE any inbound TG message can race.
 *
 *  2. `buildTelegramDispatch`: factory for the deferred callback itself.
 *     Returns a handle with `{ dispatch, drainQueue, getQueueSize }`. chat.tsx
 *     wires the dispatch into the slot AND subscribes to status idle so it
 *     can call drainQueue to wake any messages that arrived during a stdin
 *     turn (closes G4 starvation).
 *
 * Bypass commands (parseBypassCommand) skip the queue + busy gate. `/stop`
 * aborts the active brain turn; `/status` reports thinking/idle; the rest
 * are placeholders for future B5 inline-keyboard approvals.
 */
import type {
  ActivityLog,
  Brain,
  FrozenPrefix,
  PermissionDecision,
  PermissionPrompter,
  PermissionRequest,
  PermissionService,
} from 'nebula-ai-core'
import { applyPerms, applyYolo, newEventId } from 'nebula-ai-core'
import {
  ActiveSessionTracker,
  type ApprovalChoice,
  type BypassCommand,
  type TelegramApprovalBridge,
  type TelegramDispatchInput,
  type TelegramDispatchResult,
  type TelegramRuntimeContext,
  makeApprovalIdFactory,
  parseBypassCommand,
} from 'nebula-ai-plugin-telegram'
import { summarizeApprovalSubject } from '../ui/approval-summary'

export type DispatchUserMessage = (input: TelegramDispatchInput) => Promise<TelegramDispatchResult>

/**
 * Mutable callback ref. chat.tsx holds it across boot; we hand the ref into
 * the plugin's runtime context via a closure that defers to the ref's current
 * value at call-time.
 */
export interface TelegramDispatchSlot {
  current: DispatchUserMessage | null
}

export interface RowSinkRef {
  current: ((text: string) => void) | null
}

export function buildTelegramRuntimeContext(opts: {
  botToken: string
  allowedUserIds: number[]
  agentName: string
  slot: TelegramDispatchSlot
  systemRowSink: RowSinkRef
}): TelegramRuntimeContext {
  return {
    botToken: opts.botToken,
    allowedUserIds: opts.allowedUserIds,
    agentName: opts.agentName,
    dispatchUserMessage: async input => {
      const cb = opts.slot.current
      if (!cb) {
        return {
          response: 'agent is still booting; try again in a moment.',
        }
      }
      return cb(input)
    },
    onProcessingStart: async (chatId, _msgId) => {
      opts.systemRowSink.current?.(`tg replying to chat ${chatId}`)
    },
    onProcessingEnd: async (chatId, _msgId, ok) => {
      opts.systemRowSink.current?.(
        ok ? `tg reply sent to chat ${chatId}` : `tg reply FAILED to chat ${chatId}`,
      )
    },
  }
}

export interface BuildDispatchDeps {
  activity: ActivityLog
  /** Local-only memory persists via the memory.* tools; flushTurn is a no-op. */
  sync: { flushTurn: () => Promise<{ txHash: string | null; changedSlots: string[] }> }
  permission: PermissionService
  pushAssistantRow: (text: string) => void
  pushInboundRow: (preview: string) => void
  /** Returns true if the brain is currently busy on another turn. */
  isBusy: () => boolean
  buildPrefix: () => Promise<FrozenPrefix>
  brain: Brain & { refreshUserContext: (prefix: FrozenPrefix) => void }
  /** Mark the brain as "thinking" / idle in the TUI state. */
  setThinking: (on: boolean) => void
  setActiveAbort: (ctrl: AbortController | null) => void
  refreshBalances: () => void
  formatInboundPreview: (input: TelegramDispatchInput) => string
  /**
   * Optional approval bridge from the listener. When present, dispatch swaps
   * permission.setPrompter to a TG-aware prompter for the turn duration so
   * the operator can approve tool calls from their phone via inline keyboard.
   */
  approvalBridge?: TelegramApprovalBridge
}

export interface TelegramDispatchHandle {
  dispatch: DispatchUserMessage
  /** Re-run the queue. Called by chat.tsx when stdin turn ends (closes G4). */
  drainQueue: () => void
  getQueueSize: () => number
}

/**
 * Build the deferred dispatch callback. Caller assigns `handle.dispatch` into
 * `slot.current` once brain.init resolves, and wires `handle.drainQueue` into
 * a status-change effect.
 */
export function buildTelegramDispatch(deps: BuildDispatchDeps): TelegramDispatchHandle {
  const queue: { input: TelegramDispatchInput; resolve: (r: TelegramDispatchResult) => void }[] = []
  let draining = false
  const tracker = new ActiveSessionTracker()
  const pendingApprovals = new Map<string, (choice: ApprovalChoice) => void>()
  const approvalIdFactory = makeApprovalIdFactory()
  let callbackInstalled = false
  const ensureCallbackInstalled = (): void => {
    if (callbackInstalled) return
    const install = deps.approvalBridge?.installCallbackHandler.current
    if (!install) return
    install((approvalId, choice, _fromUserId) => {
      const r = pendingApprovals.get(approvalId)
      if (r) {
        pendingApprovals.delete(approvalId)
        r(choice)
      }
    })
    callbackInstalled = true
  }

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        if (deps.isBusy()) return
        const item = queue.shift()!
        ensureCallbackInstalled()
        try {
          const r = await runOne(item.input, deps, tracker, {
            pendingApprovals,
            approvalIdFactory,
          })
          item.resolve(r)
        } catch (err) {
          item.resolve({
            response: `error processing your message: ${(err as Error).message.slice(0, 200)}`,
          })
        }
      }
    } finally {
      draining = false
    }
  }

  return {
    dispatch: (input: TelegramDispatchInput) =>
      new Promise<TelegramDispatchResult>(resolve => {
        deps.pushInboundRow(deps.formatInboundPreview(input))

        // Bypass commands skip the queue + busy gate entirely.
        const bypass = parseBypassCommand(input.text)
        if (bypass) {
          void Promise.resolve(handleBypass(bypass, input, deps, tracker)).then(resolve)
          return
        }

        queue.push({ input, resolve })
        void drain()
      }),
    drainQueue: () => {
      void drain()
    },
    getQueueSize: () => queue.length,
  }
}

async function handleBypass(
  bypass: { command: BypassCommand; args: string[] },
  input: TelegramDispatchInput,
  deps: BuildDispatchDeps,
  tracker: ActiveSessionTracker,
): Promise<TelegramDispatchResult> {
  const { command: cmd, args } = bypass
  switch (cmd) {
    case '/stop': {
      const aborted = tracker.abortActive(input.sessionKey)
      if (!aborted && deps.isBusy()) {
        return { response: 'no active turn to stop here, but the agent is busy on stdin.' }
      }
      return {
        response: aborted ? 'stopped the current turn.' : 'no active turn to stop.',
      }
    }
    case '/new':
    case '/reset': {
      // v0.20.0: real reset clears this channel's history. Falls back to a
      // friendly note when the brain doesn't expose channel ops (StubBrain).
      if (typeof deps.brain.clearChannel === 'function') {
        await deps.brain.clearChannel(input.sessionKey)
        return { response: "conversation reset (this chat's history cleared)." }
      }
      return { response: 'this brain does not support reset.' }
    }
    case '/status': {
      const busy = deps.isBusy()
      const qs = '' // queue size could be read via closure; keep terse here
      return {
        response: busy ? `currently thinking on another turn${qs}.` : `idle${qs}.`,
      }
    }
    case '/approve':
    case '/deny': {
      return {
        response: 'inline-keyboard approval is not yet wired in this build (B5 ships in v0.18.1).',
      }
    }
    case '/yolo': {
      const r = applyYolo(deps.permission)
      return { response: r.message }
    }
    case '/perms': {
      const r = applyPerms(deps.permission, args[0])
      return { response: r.message }
    }
    case '/background':
    case '/restart': {
      return { response: `${cmd} is reserved for a future bundle.` }
    }
  }
}

interface RunOneOpts {
  pendingApprovals: Map<string, (c: ApprovalChoice) => void>
  approvalIdFactory: () => string
}

async function runOne(
  input: TelegramDispatchInput,
  deps: BuildDispatchDeps,
  tracker: ActiveSessionTracker,
  opts: RunOneOpts,
): Promise<TelegramDispatchResult> {
  // If the listener filled the approval bridge, swap the permission prompter
  // to the TG-aware one for the turn duration. The brain will issue an
  // inline-keyboard approval message; the operator clicks from their phone;
  // the callback resolves the prompter's Promise. Permission resolves go
  // through the normal PermissionService.resolve path: 'off' bypass, 'strict'
  // deny, 'prompt' consults the prompter. We use 'prompt' for TG turns so
  // the bridge is exercised; chat-telegram previously forced 'off' to bypass
  // the TUI modal entirely.
  const previousPrompter = (deps.permission as unknown as { prompter: PermissionPrompter }).prompter
  const bridgeReady =
    !!deps.approvalBridge?.sendApproval.current &&
    !!deps.approvalBridge?.installCallbackHandler.current
  const previousMode = deps.permission.getMode()
  if (bridgeReady) {
    const tgPrompter = buildTelegramPrompter({
      chatId: input.chatId,
      bridge: deps.approvalBridge!,
      pendingApprovals: opts.pendingApprovals,
      approvalIdFactory: opts.approvalIdFactory,
    })
    deps.permission.setPrompter(tgPrompter)
    // Use 'prompt' so dangerous patterns + value-moving txs route through the
    // TG prompter. Tools without prompts (e.g. fs.read) still pass.
    deps.permission.setMode('prompt')
  } else {
    // No bridge: fall back to YOLO so brain doesn't deadlock on a TUI modal
    // the phone-side operator can't reach.
    deps.permission.setMode('off')
  }
  deps.setThinking(true)
  const abortCtrl = new AbortController()
  deps.setActiveAbort(abortCtrl)
  // Synchronous mark-active BEFORE any await closes the race window per
  // hermes base.py:1471. Two messages in the same tick now see the lock.
  tracker.markActive(input.sessionKey, abortCtrl)
  try {
    const refreshed = await deps.buildPrefix()
    deps.brain.refreshUserContext(refreshed)
    await deps.activity.append({
      ts: Date.now(),
      kind: 'wake',
      data: { source: 'telegram', chatId: input.chatId, userId: input.userId },
    })
    const turn = await deps.brain.infer({
      event: {
        id: newEventId(),
        source: 'telegram',
        payload: { label: 'telegram-message', data: input.text },
        ts: Date.now(),
      },
      channelKey: input.sessionKey,
      signal: abortCtrl.signal,
      // Forward per-turn tool-call observer to the brain. The listener
      // attaches a ProgressTracker on every dispatch; dropping it here
      // would silently disable TG's live progress message.
      onToolEvent: input.onToolEvent
        ? ev => {
            input.onToolEvent?.({
              kind: ev.kind,
              tool: ev.tool,
              callId: ev.callId,
              argsPreview: ev.argsPreview,
              ok: ev.ok,
            })
          }
        : undefined,
    })
    await deps.activity.append({
      ts: Date.now(),
      kind: 'brain-response',
      data: {
        content: turn.content,
        toolCalls: turn.toolCalls.length,
        finishReason: turn.finishReason,
        usage: turn.usage,
        source: 'telegram',
      },
    })
    const response = (turn.content ?? '').trim()
    if (response.length > 0) deps.pushAssistantRow(response)
    deps.refreshBalances()
    let syncTx: string | undefined
    try {
      const res = await deps.sync.flushTurn()
      if (res.txHash) syncTx = res.txHash
    } catch {
      // sync errors stay in the activity log; not surfaced to TG.
    }
    return { response: response.length === 0 ? '(no reply)' : response, syncTx }
  } finally {
    deps.setThinking(false)
    deps.setActiveAbort(null)
    tracker.markIdle(input.sessionKey)
    deps.permission.setMode(previousMode)
    if (bridgeReady && previousPrompter) {
      deps.permission.setPrompter(previousPrompter)
    }
  }
}

const APPROVAL_TIMEOUT_MS = 5 * 60_000

function buildTelegramPrompter(opts: {
  chatId: number
  bridge: TelegramApprovalBridge
  pendingApprovals: Map<string, (c: ApprovalChoice) => void>
  approvalIdFactory: () => string
}): PermissionPrompter {
  return async (req: PermissionRequest) => {
    const send = opts.bridge.sendApproval.current
    if (!send) return 'deny'
    const approvalId = opts.approvalIdFactory()
    const body = formatApprovalBody(req)
    return new Promise<PermissionDecision>(resolve => {
      const timer = setTimeout(() => {
        if (opts.pendingApprovals.delete(approvalId)) resolve('deny')
      }, APPROVAL_TIMEOUT_MS)
      opts.pendingApprovals.set(approvalId, choice => {
        clearTimeout(timer)
        resolve(mapChoiceToDecision(choice))
      })
      void send(opts.chatId, body, approvalId).catch(() => {
        clearTimeout(timer)
        if (opts.pendingApprovals.delete(approvalId)) resolve('deny')
      })
    })
  }
}

function mapChoiceToDecision(choice: ApprovalChoice): PermissionDecision {
  if (choice === 'once') return 'allow-once'
  if (choice === 'session' || choice === 'always') return 'allow-session'
  return 'deny'
}

function formatApprovalBody(req: PermissionRequest): string {
  const subject = summarizeApprovalSubject(req)
  return `🔐 Approval needed for ${req.kind}\n\n${subject}\n\nReason: ${req.reason}`
}
