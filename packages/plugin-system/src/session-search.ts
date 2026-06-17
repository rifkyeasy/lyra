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
      const stream = createReadStream(deps.activityLogPath, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
      let total = 0
      try {
        for await (const line of rl) {
          if (!line.trim()) continue
          let parsed: { ts?: number; kind?: string }
          try {
            parsed = JSON.parse(line) as { ts?: number; kind?: string }
          } catch {
            continue
          }
          if (args.kind && args.kind !== 'all' && parsed.kind !== args.kind) continue
          if (!matcher(line)) continue
          total++
          if (matches.length < limit) {
            matches.push({
              ts: parsed.ts ?? 0,
              kind: parsed.kind ?? 'unknown',
              line: line.length > 4_000 ? `${line.slice(0, 4_000)}…` : line,
            })
          }
        }
      } finally {
        rl.close()
        stream.close()
      }
      return { ok: true, data: { matches, total } }
    },
  }
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
