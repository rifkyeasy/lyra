# lyra-ai-agent

## 0.5.1

### Patch Changes

- Align every published package onto a single, shared version line. The CLI, core,
  gateway, and plugins now version and release together (fixed group), so a given
  release number means the same tree across the whole stack.
- Updated dependencies
  - lyra-core@0.5.1
  - lyra-gateway@0.5.1
  - lyra-plugin-onchain@0.5.1
  - lyra-plugin-system@0.5.1
  - lyra-plugin-telegram@0.5.1

## 0.4.3

### Patch Changes

- Point the default on-chain package id at the upgraded mainnet package
  (`0xcd6943c0…fe15c5`), so the v2 functions — owner-editable spend caps
  (`set_max_per_tx` / `set_budget` / `set_window_budget`) — are reachable without
  setting `LYRA_PACKAGE_ID`.

## 0.4.2

### Patch Changes

- Point web login at `app.lyraai.space` (the console) instead of the bare domain,
  so `lyra login` opens the correct origin.

## 0.4.1

### Patch Changes

- Updated dependencies
  - lyra-plugin-onchain@0.4.1
  - lyra-core@0.4.1
  - lyra-gateway@0.4.1
  - lyra-plugin-system@0.4.1
  - lyra-plugin-telegram@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [a48698f]
  - lyra-plugin-onchain@0.4.0
  - lyra-gateway@0.4.0
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
  - lyra-gateway@0.3.0
  - lyra-plugin-system@0.3.0
  - lyra-plugin-telegram@0.3.0

## 0.2.1

### Patch Changes

- Single tool catalog drives registration, the web tool set, and the guidance.

  Every on-chain tool is now declared once in `catalog.ts` (`{ name, make, web, blurb }`).
  The plugin registers by iterating it, `WEB_TOOL_NAMES` is derived for the console,
  and the agent guidance's capability list is generated from the catalog blurbs — so
  adding a tool is one catalog entry (plus the tool file), and it reaches the CLI,
  gateway, web console, and the model's guidance with no further edits.

- Updated dependencies
  - lyra-plugin-onchain@0.2.1
  - lyra-core@0.2.1
  - lyra-gateway@0.2.1
  - lyra-plugin-system@0.2.1
  - lyra-plugin-telegram@0.2.1

## 0.2.0

### Minor Changes

- Add Walrus (WAL) staking + a single-source protocol registry.

  - New `walrus.stake` / `walrus.unstake` / `walrus.staking` tools: delegate WAL to
    a Walrus storage node's pool (min 1 WAL), through the guarded policy pipeline.
  - Consolidate the protocol allowlist into one `REGISTRY` (deriving PROTOCOL_IDS,
    PROTOCOL_LABELS, ALLOWLISTABLE_PROTOCOLS) + a dependency-free `./protocol-ids`
    subpath export so clients import the allowlist instead of mirroring it.
  - Guidance updated so the agent knows it can list + do WAL staking.

### Patch Changes

- Updated dependencies
  - lyra-plugin-onchain@0.2.0
  - lyra-gateway@0.2.0
  - lyra-core@0.2.0
  - lyra-plugin-system@0.2.0
  - lyra-plugin-telegram@0.2.0

## 0.1.11

### Patch Changes

- Repoint the on-chain integration at the reworked Lyra v1 Move package.

  The Move package was restructured into five focused modules (constants, allowlist,
  receipt, policy, vault) with a per-object version guard and freshly published on
  mainnet. This updates the package id every consumer targets and moves the
  `ActionReceipt` type path from the `policy` module to the new `receipt` module.

- Updated dependencies
  - lyra-plugin-onchain@0.1.11
  - lyra-core@0.1.11
  - lyra-gateway@0.1.11
  - lyra-plugin-system@0.1.11
  - lyra-plugin-telegram@0.1.11
