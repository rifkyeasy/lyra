/**
 * Brain-prompt channel formatting. Mirrors plugin-comms's `<channel source=...>`
 * envelope so the brain can pattern-match across A2A and TG surfaces.
 *
 * Inbound message text from TG is UNTRUSTED user content. We wrap it in
 * channel tags so prompt-injection attempts stay quoted and the brain treats
 * the content as data, not instruction.
 */
export interface FormatTelegramChannelInput {
  chatId: number
  username: string | null
  displayName: string | null
  text: string
}

export function formatTelegramChannel(input: FormatTelegramChannelInput): string {
  const user = input.username ?? input.displayName ?? `id:${input.chatId}`
  const safeUser = escapeAttr(user)
  const safeText = escapeText(input.text)
  return `<channel source="telegram" chat="${input.chatId}" user="${safeUser}">${safeText}</channel>`
}

/**
 * Inverse of `formatTelegramChannel`: strip the channel envelope and return
 * the raw inner text. Used by the gateway's TG slot to feed bypass-command
 * parsing the un-wrapped string (the wrapper would make `parseBypassCommand`'s
 * `startsWith('/')` check fail and silently drop `/yolo` etc).
 *
 * v0.22.0: extracted into plugin-telegram so the regex source lives next to
 * its forward counterpart `formatTelegramChannel`. If we ever change the
 * envelope shape (add fields, swap quoting), both stay in sync.
 *
 * Returns the input unchanged when there is no envelope (idempotent — safe to
 * call on already-stripped or non-TG input).
 */
const CHANNEL_ENVELOPE_RE = /^<channel[^>]*>([\s\S]*)<\/channel>$/
export function stripTelegramChannelEnvelope(text: string): string {
  return text.replace(CHANNEL_ENVELOPE_RE, '$1')
}

/**
 * One-line preview of an inbound TG message for TUI rows + activity log.
 * Truncated to 80 chars; never includes the bot token or any envelope bytes.
 */
export function formatInboundPreview(input: FormatTelegramChannelInput): string {
  const user = input.username ?? input.displayName ?? `id:${input.chatId}`
  const oneLine = input.text.replace(/\s+/g, ' ').trim()
  const cut = oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine
  return `tg @${user}: ${cut}`
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeText(s: string): string {
  // Only escape angle brackets so the brain can't be tricked by literal
  // </channel> in user content. Ampersands stay raw to preserve readability.
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
