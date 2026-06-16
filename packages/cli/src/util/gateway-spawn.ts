/**
 * v0.21.5 Bundle B: spawn-and-wait helper for the local gateway daemon.
 *
 * Two callers share this:
 *   - `nebula gateway start` (interactive Touch ID flow → spawn detached)
 *   - `nebula` chat fallback when no sock is present (auto-spawn before
 *     embedded TUI fallthrough — see Bundle C / chat.tsx)
 *
 * The helper does NOT perform operator-session unlock. Callers that need a
 * fresh session must run that path before invoking this. If the daemon dies
 * during boot because no session exists, the sock never appears and we
 * surface the failure as `{ ready: false, reason: 'timeout' }`.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentPaths } from 'nebula-ai-core'

export interface SpawnGatewayDaemonOpts {
  agentId: string
  configPath: string
  socketPath: string
  /** Max ms to wait for the unix sock to appear. Default 10_000. */
  timeoutMs?: number
  /**
   * Where to send daemon stdout/stderr. Default 'log-file' which redirects
   * to `~/.nebula/agents/<id>/gateway.log` (truncated on each boot) so
   * detached daemon diagnostics survive the parent's exit. 'inherit' keeps
   * the legacy behavior where output goes to the parent's tty (and vanishes
   * on detach). 'ignore' drops everything.
   */
  stdio?: 'inherit' | 'ignore' | 'log-file'
  /** Override the bin resolution (tests). */
  binPath?: string
  /** Override env (tests). */
  env?: NodeJS.ProcessEnv
}

export interface SpawnGatewayDaemonResult {
  ready: boolean
  /** Detached child PID iff spawn succeeded (regardless of readiness). */
  pid?: number
  /** Reason populated on failure: 'spawn-failed' | 'timeout' | 'pre-existing'. */
  reason?: 'spawn-failed' | 'timeout' | 'pre-existing'
  /** First-line error message when spawn failed. */
  error?: string
}

export function resolveLocalBin(): string {
  const pkgUrl = import.meta.resolve('nebula-ai-gateway/package.json')
  const pkgRoot = dirname(fileURLToPath(pkgUrl))
  return join(pkgRoot, 'bin', 'nebula-gateway-local')
}

export async function spawnGatewayDaemon(
  opts: SpawnGatewayDaemonOpts,
): Promise<SpawnGatewayDaemonResult> {
  if (existsSync(opts.socketPath)) {
    return { ready: false, reason: 'pre-existing' }
  }

  const bin = opts.binPath ?? resolveLocalBin()
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    NEBULA_AGENT_ID: opts.agentId,
    NEBULA_CONFIG: opts.configPath,
  }
  const stdioMode = opts.stdio ?? 'log-file'

  // v0.21.12: when stdio is 'log-file' redirect daemon stdout+stderr to
  // ~/.nebula/agents/<id>/gateway.log (truncate-on-restart). Pre-fix this
  // helper used 'inherit' which sent output to the parent's tty; once the
  // parent CLI returned, those handles vanished and operators couldn't see
  // why the daemon misbehaved. Truncation is fine because operators rarely
  // reboot the daemon mid-session and `nebula gateway logs -f` only follows
  // the current invocation.
  let stdioCfg: ['ignore', 'inherit' | 'ignore' | number, 'inherit' | 'ignore' | number]
  if (stdioMode === 'log-file') {
    const logPath = join(agentPaths.agent(opts.agentId).dir, 'gateway.log')
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      const fd = openSync(logPath, 'w') // truncate on each boot
      stdioCfg = ['ignore', fd, fd]
    } catch {
      // If we can't open the log file (perm, disk), fall back to ignore so
      // we still spawn cleanly. Operators lose diagnostics but the daemon
      // boots.
      stdioCfg = ['ignore', 'ignore', 'ignore']
    }
  } else {
    stdioCfg = ['ignore', stdioMode, stdioMode]
  }

  let proc: ChildProcess
  try {
    proc = spawn('bun', [bin], {
      env,
      detached: true,
      stdio: stdioCfg,
    })
    proc.unref()
  } catch (err) {
    return {
      ready: false,
      reason: 'spawn-failed',
      error: (err as Error).message?.slice(0, 200),
    }
  }

  const timeoutMs = opts.timeoutMs ?? 10_000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(opts.socketPath)) {
      return { ready: true, pid: proc.pid }
    }
    await new Promise(r => setTimeout(r, 200))
  }
  return {
    ready: false,
    pid: proc.pid,
    reason: 'timeout',
  }
}
