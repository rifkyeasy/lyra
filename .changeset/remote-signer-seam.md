---
"lyra-plugin-onchain-one": minor
"lyra-plugin-onchain": minor
---

Add a remote-signer seam to the on-chain tools. `OnchainRuntimeContext` gains an
optional `signBytes(txBytes) => Promise<signature>` hook, and every write tool now
goes through a single `submit()` choke point that prefers it — so agent keys can
live in an isolated signer process (`LYRA_SIGNER_URL`) instead of the app/gateway
process. `keypair` is now optional (set one of `keypair` / `signBytes`); the local
CLI/single-box path is unchanged. Walrus blob storage still requires a local key.
