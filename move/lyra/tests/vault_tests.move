#[test_only]
module lyra::vault_tests;

use lyra::policy;
use lyra::vault;
use std::unit_test::destroy;
use sui::clock;
use sui::coin;
use sui::sui::SUI;

// tx_context::dummy() sender — set as the policy agent so vault_spend passes the
// on-chain agent check by default.
const AGENT: address = @0x0;

#[test]
/// The agent draws funds from the vault under policy; balance + spend accounting move.
fun agent_spends_from_vault_within_policy() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let (mut policy, cap) =
        policy::new_policy_for_testing(AGENT, 1000, 600, 0, vector[], vector[], &mut ctx);
    let mut v = vault::new<SUI>(&policy, &mut ctx);

    vault::deposit(&mut v, coin::mint_for_testing<SUI>(1000, &mut ctx));
    assert!(vault::value(&v) == 1000);

    let (c, r) =
        vault::vault_spend<SUI>(&mut v, &mut policy, 400, @0x0, b"transfer", b"", &clk, &mut ctx);
    assert!(c.value() == 400);
    assert!(vault::value(&v) == 600);
    assert!(policy.spent_mist() == 400);

    destroy(c);
    destroy(r);
    destroy(v);
    destroy(policy);
    destroy(cap);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure]
/// A spend over the per-tx cap aborts inside the policy gate — even with funds present.
fun blocks_spend_over_per_tx_cap() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let (mut policy, cap) =
        policy::new_policy_for_testing(AGENT, 10_000, 500, 0, vector[], vector[], &mut ctx);
    let mut v = vault::new<SUI>(&policy, &mut ctx);
    vault::deposit(&mut v, coin::mint_for_testing<SUI>(10_000, &mut ctx));
    let (c, r) =
        vault::vault_spend<SUI>(&mut v, &mut policy, 501, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(c);
    destroy(r);
    destroy(v);
    destroy(policy);
    destroy(cap);
    clock::destroy_for_testing(clk);
}

#[test, expected_failure]
/// In-policy but the vault lacks the funds → aborts (EInsufficientVault).
fun blocks_spend_exceeding_vault_balance() {
    let mut ctx = tx_context::dummy();
    let clk = clock::create_for_testing(&mut ctx);
    let (mut policy, cap) =
        policy::new_policy_for_testing(AGENT, 10_000, 10_000, 0, vector[], vector[], &mut ctx);
    let mut v = vault::new<SUI>(&policy, &mut ctx);
    vault::deposit(&mut v, coin::mint_for_testing<SUI>(100, &mut ctx));
    let (c, r) =
        vault::vault_spend<SUI>(&mut v, &mut policy, 500, @0x0, b"transfer", b"", &clk, &mut ctx);
    destroy(c);
    destroy(r);
    destroy(v);
    destroy(policy);
    destroy(cap);
    clock::destroy_for_testing(clk);
}

#[test]
/// The owner can always pull the whole treasury back with the cap.
fun owner_withdraws_treasury_back() {
    let mut ctx = tx_context::dummy();
    let (policy, cap) =
        policy::new_policy_for_testing(AGENT, 1000, 1000, 0, vector[], vector[], &mut ctx);
    let mut v = vault::new<SUI>(&policy, &mut ctx);
    vault::deposit(&mut v, coin::mint_for_testing<SUI>(1000, &mut ctx));

    let c = vault::owner_withdraw<SUI>(&mut v, &cap, 1000, &mut ctx);
    assert!(c.value() == 1000);
    assert!(vault::value(&v) == 0);

    destroy(c);
    destroy(v);
    destroy(policy);
    destroy(cap);
}

#[test, expected_failure]
/// A cap from a different policy must not control this vault (ENotVaultOwner).
fun foreign_cap_cannot_withdraw() {
    let mut ctx = tx_context::dummy();
    let (policy, cap) =
        policy::new_policy_for_testing(AGENT, 1000, 1000, 0, vector[], vector[], &mut ctx);
    let mut v = vault::new<SUI>(&policy, &mut ctx);
    vault::deposit(&mut v, coin::mint_for_testing<SUI>(1000, &mut ctx));

    let (policy2, cap2) =
        policy::new_policy_for_testing(AGENT, 1, 1, 0, vector[], vector[], &mut ctx);
    let c = vault::owner_withdraw<SUI>(&mut v, &cap2, 1, &mut ctx);

    destroy(c);
    destroy(v);
    destroy(policy);
    destroy(cap);
    destroy(policy2);
    destroy(cap2);
}
