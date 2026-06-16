import { loadConfig } from 'lyra-core'
import { makeClient, queryReceipts } from 'lyra-plugin-sui'
import { WALRUS_MAINNET_AGGREGATOR } from 'lyra-plugin-walrus'
import pc from 'picocolors'

/** Show the on-chain audit trail: recent ActionReceipts + their Walrus artifacts. */
export async function runReceipts(): Promise<void> {
  const cfg = loadConfig()
  const client = makeClient(cfg.network)
  if (!cfg.packageId) {
    console.log(pc.yellow('LYRA_PACKAGE_ID unset'))
    return
  }
  const receipts = await queryReceipts(client, cfg.packageId, 25)
  console.log(pc.bold(`on-chain receipts · ${cfg.network}`) + pc.dim(` (${receipts.length})`))
  if (receipts.length === 0) {
    console.log('  (none yet — run `lyra agent "…"`)')
    return
  }
  for (const r of receipts) {
    const when = r.timestampMs
      ? new Date(r.timestampMs).toISOString().slice(0, 19).replace('T', ' ')
      : ''
    const color = r.status === 'executed' ? pc.green : r.status === 'blocked' ? pc.red : pc.cyan
    console.log(`  ${pc.dim(`#${r.seq}`)} ${color(r.status.padEnd(8))} ${r.protocol.padEnd(9)} ${pc.dim(when)}`)
    if (r.walrusBlob) {
      console.log(`      ${pc.dim(`walrus ${WALRUS_MAINNET_AGGREGATOR}/v1/blobs/${r.walrusBlob}`)}`)
    }
  }
}
