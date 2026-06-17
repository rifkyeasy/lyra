import { describe, expect, test } from 'bun:test'
import { generateBootstrapKeypair } from 'lyra-core'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'
import type { RuntimeConfig } from './runtime'
import {
  GATEWAY_VERSION,
  createSession,
  transitionToProvisioned,
  transitionToReady,
  transitionToShuttingDown,
} from './state'
import { StubRuntime } from './stub-runtime'

import type { Address } from './operator-sig'

const FAKE_OPERATOR = `0x${'cc'.repeat(32)}` as Address
// Sui addresses are 32-byte 0x-hex.
const FAKE_AGENT = `0x${'11'.repeat(32)}`
const FAKE_SECRET = Buffer.alloc(32, 7).toString('base64')

const FAKE_CONFIG: RuntimeConfig = {
  network: 'mainnet',
  brain: { provider: 'openai', model: 'gpt-4o-mini' },
  identity: {
    agent: FAKE_AGENT,
  },
}

function newSession() {
  const events = new EventHub()
  return createSession({
    bootstrap: generateBootstrapKeypair(),
    expectedOperatorAddress: FAKE_OPERATOR,
    sandboxId: 'sbx-test',
    events,
    approvals: new ApprovalRelay(events),
    runtime: new StubRuntime(),
  })
}

describe('state machine', () => {
  test('createSession → Bootstrapping with timestamps', () => {
    const s = newSession()
    expect(s.state).toBe('Bootstrapping')
    expect(s.version).toBe(GATEWAY_VERSION)
    expect(s.sandboxId).toBe('sbx-test')
    expect(s.bootedAt).toBeGreaterThan(0)
    expect(s.provisionedAt).toBeNull()
    expect(s.readyAt).toBeNull()
    expect(s.agentSecret).toBeNull()
    expect(s.agentAddress).toBeNull()
    expect(s.config).toBeNull()
  })

  test('Bootstrapping → Provisioned populates fields + emits state-change', () => {
    const s = newSession()
    transitionToProvisioned(s, {
      agentSecret: FAKE_SECRET,
      agentAddress: FAKE_AGENT,
      operatorAddress: FAKE_OPERATOR,
      config: FAKE_CONFIG,
    })
    expect(s.state).toBe('Provisioned')
    expect(s.agentAddress).toBe(FAKE_AGENT)
    expect(s.operatorAddress).toBe(FAKE_OPERATOR)
    expect(s.config?.network).toBe('mainnet')
    expect(s.provisionedAt).toBeGreaterThan(0)
    const events = s.events.buffer()
    expect(events.some(e => e.kind === 'state-change')).toBe(true)
  })

  test('Provisioned → Ready captures readyAt', () => {
    const s = newSession()
    transitionToProvisioned(s, {
      agentSecret: FAKE_SECRET,
      agentAddress: FAKE_AGENT,
      operatorAddress: FAKE_OPERATOR,
      config: FAKE_CONFIG,
    })
    transitionToReady(s)
    expect(s.state).toBe('Ready')
    expect(s.readyAt).toBeGreaterThan(0)
  })

  test('cannot transition to Provisioned twice', () => {
    const s = newSession()
    const inputs = {
      agentSecret: FAKE_SECRET,
      agentAddress: FAKE_AGENT,
      operatorAddress: FAKE_OPERATOR,
      config: FAKE_CONFIG,
    }
    transitionToProvisioned(s, inputs)
    expect(() => transitionToProvisioned(s, inputs)).toThrow(/cannot transition to Provisioned/)
  })

  test('cannot transition to Ready from Bootstrapping', () => {
    const s = newSession()
    expect(() => transitionToReady(s)).toThrow(/cannot transition to Ready/)
  })

  test('shutdown is reachable from any state', () => {
    const s = newSession()
    transitionToShuttingDown(s)
    expect(s.state).toBe('ShuttingDown')
  })
})
