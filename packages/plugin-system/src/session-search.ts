import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import readline from 'node:readline'
import { type ToolDef, coerceBool } from 'lyra-core'
import { z } from 'zod'

/**
 * `session.search` scans the agent's activity-log JSONL (the same file the
 * sync manager anchors to chain) for entries containing a substring match.
 * The activity log captures every wake event, tool call, tool result, and
 * brain response, so this is essentially "what did I do recently" search.
 */

interface SessionSearchDeps {
  /** Path to the activity log JSONL. Falls back to a noop when missing. */
  activityLogPath: string
}

const SearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Plain substring to match against any JSON line. Default mode is SUBSTRING — do NOT escape regex metacharacters (e.g. for tool name 'shell.run' pass 'shell.run' as-is, NOT 'shell\\\\.run'). Set `regex: true` only when you genuinely need a pattern.",
    ),
  kind: z
    .enum(['wake', 'tool-call', 'tool-result', 'brain-response', 'error', 'all'])
    .optional()
    .describe('Filter to a single activity kind. Default all.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('Cap matches returned. Default 25.'),
  regex: coerceBool
    .optional()
    .describe(
      "Opt-in regex mode. Default false (substring). Only set true when the query uses regex constructs ('.+', '|', anchors); plain dotted tool names match fine in substring mode.",
    ),
})

export function makeSessionSearch(deps: SessionSearchDeps): ToolDef<z.infer<typeof SearchSchema>> {
  return {
    name: 'session.search',
    description:
      "Search the agent's activity log for past wake events, tool calls/results, and brain responses. Useful for 'what did I do last hour?' or 'when did I call <tool>?'. Default is plain substring match — pass the tool name verbatim ('shell.run' not 'shell\\\\.run'). Returns timestamped JSON entries.",
    searchHint: 'session search activity log history past',
    schema: SearchSchema,
    handler: async args => {
      try {
        await stat(deps.activityLogPath)
      } catch {
        return { ok: true, data: { matches: [], total: 0, note: 'activity log not yet created' } }
      }
      const limit = args.limit ?? 25
      const matcher = compileMatcher(args.query, !!args.regex)
      const matches: { ts: number; kind: string; line: string }[] = []
      // Process one raw line: returns 1 when it counts as a match (and records
      // it if we're still under `limit`), 0 otherwise. Mirrors the original
      // inline loop body exactly.
      const consume = (line: string): number => {
        if (!line.trim()) return 0
        const hit = matchActivityLine(line, args.kind, matcher)
        if (!hit) return 0
        if (matches.length < limit) {
          matches.push({
            ts: hit.ts,
            kind: hit.kind,
            line: line.length > 4_000 ? `${line.slice(0, 4_000)}…` : line,
          })
        }
        return 1
      }
      const stream = createReadStream(deps.activityLogPath, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
      let total = 0
      try {
        for await (const line of rl) {
          total += consume(line)
        }
      } finally {
        rl.close()
        stream.close()
      }
      return { ok: true, data: { matches, total } }
    },
  }
}

/**
 * Parse one activity-log line and apply the kind filter + matcher. Returns the
 * entry's timestamp + kind when it should count as a match, or null when the
 * line is unparseable, filtered out by `kind`, or fails the matcher.
 */
function matchActivityLine(
  line: string,
  kind: string | undefined,
  matcher: (line: string) => boolean,
): { ts: number; kind: string } | null {
  let parsed: { ts?: number; kind?: string }
  try {
    parsed = JSON.parse(line) as { ts?: number; kind?: string }
  } catch {
    return null
  }
  if (kind && kind !== 'all' && parsed.kind !== kind) return null
  if (!matcher(line)) return null
  return { ts: parsed.ts ?? 0, kind: parsed.kind ?? 'unknown' }
}

function compileMatcher(query: string, isRegex: boolean): (line: string) => boolean {
  if (isRegex) {
    try {
      const re = new RegExp(query, 'i')
      return line => re.test(line)
    } catch {
      // Bad regex falls back to substring match.
    }
  }
  const lc = query.toLowerCase()
  return line => line.toLowerCase().includes(lc)
}
