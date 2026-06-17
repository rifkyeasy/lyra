/// Lyra — non-custodial treasury vault.
///
/// The upgrade that makes Lyra production-grade. User funds live in an on-chain
/// `Vault`, NOT in the agent's EOA. The delegated agent can only draw funds via
/// `vault_spend`, which re-runs the full `lyra::policy` gate on-chain (agent
/// identity, budget, per-tx cap, coin/protocol allowlists, expiry, revoke). So a
/// compromised agent key — or even a leaked server signing key — is bounded by the
/// policy and revocable by the owner, who can also pull the whole treasury back at
/// any time with `owner_withdraw`. The platform never has unbounded access to
/// user funds; the agent is a delegate, not a custodian.
module lyra::vault;

use lyra::policy::{Self, AgentPolicy, PolicyOwnerCap, ActionReceipt};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

// === Errors ===

const EWrongVault: u64 = 0;
const EInsufficientVault: u64 = 1;
const ENotVaultOwner: u64 = 2;

// === Structs ===

/// A treasury vault holding funds of coin type `T`, bound to one `AgentPolicy`.
public struct Vault<phantom T> has key {
    id: UID,
    /// The policy that governs spends from this vault.
    policy_id: ID,
    /// Who opened it (should be the policy owner). The owner cap is the real gate.
    owner: address,
    balance: Balance<T>,
}

// === Events ===

public struct VaultOpened has copy, drop { vault_id: ID, policy_id: ID, owner: address }

public struct VaultDeposited has copy, drop { vault_id: ID, amount: u64, balance: u64 }

public struct VaultSpent has copy, drop {
    vault_id: ID,
    policy_id: ID,
    amount: u64,
    balance: u64,
}

public struct VaultWithdrawn has copy, drop { vault_id: ID, amount: u64, by: address }

// === Open / fund ===

/// Construct a vault bound to `policy` (composable). Caller becomes the owner.
public fun new<T>(policy: &AgentPolicy, ctx: &mut TxContext): Vault<T> {
    let vault = Vault<T> {
        id: object::new(ctx),
        policy_id: object::id(policy),
        owner: ctx.sender(),
        balance: balance::zero<T>(),
    };
    event::emit(VaultOpened {
        vault_id: object::id(&vault),
        policy_id: object::id(policy),
        owner: ctx.sender(),
    });
    vault
}

/// Open + share a treasury vault of coin type `T`, bound to `policy`.
entry fun open<T>(policy: &AgentPolicy, ctx: &mut TxContext) {
    transfer::share_object(new<T>(policy, ctx));
}

/// Deposit funds into the vault. Anyone may fund it (typically the owner).
public fun deposit<T>(vault: &mut Vault<T>, coin: Coin<T>) {
    let amount = coin.value();
    balance::join(&mut vault.balance, coin.into_balance());
    event::emit(VaultDeposited {
        vault_id: object::id(vault),
        amount,
        balance: vault.balance.value(),
    });
}

/// Entry wrapper: deposit a whole coin object.
entry fun deposit_entry<T>(vault: &mut Vault<T>, coin: Coin<T>) {
    deposit(vault, coin);
}

// === Spend (agent, policy-enforced) ===

/// The policy-enforced spend. The delegated agent draws `amount_mist` of `T` from
/// the vault, gated by the full on-chain policy via `policy::enforce_spend`
/// (aborts unless the SENDER is the agent and the action is within budget, per-tx
/// cap, coin/protocol allowlists, expiry, and the policy is not revoked). Returns
/// the `Coin<T>` for the agent to use in the SAME PTB (transfer / swap / supply)
/// plus the audit `ActionReceipt`.
public fun vault_spend<T>(
    vault: &mut Vault<T>,
    policy: &mut AgentPolicy,
    amount_mist: u64,
    protocol: address,
    kind: vector<u8>,
    memo: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<T>, ActionReceipt) {
    assert!(vault.policy_id == object::id(policy), EWrongVault);
    assert!(vault.balance.value() >= amount_mist, EInsufficientVault);
    let receipt = policy::enforce_spend<T>(policy, amount_mist, protocol, kind, memo, clock, ctx);
    let coin = coin::take(&mut vault.balance, amount_mist, ctx);
    event::emit(VaultSpent {
        vault_id: object::id(vault),
        policy_id: object::id(policy),
        amount: amount_mist,
        balance: vault.balance.value(),
    });
    (coin, receipt)
}

// === Withdraw (owner escape hatch) ===

/// Owner pulls funds back out. Cap-gated: only the holder of the matching
/// `PolicyOwnerCap` may withdraw. The treasury is always fully recoverable by the
/// owner, regardless of the agent.
public fun owner_withdraw<T>(
    vault: &mut Vault<T>,
    cap: &PolicyOwnerCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(policy::owner_cap_policy_id(cap) == vault.policy_id, ENotVaultOwner);
    assert!(vault.balance.value() >= amount, EInsufficientVault);
    let coin = coin::take(&mut vault.balance, amount, ctx);
    event::emit(VaultWithdrawn { vault_id: object::id(vault), amount, by: ctx.sender() });
    coin
}

/// Entry wrapper: owner withdraws `amount` to `to`.
entry fun owner_withdraw_to<T>(
    vault: &mut Vault<T>,
    cap: &PolicyOwnerCap,
    amount: u64,
    to: address,
    ctx: &mut TxContext,
) {
    transfer::public_transfer(owner_withdraw<T>(vault, cap, amount, ctx), to);
}

// === Getters ===

public fun value<T>(vault: &Vault<T>): u64 { vault.balance.value() }

public fun policy_id<T>(vault: &Vault<T>): ID { vault.policy_id }

public fun owner<T>(vault: &Vault<T>): address { vault.owner }
