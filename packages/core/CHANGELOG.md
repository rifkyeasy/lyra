# lyra-core

## 0.5.1

### Patch Changes

- Align every published package onto a single, shared version line. The CLI, core,
  gateway, and plugins now version and release together (fixed group), so a given
  release number means the same tree across the whole stack.

## 0.4.1

## 0.4.0

## 0.3.0

### Minor Changes

- Security hardening across the agent stack:

  - **Value-moving capability gate**: `ToolDef.movesValue` + a fail-closed catalog (`read: true` marks the read tools). The permission-mode gate (strict/prompt) and the deterministic approval floor now cover EVERY value-moving tool — swap, lending, staking, storage — not just `sui.send`.
  - **Coin decimals resolver**: decimals come from a registry or on-chain `CoinMetadata` and are never guessed (fixes a 1000× amount bug on non-9-decimal coins); strict decimal amount parsing (rejects hex/scientific/precision-loss); swap + cetus refuse unknown coins.
  - **Real swap slippage cap** (previously tautological), default tightened to 0.5%; `volo.unstake` gets the missing policy gate.
  - **Agent-loop runaway guard**: bounded round-trips + tool-calls per turn so a looping/prompt-injected model can't chain unbounded tool calls.

## 0.2.1

## 0.2.0

## 0.1.11
