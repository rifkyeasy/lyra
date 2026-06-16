import { getFullnodeUrl } from '@mysten/sui/client'

export type Network = 'testnet' | 'mainnet'

/** Canonical SUI coin type and well-known system object ids. */
export const SUI_TYPE = '0x2::sui::SUI'
export const CLOCK_ID = '0x6'
export const MIST_PER_SUI = 1_000_000_000n

export interface LyraConfig {
  network: Network
  rpcUrl: string
  /** Deployed `lyra` package id (the on-chain policy module lives here). */
  packageId: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): LyraConfig {
  const network = (env.LYRA_NETWORK as Network) || 'testnet'
  const packageId = env.LYRA_PACKAGE_ID || ''
  return { network, rpcUrl: getFullnodeUrl(network), packageId }
}

/** SUI (as a decimal string, e.g. "0.5") → MIST bigint. */
export function suiToMist(sui: number | string): bigint {
  const n = typeof sui === 'string' ? Number(sui) : sui
  return BigInt(Math.round(n * 1e9))
}

/** MIST → SUI decimal string for display. */
export function mistToSui(mist: bigint): string {
  const whole = mist / MIST_PER_SUI
  const frac = mist % MIST_PER_SUI
  return `${whole}.${frac.toString().padStart(9, '0').replace(/0+$/, '') || '0'}`
}
