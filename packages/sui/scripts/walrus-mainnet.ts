/** Smoke test: store a blob on MAINNET Walrus via the SDK (pays WAL), read back. */
import { loadConfig, loadKeypair, makeClient, storeBlobOnChain } from '../src/index'

const cfg = loadConfig()
const client = makeClient('mainnet')
const signer = loadKeypair(process.env.LYRA_AGENT_KEY!)

const artifact = JSON.stringify({ kind: 'lyra.smoke', network: 'mainnet', ts: new Date().toISOString() })
console.log('writing to mainnet Walrus (pays WAL)…')
const r = await storeBlobOnChain(artifact, { suiClient: client, signer, network: 'mainnet', epochs: 2 })
console.log('blobId   :', r.blobId)
console.log('objectId :', r.objectId)
console.log('url      :', r.url)

console.log('reading back from mainnet aggregator…')
const res = await fetch(r.url)
console.log('read status:', res.status)
console.log('content    :', (await res.text()).slice(0, 200))
