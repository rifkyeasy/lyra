import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { brainFromEnv, loadConfig, loadKeypair, mistToSui, policyFromEnv, suiToMist } from 'lyra-core'
import { getBalances, getPolicyState, makeClient } from 'lyra-plugin-sui'
import pc from 'picocolors'

/** Rich status: network, package, agent, balances, config + on-chain policy. */
export async function runStatus(): Promise<void> {
  const cfg = loadConfig()
  const brain = brainFromEnv()
  const policy = policyFromEnv()
  const client = makeClient(cfg.network)
  const addr = process.env.LYRA_AGENT_KEY
    ? loadKeypair(process.env.LYRA_AGENT_KEY).toSuiAddress()
    : null

  console.log(pc.bold(pc.magenta('Lyra')) + pc.dim(' — the AI proposes, Sui policies enforce, Walrus remembers'))
  console.log('')
  console.log(`  ${pc.dim('network')}   ${cfg.network}`)
  console.log(`  ${pc.dim('package')}   ${cfg.packageId || pc.yellow('(unset)')}`)
  console.log(`  ${pc.dim('agent')}     ${addr ?? pc.yellow('(no LYRA_AGENT_KEY)')}`)
  console.log(`  ${pc.dim('brain')}     ${brain.model}${brain.apiKey ? '' : pc.yellow(' (no OPENAI_API_KEY)')}`)

  if (addr) {
    try {
      const balances = await getBalances(client, addr)
      const sui = balances.find((b) => b.symbol === 'SUI')
      const wal = balances.find((b) => b.symbol === 'WAL')
      const parts = [`${sui ? mistToSui(sui.total) : '0'} SUI`]
      if (wal) parts.push(`${mistToSui(wal.total)} WAL`)
      console.log(`  ${pc.dim('balance')}   ${parts.join('  ·  ')}`)
    } catch {
      // network hiccup — skip balances
    }
  }

  const cap = mistToSui(policy.maxNativeMistPerTx ?? suiToMist(0.02))
  console.log('')
  console.log(pc.bold('  policy (config)'))
  console.log(`    per-tx cap   ${cap} SUI`)
  console.log(`    protocols    [${(policy.allowedProtocols ?? []).join(', ')}]`)
  console.log(`    autonomy     ${policy.autonomy ?? 'auto'}`)

  if (existsSync('.lyra/policy.json')) {
    try {
      const ref = JSON.parse(await readFile('.lyra/policy.json', 'utf8'))
      if (ref.packageId === cfg.packageId) {
        const st = await getPolicyState(client, ref.policyId)
        if (st) {
          console.log('')
          console.log(`${pc.bold('  policy (on-chain) ')}${pc.dim(`${ref.policyId.slice(0, 16)}…`)}`)
          console.log(`    status       ${st.revoked ? pc.red('REVOKED') : pc.green('active')}`)
          console.log(`    budget       ${mistToSui(st.remaining)} / ${mistToSui(st.totalDeposited)} SUI remaining`)
          console.log(`    spent        ${mistToSui(st.spent)} SUI  ·  ${st.nonce} actions`)
          console.log(`    expiry       ${st.expiryMs === 0 ? 'none' : new Date(st.expiryMs).toISOString()}`)
        }
      }
    } catch {
      // no readable on-chain policy
    }
  }
}
