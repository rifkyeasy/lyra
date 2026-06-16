/**
 * v0.23.2: detect and auto-heal version drift between the on-disk CLI binary
 * and a running gateway daemon.
 *
 * Scenario this fixes:
 *   1. Operator runs `bun add -g nebula-ai-cli@<new>` — global binary
 *      swaps on disk.
 *   2. The previously-running gateway daemon was spawned from the OLD binary
 *      and pinned its node_modules at boot. `/healthz` reports the old version
 *      forever.
 *   3. Operator runs `nebula` (chat) or `nebula gateway start`. Without this
 *      helper, chat.tsx re-attaches to the stale daemon — operator sees old
 *      features for the entire daemon lifetime.
 *
 * With this helper: any caller that sees a pre-existing socket calls
 * `ensureGatewayVersionMatchesCli` first, which fetches /healthz, compares
 * versions, and if drift is detected: kills the old daemon, removes the
 * stale socket, and returns 'restarted' so the caller respawns fresh.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface VersionCheckOpts {
  /** Path to the gateway's unix socket. */
  socketPath: string
  /** Path to the lockfile holding daemon pid (for SIGTERM). */
  lockFile?: string
  /** Override the on-disk CLI version (tests). */
  cliVersion?: string
  /** Override the fetch implementation (tests). */
  fetchImpl?: typeof fetch
  /** Max ms to wait after SIGTERM for the socket to disappear. Default 4000. */
  killTimeoutMs?: number
}

export interface VersionCheckResult {
  /** What we observed and did. */
  action: 'ok' | 'restarted' | 'unreachable' | 'no-cli-version'
  cliVersion?: string
  daemonVersion?: string
  /** Human-readable note for the operator. */
  note?: string
}

/** Read the version baked into the nebula-ai-gateway package on disk. */
export function readLocalGatewayVersion(): string | undefined {
  try {
    const pkgUrl = import.meta.resolve('nebula-ai-gateway/package.json')
    const pkgPath = fileURLToPath(pkgUrl)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}

/** Fetch /healthz over the unix socket. Returns the daemon's reported version. */
export async function fetchDaemonVersion(
  socketPath: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  const f = fetchImpl ?? globalThis.fetch
  try {
    const r = await f('http://localhost/healthz', { unix: socketPath } as RequestInit & {
      unix: string
    })
    if (!r.ok) return undefined
    const body = (await r.json()) as { version?: string }
    return body.version
  } catch {
    return undefined
  }
}

/**
 * Compare running-daemon version against on-disk CLI version. If they drift,
 * SIGTERM the pid in the lockfile, wait up to killTimeoutMs for the socket
 * to disappear, and return `action='restarted'` to signal the caller to
 * spawn a fresh daemon.
 *
 * If versions match → `action='ok'`.
 * If /healthz unreachable (zombie socket) → `action='unreachable'` after
 * cleaning the stale socket file so the caller can spawn fresh.
 * If on-disk CLI version cannot be resolved → `action='no-cli-version'`
 * (skip check defensively).
 */
export async function ensureGatewayVersionMatchesCli(
  opts: VersionCheckOpts,
): Promise<VersionCheckResult> {
  if (!existsSync(opts.socketPath)) {
    return { action: 'ok', note: 'no socket; nothing to check' }
  }

  const cliVersion = opts.cliVersion ?? readLocalGatewayVersion()
  if (!cliVersion) {
    return {
      action: 'no-cli-version',
      note: 'could not resolve on-disk CLI version; skipping drift check',
    }
  }

  const daemonVersion = await fetchDaemonVersion(opts.socketPath, opts.fetchImpl)
  if (!daemonVersion) {
    try {
      unlinkSync(opts.socketPath)
    } catch {}
    return {
      action: 'unreachable',
      cliVersion,
      note: 'daemon socket present but /healthz unreachable; removed stale socket',
    }
  }

  if (daemonVersion === cliVersion) {
    return { action: 'ok', cliVersion, daemonVersion }
  }

  // Drift detected. Kill the daemon via pid in lockfile.
  let killedPid: number | undefined
  if (opts.lockFile && existsSync(opts.lockFile)) {
    try {
      const parsed = JSON.parse(readFileSync(opts.lockFile, 'utf8')) as { pid?: number }
      if (typeof parsed.pid === 'number') {
        try {
          process.kill(parsed.pid, 'SIGTERM')
          killedPid = parsed.pid
        } catch {}
      }
    } catch {}
  }

  // Wait for the socket to disappear (daemon exits, cleans up).
  const killTimeoutMs = opts.killTimeoutMs ?? 4000
  const deadline = Date.now() + killTimeoutMs
  while (Date.now() < deadline && existsSync(opts.socketPath)) {
    await new Promise(r => setTimeout(r, 100))
  }

  // If socket still here, force-remove it. The lockfile cleanup happens when
  // the parent invokes spawnGatewayDaemon (which clears stale locks at boot).
  if (existsSync(opts.socketPath)) {
    try {
      unlinkSync(opts.socketPath)
    } catch {}
  }

  return {
    action: 'restarted',
    cliVersion,
    daemonVersion,
    note: `version drift: daemon=${daemonVersion} vs cli=${cliVersion}; killed pid=${killedPid ?? '?'}, socket cleaned`,
  }
}
