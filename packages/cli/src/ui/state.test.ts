import { describe, expect, it } from 'bun:test'
import { createChatState } from './state'

describe('createChatState — v0.24.4 isLocalGateway', () => {
  it('exposes isLocalGateway=true when the local-gateway flag is passed', () => {
    const state = createChatState({
      initialSystem: 'connected to local gateway (~/.nebula/agents/abcd1234/gateway.sock)',
      identityLabel: 'agent specter  0xabc',
      approvalsMode: 'prompt',
      isLocalGateway: true,
    })
    expect(state.isLocalGateway).toBe(true)
  })

  it('defaults isLocalGateway=false when omitted (sandbox path)', () => {
    const state = createChatState({
      initialSystem: 'connected to sandbox 12345678 @ https://sandbox.example',
      identityLabel: 'agent enigma  0xdef',
      approvalsMode: 'prompt',
    })
    expect(state.isLocalGateway).toBe(false)
  })

  it('treats explicit isLocalGateway=false as sandbox mode', () => {
    const state = createChatState({
      initialSystem: 'connected to sandbox 12345678 @ https://sandbox.example',
      identityLabel: 'agent enigma  0xdef',
      approvalsMode: 'off',
      isLocalGateway: false,
    })
    expect(state.isLocalGateway).toBe(false)
  })

  it('keeps sandboxBalance() null at construction so the statusbar Show gate hides the segment until setSandboxBalance fires', () => {
    const localState = createChatState({
      initialSystem: 'connected to local gateway',
      identityLabel: 'agent specter  0xabc',
      approvalsMode: 'off',
      isLocalGateway: true,
    })
    // v0.24.4: chat-sandbox.tsx skips setSandboxBalance entirely for local
    // gateway deploys. Re-affirm the default so any future setter regression
    // surfaces here.
    expect(localState.sandboxBalance()).toBeNull()
  })

  it('seeds the initial system row from initialSystem (local-gateway label form)', () => {
    const state = createChatState({
      initialSystem: 'connected to local gateway (~/.nebula/agents/abcd1234/gateway.sock)',
      identityLabel: 'agent specter  0xabc',
      approvalsMode: 'prompt',
      isLocalGateway: true,
    })
    const first = state.rows()[0]
    expect(first).toBeDefined()
    if (!first) throw new Error('rows()[0] missing')
    expect(first.role).toBe('system')
    expect(first.text).toContain('local gateway')
    expect(first.text).not.toContain('sandbox')
  })

  it('seeds the initial system row from initialSystem (sandbox label form)', () => {
    const state = createChatState({
      initialSystem: 'connected to sandbox 12345678 @ https://sandbox.example',
      identityLabel: 'agent enigma  0xdef',
      approvalsMode: 'prompt',
    })
    const first = state.rows()[0]
    expect(first).toBeDefined()
    if (!first) throw new Error('rows()[0] missing')
    expect(first.role).toBe('system')
    expect(first.text).toContain('sandbox 12345678')
  })
})
