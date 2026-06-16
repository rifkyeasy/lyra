import { cancel, confirm, intro, isCancel, note, outro } from '@clack/prompts'
import { placeholderAgentId } from 'nebula-ai-core'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import {
  removeTelegramSecrets,
  telegramSecretsExist,
  telegramSecretsPath,
} from '../util/telegram-secrets'

export interface TelegramRemoveOpts {
  yes?: boolean
}

export async function runTelegramRemove(opts: TelegramRemoveOpts = {}): Promise<void> {
  intro('nebula telegram remove')

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

  const agentId = placeholderAgentId(config.identity.agent)

  if (!telegramSecretsExist(agentId)) {
    note('Nothing to remove.')
    outro('not configured')
    return
  }

  if (!opts.yes) {
    const ok = (await confirm({
      message: `Delete encrypted telegram-secrets for ${agentId}?`,
      initialValue: false,
    })) as boolean | symbol
    if (isCancel(ok) || !ok) {
      cancel('Aborted.')
      return
    }
  }

  await removeTelegramSecrets(agentId)

  const plugins = (config.plugins ?? []).filter(p => p !== 'telegram')
  if (plugins.length !== (config.plugins ?? []).length) {
    const updated = { ...config, plugins }
    await writeConfigTs(configPath, updated)
  }

  note(
    `Local blob deleted: ${telegramSecretsPath(agentId)}\nThe bot token at @BotFather is STILL VALID. To fully revoke, run /token in\n@BotFather and pick "Revoke" for this bot.`,
    'reminder',
  )

  outro('telegram removed')
}
