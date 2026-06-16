import { cancel, intro, log, outro, spinner } from '@clack/prompts'
import { placeholderAgentId } from 'nebula-ai-core'
import { type Address, getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'
import {
  fetchBotInfo,
  loadTelegramSecrets,
  telegramSecretsExist,
  telegramSecretsPath,
} from '../util/telegram-secrets'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export async function runTelegramStatus(): Promise<void> {
  intro('nebula telegram status')

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

  const agentAddress = getAddress(config.identity.agent) as Address
  const agentId = placeholderAgentId(agentAddress)
  const path = telegramSecretsPath(agentId)

  if (!telegramSecretsExist(agentId)) {
    log.warn(`No telegram secrets stored for ${agentId}.`)
    log.info(`Expected at: ${path}\nRun \`nebula telegram setup\` to configure.`)
    outro('not configured')
    return
  }

  const operator = await loadOrPickOperatorSigner({
    network: config.network,
    hint: config.operator,
  })
  if (!operator) {
    cancel('No operator wallet available; cannot decrypt secrets.')
    return
  }

  const sLoad = spinner()
  sLoad.start('Decrypting telegram secrets via operator wallet')
  let secrets: Awaited<ReturnType<typeof loadTelegramSecrets>>
  try {
    secrets = await loadTelegramSecrets({ signer: operator, agentAddress, agentId })
    sLoad.stop('decrypted')
  } catch (e) {
    sLoad.stop(`decrypt failed: ${(e as Error).message.slice(0, 200)}`)
    await operator.close?.()
    return
  } finally {
    await operator.close?.()
  }
  if (!secrets) {
    cancel('Empty telegram-secrets blob.')
    return
  }

  const sPing = spinner()
  sPing.start('Pinging Telegram getMe')
  try {
    const info = await fetchBotInfo(secrets.botToken)
    sPing.stop(`bot ok: @${info.username} (id ${info.id})`)
  } catch (e) {
    sPing.stop(`getMe failed: ${(e as Error).message.slice(0, 200)}`)
    log.warn('Token may have been revoked at @BotFather. Re-run `nebula telegram setup`.')
    return
  }

  log.info(
    [
      `path             ${path}`,
      `bot username     @${secrets.botUsername ?? '(unknown)'}`,
      `bot id           ${secrets.botId ?? '(unknown)'}`,
      `allowed user ids ${secrets.allowedUserIds.length === 0 ? '(open access)' : secrets.allowedUserIds.join(', ')}`,
      `plugin enabled   ${(config.plugins ?? []).includes('telegram') ? 'yes' : 'no — add `telegram` to plugins'}`,
    ].join('\n'),
  )

  outro(`telegram configured for ${agentId}`)
}
