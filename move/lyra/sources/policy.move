/// Lyra — deterministic on-chain agent policy.
///
/// Lyra's thesis: the AI is advisory; fund controls are enforced in
/// deterministic on-chain code, NOT by the model. An `AgentPolicy` is a shared
/// object created by an owner that bounds what a delegated agent address may do:
/// a lifetime budget and per-tx cap (in MIST), an allowed coin-type list, an
/// allowed protocol-package list, an expiry, and a revoke switch.
///
/// The agent calls `enforce_spend` inside the SAME programmable transaction
/// block that moves the funds. The call aborts if the action is out of policy,
/// and otherwise records the spend and mints an `ActionReceipt` for the audit
/// trail. Because the limits live on-chain, even a fully compromised off-chain
/// agent cannot exceed them — that is why Lyra runs on Sui.
module lyra::policy;

use std::string::String;
use std::type_name;
use sui::clock::Clock;
use sui::event;

// === Errors ===

const ENotAgent: u64 = 0;
const ERevoked: u64 = 1;
const EExpired: u64 = 2;
const EOverPerTxCap: u64 = 3;
const EOverBudget: u64 = 4;
const ECoinNotAllowed: u64 = 5;
const EProtocolNotAllowed: u64 = 6;
const EWrongPolicy: u64 = 7;
const EZeroAmount: u64 = 8;

// === Structs ===

/// Bounds a delegated agent's authority. Shared, so the agent (who is not the
/// owner) can mutate spend accounting while acting within the same PTB.
public struct AgentPolicy has key {
    id: UID,
    /// Creator/controller. Only the holder of the matching `PolicyOwnerCap` may
    /// revoke, top up, or rotate the policy.
    owner: address,
    /// The single address authorized to spend under this policy.
    agent: address,
    /// Lifetime spend ceiling in MIST.
    budget_mist: u64,
    /// MIST spent so far (monotonically increasing, never exceeds budget).
    spent_mist: u64,
    /// Hard cap for a single action, in MIST.
    max_per_tx_mist: u64,
    /// Reference slippage cap (bps). Enforced off-chain against live quotes;
    /// stored here so the bound is auditable on-chain.
    max_slippage_bps: u64,
    /// Allowed coin types as fully-qualified ascii bytes, e.g.
    /// b"0000...0002::sui::SUI". Empty = any coin type allowed.
    allowed_coins: vector<vector<u8>>,
    /// Allowed protocol package ids. Empty = any protocol allowed.
    allowed_protocols: vector<address>,
    /// Expiry in epoch ms; 0 = never expires.
    expiry_ms: u64,
    /// When true every `enforce_spend` call aborts.
    revoked: bool,
    /// Creation time in epoch ms.
    created_ms: u64,
}

/// Capability proving control of one specific `AgentPolicy`. Held by the owner.
public struct PolicyOwnerCap has key, store {
    id: UID,
    policy_id: ID,
}

/// Immutable audit artifact for one policy-checked action. Owned by the policy
/// owner. The off-chain receipt (stored on Walrus) references this object id and
/// the transaction digest.
public struct ActionReceipt has key, store {
    id: UID,
    policy_id: ID,
    agent: address,
    /// Short action kind, e.g. b"transfer", b"swap".
    kind: String,
    /// Coin type touched (ascii bytes of the fully-qualified type).
    coin_type: vector<u8>,
    /// Protocol package id touched (@0x0 for a native / no-protocol action).
    protocol: address,
    amount_mist: u64,
    /// Lifetime spend total AFTER this action.
    spent_after_mist: u64,
    /// Free-form note.
    memo: String,
    timestamp_ms: u64,
}

// === Events ===

public struct PolicyCreated has copy, drop {
    policy_id: ID,
    owner: address,
    agent: address,
    budget_mist: u64,
    max_per_tx_mist: u64,
    expiry_ms: u64,
}

public struct ActionRecorded has copy, drop {
    policy_id: ID,
    receipt_id: ID,
    agent: address,
    kind: String,
    amount_mist: u64,
    spent_after_mist: u64,
    timestamp_ms: u64,
}

public struct PolicyRevoked has copy, drop {
    policy_id: ID,
    by: address,
}

public struct BudgetToppedUp has copy, drop {
    policy_id: ID,
    added_mist: u64,
    budget_mist: u64,
}

public struct AgentRotated has copy, drop {
    policy_id: ID,
    old_agent: address,
    new_agent: address,
}

// === Create ===

/// Create a shared `AgentPolicy` and transfer its `PolicyOwnerCap` to the
/// caller. The caller becomes `owner`; `agent` is the delegated spender.
entry fun create_policy(
    agent: address,
    budget_mist: u64,
    max_per_tx_mist: u64,
    max_slippage_bps: u64,
    allowed_coins: vector<vector<u8>>,
    allowed_protocols: vector<address>,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let owner = ctx.sender();
    let policy = AgentPolicy {
        id: object::new(ctx),
        owner,
        agent,
        budget_mist,
        spent_mist: 0,
        max_per_tx_mist,
        max_slippage_bps,
        allowed_coins,
        allowed_protocols,
        expiry_ms,
        revoked: false,
        created_ms: clock.timestamp_ms(),
    };
    let policy_id = object::id(&policy);
    let cap = PolicyOwnerCap { id: object::new(ctx), policy_id };
    event::emit(PolicyCreated {
        policy_id,
        owner,
        agent,
        budget_mist,
        max_per_tx_mist,
        expiry_ms,
    });
    transfer::share_object(policy);
    transfer::public_transfer(cap, owner);
}

// === Enforce ===

/// Deterministic gate. Aborts unless the SENDER is the policy's agent, the
/// policy is live (not revoked, not expired), `amount_mist` is within the
/// per-tx cap and remaining budget, and the coin type `T` and `protocol` are in
/// scope. On success it increments `spent_mist` and returns an `ActionReceipt`
/// for the caller to keep or share. Compose this in the SAME PTB as the fund
/// movement so the spend and its proof are atomic.
public fun enforce_spend<T>(
    policy: &mut AgentPolicy,
    amount_mist: u64,
    protocol: address,
    kind: vector<u8>,
    memo: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): ActionReceipt {
    assert!(ctx.sender() == policy.agent, ENotAgent);
    assert!(!policy.revoked, ERevoked);
    assert!(amount_mist > 0, EZeroAmount);

    let now = clock.timestamp_ms();
    assert!(policy.expiry_ms == 0 || now <= policy.expiry_ms, EExpired);
    assert!(amount_mist <= policy.max_per_tx_mist, EOverPerTxCap);
    assert!(policy.spent_mist + amount_mist <= policy.budget_mist, EOverBudget);

    let coin_type = type_name::with_defining_ids<T>().into_string().into_bytes();
    assert!(coin_allowed(policy, &coin_type), ECoinNotAllowed);
    assert!(protocol_allowed(policy, protocol), EProtocolNotAllowed);

    policy.spent_mist = policy.spent_mist + amount_mist;

    let receipt = ActionReceipt {
        id: object::new(ctx),
        policy_id: object::id(policy),
        agent: policy.agent,
        kind: kind.to_string(),
        coin_type,
        protocol,
        amount_mist,
        spent_after_mist: policy.spent_mist,
        memo: memo.to_string(),
        timestamp_ms: now,
    };
    event::emit(ActionRecorded {
        policy_id: object::id(policy),
        receipt_id: object::id(&receipt),
        agent: policy.agent,
        kind: receipt.kind,
        amount_mist,
        spent_after_mist: policy.spent_mist,
        timestamp_ms: now,
    });
    receipt
}

/// Entry wrapper around `enforce_spend`: records the action and delivers the
/// `ActionReceipt` to the policy owner. Use this for a standalone receipt write;
/// use `enforce_spend` to compose with a fund movement in one PTB.
entry fun record_action<T>(
    policy: &mut AgentPolicy,
    amount_mist: u64,
    protocol: address,
    kind: vector<u8>,
    memo: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let owner = policy.owner;
    let receipt = enforce_spend<T>(policy, amount_mist, protocol, kind, memo, clock, ctx);
    transfer::public_transfer(receipt, owner);
}

/// Pure, read-only preview used by tests and off-chain dry-runs: true when an
/// action of `amount_mist` in coin `T` via `protocol` would pass right now.
public fun would_allow<T>(
    policy: &AgentPolicy,
    amount_mist: u64,
    protocol: address,
    clock: &Clock,
): bool {
    !policy.revoked
        && amount_mist > 0
        && (policy.expiry_ms == 0 || clock.timestamp_ms() <= policy.expiry_ms)
        && amount_mist <= policy.max_per_tx_mist
        && policy.spent_mist + amount_mist <= policy.budget_mist
        && coin_allowed(policy, &type_name::with_defining_ids<T>().into_string().into_bytes())
        && protocol_allowed(policy, protocol)
}

// === Admin (owner cap) ===

/// Permanently disable the policy. Every subsequent `enforce_spend` aborts.
entry fun revoke(policy: &mut AgentPolicy, cap: &PolicyOwnerCap, ctx: &TxContext) {
    assert!(cap.policy_id == object::id(policy), EWrongPolicy);
    policy.revoked = true;
    event::emit(PolicyRevoked { policy_id: object::id(policy), by: ctx.sender() });
}

/// Raise the lifetime budget ceiling.
entry fun top_up(policy: &mut AgentPolicy, cap: &PolicyOwnerCap, added_mist: u64) {
    assert!(cap.policy_id == object::id(policy), EWrongPolicy);
    policy.budget_mist = policy.budget_mist + added_mist;
    event::emit(BudgetToppedUp {
        policy_id: object::id(policy),
        added_mist,
        budget_mist: policy.budget_mist,
    });
}

/// Rotate the delegated agent address (e.g. after a key rotation).
entry fun rotate_agent(policy: &mut AgentPolicy, cap: &PolicyOwnerCap, new_agent: address) {
    assert!(cap.policy_id == object::id(policy), EWrongPolicy);
    let old_agent = policy.agent;
    policy.agent = new_agent;
    event::emit(AgentRotated { policy_id: object::id(policy), old_agent, new_agent });
}

// === Getters ===

public fun owner(policy: &AgentPolicy): address { policy.owner }

public fun agent(policy: &AgentPolicy): address { policy.agent }

public fun budget_mist(policy: &AgentPolicy): u64 { policy.budget_mist }

public fun spent_mist(policy: &AgentPolicy): u64 { policy.spent_mist }

public fun remaining_mist(policy: &AgentPolicy): u64 { policy.budget_mist - policy.spent_mist }

public fun max_per_tx_mist(policy: &AgentPolicy): u64 { policy.max_per_tx_mist }

public fun max_slippage_bps(policy: &AgentPolicy): u64 { policy.max_slippage_bps }

public fun expiry_ms(policy: &AgentPolicy): u64 { policy.expiry_ms }

public fun is_revoked(policy: &AgentPolicy): bool { policy.revoked }

public fun is_expired(policy: &AgentPolicy, clock: &Clock): bool {
    policy.expiry_ms != 0 && clock.timestamp_ms() > policy.expiry_ms
}

public fun allowed_coins(policy: &AgentPolicy): vector<vector<u8>> { policy.allowed_coins }

public fun allowed_protocols(policy: &AgentPolicy): vector<address> { policy.allowed_protocols }

// Receipt getters.
public fun receipt_amount_mist(r: &ActionReceipt): u64 { r.amount_mist }

public fun receipt_policy_id(r: &ActionReceipt): ID { r.policy_id }

public fun receipt_spent_after_mist(r: &ActionReceipt): u64 { r.spent_after_mist }

// === Private helpers ===

fun coin_allowed(policy: &AgentPolicy, coin_type: &vector<u8>): bool {
    policy.allowed_coins.is_empty() || policy.allowed_coins.contains(coin_type)
}

fun protocol_allowed(policy: &AgentPolicy, protocol: address): bool {
    policy.allowed_protocols.is_empty() || policy.allowed_protocols.contains(&protocol)
}

// === Tests ===

#[test_only]
use sui::sui::SUI;
#[test_only]
use sui::clock;
#[test_only]
use std::unit_test::destroy;

#[test_only]
const AGENT: address = @0x0; // matches tx_context::dummy() sender
#[test_only]
const OWNER: address = @0xACE;

#[test_only]
/// Build a policy directly (in-module) for unit tests. `agent` is the dummy ctx
/// sender so `enforce_spend` passes the agent check by default.
fun mk(
    budget_mist: u64,
    max_per_tx_mist: u64,
    expiry_ms: u64,
    allowed_coins: vector<vector<u8>>,
    allowed_protocols: vector<address>,
    ctx: &mut TxContext,
): AgentPolicy {
    AgentPolicy {
        id: object::new(ctx),
        owner: OWNER,
        agent: AGENT,
        budget_mist,
        spent_mist: 0,
        max_per_tx_mist,
        max_slippage_bps: 100,
        allowed_coins,
        allowed_protocols,
        expiry_ms,
        revoked: false,
        created_ms: 0,
    }
}

#[test_only]
fun sui_type(): vector<u8> { type_name::with_defining_ids<SUI>().into_string().into_bytes() }

#[test]
fun spends_within_limits_and_accrues() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let mut policy = mk(1000, 600, 0, vector[], vector[], &mut ctx);

    let r1 = enforce_spend<SUI>(&mut policy, 400, @0x0, b"transfer", b"first", &clk, &mut ctx);
    assert!(policy.spent_mist() == 400);
    assert!(r1.receipt_amount_mist() == 400);
    assert!(policy.remaining_mist() == 600);

    let r2 = enforce_spend<SUI>(&mut policy, 600, @0x0, b"transfer", b"second", &clk, &mut ctx);
    assert!(policy.spent_mist() == 1000);
    assert!(r2.receipt_spent_after_mist() == 1000);
    assert!(policy.remaining_mist() == 0);

    destroy(r1);
    destroy(r2);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure(abort_code = EOverPerTxCap)]
fun blocks_over_per_tx_cap() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let mut policy = mk(10_000, 500, 0, vector[], vector[], &mut ctx);
    let r = enforce_spend<SUI>(&mut policy, 501, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure(abort_code = EOverBudget)]
fun blocks_over_budget() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let mut policy = mk(1000, 1000, 0, vector[], vector[], &mut ctx);
    let r1 = enforce_spend<SUI>(&mut policy, 700, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r1);
    // 700 + 400 = 1100 > 1000 budget — this call aborts.
    let r2 = enforce_spend<SUI>(&mut policy, 400, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r2);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure(abort_code = ERevoked)]
fun blocks_when_revoked() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let mut policy = mk(1000, 1000, 0, vector[], vector[], &mut ctx);
    policy.revoked = true;
    let r = enforce_spend<SUI>(&mut policy, 100, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure(abort_code = EExpired)]
fun blocks_when_expired() {
    let mut ctx = tx_context::dummy();
    let mut clk = clock::create_for_testing(&mut ctx);
    clk.set_for_testing(5_000);
    let mut policy = mk(1000, 1000, 1_000, vector[], vector[], &mut ctx); // expiry 1s, now 5s
    let r = enforce_spend<SUI>(&mut policy, 100, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure(abort_code = ENotAgent)]
fun blocks_wrong_agent() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let mut policy = mk(1000, 1000, 0, vector[], vector[], &mut ctx);
    policy.agent = @0xBEEF; // ctx sender is @0x0, so the agent check fails
    let r = enforce_spend<SUI>(&mut policy, 100, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure(abort_code = ECoinNotAllowed)]
fun blocks_coin_not_in_allowlist() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    // Allowlist a bogus coin type, so SUI is rejected.
    let mut policy = mk(1000, 1000, 0, vector[b"0x0::nope::NOPE"], vector[], &mut ctx);
    let r = enforce_spend<SUI>(&mut policy, 100, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test]
fun allows_coin_in_allowlist() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let mut policy = mk(1000, 1000, 0, vector[sui_type()], vector[], &mut ctx);
    let r = enforce_spend<SUI>(&mut policy, 100, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure(abort_code = EProtocolNotAllowed)]
fun blocks_protocol_not_in_allowlist() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let mut policy = mk(1000, 1000, 0, vector[], vector[@0xDEE9], &mut ctx);
    // Action touches @0xBAD, not the single allowed protocol.
    let r = enforce_spend<SUI>(&mut policy, 100, @0xBAD, b"swap", b"", &clk, &mut ctx);
    destroy(r);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure(abort_code = EZeroAmount)]
fun blocks_zero_amount() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let mut policy = mk(1000, 1000, 0, vector[], vector[], &mut ctx);
    let r = enforce_spend<SUI>(&mut policy, 0, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r);
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test]
fun would_allow_tracks_state() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let mut policy = mk(1000, 600, 0, vector[], vector[], &mut ctx);
    assert!(policy.would_allow<SUI>(600, @0x0, &clk));
    assert!(!policy.would_allow<SUI>(601, @0x0, &clk)); // over per-tx cap
    let r = enforce_spend<SUI>(&mut policy, 600, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(r);
    assert!(!policy.would_allow<SUI>(600, @0x0, &clk)); // only 400 budget left
    assert!(policy.would_allow<SUI>(400, @0x0, &clk));
    destroy(policy);
    clock::destroy_for_testing(clk);
}

#[test]
fun top_up_raises_budget() {
    let mut ctx = tx_context::dummy();
    let mut policy = mk(500, 500, 0, vector[], vector[], &mut ctx);
    let cap = PolicyOwnerCap { id: object::new(&mut ctx), policy_id: object::id(&policy) };
    top_up(&mut policy, &cap, 1_000);
    assert!(policy.budget_mist() == 1_500);
    destroy(cap);
    destroy(policy);
}

#[test, expected_failure(abort_code = EWrongPolicy)]
fun rejects_foreign_owner_cap() {
    let mut ctx = tx_context::dummy();
    let mut policy = mk(500, 500, 0, vector[], vector[], &mut ctx);
    // A cap minted for a different policy id must not control this one.
    let cap = PolicyOwnerCap {
        id: object::new(&mut ctx),
        policy_id: object::id_from_address(@0xF00D),
    };
    top_up(&mut policy, &cap, 1);
    destroy(cap);
    destroy(policy);
}
