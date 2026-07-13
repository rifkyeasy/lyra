/**
 * Vault-funded actions. Lyra's treasury `lyra::vault::Vault<SUI>` is the fund
 * source for agent actions. Model B draw paths (see the Move contract):
 *   - Named-protocol actions (staking/lending, whose output is a StakedSui/position,
 *     NOT a coin that can return to the vault) draw via `vault_spend_capped` — a
 *     window-bounded raw draw, gated by the protocol allowlist. The agent signs;
 *     `enforce_spend` re-checks per-tx cap, rolling window + lifetime budget,
 *     coin/protocol allowlists, expiry, and revoke ON-CHAIN.
 *   - Swaps (coin→coin) should instead use `vault_borrow`/`vault_settle` so the
 *     output returns to a `Vault<outputAsset>` (zero standing exposure). That needs
 *     multi-asset vault provisioning; until it lands, swaps fund from the agent's
 *     own SUI (bounded by the agent balance + the off-chain policy).
 *   - Sends use `vault_transfer` directly (recipient-checked) — not this helper.
 * Withdrawals/unstakes cycle proceeds back into the vault via `returnSuiToVault`,
 * so the treasury doesn't drain as the agent works.
 *
 * All helpers degrade gracefully: with no vault wired, `fundSui` falls back to the
 * agent's gas coin — single-key mode (CLI without a provisioned vault) is unchanged.
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
 * is short for this action. The on-chain `enforce_spend` (inside `vault_spend_capped`)
 * remains the hard gate.
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

/** True when `protocol` is a real (named) protocol id, not the `0x0` sentinel. */
function isNamedProtocol(protocol: string | undefined): boolean {
  if (!protocol) return false
  try {
    return BigInt(protocol) !== 0n
  } catch {
    return false
  }
}

/**
 * Source `amountMist` of SUI for an in-PTB action, returning the `Coin<SUI>` to
 * feed into the protocol call in the SAME transaction.
 *
 * Named-protocol actions (staking/lending) with a wired, funded vault draw via
 * `vault_spend_capped` (window-bounded, policy-enforced; the audit receipt is
 * routed to the owner inside the Move call). Swaps (no named protocol) and the
 * no-vault case fund from the agent's own SUI.
 */
export function fundSui(
  tx: Transaction,
  ctx: OnchainRuntimeContext,
  amountMist: bigint,
  opts: FundOpts,
): TransactionObjectArgument {
  if (canFundFromVault(ctx, amountMist) && isNamedProtocol(opts.protocol)) {
    const [coin] = tx.moveCall({
      target: `${ctx.packageId}::vault::vault_spend_capped`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(ctx.vaultId as string),
        tx.object(ctx.policyObjectId as string),
        tx.pure.u64(amountMist),
        tx.pure.address(opts.protocol as string),
        enc(tx, opts.kind),
        enc(tx, opts.memo),
        tx.object(CLOCK),
      ],
    })
    return coin as TransactionObjectArgument
  }
  // Swap / no-vault: fund from the agent's own SUI. (Swap → vault_borrow/settle
  // into a Vault<outputAsset> is the tracked multi-asset enhancement.)
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
  if (!(ctx.vaultId && ctx.packageId)) return false
  tx.moveCall({
    target: `${ctx.packageId}::vault::deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [tx.object(ctx.vaultId), coin],
  })
  return true
}
