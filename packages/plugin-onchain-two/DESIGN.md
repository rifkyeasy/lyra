# Lyra cross-chain deposit / withdraw — design spec

**Goal (chain-abstracted UX):** a user deposits **any token from any chain** (EVM
or Solana) and withdraws back to **their own wallet on any chain** — without
thinking about bridges. Behind the scenes Lyra bridges + normalizes, and the value
lands in / leaves the user's **Sui vault**.

This lives in `lyra-plugin-onchain-two` because the Wormhole SDK requires
`@mysten/sui` v2 (incompatible with the v1 plugin — see the package README).

---

## 1. Base asset: **USDC**, not SUI

The vault normalizes to **native USDC on Sui** (`0xdba3…::usdc::USDC`), not SUI:

- **No forced volatility.** A user depositing a stablecoin must not wake up worth
  less because SUI moved. USDC keeps deposited value stable.
- **Native, not wrapped.** CCTP mints *native* USDC on Sui (no depeg/bridge risk
  accumulating in the treasury). Wrapped assets are only a fallback for long-tail
  tokens with no CCTP route.
- **Cheaper round-trips.** USDC-in / USDC-out over CCTP avoids a SUI swap on each
  leg. A SUI gas float (small) is kept on the agent EOA separately, only for gas.

The Move contract is generic (`Vault<T>`), so USDC is held as `Vault<USDC>`. SUI
stays a *separate* `Vault<SUI>` for on-Sui SUI-denominated actions. No contract
change — `deposit<T>`, owner-gated `open<T>`, and `owner_withdraw` already cover it.

---

## 2. Deposit-in: any token, any chain → USDC in the vault

```
[user's source wallet]                          [Sui]
 EVM/SVM: token X  --burn/lock (USER signs)-->  bridge  --attestation-->  redeem
                                                                             │
                          (if X ≠ USDC on Sui) swap X → USDC  ──────────────┤
                                                                             ▼
                                                          vault::deposit<USDC>(vault)
```

Routes, in preference order:
1. **USDC on source (EVM/SVM)** → **CCTP** → native USDC on Sui → `deposit`. Cleanest.
2. **Other token on source** → either (a) swap → USDC on source *then* CCTP, or
   (b) Wormhole Token Bridge → wrapped-X on Sui → swap wrapped-X → USDC → `deposit`.

**Who signs what:** the **source-chain burn/lock is signed by the USER's own
wallet** (the agent has no EVM/SVM key). Lyra: quotes the route, builds the
unsigned source tx for the user to sign, then — once attested — completes the
Sui side (redeem + optional swap + `deposit`) with the **agent's Sui key**.

---

## 3. Withdraw-out: vault → any token, any chain → user's wallet

```
[Sui]                                                   [dest chain]
 owner_withdraw (USDC)  --(swap → target if needed)-->  bridge out (AGENT signs Sui side)
                                                                 │
                                                     (attestation, async)
                                                                 ▼
                                                  mint/unlock → user's EVM/SVM wallet
```

Withdraw is **more autonomous** than deposit: the agent holds the Sui key, so it
initiates the Sui-side burn/bridge itself to the user-provided destination address.
No user signature on the Sui side. Owner authorizes via the normal owner-cap
withdraw + an explicit Execute-card confirmation.

---

## 4. Trust / custody model

- **Deposit:** funds sit in the user's source wallet until *they* sign the burn.
  After redeem they land in the **owner-controlled vault**. Lyra never custodies
  cross-chain.
- **Withdraw:** funds leave the vault only via the **owner cap** (owner-gated), to
  a destination the owner specifies. The agent executes but can't choose a rogue
  destination without owner approval (Execute-card).
- The bridge protocols (Circle CCTP, Wormhole) are the only third parties; both are
  audited + widely used. Prefer CCTP (Circle-native, no lockup pool).

---

## 5. Async + reliability

Bridging is **not instant** (finality + attestation = minutes). Requirements:

- **Idempotent completion.** A redeem/mint can be done once; key the completion by
  the source tx hash / message nonce so retries don't double-mint.
- **Pending-transfer state.** Persist `{id, route, source tx, status}`; poll the
  attestation service; surface "pending → completing → done" in the UI.
- **Recovery.** If the Sui side fails after the source burn, the transfer is
  recoverable by re-running completion with the same VAA/attestation (funds are not
  lost — the attestation is redeemable until claimed).
- **No silent failure.** Every state transition logged + shown.

---

## 6. Fees + quotes (must be transparent)

Each hop costs **bridge fee + swap slippage**. Before the user signs anything:

- Show `you send X → you receive ~Y USDC after fees (bridge $a, swap b bps)`.
- Warn when the deposit is too small to be worth the fixed bridge fee.
- Cap slippage on the normalizing swap via the policy (same slippage engine as v1).

---

## 7. Contract touchpoints — **none new**

| Step | Contract call | Change? |
|---|---|---|
| Deposit lands | `vault::deposit<USDC>` | none (generic) |
| First USDC vault | `vault::open<USDC>(policy, cap)` (owner-gated) | none |
| Withdraw out | `vault::owner_withdraw<USDC>` | none |
| On-Sui swap (normalize) | v1 `swap` (7k) or `vault_borrow`/`settle` | none |

The finalized contract already supports this. Bridging is off-chain only.

---

## 8. Tools (in `lyra-plugin-onchain-two`, v2 SDK)

- `bridge.routes` — read-only: given (source chain, token, amount), return viable
  routes (CCTP / Token Bridge) with fee + ETA + estimated USDC received.
- `bridge.deposit` — build the unsigned source-chain tx for the user + register a
  pending transfer; a completion worker finishes the Sui side when attested.
- `bridge.complete` — given a source tx hash, fetch the attestation and execute the
  Sui redeem (+ optional swap) + `vault::deposit`.
- `bridge.withdraw` — owner-gated: `owner_withdraw` → (swap) → bridge out to the
  user's destination address; track to completion.
- `bridge.status` — list pending/complete transfers.

All are `movesValue`/write except `routes`/`status` — they inherit the capability
gate + approval floor from the shared plugin surface.

---

## 9. Phasing

1. **MVP** — CCTP USDC in **and** out, EVM ↔ Sui (Ethereum/Base/Arbitrum). Native
   USDC both ways; no swaps needed.
2. **SVM** — add Solana as a CCTP source/dest.
3. **Any-token** — Wormhole Token Bridge for long-tail assets + the normalizing
   swap to USDC.
4. **Frontend** — multi-chain wallet connect (EVM/SVM) + the pending-transfer UI.

Dependencies: none on the contract (done). Needs the v2 context (done) + the
Wormhole SDK route/execute wiring + a pending-transfer store + frontend wallets.
