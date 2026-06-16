/**
 * Deterministic policy engine — the off-chain mirror of the on-chain AgentPolicy.
 *
 * Ported from Nebula (Mantle). It is a PURE function of (action, policy): no
 * network, no model — fully unit-testable and auditable. The same bounds are
 * ALSO enforced on-chain by `lyra::policy::withdraw`; this mirror lets the agent
 * explain and refuse an unsafe action BEFORE it ever builds a PTB. Defense in
 * depth: even if the mirror were bypassed, the Move contract still aborts.
 */

const lc = (s: string): string => s.toLowerCase()

/** Lowercased canonical SUI type, for native-asset detection. */
const SUI = '0x2::sui::sui'

export interface SuiPolicy {
  /** Reject every write. */
  readOnly?: boolean
  /** Hard cap on native SUI per action, in MIST. */
  maxNativeMistPerTx?: bigint
  /** At/under this MIST a native action auto-executes; above it escalates. */
  autoMaxNativeMistPerTx?: bigint
  /** Per-coin hard caps in raw units, keyed by lowercased coin type. */
  maxCoinRawPerTx?: Record<string, bigint>
  /** Allowed coin types (lowercased). SUI permitted by default. */
  coinAllowlist?: string[]
  /** Allowed transfer recipients. */
  recipientAllowlist?: string[]
  /** Allowed protocol tags (e.g. "transfer", "deepbook", "walrus"). */
  allowedProtocols?: string[]
  /** Max swap slippage tolerance, in basis points. */
  maxSlippageBps?: number
  /** Autonomy tier. */
  autonomy?: 'auto' | 'confirm' | 'readonly'
  /** Absolute unix-ms expiry. 0/undefined = no expiry. */
  expiryMs?: number
}

export interface PolicyAction {
  kind: 'transfer' | 'swap' | 'order' | 'store'
  /** Protocol tag for this action; checked against `allowedProtocols`. */
  protocol: string
  /** Input coin type, e.g. "0x2::sui::SUI". */
  coinType: string
  /** Amount in raw units (MIST for SUI). */
  amountRaw: bigint
  /** Recipient (transfers only). */
  to?: string
  /** Output coin type for swaps; also checked against the coin allowlist. */
  toCoinType?: string
  slippageBps?: number
  /** For expiry evaluation; defaults to Date.now(). */
  nowMs?: number
}

export interface PolicyVerdict {
  /** Hard violations — if non-empty the action is BLOCKED. */
  violations: string[]
  allowed: boolean
  /** A permitted action that still needs human approval before execution. */
  requiresApproval: boolean
}

export function evaluatePolicy(action: PolicyAction, policy: SuiPolicy): PolicyVerdict {
  const violations: string[] = []
  const readOnly = policy.readOnly || policy.autonomy === 'readonly'
  if (readOnly) violations.push('policy is read-only: all writes are blocked')

  const coin = lc(action.coinType)
  const isNative = coin === SUI

  // Expiry.
  if (policy.expiryMs && policy.expiryMs > 0) {
    const now = action.nowMs ?? Date.now()
    if (now >= policy.expiryMs) violations.push('policy has expired')
  }

  // Protocol allowlist — the Sui-native scope check mirrored on-chain.
  if (policy.allowedProtocols && policy.allowedProtocols.length > 0) {
    const allowed = policy.allowedProtocols.map(lc)
    if (!allowed.includes(lc(action.protocol))) {
      violations.push(`protocol "${action.protocol}" is not in the policy allowlist`)
    }
  }

  // Coin allowlist (native always permitted; checks output coin for swaps too).
  if (policy.coinAllowlist && policy.coinAllowlist.length > 0) {
    const allowed = policy.coinAllowlist.map(lc)
    if (!isNative && !allowed.includes(coin)) {
      violations.push(`coin ${action.coinType} is not in the coin allowlist`)
    }
    if (
      action.toCoinType &&
      lc(action.toCoinType) !== SUI &&
      !allowed.includes(lc(action.toCoinType))
    ) {
      violations.push(`output coin ${action.toCoinType} is not in the coin allowlist`)
    }
  }

  // Recipient allowlist (transfers).
  if (policy.recipientAllowlist && policy.recipientAllowlist.length > 0 && action.to) {
    const allowed = policy.recipientAllowlist.map(lc)
    if (!allowed.includes(lc(action.to))) {
      violations.push(`recipient ${action.to} is not in the recipient allowlist`)
    }
  }

  // Amount caps.
  if (
    isNative &&
    policy.maxNativeMistPerTx !== undefined &&
    action.amountRaw > policy.maxNativeMistPerTx
  ) {
    violations.push(
      `amount ${action.amountRaw} MIST exceeds per-tx cap ${policy.maxNativeMistPerTx} MIST`,
    )
  }
  if (!isNative && policy.maxCoinRawPerTx) {
    const cap = policy.maxCoinRawPerTx[coin]
    if (cap !== undefined && action.amountRaw > cap) {
      violations.push(`amount ${action.amountRaw} exceeds per-tx cap ${cap} for coin ${coin}`)
    }
  }

  // Slippage cap (swaps).
  if (
    action.slippageBps !== undefined &&
    policy.maxSlippageBps !== undefined &&
    action.slippageBps > policy.maxSlippageBps
  ) {
    violations.push(`slippage ${action.slippageBps} bps exceeds max ${policy.maxSlippageBps} bps`)
  }

  const allowed = violations.length === 0
  let requiresApproval = false
  if (allowed) {
    if (policy.autonomy === 'confirm') {
      requiresApproval = true
    } else if (
      isNative &&
      policy.autoMaxNativeMistPerTx !== undefined &&
      action.amountRaw > policy.autoMaxNativeMistPerTx
    ) {
      requiresApproval = true
    }
  }
  return { violations, allowed, requiresApproval }
}

/** Build a policy from `LYRA_POLICY_*` environment variables. */
export function policyFromEnv(env: Record<string, string | undefined> = process.env): SuiPolicy {
  const toMist = (s?: string): bigint | undefined => {
    if (!s) return undefined
    const n = Number(s)
    if (!Number.isFinite(n) || n < 0) return undefined
    return BigInt(Math.round(n * 1e9))
  }
  const list = (s?: string): string[] | undefined =>
    s
      ? s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined

  const policy: SuiPolicy = {}
  if (env.LYRA_POLICY_READONLY === '1') policy.readOnly = true
  const maxPer = toMist(env.LYRA_POLICY_MAX_PER_TX_SUI)
  if (maxPer !== undefined) policy.maxNativeMistPerTx = maxPer
  const autoMax = toMist(env.LYRA_POLICY_AUTO_MAX_SUI)
  if (autoMax !== undefined) policy.autoMaxNativeMistPerTx = autoMax
  if (env.LYRA_POLICY_MAX_SLIPPAGE_BPS) {
    const b = Number(env.LYRA_POLICY_MAX_SLIPPAGE_BPS)
    if (Number.isFinite(b) && b >= 0) policy.maxSlippageBps = b
  }
  const a = env.LYRA_POLICY_AUTONOMY
  if (a === 'auto' || a === 'confirm' || a === 'readonly') policy.autonomy = a
  policy.allowedProtocols = list(env.LYRA_POLICY_ALLOWED_PROTOCOLS)
  policy.coinAllowlist = list(env.LYRA_POLICY_ALLOWED_COINS)
  policy.recipientAllowlist = list(env.LYRA_POLICY_RECIPIENT_ALLOWLIST)
  const mins = env.LYRA_POLICY_EXPIRY_MINUTES ? Number(env.LYRA_POLICY_EXPIRY_MINUTES) : undefined
  if (mins && Number.isFinite(mins)) policy.expiryMs = Date.now() + mins * 60_000
  return policy
}
