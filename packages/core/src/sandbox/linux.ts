/**
 * Linux bubblewrap (`bwrap`) backend. Mirrors the macOS sandbox-exec backend
 * for Linux operators. Wraps every tool spawn in:
 *
 *   bwrap <profile-args...> <orig-command> <orig-args...>
 *
 * `bwrap` is unprivileged user-namespace sandboxing — the same primitive
 * Flatpak / Bubblewrap / chromium use. No setuid required (kernel must have
 * unprivileged user namespaces enabled, which is the default on every modern
 * distro: Ubuntu 22+, Fedora, Arch, Debian 11+).
 *
 * Profile policy mirrors macOS seatbelt:
 *   - read-only bind of / (so commands like `cat`, `ls`, `find` work)
 *   - writable bind of agentDir + workspaceRoot
 *   - writable bind of /tmp (lyra-* dirs land there)
 *   - tmpfs overlay of credential dirs (~/.ssh, ~/.aws, ~/Library/Keychains
 *     [doesn't exist on Linux but cheap to include for portability],
 *     ~/.config/gcloud) — reads return empty
 *   - --unshare-all --share-net keeps network reachable so lyra can still
 *     hit Sui RPC, the indexer, etc.
 *   - --die-with-parent kills the child if lyra crashes, no zombies
 *   - --new-session puts the child in its own session (Ctrl-C from lyra
 *     doesn't propagate to the inner command)
 */

import { existsSync } from 'node:fs'
import { credentialDirs } from './credentials'
import type {
  SandboxBackend,
  SandboxBackendOpts,
  SandboxEnvHint,
  SandboxSpawnRequest,
  WrappedSpawn,
} from './types'

/**
 * Probe order for bwrap binary. Most distros put it at /usr/bin/bwrap; some
 * via pkg-managed systems at /usr/local/bin. First existing path wins.
 */
const BWRAP_CANDIDATES: readonly string[] = ['/usr/bin/bwrap', '/usr/local/bin/bwrap']

function findBwrap(): string | null {
  for (const path of BWRAP_CANDIDATES) {
    if (existsSync(path)) return path
  }
  return null
}

/**
 * Build the bwrap argv prefix that wraps the user command. Returns a flat
 * argv array; the actual command + args are appended after.
 */
export function buildBwrapArgs(opts: SandboxBackendOpts): string[] {
  const args: string[] = []

  // Base filesystem: read-only bind of /. The container can read system tools
  // (cat, ls, etc.) but cannot modify them. Override specific subdirs below.
  args.push('--ro-bind', '/', '/')

  // Writable subdirs: agentDir + workspaceRoot + /tmp (for lyra-* test dirs)
  args.push('--bind', opts.agentDir, opts.agentDir)
  args.push('--bind', opts.workspaceRoot, opts.workspaceRoot)
  args.push('--bind', '/tmp', '/tmp')

  // Optional extra-writable subpaths (test sandbox dirs, custom workspaces).
  if (opts.extraWriteAllow) {
    for (const path of opts.extraWriteAllow) {
      args.push('--bind', path, path)
    }
  }

  // Credential blackouts: empty tmpfs overlays so reads return ENOENT-equivalent.
  // Shared list with seatbelt-profile.ts to prevent platform drift.
  for (const dir of credentialDirs(opts.homedir)) {
    args.push('--tmpfs', dir)
  }

  // Optional extra denies via tmpfs.
  if (opts.extraWriteDeny) {
    for (const path of opts.extraWriteDeny) {
      args.push('--tmpfs', path)
    }
  }

  // System pseudo-filesystems.
  args.push('--proc', '/proc')
  args.push('--dev', '/dev')

  // Namespace isolation: unshare everything except network (lyra needs network
  // for Sui RPC, indexer, brain inference). PID namespace isolates process tree
  // from host. UTS namespace gives the sandbox its own hostname.
  args.push('--unshare-all', '--share-net')

  // Lifetime + signal handling.
  args.push('--die-with-parent') // child dies if lyra dies
  args.push('--new-session') // Ctrl-C from lyra doesn't kill the child directly

  return args
}

export class LinuxBubblewrapBackend implements SandboxBackend {
  readonly mode = 'os' as const
  readonly label = 'os:linux'
  private readonly bwrapPath: string
  private readonly bwrapArgs: string[]

  constructor(opts: SandboxBackendOpts) {
    const path = findBwrap()
    if (!path) {
      throw new Error(
        `bwrap not found in ${BWRAP_CANDIDATES.join(', ')}. Linux sandbox backend requires bubblewrap (apt install bubblewrap / dnf install bubblewrap).`,
      )
    }
    this.bwrapPath = path
    this.bwrapArgs = buildBwrapArgs(opts)
  }

  /** Test-only accessor for the bwrap argv prefix. */
  getBwrapArgs(): readonly string[] {
    return this.bwrapArgs
  }

  envHint(): SandboxEnvHint {
    return {
      mode: 'os',
      label: this.label,
      innerOs: 'linux',
      workspaceMount: null,
      scope:
        'shell.run, code.execute, shell.process_start are wrapped in a bubblewrap profile; writes outside agentDir + cwd + /tmp/lyra-* are denied',
    }
  }

  async wrapSpawn(req: SandboxSpawnRequest): Promise<WrappedSpawn> {
    return {
      command: this.bwrapPath,
      args: [...this.bwrapArgs, '--', req.command, ...req.args],
      options: req.options,
    }
  }
}
