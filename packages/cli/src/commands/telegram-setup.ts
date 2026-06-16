import { cancel, intro, note, outro } from '@clack/prompts'
import { placeholderAgentId } from 'nebula-ai-core'
import { type Address, getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { loadOrPickOperatorSigner } from './init/operator-picker'
import { runTelegramStep } from './init/telegram-step'

/**
 * `nebula telegram setup` — standalone entry. Loads the operator wallet, then
 * delegates to `runTelegramStep` (the same helper bundled into `nebula init`'s
 * Phase E). Owns its own intro/outro framing.
 */
export async function runTelegramSetup(): Promise<void> {
  intro('nebula telegram setup')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No nebula.config.ts found. Run `nebula init` first.')
    return
  }
  const { config, path: configPath } = loaded
  if (!config.identity.agent) {
    cancel('Config has no agent. Run `nebula init` first.')
    return
  }

  const agentAddress = getAddress(config.identity.agent) as Address
  const agentId = placeholderAgentId(agentAddress)

  const operator = await loadOrPickOperatorSigner({
    network: config.network,
    hint: config.operator,
  })
  if (!operator) {
    cancel('No operator wallet available; cannot encrypt secrets.')
    return
  }

  let result: Awaited<ReturnType<typeof runTelegramStep>>
  try {
    result = await runTelegramStep({
      signer: operator,
      agentId,
      agentAddress,
      configPath,
      config,
      network: config.network,
    })
  } finally {
    await operator.close?.()
  }

  if (!result.configured) {
    cancel(result.cancelled ? 'Aborted.' : 'Setup failed.')
    return
  }

  note(
    `Open https://t.me/${result.botUsername} in Telegram and send any message.\nThen run \`nebula\` (or \`nebula gateway start\`) to bring the agent online.`,
    'next step',
  )

  outro(`telegram setup complete (@${result.botUsername}, mode: ${result.modeUsed})`)
}
