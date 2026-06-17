import { describe, expect, it } from 'bun:test'
import { parsePairingArgs } from './pairing'

describe('parsePairingArgs', () => {
  it('errors on no args', () => {
    const r = parsePairingArgs([])
    expect('error' in r).toBe(true)
  })

  it('errors on unknown subcommand', () => {
    const r = parsePairingArgs(['quack'])
    expect('error' in r).toBe(true)
  })

  it('parses `list`', () => {
    const r = parsePairingArgs(['list']) as Exclude<
      ReturnType<typeof parsePairingArgs>,
      { error: string }
    >
    expect(r.sub).toBe('list')
  })

  it('parses `list telegram` with platform filter', () => {
    const r = parsePairingArgs(['list', 'telegram']) as Exclude<
      ReturnType<typeof parsePairingArgs>,
      { error: string }
    >
    expect(r.sub).toBe('list')
    expect(r.platform).toBe('telegram')
  })

  it('parses `approve telegram ABCDEFGH`', () => {
    const r = parsePairingArgs(['approve', 'telegram', 'ABCDEFGH']) as Exclude<
      ReturnType<typeof parsePairingArgs>,
      { error: string }
    >
    expect(r.sub).toBe('approve')
    expect(r.platform).toBe('telegram')
    expect(r.code).toBe('ABCDEFGH')
  })

  it('errors on `approve` without arguments', () => {
    const r = parsePairingArgs(['approve'])
    expect('error' in r).toBe(true)
  })

  it('errors on `approve telegram` without code', () => {
    const r = parsePairingArgs(['approve', 'telegram'])
    expect('error' in r).toBe(true)
  })

  it('parses `revoke telegram 12345`', () => {
    const r = parsePairingArgs(['revoke', 'telegram', '12345']) as Exclude<
      ReturnType<typeof parsePairingArgs>,
      { error: string }
    >
    expect(r.sub).toBe('revoke')
    expect(r.platform).toBe('telegram')
    expect(r.userId).toBe('12345')
  })

  it('parses `clear-pending` and `clear-pending telegram`', () => {
    const a = parsePairingArgs(['clear-pending']) as Exclude<
      ReturnType<typeof parsePairingArgs>,
      { error: string }
    >
    expect(a.sub).toBe('clear-pending')
    expect(a.platform).toBeUndefined()
    const b = parsePairingArgs(['clear-pending', 'telegram']) as Exclude<
      ReturnType<typeof parsePairingArgs>,
      { error: string }
    >
    expect(b.platform).toBe('telegram')
  })

  it('extracts --yes / -y flag', () => {
    const r = parsePairingArgs(['revoke', 'telegram', '12345', '--yes']) as Exclude<
      ReturnType<typeof parsePairingArgs>,
      { error: string }
    >
    expect(r.yes).toBe(true)
    const s = parsePairingArgs(['clear-pending', '-y']) as Exclude<
      ReturnType<typeof parsePairingArgs>,
      { error: string }
    >
    expect(s.yes).toBe(true)
  })
})
