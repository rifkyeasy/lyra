/**
 * Multi-line ANSI progress box for sandbox bootstrap. Replaces the single-line
 * clack spinner across the launch + poll + /healthz window:
 *
 *   ╭─ bootstrap progress ────────────────────────╮
 *   │  [00:00] launchScript uploaded to Daytona   │
 *   │  [00:12] apt update                     ✓   │
 *   │  [00:38] system deps installed          ✓   │
 *   │  [01:04] bun runtime installed          ✓   │
 *   │  [01:22] nebula 0.24.7 installed         ✓   │
 *   │  [01:45] browser deps installed         ✓   │
 *   │  [02:08] harness daemon spawned         ✓   │
 *   │  [02:11] /healthz Ready                 ✓   │
 *   ╰─────────────────────────────────────────────╯
 *
 * Rendering uses `\x1b[NA` (cursor up) + `\x1b[0J` (clear to end) to redraw
 * the same N+2 lines in place. Falls back to per-transition lines (no ANSI)
 * when stdout is not a TTY (CI, piped output).
 */

import { BOOTSTRAP_STAGE_MARKERS } from 'nebula-ai-gateway'

const TIME_SLOT_WIDTH = 7
const LABEL_WIDTH = 32
const CONTENT_WIDTH = 45
const FRAME_WIDTH = CONTENT_WIDTH + 2

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'] as const

export type BootstrapStageId =
  | 'launch-upload'
  | 'apt-update'
  | 'system-deps'
  | 'bun-install'
  | 'nebula-install'
  | 'browser-deps'
  | 'harness-spawn'
  | 'healthz-ready'

export type BootstrapStageStatus = 'pending' | 'running' | 'done' | 'failed'

const STAGE_ORDER: readonly BootstrapStageId[] = [
  'launch-upload',
  'apt-update',
  'system-deps',
  'bun-install',
  'nebula-install',
  'browser-deps',
  'harness-spawn',
  'healthz-ready',
] as const

const DEFAULT_LABELS: Record<BootstrapStageId, string> = {
  'launch-upload': 'launchScript uploaded to Daytona',
  'apt-update': 'apt update',
  'system-deps': 'system deps installed',
  'bun-install': 'bun runtime installed',
  'nebula-install': 'nebula installed',
  'browser-deps': 'browser deps installed',
  'harness-spawn': 'harness daemon spawned',
  'healthz-ready': '/healthz Ready',
}

interface StageState {
  id: BootstrapStageId
  label: string
  status: BootstrapStageStatus
  /** Seconds since box start when status transitioned to running. */
  startedSec?: number
  /** Seconds since box start when status transitioned to done/failed. */
  endedSec?: number
}

export interface BootstrapProgressBoxOpts {
  /** Box title. Defaults to "bootstrap progress". */
  title?: string
  /** Per-stage label override. Useful for injecting the version into nebula-install. */
  labels?: Partial<Record<BootstrapStageId, string>>
  /** Stream to write to. Defaults to process.stdout. */
  out?: NodeJS.WritableStream & { isTTY?: boolean }
}

/**
 * Map a raw STAGE marker (emitted by the gateway bootstrap script as
 * `STAGE: <body>` and extracted by sandbox-provision's poll loop) to a stage
 * id. Returns null for unknown markers; callers should treat unknown markers
 * as informational, not as state transitions. Marker prefixes come from
 * `BOOTSTRAP_STAGE_MARKERS` in the gateway package so renames stay in lockstep.
 */
export function mapBootstrapMarkerToStage(marker: string): BootstrapStageId | null {
  const m = marker.trim()
  if (m.startsWith(BOOTSTRAP_STAGE_MARKERS.aptUpdate)) return 'apt-update'
  if (m.startsWith(BOOTSTRAP_STAGE_MARKERS.systemDeps)) return 'system-deps'
  if (m.startsWith(BOOTSTRAP_STAGE_MARKERS.bunInstall)) return 'bun-install'
  if (m.startsWith(BOOTSTRAP_STAGE_MARKERS.nebulaInstall)) return 'nebula-install'
  if (m.startsWith(BOOTSTRAP_STAGE_MARKERS.browserDeps)) return 'browser-deps'
  if (m.startsWith(BOOTSTRAP_STAGE_MARKERS.harnessSpawn)) return 'harness-spawn'
  if (m.startsWith(BOOTSTRAP_STAGE_MARKERS.harnessReady)) return 'harness-spawn'
  return null
}

export class BootstrapProgressBox {
  private readonly title: string
  private readonly out: NodeJS.WritableStream & { isTTY?: boolean }
  private readonly useAnsi: boolean
  private readonly stages: StageState[]
  private startMs = 0
  private tickIdx = 0
  /** Number of lines we wrote the LAST time render() ran (so we know how
   *  many to clear before the next render). Zero before the first render. */
  private renderedLines = 0
  /** Cleared on render — tracks last-printed status per stage in non-TTY mode. */
  private readonly nonTtyLastPrinted = new Map<BootstrapStageId, BootstrapStageStatus>()

  constructor(opts: BootstrapProgressBoxOpts = {}) {
    this.title = opts.title ?? 'bootstrap progress'
    this.out = opts.out ?? process.stdout
    this.useAnsi = this.out.isTTY === true
    this.stages = STAGE_ORDER.map(id => ({
      id,
      label: opts.labels?.[id] ?? DEFAULT_LABELS[id],
      status: 'pending' as BootstrapStageStatus,
    }))
  }

  start(): void {
    this.startMs = Date.now()
    if (!this.useAnsi) return
    this.render()
  }

  /**
   * Update one stage. When `status === 'running'`, every previously-running
   * stage that hasn't transitioned to done/failed is auto-completed (the
   * bash script is sequential, so a new stage starting implies the prior
   * ones finished). Stages before the activated one that are still pending
   * are also auto-completed — this handles conditional stages (e.g.
   * bun-install gets skipped when bun is already in PATH).
   */
  markStage(id: BootstrapStageId, status: BootstrapStageStatus): void {
    const sec = this.elapsedSec()
    const idx = this.stages.findIndex(s => s.id === id)
    if (idx < 0) return
    if (status === 'running') {
      for (let i = 0; i < idx; i++) {
        const s = this.stages[i]!
        if (s.status !== 'done' && s.status !== 'failed') {
          s.status = 'done'
          s.endedSec = sec
        }
      }
      const target = this.stages[idx]!
      if (target.status === 'pending') target.startedSec = sec
      target.status = 'running'
    } else {
      const target = this.stages[idx]!
      target.status = status
      target.endedSec = sec
      if (target.startedSec === undefined) target.startedSec = sec
    }
    this.tickIdx += 1
    this.render()
  }

  /**
   * Bump the spinner glyph + elapsed counter. Call every 1-5s while a
   * running stage is in-flight to keep the visual alive even when no STAGE
   * marker has arrived. No-op when the box hasn't started yet or when no
   * stage is currently running.
   */
  tick(): void {
    if (this.renderedLines === 0 && this.useAnsi) {
      this.render()
      return
    }
    this.tickIdx += 1
    this.render()
  }

  /**
   * Finalize the box. Marks any still-running stages as done (assumed
   * complete; the upstream success signal is what triggered stop()), draws
   * one final frame, and emits the trailing newline so subsequent CLI
   * output (e.g. final spinner success line) starts cleanly below.
   */
  stop(): void {
    const sec = this.elapsedSec()
    for (const s of this.stages) {
      if (s.status === 'running') {
        s.status = 'done'
        s.endedSec = sec
      }
    }
    this.render()
    if (this.useAnsi) this.out.write('\n')
  }

  /**
   * Mark the box as aborted. Any running stage becomes failed; pending
   * stages stay pending so the operator sees where bootstrap got stuck.
   */
  fail(): void {
    const sec = this.elapsedSec()
    for (const s of this.stages) {
      if (s.status === 'running') {
        s.status = 'failed'
        s.endedSec = sec
      }
    }
    this.render()
    if (this.useAnsi) this.out.write('\n')
  }

  private elapsedSec(): number {
    return Math.max(0, Math.round((Date.now() - this.startMs) / 1000))
  }

  private render(): void {
    if (!this.useAnsi) {
      this.renderNonTty()
      return
    }
    const lines = this.buildLines()
    if (this.renderedLines > 0) {
      this.out.write(`\x1b[${this.renderedLines}A\x1b[0J`)
    }
    for (const line of lines) this.out.write(`${line}\n`)
    this.renderedLines = lines.length
  }

  /**
   * Non-TTY fallback: print one line per state change instead of a redrawn
   * box. Tracks last-printed status per stage so re-renders don't spam.
   */
  private renderNonTty(): void {
    for (const s of this.stages) {
      const prev = this.nonTtyLastPrinted.get(s.id)
      if (prev === s.status) continue
      if (s.status === 'pending') continue
      const tag =
        s.status === 'done'
          ? '[ok]'
          : s.status === 'failed'
            ? '[fail]'
            : s.status === 'running'
              ? '[..]'
              : ''
      const time =
        s.status === 'running'
          ? formatTime(s.startedSec ?? 0)
          : formatTime(s.endedSec ?? this.elapsedSec())
      this.out.write(`${tag} [${time}] ${s.label}\n`)
      this.nonTtyLastPrinted.set(s.id, s.status)
    }
  }

  private buildLines(): string[] {
    const header = `╭─ ${this.title} ${'─'.repeat(FRAME_WIDTH - this.title.length - 5)}╮`
    const footer = `╰${'─'.repeat(FRAME_WIDTH - 2)}╯`
    const rows = this.stages.map(s => this.formatRow(s))
    return [header, ...rows, footer]
  }

  private formatRow(s: StageState): string {
    const timeText = pickTimeText(s)
    const timeCol =
      timeText === null ? ' '.repeat(TIME_SLOT_WIDTH) : `[${timeText}]`.padEnd(TIME_SLOT_WIDTH)
    const labelText = truncate(s.label, LABEL_WIDTH).padEnd(LABEL_WIDTH)
    const glyph = pickGlyph(s, this.tickIdx)
    return `│  ${timeCol} ${labelText} ${glyph} │`
  }
}

function pickTimeText(s: StageState): string | null {
  if (s.status === 'pending') return null
  const sec = s.status === 'running' ? (s.startedSec ?? 0) : (s.endedSec ?? s.startedSec ?? 0)
  return formatTime(sec)
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function pickGlyph(s: StageState, tickIdx: number): string {
  if (s.status === 'done') return '✓'
  if (s.status === 'failed') return '✗'
  if (s.status === 'running') return SPINNER_FRAMES[tickIdx % SPINNER_FRAMES.length]!
  return ' '
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

export const __testing = {
  STAGE_ORDER,
  DEFAULT_LABELS,
  SPINNER_FRAMES,
  formatTime,
  truncate,
}

/**
 * Lifecycle owner for the bootstrap progress UX. Wraps the clack spinner
 * (which renders the pre-bootstrap phase: deposit + createSandbox) and a
 * lazily-created `BootstrapProgressBox` (which renders the actual bootstrap
 * stages). Encapsulates the takeover handoff so `init.ts` and `upgrade.ts`
 * don't repeat the same `let box / spinnerStopped` dance.
 */
export interface ClackSpinnerLike {
  message: (msg: string) => void
  stop: (msg?: string, code?: number) => void
}

export interface BootstrapProgressControllerOpts {
  spinner: ClackSpinnerLike
  cliVersion: string
  /** Text shown when the spinner stops + the box takes over (e.g. "sandbox started, running bootstrap"). */
  startedMsg: string
}

export class BootstrapProgressController {
  private box: BootstrapProgressBox | null = null
  private spinnerStopped = false
  private readonly spinner: ClackSpinnerLike
  private readonly cliVersion: string
  private readonly startedMsg: string

  constructor(opts: BootstrapProgressControllerOpts) {
    this.spinner = opts.spinner
    this.cliVersion = opts.cliVersion
    this.startedMsg = opts.startedMsg
  }

  onProgress = (msg: string): void => {
    if (this.box) return
    this.spinner.message(msg)
  }

  onStageEvent = (stage: BootstrapStageId, status: BootstrapStageStatus): void => {
    if (!this.box) {
      this.spinner.stop(this.startedMsg)
      this.spinnerStopped = true
      this.box = new BootstrapProgressBox({
        labels: { 'nebula-install': `nebula ${this.cliVersion} installed` },
      })
      this.box.start()
    }
    this.box.markStage(stage, status)
  }

  onTick = (): void => {
    this.box?.tick()
  }

  /** Box closes itself; success line printed via the caller's `emit` (typically `log.step`). */
  finalize(successLine: string, emit: (msg: string) => void): void {
    if (this.box) {
      this.box.stop()
      emit(successLine)
    } else {
      this.spinner.stop(successLine)
    }
  }

  /** Box marks running stage as failed; error line printed via caller's `emit` (typically `log.error`). */
  fail(errLine: string, emit: (msg: string) => void): void {
    if (this.box) {
      this.box.fail()
      emit(errLine)
    } else if (!this.spinnerStopped) {
      this.spinner.stop(errLine)
    }
  }
}
