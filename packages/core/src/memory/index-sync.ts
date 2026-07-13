import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { addEntryLine, readIndexFile, writeIndexFile } from './index-file'

/**
 * v0.23.0: MEMORY.md historically only listed user-partition emergent topic
 * files; the agent-partition meta-files (identity, persona) were anchored to
 * the iNFT but invisible to brain enumeration via the index. Result: the
 * brain's `memory.read name=identity` would only succeed via the slug fallback
 * branch; `memory.list` would report agent[] files but the brain wouldn't
 * see them in narrative MEMORY.md prose.
 *
 * This module adds synthetic top-of-index entries for the canonical
 * agent-partition + the user/profile.md anchor whenever those files exist
 * on disk. Idempotent (matches by file path). Runs at boot-restore and at
 * every sync.doFlush() so the index stays current.
 */
export interface SyntheticIndexFile {
  /** Path relative to memoryDir, e.g. `agent/identity.md`. */
  file: string
  /** Title used when frontmatter `name` is absent. */
  fallbackTitle: string
}

export const STANDARD_SYNTHETIC_INDEX_FILES: readonly SyntheticIndexFile[] = [
  { file: 'agent/identity.md', fallbackTitle: 'identity' },
  { file: 'agent/persona.md', fallbackTitle: 'persona' },
  { file: 'user/profile.md', fallbackTitle: 'profile' },
]

export interface SyntheticIndexResult {
  added: string[]
  skipped: string[]
}

export async function ensureSyntheticIndexEntries(
  memoryDir: string,
  files: readonly SyntheticIndexFile[] = STANDARD_SYNTHETIC_INDEX_FILES,
): Promise<SyntheticIndexResult> {
  const indexPath = join(memoryDir, 'MEMORY.md')
  let index: Awaited<ReturnType<typeof readIndexFile>>
  try {
    index = await readIndexFile(indexPath)
  } catch {
    // Index file missing or unreadable — skip silently. seedStarterMemoryFiles
    // creates it at init; existing agents that pre-date that path may need a
    // one-time backfill via migration.
    return { added: [], skipped: files.map(f => f.file) }
  }

  const added: string[] = []
  const skipped: string[] = []

  for (const f of files) {
    if (index.entries.has(f.file)) {
      skipped.push(f.file)
      continue
    }
    const fsPath = join(memoryDir, f.file)
    if (!(await fileExists(fsPath))) {
      skipped.push(f.file)
      continue
    }
    const { title, description } = await readSyntheticMeta(fsPath, f.fallbackTitle)
    index = addEntryLine(index, {
      file: f.file,
      title,
      hook: description ?? title,
    })
    added.push(f.file)
  }

  if (added.length > 0) {
    await writeIndexFile(indexPath, index)
  }

  return { added, skipped }
}

/**
 * Read an entry's frontmatter `name`/`description` (best-effort). Falls back to
 * the supplied title and a null description when the file or frontmatter is bad.
 */
async function readSyntheticMeta(
  fsPath: string,
  fallbackTitle: string,
): Promise<{ title: string; description: string | null }> {
  let title = fallbackTitle
  let description: string | null = null
  try {
    const content = await readFile(fsPath, 'utf8')
    const head = content.length > 4096 ? content.slice(0, 4096) : content
    const parsed = matter(head)
    const fm = parsed.data as { name?: string; description?: string }
    if (fm.name && typeof fm.name === 'string') title = fm.name
    if (fm.description && typeof fm.description === 'string') description = fm.description
  } catch {
    // bad frontmatter — fall back to filename
  }
  return { title, description }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile() && s.size > 0
  } catch {
    return false
  }
}
