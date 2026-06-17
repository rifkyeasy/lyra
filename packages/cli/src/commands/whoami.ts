/**
 * `lyra whoami [--owner 0x…]` — resolve which agent wallet belongs to an owner.
 *
 * Multi-tenant identity: an owner's personal wallet deterministically maps to one
 * agent wallet (the SAME derivation the web + Telegram use). This command shows
 * that mapping + the agent's balance so the owner can fund it. The owner proves
 * identity differently per surface (SIWS on web, /link on Telegram, this config
 * on CLI), but they all resolve to the same agent.
 */

import { type SuiNetwork, deriveAgentAddress, makeSuiClient } from 'lyra-plugin-onchain'

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
  const network = (process.env.LYRA_NETWORK as SuiNetwork) ?? 'mainnet'
  const client = makeSuiClient(network)
  const bal = await client.getBalance({ owner: agent }).catch(() => null)
  const sui = bal ? (Number(bal.totalBalance) / 1e9).toFixed(6) : '?'

  console.log('')
  console.log(`  owner    ${owner}`)
  console.log(`  agent    ${agent}`)
  console.log(`  network  ${network}`)
  console.log(`  balance  ${sui} SUI`)
  console.log('')
  console.log('  Same owner → same agent on web + CLI + Telegram (one master secret,')
  console.log('  deterministic derivation). Fund the agent address to let it act under')
  console.log('  your on-chain AgentPolicy.')
  console.log('')
}
