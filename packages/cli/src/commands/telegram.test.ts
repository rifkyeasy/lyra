import { describe, expect, it } from 'bun:test'
import { parseTelegramArgs } from './telegram'

describe('parseTelegramArgs', () => {
  it('errors on missing subcommand', () => {
    const r = parseTelegramArgs([])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('usage')
  })

  it('errors on unknown subcommand', () => {
    const r = parseTelegramArgs(['nuke'])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('nuke')
  })

  it('parses setup', () => {
    const r = parseTelegramArgs(['setup'])
    expect('error' in r).toBe(false)
    if (!('error' in r)) expect(r.sub).toBe('setup')
  })

  it('parses status', () => {
    const r = parseTelegramArgs(['status'])
    if (!('error' in r)) expect(r.sub).toBe('status')
  })

  it('parses remove without --yes', () => {
    const r = parseTelegramArgs(['remove'])
    if (!('error' in r)) {
      expect(r.sub).toBe('remove')
      expect(r.yes).toBeFalsy()
    }
  })

  it('parses remove --yes', () => {
    const r = parseTelegramArgs(['remove', '--yes'])
    if (!('error' in r)) {
      expect(r.sub).toBe('remove')
      expect(r.yes).toBe(true)
    }
  })

  it('parses remove -y', () => {
    const r = parseTelegramArgs(['remove', '-y'])
    if (!('error' in r)) {
      expect(r.yes).toBe(true)
    }
  })
})
