// Pairing-flow message formatter.
//
// When an unknown user DMs the bot, the listener replies with a pairing code
// they can give to the operator. The operator approves out-of-band via
// `lyra pairing approve telegram <code>`, which writes the user-id to
// `~/.lyra/agents/<id>/pairing/telegram-approved.json`. The next message
// from that user passes sanitize and reaches the brain.

export interface PairingMessageOpts {
  code: string
  agentName?: string
  /** Optional override of the approval CLI hint. */
  approveCommand?: string
}

export function formatPairingMessage(opts: PairingMessageOpts): string {
  const cmd = opts.approveCommand ?? `lyra pairing approve telegram ${opts.code}`
  const greeting = opts.agentName
    ? `🔐 Hi! I'm ${opts.agentName} and I don't recognize you yet.`
    : "🔐 Hi! I don't recognize you yet."
  return [
    greeting,
    '',
    `Your pairing code: ${opts.code}`,
    '',
    'Send this code to the bot owner and ask them to approve you. They will run:',
    `  ${cmd}`,
    '',
    "Codes expire in 1 hour. Once approved, send your next message and I'll respond.",
  ].join('\n')
}
