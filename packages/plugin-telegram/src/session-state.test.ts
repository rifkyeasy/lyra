import { describe, expect, it } from 'bun:test'
import { ActiveSessionTracker, BYPASS_COMMANDS, parseBypassCommand } from './session-state'

describe('parseBypassCommand', () => {
  it('returns null for non-slash text', () => {
    expect(parseBypassCommand('hello there')).toBeNull()
    expect(parseBypassCommand('what time is it')).toBeNull()
  })

  it('matches each bypass command verbatim with empty args', () => {
    for (const cmd of BYPASS_COMMANDS) {
      const r = parseBypassCommand(cmd)
      expect(r).toEqual({ command: cmd, args: [] })
    }
  })

  it('is case-insensitive on the command name', () => {
    expect(parseBypassCommand('/STOP')?.command).toBe('/stop')
    expect(parseBypassCommand('/Reset')?.command).toBe('/reset')
  })

  it('captures whitespace-split args after the command', () => {
    expect(parseBypassCommand('/stop please')).toEqual({ command: '/stop', args: ['please'] })
    expect(parseBypassCommand('/new with arg')).toEqual({
      command: '/new',
      args: ['with', 'arg'],
    })
  })

  it('parses /perms with mode arg', () => {
    expect(parseBypassCommand('/perms strict')).toEqual({ command: '/perms', args: ['strict'] })
    expect(parseBypassCommand('/perms')).toEqual({ command: '/perms', args: [] })
  })

  it('parses /yolo with no args', () => {
    expect(parseBypassCommand('/yolo')).toEqual({ command: '/yolo', args: [] })
  })

  it('returns null for unknown slash commands', () => {
    expect(parseBypassCommand('/foobar')).toBeNull()
    expect(parseBypassCommand('/help')).toBeNull()
  })

  it('returns null for empty text', () => {
    expect(parseBypassCommand('')).toBeNull()
    expect(parseBypassCommand('  ')).toBeNull()
  })

  it('strips leading whitespace', () => {
    expect(parseBypassCommand('   /stop')?.command).toBe('/stop')
  })
})

describe('ActiveSessionTracker', () => {
  it('isActive returns false initially', () => {
    const t = new ActiveSessionTracker()
    expect(t.isActive('a')).toBe(false)
  })

  it('markActive then markIdle round-trip', () => {
    const t = new ActiveSessionTracker()
    t.markActive('a')
    expect(t.isActive('a')).toBe(true)
    t.markIdle('a')
    expect(t.isActive('a')).toBe(false)
  })

  it('different keys do not collide', () => {
    const t = new ActiveSessionTracker()
    t.markActive('a')
    expect(t.isActive('b')).toBe(false)
  })

  it('abortActive calls the stored AbortController', () => {
    const t = new ActiveSessionTracker()
    const ctrl = new AbortController()
    t.markActive('a', ctrl)
    expect(t.abortActive('a')).toBe(true)
    expect(ctrl.signal.aborted).toBe(true)
  })

  it('abortActive returns false when there is no active session', () => {
    const t = new ActiveSessionTracker()
    expect(t.abortActive('a')).toBe(false)
  })

  it('abortActive returns false when active session has no AbortController', () => {
    const t = new ActiveSessionTracker()
    t.markActive('a', null)
    expect(t.abortActive('a')).toBe(false)
  })

  it('setPending / takePending one-shot', () => {
    const t = new ActiveSessionTracker()
    t.setPending('a', { kind: 'queued' })
    expect(t.takePending('a')).toEqual({ kind: 'queued' })
    expect(t.takePending('a')).toBeUndefined()
  })

  it('activeKeys lists all active session keys', () => {
    const t = new ActiveSessionTracker()
    t.markActive('a')
    t.markActive('b')
    expect(t.activeKeys().sort()).toEqual(['a', 'b'])
  })

  it('synchronous mark-active closes the race window', () => {
    // Simulate two messages arriving in the same tick: only the first should
    // see isActive=false; the second sees isActive=true even though no async
    // work has started yet.
    const t = new ActiveSessionTracker()
    expect(t.isActive('a')).toBe(false)
    t.markActive('a')
    expect(t.isActive('a')).toBe(true)
  })
})
