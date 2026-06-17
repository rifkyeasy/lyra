import { describe, expect, it } from 'bun:test'
import { buildTelegramCommands } from './commands'

describe('buildTelegramCommands', () => {
  it('returns at least the v0.20.0 cross-surface commands', () => {
    const out = buildTelegramCommands()
    const names = out.map(c => c.command)
    expect(names).toContain('yolo')
    expect(names).toContain('perms')
    expect(names).toContain('reset')
  })

  it('command names have no leading slash', () => {
    for (const c of buildTelegramCommands()) {
      expect(c.command.startsWith('/')).toBe(false)
    }
  })

  it('every entry has a non-empty description', () => {
    for (const c of buildTelegramCommands()) {
      expect(c.description.length).toBeGreaterThan(0)
    }
  })

  it('argHint is folded into description for /perms', () => {
    const perms = buildTelegramCommands().find(c => c.command === 'perms')
    expect(perms).toBeDefined()
    expect(perms!.description).toContain('off|prompt|strict')
  })

  it('respects Telegram length limits (32 / 256)', () => {
    for (const c of buildTelegramCommands()) {
      expect(c.command.length).toBeLessThanOrEqual(32)
      expect(c.description.length).toBeLessThanOrEqual(256)
    }
  })

  it('omits TUI-only commands', () => {
    const names = buildTelegramCommands().map(c => c.command)
    expect(names).not.toContain('sync')
    expect(names).not.toContain('model')
    expect(names).not.toContain('jobs')
    expect(names).not.toContain('help')
  })
})
