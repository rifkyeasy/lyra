import { cancel, intro, log, outro, spinner } from '@clack/prompts'
import { findAndLoadConfig } from '../config/load'
import { fetchBotInfo, telegramSecretsFromEnv } from '../util/telegram-secrets'

/**
 * `lyra telegram status` — read the env-configured bot token, ping getMe, and
 * report the resolved config.
 */
export async function runTelegramStatus(): Promise<void> {
  intro('lyra telegram status')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No lyra.config.ts found. Run `lyra init` first.')
    return
  }
  const { config } = loaded

  const secrets = telegramSecretsFromEnv()
  if (!secrets) {
    log.warn('No TELEGRAM_BOT_TOKEN in the environment.')
    log.info('Run `lyra telegram setup` for the env vars to set.')
    outro('not configured')
    return
  }

  const sPing = spinner()
  sPing.start('Pinging Telegram getMe')
  try {
    const info = await fetchBotInfo(secrets.botToken)
    sPing.stop(`bot ok: @${info.username} (id ${info.id})`)
  } catch (e) {
    sPing.stop(`getMe failed: ${(e as Error).message.slice(0, 200)}`)
    log.warn('Token may have been revoked at @BotFather. Re-run `lyra telegram setup`.')
    return
  }

  log.info(
    [
      'source           env (TELEGRAM_BOT_TOKEN)',
      `bot username     @${secrets.botUsername ?? '(set TELEGRAM_USERNAME)'}`,
      `allowed user ids ${secrets.allowedUserIds.length === 0 ? '(open access)' : secrets.allowedUserIds.join(', ')}`,
      `plugin enabled   ${(config.plugins ?? []).includes('telegram') ? 'yes' : 'no — add `telegram` to plugins'}`,
    ].join('\n'),
  )

  outro('telegram configured via env')
}
