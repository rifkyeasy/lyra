/**
 * `nebula gateway status` — show PID, uptime, socket path, lock state,
 * operator-session freshness.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  agentPaths,
  isOperatorSessionFresh,
  placeholderAgentId,
  readOperatorSession,
} from 'nebula-ai-core'
import { findAndLoadConfig } from '../config/load'

export interface GatewayStatusOpts {
  agentId?: string
}

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

export async function runGatewayStatus(opts: GatewayStatusOpts): Promise<void> {
  let agentId = opts.agentId
  if (!agentId) {
    const found = await findAndLoadConfig()
    if (!found?.config) {
      console.error('nebula gateway status: no nebula.config.ts and no --agent provided')
      process.exit(1)
    }
    const agentEoa = found.config.identity.agent
    if (!agentEoa) {
      console.error('nebula gateway status: config has no agent EOA; run `nebula init` first')
      process.exit(1)
    }
    agentId = placeholderAgentId(agentEoa)
  }
  const paths = agentPaths.agent(agentId)
  const socketPath = join(paths.dir, 'gateway.sock')
  const identityHash = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
  const lockFile = join(homedir(), '.nebula', 'locks', `nebula-gateway-${identityHash}.lock`)

  console.log(`agent:        ${agentId}`)
  console.log(`socket:       ${socketPath} ${existsSync(socketPath) ? '(present)' : '(absent)'}`)
  console.log(`lock:         ${lockFile} ${existsSync(lockFile) ? '(present)' : '(absent)'}`)

  // PID + uptime via lock file.
  if (existsSync(lockFile)) {
    try {
      const parsed = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid?: number }
      if (typeof parsed.pid === 'number') {
        let alive = false
        try {
          process.kill(parsed.pid, 0)
          alive = true
        } catch {
          /* dead */
        }
        const stat = statSync(lockFile)
        const ageMs = Date.now() - stat.mtimeMs
        console.log(`pid:          ${parsed.pid} ${alive ? '(alive)' : '(dead — stale lock)'}`)
        console.log(`lock-age:     ${fmtAge(ageMs)}`)
      }
    } catch {
      console.log('pid:          (lock file unreadable)')
    }
  } else {
    console.log('pid:          (not running)')
  }

  // Operator-session freshness.
  const fresh = isOperatorSessionFresh(agentId)
  console.log(`session:      ${fresh ? 'fresh' : 'absent or expired'}`)
  if (fresh) {
    const sess = readOperatorSession(agentId)
    if (sess) {
      const remaining = sess.expiresAt - Date.now()
      const scopes = Object.keys(sess.keys).filter(k => sess.keys[k as keyof typeof sess.keys])
      console.log(`session-ttl:  ${fmtAge(remaining)} remaining (scopes: ${scopes.join(', ')})`)
    }
  }
}
