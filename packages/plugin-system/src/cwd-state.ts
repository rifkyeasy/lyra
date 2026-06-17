/**
 * Mutable working-directory container shared across shell-class tools.
 *
 * shell.cd updates `current`; shell.run, code.execute, shell.process_start
 * read `current` at handler invocation time. One instance per lyra session,
 * created in the plugin's `register()` hook and threaded into every shell-class
 * tool factory.
 *
 * Tests + legacy callers can pass a plain string to those factories; we
 * normalize via `resolveCwd()` so the existing `cwd: '/tmp/foo'` shape keeps
 * working but creates a tool-local container that won't share state with
 * other tools — fine for unit tests, wrong for production where the chat
 * layer must construct one shared `WorkingDirState`.
 */
export class WorkingDirState {
  private current: string

  constructor(initial: string) {
    this.current = initial
  }

  get(): string {
    return this.current
  }

  set(path: string): void {
    this.current = path
  }
}

export function resolveCwd(input: string | WorkingDirState): WorkingDirState {
  return typeof input === 'string' ? new WorkingDirState(input) : input
}
