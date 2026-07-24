# lyra-plugin-onchain

## 0.5.1

### Patch Changes

- Align every published package onto a single, shared version line. The CLI, core,
  gateway, and plugins now version and release together (fixed group), so a given
  release number means the same tree across the whole stack.
- Updated dependencies
  - lyra-core@0.5.1
  - lyra-plugin-onchain-one@0.5.1

## 0.4.1

### Patch Changes

- Fix the broken `lyra-plugin-onchain@0.4.0` publish. The facade hard-depended on the
  private, unpublished `lyra-plugin-onchain-two`, so its deps published as `workspace:*`
  and every downstream install (CLI, gateway) failed to resolve. Drop the v2 dependency:
  the facade is now a v1-only pass-through of `lyra-plugin-onchain-one` (the v2 Wormhole
  bridge — which pins @mysten/sui v2 and can't be flattened onto npm alongside v1 — is
  deferred until it ships with proper nested-node_modules coexistence).
  - lyra-core@0.4.1

## 0.4.0

### Minor Changes

- a48698f: Add a remote-signer seam to the on-chain tools. `OnchainRuntimeContext` gains an
  optional `signBytes(txBytes) => Promise<signature>` hook, and every write tool now
  goes through a single `submit()` choke point that prefers it — so agent keys can
  live in an isolated signer process (`LYRA_SIGNER_URL`) instead of the app/gateway
  process. `keypair` is now optional (set one of `keypair` / `signBytes`); the local
  CLI/single-box path is unchanged. Walrus blob storage still requires a local key.

### Patch Changes

- Updated dependencies [a48698f]
  - lyra-plugin-onchain-one@0.4.0
  - lyra-core@0.4.0
  - lyra-plugin-onchain-two@0.0.1
