# lyra-plugin-onchain

The single on-chain plugin import for **lyra** — the canonical way to pull in the
Sui tools (reads, transfers, swaps, lending, staking, liquidity, Walrus, vault, and
policy). It re-exports
[`lyra-plugin-onchain-one`](https://www.npmjs.com/package/lyra-plugin-onchain-one)
so callers depend on one stable name instead of an SDK-versioned one.

The plugin is split into SDK-versioned halves — `lyra-plugin-onchain-one` (on
`@mysten/sui` v1) and `lyra-plugin-onchain-two` (v2, the cross-chain bridge path) —
because those `@mysten/sui` majors can't share one dependency tree. This facade
currently passes through v1; the v2 half is folded in once npm-safe v1/v2
coexistence ships.

## Install

Auto-installed with [`lyra-ai-agent`](https://www.npmjs.com/package/lyra-ai-agent).
Or directly:

```bash
bun add lyra-plugin-onchain
```

See the [root README](https://github.com/lyraai-protocol/lyra#readme) for the full
architecture, and [`lyra-plugin-onchain-one`](https://www.npmjs.com/package/lyra-plugin-onchain-one)
for the full tool list.
