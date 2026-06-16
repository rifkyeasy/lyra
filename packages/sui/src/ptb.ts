import type { SuiClient, SuiTransactionBlockResponse } from '@mysten/sui/client'
import type { Signer } from '@mysten/sui/cryptography'
import { Transaction } from '@mysten/sui/transactions'
import { CLOCK_ID } from './config'

/**
 * PTB builders for the `lyra::policy` Move module, plus simulate/execute
 * helpers. Every value-moving builder routes through the on-chain guard
 * (`withdraw`), so the budget/cap/expiry/scope checks are atomic with the
 * action they fund.
 */

export interface CreatePolicyArgs {
  packageId: string
  coinType: string
  agent: string
  budgetMist: bigint
  maxPerTxMist: bigint
  maxSlippageBps: number
  allowedProtocols: string[]
  /** Absolute unix-ms expiry; 0 = no expiry. */
  expiryMs: number
}

/** Split the budget from gas, create the policy, share it, hand the cap to the agent. */
export function buildCreatePolicy(tx: Transaction, a: CreatePolicyArgs): void {
  const [budget] = tx.splitCoins(tx.gas, [tx.pure.u64(a.budgetMist)])
  tx.moveCall({
    target: `${a.packageId}::policy::create`,
    typeArguments: [a.coinType],
    arguments: [
      tx.pure.address(a.agent),
      tx.pure.u64(a.maxPerTxMist),
      tx.pure.u64(BigInt(a.maxSlippageBps)),
      tx.pure.vector('string', a.allowedProtocols),
      tx.pure.u64(BigInt(a.expiryMs)),
      budget,
    ],
  })
}

export interface WithdrawTransferArgs {
  packageId: string
  coinType: string
  policyId: string
  capId: string
  amountMist: bigint
  protocol: string
  recipient: string
}

/** Guarded spend: withdraw within policy, then transfer the coin — atomically. */
export function buildWithdrawTransfer(tx: Transaction, a: WithdrawTransferArgs): void {
  const coin = buildWithdraw(tx, a)
  tx.transferObjects([coin], tx.pure.address(a.recipient))
}

/**
 * Just the guarded withdraw; returns the moveCall result, which represents the
 * single returned `Coin<T>` and can be passed directly to a later command.
 */
export function buildWithdraw(tx: Transaction, a: Omit<WithdrawTransferArgs, 'recipient'>) {
  return tx.moveCall({
    target: `${a.packageId}::policy::withdraw`,
    typeArguments: [a.coinType],
    arguments: [
      tx.object(a.policyId),
      tx.object(a.capId),
      tx.pure.u64(a.amountMist),
      tx.pure.string(a.protocol),
      tx.object(CLOCK_ID),
    ],
  })
}

export interface RecordArgs {
  packageId: string
  coinType: string
  policyId: string
  capId: string
  protocol: string
  summary: string
  amountMist: bigint
  coinTypeStr: string
  status: string
  walrusBlob: string
}

/** Append an immutable on-chain ActionReceipt linked to its Walrus artifact. */
export function buildRecord(tx: Transaction, a: RecordArgs): void {
  tx.moveCall({
    target: `${a.packageId}::policy::record`,
    typeArguments: [a.coinType],
    arguments: [
      tx.object(a.policyId),
      tx.object(a.capId),
      tx.pure.string(a.protocol),
      tx.pure.string(a.summary),
      tx.pure.u64(a.amountMist),
      tx.pure.string(a.coinTypeStr),
      tx.pure.string(a.status),
      tx.pure.string(a.walrusBlob),
      tx.object(CLOCK_ID),
    ],
  })
}

export interface RevokeArgs {
  packageId: string
  coinType: string
  policyId: string
}

export function buildRevoke(tx: Transaction, a: RevokeArgs): void {
  tx.moveCall({
    target: `${a.packageId}::policy::revoke`,
    typeArguments: [a.coinType],
    arguments: [tx.object(a.policyId)],
  })
}

export interface ReclaimArgs {
  packageId: string
  coinType: string
  policyId: string
}

/** Owner reclaims the entire remaining budget back to their address. */
export function buildReclaim(tx: Transaction, a: ReclaimArgs): void {
  tx.moveCall({
    target: `${a.packageId}::policy::reclaim_all`,
    typeArguments: [a.coinType],
    arguments: [tx.object(a.policyId)],
  })
}

// === Simulation & execution ===

export interface DryRunResult {
  ok: boolean
  error?: string
}

/** Dry-run a PTB with no gas spent. Used to PROVE a blocked action aborts. */
export async function dryRun(
  client: SuiClient,
  tx: Transaction,
  sender: string,
): Promise<DryRunResult> {
  const r = await client.devInspectTransactionBlock({ sender, transactionBlock: tx })
  const status = r.effects?.status?.status
  return { ok: status === 'success', error: r.effects?.status?.error ?? undefined }
}

/** Sign, execute, and wait for indexing. Returns the full response. */
export async function execute(
  client: SuiClient,
  signer: Signer,
  tx: Transaction,
): Promise<SuiTransactionBlockResponse> {
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  })
  await client.waitForTransaction({ digest: res.digest })
  return res
}

/** First created object whose type contains `typeSubstr` (e.g. "::policy::AgentCap"). */
export function createdObjectByType(
  res: SuiTransactionBlockResponse,
  typeSubstr: string,
): string | undefined {
  for (const c of res.objectChanges ?? []) {
    if (c.type === 'created' && 'objectType' in c && c.objectType.includes(typeSubstr)) {
      return c.objectId
    }
  }
  return undefined
}
