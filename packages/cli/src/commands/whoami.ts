/**
 * `lyra whoami [--owner 0x…]` — resolve which agent wallet belongs to an owner.
 *
 * Multi-tenant identity: an owner's personal wallet deterministically maps to one
 * agent wallet (the SAME derivation the web + Telegram use). This command shows
 * that mapping + the agent's balance so the owner can fund it. The owner proves
 * identity differently per surface (SIWS on web, /link on Telegram, this config
 * on CLI), but they all resolve to the same agent.
 */

import { deriveAgentAddress, makeSuiClient, resolveOwnerVault } from 'lyra-plugin-onchain'
import { resolveNetwork } from '../config/defaults'

export async function runWhoami(opts: { owner?: string }): Promise<void> {
  const owner = opts.owner ?? process.env.LYRA_OWNER_ADDRESS
  if (!owner) {
    console.error('lyra whoami: pass --owner <0x…> (your wallet) or set LYRA_OWNER_ADDRESS')
    process.exit(1)
    return
  }
  let agent: string
  try {
    agent = deriveAgentAddress(owner)
  } catch (e) {
    console.error(`lyra whoami: ${(e as Error).message}`)
    process.exit(1)
    return
  }
  const network = resolveNetwork()
  const client = makeSuiClient(network)
  const [bal, ov] = await Promise.all([
    client.getBalance({ owner: agent }).catch(() => null),
    resolveOwnerVault(owner, network).catch(() => null),
  ])
  const sui = bal ? (Number(bal.totalBalance) / 1e9).toFixed(6) : '?'

  console.log('')
  console.log(`  owner    ${owner}`)
  console.log(`  agent    ${agent}   (gas float ${sui} SUI)`)
  console.log(`  network  ${network}`)
  if (ov) {
    console.log(`  vault    ${ov.vaultId}`)
    console.log(
      `  treasury ${(Number(ov.vaultMist) / 1e9).toFixed(6)} SUI  (policy ${ov.policyId.slice(0, 10)}…)`,
    )
    console.log('')
    console.log('  The agent spends the treasury from the vault via policy-enforced')
    console.log('  vault_spend; you (owner) can withdraw or revoke any time.')
  } else {
    console.log('  vault    not provisioned')
    console.log('')
    console.log('  Provision a non-custodial vault from the web console (owner-signed),')
    console.log('  then the agent spends the treasury under your on-chain AgentPolicy.')
  }
  console.log('')
  console.log('  Same owner → same agent + vault on web + CLI + Telegram (deterministic).')
  console.log('')
}
