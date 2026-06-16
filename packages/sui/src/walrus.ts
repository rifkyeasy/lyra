/**
 * Walrus storage for durable, verifiable agent receipts and memory.
 *
 * Lyra writes each decision artifact (the full action record) to Walrus and
 * stores the returned blob id inside the on-chain ActionReceipt. Anyone can then
 * retrieve and verify the artifact from a public aggregator — turning a
 * short-lived action into durable, portable, verifiable memory.
 *
 * We use the HTTP publisher/aggregator API so no WAL balance is required (the
 * publisher sponsors storage). Chain + policy run on mainnet; the artifact layer
 * uses Walrus testnet today. Production mainnet Walrus needs a WAL-funded
 * publisher (see README).
 */

import type { SuiClient } from '@mysten/sui/client'
import type { Signer } from '@mysten/sui/cryptography'
import { WalrusClient } from '@mysten/walrus'

export interface WalrusEndpoints {
  publisher: string
  aggregator: string
}

export const WALRUS_MAINNET_AGGREGATOR = 'https://aggregator.walrus-mainnet.walrus.space'

export const WALRUS_TESTNET: WalrusEndpoints = {
  publisher: 'https://publisher.walrus-testnet.walrus.space',
  aggregator: 'https://aggregator.walrus-testnet.walrus.space',
}

export interface StoredBlob {
  blobId: string
  /** Sui object id of the blob (only when newly created). */
  objectId?: string
  /** Public aggregator URL to retrieve the artifact. */
  url: string
  /** True when the identical blob was already stored on Walrus. */
  alreadyCertified: boolean
}

export function blobUrl(blobId: string, endpoints: WalrusEndpoints = WALRUS_TESTNET): string {
  return `${endpoints.aggregator}/v1/blobs/${blobId}`
}

/** Store bytes/JSON on Walrus and return the blob id + retrieval URL. */
export async function storeBlob(
  data: string | Uint8Array,
  opts: { endpoints?: WalrusEndpoints; epochs?: number } = {},
): Promise<StoredBlob> {
  const ep = opts.endpoints ?? WALRUS_TESTNET
  const epochs = opts.epochs ?? 1
  const res = await fetch(`${ep.publisher}/v1/blobs?epochs=${epochs}`, {
    method: 'PUT',
    body: data,
  })
  if (!res.ok) {
    throw new Error(`Walrus publish failed: ${res.status} ${await res.text()}`)
  }
  const j = (await res.json()) as {
    newlyCreated?: { blobObject?: { blobId: string; id: string } }
    alreadyCertified?: { blobId: string }
  }
  const created = j.newlyCreated?.blobObject
  const certified = j.alreadyCertified
  const blobId = created?.blobId ?? certified?.blobId
  if (!blobId) throw new Error(`Walrus response had no blobId: ${JSON.stringify(j)}`)
  return {
    blobId,
    objectId: created?.id,
    url: blobUrl(blobId, ep),
    alreadyCertified: !!certified,
  }
}

/**
 * Store a blob on Walrus via the SDK, paying storage in WAL from `signer`.
 * This is the fully on-chain mainnet path (no third-party publisher). Returns
 * the blob id, its Sui object id, and a public aggregator retrieval URL.
 */
export async function storeBlobOnChain(
  data: string | Uint8Array,
  opts: {
    suiClient: SuiClient
    signer: Signer
    network?: 'mainnet' | 'testnet'
    epochs?: number
    deletable?: boolean
  },
): Promise<StoredBlob> {
  const network = opts.network ?? 'mainnet'
  const blob = typeof data === 'string' ? new TextEncoder().encode(data) : data
  // @mysten/walrus bundles its own copy of @mysten/sui, so its client and Signer
  // types are nominally incompatible with ours despite being identical at
  // runtime. Bridge through `any` (the demo verifies the real call works).
  // biome-ignore lint/suspicious/noExplicitAny: cross-version SDK type bridge.
  const walrus: any = new WalrusClient({ network, suiClient: opts.suiClient as any })
  const { blobId, blobObject } = await walrus.writeBlob({
    blob,
    deletable: opts.deletable ?? false,
    epochs: opts.epochs ?? 3,
    signer: opts.signer,
  })
  // biome-ignore lint/suspicious/noExplicitAny: blobObject id shape varies across SDK versions.
  const bo = blobObject as any
  const objectId: string | undefined = bo?.id?.id ?? bo?.id
  const aggregator = network === 'mainnet' ? WALRUS_MAINNET_AGGREGATOR : WALRUS_TESTNET.aggregator
  return { blobId, objectId, url: `${aggregator}/v1/blobs/${blobId}`, alreadyCertified: false }
}

/** Retrieve a stored artifact from a Walrus aggregator. */
export async function readBlob(
  blobId: string,
  opts: { endpoints?: WalrusEndpoints } = {},
): Promise<string> {
  const ep = opts.endpoints ?? WALRUS_TESTNET
  const res = await fetch(blobUrl(blobId, ep))
  if (!res.ok) throw new Error(`Walrus read failed: ${res.status}`)
  return res.text()
}
