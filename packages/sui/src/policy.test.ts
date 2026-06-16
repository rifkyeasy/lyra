import { describe, expect, test } from 'bun:test'
import { evaluatePolicy, type PolicyAction, policyFromEnv, type SuiPolicy } from './policy'

const SUI = '0x2::sui::SUI'
const USDC = '0xabc::usdc::USDC'

const transfer = (over: Partial<PolicyAction> = {}): PolicyAction => ({
  kind: 'transfer',
  protocol: 'transfer',
  coinType: SUI,
  amountRaw: 1_000_000n,
  to: '0xrecipient',
  ...over,
})

describe('evaluatePolicy', () => {
  test('allows a native send within all bounds', () => {
    const v = evaluatePolicy(transfer(), { maxNativeMistPerTx: 2_000_000n, autonomy: 'auto' })
    expect(v.allowed).toBe(true)
    expect(v.requiresApproval).toBe(false)
    expect(v.violations).toHaveLength(0)
  })

  test('blocks a native send over the per-tx cap', () => {
    const v = evaluatePolicy(transfer({ amountRaw: 5_000_000n }), { maxNativeMistPerTx: 2_000_000n })
    expect(v.allowed).toBe(false)
    expect(v.violations.join(' ')).toContain('exceeds per-tx cap')
  })

  test('blocks an unlisted protocol', () => {
    const v = evaluatePolicy(transfer({ protocol: 'cetus' }), { allowedProtocols: ['transfer', 'deepbook'] })
    expect(v.allowed).toBe(false)
    expect(v.violations.join(' ')).toContain('not in the policy allowlist')
  })

  test('allows a listed protocol', () => {
    const v = evaluatePolicy(transfer({ protocol: 'deepbook' }), { allowedProtocols: ['transfer', 'deepbook'] })
    expect(v.allowed).toBe(true)
  })

  test('blocks a non-allowlisted coin but always permits native SUI', () => {
    const policy: SuiPolicy = { coinAllowlist: [USDC] }
    expect(evaluatePolicy(transfer({ coinType: SUI }), policy).allowed).toBe(true)
    const other = evaluatePolicy(transfer({ coinType: '0xdef::other::OTHER' }), policy)
    expect(other.allowed).toBe(false)
    expect(other.violations.join(' ')).toContain('not in the coin allowlist')
  })

  test('checks the swap OUTPUT coin against the allowlist', () => {
    const v = evaluatePolicy(
      { kind: 'swap', protocol: 'deepbook', coinType: SUI, amountRaw: 1n, toCoinType: '0xbad::x::X' },
      { coinAllowlist: [USDC] },
    )
    expect(v.allowed).toBe(false)
    expect(v.violations.join(' ')).toContain('output coin')
  })

  test('enforces the recipient allowlist', () => {
    const policy: SuiPolicy = { recipientAllowlist: ['0xgood'] }
    expect(evaluatePolicy(transfer({ to: '0xgood' }), policy).allowed).toBe(true)
    expect(evaluatePolicy(transfer({ to: '0xbad' }), policy).allowed).toBe(false)
  })

  test('enforces the slippage cap', () => {
    const v = evaluatePolicy(
      { kind: 'swap', protocol: 'deepbook', coinType: SUI, amountRaw: 1n, slippageBps: 300 },
      { maxSlippageBps: 100 },
    )
    expect(v.allowed).toBe(false)
    expect(v.violations.join(' ')).toContain('slippage')
  })

  test('readOnly and readonly-autonomy block all writes', () => {
    expect(evaluatePolicy(transfer(), { readOnly: true }).allowed).toBe(false)
    expect(evaluatePolicy(transfer(), { autonomy: 'readonly' }).allowed).toBe(false)
  })

  test('confirm autonomy requires approval even when allowed', () => {
    const v = evaluatePolicy(transfer(), { autonomy: 'confirm' })
    expect(v.allowed).toBe(true)
    expect(v.requiresApproval).toBe(true)
  })

  test('auto autonomy escalates a native send above the auto ceiling', () => {
    const policy: SuiPolicy = { autonomy: 'auto', autoMaxNativeMistPerTx: 100_000n }
    expect(evaluatePolicy(transfer({ amountRaw: 50_000n }), policy).requiresApproval).toBe(false)
    expect(evaluatePolicy(transfer({ amountRaw: 500_000n }), policy).requiresApproval).toBe(true)
  })

  test('expired policy blocks the action', () => {
    const past = Date.now() - 1
    const v = evaluatePolicy(transfer({ nowMs: Date.now() }), { expiryMs: past })
    expect(v.allowed).toBe(false)
    expect(v.violations.join(' ')).toContain('expired')
  })
})

describe('policyFromEnv', () => {
  test('parses SUI caps into MIST and lists into arrays', () => {
    const p = policyFromEnv({
      LYRA_POLICY_MAX_PER_TX_SUI: '1.5',
      LYRA_POLICY_AUTO_MAX_SUI: '0.1',
      LYRA_POLICY_MAX_SLIPPAGE_BPS: '100',
      LYRA_POLICY_AUTONOMY: 'auto',
      LYRA_POLICY_ALLOWED_PROTOCOLS: 'transfer, deepbook , walrus',
      LYRA_POLICY_ALLOWED_COINS: '0x2::sui::SUI',
    })
    expect(p.maxNativeMistPerTx).toBe(1_500_000_000n)
    expect(p.autoMaxNativeMistPerTx).toBe(100_000_000n)
    expect(p.maxSlippageBps).toBe(100)
    expect(p.autonomy).toBe('auto')
    expect(p.allowedProtocols).toEqual(['transfer', 'deepbook', 'walrus'])
  })

  test('ignores an invalid autonomy value', () => {
    const p = policyFromEnv({ LYRA_POLICY_AUTONOMY: 'banana' })
    expect(p.autonomy).toBeUndefined()
  })
})
