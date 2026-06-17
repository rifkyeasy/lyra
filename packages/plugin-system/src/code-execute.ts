import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalBackend, type SandboxBackend, type ToolDef, redactEnv } from 'lyra-core'
import { z } from 'zod'
import { type WorkingDirState, resolveCwd } from './cwd-state'

/**
 * `code.execute` runs a snippet in a subprocess. Wraps shell.run with an
 * interpreter + temp-file pattern so the brain doesn't have to escape strings
 * into a one-liner. Honours the same permission floor as shell.run via the
 * pre_tool_call hook (the chat layer maps `code.execute` → `shell.run`-equivalent
 * dangerous-pattern check).
 */

const ALLOWED_LANGUAGES = ['bash', 'python', 'node', 'bun', 'ts', 'js'] as const

const ExecuteSchema = z.object({
  language: z
    .enum(ALLOWED_LANGUAGES)
    .describe("Interpreter: 'bash', 'python', 'node', 'bun', 'ts', or 'js'."),
  code: z.string().min(1).describe('Source code to execute.'),
  stdin: z.string().optional().describe('Optional stdin content piped to the process.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe('Kill the process after N ms. Default 30000.'),
  cwd: z.string().optional().describe('Working directory. Default: workspace root.'),
})

interface CodeExecuteDeps {
  /**
   * Working directory. Pass a `WorkingDirState` to share with `shell.cd`
   * (production); a plain string for a fixed cwd (tests).
   */
  cwd: string | WorkingDirState
  /** Phase 9.5: sandbox backend wraps the spawn. LocalBackend = passthrough. Optional for back-compat. */
  sandbox?: SandboxBackend
}

interface RunResult {
  ok: boolean
  data?: {
    exit_code: number | null
    stdout: string
    stderr: string
    timed_out: boolean
  }
  error?: string
}

export function makeCodeExecute(deps: CodeExecuteDeps): ToolDef<z.infer<typeof ExecuteSchema>> {
  const sandbox = deps.sandbox ?? new LocalBackend()
  const cwdState = resolveCwd(deps.cwd)
  return {
    name: 'code.execute',
    description:
      "Run a code snippet in bash/python/node/bun. Returns exit code, stdout, stderr. Honours the agent's permission/dangerous-pattern floor (shell.run-equivalent).",
    searchHint: 'code execute python javascript bash run snippet',
    schema: ExecuteSchema,
    handler: async args => execute(args, cwdState.get(), sandbox),
  }
}

async function execute(
  args: z.infer<typeof ExecuteSchema>,
  defaultCwd: string,
  sandbox: SandboxBackend,
): Promise<RunResult> {
  const interp = pickInterpreter(args.language)
  if (!interp) return { ok: false, error: `unsupported language: ${args.language}` }
  const dir = await mkdtemp(join(tmpdir(), 'lyra-code-'))
  const file = join(dir, `snippet.${interp.ext}`)
  await writeFile(file, args.code, 'utf8')
  const cwd = args.cwd && args.cwd.trim().length > 0 ? args.cwd : defaultCwd
  const timeoutMs = args.timeout_ms ?? 30_000
  const { env: redactedEnv } = redactEnv(process.env as Record<string, string>)
  const wrapped = await sandbox.wrapSpawn({
    command: interp.command,
    args: [...interp.args, file],
    options: { cwd, env: redactedEnv },
  })
  return await new Promise<RunResult>(resolve => {
    const proc = spawn(wrapped.command, wrapped.args, wrapped.options)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill('SIGKILL')
      } catch {}
    }, timeoutMs)
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', chunk => {
      stdout += chunk as string
      if (stdout.length > 50_000) stdout = stdout.slice(-50_000)
    })
    proc.stderr?.on('data', chunk => {
      stderr += chunk as string
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000)
    })
    proc.on('error', err => {
      clearTimeout(timer)
      rm(dir, { recursive: true, force: true }).catch(() => {})
      resolve({ ok: false, error: err.message })
    })
    proc.on('close', code => {
      clearTimeout(timer)
      rm(dir, { recursive: true, force: true }).catch(() => {})
      resolve({
        ok: !timedOut && (code ?? 0) === 0,
        data: { exit_code: code, stdout, stderr, timed_out: timedOut },
      })
    })
    if (args.stdin !== undefined) {
      try {
        proc.stdin?.write(args.stdin)
        proc.stdin?.end()
      } catch {}
    } else {
      proc.stdin?.end()
    }
  })
}

interface Interpreter {
  command: string
  args: string[]
  ext: string
}

function pickInterpreter(lang: (typeof ALLOWED_LANGUAGES)[number]): Interpreter | null {
  switch (lang) {
    case 'bash':
      return { command: 'bash', args: [], ext: 'sh' }
    case 'python':
      return { command: 'python3', args: [], ext: 'py' }
    case 'node':
    case 'js':
      return { command: 'node', args: [], ext: 'js' }
    case 'bun':
    case 'ts':
      return { command: 'bun', args: ['run'], ext: 'ts' }
  }
}
