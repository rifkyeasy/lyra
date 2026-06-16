/**
 * `nebula gateway run` — foreground daemon (blocks; Ctrl+C to stop).
 *
 * Spawns `nebula-gateway-local` (the bin in nebula-ai-gateway) with
 * inherit stdio so the user sees logs live. Reads operator-session for the
 * cached AES keys; fails loud if no session exists ("run nebula gateway start
 * first").
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { resolveLocalBin } from '../util/gateway-spawn'

export interface GatewayRunOpts {
  agentId?: string
}

export async function runGatewayForeground(opts: GatewayRunOpts): Promise<void> {
  const env = { ...process.env }
  if (opts.agentId) env.NEBULA_AGENT_ID = opts.agentId
  // Default NEBULA_CONFIG to ~/.nebula/config.ts if not already set.
  if (!env.NEBULA_CONFIG) {
    env.NEBULA_CONFIG = join(env.HOME ?? '', '.nebula', 'config.ts')
  }

  const localBin = resolveLocalBin()
  const proc = spawn('bun', [localBin], {
    env,
    stdio: 'inherit',
  })
  proc.on('exit', code => process.exit(code ?? 0))
  proc.on('error', err => {
    console.error(`nebula gateway run: spawn failed — ${err.message}`)
    process.exit(1)
  })

  const forwardSignal = (sig: NodeJS.Signals): void => {
    if (!proc.killed) proc.kill(sig)
  }
  process.on('SIGINT', () => forwardSignal('SIGINT'))
  process.on('SIGTERM', () => forwardSignal('SIGTERM'))
}
