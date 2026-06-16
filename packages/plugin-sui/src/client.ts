import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import type { Network } from 'lyra-core'

export function makeClient(network: Network): SuiClient {
  return new SuiClient({ url: getFullnodeUrl(network) })
}

/** Block explorer link for a transaction digest. */
export function txUrl(network: Network, digest: string): string {
  return `https://suiscan.xyz/${network}/tx/${digest}`
}

/** Block explorer link for an object id. */
export function objectUrl(network: Network, id: string): string {
  return `https://suiscan.xyz/${network}/object/${id}`
}
