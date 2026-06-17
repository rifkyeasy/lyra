import { type ChildProcess, spawn } from 'node:child_process'
import {
  LocalBackend,
  type SandboxBackend,
  type ToolDef,
  coerceBool,
  redactEnv,
} from 'lyra-core'
import { z } from 'zod'
import { type WorkingDirState, resolveCwd } from './cwd-state'

/**
 * v0.9.3 split: long-running subprocess management is FOUR flat tools, not
 * a discriminated union. qwen3.6-plus narrates results when faced with
 * `action: 'start'|'output'|'list'|'kill'` schemas (regression #1). Flat
 * z.object schemas remove that footgun.
 *
 * - `shell.process_start`  — spawn a backgrounded command, returns id
 * - `shell.process_output` — read stdout/stderr by id
 * - `shell.process_list`   — list active + recently-exited entries
 * - `shell.process_kill`   — terminate by id (SIGTERM / SIGKILL / SIGINT)
 *
 * State lives in module-level memory shared across the four tools; the
 * process tree is killed when lyra exits via killAllProcesses().
 *
 * Distinct from `shell.run` which waits for completion (one-shot
 * commands). shell.process_start backgrounds it (dev servers, watchers).
 */

interface BackgroundProcess {
  id: string
  command: string
  cwd: string
  proc: ChildProcess
  stdout: string
  stderr: string
  startedAt: number
  exitCode: number | null
  exitedAt: number | null
}

const processes = new Map<string, BackgroundProcess>()

interface ShellProcessDeps {
  /**
   * Working directory. Pass a `WorkingDirState` to share with `shell.cd`
   * (production); a plain string for a fixed cwd (tests).
   */
  cwd: string | WorkingDirState
  /** Phase 9.5: sandbox wraps the long-running spawn. LocalBackend = passthrough. Optional for back-compat. */
  sandbox?: SandboxBackend
}

const StartSchema = z.object({
  command: z.string().min(1).describe('Command to run via /bin/sh -c, in the background.'),
  cwd: z.string().optional().describe('Working directory override. Defaults to lyra cwd.'),
})

const OutputSchema = z.object({
  id: z.string().min(1).describe('Process id from a prior shell.process_start.'),
  clear: coerceBool.optional().describe('Clear captured output after returning. Default false.'),
})

const ListSchema = z.object({})

const KillSchema = z.object({
  id: z.string().min(1).describe('Process id from a prior shell.process_start.'),
  signal: z
    .enum(['SIGTERM', 'SIGKILL', 'SIGINT'])
    .optional()
    .describe('Signal to send. Default SIGTERM.'),
})

export function makeShellProcessStart(
  deps: ShellProcessDeps,
): ToolDef<z.infer<typeof StartSchema>> {
  const sandbox = deps.sandbox ?? new LocalBackend()
  const cwdState = resolveCwd(deps.cwd)
  return {
    name: 'shell.process_start',
    description:
      'Spawn a backgrounded shell command and return its id. Use for dev servers, watchers, REPLs, anything you need to keep running while you do other things. For one-shot commands, use shell.run instead.',
    searchHint: 'shell process spawn background daemon long running start',
    schema: StartSchema,
    handler: async args => startProcess(args.command, args.cwd ?? cwdState.get(), sandbox),
  }
}

export function makeShellProcessOutput(): ToolDef<z.infer<typeof OutputSchema>> {
  return {
    name: 'shell.process_output',
    description:
      'Read accumulated stdout + stderr of a backgrounded process by id. Returns running flag and exit_code (null while running). Set clear=true to drain the buffer after reading.',
    searchHint: 'shell process output stdout stderr capture read',
    schema: OutputSchema,
    handler: async args => captureOutput(args.id, args.clear ?? false),
  }
}

export function makeShellProcessList(): ToolDef<z.infer<typeof ListSchema>> {
  return {
    name: 'shell.process_list',
    description:
      'List all backgrounded processes (active and recently-exited) with their commands, cwd, and status.',
    searchHint: 'shell process list active running daemons subprocesses',
    schema: ListSchema,
    handler: async () => listProcesses(),
  }
}

export function makeShellProcessKill(): ToolDef<z.infer<typeof KillSchema>> {
  return {
    name: 'shell.process_kill',
    description:
      'Terminate a backgrounded process by id. Default signal is SIGTERM. Returns killed=true if a live process was signalled, killed=false if it had already exited.',
    searchHint: 'shell process kill terminate sigterm sigkill stop',
    schema: KillSchema,
    handler: async args => killProcess(args.id, args.signal ?? 'SIGTERM'),
  }
}

async function startProcess(
  command: string,
  cwd: string,
  sandbox: SandboxBackend,
): Promise<{ ok: boolean; data?: { id: string }; error?: string }> {
  const id = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { env } = redactEnv(process.env as Record<string, string>)
  const wrapped = await sandbox.wrapSpawn({
    command: '/bin/sh',
    args: ['-c', command],
    options: { cwd, env },
  })
  const proc = spawn(wrapped.command, wrapped.args, wrapped.options)
  const entry: BackgroundProcess = {
    id,
    command,
    cwd,
    proc,
    stdout: '',
    stderr: '',
    startedAt: Date.now(),
    exitCode: null,
    exitedAt: null,
  }
  processes.set(id, entry)
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', chunk => {
    entry.stdout += chunk as string
    if (entry.stdout.length > 200_000) entry.stdout = entry.stdout.slice(-200_000)
  })
  proc.stderr?.on('data', chunk => {
    entry.stderr += chunk as string
    if (entry.stderr.length > 100_000) entry.stderr = entry.stderr.slice(-100_000)
  })
  proc.on('exit', code => {
    entry.exitCode = code
    entry.exitedAt = Date.now()
  })
  return { ok: true, data: { id } }
}

function captureOutput(
  id: string,
  clear: boolean,
): {
  ok: boolean
  data?: {
    id: string
    stdout: string
    stderr: string
    exit_code: number | null
    running: boolean
    started_at: number
    exited_at: number | null
  }
  error?: string
} {
  const entry = processes.get(id)
  if (!entry) return { ok: false, error: `unknown process: ${id}` }
  const out = {
    id,
    stdout: entry.stdout,
    stderr: entry.stderr,
    exit_code: entry.exitCode,
    running: entry.exitCode === null,
    started_at: entry.startedAt,
    exited_at: entry.exitedAt,
  }
  if (clear) {
    entry.stdout = ''
    entry.stderr = ''
  }
  if (entry.exitCode !== null && clear) {
    processes.delete(id)
  }
  return { ok: true, data: out }
}

function listProcesses(): {
  ok: boolean
  data: {
    processes: Array<{
      id: string
      command: string
      cwd: string
      running: boolean
      exit_code: number | null
      started_at: number
    }>
  }
} {
  return {
    ok: true,
    data: {
      processes: [...processes.values()].map(p => ({
        id: p.id,
        command: p.command,
        cwd: p.cwd,
        running: p.exitCode === null,
        exit_code: p.exitCode,
        started_at: p.startedAt,
      })),
    },
  }
}

function killProcess(
  id: string,
  signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT',
): { ok: boolean; data?: { id: string; killed: boolean }; error?: string } {
  const entry = processes.get(id)
  if (!entry) return { ok: false, error: `unknown process: ${id}` }
  if (entry.exitCode !== null) {
    processes.delete(id)
    return { ok: true, data: { id, killed: false } }
  }
  try {
    entry.proc.kill(signal)
    return { ok: true, data: { id, killed: true } }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Kill all tracked processes. Called by chat.tsx on session exit. */
export function killAllProcesses(): void {
  for (const entry of processes.values()) {
    if (entry.exitCode !== null) continue
    try {
      entry.proc.kill('SIGTERM')
    } catch {}
  }
}
