/**
 * Atomic reaction state machine: 👀 (processing) → 👍 (success) | 👎 (error).
 * Telegram's setMessageReaction REPLACES all bot reactions on the message in
 * one call, so transitions are atomic. No remove step needed.
 *
 * If the bot doesn't have permission to react in the chat (rare for DMs but
 * possible if the user blocks), the call fails silently and message handling
 * continues. We never let a reaction failure abort a brain turn.
 */
import type { Bot } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'

type Emoji = ReactionTypeEmoji['emoji']

export const REACTION_PROCESSING: Emoji = '\u{1F440}' // 👀
export const REACTION_OK: Emoji = '\u{1F44D}' // 👍
export const REACTION_ERR: Emoji = '\u{1F44E}' // 👎

export async function reactProcessing(bot: Bot, chatId: number, messageId: number): Promise<void> {
  await safeSetReaction(bot, chatId, messageId, REACTION_PROCESSING)
}

export async function reactSuccess(bot: Bot, chatId: number, messageId: number): Promise<void> {
  await safeSetReaction(bot, chatId, messageId, REACTION_OK)
}

export async function reactError(bot: Bot, chatId: number, messageId: number): Promise<void> {
  await safeSetReaction(bot, chatId, messageId, REACTION_ERR)
}

export async function clearReaction(bot: Bot, chatId: number, messageId: number): Promise<void> {
  await safeSetReactionEmpty(bot, chatId, messageId)
}

async function safeSetReaction(
  bot: Bot,
  chatId: number,
  messageId: number,
  emoji: Emoji,
): Promise<void> {
  try {
    await bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }])
  } catch {
    // Reaction failures are cosmetic; never block the turn on them.
  }
}

async function safeSetReactionEmpty(bot: Bot, chatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.setMessageReaction(chatId, messageId, [])
  } catch {
    // Same: silent.
  }
}
