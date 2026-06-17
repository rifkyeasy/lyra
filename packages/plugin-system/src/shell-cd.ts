import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { PathGuard, type ToolDef } from 'lyra-core'
import { z } from 'zod'
import { type WorkingDirState, resolveCwd } from './cwd-state'

interface ShellCdDeps {
  /** Mutable cwd container shared with shell.run / code.execute / shell.process_start. */
  cwd: string | WorkingDirState
  /** PathGuard agentDir — refuses cd into the agent's own state tree. */
  agentDir: string
}

const CdSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Absolute path or path relative to the current cwd. Use ~ for home. The new cwd persists across subsequent shell.run / code.execute / shell.process_start calls within this session.',
    ),
})

export function makeShellCd(deps: ShellCdDeps): ToolDef<z.infer<typeof CdSchema>> {
  const cwdState = resolveCwd(deps.cwd)
  const guard = new PathGuard({ agentDir: deps.agentDir })
  return {
    name: 'shell.cd',
    description:
      'Set the working directory for subsequent shell.run / code.execute / shell.process_start calls. Persists across calls in this session. Path is resolved against the current cwd; use absolute paths or ~ for clarity. Refuses to enter credential dirs (~/.ssh, ~/.aws, .config/gcloud) or the agent state tree.',
    searchHint: 'shell cd chdir change directory cwd working',
    schema: CdSchema,
    handler: async args => {
      const expanded = args.path.startsWith('~') ? args.path.replace('~', homedir()) : args.path
      const abs = isAbsolute(expanded) ? expanded : resolve(cwdState.get(), expanded)
      // Run the deny check FIRST — before any filesystem syscall — so a
      // protected target denies cleanly even when the path doesn't exist on
      // disk (e.g. CI runners without ~/.ssh would otherwise ENOENT before
      // the deny rule fires). PathGuard now canonicalises via realpath
      // internally and stores both raw + canonical denylist entries, so
      // symlinked credential dirs are still caught.
      const guardResult = guard.check(abs)
      if (!guardResult.allowed) {
        return { ok: false, error: guardResult.reason ?? 'path denied' }
      }
      // Canonicalise through realpath so the stored cwd matches what `pwd`
      // would print inside subsequent shell.run calls (macOS resolves
      // /var/folders → /private/var/folders, etc.).
      let canonical: string
      try {
        canonical = await realpath(abs)
      } catch (e) {
        return { ok: false, error: `stat failed: ${(e as Error).message}` }
      }
      // Re-check after canonicalisation — covers the (rare) case where the
      // raw form passes but the resolved target lands inside a denied tree.
      const guardCanonical = guard.check(canonical)
      if (!guardCanonical.allowed) {
        return { ok: false, error: guardCanonical.reason ?? 'path denied' }
      }
      try {
        const info = await stat(canonical)
        if (!info.isDirectory()) {
          return { ok: false, error: `not a directory: ${canonical}` }
        }
      } catch (e) {
        return { ok: false, error: `stat failed: ${(e as Error).message}` }
      }
      cwdState.set(canonical)
      return { ok: true, data: { cwd: canonical } }
    },
  }
}
