# lyra-gateway

## 0.4.0

### Patch Changes

- Updated dependencies [a48698f]
  - lyra-plugin-onchain@0.4.0
  - lyra-core@0.4.0
  - lyra-plugin-system@0.4.0
  - lyra-plugin-telegram@0.4.0

## 0.3.0

### Minor Changes

- Security hardening across the agent stack:

  - **Value-moving capability gate**: `ToolDef.movesValue` + a fail-closed catalog (`read: true` marks the read tools). The permission-mode gate (strict/prompt) and the deterministic approval floor now cover EVERY value-moving tool — swap, lending, staking, storage — not just `sui.send`.
  - **Coin decimals resolver**: decimals come from a registry or on-chain `CoinMetadata` and are never guessed (fixes a 1000× amount bug on non-9-decimal coins); strict decimal amount parsing (rejects hex/scientific/precision-loss); swap + cetus refuse unknown coins.
  - **Real swap slippage cap** (previously tautological), default tightened to 0.5%; `volo.unstake` gets the missing policy gate.
  - **Agent-loop runaway guard**: bounded round-trips + tool-calls per turn so a looping/prompt-injected model can't chain unbounded tool calls.

### Patch Changes

- Updated dependencies
  - lyra-core@0.3.0
  - lyra-plugin-onchain@0.3.0
  - lyra-plugin-system@0.3.0
  - lyra-plugin-telegram@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - lyra-plugin-onchain@0.2.1
  - lyra-core@0.2.1
  - lyra-plugin-system@0.2.1
  - lyra-plugin-telegram@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies
  - lyra-plugin-onchain@0.2.0
  - lyra-core@0.2.0
  - lyra-plugin-system@0.2.0
  - lyra-plugin-telegram@0.2.0

## 0.1.11

### Patch Changes

- Updated dependencies
  - lyra-plugin-onchain@0.1.11
  - lyra-core@0.1.11
  - lyra-plugin-system@0.1.11
  - lyra-plugin-telegram@0.1.11
