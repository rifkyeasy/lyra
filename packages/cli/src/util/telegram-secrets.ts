/**
 * Telegram bot helpers for the Sui CLI.
 *
 * On Sui, telegram is configured purely via environment variables — there is
 * no operator wallet to sign-derive an encryption key, so the previous
 * on-disk encrypted-blob flow is gone. The agent reads:
 *
 *   TELEGRAM_BOT_TOKEN   — from @BotFather (required to enable the gateway)
 *   TELEGRAM_CHAT_ID     — optional sole allowed DM user (blank = open access)
 *   TELEGRAM_USERNAME    — optional cached bot @username for nicer status output
 *
 * This module keeps the pure token/allowlist validators plus the Telegram
 * `getMe` probe used by `lyra telegram setup` / `status`.
 */

export interface TelegramEnvSecrets {
  botToken: string
  botUsername?: string
  allowedUserIds: number[]
}

/**
 * Resolve telegram config from the environment, or null when no token is set.
 */
export function telegramSecretsFromEnv(): TelegramEnvSecrets | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return null
  const chatId = process.env.TELEGRAM_CHAT_ID
  return {
    botToken,
    botUsername: process.env.TELEGRAM_USERNAME,
    allowedUserIds: chatId ? [Number(chatId)] : [],
  }
}

const BOT_TOKEN_RE = /^\d{6,15}:[A-Za-z0-9_-]{30,}$/

export function looksLikeBotToken(s: string): boolean {
  return BOT_TOKEN_RE.test(s.trim())
}

export interface ValidatedBotInfo {
  id: number
  username: string
  firstName: string
}

/**
 * Telegram Bot API getMe — cheap, free, no message side-effect. Used by
 * `lyra telegram setup` to validate the token before persisting it AND by
 * `lyra telegram status` to confirm the stored token still works.
 *
 * Throws on non-200 / `ok: false` with a clean error message; caller wraps
 * the throw in a clack spinner.stop().
 */
export async function fetchBotInfo(
  botToken: string,
  opts?: { signal?: AbortSignal },
): Promise<ValidatedBotInfo> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`
  const res = await fetch(url, { signal: opts?.signal })
  if (!res.ok) {
    throw new Error(`getMe HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const body = (await res.json()) as {
    ok: boolean
    description?: string
    result?: { id: number; username?: string; first_name?: string }
  }
  if (!(body.ok && body.result)) {
    throw new Error(`getMe rejected: ${body.description ?? 'unknown error'}`)
  }
  if (!body.result.username) throw new Error('bot has no username; create one in @BotFather')
  return {
    id: body.result.id,
    username: body.result.username,
    firstName: body.result.first_name ?? body.result.username,
  }
}

export function parseAllowedUserIds(
  input: string,
): { ok: true; ids: number[] } | { ok: false; reason: string } {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { ok: true, ids: [] }
  const parts = trimmed
    .split(/[,\s]+/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
  const ids: number[] = []
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return { ok: false, reason: `not a numeric id: "${p}"` }
    const n = Number(p)
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: `not a positive id: "${p}"` }
    ids.push(n)
  }
  // Dedupe, preserve first-seen order.
  return { ok: true, ids: [...new Set(ids)] }
}
