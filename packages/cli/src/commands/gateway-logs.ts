/**
 * `nebula gateway logs [--tail N] [-f]` — tail the gateway log.
 *
 * v0.19.x: gateway daemon logs to stdout/stderr only (inherited by `gateway run`
 * or backgrounded by `gateway start`). v0.19.3 wires a log file at
 * `~/.nebula/agents/<id>/gateway.log` for tailing. Until then, this command
 * informs the user where to look.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentPaths, placeholderAgentId } from 'nebula-ai-core'
import { findAndLoadConfig } from '../config/load'

export interface GatewayLogsOpts {
  agentId?: string
  tail: number
  follow: boolean
}

export async function runGatewayLogs(opts: GatewayLogsOpts): Promise<void> {
  let agentId = opts.agentId
  if (!agentId) {
    const found = await findAndLoadConfig()
    if (!found?.config) {
      console.error('nebula gateway logs: no nebula.config.ts and no --agent provided')
      process.exit(1)
    }
    const agentEoa = found.config.identity.agent
    if (!agentEoa) {
      console.error('nebula gateway logs: config has no agent EOA; run `nebula init` first')
      process.exit(1)
    }
    agentId = placeholderAgentId(agentEoa)
  }
  const logFile = join(agentPaths.agent(agentId).dir, 'gateway.log')
  if (!existsSync(logFile)) {
    console.log(`gateway log not found at ${logFile}`)
    console.log('v0.19.x: gateway daemon logs to stdout when run via `nebula gateway run`.')
    console.log(
      'Background it with: nohup bun packages/gateway/bin/nebula-gateway-local > ~/nebula-logs/gateway.log 2>&1 &',
    )
    return
  }
  const args = ['-n', String(opts.tail), ...(opts.follow ? ['-f'] : []), logFile]
  const proc = spawn('tail', args, { stdio: 'inherit' })
  proc.on('exit', code => process.exit(code ?? 0))
}
