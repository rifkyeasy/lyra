/**
 * `lyra gateway stop` — SIGTERM the running gateway daemon via the lock
 * file's PID. Falls through to SIGKILL after a 5s grace period.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentPaths, placeholderAgentId } from 'lyra-core'
import { findAndLoadConfig } from '../config/load'

export interface GatewayStopOpts {
  agentId?: string
}

function lockPath(_agentId: string): string {
  // Mirror packages/core/src/locks.ts — `~/.lyra/locks/<scope>-<sha256(identity).slice(0,16)>.lock`
  // For 'lyra-gateway' scope. We compute the same hash as the lock module.
  // Easiest: read all lock files and find one matching the agent.
  return join(homedir(), '.lyra', 'locks')
}

function findGatewayLock(agentId: string): string | null {
  // The lock filename embeds sha256(agentId).slice(0, 16). Compute it.
  const { createHash } = require('node:crypto')
  const identityHash = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
  const lockFile = join(lockPath(agentId), `lyra-gateway-${identityHash}.lock`)
  return existsSync(lockFile) ? lockFile : null
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function removeIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* ignore */
  }
}

async function resolveStopAgentId(opts: GatewayStopOpts): Promise<string> {
  if (opts.agentId) return opts.agentId
  const found = await findAndLoadConfig()
  if (!found?.config) {
    console.error('lyra gateway stop: no lyra.config.ts and no --agent provided')
    process.exit(1)
  }
  const agentEoa = found.config.identity?.agent ?? null
  if (!agentEoa) {
    console.error('lyra gateway stop: config has no agent EOA; run `lyra init` first')
    process.exit(1)
  }
  const agentId = placeholderAgentId(agentEoa)
  const label = `agent ${agentId.slice(0, 8)}…`
  const eoaLabel = ` (EOA ${agentEoa.slice(0, 6)}…${agentEoa.slice(-4)})`
  const configPath = found.path ?? '<unknown>'
  console.log(`lyra gateway stop → ${label}${eoaLabel}`)
  console.log(`  config: ${configPath}`)
  console.log(
    '  if this is not the agent you meant, set LYRA_ROOT or pass --agent <id> before re-running.',
  )
  return agentId
}

function readPidFromLock(lockFile: string): number {
  try {
    const raw = readFileSync(lockFile, 'utf8').trim()
    // Lock files are JSON with shape `{pid, scope, identityHash, expiresAt}`.
    const parsed = JSON.parse(raw) as { pid?: number }
    if (typeof parsed.pid !== 'number') {
      console.error('lyra gateway stop: lock file has no pid field')
      process.exit(1)
    }
    return parsed.pid
  } catch (e) {
    console.error(`lyra gateway stop: lock file unreadable — ${(e as Error).message}`)
    process.exit(1)
  }
}

/**
 * Poll the pid until it exits or 5s elapses. On exit, clean up the lock +
 * socket (belt + suspenders; the daemon usually does this itself). Returns
 * true when the gateway exited within the grace window.
 */
async function waitForGatewayExit(
  pid: number,
  lockFile: string,
  agentId: string,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < 5_000) {
    if (!isPidAlive(pid)) {
      console.log(`gateway stopped pid=${pid}`)
      removeIfExists(lockFile)
      removeIfExists(join(agentPaths.agent(agentId).dir, 'gateway.sock'))
      return true
    }
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

export async function runGatewayStop(opts: GatewayStopOpts): Promise<void> {
  const agentId = await resolveStopAgentId(opts)
  const lockFile = findGatewayLock(agentId)
  if (!lockFile) {
    console.log(`gateway not running (no lock at ${lockPath(agentId)})`)
    return
  }
  const pid = readPidFromLock(lockFile)

  // Verify the PID is alive.
  if (!isPidAlive(pid)) {
    console.log(`gateway not running (stale lock pid=${pid}); cleaning up`)
    removeIfExists(lockFile)
    return
  }

  // Send SIGTERM, wait up to 5s, then SIGKILL.
  console.log(`stopping gateway pid=${pid} ...`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    console.error(`lyra gateway stop: SIGTERM failed — ${(e as Error).message}`)
    process.exit(1)
  }

  if (await waitForGatewayExit(pid, lockFile, agentId)) return

  console.log('gateway did not exit in 5s; sending SIGKILL')
  try {
    process.kill(pid, 'SIGKILL')
  } catch (e) {
    console.error(`lyra gateway stop: SIGKILL failed — ${(e as Error).message}`)
    process.exit(1)
  }
  removeIfExists(lockFile)
  console.log(`gateway force-killed pid=${pid}`)
}
