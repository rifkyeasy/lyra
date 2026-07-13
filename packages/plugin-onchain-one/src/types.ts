/**
 * Public types for lyra-plugin-onchain. The runtime context is side-banded onto
 * PluginContext under `.onchain` (the harness builds it; the plugin reads it via
 * `(ctx as any).onchain`), keeping PluginContext free of plugin-specific fields.
 */

import type { SuiClient } from '@mysten/sui/client'
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import type { SuiNetwork } from './client'
import type { SuiPolicy } from './policy'

export interface OnchainRuntimeContext {
  /** Sui JSON-RPC client for `network`. */
  client: SuiClient
  /**
   * The agent signer (signs + pays gas) — the local-key path. Optional: when a
   * remote signer is wired via `signBytes`, the master/agent key never enters this
   * process and `keypair` is omitted. Exactly one of `keypair` / `signBytes` must
   * be set; write tools go through `submit()` which prefers `signBytes`.
   */
  keypair?: Ed25519Keypair
  /**
   * Remote-signer hook: sign built transaction bytes for this owner's agent and
   * return the serialized signature. When set, `submit()` builds → signs here →
   * executes, so agent keys stay out of this process (production posture). When
   * unset, signing falls back to `keypair` (CLI / single-box).
   */
  signBytes?: (txBytes: Uint8Array) => Promise<string>
  /** The agent's Sui address, cached (from the keypair or the remote signer). */
  agentAddress: string
  network: SuiNetwork
  /** Deterministic fund-control policy. When set, every write is checked before simulate/execute. */
  policy?: SuiPolicy
  /** Deployed `lyra::policy` package id (for on-chain receipts + policy objects). */
  packageId?: string
  /** Shared `AgentPolicy` object id. When set, writes compose an on-chain receipt + enforcement. */
  policyObjectId?: string
  /**
   * Treasury `Vault<SUI>` object id bound to `policyObjectId`. When set (together
   * with `policyObjectId` + `packageId`), write tools source their SUI from the
   * vault via the policy-gated `vault_spend` instead of the agent's gas coin — so
   * the vault is the single fund source and every deployment is enforced on-chain.
   * When unset, tools fall back to the agent's own SUI (single-key mode).
   */
  vaultId?: string
  /**
   * Additional treasury vaults keyed by NORMALIZED coin type (`normalizeCoinType`)
   * → `Vault<T>` object id, for multi-asset flows. E.g. a `Vault<USDC>` so a swap
   * can `vault_borrow` its SUI input and `vault_settle` the swapped output back
   * into the treasury (zero standing exposure) instead of handing the output to the
   * agent. Populated once the owner provisions the extra asset vault; absent ⇒ the
   * swap falls back to funding from the agent's SUI.
   */
  assetVaultIds?: Record<string, string>
  /**
   * The vault/policy owner address. Audit `ActionReceipt`s from `vault_spend` are
   * sent here (falls back to the agent when unset). The owner also receives any
   * funds swept back to the treasury.
   */
  ownerAddress?: string
  /**
   * Snapshot of the vault's SUI balance (MIST, as a string) at ctx-build time.
   * A funding heuristic: when the vault can't cover an action, tools fall back to
   * the agent's own SUI so the action still works (the on-chain `vault_spend` is
   * the authoritative gate). Absent/`"0"` ⇒ always fall back.
   */
  vaultMist?: string
  /** Walrus network for receipt/memory storage (defaults to `network`). */
  walrusNetwork?: SuiNetwork
  agentDir: string
  /** Optional: brain provider/model, surfaced by account.info. */
  brainProvider?: string | null
  brainModel?: string | null
}
