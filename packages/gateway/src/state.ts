import pkg from '../package.json' with { type: 'json' }
import type { ApprovalRelay } from './approval-relay'
import type { EventHub } from './events'
import type { Address, Hex } from './operator-sig'
import type { RuntimeAdapter, RuntimeConfig } from './runtime'

// Derived from package.json so /healthz always reports the version that's
// actually running. Kept as a const so existing consumers (tests, server.ts)
// don't need to change. The JSON import attribute is supported by bun + tsc
// (TypeScript 5+) and produces a synchronous, type-safe import.
export const GATEWAY_VERSION: string = (pkg as { version: string }).version

export type GatewayState = 'Bootstrapping' | 'Provisioned' | 'Ready' | 'ShuttingDown'

export interface GatewaySession {
  state: GatewayState
  version: string
  sandboxId: string
  bootedAt: number
  provisionedAt: number | null
  readyAt: number | null

  bootstrap: {
    privkeyHex: Hex
    pubkeyHexCompressed: Hex
    pubkeyHexUncompressed: Hex
  }

  expectedOperatorAddress: Address

  /** Agent's Sui secret key (`suiprivkey1...` or base64 seed). */
  agentSecret: string | null
  /** Agent's Sui address (`keypair.toSuiAddress()`). */
  agentAddress: string | null
  operatorAddress: Address | null
  config: RuntimeConfig | null

  events: EventHub
  approvals: ApprovalRelay
  runtime: RuntimeAdapter
}

export interface CreateSessionOpts {
  bootstrap: GatewaySession['bootstrap']
  expectedOperatorAddress: Address
  sandboxId: string
  events: EventHub
  approvals: ApprovalRelay
  runtime: RuntimeAdapter
  version?: string
}

export function createSession(opts: CreateSessionOpts): GatewaySession {
  return {
    state: 'Bootstrapping',
    version: opts.version ?? GATEWAY_VERSION,
    sandboxId: opts.sandboxId,
    bootedAt: Date.now(),
    provisionedAt: null,
    readyAt: null,
    bootstrap: opts.bootstrap,
    expectedOperatorAddress: opts.expectedOperatorAddress,
    agentSecret: null,
    agentAddress: null,
    operatorAddress: null,
    config: null,
    events: opts.events,
    approvals: opts.approvals,
    runtime: opts.runtime,
  }
}

export interface ProvisionInputs {
  /** Agent's Sui secret key (`suiprivkey1...` or base64 seed). */
  agentSecret: string
  /** Agent's Sui address. */
  agentAddress: string
  operatorAddress: Address
  config: RuntimeConfig
}

export function transitionToProvisioned(session: GatewaySession, inputs: ProvisionInputs): void {
  if (session.state !== 'Bootstrapping') {
    throw new Error(`cannot transition to Provisioned from state=${session.state}`)
  }
  session.agentSecret = inputs.agentSecret
  session.agentAddress = inputs.agentAddress
  session.operatorAddress = inputs.operatorAddress
  session.config = inputs.config
  session.provisionedAt = Date.now()
  session.state = 'Provisioned'
  session.events.publish('state-change', { state: 'Provisioned' })
}

export function transitionToReady(session: GatewaySession): void {
  if (session.state !== 'Provisioned') {
    throw new Error(`cannot transition to Ready from state=${session.state}`)
  }
  session.readyAt = Date.now()
  session.state = 'Ready'
  session.events.publish('state-change', { state: 'Ready' })
}

export function transitionToShuttingDown(session: GatewaySession): void {
  session.state = 'ShuttingDown'
  session.events.publish('state-change', { state: 'ShuttingDown' })
}
