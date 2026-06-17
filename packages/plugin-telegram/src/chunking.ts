// Long-message chunking with (1/N) (2/N) suffix.
//
// Pattern from hermes telegram.py:829-836. Telegram's hard limit is 4096
// characters per message. We split at 4000 (leave room for the suffix) and
// attach `(1/N)` `(2/N)` `(N/N)` to each chunk. We avoid breaking inside
// fenced code blocks so the runtime grammar stays intact across chunks.

const DEFAULT_MAX_LEN = 4000

export interface SplitOpts {
  maxLen?: number
  /** Add `(1/N)` suffixes to multi-chunk output. Default true. */
  numbered?: boolean
}

export function splitMessage(text: string, opts: SplitOpts = {}): string[] {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN
  const numbered = opts.numbered ?? true

  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(cursor + maxLen, text.length)

    // Avoid splitting inside a fenced code block — if there's an unclosed
    // ``` between cursor and end, back up to the last newline before end.
    if (end < text.length) {
      const segment = text.slice(cursor, end)
      const fencesInSegment = (segment.match(/```/g) || []).length
      if (fencesInSegment % 2 === 1) {
        const lastNewline = text.lastIndexOf('\n', end - 1)
        if (lastNewline > cursor) end = lastNewline
      } else {
        // Prefer to split on word boundary when possible
        const lastSpace = text.lastIndexOf(' ', end)
        const lastNewline = text.lastIndexOf('\n', end)
        const splitAt = Math.max(lastSpace, lastNewline)
        if (splitAt > cursor + Math.floor(maxLen / 2)) {
          end = splitAt
        }
      }
    }

    chunks.push(text.slice(cursor, end))
    cursor = end
    // Skip the leading whitespace at the new cursor (we split on it)
    while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\n')) cursor++
  }

  if (!numbered || chunks.length === 1) return chunks
  const total = chunks.length
  return chunks.map((c, i) => `${c} (${i + 1}/${total})`)
}

/**
 * If a chunk is going through MarkdownV2 mode, the parens in `(N/N)` need to
 * be escaped. Hermes telegram.py:836.
 */
export function escapeChunkSuffixForMarkdownV2(text: string): string {
  return text.replace(/\s\((\d+)\/(\d+)\)$/, ' \\($1/$2\\)')
}
