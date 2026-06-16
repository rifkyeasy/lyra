/**
 * CLI argv dispatch. No subcommand → chat REPL, otherwise route to
 * commands/<name>.
 */

const argv = process.argv.slice(2)
// First arg starting with `--` means the user invoked the default subcommand
// (chat) with flags, e.g. `nebula --yolo`. Treat it as if `chat` were implicit.
// Exception: `--help` and `--version` are top-level commands, not chat flags.
const first = argv[0]
const isTopLevelFlag = first === '--help' || first === '--version'
const sub = first?.startsWith('--') && !isTopLevelFlag ? 'chat' : first

async function main(): Promise<void> {
  switch (sub) {
    case undefined:
    case 'chat': {
      const { runChat } = await import('./commands/chat')
      await runChat({ yolo: argv.includes('--yolo') })
      return
    }
    case 'init': {
      const { runInit } = await import('./commands/init')
      await runInit()
      return
    }
    case 'status': {
      const { runStatus } = await import('./commands/status')
      await runStatus()
      return
    }
    case 'login': {
      const { runLogin } = await import('./commands/login')
      await runLogin()
      return
    }
    case 'logout': {
      const { runLogout } = await import('./commands/login')
      await runLogout()
      return
    }
    case 'agent': {
      const { runAgentWallet } = await import('./commands/agent-wallet')
      await runAgentWallet()
      return
    }
    case 'logs': {
      const { runLogs } = await import('./commands/logs')
      const tailIdx = argv.indexOf('--tail')
      const tail = tailIdx >= 0 ? Number(argv[tailIdx + 1]) : undefined
      const agentIdx = argv.indexOf('--agent')
      const agent = agentIdx >= 0 ? argv[agentIdx + 1] : undefined
      await runLogs({ agent, tail })
      return
    }
    case 'model': {
      const { runModel } = await import('./commands/model')
      await runModel()
      return
    }
    case 'drain': {
      const toIdx = argv.indexOf('--to')
      const to = toIdx >= 0 ? argv[toIdx + 1] : undefined
      const yes = argv.includes('--yes') || argv.includes('-y')
      const { runDrain } = await import('./commands/drain')
      await runDrain({ to, yes })
      return
    }
    case 'identity': {
      const { parseIdentityArgs, runIdentity } = await import('./commands/identity')
      const parsed = parseIdentityArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`nebula identity: ${parsed.error}`)
        process.exit(1)
      }
      await runIdentity(parsed)
      return
    }
    case 'reputation':
    case 'validation': {
      const { parseTrustArgs, runTrust } = await import('./commands/trust')
      const parsed = parseTrustArgs(sub, argv.slice(1))
      if ('error' in parsed) {
        console.error(`nebula ${sub}: ${parsed.error}`)
        process.exit(1)
      }
      await runTrust(parsed)
      return
    }
    case 'telegram': {
      const { parseTelegramArgs, runTelegram } = await import('./commands/telegram')
      const parsed = parseTelegramArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`nebula telegram: ${parsed.error}`)
        process.exit(1)
      }
      await runTelegram(parsed)
      return
    }
    case 'pairing': {
      const { parsePairingArgs, runPairing } = await import('./commands/pairing')
      const parsed = parsePairingArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`nebula pairing: ${parsed.error}`)
        process.exit(1)
      }
      await runPairing(parsed)
      return
    }
    case 'gateway': {
      const { parseGatewayArgs, runGateway } = await import('./commands/gateway')
      const parsed = parseGatewayArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`nebula gateway: ${parsed.error}`)
        process.exit(1)
      }
      await runGateway(parsed)
      return
    }
    case '-h':
    case '--help':
    case 'help': {
      printHelp()
      return
    }
    case '-v':
    case '--version':
    case 'version': {
      const { resolveCliVersion } = await import('./util/cli-version')
      const v = await resolveCliVersion()
      console.log(v)
      return
    }
    default: {
      console.log(`Unknown command: ${sub}`)
      printHelp()
      process.exit(1)
    }
  }
}

function printHelp(): void {
  console.log(
    [
      'nebula: a Mantle-native, policy-aware AI treasury assistant',
      '',
      'Commands:',
      '  nebula init                bootstrap a new agent identity + local keystore',
      '  nebula [--yolo]            interactive chat with your agent (default; --yolo skips approvals)',
      '  nebula status              show agent + wallet + config state',
      '  nebula login               unlock with a password profile (no per-command operator sign)',
      '  nebula logout              clear the login session',
      '  nebula agent               show your deterministic agent wallet (same as the web console)',
      '  nebula logs                tail the activity log  (flags: --tail N, --agent <id>)',
      '  nebula drain --to <addr>   sweep agent EOA balance to address (default: operator)',
      '  nebula model               re-pick the brain model',
      '  nebula identity <sub>      ERC-8004 agent identity  (subs: card | register | show)',
      '  nebula reputation <sub>    ERC-8004 reputation  (subs: show | give)',
      '  nebula validation <sub>    ERC-8004 validation  (subs: show | request | respond)',
      '  nebula telegram <sub>      configure phone-DM gateway  (subs: setup | status | remove)',
      '  nebula pairing <sub>       manage DM pairing approvals (subs: list | approve | revoke | clear-pending)',
      '                            usage: nebula pairing approve telegram <code>',
      '  nebula gateway <sub>       always-on agent gateway daemon  (subs: run | start | stop | restart | status | logs)',
      '                            run = foreground, start = bg + Touch ID, stop = SIGTERM via lock',
      '  nebula version             print CLI version  (aliases: --version, -v)',
      '  nebula help                show this message  (aliases: --help, -h)',
      '',
    ].join('\n'),
  )
}

main()
  .then(() => {
    // Force-exit on success because some SDKs (e.g. the WalletConnect relay)
    // leak open handles (websockets, heartbeat timers) we have no hooks to
    // drain. Without this, one-shot commands like `nebula init` would hang at
    // the prompt indefinitely after their work completed. `chat` returns only
    // when the user actually quits, so this also gives chat a clean exit.
    process.exit(0)
  })
  .catch(e => {
    console.error('fatal:', (e as Error).message)
    process.exit(1)
  })
