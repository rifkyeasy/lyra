import { describe, expect, it } from 'bun:test'
import { shortAddr } from './format'

describe('shortAddr', () => {
  it('returns ? for missing input', () => {
    expect(shortAddr(undefined)).toBe('?')
    expect(shortAddr('')).toBe('?')
  })
  it('passes through short / non-0x values unchanged', () => {
    expect(shortAddr('alice.0g')).toBe('alice.0g')
    expect(shortAddr('0xabc')).toBe('0xabc')
  })
  it('truncates a 0x EVM address to first 6 + last 4', () => {
    expect(shortAddr('0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec')).toBe('0xC635…87Ec')
  })
})
