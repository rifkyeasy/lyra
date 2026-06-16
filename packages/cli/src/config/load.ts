import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type NebulaConfig, agentPaths } from 'nebula-ai-core'

/**
 * Load the user's `nebula.config.ts`.
 *
 * Phase 6.6: canonical location is `~/.nebula/config.ts` (returned by
 * `agentPaths.config`). If that file exists, it wins. Otherwise, fall back
 * to walking upward from cwd looking for `nebula.config.ts` (legacy v0.5.0
 * pattern, kept so existing dev setups still work without a migration step).
 */
export async function findAndLoadConfig(
  startDir: string = process.cwd(),
): Promise<{ config: NebulaConfig; path: string } | null> {
  const canonical = agentPaths.config
  if (existsSync(canonical)) {
    const mod = (await import(canonical)) as { default: NebulaConfig }
    if (!mod.default) throw new Error(`nebula config at ${canonical} has no default export`)
    return { config: mod.default, path: canonical }
  }

  let dir = resolve(startDir)
  while (true) {
    const candidate = resolve(dir, 'nebula.config.ts')
    if (existsSync(candidate)) {
      const mod = (await import(candidate)) as { default: NebulaConfig }
      if (!mod.default) throw new Error(`nebula.config.ts at ${candidate} has no default export`)
      return { config: mod.default, path: candidate }
    }
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
}
