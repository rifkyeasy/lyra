/**
 * The shared write tail. Every write tool ends the same way: dry-run simulate,
 * then sign + execute + wait for indexing. Centralizing it here removes that
 * duplicated branching (and the cognitive complexity it added) from every handler.
 */
import type { SuiTransactionBlockResponse } from '@mysten/sui/client'
import type { Transaction } from '@mysten/sui/transactions'
import { simulate } from './simulate'
import type { OnchainRuntimeContext } from './types'

/**
 * Sign + execute `tx` through the configured signer. When `ctx.signBytes` is set
 * (remote signer), build the bytes, sign them out-of-process, and submit — so the
 * agent key never enters this process. Otherwise fall back to the local `keypair`.
 * This is the single choke point every write tool goes through, so wiring a remote
 * signer at ctx-build time covers ALL of them (transfer, swap, staking, lending).
 */
export async function submit(
  ctx: OnchainRuntimeContext,
  tx: Transaction,
  // biome-ignore lint/suspicious/noExplicitAny: mirrors @mysten's execute options shape
  options: Record<string, any> = {},
): Promise<SuiTransactionBlockResponse> {
  tx.setSenderIfNotSet(ctx.agentAddress)
  if (ctx.signBytes) {
    const bytes = await tx.build({ client: ctx.client })
    const signature = await ctx.signBytes(bytes)
    return ctx.client.executeTransactionBlock({ transactionBlock: bytes, signature, options })
  }
  if (!ctx.keypair) throw new Error('no signer configured (neither signBytes nor keypair)')
  return ctx.client.signAndExecuteTransaction({ signer: ctx.keypair, transaction: tx, options })
}

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

  const res = await submit(ctx, tx, {
    showEffects: true,
    showObjectChanges: opts.showObjectChanges ?? false,
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
