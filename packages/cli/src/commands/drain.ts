import { cancel, confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts'
import { NETWORK_RPC, drainAgentEOA, explorerTxUrl } from 'nebula-ai-core'
import { http, type Address, createPublicClient, formatEther, isAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { withSilencedConsole } from '../util/silence-console'
import { unlockAgentSigner } from './_unlock'

export interface DrainOpts {
  /** Target address. If omitted, defaults to the operator wallet on this config. */
  to?: string
  /** Skip the destructive confirmation prompt. */
  yes?: boolean
}

export async function runDrain(opts: DrainOpts): Promise<void> {
  intro('nebula drain')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No nebula.config.ts found. Run `nebula init` first.')
    return
  }
  const { config } = loaded
  if (!config.identity.agent) {
    cancel('Config has no agent. Run `nebula init` first.')
    return
  }

  const network = config.network
  const agentAddress = config.identity.agent as Address

  const targetRaw = opts.to ?? (config.identity.operator as string | undefined)
  if (!targetRaw) {
    cancel('No --to address provided and config has no operator. Pass --to <0x...>.')
    return
  }
  if (!isAddress(targetRaw)) {
    cancel(`--to is not a valid address: ${targetRaw}`)
    return
  }
  const to = targetRaw as Address

  const publicClient = createPublicClient({ transport: http(NETWORK_RPC[network]) })
  const before = await publicClient.getBalance({ address: agentAddress })
  log.info(
    [
      `agent      ${agentAddress}`,
      `balance    ${formatEther(before)} Mantle`,
      `target     ${to}`,
      `network    ${network}`,
    ].join('\n'),
  )

  if (before === 0n) {
    log.warn('Agent EOA already empty.')
    outro('nothing to drain')
    return
  }

  if (!opts.yes) {
    const ok = (await confirm({
      message: `Sweep agent EOA balance (${formatEther(before)} Mantle minus gas) to ${to}?`,
      initialValue: false,
    })) as boolean | symbol
    if (isCancel(ok) || !ok) {
      cancel('Aborted.')
      return
    }
  }

  const unlocked = await unlockAgentSigner(config)
  if (!unlocked) return
  try {
    const sSweep = spinner()
    sSweep.start(`Sweeping agent EOA → ${to}`)
    try {
      const result = await withSilencedConsole(() =>
        drainAgentEOA({ network, privkeyHex: unlocked.agentPrivkey, to }),
      )
      sSweep.stop(
        `swept ${formatEther(result.amountSent)} Mantle (gas reserved ${formatEther(result.gasReserved)} Mantle) → ${explorerTxUrl(network, result.txHash)}`,
      )
      outro(`agent ${agentAddress} drained to ${to}`)
    } catch (e) {
      sSweep.stop(`sweep failed: ${(e as Error).message.slice(0, 160)}`)
    }
  } finally {
    await unlocked.close()
  }
}
