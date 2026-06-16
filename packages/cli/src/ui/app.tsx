import { useKeyboard, usePaste, useTerminalDimensions } from '@opentui/solid'
import { type SlashCommand, suggestForPrefix } from 'nebula-ai-core'
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { summarizeApprovalSubject } from './approval-summary'
import { MarkdownSegments } from './markdown'
import type { ChatState, TurnRow } from './state'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const SPINNER_FRAME_MS = 80
const SCROLL_STEP = 8

// opentui's <span> accepts `fg` at runtime but the SpanProps type omits it,
// and every workaround we tried fails:
//   - dynamic <Tag> wrapper (`const Tag = 'span' as any`): solid's JSX
//     transform resolves Tag and crashes with `Comp is not a function`.
//   - module-level function-typed alias (`const Sp = 'span' as unknown as
//     (p) => JSX.Element`): same crash — runtime value is still a string,
//     solid invokes it as a function in completeUpdates and throws.
//   - module augmentation `interface SpanProps { fg?: string }`: opentui
//     exports SpanProps in a way that doesn't merge.
//   - inline ANSI `\x1b[38;2;…m`: opentui's <text> renders them literally.
// Direct `<span fg=…>` with `@ts-expect-error` is the only path that works.

interface AppProps {
  state: ChatState
  onSubmit: (text: string) => void | Promise<void>
  onExit: () => void
  /**
   * v0.20.0: extra slash commands (Claude Code commands etc) appended to the
   * autocomplete suggestions when typing `/`. Each entry is a `SlashCommand`
   * with `surfaces:['tui']`. The bundled registry is always shown alongside.
   */
  extraSlashCommands?: readonly SlashCommand[]
}

/** Cap visible autocomplete rows so the popup doesn't push the input box off-screen. */
const SLASH_MENU_MAX_ROWS = 8

const PREFIX_GUTTER = '   '
const LABEL_WIDTH = 5
const BODY_INDENT = `${PREFIX_GUTTER}${' '.repeat(LABEL_WIDTH + 2)}`
const TOOL_RESULT_INDENT = `${BODY_INDENT}  `

function pad5(s: string): string {
  return s.padEnd(LABEL_WIDTH, ' ')
}

function renderPrefix(label: string): string {
  return `${PREFIX_GUTTER}${pad5(label)}  `
}

function formatUsage(usage: { total?: number; cached?: number } | null | undefined): string {
  if (!usage) return ''
  const total = usage.total ?? 0
  const cached = usage.cached ?? 0
  const totalK = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`
  const cachedK = cached >= 1000 ? `${(cached / 1000).toFixed(1)}k` : `${cached}`
  return cached ? `${totalK} t (${cachedK} cached)` : `${totalK} t`
}

function formatBalance(balance: number | null | undefined): string {
  if (balance == null) return ''
  if (balance >= 100) return `${balance.toFixed(0)} Mantle`
  if (balance >= 1) return `${balance.toFixed(2)} Mantle`
  return `${balance.toFixed(3)} Mantle`
}

function balanceColor(
  balance: number | null | undefined,
  redBelow = 0.5,
  yellowBelow = 1.5,
): string {
  if (balance == null) return '#9ca3af'
  if (balance < redBelow) return '#fca5a5'
  if (balance < yellowBelow) return '#fbbf24'
  return '#9ca3af'
}

function formatElapsed(startedAt: number | null | undefined): string {
  if (!startedAt) return ''
  const sec = Math.floor((Date.now() - startedAt) / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s.toString().padStart(2, '0')}s`
}

function UserRow(props: { text: string }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg="#67e8f9" flexShrink={0}>
        {renderPrefix('you')}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#e5e7eb">
        {props.text}
      </text>
    </box>
  )
}

function SystemRow(props: { text: string }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg="#9ca3af" flexShrink={0}>
        {renderPrefix('sys')}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#9ca3af">
        {props.text}
      </text>
    </box>
  )
}

function InboxRow(props: { text: string }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg="#fbbf24" flexShrink={0}>
        {renderPrefix('inbox')}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#fde68a">
        {props.text}
      </text>
    </box>
  )
}

function MarketRow(props: { text: string }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg="#c4b5fd" flexShrink={0}>
        {renderPrefix('mkt')}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#ddd6fe">
        {props.text}
      </text>
    </box>
  )
}

function TelegramInboxRow(props: { text: string }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg="#60a5fa" flexShrink={0}>
        {renderPrefix('tg-in')}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#bfdbfe">
        {props.text}
      </text>
    </box>
  )
}

function TelegramAssistantRow(props: { text: string }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg="#60a5fa" flexShrink={0}>
        {renderPrefix('tg-out')}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#dbeafe">
        <MarkdownSegments text={props.text} />
      </text>
    </box>
  )
}

function AssistantTextRow(props: { text: string; firstOfBlock: boolean }) {
  return (
    <box flexDirection="row" marginTop={props.firstOfBlock ? 0 : 1} marginBottom={1}>
      <text fg="#86efac" flexShrink={0}>
        {props.firstOfBlock ? renderPrefix('nebula') : BODY_INDENT}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#e5e7eb">
        <MarkdownSegments text={props.text} />
      </text>
    </box>
  )
}

function ToolCallRow(props: {
  toolName: string
  args: string
  firstOfBlock: boolean
  autoEscalated?: boolean
}) {
  return (
    <box flexDirection="row">
      <text fg="#86efac" flexShrink={0}>
        {props.firstOfBlock ? renderPrefix('nebula') : BODY_INDENT}
      </text>
      <text wrapMode="word" flexGrow={1}>
        {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
        <span fg={props.autoEscalated ? '#fbbf24' : '#c4b5fd'}>
          {props.autoEscalated ? '↪ ' : '⏺ '}
        </span>
        {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
        <span fg="#e5e7eb">{props.toolName}</span>
        <Show when={props.args}>
          {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
          <span fg="#6b7280">{`(${props.args})`}</span>
        </Show>
      </text>
    </box>
  )
}

function ToolResultRow(props: { text: string; failed: boolean; autoEscalated?: boolean }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text flexShrink={0}>{TOOL_RESULT_INDENT}</text>
      <text wrapMode="word" flexGrow={1}>
        {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
        <span fg={props.failed ? '#fca5a5' : props.autoEscalated ? '#fbbf24' : '#4b5563'}>
          {props.failed ? '✗ ' : props.autoEscalated ? '↳ ' : '⎿ '}
        </span>
        {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
        <span fg={props.failed ? '#fca5a5' : '#9ca3af'}>{props.text}</span>
      </text>
    </box>
  )
}

/**
 * Slash-command popup. Rendered between the spinner row and the input box
 * when input starts with `/`. Mirrors the approval-modal layout pattern
 * (flexShrink=0 so the scrollbox compresses to make room).
 */
function SlashMenu(props: {
  matches: readonly SlashCommand[]
  selected: number
}) {
  const visible = () => props.matches.slice(0, SLASH_MENU_MAX_ROWS)
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      borderStyle="rounded"
      borderColor="#67e8f9"
      paddingLeft={2}
      paddingRight={2}
      marginLeft={2}
      marginRight={2}
      marginTop={1}
    >
      <text fg="#67e8f9">{'commands  (↑↓ select · tab/enter complete · esc dismiss)'}</text>
      <For each={visible()}>
        {(cmd, idx) => {
          const isSelected = () => idx() === props.selected
          return (
            <text wrapMode="word">
              {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
              <span fg={isSelected() ? '#86efac' : '#9ca3af'}>
                {`${isSelected() ? '› ' : '  '}/${cmd.name}`}
              </span>
              <Show when={cmd.argHint}>
                {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
                <span fg="#fbbf24">{` <${cmd.argHint}>`}</span>
              </Show>
              {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
              <span fg="#6b7280">{`  ${cmd.description}`}</span>
            </text>
          )
        }}
      </For>
      <Show when={props.matches.length > SLASH_MENU_MAX_ROWS}>
        <text fg="#6b7280">{`+ ${props.matches.length - SLASH_MENU_MAX_ROWS} more (type to filter)`}</text>
      </Show>
    </box>
  )
}

function ChatRowDispatch(props: { row: TurnRow }) {
  const r = props.row
  if (r.role === 'user') return <UserRow text={r.text} />
  if (r.role === 'system') return <SystemRow text={r.text} />
  if (r.role === 'assistant')
    return <AssistantTextRow text={r.text} firstOfBlock={r.firstOfBlock === true} />
  if (r.role === 'tool-call')
    return (
      <ToolCallRow
        toolName={r.toolName ?? '(unknown)'}
        args={r.args ?? ''}
        firstOfBlock={r.firstOfBlock === true}
        autoEscalated={r.autoEscalated === true}
      />
    )
  if (r.role === 'tool-result')
    return (
      <ToolResultRow
        text={r.text}
        failed={r.failed === true}
        autoEscalated={r.autoEscalated === true}
      />
    )
  if (r.role === 'inbox') return <InboxRow text={r.text} />
  if (r.role === 'market') return <MarketRow text={r.text} />
  if (r.role === 'inbox-tg') return <TelegramInboxRow text={r.text} />
  if (r.role === 'telegram-assistant') return <TelegramAssistantRow text={r.text} />
  return null
}

export function ChatApp(props: AppProps) {
  const dims = useTerminalDimensions()
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)
  // Loose type: @opentui/core's ScrollBox class isn't re-exported via the
  // jsx namespace, but the runtime instance has scrollBy + scrollTop.
  let scrollboxRef: { scrollBy: (delta: number) => void; scrollTop: number } | null = null
  // Only tick while we're actually waiting on the brain. Otherwise the signal
  // would notify subscribers 12.5x/sec for nothing — wasteful in the renderer.
  createEffect(() => {
    if (props.state.status() !== 'thinking') {
      setSpinnerFrame(0)
      return
    }
    const id = setInterval(
      () => setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_FRAME_MS,
    )
    onCleanup(() => clearInterval(id))
  })

  // When the approval modal mounts, scrollbox flexGrow=1 compresses to give
  // it room. opentui's stickyScroll reanchors against the new shorter
  // viewport before content remeasures, sometimes landing at scrollTop=0.
  // Force a re-snap to the bottom one tick after mount.
  createEffect(() => {
    const pending = props.state.pendingApproval()
    if (!pending) return
    queueMicrotask(() => {
      if (!scrollboxRef) return
      // Setting scrollTop to a large value clamps to scrollHeight inside opentui.
      try {
        scrollboxRef.scrollTop = Number.MAX_SAFE_INTEGER
      } catch {
        // Older opentui versions: scrollBy with a big delta lands at the bottom.
        scrollboxRef.scrollBy?.(1_000_000)
      }
    })
  })

  // Recompute the slash autocomplete matches whenever input starts with `/`.
  // Cleared on submit/exit/non-slash input. Pulls registry + caller-supplied
  // extras (Claude Code commands).
  function refreshSlashMatches(nextInput: string): void {
    if (!nextInput.startsWith('/')) {
      if (props.state.slashMatches().length > 0) props.state.setSlashMatches([])
      return
    }
    const builtins = suggestForPrefix('tui', nextInput)
    const extras = (props.extraSlashCommands ?? []).filter(cmd => {
      const stripped = nextInput.replace(/^\/+/, '').toLowerCase()
      return stripped.length === 0 || cmd.name.startsWith(stripped)
    })
    const merged = [...builtins]
    for (const e of extras) {
      if (!merged.some(b => b.name === e.name)) merged.push(e)
    }
    props.state.setSlashMatches(merged)
    if (props.state.slashIndex() >= merged.length) props.state.setSlashIndex(0)
  }

  useKeyboard(evt => {
    if (evt.ctrl && evt.name === 'c') {
      evt.preventDefault()
      props.onExit()
      return
    }
    // Approval modal mode: swallow keys, route y/s/n to decision.
    const pending = props.state.pendingApproval()
    if (pending) {
      if (evt.name === 'return') return
      if (evt.sequence) {
        const ch = evt.sequence.toLowerCase()
        if (ch === 'y' || ch === '1') {
          pending.resolve('allow-once')
          props.state.setPendingApproval(null)
          return
        }
        if (ch === 's' || ch === '2') {
          pending.resolve('allow-session')
          props.state.setPendingApproval(null)
          return
        }
        if (ch === 'n' || ch === 'd' || ch === '3' || evt.name === 'escape') {
          pending.resolve('deny')
          props.state.setPendingApproval(null)
          return
        }
      }
      return
    }
    // stickyScroll auto-snaps to bottom on new rows; ctrl+u/d (vim-style
    // half-page) and opt+u/d let the operator scroll back through past
    // responses mid-conversation. Ctrl works in every terminal; Opt only
    // works when the terminal is configured to send Opt as Meta/Alt
    // (Ghostty needs `macos-option-as-alt = true`, iTerm2 "Option as Esc+",
    // Terminal.app "Use Option as Meta key").
    if ((evt.ctrl || evt.option) && (evt.name === 'u' || evt.name === 'd')) {
      scrollboxRef?.scrollBy(evt.name === 'u' ? -SCROLL_STEP : SCROLL_STEP)
      return
    }
    // Esc dismisses the slash menu first; only on a second press does it
    // abort the current brain turn.
    if (evt.name === 'escape') {
      if (props.state.slashMatches().length > 0) {
        props.state.setSlashMatches([])
        props.state.setSlashIndex(0)
        return
      }
      const abort = props.state.activeAbort()
      if (abort && !abort.signal.aborted) {
        abort.abort()
      }
      return
    }
    // Slash menu: ↑/↓ cycle selection, Tab completes, Enter submits the
    // selection (when the menu is open). Only fires when matches are visible.
    if (props.state.slashMatches().length > 0) {
      if (evt.name === 'up') {
        const len = props.state.slashMatches().length
        props.state.setSlashIndex(i => (i - 1 + len) % len)
        return
      }
      if (evt.name === 'down') {
        const len = props.state.slashMatches().length
        props.state.setSlashIndex(i => (i + 1) % len)
        return
      }
      if (evt.name === 'tab') {
        const cmd = props.state.slashMatches()[props.state.slashIndex()]
        if (cmd) {
          const next = `/${cmd.name}${cmd.argHint ? ' ' : ''}`
          props.state.setInput(next)
          refreshSlashMatches(next)
        }
        return
      }
    }
    if (evt.name === 'return') {
      const text = props.state.input().trim()
      if (!text) return
      // Mid-turn submit guard: refuse to fire a second brain.infer while one
      // is in flight (concurrent infers clobber history). Tell the operator
      // how to interrupt the current one.
      if (props.state.status() === 'thinking') {
        props.state.pushRow({
          role: 'system',
          text: 'turn in progress. press esc to interrupt before sending the next message.',
        })
        return
      }
      // If the slash menu is open and a single match exists with no args
      // typed yet, complete to that command name before submitting. Otherwise
      // submit verbatim — operator may have typed `/perms strict` in full.
      let toSubmit = text
      if (props.state.slashMatches().length === 1 && /^\/\S+$/.test(text)) {
        const sole = props.state.slashMatches()[0]!
        toSubmit = `/${sole.name}`
      }
      props.state.pushRow({ role: 'user', text: toSubmit })
      props.state.setInput('')
      props.state.setSlashMatches([])
      props.state.setSlashIndex(0)
      props.state.setStatus('thinking')
      props.onSubmit(toSubmit)
      return
    }
    if (evt.name === 'backspace' || evt.name === 'delete') {
      props.state.setInput(prev => {
        const next = prev.slice(0, -1)
        refreshSlashMatches(next)
        return next
      })
      return
    }
    // Typed characters AND pasted text. A paste arrives as a single multi-char
    // event (sometimes wrapped in a bracketed-paste sequence); the old
    // `length === 1` guard dropped it, so paste did nothing. Accept printable
    // text of any length: extract the bracketed-paste payload if present, then
    // strip control bytes (ESC sequences from arrow/fn keys, CR/LF/TAB) so only
    // real text lands in the input.
    if (evt.sequence && !evt.ctrl && !evt.meta && !evt.option) {
      const ESC = String.fromCharCode(27)
      let seq = evt.sequence
      if (seq.includes(ESC)) {
        // Bracketed paste: ESC[200~ <text> ESC[201~. Anything else with an ESC
        // is an arrow/fn escape sequence — not text — so ignore it.
        const start = seq.indexOf(`${ESC}[200~`)
        const end = seq.indexOf(`${ESC}[201~`)
        if (start === -1 || end === -1 || end <= start) return
        seq = seq.slice(start + 6, end)
      }
      // Keep only printable characters (drop control bytes incl. CR/LF/TAB).
      let text = ''
      for (const ch of seq) {
        const c = ch.charCodeAt(0)
        if (c >= 0x20 && c !== 0x7f) text += ch
      }
      if (!text) return
      props.state.setInput(prev => {
        const next = prev + text
        refreshSlashMatches(next)
        return next
      })
    }
  })

  // Clipboard paste (⌘/Ctrl+V) arrives as a bracketed-paste event on its own
  // channel — NOT as keypresses — so it must be handled here, not in
  // useKeyboard. Decode the bytes, drop control chars, and append to the input.
  usePaste(evt => {
    if (props.state.pendingApproval()) return
    let pasted = ''
    try {
      pasted = new TextDecoder().decode(evt.bytes)
    } catch {
      return
    }
    let text = ''
    for (const ch of pasted) {
      const c = ch.charCodeAt(0)
      if (c >= 0x20 && c !== 0x7f) text += ch
    }
    if (!text) return
    props.state.setInput(prev => {
      const next = prev + text
      refreshSlashMatches(next)
      return next
    })
  })

  return (
    <box flexDirection="column" width={dims().width} height={dims().height}>
      {/* Chat history — scrollable so it never crowds the input area. */}
      <scrollbox
        ref={(el: typeof scrollboxRef) => {
          scrollboxRef = el
        }}
        flexGrow={1}
        flexShrink={1}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{
          flexDirection: 'column',
          paddingLeft: 0,
          paddingRight: 1,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        <For each={props.state.rows()}>{row => <ChatRowDispatch row={row} />}</For>
      </scrollbox>

      {/* Approval modal — single-color rows (nested spans broke layout in v0.7.0). */}
      <Show when={props.state.pendingApproval()}>
        <box
          flexDirection="column"
          flexShrink={0}
          borderStyle="rounded"
          borderColor="#f59e0b"
          paddingLeft={2}
          paddingRight={2}
          marginLeft={2}
          marginRight={2}
          marginTop={1}
        >
          <text fg="#fbbf24" wrapMode="word">
            {`⚠  approval needed  ·  ${props.state.pendingApproval()!.request.reason}`}
          </text>
          <text fg="#fde68a" wrapMode="word">
            {summarizeApprovalSubject(props.state.pendingApproval()!.request)}
          </text>
          <text>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#86efac">{'[y]'}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#9ca3af">{' allow once   '}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#86efac">{'[s]'}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#9ca3af">{' allow session   '}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#fca5a5">{'[n]'}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#9ca3af">{' deny'}</span>
          </text>
        </box>
      </Show>

      {/* v0.20.0: slash autocomplete popup. Pushed between spinner row and
          input box so the operator sees command suggestions live as they
          type. Mirrors approval-modal layout pattern (flexShrink=0 + the
          scrollbox compresses). */}
      <Show when={props.state.slashMatches().length > 0}>
        <SlashMenu matches={props.state.slashMatches()} selected={props.state.slashIndex()} />
      </Show>

      {/* Status hint row above input. Always rendered (no Show wrapper) so
          the row's height never collapses; spinner content swaps between a
          spinner string and a single space (never empty — opentui's text
          renderer chokes on truly-empty children). The elapsed counter
          re-evaluates on every spinnerFrame tick (80ms), no extra timer. */}
      <box flexDirection="row" flexShrink={0} paddingLeft={3} paddingRight={2} marginTop={1}>
        <text fg="#67e8f9" flexGrow={1}>
          {(() => {
            if (props.state.status() !== 'thinking') return ' '
            // re-read spinnerFrame so this expression is reactive
            spinnerFrame()
            const elapsed = formatElapsed(props.state.turnStartedAt())
            const frame = SPINNER_FRAMES[spinnerFrame()]
            return elapsed
              ? `${frame} thinking… ${elapsed} (esc to interrupt)`
              : `${frame} thinking… (esc to interrupt)`
          })()}
        </text>
      </box>

      {/* Input bar — minHeight=3 keeps the row visible when empty; box grows
          as the wrapped text needs more rows. maxHeight caps runaway growth
          on a paste of huge content so the chat history never gets shoved
          off-screen. */}
      <box
        flexDirection="row"
        flexShrink={0}
        minHeight={3}
        maxHeight={12}
        borderStyle="rounded"
        borderColor="#374151"
        paddingLeft={1}
        paddingRight={1}
        marginLeft={2}
        marginRight={2}
      >
        <text fg="#67e8f9" flexShrink={0}>
          {'> '}
        </text>
        <text wrapMode="word" flexGrow={1} fg="#e5e7eb">
          {`${props.state.input()}${props.state.status() === 'idle' ? '▋' : ''}`}
        </text>
      </box>

      {/* Status footer. Each separator is paired with its value via a Show so
          dropping a value also drops its leading separator (no orphans).
          Hint text takes flexShrink=1 so on narrow terminals it compresses
          before colliding with the left side. */}
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2}>
        <text fg="#86efac" flexShrink={0}>
          {props.state.identityLabel}
        </text>
        <text fg="#374151" flexShrink={0}>
          {'  ·  '}
        </text>
        {/* v0.22.0: perms label unifies with /yolo. When mode is 'off', show
            "YOLO" in red so operators read it as a danger signal — modals are
            disabled, dangerous tool calls run without prompting. Strict/prompt
            keep the literal mode in gray for clarity. */}
        <text fg={props.state.approvalsMode() === 'off' ? '#ef4444' : '#9ca3af'} flexShrink={0}>
          {props.state.approvalsMode() === 'off' ? 'YOLO' : `perms: ${props.state.approvalsMode()}`}
        </text>
        {/* opentui's <Show> renders in resolution order, not JSX order; matching
            here keeps intent obvious. Wallet first because EOA gas starves first. */}
        <Show when={props.state.eoaBalance() != null}>
          <text fg="#374151" flexShrink={0}>
            {'  ·  '}
          </text>
          <text fg="#6b7280" flexShrink={0}>
            {'wallet '}
          </text>
          <text fg={balanceColor(props.state.eoaBalance(), 0.005, 0.02)} flexShrink={0}>
            {formatBalance(props.state.eoaBalance())}
          </text>
        </Show>
        <Show when={props.state.balance() != null}>
          <text fg="#374151" flexShrink={0}>
            {'  ·  '}
          </text>
          <text fg="#6b7280" flexShrink={0}>
            {'compute '}
          </text>
          <text fg={balanceColor(props.state.balance())} flexShrink={0}>
            {formatBalance(props.state.balance())}
          </text>
        </Show>
        {/* v0.24.4: hide the sandbox-billing balance segment on local-gateway
            deploys. There's no Daytona reserve to surface for a daemon running
            on the operator's own machine; chat-sandbox.tsx also skips the
            getSandboxBillingReserve RPC for the same reason, so the signal
            stays null even if the gate were missing — but gating here keeps
            the statusbar deterministic for tests + future setters. */}
        <Show when={!props.state.isLocalGateway && props.state.sandboxBalance() != null}>
          <text fg="#374151" flexShrink={0}>
            {'  ·  '}
          </text>
          <text fg="#6b7280" flexShrink={0}>
            {'sandbox '}
          </text>
          <text fg={balanceColor(props.state.sandboxBalance())} flexShrink={0}>
            {formatBalance(props.state.sandboxBalance())}
          </text>
        </Show>
        <Show when={props.state.activeJobCount() > 0}>
          <text fg="#374151" flexShrink={0}>
            {'  ·  '}
          </text>
          <text fg="#fbbf24" flexShrink={0}>
            {`${props.state.activeJobCount()} escrow`}
          </text>
        </Show>
        <Show when={props.state.usage()}>
          <text fg="#374151" flexShrink={0}>
            {'  ·  '}
          </text>
          <text fg="#9ca3af" flexShrink={0}>
            {formatUsage(props.state.usage())}
          </text>
        </Show>
      </box>
    </box>
  )
}
