/**
 * `nebula pairing <subcommand>` — argv dispatcher for the DM pairing flow.
 *
 * Subcommands:
 *   list                          show pending codes + approved users
 *   approve <platform> <code>     approve a pairing code (case-insensitive)
 *   revoke <platform> <userId>    revoke an approved user
 *   clear-pending [platform]      drop all pending codes
 *
 * Platform is `telegram` for Phase 12. Future platforms (discord, slack) will
 * reuse the same command surface.
 */

export interface PairingArgs {
  sub: 'list' | 'approve' | 'revoke' | 'clear-pending'
  platform?: string
  code?: string
  userId?: string
  yes?: boolean
}

const VALID_SUBS = ['list', 'approve', 'revoke', 'clear-pending'] as const

export type PairingParseResult = PairingArgs | { error: string }

export function parsePairingArgs(argv: string[]): PairingParseResult {
  const sub = argv[0]
  if (!sub) {
    return {
      error:
        'usage: nebula pairing <list | approve <platform> <code> | revoke <platform> <userId> | clear-pending [platform]>',
    }
  }
  if (!(VALID_SUBS as readonly string[]).includes(sub)) {
    return { error: `unknown subcommand '${sub}' (expected: ${VALID_SUBS.join(' | ')})` }
  }
  const positional = argv.slice(1).filter(a => !a.startsWith('-'))
  const yes = argv.includes('--yes') || argv.includes('-y')

  if (sub === 'approve') {
    if (positional.length < 2) {
      return { error: 'usage: nebula pairing approve <platform> <code>' }
    }
    return { sub: 'approve', platform: positional[0], code: positional[1], yes }
  }
  if (sub === 'revoke') {
    if (positional.length < 2) {
      return { error: 'usage: nebula pairing revoke <platform> <userId>' }
    }
    return { sub: 'revoke', platform: positional[0], userId: positional[1], yes }
  }
  if (sub === 'clear-pending') {
    return { sub: 'clear-pending', platform: positional[0], yes }
  }
  return { sub: 'list', platform: positional[0], yes }
}

export async function runPairing(args: PairingArgs): Promise<void> {
  switch (args.sub) {
    case 'list': {
      const { runPairingList } = await import('./pairing-list')
      await runPairingList({ platform: args.platform })
      return
    }
    case 'approve': {
      const { runPairingApprove } = await import('./pairing-approve')
      await runPairingApprove({ platform: args.platform!, code: args.code! })
      return
    }
    case 'revoke': {
      const { runPairingRevoke } = await import('./pairing-revoke')
      await runPairingRevoke({ platform: args.platform!, userId: args.userId!, yes: args.yes })
      return
    }
    case 'clear-pending': {
      const { runPairingClear } = await import('./pairing-clear')
      await runPairingClear({ platform: args.platform, yes: args.yes })
      return
    }
  }
}
