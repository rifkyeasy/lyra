/**
 * The shared write tail. Every write tool ends the same way: dry-run simulate,
 * then sign + execute + wait for indexing. Centralizing it here removes that
 * duplicated branching (and the cognitive complexity it added) from every handler.
 */
import type { Transaction } from '@mysten/sui/transactions'
import { simulate } from './simulate'
import type { OnchainRuntimeContext } from './types'

export interface ExecOk {
  digest: string
  gasUsed?: string
  objectChanges?: unknown[]
}

export type ExecResult = { ok: true; value: ExecOk } | { ok: false; error: string }

/**
 * Simulate `tx`, then (on a clean sim) sign + execute + wait. Returns the digest
 * (+ objectChanges when `showObjectChanges`) on success, or a mapped error string
 * on any failure — so callers just do `if (!r.ok) return r`.
 */
export async function simulateAndExecute(
  ctx: OnchainRuntimeContext,
  tx: Transaction,
  opts: { showObjectChanges?: boolean } = {},
): Promise<ExecResult> {
  const sim = await simulate(ctx.client, tx, ctx.agentAddress)
  if (!sim.ok) return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }

  const res = await ctx.client.signAndExecuteTransaction({
    signer: ctx.keypair,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: opts.showObjectChanges ?? false },
  })
  if (res.effects?.status?.status !== 'success') {
    return { ok: false, error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}` }
  }
  await ctx.client.waitForTransaction({ digest: res.digest })
  return {
    ok: true,
    value: {
      digest: res.digest,
      gasUsed: sim.gasUsed,
      objectChanges: res.objectChanges ?? undefined,
    },
  }
}
