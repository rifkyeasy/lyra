/**
 * Container sandbox backend (Tier 3, Phase 9.5 follow-up to sandbox-exec).
 *
 * Works with EITHER Docker Desktop OR Podman — they provide the same CLI.
 * Auto-detects the runtime; same default config works for both. Operator
 * can force a specific binary via `runtimePath` opt.
 *
 * Same isolation shape as hermes-agent's `TERMINAL_ENV=docker` mode (full Linux
 * container). Differences from Tier 2 (sandbox-exec):
 *
 *  - Container has its own filesystem (chroot-like). Host fs invisible to the
 *    sandboxed processes unless explicitly mounted via `mountWorkspace=true`.
 *  - Container has its own /tmp, /etc, /home — `rm -rf /tmp/*` only nukes the
 *    container's tmpdir, never the host's.
 *  - Network goes through the runtime's bridge by default (still allowed for
 *    lyra's RPC/storage/compute/WC traffic to escape the container).
 *  - Cold-start cost ~1s on the FIRST tool call after lyra boot (longer if
 *    the image is being pulled). Subsequent `exec` calls are ~50-100ms.
 *
 * Hybrid MVP: only shell.run / shell.process_start / code.execute go through
 * the container. fs.* tools still run on host (gated by PathGuard). browser.*
 * still runs on host. A future bundle would re-exec all of lyra inside the
 * container; this is the lower-risk incremental step.
 *
 * Lifecycle:
 *  - `wrapSpawn` lazy-starts the container on first call.
 *  - Container runs `nikolaik/python-nodejs:python3.11-nodejs20` by default
 *    (matches hermes' default; has bash, python3, node, npm, git, curl on
 *    standard PATH).
 *  - Container is detached (`run -d`), idle-loops on `tail -f /dev/null` so it
 *    stays alive between exec calls.
 *  - `dispose()` kills the container. chat.tsx wires this to process exit
 *    handlers.
 *
 * Failure modes:
 *  - Runtime not installed → constructor throws clear error; factory falls
 *    back to LocalBackend with stderr warning.
 *  - Daemon/machine not running → first call surfaces "daemon unreachable"
 *    error from the runtime. With podman on macOS, requires `podman machine
 *    start` once.
 *  - Image pull on first run → 30-60s, surfaced as "starting container" log.
 *  - Container crash mid-session (external `podman kill`, OOM, daemon
 *    restart) → wrapSpawn detects the stale cache via a fast
 *    `podman inspect --format '{{.State.Running}}'` probe and self-heals by
 *    invalidating containerId + re-running startContainer. Cost: one extra
 *    inspect (~5-15ms on the warm Podman API socket) per shell-class call.
 *    Worth the latency vs. the alternative of leaving the brain stuck on
 *    "no such container" errors with no recovery path.
 */

import { type SpawnOptions, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type {
  SandboxBackend,
  SandboxBackendOpts,
  SandboxEnvHint,
  SandboxSpawnRequest,
  WrappedSpawn,
} from './types'

const exec = promisify(execFile)

/**
 * Probe order for container runtime auto-detect. First existing path wins.
 * macOS Homebrew Podman lives at /opt/homebrew/bin/podman; Docker Desktop
 * symlinks /usr/local/bin/docker to its CLI (or to podman, on machines
 * with both). Linux paths included for completeness.
 */
const RUNTIME_CANDIDATES: ReadonlyArray<{ path: string; runtime: 'docker' | 'podman' }> = [
  { path: '/usr/local/bin/docker', runtime: 'docker' },
  { path: '/opt/homebrew/bin/docker', runtime: 'docker' },
  { path: '/opt/homebrew/bin/podman', runtime: 'podman' },
  { path: '/usr/bin/docker', runtime: 'docker' },
  { path: '/usr/bin/podman', runtime: 'podman' },
]

interface RuntimeInfo {
  path: string
  runtime: 'docker' | 'podman'
}

function detectRuntime(override?: string): RuntimeInfo {
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`container runtime override path does not exist: ${override}`)
    }
    const runtime = override.includes('podman') ? 'podman' : 'docker'
    return { path: override, runtime }
  }
  for (const cand of RUNTIME_CANDIDATES) {
    if (existsSync(cand.path)) return cand
  }
  throw new Error(
    'no container runtime found. Install Docker Desktop or Podman (`brew install podman`) and ensure the daemon/machine is running.',
  )
}

export interface DockerBackendOpts extends SandboxBackendOpts {
  /**
   * Container image. Default: `nikolaik/python-nodejs:python3.11-nodejs20`
   * (matches hermes-agent's TERMINAL_DOCKER_IMAGE default; has bash, python3,
   * node, npm, git, curl on standard PATH so every code.execute language and
   * shell tool works out of the box). Switch to `oven/bun:1` (~250MB vs 700MB)
   * if you only need bun/ts and don't care about python.
   */
  image?: string
  /**
   * Mount the host's workspaceRoot into the container at /workspace. Default
   * `false` for max isolation (container has no view of host fs). Set true
   * when the operator wants the agent to read/edit host project files.
   */
  mountWorkspace?: boolean
  /**
   * Override container runtime binary path. Default: auto-detect (docker, then
   * podman). Set this to force one or the other, e.g. `/opt/homebrew/bin/podman`.
   */
  runtimePath?: string
  /** Override container start timeout in ms. Default 60000 (60s for image pull). */
  startTimeoutMs?: number
  /**
   * CPU cores cap (passed to runtime as `--cpus`). Float (e.g. 0.5, 2). Unset =
   * unlimited (runtime default). Hermes default is 1; lyra leaves UNSET so
   * the container competes fairly with host work unless the operator opts in.
   */
  cpu?: number
  /**
   * Memory cap in MB (`--memory <N>m`). Unset = unlimited. Hermes default is
   * 5120 (5GB). OOM kills happen at this cap, so prefer leaving it unset
   * unless the operator wants a hard guard against runaway pip installs.
   */
  memoryMb?: number
  /**
   * Per-container disk cap in MB (`--storage-opt size=<N>m`). Linux + overlay2
   * with pquota only — silently dropped on macOS (Docker Desktop / podman
   * machine). Unset = unlimited.
   */
  diskMb?: number
  /**
   * Block all network access from inside the container (`--network=none`).
   * Default false (container's bridge network reaches the internet). Useful
   * for max-paranoia code.execute runs that should never reach out.
   */
  noNetwork?: boolean
}

/**
 * Always-on hardening flags ported from hermes-agent's `_SECURITY_ARGS`. Drop
 * every Linux capability then re-add the minimum needed by package managers
 * (pip / npm / apt set ownership and override DAC), block setuid escalation,
 * cap process count to stop fork bombs, and replace tmpfs /tmp /var/tmp /run
 * with size-limited writable tmpfs that doesn't bleed into the host. `--init`
 * gives the container a real PID 1 (tini) that reaps zombies — without it,
 * background tools that orphan children leak file descriptors.
 */
const HARDENING_ARGS: ReadonlyArray<string> = [
  '--init',
  '--cap-drop',
  'ALL',
  '--cap-add',
  'DAC_OVERRIDE',
  '--cap-add',
  'CHOWN',
  '--cap-add',
  'FOWNER',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '256',
  '--tmpfs',
  '/tmp:rw,nosuid,size=512m',
  '--tmpfs',
  '/var/tmp:rw,noexec,nosuid,size=256m',
  '--tmpfs',
  '/run:rw,noexec,nosuid,size=64m',
]

export class DockerBackend implements SandboxBackend {
  readonly mode = 'docker' as const
  readonly label: string
  private readonly image: string
  private readonly mountWorkspace: boolean
  private readonly runtime: RuntimeInfo
  private readonly startTimeoutMs: number
  private readonly workspaceRoot: string
  private readonly cpu?: number
  private readonly memoryMb?: number
  private readonly diskMb?: number
  private readonly noNetwork: boolean
  private containerId: string | null = null
  private starting: Promise<string> | null = null
  /**
   * Last `Date.now()` at which `isContainerAlive` returned true. Used to
   * cache the result and skip the ~30-70ms `inspect` probe when the container
   * was confirmed alive recently. The window is narrow enough that a stale
   * cache only delays self-heal by ALIVE_PROBE_TTL_MS in the rare case where
   * the container died externally.
   */
  private lastAliveProbeMs = 0
  private static readonly ALIVE_PROBE_TTL_MS = 30_000

  constructor(opts: DockerBackendOpts) {
    this.image = opts.image ?? 'nikolaik/python-nodejs:python3.11-nodejs20'
    this.mountWorkspace = opts.mountWorkspace ?? false
    this.runtime = detectRuntime(opts.runtimePath)
    this.startTimeoutMs = opts.startTimeoutMs ?? 60_000
    this.workspaceRoot = opts.workspaceRoot
    this.cpu = opts.cpu
    this.memoryMb = opts.memoryMb
    this.diskMb = opts.diskMb
    this.noNetwork = opts.noNetwork ?? false
    this.label = `${this.runtime.runtime}:${this.image}${this.mountWorkspace ? '+workspace' : ''}`
  }

  /**
   * Lazy-starts the container on first call. Reuses on subsequent calls.
   * Synchronous assignment to `this.starting` BEFORE the first await ensures
   * concurrent first-callers all wait on the same Promise (otherwise each
   * read `this.starting === null`, each kicked off `startContainer`, and only
   * the last wrote — leaking N-1 orphan containers).
   */
  private ensureContainer(): Promise<string> {
    if (this.containerId) return Promise.resolve(this.containerId)
    if (this.starting) return this.starting
    const promise = this.startContainer().then(
      id => {
        this.containerId = id
        return id
      },
      err => {
        this.starting = null
        throw err
      },
    )
    this.starting = promise
    return promise
  }

  private async startContainer(): Promise<string> {
    // Verify the runtime daemon/machine is reachable. Fast-fail with a clear
    // error if not. Podman on macOS needs `podman machine start` once before
    // the API responds.
    try {
      await exec(this.runtime.path, ['version', '--format', '{{.Server.Version}}'], {
        timeout: 5_000,
      })
    } catch (err) {
      const hint =
        this.runtime.runtime === 'podman'
          ? "Run `podman machine start` if you haven't yet."
          : 'Start Docker Desktop.'
      throw new Error(
        `${this.runtime.runtime} daemon unreachable (${(err as Error).message}). ${hint} Or set sandbox.mode='os' / 'none'.`,
      )
    }

    const runArgs: string[] = ['run', '-d', '--rm', '--label', 'lyra-sandbox=1', ...HARDENING_ARGS]
    // Run as host UID so files created in a mounted workspace are owned by
    // the host user. Podman rootless on macOS handles this automatically; we
    // only force --user on docker/podman where the default would be root.
    if (this.runtime.runtime === 'docker') {
      runArgs.push('--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`)
    }
    // Optional resource caps. `--cpus` and `--memory` work cross-platform.
    // `--storage-opt size` only works on Linux + overlay2 with pquota; we
    // skip it on darwin to match hermes' behavior (silently a no-op there).
    if (this.cpu && this.cpu > 0) runArgs.push('--cpus', String(this.cpu))
    if (this.memoryMb && this.memoryMb > 0) runArgs.push('--memory', `${this.memoryMb}m`)
    if (this.diskMb && this.diskMb > 0 && process.platform !== 'darwin') {
      runArgs.push('--storage-opt', `size=${this.diskMb}m`)
    }
    if (this.noNetwork) runArgs.push('--network=none')
    if (this.mountWorkspace) {
      runArgs.push('-v', `${this.workspaceRoot}:/workspace`)
      runArgs.push('-w', '/workspace')
    }
    // Mount the host's tmpdir READ-ONLY at the same path inside the container
    // so code.execute's host-written snippet (mkdtemp + writeFile happen on
    // host, then `python3 <hostpath>` runs in container) is actually readable.
    // RO so the container can't write back — the container's own /tmp stays
    // isolated and `rm /var/folders/...` from inside fails with EROFS.
    const hostTmp = tmpdir()
    runArgs.push('-v', `${hostTmp}:${hostTmp}:ro`)
    runArgs.push(this.image, 'tail', '-f', '/dev/null')

    const { stdout } = await exec(this.runtime.path, runArgs, {
      timeout: this.startTimeoutMs,
    })
    const containerId = stdout.toString().trim()
    if (!containerId || containerId.length < 12) {
      throw new Error(
        `${this.runtime.runtime} run returned unexpected output: "${containerId.slice(0, 200)}"`,
      )
    }
    return containerId
  }

  async wrapSpawn(req: SandboxSpawnRequest): Promise<WrappedSpawn> {
    let containerId = await this.ensureContainer()
    // Self-heal stale cache: container may have died since last call (external
    // `podman kill`, OOM, daemon restart, --rm cleanup after host crash).
    // Probe is rate-limited to ALIVE_PROBE_TTL_MS so the happy path doesn't
    // pay the ~30-70ms inspect tax on every spawn — only the first call after
    // the TTL window pays. Worst case after external kill: one failed exec
    // before the next probe re-spawns.
    const now = Date.now()
    if (now - this.lastAliveProbeMs > DockerBackend.ALIVE_PROBE_TTL_MS) {
      if (!(await this.isContainerAlive(containerId))) {
        this.containerId = null
        this.starting = null
        this.lastAliveProbeMs = 0
        containerId = await this.ensureContainer()
      }
      this.lastAliveProbeMs = Date.now()
    }
    // `exec -i` (interactive stdin), preserve env subset, run inside the
    // container. We pass env explicitly via `-e` rather than relying on
    // container env so redactedEnv from the tool layer actually reaches the
    // inner process.
    const envArgs: string[] = []
    if (req.options.env) {
      for (const [k, v] of Object.entries(req.options.env)) {
        if (typeof v === 'string') envArgs.push('-e', `${k}=${v}`)
      }
    }
    const cwdArg: string[] = []
    if (this.mountWorkspace && req.options.cwd === this.workspaceRoot) {
      cwdArg.push('-w', '/workspace')
    }
    // Strip cwd + env from passed-through options because we redirected both
    // into exec flags. Keep stdio/etc.
    const {
      cwd: _cwd,
      env: _env,
      ...passOptions
    } = req.options as SpawnOptions & {
      cwd?: unknown
      env?: unknown
    }
    return {
      command: this.runtime.path,
      args: ['exec', '-i', ...envArgs, ...cwdArg, containerId, req.command, ...req.args],
      options: passOptions,
    }
  }

  /**
   * Fast liveness probe. `inspect --format '{{.State.Running}}'` returns
   * "true" / "false" when the container exists, fails non-zero when missing.
   * 3s timeout prevents a wedged daemon from stalling every spawn.
   */
  private async isContainerAlive(id: string): Promise<boolean> {
    try {
      const { stdout } = await exec(
        this.runtime.path,
        ['inspect', '--format', '{{.State.Running}}', id],
        { timeout: 3_000 },
      )
      return stdout.toString().trim() === 'true'
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    if (!this.containerId) return
    const id = this.containerId
    this.containerId = null
    this.starting = null
    this.lastAliveProbeMs = 0
    try {
      await exec(this.runtime.path, ['kill', id], { timeout: 5_000 })
    } catch {
      // Container may already be dead; --rm cleaned up. Best-effort.
    }
  }

  envHint(): SandboxEnvHint {
    return {
      mode: 'docker',
      label: this.label,
      innerOs: 'linux',
      workspaceMount: this.mountWorkspace ? '/workspace' : null,
      scope:
        'shell.run, code.execute, shell.process_start run inside the container; fs.*, browser.*, memory.* run on the host',
    }
  }
}
