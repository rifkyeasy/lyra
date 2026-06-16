import { loadConfig, loadKeypair, mistToSui } from 'lyra-core'
import { getBalances, makeClient } from 'lyra-plugin-sui'
import pc from 'picocolors'

/** Show all coin balances for the agent address. */
export async function runBalance(): Promise<void> {
  const cfg = loadConfig()
  if (!process.env.LYRA_AGENT_KEY) {
    console.log(pc.yellow('no LYRA_AGENT_KEY set — run `lyra init`'))
    return
  }
  const addr = loadKeypair(process.env.LYRA_AGENT_KEY).toSuiAddress()
  const client = makeClient(cfg.network)
  const balances = await getBalances(client, addr)
  console.log(pc.bold(`balances · ${cfg.network}`))
  console.log(pc.dim(`  ${addr}`))
  if (balances.length === 0) {
    console.log('  (no coins)')
    return
  }
  for (const b of balances.sort((x, y) => (y.total > x.total ? 1 : -1))) {
    console.log(`  ${pc.cyan(b.symbol.padEnd(8))} ${mistToSui(b.total).padStart(14)}  ${pc.dim(b.coinType)}`)
  }
}
