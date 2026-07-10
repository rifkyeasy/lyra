/**
 * Vault-funded actions. Lyra's treasury `lyra::vault::Vault<SUI>` is the SINGLE
 * fund source for agent actions: instead of splitting the agent's own gas coin,
 * a write tool draws SUI from the owner's vault via the policy-gated `vault_spend`
 * (the agent signs; `enforce_spend` re-checks budget, per-tx cap, coin/protocol
 * allowlists, expiry, and revoke ON-CHAIN). Idle funds stay in the vault, and the
 * treasury is topped back up on withdrawal (Option 1: funds cycle vault→protocol→
 * vault, so the treasury doesn't drain as the agent works).
 *
 * All helpers degrade gracefully: with no vault configured in the runtime ctx,
 * `fundSui` falls back to the agent's gas coin — so single-key mode (e.g. the CLI
 * with no provisioned vault) keeps working unchanged.
 */

import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions'
import type { OnchainRuntimeContext } from './types'

const SUI_TYPE = '0x2::sui::SUI'
const CLOCK = '0x6'

/** True when the ctx carries a fully-wired treasury vault (vault + policy + package). */
export function hasVault(ctx: OnchainRuntimeContext): boolean {
  return Boolean(ctx.vaultId && ctx.policyObjectId && ctx.packageId)
}

/**
 * True when the wired vault can cover `amountMist` (per its balance snapshot).
 * When false, callers fund from the agent's own SUI so the action still works —
 * e.g. the user provisioned a vault but funded the agent directly, or the vault
 * is short for this action. The on-chain `vault_spend` remains the hard gate.
 */
export function canFundFromVault(ctx: OnchainRuntimeContext, amountMist: bigint): boolean {
  if (!hasVault(ctx)) return false
  return BigInt(ctx.vaultMist ?? '0') >= amountMist
}

function enc(tx: Transaction, s: string) {
  return tx.pure.vector('u8', Array.from(new TextEncoder().encode(s)))
}

export interface FundOpts {
  /**
   * Protocol package/registry id checked against the policy's protocol allowlist.
   * Pass the protocol's package id (e.g. NAVI, Scallop) so an owner-set allowlist
   * gates it meaningfully; `0x0` when the action isn't protocol-scoped (a plain
   * transfer). Defaults to `0x0`.
   */
  protocol?: string
  /** Short action kind for the on-chain receipt (e.g. `stake`, `supply`, `swap`). */
  kind: string
  /** Human memo for the on-chain receipt. */
  memo: string
}

/**
 * Source `amountMist` of SUI for an in-PTB action. When a vault is wired, draws
 * from it via `vault_spend` (policy-enforced) and routes the audit `ActionReceipt`
 * to the owner; otherwise splits the agent's gas coin. Returns the `Coin<SUI>` to
 * feed into the protocol call in the SAME transaction.
 */
export function fundSui(
  tx: Transaction,
  ctx: OnchainRuntimeContext,
  amountMist: bigint,
  opts: FundOpts,
): TransactionObjectArgument {
  if (canFundFromVault(ctx, amountMist)) {
    const [coin, receipt] = tx.moveCall({
      target: `${ctx.packageId}::vault::vault_spend`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(ctx.vaultId as string),
        tx.object(ctx.policyObjectId as string),
        tx.pure.u64(amountMist),
        tx.pure.address(opts.protocol ?? '0x0'),
        enc(tx, opts.kind),
        enc(tx, opts.memo),
        tx.object(CLOCK),
      ],
    })
    // The receipt is an on-chain audit object (key+store); park it with the owner
    // (or the agent when the owner is unknown) so the PTB has no dangling value.
    tx.transferObjects([receipt as TransactionObjectArgument], ctx.ownerAddress ?? ctx.agentAddress)
    return coin as TransactionObjectArgument
  }
  const [coin] = tx.splitCoins(tx.gas, [amountMist])
  return coin as TransactionObjectArgument
}

/**
 * Return a `Coin<SUI>` to the treasury vault (Option 1: withdrawals/unstakes cycle
 * back into the vault instead of accumulating on the agent). No-op-returns `false`
 * when no vault is wired, so the caller can transfer the coin to the agent instead.
 */
export function returnSuiToVault(
  tx: Transaction,
  ctx: OnchainRuntimeContext,
  coin: TransactionObjectArgument,
): boolean {
  if (!ctx.vaultId || !ctx.packageId) return false
  tx.moveCall({
    target: `${ctx.packageId}::vault::deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [tx.object(ctx.vaultId), coin],
  })
  return true
}
