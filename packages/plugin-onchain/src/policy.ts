/**
 * Deterministic policy engine — Lyra's "verifiable autonomy" core.
 *
 * The project rule (CLAUDE.md): the AI is advisory; fund controls are enforced
 * in deterministic code, NOT by the model. Every write is checked here BEFORE
 * it is simulated/broadcast. The verdict is a pure function of (action, policy)
 * — no network, no model — so it is fully unit-testable and auditable. This is
 * the off-chain mirror of the on-chain `lyra::policy::AgentPolicy`: the same
 * caps, coin/protocol allowlists, and expiry are enforced again in Move so a
 * compromised agent still cannot exceed them.
 *
 * Order of the write pipeline: policy → simulate → (approval) → execute → receipt.
 */

/** 1 SUI = 10^9 MIST. */
export const MIST_PER_SUI = 1_000_000_000n

/** Canonical lowercased coin type for native SUI. */
const SUI_CANON = '0x2::sui::sui'

/**
 * Normalize a coin type for comparison: lowercase, map the `native`/`sui`
 * aliases to the canonical SUI type, and collapse a leading-zero-padded address
 * (`0x000…02::sui::SUI`) to its short form (`0x2::sui::SUI`). The on-chain
 * `type_name` form is fully padded; users write the short form — both compare
 * equal here.
 */
export function normalizeCoinType(input: string): string {
  let t = input.trim().toLowerCase()
  if (t === 'native' || t === 'sui') return SUI_CANON
  const sep = t.indexOf('::')
  if (sep > 0 && t.startsWith('0x')) {
    const addr = t.slice(2, sep).replace(/^0+/, '') || '0'
    t = `0x${addr}${t.slice(sep)}`
  }
  return t
}

const lc = (a: string): string => a.trim().toLowerCase()

export interface SuiPolicy {
  /** Reject every write (read-only agent). */
  readOnly?: boolean
  /** Hard cap on MIST moved per action. */
  maxMistPerTx?: bigint
  /** MIST at/under which the `auto` tier executes without approval. */
  autoMaxMistPerTx?: bigint
  /** If set, only these coin types may be moved/swapped (normalized compare). */
  coinAllowlist?: string[]
  /**
   * If set, only these protocols may be touched. Values are short ids
   * (`transfer`, `deepbook`, `walrus`) or package addresses. Empty = any.
   */
  protocolAllowlist?: string[]
  /** If set, transfers may only go to these recipient addresses. */
  recipientAllowlist?: string[]
  /** Max swap slippage tolerance, in basis points. */
  maxSlippageBps?: number
  /**
   * Autonomy tier:
   *  - 'auto'     execute within caps without asking
   *  - 'confirm'  every write needs human approval
   *  - 'readonly' alias for readOnly=true
   * A spend above `autoMaxMistPerTx` always escalates to approval.
   */
  autonomy?: 'auto' | 'confirm' | 'readonly'
  /** Absolute expiry (epoch ms). Past this, every write is blocked. */
  expiryMs?: number
}

export interface SuiPolicyAction {
  kind: 'transfer' | 'swap'
  /** Coin type of the INPUT asset. `native` / `sui` accepted as aliases. */
  coinType: string
  /** Amount in MIST. */
  amountMist: bigint
  /** Recipient (transfers only). */
  to?: string
  /** Swap OUTPUT coin type — checked against the coin allowlist. */
  toCoinType?: string
  /** Protocol touched (`transfer`, `deepbook`, `walrus`, or a package id). */
  protocol?: string
  /** Swap slippage tolerance in bps. */
  slippageBps?: number
}

export interface PolicyVerdict {
  /** Hard policy violations — if non-empty the action is BLOCKED. */
  violations: string[]
  /** True when the action is permitted to proceed (no violations). */
  allowed: boolean
  /** True when a permitted action still needs human approval before execution. */
  requiresApproval: boolean
}

/**
 * Evaluate a proposed Sui action against the policy. Pure + deterministic.
 * `nowMs` defaults to the wall clock but can be passed for deterministic tests.
 */
export function evaluatePolicy(
  action: SuiPolicyAction,
  policy: SuiPolicy,
  nowMs: number = Date.now(),
): PolicyVerdict {
  const violations: string[] = []
  const readOnly = policy.readOnly || policy.autonomy === 'readonly'
  if (readOnly) violations.push('policy is read-only: all writes are blocked')

  // Coin allowlist — checks the input asset AND, for swaps, the OUTPUT asset,
  // otherwise the agent could swap an allowed coin INTO an arbitrary one.
  if (policy.coinAllowlist?.length) {
    const allowed = policy.coinAllowlist.map(normalizeCoinType)
    if (!allowed.includes(normalizeCoinType(action.coinType))) {
      violations.push(`coin ${action.coinType} is not in the coin allowlist`)
    }
    if (
      action.kind === 'swap' &&
      action.toCoinType !== undefined &&
      !allowed.includes(normalizeCoinType(action.toCoinType))
    ) {
      violations.push(`swap output coin ${action.toCoinType} is not in the coin allowlist`)
    }
  }

  // Protocol allowlist.
  if (policy.protocolAllowlist?.length && action.protocol !== undefined) {
    const allowed = policy.protocolAllowlist.map(lc)
    if (!allowed.includes(lc(action.protocol))) {
      violations.push(`protocol ${action.protocol} is not in the protocol allowlist`)
    }
  }

  // Recipient allowlist (transfers).
  if (policy.recipientAllowlist?.length && action.to) {
    const allowed = policy.recipientAllowlist.map(lc)
    if (!allowed.includes(lc(action.to))) {
      violations.push(`recipient ${action.to} is not in the recipient allowlist`)
    }
  }

  // Per-tx amount cap.
  if (policy.maxMistPerTx !== undefined && action.amountMist > policy.maxMistPerTx) {
    violations.push(
      `amount ${action.amountMist} MIST exceeds per-tx cap ${policy.maxMistPerTx} MIST`,
    )
  }

  // Slippage cap (swaps).
  if (
    action.slippageBps !== undefined &&
    policy.maxSlippageBps !== undefined &&
    action.slippageBps > policy.maxSlippageBps
  ) {
    violations.push(`slippage ${action.slippageBps} bps exceeds max ${policy.maxSlippageBps} bps`)
  }

  // Expiry.
  if (policy.expiryMs !== undefined && nowMs > policy.expiryMs) {
    violations.push(`policy expired at ${new Date(policy.expiryMs).toISOString()}`)
  }

  const allowed = violations.length === 0

  // Approval gate: 'confirm' tier always needs approval; 'auto' escalates only
  // when the spend is above the auto ceiling (material risk).
  let requiresApproval = false
  if (allowed) {
    if (policy.autonomy === 'confirm') {
      requiresApproval = true
    } else if (
      policy.autoMaxMistPerTx !== undefined &&
      action.amountMist > policy.autoMaxMistPerTx
    ) {
      requiresApproval = true
    }
  }

  return { violations, allowed, requiresApproval }
}

/**
 * Strict decimal string → base units (bigint) for a coin with `decimals`. No
 * floats, no rounding: rejects hex, scientific notation, signs, and more
 * fractional digits than the asset has. Returns undefined for anything it can't
 * parse exactly. The shared amount parser for every tool (via `./coins`).
 */
export function decimalToBase(input: string | undefined, decimals: number): bigint | undefined {
  if (input === undefined) return undefined
  const s = input.trim()
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined
  const [whole = '0', frac = ''] = s.split('.')
  if (frac.length > decimals) return undefined
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

/**
 * Parse a decimal SUI string to MIST. Strict (see `decimalToBase`): rejects hex,
 * scientific notation, negatives, and sub-MIST precision.
 */
export function suiToMist(sui?: string): bigint | undefined {
  return decimalToBase(sui, 9)
}

const list = (s?: string): string[] | undefined =>
  s
    ? s
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    : undefined

/**
 * Build a policy from environment variables (operator opt-in). Returns
 * undefined when no policy env is set. `nowMs` seeds the relative expiry.
 *   LYRA_POLICY_READONLY=1
 *   LYRA_POLICY_MAX_PER_TX_SUI=1.0
 *   LYRA_POLICY_AUTO_MAX_SUI=0.1
 *   LYRA_POLICY_MAX_SLIPPAGE_BPS=100
 *   LYRA_POLICY_AUTONOMY=auto|confirm|readonly
 *   LYRA_POLICY_ALLOWED_PROTOCOLS=transfer,deepbook,walrus
 *   LYRA_POLICY_ALLOWED_COINS=0x2::sui::SUI
 *   LYRA_POLICY_RECIPIENT_ALLOWLIST=0xabc...,0xdef...
 *   LYRA_POLICY_EXPIRY_MINUTES=60
 */
export function policyFromEnv(
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): SuiPolicy | undefined {
  const policy: SuiPolicy = {}
  let any = false

  if (env.LYRA_POLICY_READONLY === '1') {
    policy.readOnly = true
    any = true
  }
  const maxPerTx = suiToMist(env.LYRA_POLICY_MAX_PER_TX_SUI)
  if (maxPerTx !== undefined) {
    policy.maxMistPerTx = maxPerTx
    any = true
  }
  const autoMax = suiToMist(env.LYRA_POLICY_AUTO_MAX_SUI)
  if (autoMax !== undefined) {
    policy.autoMaxMistPerTx = autoMax
    any = true
  }
  if (env.LYRA_POLICY_MAX_SLIPPAGE_BPS) {
    const bps = Number(env.LYRA_POLICY_MAX_SLIPPAGE_BPS)
    if (Number.isFinite(bps) && bps >= 0) {
      policy.maxSlippageBps = bps
      any = true
    }
  }
  const autonomy = env.LYRA_POLICY_AUTONOMY
  if (autonomy === 'auto' || autonomy === 'confirm' || autonomy === 'readonly') {
    policy.autonomy = autonomy
    any = true
  }
  const protocols = list(env.LYRA_POLICY_ALLOWED_PROTOCOLS)
  if (protocols) {
    policy.protocolAllowlist = protocols
    any = true
  }
  const coins = list(env.LYRA_POLICY_ALLOWED_COINS)
  if (coins) {
    policy.coinAllowlist = coins
    any = true
  }
  const recipients = list(env.LYRA_POLICY_RECIPIENT_ALLOWLIST)
  if (recipients) {
    policy.recipientAllowlist = recipients
    any = true
  }
  if (env.LYRA_POLICY_EXPIRY_MINUTES) {
    const mins = Number(env.LYRA_POLICY_EXPIRY_MINUTES)
    if (Number.isFinite(mins) && mins > 0) {
      policy.expiryMs = nowMs + mins * 60_000
      any = true
    }
  }
  return any ? policy : undefined
}
