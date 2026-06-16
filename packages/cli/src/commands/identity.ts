/**
 * `nebula identity` — ERC-8004 (Trustless Agents) on-chain agent identity.
 *
 *   nebula identity card                 build + print the agent card (offline)
 *   nebula identity register [--name N]  register the agent on the Identity Registry
 *   nebula identity show [<agentId>]     resolve an agent (by id, or this agent's EOA)
 *
 * The owner of the identity NFT is the operator wallet; the card's
 * `agentAddress` is the agent EOA. Registry address resolves from
 * NEBULA_IDENTITY_REGISTRY env → baked-in deployment.
 */
import { writeFile } from 'node:fs/promises'
import { cancel, intro, note, outro, spinner } from '@clack/prompts'
import {
  NETWORK_RPC,
  agentIdByAddress,
  buildAgentCard,
  cardToDataUri,
  explorerTxUrl,
  registerAgent,
  resolveAgentById,
  resolveRegistryAddress,
} from 'nebula-ai-core'
import { http, type Address, createPublicClient } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export interface IdentityArgs {
  sub: 'card' | 'register' | 'show'
  agentId?: string
  name?: string
  url?: string
  out?: string
}

export function parseIdentityArgs(argv: string[]): IdentityArgs | { error: string } {
  const sub = argv[0]
  if (sub !== 'card' && sub !== 'register' && sub !== 'show') {
    return { error: `unknown subcommand '${sub ?? '(none)'}' — try: card | register | show` }
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const positional = argv.slice(1).find(a => !a.startsWith('--'))
  return {
    sub,
    agentId: sub === 'show' ? positional : undefined,
    name: flag('--name'),
    url: flag('--url'),
    out: flag('--out'),
  }
}

export async function runIdentity(args: IdentityArgs): Promise<void> {
  const loaded = await findAndLoadConfig()
  if (!loaded) {
    console.error('No nebula.config.ts found. Run `nebula init` first.')
    process.exit(1)
  }
  const { config } = loaded
  const network = config.network
  const agentAddress = config.identity.agent as Address | null

  if (args.sub === 'card') {
    if (!agentAddress) {
      console.error('Config has no agent EOA. Run `nebula init` first.')
      process.exit(1)
    }
    const card = buildAgentCard({
      name: args.name ?? `nebula-${agentAddress.slice(2, 8)}`,
      agentAddress,
      network,
      url: args.url,
    })
    const json = JSON.stringify(card, null, 2)
    if (args.out) {
      await writeFile(args.out, json, 'utf8')
      console.log(`agent card written to ${args.out}`)
    } else {
      console.log(json)
    }
    return
  }

  const registry = resolveRegistryAddress(network)
  if (!registry) {
    console.error(
      `No Identity Registry address for ${network}. Deploy it (contracts/script/DeployIdentityRegistry.s.sol) and set NEBULA_IDENTITY_REGISTRY.`,
    )
    process.exit(1)
  }
  const publicClient = createPublicClient({ transport: http(NETWORK_RPC[network]) })

  if (args.sub === 'show') {
    let id: bigint
    if (args.agentId) {
      id = BigInt(args.agentId)
    } else {
      if (!agentAddress) {
        console.error(
          'Pass an <agentId>, or run `nebula init` so this agent has an EOA to reverse-resolve.',
        )
        process.exit(1)
      }
      id = await agentIdByAddress({ publicClient, registry, agentAddress })
      if (id === 0n) {
        console.log(
          `agent ${agentAddress} is not registered on ${network}. Run \`nebula identity register\`.`,
        )
        return
      }
    }
    const resolved = await resolveAgentById({ publicClient, registry, agentId: id })
    console.log(`agent id   ${resolved.agentId.toString()}`)
    console.log(`owner      ${resolved.owner}`)
    console.log(`agent EOA  ${resolved.agentAddress}`)
    console.log(`registry   ${registry} (${network})`)
    console.log(
      `card       ${resolved.cardURI.slice(0, 80)}${resolved.cardURI.length > 80 ? '…' : ''}`,
    )
    return
  }

  // register
  intro('nebula identity register')
  if (!agentAddress) {
    cancel('Config has no agent EOA. Run `nebula init` first.')
    return
  }
  const existing = await agentIdByAddress({ publicClient, registry, agentAddress })
  if (existing !== 0n) {
    note(
      `agent ${agentAddress} is already registered as id ${existing.toString()}.`,
      'already registered',
    )
    outro('nothing to do')
    return
  }
  const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
  if (!operator) {
    cancel('No operator wallet available; cannot register.')
    return
  }
  const s = spinner()
  s.start('Registering agent identity on the ERC-8004 registry')
  try {
    const walletClient = await operator.walletClient(network)
    const card = buildAgentCard({
      name: args.name ?? `nebula-${agentAddress.slice(2, 8)}`,
      agentAddress,
      network,
      url: args.url,
    })
    const cardURI = args.url ?? cardToDataUri(card)
    const { agentId, txHash } = await registerAgent({
      walletClient,
      publicClient,
      registry,
      cardURI,
      agentAddress,
    })
    s.stop(`registered as agent id ${agentId.toString()}`)
    outro(
      [
        `  agent id   ${agentId.toString()}`,
        `  registry   ${registry} (${network})`,
        `  tx         ${explorerTxUrl(network, txHash)}`,
        '',
        'Resolve with: nebula identity show',
      ].join('\n'),
    )
  } catch (e) {
    s.stop(`register failed: ${(e as Error).message.slice(0, 200)}`)
  } finally {
    await operator.close?.()
  }
}
