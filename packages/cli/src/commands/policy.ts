import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Transaction } from '@mysten/sui/transactions'
import { loadConfig, loadKeypair, mistToSui, SUI_TYPE, suiToMist } from 'lyra-core'
import {
  buildDeposit,
  buildReclaim,
  buildRevoke,
  execute,
  getPolicyState,
  makeClient,
  txUrl,
} from 'lyra-plugin-sui'
import pc from 'picocolors'

/** Manage the agent's on-chain policy: show | revoke | reclaim | topup <sui>. */
export async function runPolicy(argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'show'
  const cfg = loadConfig()
  const client = makeClient(cfg.network)
  const coinType = SUI_TYPE

  if (!existsSync('.lyra/policy.json')) {
    console.log(pc.yellow('No policy yet. Run `lyra init` or `lyra agent "…"` first.'))
    return
  }
  const ref = JSON.parse(await readFile('.lyra/policy.json', 'utf8'))

  if (sub === 'show') {
    const st = await getPolicyState(client, ref.policyId)
    if (!st) {
      console.log('policy object not found on-chain')
      return
    }
    console.log(pc.bold(`policy ${ref.policyId}`))
    console.log(`  owner       ${st.owner}`)
    console.log(`  agent       ${st.agent}`)
    console.log(`  status      ${st.revoked ? pc.red('REVOKED') : pc.green('active')}`)
    console.log(`  budget      ${mistToSui(st.remaining)} / ${mistToSui(st.totalDeposited)} SUI remaining`)
    console.log(`  spent       ${mistToSui(st.spent)} SUI`)
    console.log(`  per-tx cap  ${mistToSui(st.maxPerTx)} SUI`)
    console.log(`  protocols   [${st.allowedProtocols.join(', ')}]`)
    console.log(`  expiry      ${st.expiryMs === 0 ? 'none' : new Date(st.expiryMs).toISOString()}`)
    console.log(`  actions     ${st.nonce}`)
    return
  }

  // mutating subcommands require the owner key
  if (!process.env.LYRA_AGENT_KEY) {
    console.log(pc.yellow('LYRA_AGENT_KEY required for this action'))
    return
  }
  const owner = loadKeypair(process.env.LYRA_AGENT_KEY)
  const args = { packageId: ref.packageId, coinType, policyId: ref.policyId }

  if (sub === 'revoke') {
    const tx = new Transaction()
    buildRevoke(tx, args)
    const res = await execute(client, owner, tx)
    console.log(pc.green(`✓ revoked · ${txUrl(cfg.network, res.digest)}`))
    return
  }
  if (sub === 'reclaim') {
    const tx = new Transaction()
    buildReclaim(tx, args)
    const res = await execute(client, owner, tx)
    console.log(pc.green(`✓ reclaimed remaining budget · ${txUrl(cfg.network, res.digest)}`))
    return
  }
  if (sub === 'topup') {
    const amt = argv[1]
    if (!amt) {
      console.log('usage: lyra policy topup <sui>')
      return
    }
    const tx = new Transaction()
    buildDeposit(tx, { ...args, amountMist: suiToMist(amt) })
    const res = await execute(client, owner, tx)
    console.log(pc.green(`✓ topped up ${amt} SUI · ${txUrl(cfg.network, res.digest)}`))
    return
  }
  console.log(`unknown: lyra policy ${sub}  (show | revoke | reclaim | topup <sui>)`)
}
