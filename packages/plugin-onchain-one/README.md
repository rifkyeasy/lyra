# lyra-plugin-onchain-one

The **Sui limbs** for **lyra** on `@mysten/sui` v1 — the tools that do real
on-chain work. Every value-moving call is routed through the deterministic
**policy → simulate → approve → execute** pipeline, and (when a vault is
provisioned) sources funds from the on-chain `Vault` via one of its bounded exits
(`vault_transfer`, `vault_borrow`/`vault_settle`, `vault_spend_capped`), so nothing
moves outside the on-chain `lyra::policy` limits.

- **Wallet / reads** — `account.info`, `sui.balance`
- **Transfers** — `sui.send` (recipient-allowlist aware)
- **Swaps** — `swap` (7k aggregator best-route across Cetus / Turbos / FlowX /
  Bluefin / Aftermath / Momentum / Kriya / DeepBook), `cetus.quote`
- **Liquidity** — `cetus.add_liquidity` (full-range Cetus CLMM position,
  zap-funded from vault SUI)
- **Lending** — `scallop.*` (markets / position / supply / withdraw),
  `navi.*` (markets / position / supply / withdraw / borrow / repay),
  `suilend.*` (position / supply / withdraw / borrow / repay)
- **Staking** — `sui.stake` / `sui.unstake` (native delegation), `volo.stake` /
  `volo.unstake` (liquid staking → vSUI)
- **Discovery** — `defi.yields` (DeFiLlama), `deepbook.markets`, `protocols.list`
  (the honest read-vs-execute capability map)
- **Storage** — `walrus.store` (durable, verifiable receipts/memory on Walrus)
- **Policy** — `policy.create` (provision an `AgentPolicy` + `Vault`), `policy.show`

## Install

Most users get these tools automatically with
[`lyra-ai-agent`](https://www.npmjs.com/package/lyra-ai-agent) (the CLI), or via the
[`lyra-plugin-onchain`](https://www.npmjs.com/package/lyra-plugin-onchain) facade.
To depend on this v1 half directly:

```bash
bun add lyra-plugin-onchain-one
```

This is the `@mysten/sui` **v1** implementation; `lyra-plugin-onchain-two` is the v2
sibling, and `lyra-plugin-onchain` combines them behind a single import.

The on-chain package it targets lives in
[`lyraai-protocol/contracts`](https://github.com/lyraai-protocol/contracts). See the
[root README](https://github.com/lyraai-protocol/lyra#readme) for the full architecture.
