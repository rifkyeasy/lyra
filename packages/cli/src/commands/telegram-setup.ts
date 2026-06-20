import { cancel, intro, isCancel, note, outro, password, spinner, text } from '@clack/prompts'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { setDotenvVar } from '../util/dotenv'
import { fetchBotInfo, looksLikeBotToken, parseAllowedUserIds } from '../util/telegram-secrets'

/**
 * `lyra telegram setup` — validate a bot token, enable the plugin, and persist
 * the token to `~/.lyra/.env` (0600) so it's loaded automatically by `lyra` chat
 * AND the `lyra gateway start` daemon — no manual `export` needed.
 */
export async function runTelegramSetup(): Promise<void> {
  intro('lyra telegram setup')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No lyra.config.ts found. Run `lyra init` first.')
    return
  }
  const { config, path: configPath } = loaded

  const token = await password({
    message: 'Bot token (from @BotFather)',
    validate: v => (v && looksLikeBotToken(v) ? undefined : 'Expected a token like 123456:ABC...'),
  })
  if (isCancel(token)) {
    cancel('Aborted.')
    return
  }

  const sPing = spinner()
  sPing.start('Validating token via getMe')
  let info: Awaited<ReturnType<typeof fetchBotInfo>>
  try {
    info = await fetchBotInfo(String(token))
    sPing.stop(`bot ok: @${info.username} (id ${info.id})`)
  } catch (e) {
    sPing.stop(`getMe failed: ${(e as Error).message.slice(0, 200)}`)
    cancel('Token rejected.')
    return
  }

  const idsRaw = await text({
    message: 'Allowed Telegram user id (blank = open access). Sets TELEGRAM_CHAT_ID.',
    placeholder: '',
    validate: v => {
      const r = parseAllowedUserIds(v ?? '')
      return r.ok ? undefined : r.reason
    },
  })
  if (isCancel(idsRaw)) {
    cancel('Aborted.')
    return
  }
  const parsed = parseAllowedUserIds(String(idsRaw ?? ''))
  const chatId = parsed.ok && parsed.ids.length > 0 ? parsed.ids[0] : null

  // Enable the telegram plugin in config so `lyra` loads the listener when the
  // env token is present.
  if (!(config.plugins ?? []).includes('telegram')) {
    await writeConfigTs(configPath, {
      ...config,
      plugins: [...(config.plugins ?? []), 'telegram'],
    })
  }

  // Persist to ~/.lyra/.env (0600) so both `lyra` and the gateway daemon load the
  // token automatically — no manual export.
  const envPath = setDotenvVar('TELEGRAM_BOT_TOKEN', String(token))
  setDotenvVar('TELEGRAM_USERNAME', info.username)
  if (chatId) setDotenvVar('TELEGRAM_CHAT_ID', String(chatId))

  note(
    [
      `Saved to ${envPath} (loaded automatically).`,
      chatId ? `Allowed user id: ${chatId}` : 'Open access (no allowlist).',
      '',
      'Run the bot:',
      '  lyra                — responds while the chat is open',
      '  lyra gateway start  — always-on daemon (responds 24/7)',
      '',
      `Then open https://t.me/${info.username} and send any message.`,
    ].join('\n'),
    'next step',
  )

  outro(`telegram setup validated (@${info.username})`)
}
