import { readFile, writeFile } from 'node:fs/promises'
import { type ToolDef, scanSkills } from 'lyra-core'
import { z } from 'zod'

/**
 * Phase 9.1 skills.manage. Persists per-skill on/off state into the user's
 * lyra config (under `skills.disabled[]`). Re-scans the disk on every call so
 * the user can install a new skill in another shell and the agent picks it up
 * without restart.
 */

interface SkillsManageDeps {
  importsClaudeCode: boolean
  /** Path to ~/.lyra/config.ts. Used to read+rewrite the disabled list. */
  configPath: string
  /** When set, the manage tool reports this list as the active disabled set. */
  disabledRef?: { current: string[] }
  lyraSkillsRoot?: string
  claudeSkillsRoot?: string
  claudePluginsCacheRoot?: string
  lyraPluginsRoot?: string
}

const DISABLED_BLOCK_RE = /skills:\s*\{[^}]*disabled:\s*\[([\s\S]*?)\][^}]*\}/

const ManageSchema = z.object({
  action: z
    .enum(['list', 'enable', 'disable', 'refresh'])
    .describe(
      "'list' shows enabled+disabled skills; 'enable' / 'disable' flip a specific skill id; 'refresh' re-scans the disk.",
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe('Skill id to enable/disable. Required for enable/disable actions.'),
})

export function makeSkillsManage(deps: SkillsManageDeps): ToolDef<z.infer<typeof ManageSchema>> {
  return {
    name: 'skills.manage',
    description:
      "Enable/disable specific skills, or list all skills with their on/off state. Disabled skills are persisted in ~/.lyra/config.ts so the next session honors the choice. Use 'refresh' to re-scan the disk after installing a new skill.",
    searchHint: 'skills manage enable disable toggle',
    schema: ManageSchema,
    handler: async args => {
      const all = await scanSkills({
        importsClaudeCode: deps.importsClaudeCode,
        lyraSkillsRoot: deps.lyraSkillsRoot,
        lyraPluginsRoot: deps.lyraPluginsRoot,
        claudeSkillsRoot: deps.claudeSkillsRoot,
        claudePluginsCacheRoot: deps.claudePluginsCacheRoot,
      })
      const disabled = new Set(deps.disabledRef?.current ?? [])
      if (args.action === 'list' || args.action === 'refresh') {
        return {
          ok: true,
          data: {
            total: all.length,
            disabled: [...disabled].sort(),
            skills: all
              .map(s => ({
                id: s.id,
                source: s.source,
                enabled: !disabled.has(s.id),
                description: s.description,
              }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          },
        }
      }
      if (!args.id) {
        return { ok: false, error: 'id is required for enable/disable' }
      }
      const known = all.find(s => s.id === args.id)
      if (!known) return { ok: false, error: `unknown skill: ${args.id}` }
      if (args.action === 'enable') disabled.delete(args.id)
      else disabled.add(args.id)
      const next = [...disabled].sort()
      try {
        await persistDisabled(deps.configPath, next)
      } catch (e) {
        return { ok: false, error: `failed to update config: ${(e as Error).message}` }
      }
      if (deps.disabledRef) deps.disabledRef.current = next
      return {
        ok: true,
        data: { id: args.id, action: args.action, disabled: next },
      }
    },
  }
}

async function persistDisabled(configPath: string, disabled: readonly string[]): Promise<void> {
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    raw = ''
  }
  const block = `skills: { disabled: [${disabled.map(s => `'${s.replace(/'/g, "\\'")}'`).join(', ')}] }`
  if (raw.includes('skills:')) {
    const next = raw.replace(DISABLED_BLOCK_RE, block)
    await writeFile(configPath, next, 'utf8')
    return
  }
  // Insert just before the closing `}` of the top-level config object. Works
  // for both `defineConfig({...})` and `export default {...}` shapes.
  const inserted = injectKey(raw, block)
  if (inserted) {
    await writeFile(configPath, inserted, 'utf8')
    return
  }
  await writeFile(configPath, `${raw}\n// lyra added: ${block}\n`, 'utf8')
}

function injectKey(raw: string, block: string): string | null {
  // Find the last `}` that closes the config object (handles both
  // `}\n` and `})\n` endings; strips trailing whitespace).
  const closer = raw.match(/\n}\)?\s*$/)
  if (!closer) return null
  const before = raw.slice(0, closer.index)
  const after = raw.slice(closer.index!)
  const sep = before.trimEnd().endsWith(',') ? '\n' : ',\n'
  return `${before.trimEnd()}${sep}  ${block}${after}`
}
