import { describe, expect, test } from 'bun:test'
import { type CoinInfo, decimalToBase, resolveCoin, resolveKnown } from './coins'

describe('decimalToBase — strict amount parsing', () => {
  test('parses plain decimals at the coin decimals', () => {
    expect(decimalToBase('1', 9)).toBe(1_000_000_000n)
    expect(decimalToBase('0.1', 9)).toBe(100_000_000n)
    expect(decimalToBase('1.5', 9)).toBe(1_500_000_000n)
    expect(decimalToBase('100', 6)).toBe(100_000_000n) // the old 9-guess made this 1000x
    expect(decimalToBase('0.000001', 6)).toBe(1n)
  })

  test('rejects hex, scientific notation, signs, and empty', () => {
    expect(decimalToBase('0x10', 9)).toBeUndefined()
    expect(decimalToBase('1e3', 9)).toBeUndefined()
    expect(decimalToBase('-1', 9)).toBeUndefined()
    expect(decimalToBase('', 9)).toBeUndefined()
    expect(decimalToBase(undefined, 9)).toBeUndefined()
    expect(decimalToBase('abc', 9)).toBeUndefined()
    expect(decimalToBase('1.2.3', 9)).toBeUndefined()
  })

  test('rejects more fractional digits than the asset has (no silent rounding)', () => {
    expect(decimalToBase('0.0000001', 6)).toBeUndefined() // 7 dp for a 6-dp coin
    expect(decimalToBase('1.1234567890', 9)).toBeUndefined() // 10 dp for a 9-dp coin
  })
})

describe('resolveKnown — registry lookups', () => {
  test('resolves built-in symbols with correct decimals', () => {
    expect(resolveKnown('sui')?.decimals).toBe(9)
    expect(resolveKnown('USDC')?.decimals).toBe(6)
    expect(resolveKnown('deep')?.decimals).toBe(6)
  })
  test('resolves a known full type (padded or short) via the registry', () => {
    expect(resolveKnown('0x2::sui::SUI')?.decimals).toBe(9)
  })
  test('returns undefined for an unknown bare symbol', () => {
    expect(resolveKnown('pepe')).toBeUndefined()
  })
})

describe('resolveCoin — never guesses decimals', () => {
  const client = (decimals: number | null) =>
    ({ getCoinMetadata: async () => (decimals === null ? null : { decimals }) }) as never

  test('an unknown bare symbol resolves to undefined (caller must refuse)', async () => {
    expect(await resolveCoin(client(6), 'pepe')).toBeUndefined()
  })

  test('an unknown full type reads decimals from on-chain metadata', async () => {
    const info = (await resolveCoin(client(8), '0xabc::foo::FOO')) as CoinInfo
    expect(info?.decimals).toBe(8)
  })

  test('an unknown full type with no metadata resolves to undefined (never 9)', async () => {
    expect(await resolveCoin(client(null), '0xabc::bar::BAR')).toBeUndefined()
  })
})
