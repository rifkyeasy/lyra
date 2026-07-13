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
 * True when `value` is NOT in a non-empty allowlist (i.e. a violation). An empty
 * or absent allowlist means "any", so it never violates. Uses a Set for lookup.
 */
function outsideAllowlist(
  allowlist: string[] | undefined,
  value: string,
  normalize: (s: string) => string,
): boolean {
  if (!allowlist?.length) return false
  return !new Set(allowlist.map(normalize)).has(normalize(value))
}

/** Keep the message from each `[failed, message]` pair whose condition is true. */
function collect(checks: ReadonlyArray<readonly [boolean, string]>): string[] {
  return checks.filter(([failed]) => failed).map(([, message]) => message)
}

/**
 * Convenience for the write tools: run `evaluatePolicy` (skipped when no policy is
 * configured) and return a ready `policy blocked: …` message, or null when allowed.
 * Lets a handler do `const blocked = policyBlock(...); if (blocked) return { ok:false, error: blocked }`.
 */
export function policyBlock(policy: SuiPolicy | undefined, action: SuiPolicyAction): string | null {
  if (!policy) return null
  const verdict = evaluatePolicy(action, policy)
  return verdict.allowed ? null : `policy blocked: ${verdict.violations.join('; ')}`
}

export function evaluatePolicy(
  action: SuiPolicyAction,
  policy: SuiPolicy,
  nowMs: number = Date.now(),
): PolicyVerdict {
  const readOnly = policy.readOnly === true || policy.autonomy === 'readonly'
  const expired = policy.expiryMs !== undefined && nowMs > policy.expiryMs
  const violations = collect([
    [readOnly, 'policy is read-only: all writes are blocked'],
    [
      outsideAllowlist(policy.coinAllowlist, action.coinType, normalizeCoinType),
      `coin ${action.coinType} is not in the coin allowlist`,
    ],
    [
      action.kind === 'swap' &&
        action.toCoinType !== undefined &&
        outsideAllowlist(policy.coinAllowlist, action.toCoinType, normalizeCoinType),
      `swap output coin ${action.toCoinType} is not in the coin allowlist`,
    ],
    [
      action.protocol !== undefined &&
        outsideAllowlist(policy.protocolAllowlist, action.protocol, lc),
      `protocol ${action.protocol} is not in the protocol allowlist`,
    ],
    [
      action.to !== undefined && outsideAllowlist(policy.recipientAllowlist, action.to, lc),
      `recipient ${action.to} is not in the recipient allowlist`,
    ],
    [
      policy.maxMistPerTx !== undefined && action.amountMist > policy.maxMistPerTx,
      `amount ${action.amountMist} MIST exceeds per-tx cap ${policy.maxMistPerTx} MIST`,
    ],
    [
      action.slippageBps !== undefined &&
        policy.maxSlippageBps !== undefined &&
        action.slippageBps > policy.maxSlippageBps,
      `slippage ${action.slippageBps} bps exceeds max ${policy.maxSlippageBps} bps`,
    ],
    [
      expired,
      `policy expired at ${policy.expiryMs ? new Date(policy.expiryMs).toISOString() : ''}`,
    ],
  ])

  const allowed = violations.length === 0
  // Approval gate: 'confirm' always needs approval; 'auto' escalates only above the
  // auto ceiling (material risk).
  const overAutoCeiling =
    policy.autoMaxMistPerTx !== undefined && action.amountMist > policy.autoMaxMistPerTx
  const requiresApproval = allowed && (policy.autonomy === 'confirm' || overAutoCeiling)

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
/** Parse a numeric env value, keeping it only when finite and `ok(n)`. */
function envNum(s: string | undefined, ok: (n: number) => boolean): number | undefined {
  if (!s) return undefined
  const n = Number(s)
  return Number.isFinite(n) && ok(n) ? n : undefined
}

/** `{ key: value }` when `value` is defined, else `{}` — for building a policy by spread. */
function field<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

export function policyFromEnv(
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): SuiPolicy | undefined {
  const autonomy = env.LYRA_POLICY_AUTONOMY
  const slippage = envNum(env.LYRA_POLICY_MAX_SLIPPAGE_BPS, n => n >= 0)
  const expiryMins = envNum(env.LYRA_POLICY_EXPIRY_MINUTES, n => n > 0)
  const policy: SuiPolicy = {
    ...field('readOnly', env.LYRA_POLICY_READONLY === '1' ? true : undefined),
    ...field('maxMistPerTx', suiToMist(env.LYRA_POLICY_MAX_PER_TX_SUI)),
    ...field('autoMaxMistPerTx', suiToMist(env.LYRA_POLICY_AUTO_MAX_SUI)),
    ...field('maxSlippageBps', slippage),
    ...field(
      'autonomy',
      autonomy === 'auto' || autonomy === 'confirm' || autonomy === 'readonly'
        ? autonomy
        : undefined,
    ),
    ...field('protocolAllowlist', list(env.LYRA_POLICY_ALLOWED_PROTOCOLS)),
    ...field('coinAllowlist', list(env.LYRA_POLICY_ALLOWED_COINS)),
    ...field('recipientAllowlist', list(env.LYRA_POLICY_RECIPIENT_ALLOWLIST)),
    ...field('expiryMs', expiryMins === undefined ? undefined : nowMs + expiryMins * 60_000),
  }
  return Object.keys(policy).length > 0 ? policy : undefined
}
