/**
 * Per-channel conversation persistence to local JSONL.
 *
 * Each channel's history is streamed to `<dir>/<sanitizedKey>.jsonl`, one
 * message per line. JSONL append is fsync'd to survive process kill. On
 * boot, `loadAll()` scans the dir and rehydrates the brain's history Map.
 *
 * NOT anchored to Sui Storage — these are chat transcripts, not memory facts.
 * Memory-worthy items still flow through `memory.save` and the typed
 * frontmatter file system.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrainMessage } from './types'

export interface HistoryPersist {
  /** Read every persisted channel into a Map. Best-effort: bad lines are dropped, missing dir returns empty. */
  loadAll(): Promise<Map<string, BrainMessage[]>>
  /** Append one user→assistant turn pair to the channel's JSONL. */
  appendTurn(channelKey: string, user: BrainMessage, assistant: BrainMessage): Promise<void>
  /** Wipe the channel's persisted history (called by `/reset` etc). */
  clearChannel(channelKey: string): Promise<void>
  /** Replace the channel's persisted history wholesale (used after compaction). */
  rewriteChannel(channelKey: string, history: readonly BrainMessage[]): Promise<void>
}

export interface FsHistoryPersistOpts {
  /** Directory holding `<channel>.jsonl` files. Created if absent. */
  dir: string
}

/** Convert a channel key to a filesystem-safe basename. Caps length to 200 chars. */
export function sanitizeChannelKey(key: string): string {
  const cleaned = key.replace(/[^a-zA-Z0-9_.-]/g, '_')
  return cleaned.slice(0, 200) || 'default'
}

const JSONL_RECORD_VERSION = 1

interface PersistedRecord {
  v: number
  channelKey: string
  message: BrainMessage
  ts: number
}

/** Read one `.jsonl` file (best-effort) and merge its records into `out`. */
function loadJsonlFile(path: string, out: Map<string, BrainMessage[]>): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  const lines = raw.split('\n').filter(l => l.length > 0)
  for (const line of lines) {
    mergeRecordLine(line, out)
  }
}

/** Parse a single JSONL line and append its message to `out`. Malformed lines are dropped. */
function mergeRecordLine(line: string, out: Map<string, BrainMessage[]>): void {
  try {
    const rec = JSON.parse(line) as PersistedRecord
    if (typeof rec.channelKey !== 'string' || !rec.message) return
    if (rec.v !== JSONL_RECORD_VERSION) return
    const list = out.get(rec.channelKey) ?? []
    list.push(rec.message)
    out.set(rec.channelKey, list)
  } catch {
    // skip malformed line
  }
}

export function createFsHistoryPersist(opts: FsHistoryPersistOpts): HistoryPersist {
  const { dir } = opts

  function ensureDir(): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  function pathFor(channelKey: string): string {
    return join(dir, `${sanitizeChannelKey(channelKey)}.jsonl`)
  }

  async function appendRecords(channelKey: string, messages: BrainMessage[]): Promise<void> {
    if (messages.length === 0) return
    ensureDir()
    const ts = Date.now()
    const lines: string[] = []
    for (const m of messages) {
      const record: PersistedRecord = {
        v: JSONL_RECORD_VERSION,
        channelKey,
        message: m,
        ts,
      }
      lines.push(`${JSON.stringify(record)}\n`)
    }
    const fh = await open(pathFor(channelKey), 'a')
    try {
      await fh.write(lines.join(''))
      await fh.sync()
    } finally {
      await fh.close()
    }
  }

  return {
    async loadAll() {
      const out = new Map<string, BrainMessage[]>()
      if (!existsSync(dir)) return out
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          loadJsonlFile(join(dir, e.name), out)
        }
      }
      return out
    },

    async appendTurn(channelKey: string, user: BrainMessage, assistant: BrainMessage) {
      // Single open/write/fsync/close — halves syscalls vs per-message append.
      await appendRecords(channelKey, [user, assistant])
    },

    async clearChannel(channelKey: string) {
      const path = pathFor(channelKey)
      if (existsSync(path)) {
        try {
          unlinkSync(path)
        } catch {
          // best-effort
        }
      }
    },

    async rewriteChannel(channelKey: string, history: readonly BrainMessage[]) {
      ensureDir()
      const path = pathFor(channelKey)
      // Atomic rewrite: write to temp, then rename.
      const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
      const fh = await open(tmp, 'w')
      try {
        for (const m of history) {
          const rec: PersistedRecord = {
            v: JSONL_RECORD_VERSION,
            channelKey,
            message: m,
            ts: Date.now(),
          }
          await fh.write(`${JSON.stringify(rec)}\n`)
        }
        await fh.sync()
      } finally {
        await fh.close()
      }
      const { rename } = await import('node:fs/promises')
      await rename(tmp, path)
    },
  }
}
