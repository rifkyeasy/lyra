/**
 * Simulate-before-write guard.
 *
 * Lyra's core safety rule (project thesis): every state-changing transaction is
 * dry-run against the live chain BEFORE it is broadcast, so Move aborts and
 * insufficient-funds are caught pre-flight and surfaced to the operator instead
 * of burning gas on a doomed tx. Read-only — no transaction is sent here.
 */

import type { SuiClient } from '@mysten/sui/client'
import type { Transaction } from '@mysten/sui/transactions'

export interface SimOk {
  ok: true
  /** Net gas the (validated) transaction would cost, in MIST. */
  gasUsed: string
}
export interface SimFail {
  ok: false
  /** Decoded Move abort / node error (truncated). */
  reason: string
}
export type SimResult = SimOk | SimFail

/** Net gas = computation + storage − rebate, as a MIST string. */
function netGas(gas: {
  computationCost: string
  storageCost: string
  storageRebate: string
}): string {
  return (
    BigInt(gas.computationCost) +
    BigInt(gas.storageCost) -
    BigInt(gas.storageRebate)
  ).toString()
}

/**
 * Dry-run a PTB. `dryRunTransactionBlock` executes the block at the node
 * (no broadcast), so Move aborts, type errors, and funding shortfalls surface
 * here. Returns the decoded failure reason or the net gas estimate.
 */
export async function simulate(
  client: SuiClient,
  tx: Transaction,
  sender: string,
): Promise<SimResult> {
  try {
    tx.setSenderIfNotSet(sender)
    const bytes = await tx.build({ client })
    const res = await client.dryRunTransactionBlock({ transactionBlock: bytes })
    const status = res.effects.status
    if (status.status !== 'success') {
      return { ok: false, reason: status.error ?? 'transaction would fail' }
    }
    return { ok: true, gasUsed: netGas(res.effects.gasUsed) }
  } catch (e) {
    return { ok: false, reason: (e as Error).message?.slice(0, 240) ?? 'unknown simulation error' }
  }
}
