/**
 * Telegram interface for the Lyra agent — the same policy-bound agent, driven
 * from your phone. A dependency-free long-poll loop over the Bot API: each
 * inbound message is handed to `onMessage` (which runs the agent), and the
 * result is sent back. An optional allow-list restricts who can drive it.
 */

export interface TelegramOpts {
  token: string
  /** If set, only this chat id may drive the agent. */
  allowedChatId?: string
  /** Handle an inbound message; return the reply text. */
  onMessage: (text: string, ctx: { chatId: number }) => Promise<string>
  log?: (s: string) => void
}

// biome-ignore lint/suspicious/noExplicitAny: Telegram API payloads are dynamic.
type Json = any

export async function startTelegram(opts: TelegramOpts): Promise<void> {
  const api = (method: string) => `https://api.telegram.org/bot${opts.token}/${method}`
  const log = opts.log ?? (() => {})

  const send = async (chatId: number, text: string): Promise<void> => {
    await fetch(api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Telegram caps messages at 4096 chars.
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
    })
  }

  const meRes = (await (await fetch(api('getMe'))).json()) as Json
  if (!meRes.ok) throw new Error(`telegram getMe failed: ${JSON.stringify(meRes)}`)
  log(`telegram bot @${meRes.result?.username} online${opts.allowedChatId ? ` (chat ${opts.allowedChatId})` : ''}`)

  let offset = 0
  while (true) {
    let updates: Json
    try {
      const res = await fetch(`${api('getUpdates')}?timeout=30&offset=${offset}`)
      updates = (await res.json()) as Json
    } catch (e) {
      log(`poll error: ${(e as Error).message}`)
      continue
    }
    for (const u of updates.result ?? []) {
      offset = u.update_id + 1
      const msg = u.message
      const text: string | undefined = msg?.text
      if (!text) continue
      const chatId: number = msg.chat.id
      if (opts.allowedChatId && String(chatId) !== opts.allowedChatId) {
        await send(chatId, 'Not authorized.')
        continue
      }
      try {
        await send(chatId, '⏳ working…')
        const reply = await opts.onMessage(text, { chatId })
        await send(chatId, reply)
      } catch (e) {
        await send(chatId, `error: ${(e as Error).message}`)
      }
    }
  }
}
