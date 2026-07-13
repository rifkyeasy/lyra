# lyra-plugin-onchain

The **Sui limbs** for **lyra** — the tools that do real on-chain work. Every
value-moving call is routed through the deterministic **policy → simulate →
approve → execute** pipeline, and (when a vault is provisioned) sources funds from
the on-chain `Vault` via one of its bounded exits (`vault_transfer`,
`vault_borrow`/`vault_settle`, `vault_spend_capped`), so nothing moves outside the
on-chain `lyra::policy` limits.

- **Wallet / reads** — `account.info`, `sui.balance`
- **Transfers** — `sui.send` (recipient-allowlist aware)
- **Swaps** — `swap` (7k aggregator best-route across Cetus / Turbos / FlowX /
  Bluefin / Aftermath / Momentum / Kriya / DeepBook), `cetus.quote`
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

Auto-installed with [`lyra-ai-agent`](https://www.npmjs.com/package/lyra-ai-agent).
Or directly: `bun add lyra-plugin-onchain`.

The on-chain package it targets lives in
[`lyraai-protocol/contracts`](https://github.com/lyraai-protocol/contracts). See the
[root README](https://github.com/lyraai-protocol/lyra#readme) for the full architecture.
