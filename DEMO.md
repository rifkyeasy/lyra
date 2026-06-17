# Lyra — demo walkthrough

A 5-minute tour of the thesis: **the AI advises, deterministic code + Sui enforce the fund controls.** Every step below is a real capability, wired and verified live on **Sui mainnet** in this repo.

The control layer lives in two places that agree with each other:
- **Off-chain** — a pure, unit-tested policy engine (`packages/plugin-onchain/src/policy.ts`) checked before anything is signed.
- **On-chain** — the `lyra::policy` Move package, deployed to mainnet, which re-enforces the same budget / per-tx / coin / protocol / expiry in Move and mints an auditable `ActionReceipt`.

```
mainnet package  0x250880a4c1a268da8011b164f599d4e100cefce84f862d36396cd1a943ee8a35
```

## Setup

```bash
bun install
cp .env.example .env      # then fill in the values below

# the deterministic guardrails (the whole point):
LYRA_NETWORK=mainnet
LYRA_AGENT_KEY=suiprivkey1...                 # the agent that signs + pays gas
LYRA_PACKAGE_ID=0x250880a4...316885           # the deployed lyra::policy package
LYRA_POLICY_MAX_PER_TX_SUI=1.0                # hard cap: block any send over 1 SUI
LYRA_POLICY_AUTO_MAX_SUI=0.1                  # auto up to 0.1 SUI; above → approval
LYRA_POLICY_MAX_SLIPPAGE_BPS=100             # block swaps over 1% slippage
LYRA_POLICY_ALLOWED_PROTOCOLS=transfer,deepbook,walrus,scallop,navi,cetus,swap
LYRA_POLICY_ALLOWED_COINS=0x2::sui::SUI,<usdc>,<deep>,<wal>   # coins the agent may hold/acquire
LYRA_POLICY_EXPIRY_MINUTES=60
OPENAI_API_KEY=sk-...                          # any OpenAI-compatible key

bun run lyra init        # derives the agent's Sui address, seeds memory
bun run lyra demo        # one-shot guarded-pipeline demo (read-only by default)
bun run lyra chat        # terminal chat
```

Fund the agent address shown by `init` with a little SUI for gas.

---

## 1. The control layer is legible

> **you:** what are my limits?

The agent calls `policy.show` and reports the enforced boundary verbatim — hard cap 1 SUI, auto-execute up to 0.1 SUI (above that needs approval), swaps capped at 100 bps, allowed protocols + coin type, a 60-minute expiry. These come from `LYRA_POLICY_*`, evaluated in pure code, not from the model's judgment.

## 2. A hard cap blocks — the model cannot talk its way past it

> **you:** send 5 SUI to my address

`sui.send` runs `evaluatePolicy` first. 5 SUI exceeds the 1 SUI per-tx cap, so the tool returns **`policy blocked: amount 5000000000 MIST exceeds per-tx cap 1000000000 MIST`** *before any signing or broadcast.* No prompt, no override. (`packages/plugin-onchain/src/policy.ts`, 22 unit tests.)

## 3. Publish the policy on-chain

> **you:** arm an on-chain policy: 1 SUI budget, 0.5 SUI per tx

`policy.create` calls `lyra::policy::create_policy`, publishing a shared **`AgentPolicy`** object on mainnet (and a `PolicyOwnerCap` to the owner). Verified: object `0x75c60a44…`, digest `3vzpyRxXCT9hSQp14EeQbbt4J8Xzuik3Mx8oJPpzqT9c`. Now the same limits are enforced in Move, not just off-chain.

## 4. Guarded execution — policy → simulate → execute → on-chain receipt

> **you:** send 0.01 SUI to my address

`sui.send` runs the full pipeline in one PTB: deterministic policy check → dry-run simulate (catches reverts / insufficient funds with zero gas) → execute → `lyra::policy::record_action`, which re-checks the limits in Move and mints an **`ActionReceipt`**. Verified on mainnet: digest `GiCXyXawmQVNyyozQuF5HY6TRa18DTEqL8bKZ9Yi8QUd`, on-chain receipt `0xc9a19788…`. A compromised off-chain agent still can't exceed the on-chain caps — that is why Lyra runs on Sui.

## 5. Durable, verifiable receipts on Walrus

> **you:** store that receipt

`walrus.store` writes the execution receipt to **Walrus** (real mainnet blob, pays WAL). Verified blobId `rfxVUtxjSE1PAuXcdOYfSsNLYca43PjLrZlsHyyONYg`. Short-lived actions become durable, portable, verifiable memory.

## 6. Yield discovery — and an honest capability boundary

> **you:** best stablecoin yield on Sui?

`defi.yields` (DefiLlama, read-only) ranks pools across **every** Sui protocol with TVL + IL-risk signals, and tags each one `executable` / `executeWith`. When the best APY is on a protocol Lyra hasn't integrated, it says so honestly and proposes the best **executable** alternative (NAVI / Scallop) — it never fabricates a transaction. `protocols.list` shows exactly what Lyra can execute vs only read. (`packages/plugin-onchain/src/protocols.ts`.)

## 7. Lending on the two biggest Sui money markets

> **you:** where can I earn on idle SUI? then supply 0.1

`scallop.markets` + `navi.markets` return live supply/borrow APY (verified: NAVI SUI 1.72%/2.63%, Scallop USDC 5.7%/9.7%). `scallop.supply` / `navi.supply` deposit through the same policy → simulate → execute pipeline; `*.position` shows the agent's balances + health factor. Both **NAVI** (largest Sui lender) and **Scallop** SDK builders compose into our PTB.

## 8. Best-execution market data

> **you:** what's the price of SUI?

`deepbook.markets` returns live **DeepBook** spot mids; `swap` **executes** a real swap through the **7k aggregator** (best route across Cetus / FlowX / Bluefin / DeepBook), policy-checked → simulated → executed (verified on mainnet: 1 SUI → 0.799 USDC via FlowX, digest `CYQPBQzAJoNUtMwa9KbbBkyodfBCcw3RxD4MKVpuhfdg`; reverse 1 USDC → 1.253 SUI). It tries routes in output order, skipping any that don't simulate cleanly. `cetus.quote` gives a read-only quote. Discovery, routing, and execution span the whole DEX landscape.

## 9. Same agent, four interfaces

```bash
bun run lyra chat            # terminal TUI
bun run lyra gateway start   # HTTP daemon
bun run lyra telegram setup  # drive it from your phone (inline-keyboard approvals)
cd apps/web && bun run dev    # web console — Sui wallet sign-in, on-chain policy view
```

The CLI, gateway, and Telegram bot drive the **identical** autonomous agent with the **identical** policy gates — material-risk actions arrive as approvals. The **web console** adds a second execution path: with a wallet connected, asking it to **send** or **swap** returns an Execute button that builds the PTB in the browser and your **own wallet** signs it — Lyra prepares the action and never holds your keys (verified: `propose_transfer` / `propose_swap` → client-side build via the same 7k routing → wallet `signAndExecute`).

---

## What to look at in the code

| Claim | Where |
| --- | --- |
| On-chain policy (Move, mainnet) | `move/lyra/sources/policy.move` (+ 13 Move tests) |
| Deterministic policy engine (pure, auditable) | `packages/plugin-onchain/src/policy.ts` + `policy.test.ts` (22 tests) |
| Guarded pipeline (policy → simulate → execute → receipt) | `packages/plugin-onchain/src/tools/send.ts` |
| Simulate-before-write (dry-run) | `packages/plugin-onchain/src/simulate.ts` |
| Capability boundary (discover vs execute) | `packages/plugin-onchain/src/protocols.ts` + `tools/defillama.ts` |
| Walrus receipts/memory | `packages/plugin-onchain/src/tools/walrus.ts` |
| Lending (Scallop / NAVI) | `packages/plugin-onchain/src/tools/{scallop,navi}.ts` |
| DeepBook + Cetus | `packages/plugin-onchain/src/tools/{deepbook,cetus}.ts` |
| Web console (Sui dapp-kit) | `apps/web` |

Run the safety boundary's tests directly:

```bash
sui move test --path move/lyra                       # 13 on-chain policy tests
bun test packages/plugin-onchain/src/policy.test.ts  # 22 off-chain policy tests
```
