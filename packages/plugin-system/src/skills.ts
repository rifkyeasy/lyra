import { readFile } from 'node:fs/promises'
import { type SkillRef, type ToolDef, coerceInt, scanSkills } from 'lyra-core'
import { z } from 'zod'

/**
 * Phase 9.1 skills surface. The scanner now lives in core (it's also used by
 * the frozen-prefix builder + auto-trigger hook); these two tools are the
 * brain-callable views.
 */

interface SkillsToolDeps {
  importsClaudeCode: boolean
  /** Override the lyra skills root. Defaults to agentPaths.skills. */
  lyraSkillsRoot?: string
  /** Override the Claude Code skills root. Default: $HOME/.claude/skills. */
  claudeSkillsRoot?: string
  /** Override the Claude Code plugins cache root. Default: $HOME/.claude/plugins/cache. */
  claudePluginsCacheRoot?: string
  /** Override the lyra plugins root. Defaults to agentPaths.plugins. */
  lyraPluginsRoot?: string
  /** Disabled skill ids (skills.manage persists this set into config). */
  disabled?: readonly string[]
}

async function discover(deps: SkillsToolDeps): Promise<SkillRef[]> {
  const found = await scanSkills({
    importsClaudeCode: deps.importsClaudeCode,
    lyraSkillsRoot: deps.lyraSkillsRoot,
    lyraPluginsRoot: deps.lyraPluginsRoot,
    claudeSkillsRoot: deps.claudeSkillsRoot,
    claudePluginsCacheRoot: deps.claudePluginsCacheRoot,
  })
  if (!deps.disabled || deps.disabled.length === 0) return found
  const disabled = new Set(deps.disabled)
  return found.filter(s => !disabled.has(s.id))
}

const ListSchema = z.object({
  source: z.enum(['lyra', 'lyra-plugin', 'claude-code', 'claude-plugin', 'all']).optional(),
})

export function makeSkillsList(deps: SkillsToolDeps): ToolDef<z.infer<typeof ListSchema>> {
  return {
    name: 'skills.list',
    description:
      'List skills from ~/.lyra/skills, ~/.lyra/plugins/<n>/skills, ~/.claude/skills, and ~/.claude/plugins/cache/<m>/<p>/<v>/skills (when imports.claudeCode). Returns id, name, description, source, path.',
    searchHint: 'skills list catalog discover available',
    schema: ListSchema,
    handler: async args => {
      const all = await discover(deps)
      const filter = args.source ?? 'all'
      const filtered = filter === 'all' ? all : all.filter(s => s.source === filter)
      return {
        ok: true,
        data: {
          skills: filtered.map(s => ({
            id: s.id,
            name: s.frontmatter.name ?? s.name,
            description: s.description,
            path: s.path,
            source: s.source,
            filePattern: s.frontmatter.filePattern ?? null,
            bashPattern: s.frontmatter.bashPattern ?? null,
          })),
        },
      }
    },
  }
}

const ViewSchema = z.object({
  id: z.string().min(1).describe('Skill id from skills.list (e.g., "lyra:dogfood").'),
  max_bytes: coerceInt.refine(n => n > 0 && n <= 200_000, 'max_bytes must be 1..200000').optional(),
})

export function makeSkillsView(deps: SkillsToolDeps): ToolDef<z.infer<typeof ViewSchema>> {
  return {
    name: 'skills.view',
    description:
      'Read the full SKILL.md body for a skill identified by `skills.list`. Use to inline a skill before applying it.',
    searchHint: 'skills view read body content',
    schema: ViewSchema,
    handler: async args => {
      const all = await discover(deps)
      const skill = all.find(s => s.id === args.id)
      if (!skill) return { ok: false, error: `unknown skill: ${args.id}` }
      try {
        const buf = await readFile(skill.path)
        const cap = args.max_bytes ?? 100_000
        const truncated = buf.byteLength > cap
        const text = buf.subarray(0, Math.min(buf.byteLength, cap)).toString('utf8')
        return {
          ok: true,
          data: {
            id: skill.id,
            path: skill.path,
            text,
            bytes: buf.byteLength,
            truncated,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  }
}
