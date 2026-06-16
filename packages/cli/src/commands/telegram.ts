/**
 * `nebula telegram <subcommand>` — argv dispatcher.
 *
 * Subcommands:
 *   setup    interactive wizard: validate token, encrypt + persist locally
 *   status   confirm token still valid + show stored config
 *   remove   delete the encrypted local blob (does NOT revoke at @BotFather)
 */

export interface TelegramArgs {
  sub: 'setup' | 'status' | 'remove'
  yes?: boolean
}

const VALID_SUBS = ['setup', 'status', 'remove'] as const

export function parseTelegramArgs(argv: string[]): TelegramArgs | { error: string } {
  const sub = argv[0]
  if (!sub) return { error: 'usage: nebula telegram <setup | status | remove>' }
  const valid = (VALID_SUBS as readonly string[]).includes(sub)
  if (!valid) return { error: `unknown subcommand '${sub}' (expected: ${VALID_SUBS.join(' | ')})` }
  const yes = argv.includes('--yes') || argv.includes('-y')
  return { sub: sub as TelegramArgs['sub'], yes }
}

export async function runTelegram(args: TelegramArgs): Promise<void> {
  switch (args.sub) {
    case 'setup': {
      const { runTelegramSetup } = await import('./telegram-setup')
      await runTelegramSetup()
      return
    }
    case 'status': {
      const { runTelegramStatus } = await import('./telegram-status')
      await runTelegramStatus()
      return
    }
    case 'remove': {
      const { runTelegramRemove } = await import('./telegram-remove')
      await runTelegramRemove({ yes: args.yes })
      return
    }
  }
}
