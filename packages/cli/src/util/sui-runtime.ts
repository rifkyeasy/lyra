/**
 * Sui runtime construction for the CLI.
 *
 * Lyra on Sui keys the agent off a single env secret (`LYRA_AGENT_KEY`, a
 * `suiprivkey1…` bech32 string). That one Ed25519 keypair signs every PTB and
 * pays gas; the deterministic policy (mirrored on-chain by the `lyra::policy`
 * Move package) bounds what it may do. There is no operator wallet, keystore
 * decrypt, or a Sui wallet dance — the agent IS the signer.
 *
 * `buildOnchainContext` assembles the `OnchainRuntimeContext` the
 * lyra-plugin-onchain tools read via `(ctx as any).onchain`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { agentPaths } from 'lyra-core'
import {
  type OnchainRuntimeContext,
  type SuiNetwork,
  keypairFromSecret,
  makeSuiClient,
  policyFromEnv,
  resolveVaultForAgent,
} from 'lyra-plugin-onchain'
import { resolvePackageId, resolvePolicyEnv } from '../config/defaults'

/** Env var holding the agent's Sui secret key (`suiprivkey1…` or base64 seed). */
export const AGENT_KEY_ENV = 'LYRA_AGENT_KEY'

export interface SuiAgent {
  keypair: ReturnType<typeof keypairFromSecret>
  /** `keypair.toSuiAddress()` — 0x + 64 hex. */
  address: string
}

/**
 * Resolve the agent keypair from `LYRA_AGENT_KEY`. Returns null when the env
 * var is unset so callers can print a friendly "run lyra init" message instead
 * of throwing a raw decode error.
 */
export function loadAgentFromEnv(): SuiAgent | null {
  const secret = process.env[AGENT_KEY_ENV]
  if (!secret || secret.trim().length === 0) return null
  const keypair = keypairFromSecret(secret)
  return { keypair, address: keypair.toSuiAddress() }
}

/** Read the on-disk agent secret (`~/.lyra/agent.key`), or null if absent. */
export function readAgentKeyFile(): string | null {
  const path = agentPaths.agentKey
  if (!existsSync(path)) return null
  const secret = readFileSync(path, 'utf8').trim()
  return secret.length > 0 ? secret : null
}

/**
 * Resolve the agent keypair the file-aware way: `LYRA_AGENT_KEY` env wins if
 * set, else the on-disk key at `~/.lyra/agent.key`, else null. This is the
 * loader every command should use — it makes the agent key a zero-env-var
 * concern (`lyra init` / `lyra login` write the file).
 */
export function loadAgent(): SuiAgent | null {
  const fromEnv = loadAgentFromEnv()
  if (fromEnv) return fromEnv
  const secret = readAgentKeyFile()
  if (!secret) return null
  const keypair = keypairFromSecret(secret)
  return { keypair, address: keypair.toSuiAddress() }
}

/**
 * Persist the agent secret (`suiprivkey1…`) to `~/.lyra/agent.key` with mode
 * 0600. Used by `lyra init` (create new) and `lyra login` (device-link).
 */
export function writeAgentKey(suiprivkey: string): string {
  const path = agentPaths.agentKey
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${suiprivkey.trim()}\n`, { mode: 0o600 })
  // writeFileSync's mode is masked by umask on create and ignored when the file
  // already exists — chmod unconditionally so re-runs stay locked down.
  chmodSync(path, 0o600)
  return path
}

export interface BuildOnchainOpts {
  agent: SuiAgent
  network: SuiNetwork
  agentDir: string
  packageId?: string | null
  policyObjectId?: string | null
  brainProvider?: string | null
  brainModel?: string | null
}

/**
 * Build the side-band `OnchainRuntimeContext` consumed by lyra-plugin-onchain.
 * `packageId` / `policyObjectId` default to the env values the Move deploy
 * wrote (`LYRA_PACKAGE_ID` / `LYRA_POLICY_OBJECT_ID`); the off-chain policy
 * mirror comes from `policyFromEnv()` (the `LYRA_POLICY_*` vars).
 */
export async function buildOnchainContext(opts: BuildOnchainOpts): Promise<OnchainRuntimeContext> {
  // packageId: explicit opt wins, then LYRA_PACKAGE_ID, then the deployed
  // mainnet default — so on-chain receipts work with zero env config.
  const packageId = opts.packageId ?? resolvePackageId()
  // Auto-resolve this agent's treasury vault (if provisioned) so DeFi tools draw
  // from the vault via the policy-gated vault_spend; falls back to the agent's own
  // SUI when there's none. Owner-agnostic (found by the agent tag on-chain).
  const vault = await resolveVaultForAgent(opts.agent.address, opts.network).catch(() => null)
  const policyObjectId =
    opts.policyObjectId ?? process.env.LYRA_POLICY_OBJECT_ID ?? vault?.policyId ?? undefined
  return {
    client: makeSuiClient(opts.network),
    keypair: opts.agent.keypair,
    agentAddress: opts.agent.address,
    network: opts.network,
    // Default to the bounded policy when no LYRA_POLICY_* is set (never an
    // unbounded auto-spender out of the box).
    policy: policyFromEnv(resolvePolicyEnv()),
    packageId: packageId || undefined,
    policyObjectId: policyObjectId || undefined,
    vaultId: vault?.vaultId,
    vaultMist: vault?.vaultMist,
    ownerAddress: vault?.owner,
    agentDir: opts.agentDir,
    brainProvider: opts.brainProvider ?? null,
    brainModel: opts.brainModel ?? null,
  }
}
