import { startTelegram } from 'lyra-plugin-telegram'
import pc from 'picocolors'
import { runGoal } from './agent'

/** Run the Lyra agent as a Telegram bot (drive the same agent from your phone). */
export async function runTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.log(pc.yellow('set TELEGRAM_BOT_TOKEN (from @BotFather) to use the Telegram interface'))
    console.log(pc.dim('optional: TELEGRAM_CHAT_ID to allow-list a single chat'))
    return
  }
  console.log('starting Lyra Telegram bot… (Ctrl-C to stop)')
  await startTelegram({
    token,
    allowedChatId: process.env.TELEGRAM_CHAT_ID,
    log: (s) => console.log(s),
    onMessage: async (text) => {
      const result = await runGoal(text, { log: false })
      const lines: string[] = []
      for (const e of result.events) {
        if (e.type === 'tool-call') lines.push(`⏺ ${e.name}`)
      }
      if (result.finalText) lines.push(`\n${result.finalText}`)
      for (const x of result.executed) lines.push(`\n✅ ${x.summary}\n${x.txUrl}`)
      return lines.join('\n') || '(no response)'
    },
  })
}
