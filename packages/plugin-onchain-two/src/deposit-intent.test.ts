import { describe, expect, test } from 'bun:test'
import {
  CCTP_DOMAINS,
  type DepositRequest,
  classifyToken,
  isSupportedSourceChain,
  validateDepositRequest,
} from './deposit-intent'

const VALID: DepositRequest = {
  id: 'dep-1',
  owner: `0x${'a'.repeat(64)}`,
  sourceChain: 'Ethereum',
  sourceToken: 'USDC',
  amount: '100',
}

describe('classifyToken', () => {
  test('USDC (any case) is the native-CCTP route', () => {
    expect(classifyToken('USDC')).toBe('usdc')
    expect(classifyToken('usdc')).toBe('usdc')
    expect(classifyToken(' Usdc ')).toBe('usdc')
  })
  test('anything else needs a Sui-side swap', () => {
    expect(classifyToken('WETH')).toBe('swap')
    expect(classifyToken('PEPE')).toBe('swap')
  })
})

describe('supported chains', () => {
  test('canonical CCTP source domains, Sui excluded (it is the destination)', () => {
    expect(isSupportedSourceChain('Ethereum')).toBe(true)
    expect(isSupportedSourceChain('Base')).toBe(true)
    expect(isSupportedSourceChain('Solana')).toBe(true)
    expect(isSupportedSourceChain('Sui')).toBe(false)
    expect(isSupportedSourceChain('Bitcoin')).toBe(false)
  })
  test('domain numbers are Circle canonical', () => {
    expect(CCTP_DOMAINS.Ethereum).toBe(0)
    expect(CCTP_DOMAINS.Arbitrum).toBe(3)
    expect(CCTP_DOMAINS.Base).toBe(6)
  })
})

describe('validateDepositRequest', () => {
  test('accepts a valid USDC request (no swap needed)', () => {
    const r = validateDepositRequest(VALID)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.deposit.needsSwap).toBe(false)
      expect(r.deposit.id).toBe('dep-1')
      expect(r.deposit.sourceChain).toBe('Ethereum')
    }
  })

  test('marks a non-USDC token as needing a swap', () => {
    const r = validateDepositRequest({ ...VALID, sourceToken: 'WETH' })
    expect(r.ok && r.deposit.needsSwap).toBe(true)
  })

  test('lowercases the owner + trims id/token', () => {
    const r = validateDepositRequest({
      ...VALID,
      owner: `0x${'A'.repeat(64)}`,
      id: '  dep-2  ',
      sourceToken: '  USDC  ',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.deposit.owner).toBe(`0x${'a'.repeat(64)}`)
      expect(r.deposit.id).toBe('dep-2')
      expect(r.deposit.sourceToken).toBe('USDC')
    }
  })

  test('rejects a missing id', () => {
    expect(validateDepositRequest({ ...VALID, id: '  ' })).toEqual({
      ok: false,
      error: 'missing deposit id',
    })
  })

  test('rejects a malformed Sui owner', () => {
    const r = validateDepositRequest({ ...VALID, owner: '0x123' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/invalid Sui owner/)
  })

  test('rejects an unsupported source chain and lists the supported ones', () => {
    const r = validateDepositRequest({ ...VALID, sourceChain: 'Bitcoin' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/unsupported source chain/)
      expect(r.error).toMatch(/Ethereum/)
    }
  })

  test('rejects a non-positive or non-numeric amount', () => {
    expect(validateDepositRequest({ ...VALID, amount: '0' }).ok).toBe(false)
    expect(validateDepositRequest({ ...VALID, amount: '-5' }).ok).toBe(false)
    expect(validateDepositRequest({ ...VALID, amount: 'abc' }).ok).toBe(false)
  })

  test('rejects an amount below the minimum', () => {
    const r = validateDepositRequest({ ...VALID, amount: '0.5' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/minimum/)
  })

  test('rejects a missing source token', () => {
    expect(validateDepositRequest({ ...VALID, sourceToken: '' }).ok).toBe(false)
  })
})
