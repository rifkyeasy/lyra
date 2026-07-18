/**
 * CLI argv dispatch. No subcommand → chat REPL, otherwise route to
 * commands/<name>.
 */

// MUST be first: guards Error.captureStackTrace so navi-sdk's transitive
// follow-redirects import doesn't crash Bun at startup. See the shim for why.
import './util/capture-shim'
import { loadDotenvFile } from './util/dotenv'

// Zero-env-var startup: load `~/.lyra/.env` (e.g. the OPENAI_API_KEY that
// `lyra init` persisted) into process.env before any command reads it. Real
// shell env always wins — loadDotenvFile only fills UNSET keys.
loadDotenvFile()

const argv = process.argv.slice(2)
// First arg starting with `--` means the user invoked the default subcommand
// (chat) with flags, e.g. `lyra --yolo`. Treat it as if `chat` were implicit.
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
      await runInit({
        yes: argv.includes('--yes') || argv.includes('-y'),
        new: argv.includes('--new'),
      })
      return
    }
    case 'login': {
      const { runLogin } = await import('./commands/login')
      await runLogin()
      return
    }
    case 'status': {
      const { runStatus } = await import('./commands/status')
      await runStatus()
      return
    }
    case 'whoami': {
      const { runWhoami } = await import('./commands/whoami')
      const ownerIdx = argv.indexOf('--owner')
      const owner = ownerIdx >= 0 ? argv[ownerIdx + 1] : undefined
      await runWhoami({ owner })
      return
    }
    case 'demo': {
      const { runDemo } = await import('./commands/demo')
      await runDemo({ yes: argv.includes('--yes') || argv.includes('-y') })
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
    case 'telegram': {
      const { parseTelegramArgs, runTelegram } = await import('./commands/telegram')
      const parsed = parseTelegramArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`lyra telegram: ${parsed.error}`)
        process.exit(1)
      }
      await runTelegram(parsed)
      return
    }
    case 'pairing': {
      const { parsePairingArgs, runPairing } = await import('./commands/pairing')
      const parsed = parsePairingArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`lyra pairing: ${parsed.error}`)
        process.exit(1)
      }
      await runPairing(parsed)
      return
    }
    case 'gateway': {
      const { parseGatewayArgs, runGateway } = await import('./commands/gateway')
      const parsed = parseGatewayArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`lyra gateway: ${parsed.error}`)
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
      'lyra: a Sui-native, policy-bound AI finance agent',
      '',
      'Commands:',
      '  lyra init                set up your agent (interactive; --new / --yes skip prompts)',
      '  lyra login               link the same agent as app.lyraai.space (device-link)',
      '  lyra [--yolo]            interactive chat with your agent (default; --yolo skips approvals)',
      '  lyra status              show agent address + network + SUI balance + policy',
      '  lyra whoami [--owner 0x…] resolve the agent wallet an owner controls (same on web/CLI/TG)',
      '  lyra demo [--yes]        run the guarded pipeline (policy → blocked over-cap → send → walrus)',
      '  lyra logs                tail the activity log  (flags: --tail N, --agent <id>)',
      '  lyra model               re-pick the brain model',
      '  lyra telegram <sub>      configure phone-DM gateway  (subs: setup | status | remove)',
      '  lyra pairing <sub>       manage DM pairing approvals (subs: list | approve | revoke | clear-pending)',
      '                            usage: lyra pairing approve telegram <code>',
      '  lyra gateway <sub>       always-on agent gateway daemon  (subs: run | start | stop | restart | status | logs)',
      '                            run = foreground, start = bg, stop = SIGTERM via lock',
      '  lyra version             print CLI version  (aliases: --version, -v)',
      '  lyra help                show this message  (aliases: --help, -h)',
      '',
      'Zero-config: `lyra init` writes ~/.lyra/agent.key + ~/.lyra/.env, so no env',
      'vars are required. All env below are OPTIONAL overrides (env wins if set):',
      '  LYRA_AGENT_KEY (suiprivkey1…), LYRA_NETWORK, LYRA_PACKAGE_ID, LYRA_WEB_URL,',
      '  LYRA_LLM_BASE_URL, LYRA_LLM_MODEL, OPENAI_API_KEY, LYRA_POLICY_*',
      '',
    ].join('\n'),
  )
}

main()
  .then(() => {
    // Force-exit on success; `chat` returns only when the user actually quits,
    // so this also gives chat a clean exit.
    process.exit(0)
  })
  .catch(e => {
    console.error('fatal:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
