import { spawn } from 'node:child_process'
import { LocalBackend, type SandboxBackend, type ToolDef, redactEnv } from 'lyra-core'
import { z } from 'zod'
import { type WorkingDirState, resolveCwd } from './cwd-state'

interface ShellToolDeps {
  /**
   * Working directory for spawned commands. Pass a `WorkingDirState` to share
   * the cwd with `shell.cd` and other shell-class tools (production path), or
   * a plain string for a fixed cwd (legacy + tests).
   */
  cwd: string | WorkingDirState
  /** Default timeout in ms. */
  defaultTimeoutMs?: number
  /**
   * Phase 9.5: sandbox backend wraps the spawn before exec. Default
   * `LocalBackend` is a passthrough (today's behaviour). When sandbox.mode='os'
   * on darwin, this becomes a sandbox-exec wrapper that denies writes outside
   * agentDir + workspaceRoot + /tmp/lyra-* + /var/folders. Optional for
   * back-compat: tests + legacy callers that don't supply it get LocalBackend.
   */
  sandbox?: SandboxBackend
}

const ShellSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Shell command to run. Quoted, fully formed (e.g., `ls -la`).'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .optional()
    .describe('Override default 60s timeout.'),
})

export function makeShellRun(deps: ShellToolDeps): ToolDef<z.infer<typeof ShellSchema>> {
  const sandbox = deps.sandbox ?? new LocalBackend()
  const cwdState = resolveCwd(deps.cwd)
  return {
    name: 'shell.run',
    description:
      'Run a shell command in the agent workspace. Subject to permission approval (mode `prompt` or `strict`). Wallet/API-key environment variables are redacted before launch. Captures stdout/stderr; killed on timeout.',
    searchHint: 'shell run bash command execute subprocess',
    schema: ShellSchema,
    handler: async args => {
      const cwd = cwdState.get()
      const timeout = args.timeout_ms ?? deps.defaultTimeoutMs ?? 60_000
      const { env: redactedEnv, removed } = redactEnv(process.env)
      // Build an explicit /bin/sh -c <cmd> argv so the sandbox backend can
      // wrap it without colliding with shell:true semantics. The wrapper may
      // prepend e.g. sandbox-exec -p <profile>; spawn must see a real argv.
      const wrapped = await sandbox.wrapSpawn({
        command: '/bin/sh',
        args: ['-c', args.command],
        options: { cwd, env: redactedEnv },
      })
      return new Promise(resolve => {
        const child = spawn(wrapped.command, wrapped.args, wrapped.options)
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeout)
        child.stdout?.on('data', chunk => {
          stdout += String(chunk)
          if (stdout.length > 200_000) stdout = stdout.slice(-200_000)
        })
        child.stderr?.on('data', chunk => {
          stderr += String(chunk)
          if (stderr.length > 200_000) stderr = stderr.slice(-200_000)
        })
        child.on('close', code => {
          clearTimeout(timer)
          resolve({
            ok: !timedOut && code === 0,
            data: {
              command: args.command,
              code,
              timedOut,
              stdout: stdout.slice(-32_000),
              stderr: stderr.slice(-32_000),
              cwd,
              redactedEnvVars: removed,
            },
            ...(timedOut
              ? { error: `command timed out after ${timeout}ms` }
              : code !== 0
                ? { error: `exit code ${code}` }
                : {}),
          })
        })
        child.on('error', e => {
          clearTimeout(timer)
          resolve({ ok: false, error: e.message })
        })
      })
    },
  }
}
