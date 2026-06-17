import { describe, expect, it } from 'bun:test'
import { resolveAgentName } from './build-runtime'

describe('resolveAgentName', () => {
  const FAKE_AGENT_ID = 'a1b2c3d4e5f6abcd1234567890abcdef'

  it('returns subname when set', () => {
    expect(resolveAgentName('specter', FAKE_AGENT_ID)).toBe('specter')
    expect(resolveAgentName('enigma', FAKE_AGENT_ID)).toBe('enigma')
  })

  it('falls back to slug when null', () => {
    expect(resolveAgentName(null, FAKE_AGENT_ID)).toBe('agent-a1b2c3d4')
  })

  it('falls back to slug when undefined', () => {
    expect(resolveAgentName(undefined, FAKE_AGENT_ID)).toBe('agent-a1b2c3d4')
  })

  it('treats empty/whitespace string as missing', () => {
    expect(resolveAgentName('', FAKE_AGENT_ID)).toBe('agent-a1b2c3d4')
    expect(resolveAgentName('   ', FAKE_AGENT_ID)).toBe('agent-a1b2c3d4')
  })

  it('trims surrounding whitespace from valid subnames', () => {
    expect(resolveAgentName('  specter  ', FAKE_AGENT_ID)).toBe('specter')
  })

  it('uses agentId slice for fallback so slug is stable per agent', () => {
    const id1 = '11111111aaaaaaaa22222222bbbbbbbb'
    const id2 = '22222222ccccccccdddddddd33333333'
    expect(resolveAgentName(null, id1)).toBe('agent-11111111')
    expect(resolveAgentName(null, id2)).toBe('agent-22222222')
  })
})
