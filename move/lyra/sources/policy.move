/// Lyra AI — on-chain agent policy and audit receipts.
///
/// Product rule: the AI is advisory; spending authority is enforced HERE, in
/// deterministic Move code, never by the model. An `AgentPolicy<T>` custodies a
/// budget of coin `T` that an agent may spend ONLY through `withdraw`, which
/// aborts if the policy is revoked, expired, over its per-transaction cap, over
/// its remaining budget, or targets a protocol outside the allowlist. Because
/// the agent holds no other funds, it physically cannot exceed these bounds — a
/// jailbreak or hallucination cannot move money the contract won't release.
module lyra::policy;

use std::string::String;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;

// === Errors ===

#[error]
const ENotOwner: vector<u8> = b"only the policy owner may perform this action";
#[error]
const ECapMismatch: vector<u8> = b"agent capability does not authorize this policy";
#[error]
const ERevoked: vector<u8> = b"policy has been revoked by the owner";
#[error]
const EExpired: vector<u8> = b"policy has expired";
#[error]
const EOverPerTxCap: vector<u8> = b"amount exceeds the per-transaction cap";
#[error]
const EOverBudget: vector<u8> = b"amount exceeds the remaining budget";
#[error]
const EProtocolNotAllowed: vector<u8> = b"protocol is not in the policy allowlist";

// === Objects ===

/// Shared object: an agent's bounded spending authority plus audit accounting.
/// Shared (not owned) so the agent — a different key from the owner — can use
/// it as a transaction input. Access is gated by `AgentCap` + the revoked flag.
public struct AgentPolicy<phantom T> has key, store {
    id: UID,
    /// Human owner; the only address that can revoke or reclaim.
    owner: address,
    /// The agent's operational address (informational / for receipts).
    agent: address,
    /// Custodied funds the agent may spend. The hard ceiling on total outflow.
    budget: Balance<T>,
    /// Lifetime deposited, for accounting/UX.
    total_deposited: u64,
    /// Lifetime spent through `withdraw`.
    spent: u64,
    /// Per-action hard cap.
    max_per_tx: u64,
    /// Advisory slippage ceiling (bps); enforced off-chain at quote time.
    max_slippage_bps: u64,
    /// Allowed protocol tags (e.g. "transfer", "deepbook"). Empty = allow all.
    allowed_protocols: vector<String>,
    /// Absolute unix ms after which the policy is invalid. 0 = no expiry.
    expiry_ms: u64,
    /// Owner kill switch. Once true, every spend aborts.
    revoked: bool,
    /// Monotonic action counter, used as the receipt sequence number.
    nonce: u64,
}

/// Capability proving the holder is the agent authorized by `policy_id`.
/// Minted at creation and transferred to the agent's address; presented on
/// every spend. Revocation is enforced by the policy's `revoked` flag, so a
/// leaked cap is neutralized the moment the owner revokes.
public struct AgentCap has key, store {
    id: UID,
    policy_id: ID,
}

/// Immutable, append-only audit record of an executed action. Frozen on
/// creation so it is publicly readable forever and can never be altered.
public struct ActionReceipt has key, store {
    id: UID,
    policy_id: ID,
    seq: u64,
    agent: address,
    protocol: String,
    summary: String,
    amount: u64,
    coin_type: String,
    status: String,
    /// Walrus blob id of the full off-chain receipt/memory artifact ("" if none).
    walrus_blob: String,
    timestamp_ms: u64,
}

// === Events ===

public struct PolicyCreated has copy, drop {
    policy_id: ID,
    owner: address,
    agent: address,
    max_per_tx: u64,
    expiry_ms: u64,
}

public struct Deposited has copy, drop {
    policy_id: ID,
    amount: u64,
    new_remaining: u64,
}

public struct Spent has copy, drop {
    policy_id: ID,
    seq: u64,
    protocol: String,
    amount: u64,
    spent_total: u64,
    remaining: u64,
}

public struct ActionRecorded has copy, drop {
    policy_id: ID,
    receipt_id: ID,
    seq: u64,
    protocol: String,
    status: String,
    walrus_blob: String,
}

public struct Revoked has copy, drop {
    policy_id: ID,
    by: address,
}

public struct Reclaimed has copy, drop {
    policy_id: ID,
    amount: u64,
}

// === Public functions ===

/// Create a new policy funded with `initial`, returning the policy and the
/// agent capability for the caller to place. Owner is the transaction sender.
/// Composable form — see `create` for the share-and-transfer convenience entry.
public fun new<T>(
    agent: address,
    max_per_tx: u64,
    max_slippage_bps: u64,
    allowed_protocols: vector<String>,
    expiry_ms: u64,
    initial: Coin<T>,
    ctx: &mut TxContext,
): (AgentPolicy<T>, AgentCap) {
    let amount = initial.value();
    let policy = AgentPolicy<T> {
        id: object::new(ctx),
        owner: ctx.sender(),
        agent,
        budget: initial.into_balance(),
        total_deposited: amount,
        spent: 0,
        max_per_tx,
        max_slippage_bps,
        allowed_protocols,
        expiry_ms,
        revoked: false,
        nonce: 0,
    };
    let policy_id = object::id(&policy);
    let cap = AgentCap { id: object::new(ctx), policy_id };
    event::emit(PolicyCreated {
        policy_id,
        owner: policy.owner,
        agent,
        max_per_tx,
        expiry_ms,
    });
    (policy, cap)
}

/// Convenience entry: create the policy, share it, and hand the cap to `agent`.
/// The policy is created and shared in the same call, so the share cannot abort.
#[allow(lint(share_owned))]
entry fun create<T>(
    agent: address,
    max_per_tx: u64,
    max_slippage_bps: u64,
    allowed_protocols: vector<String>,
    expiry_ms: u64,
    initial: Coin<T>,
    ctx: &mut TxContext,
) {
    let (policy, cap) = new<T>(
        agent,
        max_per_tx,
        max_slippage_bps,
        allowed_protocols,
        expiry_ms,
        initial,
        ctx,
    );
    transfer::public_share_object(policy);
    transfer::public_transfer(cap, agent);
}

/// Top up the policy budget. Anyone may deposit; only the agent may spend.
public fun deposit<T>(policy: &mut AgentPolicy<T>, c: Coin<T>) {
    let amount = c.value();
    policy.budget.join(c.into_balance());
    policy.total_deposited = policy.total_deposited + amount;
    event::emit(Deposited {
        policy_id: object::id(policy),
        amount,
        new_remaining: policy.budget.value(),
    });
}

/// The core guard. The agent draws `amount` of budget for an action on
/// `protocol`, aborting unless every policy bound holds. Returns the `Coin<T>`
/// so the caller spends it in the SAME programmable transaction block — the
/// guard and the real action are therefore atomic.
public fun withdraw<T>(
    policy: &mut AgentPolicy<T>,
    cap: &AgentCap,
    amount: u64,
    protocol: String,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(cap.policy_id == object::id(policy), ECapMismatch);
    assert!(!policy.revoked, ERevoked);
    if (policy.expiry_ms != 0) {
        assert!(clock.timestamp_ms() < policy.expiry_ms, EExpired);
    };
    assert!(amount <= policy.max_per_tx, EOverPerTxCap);
    assert!(amount <= policy.budget.value(), EOverBudget);
    assert!(is_allowed(&policy.allowed_protocols, &protocol), EProtocolNotAllowed);

    let coin = policy.budget.split(amount).into_coin(ctx);
    policy.spent = policy.spent + amount;
    policy.nonce = policy.nonce + 1;
    event::emit(Spent {
        policy_id: object::id(policy),
        seq: policy.nonce,
        protocol,
        amount,
        spent_total: policy.spent,
        remaining: policy.budget.value(),
    });
    coin
}

/// Record an immutable on-chain receipt for an executed action and link it to
/// its Walrus artifact. Callable by the agent (cap holder). Frozen on creation.
public fun record<T>(
    policy: &mut AgentPolicy<T>,
    cap: &AgentCap,
    protocol: String,
    summary: String,
    amount: u64,
    coin_type: String,
    status: String,
    walrus_blob: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(cap.policy_id == object::id(policy), ECapMismatch);
    let receipt = ActionReceipt {
        id: object::new(ctx),
        policy_id: object::id(policy),
        seq: policy.nonce,
        agent: policy.agent,
        protocol,
        summary,
        amount,
        coin_type,
        status,
        walrus_blob,
        timestamp_ms: clock.timestamp_ms(),
    };
    event::emit(ActionRecorded {
        policy_id: receipt.policy_id,
        receipt_id: object::id(&receipt),
        seq: receipt.seq,
        protocol: receipt.protocol,
        status: receipt.status,
        walrus_blob: receipt.walrus_blob,
    });
    transfer::freeze_object(receipt);
}

/// Owner kill switch. After this, every `withdraw` aborts with `ERevoked`.
public fun revoke<T>(policy: &mut AgentPolicy<T>, ctx: &TxContext) {
    assert!(ctx.sender() == policy.owner, ENotOwner);
    policy.revoked = true;
    event::emit(Revoked { policy_id: object::id(policy), by: ctx.sender() });
}

/// Owner reclaims the entire remaining budget as a coin (composable form).
public fun reclaim<T>(policy: &mut AgentPolicy<T>, ctx: &mut TxContext): Coin<T> {
    assert!(ctx.sender() == policy.owner, ENotOwner);
    let amount = policy.budget.value();
    let coin = policy.budget.split(amount).into_coin(ctx);
    event::emit(Reclaimed { policy_id: object::id(policy), amount });
    coin
}

/// Convenience entry: reclaim the remaining budget back to the owner.
entry fun reclaim_all<T>(policy: &mut AgentPolicy<T>, ctx: &mut TxContext) {
    let coin = reclaim(policy, ctx);
    transfer::public_transfer(coin, ctx.sender());
}

// === Views ===

public fun owner<T>(p: &AgentPolicy<T>): address { p.owner }

public fun agent<T>(p: &AgentPolicy<T>): address { p.agent }

public fun remaining<T>(p: &AgentPolicy<T>): u64 { p.budget.value() }

public fun spent<T>(p: &AgentPolicy<T>): u64 { p.spent }

public fun total_deposited<T>(p: &AgentPolicy<T>): u64 { p.total_deposited }

public fun max_per_tx<T>(p: &AgentPolicy<T>): u64 { p.max_per_tx }

public fun max_slippage_bps<T>(p: &AgentPolicy<T>): u64 { p.max_slippage_bps }

public fun expiry_ms<T>(p: &AgentPolicy<T>): u64 { p.expiry_ms }

public fun is_revoked<T>(p: &AgentPolicy<T>): bool { p.revoked }

public fun nonce<T>(p: &AgentPolicy<T>): u64 { p.nonce }

public fun allowed_protocols<T>(p: &AgentPolicy<T>): vector<String> { p.allowed_protocols }

// === Private helpers ===

/// True if `p` is in `list`, or the list is empty (empty allowlist = allow all).
fun is_allowed(list: &vector<String>, p: &String): bool {
    if (list.is_empty()) return true;
    let mut i = 0;
    while (i < list.length()) {
        if (list[i] == *p) return true;
        i = i + 1;
    };
    false
}

// === Tests ===

#[test_only]
use sui::coin;
#[test_only]
use sui::sui::SUI;
#[test_only]
use sui::test_utils::destroy;

#[test_only]
fun protos(): vector<String> {
    vector[b"transfer".to_string(), b"deepbook".to_string()]
}

#[test]
fun withdraw_within_cap_succeeds() {
    let mut ctx = tx_context::dummy();
    let clk = sui::clock::create_for_testing(&mut ctx);
    let funds = coin::mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut p, cap) = new<SUI>(@0xA, 500, 100, protos(), 0, funds, &mut ctx);

    let c = p.withdraw(&cap, 300, b"transfer".to_string(), &clk, &mut ctx);
    assert!(c.value() == 300);
    assert!(p.remaining() == 700);
    assert!(p.spent() == 300);
    assert!(p.nonce() == 1);

    destroy(c);
    destroy(p);
    destroy(cap);
    clk.destroy_for_testing();
}

#[test, expected_failure(abort_code = EOverPerTxCap)]
fun withdraw_over_per_tx_cap_aborts() {
    let mut ctx = tx_context::dummy();
    let clk = sui::clock::create_for_testing(&mut ctx);
    let funds = coin::mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut p, cap) = new<SUI>(@0xA, 500, 100, protos(), 0, funds, &mut ctx);
    let c = p.withdraw(&cap, 600, b"transfer".to_string(), &clk, &mut ctx); // > 500 cap
    destroy(c);
    destroy(p);
    destroy(cap);
    clk.destroy_for_testing();
}

#[test, expected_failure(abort_code = EOverBudget)]
fun withdraw_over_budget_aborts() {
    let mut ctx = tx_context::dummy();
    let clk = sui::clock::create_for_testing(&mut ctx);
    let funds = coin::mint_for_testing<SUI>(1_000, &mut ctx);
    // per-tx cap high enough to pass, but amount exceeds the 1_000 budget
    let (mut p, cap) = new<SUI>(@0xA, 5_000, 100, protos(), 0, funds, &mut ctx);
    let c = p.withdraw(&cap, 1_500, b"transfer".to_string(), &clk, &mut ctx);
    destroy(c);
    destroy(p);
    destroy(cap);
    clk.destroy_for_testing();
}

#[test, expected_failure(abort_code = EProtocolNotAllowed)]
fun withdraw_disallowed_protocol_aborts() {
    let mut ctx = tx_context::dummy();
    let clk = sui::clock::create_for_testing(&mut ctx);
    let funds = coin::mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut p, cap) = new<SUI>(@0xA, 500, 100, protos(), 0, funds, &mut ctx);
    let c = p.withdraw(&cap, 100, b"cetus".to_string(), &clk, &mut ctx); // not allowlisted
    destroy(c);
    destroy(p);
    destroy(cap);
    clk.destroy_for_testing();
}

#[test, expected_failure(abort_code = ERevoked)]
fun withdraw_after_revoke_aborts() {
    let mut ctx = tx_context::dummy(); // sender = @0x0 == owner
    let clk = sui::clock::create_for_testing(&mut ctx);
    let funds = coin::mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut p, cap) = new<SUI>(@0xA, 500, 100, protos(), 0, funds, &mut ctx);
    p.revoke(&ctx);
    let c = p.withdraw(&cap, 100, b"transfer".to_string(), &clk, &mut ctx);
    destroy(c);
    destroy(p);
    destroy(cap);
    clk.destroy_for_testing();
}

#[test, expected_failure(abort_code = EExpired)]
fun withdraw_after_expiry_aborts() {
    let mut ctx = tx_context::dummy();
    let mut clk = sui::clock::create_for_testing(&mut ctx);
    let funds = coin::mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut p, cap) = new<SUI>(@0xA, 500, 100, protos(), 1_000, funds, &mut ctx); // expiry 1_000ms
    clk.set_for_testing(2_000); // now past expiry
    let c = p.withdraw(&cap, 100, b"transfer".to_string(), &clk, &mut ctx);
    destroy(c);
    destroy(p);
    destroy(cap);
    clk.destroy_for_testing();
}

#[test]
fun deposit_and_reclaim() {
    let mut ctx = tx_context::dummy();
    let funds = coin::mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut p, cap) = new<SUI>(@0xA, 500, 100, protos(), 0, funds, &mut ctx);

    let more = coin::mint_for_testing<SUI>(500, &mut ctx);
    p.deposit(more);
    assert!(p.remaining() == 1_500);
    assert!(p.total_deposited() == 1_500);

    let back = p.reclaim(&mut ctx); // owner == @0x0 == sender
    assert!(back.value() == 1_500);
    assert!(p.remaining() == 0);

    destroy(back);
    destroy(p);
    destroy(cap);
}

#[test, expected_failure(abort_code = ENotOwner)]
fun revoke_by_non_owner_aborts() {
    // Owner is @0xA, but the dummy-context sender is @0x0 → not the owner.
    let mut ctx = tx_context::dummy();
    let funds = coin::mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut p, cap) = new_with_owner<SUI>(@0xBEEF, @0xA, 500, protos(), funds, &mut ctx);
    p.revoke(&ctx); // sender @0x0 != owner @0xBEEF
    destroy(p);
    destroy(cap);
}

/// Test helper: build a policy with an explicit owner (since `new` uses sender).
#[test_only]
fun new_with_owner<T>(
    owner: address,
    agent: address,
    max_per_tx: u64,
    allowed_protocols: vector<String>,
    initial: Coin<T>,
    ctx: &mut TxContext,
): (AgentPolicy<T>, AgentCap) {
    let amount = initial.value();
    let policy = AgentPolicy<T> {
        id: object::new(ctx),
        owner,
        agent,
        budget: initial.into_balance(),
        total_deposited: amount,
        spent: 0,
        max_per_tx,
        max_slippage_bps: 0,
        allowed_protocols,
        expiry_ms: 0,
        revoked: false,
        nonce: 0,
    };
    let policy_id = object::id(&policy);
    let cap = AgentCap { id: object::new(ctx), policy_id };
    (policy, cap)
}
