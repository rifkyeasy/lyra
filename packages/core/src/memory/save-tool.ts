import { join } from 'node:path'
import { z } from 'zod'
import { agentPaths } from '../paths'
import type { ToolDef } from '../tools/types'
import { addEntryLine, readIndexFile, writeIndexFile } from './index-file'
import { scanForThreats } from './scan'
import { readTopic, writeTopic } from './topic'
import {
  MEMORY_TYPES,
  type MemoryFrontmatter,
  type MemoryPartition,
  type MemoryTopic,
  type MemoryType,
} from './types'

const saveSchema = z.object({
  name: z.string().min(3).max(64).describe('Short human-readable title for this memory.'),
  description: z
    .string()
    .min(10)
    .max(240)
    .describe('One-line description used to decide relevance in future sessions. Be specific.'),
  type: z
    .enum(MEMORY_TYPES)
    .describe(
      'Memory type. agent-* transfers with iNFT; user/feedback/project/reference are operator-scoped and purge on transfer.',
    ),
  /** For MVP we only support full-body rewrite. Edit ops follow in phase 3.5+. */
  content: z
    .string()
    .min(1)
    .max(10_000)
    .describe('Full markdown body of the memory (no frontmatter — it gets added).'),
})

export type MemorySaveArgs = z.infer<typeof saveSchema>

/** Shape returned in `data` from a successful memory.save call. */
export interface MemorySaveData {
  file: string
  partition: MemoryPartition
  slug: string
  updated: boolean
}

export interface MakeMemorySaveToolArgs {
  agentId: string
  /**
   * Override the on-disk agent dir (e.g. `${TMPDIR}/lyra-gateway/<id>`).
   * Gateway daemon writes memory under tmpdir, not `~/.lyra/agents/<id>/`.
   * When provided, `topic` + `MEMORY.md` resolve against this root.
   * When absent, fall back to `agentPaths.agent(agentId).dir` for local-mode
   * callers (chat.tsx pre-gateway path).
   */
  agentDir?: string
}

export function makeMemorySaveTool({
  agentId,
  agentDir,
}: MakeMemorySaveToolArgs): ToolDef<MemorySaveArgs> {
  return {
    name: 'memory.save',
    description:
      'Save a durable fact, preference, or knowledge to long-term memory. Call proactively when you learn non-obvious things about the user or world. Skip derivable info (code patterns, git log, ephemeral state).',
    schema: saveSchema,
    handler: async args => {
      const scan = scanForThreats(args.content)
      if (!scan.ok) {
        return {
          ok: false,
          error: `Content rejected by threat scan: ${scan.violations.map(v => v.id).join(', ')}`,
        }
      }

      const partition = partitionForType(args.type)
      const slug = toSlug(args.name, args.type)
      const dir = agentDir ?? agentPaths.agent(agentId).dir
      const now = new Date().toISOString()

      const existing = await readTopic(dir, partition, slug)
      const isProfile = slug === PROFILE_SLUG && partition === 'user'
      const topic: MemoryTopic = {
        partition,
        slug,
        frontmatter: buildSaveFrontmatter(args, isProfile, existing, now),
        body: existing ? mergeBody(existing.body, args.content, slug) : args.content,
      }
      await writeTopic(dir, topic)

      const indexPath = agentDir
        ? join(agentDir, 'memory', 'MEMORY.md')
        : agentPaths.agent(agentId).memoryIndex
      const file = `${partition}/${slug}.md`
      await upsertIndexEntry(indexPath, file, args.name, args.description)

      const data: MemorySaveData = { file, partition, slug, updated: existing !== null }
      return { ok: true, data }
    },
  }
}

function partitionForType(type: MemoryType): MemoryPartition {
  return type.startsWith('agent-') ? 'agent' : 'user'
}

/** Build the frontmatter for a save, preserving profile invariants + prior timestamps. */
function buildSaveFrontmatter(
  args: MemorySaveArgs,
  isProfile: boolean,
  existing: MemoryTopic | null,
  now: string,
): MemoryFrontmatter {
  return {
    name: isProfile ? PROFILE_SLUG : args.name,
    description: isProfile
      ? (existing?.frontmatter.description ?? args.description)
      : args.description,
    type: args.type,
    createdAt: existing?.frontmatter.createdAt ?? now,
    updatedAt: now,
  }
}

/** Add the topic's index line to MEMORY.md if it isn't already registered. */
async function upsertIndexEntry(
  indexPath: string,
  file: string,
  name: string,
  description: string,
): Promise<void> {
  let index = await readIndexFile(indexPath)
  if (!index.entries.has(file)) {
    index = addEntryLine(index, {
      file,
      title: name,
      hook: description,
    })
    await writeIndexFile(indexPath, index)
  }
}

/**
 * Canonical operator-facts file in the user partition. Anchors to iNFT slot 3.
 * Any user/<other>.md file is local-only scratchpad until v0.24.0 ships the
 * multi-file user partition.
 */
export const PROFILE_SLUG = 'profile' as const

/**
 * Brain often picks ambiguous names for operator facts ("preferences",
 * "operator profile", "about me", "my preferences"). Consolidate them all
 * into user/profile.md so the fact actually anchors to chain instead of
 * being lost on reprovision.
 */
const PROFILE_NAME_PATTERN =
  /^(my[\s_-]?)?(profile|preferences?|about[\s_-]?me|operator[\s_-]?profile|user[\s_-]?profile|operator[\s_-]?preferences?|user[\s_-]?preferences?)$/i

export function toSlug(name: string, type: MemoryType): string {
  if (type === 'user' && PROFILE_NAME_PATTERN.test(name.trim())) {
    return PROFILE_SLUG
  }

  let prefix = ''
  if (type.startsWith('user-')) prefix = type.replace(/^user-/, '')
  else if (type.startsWith('agent-')) prefix = type.replace(/^agent-/, '')

  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  return prefix ? `${prefix}-${base}` : base
}

function mergeBody(prev: string, add: string, slug: string): string {
  return slug === PROFILE_SLUG ? mergeProfileBody(prev, add) : appendBody(prev, add)
}

/**
 * Profile.md grows over time as the brain learns operator facts. Plain append
 * accumulates duplicates ("Operator likes coffee black" written 5 times across
 * sessions). Dedup at line granularity: skip any non-blank line that already
 * appears verbatim in the previous body. Append only fresh lines.
 *
 * Section-level merge (replace `## Heading` blocks) is intentionally NOT done
 * here — the brain doesn't reliably structure profile writes with stable
 * headings, so a line-dedup is the cheapest correct semantics.
 */
export function mergeProfileBody(prev: string, add: string): string {
  const prevLines = new Set(
    prev
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0),
  )
  const freshLines = add
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !prevLines.has(l))
  if (freshLines.length === 0) return prev
  return `${prev.trimEnd()}\n\n${freshLines.join('\n')}`
}

function appendBody(prev: string, add: string): string {
  const trimmed = prev.trimEnd()
  return `${trimmed}\n\n${add}`
}
