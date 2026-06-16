/**
 * `nebula gateway stop` — SIGTERM the running gateway daemon via the lock
 * file's PID. Falls through to SIGKILL after a 5s grace period.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentPaths, placeholderAgentId } from 'nebula-ai-core'
import { findAndLoadConfig } from '../config/load'

export interface GatewayStopOpts {
  agentId?: string
}

function lockPath(_agentId: string): string {
  // Mirror packages/core/src/locks.ts — `~/.nebula/locks/<scope>-<sha256(identity).slice(0,16)>.lock`
  // For 'nebula-gateway' scope. We compute the same hash as the lock module.
  // Easiest: read all lock files and find one matching the agent.
  return join(homedir(), '.nebula', 'locks')
}

function findGatewayLock(agentId: string): string | null {
  // The lock filename embeds sha256(agentId).slice(0, 16). Compute it.
  const { createHash } = require('node:crypto')
  const identityHash = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
  const lockFile = join(lockPath(agentId), `nebula-gateway-${identityHash}.lock`)
  return existsSync(lockFile) ? lockFile : null
}

export async function runGatewayStop(opts: GatewayStopOpts): Promise<void> {
  let agentId = opts.agentId
  if (!agentId) {
    const found = await findAndLoadConfig()
    if (!found?.config) {
      console.error('nebula gateway stop: no nebula.config.ts and no --agent provided')
      process.exit(1)
    }
    const agentEoa = found.config.identity?.agent ?? null
    if (!agentEoa) {
      console.error('nebula gateway stop: config has no agent EOA; run `nebula init` first')
      process.exit(1)
    }
    agentId = placeholderAgentId(agentEoa)
    const label = `agent ${agentId.slice(0, 8)}…`
    const eoaLabel = ` (EOA ${agentEoa.slice(0, 6)}…${agentEoa.slice(-4)})`
    const configPath = found.path ?? '<unknown>'
    console.log(`nebula gateway stop → ${label}${eoaLabel}`)
    console.log(`  config: ${configPath}`)
    console.log(
      '  if this is not the agent you meant, set NEBULA_ROOT or pass --agent <id> before re-running.',
    )
  }
  const lockFile = findGatewayLock(agentId)
  if (!lockFile) {
    console.log(`gateway not running (no lock at ${lockPath(agentId)})`)
    return
  }
  let pid: number
  try {
    const raw = readFileSync(lockFile, 'utf8').trim()
    // Lock files are JSON with shape `{pid, scope, identityHash, expiresAt}`.
    const parsed = JSON.parse(raw) as { pid?: number }
    if (typeof parsed.pid !== 'number') {
      console.error('nebula gateway stop: lock file has no pid field')
      process.exit(1)
    }
    pid = parsed.pid
  } catch (e) {
    console.error(`nebula gateway stop: lock file unreadable — ${(e as Error).message}`)
    process.exit(1)
  }

  // Verify the PID is alive.
  try {
    process.kill(pid, 0)
  } catch {
    console.log(`gateway not running (stale lock pid=${pid}); cleaning up`)
    try {
      unlinkSync(lockFile)
    } catch {
      /* ignore */
    }
    return
  }

  // Send SIGTERM, wait up to 5s, then SIGKILL.
  console.log(`stopping gateway pid=${pid} ...`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    console.error(`nebula gateway stop: SIGTERM failed — ${(e as Error).message}`)
    process.exit(1)
  }

  const start = Date.now()
  while (Date.now() - start < 5_000) {
    try {
      process.kill(pid, 0)
    } catch {
      console.log(`gateway stopped pid=${pid}`)
      // Lock file is auto-removed by daemon's shutdown handler. Belt + suspenders:
      try {
        if (existsSync(lockFile)) unlinkSync(lockFile)
      } catch {
        /* ignore */
      }
      // Also clean up the socket file in case the daemon didn't.
      const socketPath = join(agentPaths.agent(agentId).dir, 'gateway.sock')
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath)
      } catch {
        /* ignore */
      }
      return
    }
    await new Promise(r => setTimeout(r, 200))
  }

  console.log('gateway did not exit in 5s; sending SIGKILL')
  try {
    process.kill(pid, 'SIGKILL')
  } catch (e) {
    console.error(`nebula gateway stop: SIGKILL failed — ${(e as Error).message}`)
    process.exit(1)
  }
  try {
    if (existsSync(lockFile)) unlinkSync(lockFile)
  } catch {
    /* ignore */
  }
  console.log(`gateway force-killed pid=${pid}`)
}
