import { describe, expect, it } from 'bun:test'
import { buildSessionKey, sanitizeAgentName } from './session-key'

describe('buildSessionKey', () => {
  it('DM key for vanilla agent name + chat id', () => {
    expect(buildSessionKey({ agentName: 'specter', chatId: 12345 })).toBe(
      'agent:specter:telegram:dm:12345',
    )
  })
  it('group key with thread id', () => {
    expect(
      buildSessionKey({ agentName: 'enigma', chatId: -100123, threadId: 7, isGroup: true }),
    ).toBe('agent:enigma:telegram:group:-100123:7')
  })
  it('group key without thread id falls back to thread 0', () => {
    expect(buildSessionKey({ agentName: 'enigma', chatId: -100123, isGroup: true })).toBe(
      'agent:enigma:telegram:group:-100123:0',
    )
  })
  it('agent name is sanitized', () => {
    expect(buildSessionKey({ agentName: 'Spec/t.er!', chatId: 1 })).toBe(
      'agent:specter:telegram:dm:1',
    )
  })
  it('empty agent name falls back to lyra', () => {
    expect(buildSessionKey({ agentName: '   ', chatId: 1 })).toBe('agent:lyra:telegram:dm:1')
  })
})

describe('sanitizeAgentName', () => {
  it('lowercases', () => {
    expect(sanitizeAgentName('SPECTER')).toBe('specter')
  })
  it('strips special chars', () => {
    expect(sanitizeAgentName('foo.bar/baz!')).toBe('foobarbaz')
  })
  it('preserves hyphens', () => {
    expect(sanitizeAgentName('foo-bar')).toBe('foo-bar')
  })
})
