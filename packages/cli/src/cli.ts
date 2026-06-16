#!/usr/bin/env bun
/**
 * Lyra CLI argv dispatch (structure adapted from Nebula's CLI). No subcommand
 * → TUI chat; otherwise route to commands/<name>. Commands are dynamically
 * imported so read-only commands don't pull in the agent runtime / a key.
 */
const argv = process.argv.slice(2)
const sub = argv[0]

async function main(): Promise<void> {
  switch (sub) {
    case undefined:
    case 'chat': {
      const { runChat } = await import('./commands/chat')
      await runChat()
      return
    }
    case 'init': {
      const { runInit } = await import('./commands/init')
      await runInit()
      return
    }
    case 'agent': {
      const goal = argv.slice(1).join(' ').trim()
      if (!goal) {
        console.error('usage: lyra agent "<goal>"')
        process.exit(1)
      }
      const { runGoal } = await import('./commands/agent')
      await runGoal(goal, { log: true })
      return
    }
    case 'status': {
      const { runStatus } = await import('./commands/status')
      await runStatus()
      return
    }
    case 'balance': {
      const { runBalance } = await import('./commands/balance')
      await runBalance()
      return
    }
    case 'policy': {
      const { runPolicy } = await import('./commands/policy')
      await runPolicy(argv.slice(1))
      return
    }
    case 'receipts':
    case 'logs': {
      const { runReceipts } = await import('./commands/receipts')
      await runReceipts()
      return
    }
    case 'deepbook': {
      const { runDeepbook } = await import('./commands/deepbook')
      await runDeepbook()
      return
    }
    case 'model': {
      const { runModel } = await import('./commands/model')
      await runModel()
      return
    }
    case 'demo': {
      const { runDemo } = await import('./commands/demo')
      await runDemo()
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
      console.log('lyra 0.1.0')
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
      'lyra: a Sui-native, policy-bound AI agent for autonomous DeFi',
      '',
      'Commands:',
      '  lyra init                  bootstrap an agent: key, model, policy, on-chain policy object',
      '  lyra [chat]                interactive TUI — type goals; the agent plans + executes within policy',
      '  lyra agent "<goal>"        plan + execute a single goal end-to-end',
      '  lyra status                network, package, agent, balances, config + on-chain policy state',
      '  lyra balance               show all coin balances (SUI, WAL, …)',
      '  lyra policy <sub>          manage the on-chain policy (subs: show | revoke | reclaim | topup <sui>)',
      '  lyra receipts              on-chain audit trail: ActionReceipts + Walrus artifacts  (alias: logs)',
      '  lyra deepbook              live DeepBook mainnet market context (pools, prices)',
      '  lyra model                 re-pick the LLM model',
      '  lyra demo                  run the full guarded-pipeline demo (create/spend/block/revoke/reclaim)',
      '  lyra version               print CLI version  (aliases: --version, -v)',
      '  lyra help                  show this message   (aliases: --help, -h)',
      '',
      'The AI proposes. Sui policies enforce. Walrus remembers.',
      '',
    ].join('\n'),
  )
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('fatal:', (e as Error).message)
    process.exit(1)
  })
