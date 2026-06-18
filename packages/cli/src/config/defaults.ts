/**
 * Zero-env-var defaults for the Lyra CLI.
 *
 * The whole point of `lyra init` is that a fresh user runs ONE prompt and the
 * CLI works with no env vars. Every value here is the fallback used when the
 * corresponding `LYRA_*` / `OPENAI_*` env var is unset. Env still WINS when set
 * — these are last-resort defaults, never overrides.
 */

/** Deployed `lyra::policy` Move package on mainnet (on-chain receipts). */
export const DEFAULT_PACKAGE_ID =
  '0x8e984145d636037cebf5c402ac4b338567411ba6dd275948d7ff593b1ed01a04'

/** Default Sui network. */
export const DEFAULT_NETWORK = 'mainnet' as const

/** Default OpenAI-compatible LLM endpoint + model. */
export const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_LLM_MODEL = 'gpt-4o-mini'

/** Default deterministic policy bounds (mirrored on-chain by `lyra::policy`). */
export const DEFAULT_MAX_PER_TX_SUI = 1
export const DEFAULT_AUTO_MAX_SUI = 0.1
export const DEFAULT_MAX_SLIPPAGE_BPS = 100
export const DEFAULT_ALLOWED_COINS = ['0x2::sui::SUI']
export const DEFAULT_ALLOWED_PROTOCOLS = [
  'transfer',
  'swap',
  'deepbook',
  'scallop',
  'navi',
  'walrus',
]

/**
 * Resolve the package id: env override first, then the deployed default. Always
 * returns a concrete id so on-chain receipts work with zero config.
 */
export function resolvePackageId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.LYRA_PACKAGE_ID
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : DEFAULT_PACKAGE_ID
}

/** Resolve the network: env override first, then `mainnet`. */
export function resolveNetwork(env: NodeJS.ProcessEnv = process.env): 'mainnet' | 'testnet' {
  const fromEnv = env.LYRA_NETWORK
  return fromEnv === 'testnet' || fromEnv === 'mainnet' ? fromEnv : DEFAULT_NETWORK
}

/** Resolve the LLM base URL: env override first, then the OpenAI endpoint. */
export function resolveLlmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.LYRA_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL
}

/** Resolve the LLM model: env override first, then `gpt-4o-mini`. */
export function resolveLlmModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LYRA_LLM_MODEL ?? DEFAULT_LLM_MODEL
}

/**
 * Build a `LYRA_POLICY_*`-shaped env record from the defaults, used only to seed
 * `policyFromEnv` when the user has not set ANY `LYRA_POLICY_*` var. This keeps
 * the agent bounded out of the box (never an unbounded auto-spender).
 */
export function defaultPolicyEnv(): Record<string, string> {
  return {
    LYRA_POLICY_MAX_PER_TX_SUI: String(DEFAULT_MAX_PER_TX_SUI),
    LYRA_POLICY_AUTO_MAX_SUI: String(DEFAULT_AUTO_MAX_SUI),
    LYRA_POLICY_MAX_SLIPPAGE_BPS: String(DEFAULT_MAX_SLIPPAGE_BPS),
    LYRA_POLICY_ALLOWED_COINS: DEFAULT_ALLOWED_COINS.join(','),
    LYRA_POLICY_ALLOWED_PROTOCOLS: DEFAULT_ALLOWED_PROTOCOLS.join(','),
  }
}

/** True when the user set no `LYRA_POLICY_*` var (so defaults should apply). */
export function hasNoPolicyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return !Object.keys(env).some(k => k.startsWith('LYRA_POLICY_'))
}

/**
 * Resolve the deterministic policy env: the user's `LYRA_POLICY_*` vars if ANY
 * are set, otherwise the bounded defaults. Pass the result to `policyFromEnv`.
 */
export function resolvePolicyEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return hasNoPolicyEnv(env) ? { ...env, ...defaultPolicyEnv() } : env
}
