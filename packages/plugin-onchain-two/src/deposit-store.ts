/**
 * Pending cross-chain deposit tracking. A deposit spans minutes (source burn →
 * Circle attestation → Sui redeem → vault), so its state is persisted and driven
 * forward by a poller. This module defines the record + a store abstraction, plus
 * an in-memory implementation for dev/tests; a production deployment swaps in a
 * durable store (DB / Walrus) behind the same interface. Every mutation is routed
 * through the {@link DepositLifecycle} state machine, so an illegal transition
 * throws rather than corrupting a transfer mid-flight.
 */

import { type DepositStatus, canTransition, isTerminal } from './deposit-lifecycle'

export interface PendingDeposit {
  /** Stable id (idempotency key) for this deposit. */
  id: string
  /** The Sui owner whose Vault\<USDC\> receives the funds. */
  owner: string
  /** Human-readable source chain, e.g. "Ethereum", "Arbitrum", "Solana". */
  sourceChain: string
  /** Source-chain token symbol/address being deposited. */
  sourceToken: string
  /** Human amount of the source token. */
  amount: string
  /** Source asset ≠ native USDC-on-Sui ⇒ a Sui-side swap runs before the vault. */
  needsSwap: boolean
  status: DepositStatus
  createdMs: number
  updatedMs: number
  // Artifacts, filled in as the deposit progresses (audit + resumability):
  burnTxHash?: string
  attestation?: string
  suiRedeemDigest?: string
  suiSwapDigest?: string
  vaultDepositDigest?: string
  error?: string
}

/** The fields a caller supplies to open a new deposit. */
export interface NewDeposit {
  id: string
  owner: string
  sourceChain: string
  sourceToken: string
  amount: string
  needsSwap: boolean
}

export interface DepositStore {
  create(input: NewDeposit, now?: number): PendingDeposit
  get(id: string): PendingDeposit | null
  listByOwner(owner: string): PendingDeposit[]
  /** List every non-terminal deposit — the work-list a poller drives forward. */
  listActive(): PendingDeposit[]
  /** Move a deposit to `status`, merging `patch`; throws on an illegal transition. */
  transition(
    id: string,
    status: DepositStatus,
    patch?: Partial<PendingDeposit>,
    now?: number,
  ): PendingDeposit
  /** Terminal-fail a deposit with a reason (legal from any non-terminal state). */
  fail(id: string, error: string, now?: number): PendingDeposit
}

export class InMemoryDepositStore implements DepositStore {
  private readonly byId = new Map<string, PendingDeposit>()

  create(input: NewDeposit, now = Date.now()): PendingDeposit {
    if (this.byId.has(input.id)) throw new Error(`deposit ${input.id} already exists`)
    const deposit: PendingDeposit = {
      ...input,
      status: 'initiated',
      createdMs: now,
      updatedMs: now,
    }
    this.byId.set(input.id, deposit)
    return { ...deposit }
  }

  get(id: string): PendingDeposit | null {
    const d = this.byId.get(id)
    return d ? { ...d } : null
  }

  listByOwner(owner: string): PendingDeposit[] {
    return [...this.byId.values()].filter(d => d.owner === owner).map(d => ({ ...d }))
  }

  listActive(): PendingDeposit[] {
    return [...this.byId.values()].filter(d => !isTerminal(d.status)).map(d => ({ ...d }))
  }

  transition(
    id: string,
    status: DepositStatus,
    patch: Partial<PendingDeposit> = {},
    now = Date.now(),
  ): PendingDeposit {
    const current = this.byId.get(id)
    if (!current) throw new Error(`deposit ${id} not found`)
    if (!canTransition(current.status, status)) {
      throw new Error(`illegal deposit transition ${current.status} → ${status} (${id})`)
    }
    // Never let a patch silently rewrite identity/routing fields.
    const { id: _i, owner: _o, createdMs: _c, ...safe } = patch
    const updated: PendingDeposit = { ...current, ...safe, status, updatedMs: now }
    this.byId.set(id, updated)
    return { ...updated }
  }

  fail(id: string, error: string, now = Date.now()): PendingDeposit {
    return this.transition(id, 'failed', { error }, now)
  }
}
