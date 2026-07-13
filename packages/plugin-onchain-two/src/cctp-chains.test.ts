import { describe, expect, test } from 'bun:test'
import { whChainName } from './cctp-chains'

describe('whChainName', () => {
  test('applies testnet suffixes', () => {
    expect(whChainName('Base', 'Testnet')).toBe('BaseSepolia')
    expect(whChainName('Ethereum', 'Testnet')).toBe('Sepolia')
    expect(whChainName('Arbitrum', 'Testnet')).toBe('ArbitrumSepolia')
  })

  test('passes mainnet chain names through unchanged', () => {
    expect(whChainName('Base', 'Mainnet')).toBe('Base')
    expect(whChainName('Ethereum', 'Mainnet')).toBe('Ethereum')
  })

  test('falls back to the given name for unmapped chains', () => {
    expect(whChainName('Solana', 'Testnet')).toBe('Solana')
  })
})
