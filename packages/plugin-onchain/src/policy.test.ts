import { describe, expect, it } from 'bun:test'
import {
  type SuiPolicy,
  type SuiPolicyAction,
  evaluatePolicy,
  normalizeCoinType,
  policyFromEnv,
  suiToMist,
} from './policy'

const ONE_SUI = 1_000_000_000n // 1 SUI in MIST
const SUI = '0x2::sui::SUI'

const send = (over: Partial<SuiPolicyAction> = {}): SuiPolicyAction => ({
  kind: 'transfer',
  coinType: SUI,
  amountMist: ONE_SUI,
  to: '0x1111111111111111111111111111111111111111111111111111111111111111',
  protocol: 'transfer',
  ...over,
})

describe('evaluatePolicy', () => {
  it('allows a compliant native transfer', () => {
    const v = evaluatePolicy(send(), { maxMistPerTx: 2n * ONE_SUI })
    expect(v.allowed).toBe(true)
    expect(v.violations).toHaveLength(0)
    expect(v.requiresApproval).toBe(false)
  })

  it('blocks a transfer over the per-tx cap', () => {
    const v = evaluatePolicy(send({ amountMist: 5n * ONE_SUI }), { maxMistPerTx: 2n * ONE_SUI })
    expect(v.allowed).toBe(false)
    expect(v.violations[0]).toContain('exceeds per-tx cap')
  })

  it('blocks a recipient not in the allowlist', () => {
    const v = evaluatePolicy(send({ to: '0x2222' }), { recipientAllowlist: ['0x1111'] })
    expect(v.allowed).toBe(false)
    expect(v.violations[0]).toContain('not in the recipient allowlist')
  })

  it('allows an allowlisted recipient case-insensitively', () => {
    const v = evaluatePolicy(send({ to: '0xABCD' }), { recipientAllowlist: ['0xabcd'] })
    expect(v.allowed).toBe(true)
  })

  it('blocks a coin not in the coin allowlist', () => {
    const v = evaluatePolicy(send({ coinType: '0xdead::x::X' }), { coinAllowlist: [SUI] })
    expect(v.allowed).toBe(false)
    expect(v.violations[0]).toContain('not in the coin allowlist')
  })

  it('allows SUI by short or padded form against an allowlist', () => {
    const padded = `0x${'0'.repeat(63)}2::sui::SUI`
    expect(evaluatePolicy(send({ coinType: padded }), { coinAllowlist: [SUI] }).allowed).toBe(true)
    expect(evaluatePolicy(send({ coinType: 'native' }), { coinAllowlist: [SUI] }).allowed).toBe(
      true,
    )
  })

  it('blocks a swap whose slippage exceeds the cap', () => {
    const v = evaluatePolicy(
      { kind: 'swap', coinType: SUI, amountMist: ONE_SUI, slippageBps: 300 },
      { maxSlippageBps: 100 },
    )
    expect(v.allowed).toBe(false)
    expect(v.violations[0]).toContain('slippage')
  })

  it('blocks a protocol not in the protocol allowlist', () => {
    const v = evaluatePolicy(send({ protocol: 'cetus' }), {
      protocolAllowlist: ['transfer', 'deepbook'],
    })
    expect(v.allowed).toBe(false)
    expect(v.violations[0]).toContain('not in the protocol allowlist')
  })

  it('blocks everything under a read-only policy', () => {
    expect(evaluatePolicy(send(), { readOnly: true }).allowed).toBe(false)
    expect(evaluatePolicy(send(), { autonomy: 'readonly' }).allowed).toBe(false)
  })

  it('blocks when the policy has expired', () => {
    const v = evaluatePolicy(send(), { expiryMs: 1_000 }, 2_000)
    expect(v.allowed).toBe(false)
    expect(v.violations[0]).toContain('expired')
  })

  it('allows before the policy expires', () => {
    expect(evaluatePolicy(send(), { expiryMs: 5_000 }, 2_000).allowed).toBe(true)
  })

  it('requires approval in the confirm tier', () => {
    const v = evaluatePolicy(send(), { autonomy: 'confirm' })
    expect(v.allowed).toBe(true)
    expect(v.requiresApproval).toBe(true)
  })

  it('escalates to approval when a spend exceeds the auto ceiling', () => {
    const policy: SuiPolicy = { autonomy: 'auto', autoMaxMistPerTx: ONE_SUI / 10n }
    expect(evaluatePolicy(send({ amountMist: ONE_SUI / 100n }), policy).requiresApproval).toBe(
      false,
    )
    expect(evaluatePolicy(send({ amountMist: ONE_SUI }), policy).requiresApproval).toBe(true)
  })
})

describe('coin allowlist — adversarial', () => {
  const A = '0xaaa::coin::A'
  const B = '0xbbb::coin::B'
  const policy: SuiPolicy = { coinAllowlist: [A] }

  it('blocks a swap whose OUTPUT coin is not allowlisted', () => {
    const v = evaluatePolicy({ kind: 'swap', coinType: A, toCoinType: B, amountMist: 1n }, policy)
    expect(v.allowed).toBe(false)
    expect(v.violations.some(s => /output coin/.test(s))).toBe(true)
  })

  it('allows a swap when both legs are allowlisted', () => {
    const v = evaluatePolicy({ kind: 'swap', coinType: A, toCoinType: A, amountMist: 1n }, policy)
    expect(v.allowed).toBe(true)
  })

  it('still blocks a swap whose INPUT coin is not allowlisted', () => {
    const v = evaluatePolicy({ kind: 'swap', coinType: B, toCoinType: A, amountMist: 1n }, policy)
    expect(v.allowed).toBe(false)
  })
})

describe('amount-cap boundaries', () => {
  it('allows exactly at the cap, blocks one MIST over', () => {
    const policy: SuiPolicy = { maxMistPerTx: ONE_SUI }
    expect(evaluatePolicy(send({ amountMist: ONE_SUI }), policy).allowed).toBe(true)
    expect(evaluatePolicy(send({ amountMist: ONE_SUI + 1n }), policy).allowed).toBe(false)
  })

  it('auto tier: no approval exactly at the auto ceiling, approval one MIST over', () => {
    const policy: SuiPolicy = { autoMaxMistPerTx: ONE_SUI }
    expect(evaluatePolicy(send({ amountMist: ONE_SUI }), policy).requiresApproval).toBe(false)
    expect(evaluatePolicy(send({ amountMist: ONE_SUI + 1n }), policy).requiresApproval).toBe(true)
  })
})

describe('suiToMist + normalizeCoinType', () => {
  it('converts decimal SUI to MIST', () => {
    expect(suiToMist('1')).toBe(ONE_SUI)
    expect(suiToMist('0.1')).toBe(ONE_SUI / 10n)
    expect(suiToMist('1.5')).toBe(1_500_000_000n)
    expect(suiToMist('')).toBeUndefined()
    expect(suiToMist('-1')).toBeUndefined()
  })

  it('canonicalizes SUI forms and aliases', () => {
    expect(normalizeCoinType('SUI')).toBe('0x2::sui::sui')
    expect(normalizeCoinType('native')).toBe('0x2::sui::sui')
    expect(normalizeCoinType(`0x${'0'.repeat(63)}2::sui::SUI`)).toBe('0x2::sui::sui')
  })
})

describe('policyFromEnv', () => {
  it('returns undefined when no policy env is set', () => {
    expect(policyFromEnv({})).toBeUndefined()
  })

  it('parses caps, slippage, tier, allowlists and expiry', () => {
    const p = policyFromEnv(
      {
        LYRA_POLICY_MAX_PER_TX_SUI: '1.0',
        LYRA_POLICY_AUTO_MAX_SUI: '0.1',
        LYRA_POLICY_MAX_SLIPPAGE_BPS: '100',
        LYRA_POLICY_AUTONOMY: 'auto',
        LYRA_POLICY_ALLOWED_PROTOCOLS: 'transfer, deepbook, walrus',
        LYRA_POLICY_ALLOWED_COINS: '0x2::sui::SUI',
        LYRA_POLICY_EXPIRY_MINUTES: '60',
      },
      1_000_000,
    )
    expect(p?.maxMistPerTx).toBe(ONE_SUI)
    expect(p?.autoMaxMistPerTx).toBe(ONE_SUI / 10n)
    expect(p?.maxSlippageBps).toBe(100)
    expect(p?.autonomy).toBe('auto')
    expect(p?.protocolAllowlist).toEqual(['transfer', 'deepbook', 'walrus'])
    expect(p?.coinAllowlist).toEqual(['0x2::sui::SUI'])
    expect(p?.expiryMs).toBe(1_000_000 + 60 * 60_000)
  })
})
