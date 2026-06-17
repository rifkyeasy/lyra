import { cancel, intro, note, outro } from '@clack/prompts'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'

export interface TelegramRemoveOpts {
  yes?: boolean
}

/**
 * `lyra telegram remove` — disable the telegram plugin in config and remind the
 * operator to unset the env vars. On Sui the token lives only in the
 * environment, so there is no on-disk blob to delete.
 */
export async function runTelegramRemove(_opts: TelegramRemoveOpts = {}): Promise<void> {
  intro('lyra telegram remove')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No lyra.config.ts found. Run `lyra init` first.')
    return
  }
  const { config, path: configPath } = loaded

  const plugins = (config.plugins ?? []).filter(p => p !== 'telegram')
  if (plugins.length !== (config.plugins ?? []).length) {
    await writeConfigTs(configPath, { ...config, plugins })
    note('Removed `telegram` from config.plugins.')
  } else {
    note('telegram plugin was not enabled.')
  }

  note(
    [
      'Unset the env vars to fully disable the bot:',
      '',
      '  unset TELEGRAM_BOT_TOKEN TELEGRAM_USERNAME TELEGRAM_CHAT_ID',
      '',
      'The bot token at @BotFather is STILL VALID. To fully revoke, run /token',
      'in @BotFather and pick "Revoke" for this bot.',
    ].join('\n'),
    'reminder',
  )

  outro('telegram removed')
}
