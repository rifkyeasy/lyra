/**
 * Pure CCTP chain-name mapping — kept separate from `cctp-executor` (which imports the
 * Wormhole SDK, unloadable under Bun) so this stays unit-testable.
 */

export type CctpNetwork = 'Mainnet' | 'Testnet'

/** Our canonical (mainnet) source-chain name → the Wormhole chain name on testnet. */
const TESTNET_CHAIN: Record<string, string> = {
  Ethereum: 'Sepolia',
  Optimism: 'OptimismSepolia',
  Arbitrum: 'ArbitrumSepolia',
  Base: 'BaseSepolia',
  Polygon: 'PolygonSepolia',
  Avalanche: 'Avalanche', // Fuji
}

/** The Wormhole chain name for `sourceChain` on `network` (testnet suffixes applied). */
export function whChainName(sourceChain: string, network: CctpNetwork): string {
  return network === 'Testnet' ? (TESTNET_CHAIN[sourceChain] ?? sourceChain) : sourceChain
}
