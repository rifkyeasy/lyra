/**
 * Builds the Telegram BotCommand list registered via `bot.api.setMyCommands`.
 * Sourced from the shared `lyra-core` registry, filtered to
 * surfaces:['tg']. Telegram clips command names to 32 chars and descriptions
 * to 256, so we trim defensively. Argument hints are folded into the
 * description because grammY's BotCommand has no separate hint field.
 */

import { commandsForSurface } from 'lyra-core'

export interface TelegramBotCommand {
  command: string
  description: string
}

const NAME_LIMIT = 32
const DESC_LIMIT = 256

export function buildTelegramCommands(): TelegramBotCommand[] {
  const out: TelegramBotCommand[] = []
  for (const c of commandsForSurface('tg')) {
    const name = c.name.slice(0, NAME_LIMIT)
    const hint = c.argHint ? ` <${c.argHint}>` : ''
    const description = `${c.description}${hint}`.slice(0, DESC_LIMIT)
    out.push({ command: name, description })
  }
  return out
}
