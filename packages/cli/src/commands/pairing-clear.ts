import { confirm, isCancel } from '@clack/prompts'
import { PairingStore, agentPaths, placeholderAgentId } from 'nebula-ai-core'
import { findAndLoadConfig } from '../config/load'

export interface RunPairingClearOpts {
  platform?: string
  yes?: boolean
}

export async function runPairingClear(opts: RunPairingClearOpts): Promise<void> {
  const loaded = await findAndLoadConfig()
  if (!loaded) {
    console.error('No nebula.config.ts found. Run `nebula init` first.')
    process.exit(1)
  }
  const { config } = loaded
  if (!config.identity.agent) {
    console.error('Config has no agent. Run `nebula init` first.')
    process.exit(1)
  }
  const agentId = placeholderAgentId(config.identity.agent)
  const dir = agentPaths.agent(agentId).pairingDir
  const store = new PairingStore({ dir })

  if (!opts.yes) {
    const target = opts.platform ? `${opts.platform} pending` : 'ALL pending pairing codes'
    const ok = await confirm({
      message: `Clear ${target}?`,
      initialValue: false,
    })
    if (isCancel(ok) || !ok) {
      console.log('Aborted.')
      return
    }
  }

  const count = store.clearPending(opts.platform)
  console.log(`✓ Cleared ${count} pending pairing code${count === 1 ? '' : 's'}`)
}
