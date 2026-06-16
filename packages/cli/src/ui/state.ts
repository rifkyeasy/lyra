import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  SlashCommand,
} from 'nebula-ai-core'
import { createSignal } from 'solid-js'

export type TurnRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'tool-call'
  | 'tool-result'
  | 'inbox'
  | 'market'
  | 'inbox-tg'
  | 'telegram-assistant'

export interface TurnRow {
  id: string
  role: TurnRole
  text: string
  // tool-call rows: tool name + formatted args (rendered as `name(args)`)
  toolName?: string
  args?: string
  // tool-result rows: failure flag drives icon + color
  failed?: boolean
  // v0.21.2: drives the ↪ prefix so operators see the SAME logical fetch was
  // escalated, not a fresh brain decision.
  autoEscalated?: boolean
  // True only for the first row in an "nebula block" (assistant + tool-call rows
  // that share the same speaker turn). Computed once at push time so the For
  // loop renderer doesn't re-walk neighbors on every state mutation.
  firstOfBlock?: boolean
}

export interface PendingApproval {
  request: PermissionRequest
  resolve: (decision: PermissionDecision) => void
}

interface CreateChatStateOpts {
  initialSystem: string
  identityLabel: string
  approvalsMode: PermissionMode
  // v0.24.4: true when the TUI talks to a local gateway daemon over a unix
  // socket (`~/.nebula/agents/<id>/gateway.sock`) instead of a remote Daytona
  // sandbox endpoint. Drives statusbar copy (drops the "sandbox X" prefix on
  // the system line) and hides the sandbox-billing balance segment (which is
  // meaningless for local deploys — there is no billing reserve to surface).
  // Defaults to false so existing call sites that don't pass it (i.e. nothing
  // today, since both call sites set it explicitly) keep sandbox semantics.
  isLocalGateway?: boolean
}

export function createChatState(opts: CreateChatStateOpts) {
  const [rows, setRows] = createSignal<TurnRow[]>([
    { id: 'sys-0', role: 'system', text: opts.initialSystem },
  ])
  const [input, setInput] = createSignal('')
  const [status, setStatus] = createSignal<'idle' | 'thinking' | 'error'>('idle')
  const [usage, setUsage] = createSignal<{ total?: number; cached?: number } | null>(null)
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null)
  const [approvalsMode, setApprovalsMode] = createSignal<PermissionMode>(opts.approvalsMode)

  // Mantle Compute ledger balance, in Mantle. Refreshed at chat init and after each
  // per-turn auto-sync. null = not yet fetched / fetch failed.
  const [balance, setBalance] = createSignal<number | null>(null)
  // Agent EOA balance, in Mantle. Pays gas for chain writes (agent.message
  // inbox.send, sync's updateSlots anchor). Typically starves before the
  // compute ledger in long sessions (~0.001 Mantle/send at 4 gwei).
  const [eoaBalance, setEoaBalance] = createSignal<number | null>(null)
  // v0.22.0: Mantle Sandbox billing reserve, in Mantle. Sandbox-deployed agents only —
  // local-mode TUI stays null and the statusline `<Show>` hides the segment.
  // Auto-topup refills this when it dips below the configured threshold; the
  // statusline mirror lets operators see the same balance without leaving TUI.
  const [sandboxBalance, setSandboxBalance] = createSignal<number | null>(null)
  // ms epoch when current turn started (status flipped to 'thinking'). The
  // spinner row reads this and renders elapsed seconds. Cleared on idle.
  const [turnStartedAt, setTurnStartedAt] = createSignal<number | null>(null)

  // In-flight escrow job count surfaced in the statusbar. The marketplace
  // wiring that populated this lived in the (removed) comms plugin; the signal
  // is retained so the statusbar segment and the sandbox 'market' rows keep
  // their type contract.
  const [activeJobCount, setActiveJobCount] = createSignal(0)
  void setActiveJobCount

  // Per-turn AbortController. Set when handleSubmit kicks off brain.infer;
  // cleared (set to null) after the turn ends or is aborted. The keyboard
  // handler reads it to wire Esc → abort.
  const [activeAbort, setActiveAbort] = createSignal<AbortController | null>(null)

  // v0.20.0: slash-command autocomplete popup state. `slashMatches` is the
  // filtered list of commands matching the current input prefix; populated
  // when input starts with `/`, cleared otherwise. `slashIndex` tracks the
  // selected row inside `slashMatches`. Both reset to defaults on submit.
  const [slashMatches, setSlashMatches] = createSignal<SlashCommand[]>([])
  const [slashIndex, setSlashIndex] = createSignal(0)

  // Status-change subscribers. Phase 12 telegram-dispatch hooks here so it
  // can drain its queue when the brain returns to idle from a stdin turn.
  type StatusListener = (next: 'idle' | 'thinking' | 'error') => void
  const statusListeners = new Set<StatusListener>()
  const onStatusChange = (cb: StatusListener): (() => void) => {
    statusListeners.add(cb)
    return () => statusListeners.delete(cb)
  }

  // Wrap status setter so the turn-start timestamp tracks status changes
  // automatically. Every code path that flips to 'thinking' starts the
  // clock; every flip to idle/error stops it. Removes the burden from
  // call sites.
  const setStatusTracked: typeof setStatus = next => {
    const prev = status()
    const result = setStatus(next)
    const after = status()
    if (prev !== 'thinking' && after === 'thinking') setTurnStartedAt(Date.now())
    else if (prev === 'thinking' && after !== 'thinking') setTurnStartedAt(null)
    if (prev !== after) {
      for (const cb of statusListeners) {
        try {
          cb(after)
        } catch {
          // listener errors must not break status updates
        }
      }
    }
    return result
  }

  let idCounter = 1
  const nextId = () => `row-${idCounter++}`

  const pushRow = (row: Omit<TurnRow, 'id' | 'firstOfBlock'>) => {
    setRows(prev => {
      const last = prev[prev.length - 1] ?? null
      const isAssistantBlock = row.role === 'assistant' || row.role === 'tool-call'
      const continuesBlock =
        last?.role === 'assistant' || last?.role === 'tool-call' || last?.role === 'tool-result'
      const firstOfBlock = isAssistantBlock && !continuesBlock
      return [...prev, { ...row, id: nextId(), firstOfBlock }]
    })
  }

  return {
    rows,
    input,
    status,
    usage,
    pendingApproval,
    approvalsMode,
    balance,
    eoaBalance,
    sandboxBalance,
    turnStartedAt,
    activeAbort,
    activeJobCount,
    slashMatches,
    slashIndex,
    setInput,
    setStatus: setStatusTracked,
    setUsage,
    setPendingApproval,
    setApprovalsMode,
    setBalance,
    setEoaBalance,
    setSandboxBalance,
    setTurnStartedAt,
    setActiveAbort,
    setSlashMatches,
    setSlashIndex,
    pushRow,
    onStatusChange,
    identityLabel: opts.identityLabel,
    isLocalGateway: opts.isLocalGateway ?? false,
  }
}

export type ChatState = ReturnType<typeof createChatState>
