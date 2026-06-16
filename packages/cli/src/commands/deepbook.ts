import { getSummary } from 'lyra-plugin-deepbook'
import pc from 'picocolors'

/** Show live DeepBook (Sui mainnet) market context from the indexer. */
export async function runDeepbook(): Promise<void> {
  console.log(pc.bold('DeepBook · Sui mainnet') + pc.dim(' — top pools by 24h quote volume'))
  try {
    const summary = await getSummary()
    const top = summary
      .filter((s) => s.quoteVolume)
      .sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
      .slice(0, 12)
    if (top.length === 0) {
      console.log('  (no pools returned)')
      return
    }
    for (const t of top) {
      const price = t.lastPrice != null ? `price ${t.lastPrice}` : ''
      const vol = t.quoteVolume != null ? pc.dim(`vol ${Math.round(t.quoteVolume).toLocaleString()}`) : ''
      console.log(`  ${pc.cyan(t.pool.padEnd(18))} ${price.padEnd(20)} ${vol}`)
    }
  } catch (e) {
    console.log(pc.yellow(`  could not reach DeepBook indexer: ${(e as Error).message}`))
  }
}
