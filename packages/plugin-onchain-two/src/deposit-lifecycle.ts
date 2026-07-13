/**
 * The deposit lifecycle — the orchestration "brain" for a cross-chain deposit
 * (any token, any chain → USDC in the owner's Sui vault), per the DESIGN spec.
 *
 * This module is PURE + storage-agnostic + chain-agnostic: it owns the state
 * machine (which transitions are legal) and the decision of what to do next given
 * a transfer's state. The actual chain calls (source burn, Circle attestation, Sui
 * redeem, swap, vault deposit) are performed elsewhere and only ever report their
 * result back as a transition — so the risky cross-chain integration is decoupled
 * from, and testable independently of, this control flow.
 *
 * Happy path (native-USDC source):
 *   initiated → source_burned → attested → sui_redeemed → vault_deposited
 * Long-tail source token (needs a Sui-side swap to USDC before the vault):
 *   … → sui_redeemed → swapped_to_usdc → vault_deposited
 * Any non-terminal state can fail.
 */

export type DepositStatus =
  | 'initiated' // intent created; awaiting the user's source-chain burn/lock
  | 'source_burned' // burn seen on the source chain; awaiting Circle attestation
  | 'attested' // attestation ready; ready to redeem on Sui
  | 'sui_redeemed' // USDC (or wrapped X) minted on Sui, in the agent's custody
  | 'swapped_to_usdc' // long-tail X swapped to USDC on Sui
  | 'vault_deposited' // USDC deposited into the owner's Vault<USDC> — COMPLETE
  | 'failed'

export type DepositAction =
  | 'await_source_burn' // waiting on the user to burn/lock on the source chain
  | 'await_attestation' // poll Circle for the CCTP attestation
  | 'submit_sui_redeem' // redeem the attestation on Sui (mint USDC)
  | 'swap_to_usdc' // swap the redeemed long-tail asset to USDC on Sui
  | 'deposit_to_vault' // deposit the USDC into the owner's Vault<USDC>
  | 'none' // terminal (complete or failed) — nothing to do

/** Legal forward transitions out of each state (`failed` is reachable from any
 *  non-terminal state and is handled separately by {@link canTransition}). */
const NEXT: Record<DepositStatus, DepositStatus[]> = {
  initiated: ['source_burned'],
  source_burned: ['attested'],
  attested: ['sui_redeemed'],
  sui_redeemed: ['swapped_to_usdc', 'vault_deposited'],
  swapped_to_usdc: ['vault_deposited'],
  vault_deposited: [],
  failed: [],
}

/** A state with no outgoing transitions — `vault_deposited` (done) or `failed`. */
export function isTerminal(status: DepositStatus): boolean {
  return NEXT[status].length === 0
}

/** Whether moving `from → to` is a legal transition. Any non-terminal state may
 *  move to `failed`; otherwise `to` must be an allowed forward step. */
export function canTransition(from: DepositStatus, to: DepositStatus): boolean {
  if (to === 'failed') return !isTerminal(from)
  return NEXT[from].includes(to)
}

/** The next off-chain/on-chain action to drive `status` forward (given whether the
 *  source asset needs a Sui-side swap to USDC after redeem). */
export function nextAction(status: DepositStatus, needsSwap: boolean): DepositAction {
  switch (status) {
    case 'initiated':
      return 'await_source_burn'
    case 'source_burned':
      return 'await_attestation'
    case 'attested':
      return 'submit_sui_redeem'
    case 'sui_redeemed':
      return needsSwap ? 'swap_to_usdc' : 'deposit_to_vault'
    case 'swapped_to_usdc':
      return 'deposit_to_vault'
    default:
      return 'none' // vault_deposited | failed
  }
}
