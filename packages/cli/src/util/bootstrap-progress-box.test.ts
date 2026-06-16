import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import {
  BootstrapProgressBox,
  __testing,
  mapBootstrapMarkerToStage,
} from './bootstrap-progress-box'

class CapturingStream extends Writable {
  chunks: string[] = []
  isTTY: boolean
  constructor(isTTY: boolean) {
    super()
    this.isTTY = isTTY
  }
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  combined(): string {
    return this.chunks.join('')
  }
}

describe('mapBootstrapMarkerToStage', () => {
  test('maps every gateway bootstrap.ts marker', () => {
    expect(mapBootstrapMarkerToStage('updating package index')).toBe('apt-update')
    expect(
      mapBootstrapMarkerToStage('installing system deps (build-essential, curl, git, xvfb)'),
    ).toBe('system-deps')
    expect(mapBootstrapMarkerToStage('installing bun runtime')).toBe('bun-install')
    expect(mapBootstrapMarkerToStage('installing nebula (0.24.7)')).toBe('nebula-install')
    expect(mapBootstrapMarkerToStage('installing nebula (git main)')).toBe('nebula-install')
    expect(mapBootstrapMarkerToStage('installing chrome for browser tools')).toBe('browser-deps')
    expect(mapBootstrapMarkerToStage('starting harness daemon')).toBe('harness-spawn')
    expect(mapBootstrapMarkerToStage('harness ready')).toBe('harness-spawn')
  })

  test('returns null for unknown markers', () => {
    expect(mapBootstrapMarkerToStage('something else entirely')).toBeNull()
    expect(mapBootstrapMarkerToStage('')).toBeNull()
  })
})

describe('BootstrapProgressBox TTY mode', () => {
  test('start renders the initial frame with all stages pending', () => {
    const out = new CapturingStream(true)
    const box = new BootstrapProgressBox({ out })
    box.start()
    const combined = out.combined()
    expect(combined).toContain('bootstrap progress')
    expect(combined).toContain('launchScript uploaded to Daytona')
    expect(combined).toContain('apt update')
    expect(combined).toContain('/healthz Ready')
    expect(combined).toContain('╰')
  })

  test('markStage running uses spinner glyph; done uses checkmark', () => {
    const out = new CapturingStream(true)
    const box = new BootstrapProgressBox({ out })
    box.start()
    box.markStage('launch-upload', 'running')
    const afterRunning = out.combined()
    const runningGlyph = __testing.SPINNER_FRAMES.find(g => afterRunning.includes(g))
    expect(runningGlyph).toBeDefined()

    box.markStage('launch-upload', 'done')
    expect(out.combined()).toContain('✓')
  })

  test('markStage running auto-completes prior pending stages (handles skipped bun-install)', () => {
    const out = new CapturingStream(true)
    const box = new BootstrapProgressBox({ out })
    box.start()
    box.markStage('apt-update', 'running')
    box.markStage('system-deps', 'running')
    // Skip bun-install — bun already installed
    box.markStage('nebula-install', 'running')
    const checkmarks = (out.combined().match(/✓/g) ?? []).length
    // Stages auto-completed: launch-upload (skipped), apt-update, system-deps, bun-install (skipped)
    expect(checkmarks).toBeGreaterThanOrEqual(4)
  })

  test('stop finalizes any running stage as done and appends a newline', () => {
    const out = new CapturingStream(true)
    const box = new BootstrapProgressBox({ out })
    box.start()
    box.markStage('healthz-ready', 'running')
    box.stop()
    const combined = out.combined()
    const checkmarks = (combined.match(/✓/g) ?? []).length
    expect(checkmarks).toBeGreaterThanOrEqual(1)
    expect(combined.endsWith('\n')).toBe(true)
  })

  test('fail marks running stage as failed (✗) and leaves later pending stages alone', () => {
    const out = new CapturingStream(true)
    const box = new BootstrapProgressBox({ out })
    box.start()
    box.markStage('nebula-install', 'running')
    box.fail()
    expect(out.combined()).toContain('✗')
  })

  test('uses ANSI cursor-up + clear-to-end between renders', () => {
    const out = new CapturingStream(true)
    const box = new BootstrapProgressBox({ out })
    box.start()
    box.markStage('apt-update', 'running')
    const combined = out.combined()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: validates emitted ANSI escapes
    expect(combined).toMatch(/\x1b\[\d+A/)
    expect(combined).toContain('\x1b[0J')
  })

  test('honors custom label override', () => {
    const out = new CapturingStream(true)
    const box = new BootstrapProgressBox({
      out,
      labels: { 'nebula-install': 'nebula 0.24.7 installed' },
    })
    box.start()
    expect(out.combined()).toContain('nebula 0.24.7 installed')
  })

  test('row layout pads to constant width regardless of label length', () => {
    const out = new CapturingStream(true)
    const box = new BootstrapProgressBox({ out })
    box.start()
    const lines = out
      .combined()
      .split('\n')
      .filter(l => l.startsWith('│'))
    const widths = lines.map(l => stripAnsi(l).length)
    const unique = new Set(widths)
    expect(unique.size).toBe(1)
  })
})

describe('BootstrapProgressBox non-TTY fallback', () => {
  test('emits per-transition lines without ANSI', () => {
    const out = new CapturingStream(false)
    const box = new BootstrapProgressBox({ out })
    box.start()
    box.markStage('apt-update', 'running')
    box.markStage('apt-update', 'done')
    const combined = out.combined()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserts absence of ANSI escapes
    expect(combined).not.toMatch(/\x1b\[/)
    expect(combined).toContain('[..]')
    expect(combined).toContain('[ok]')
    expect(combined).toContain('apt update')
  })

  test('does not re-print the same status twice in non-TTY mode', () => {
    const out = new CapturingStream(false)
    const box = new BootstrapProgressBox({ out })
    box.start()
    box.markStage('apt-update', 'done')
    box.tick()
    box.tick()
    const okLines = (out.combined().match(/\[ok\] /g) ?? []).length
    expect(okLines).toBe(1)
  })
})

describe('formatTime', () => {
  test('00:00 for zero', () => {
    expect(__testing.formatTime(0)).toBe('00:00')
  })
  test('zero pads single-digit seconds and minutes', () => {
    expect(__testing.formatTime(7)).toBe('00:07')
    expect(__testing.formatTime(65)).toBe('01:05')
    expect(__testing.formatTime(601)).toBe('10:01')
  })
})

describe('truncate', () => {
  test('returns as-is when within limit', () => {
    expect(__testing.truncate('hello', 10)).toBe('hello')
  })
  test('truncates with ellipsis when over limit', () => {
    expect(__testing.truncate('a very long label that overflows', 12)).toBe('a very long…')
  })
})

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}
