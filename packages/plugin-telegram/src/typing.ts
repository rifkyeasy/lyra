/**
 * Typing-indicator loop for the active brain turn. TG's `chat_action="typing"`
 * auto-expires after ~5 seconds, so we refresh on a 4.5s interval. Fires once
 * immediately so the user sees `typing...` within the first message-handler tick.
 *
 * Errors are swallowed: if `sendChatAction` rate-limits or fails the network
 * call, the loop keeps running and the brain dispatch must NEVER block on a
 * cosmetic indicator.
 *
 * Mirrors hermes' `_keep_typing` (gateway/platforms/base.py), but uses
 * `setInterval` instead of an asyncio task. `clearInterval(timer)` from the
 * returned cancel fn is idempotent.
 */
import type { Bot } from 'grammy'

const TYPING_REFRESH_MS = 4_500

export function startTypingLoop(bot: Bot, chatId: number): () => void {
  const fire = (): void => {
    void bot.api.sendChatAction(chatId, 'typing').catch(() => {
      /* cosmetic; never block dispatch */
    })
  }
  fire()
  const timer = setInterval(fire, TYPING_REFRESH_MS)
  return () => {
    clearInterval(timer)
  }
}

export const TYPING_REFRESH_INTERVAL_MS = TYPING_REFRESH_MS
