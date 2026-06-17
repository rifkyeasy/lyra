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

import {
  type OnchainRuntimeContext,
  type SuiNetwork,
  keypairFromSecret,
  makeSuiClient,
  policyFromEnv,
} from 'lyra-plugin-onchain'

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
export function buildOnchainContext(opts: BuildOnchainOpts): OnchainRuntimeContext {
  const packageId = opts.packageId ?? process.env.LYRA_PACKAGE_ID ?? undefined
  const policyObjectId = opts.policyObjectId ?? process.env.LYRA_POLICY_OBJECT_ID ?? undefined
  return {
    client: makeSuiClient(opts.network),
    keypair: opts.agent.keypair,
    agentAddress: opts.agent.address,
    network: opts.network,
    policy: policyFromEnv(),
    packageId: packageId || undefined,
    policyObjectId: policyObjectId || undefined,
    agentDir: opts.agentDir,
    brainProvider: opts.brainProvider ?? null,
    brainModel: opts.brainModel ?? null,
  }
}
