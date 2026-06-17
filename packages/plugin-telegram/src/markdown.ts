// MarkdownV2 escape + plain-text fallback + standard-markdown translator.
//
// The brain emits standard CommonMark (`**bold**`, `*italic*`, `` `code` ``,
// `# heading`, `[text](url)`, lists, blockquotes). Telegram MarkdownV2 has
// different syntax AND requires every reserved character outside formatting
// markers to be backslash-escaped. Sending the brain's text directly with
// `parse_mode: 'MarkdownV2'` either parse-errors or renders escape characters
// literally.
//
// `formatMarkdownV2(text)` is the canonical translator: protect code blocks
// and links behind placeholders, convert markdown structures to MarkdownV2
// equivalents, escape remaining reserved chars, restore placeholders. Ported
// from hermes telegram.py:format_message.
//
// `escapeMarkdownV2(text)` and `stripMarkdownV2(text)` remain available for
// callers that need raw escaping or a plain-text fallback when send fails.

const MARKDOWN_V2_ESCAPE_REGEX = /([_*[\]()~`>#+\-=|{}.!\\])/g

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_ESCAPE_REGEX, '\\$1')
}

/**
 * Strip MarkdownV2 markers so a parse_error fallback can send the same content
 * as plain text. Handles the four common formatting markers (`*bold*`,
 * `_italic_`, `~strike~`, `||spoiler||`) plus drops escape backslashes.
 *
 * Code-block markers stay (TG renders them as plain text without parse_mode).
 */
export function stripMarkdownV2(text: string): string {
  let out = text
  out = out.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')
  out = out.replace(/\|\|([^|]+)\|\|/g, '$1')
  out = out.replace(/\*([^*]+)\*/g, '$1')
  out = out.replace(/(?:^|[\s])_([^_]+)_(?=[\s]|$)/g, ' $1')
  out = out.replace(/~([^~]+)~/g, '$1')
  return out
}

/**
 * Detect if a grammy / Bot API error is a MarkdownV2 parse error so callers
 * can fall back to plain-text. Hermes pattern: the error message contains
 * "can't parse entities" with the MarkdownV2 mention.
 */
export function isMarkdownParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  return (
    lower.includes("can't parse entities") ||
    lower.includes('cannot parse entities') ||
    (lower.includes('bad request') && (lower.includes('parse') || lower.includes('entities')))
  )
}

/**
 * Translate standard CommonMark (what the brain emits) into Telegram MarkdownV2.
 * Ports hermes `format_message` (telegram.py:1838-1993). Strategy: stash code
 * spans and links behind NUL-bracketed placeholders, rewrite formatting
 * markers, then escape every reserved char in the remaining plain text and
 * restore placeholders. The trailing safety pass catches stray `( ) { }` that
 * survived the dance, while leaving link parens intact.
 */
export function formatMarkdownV2(content: string): string {
  if (!content) return content

  // GFM tables don't render in MarkdownV2 — pipes show literally and columns
  // misalign. Wrap detected table blocks in ``` fences so TG renders them
  // monospace + preserves column alignment. Detection: a line starting with
  // `|` followed by a separator row (`|---|---|`) makes the start of a table;
  // contiguous `|...|` lines are pulled in until the first non-table line.
  const wrapped = wrapGfmTablesInCodeBlocks(content)

  const placeholders: string[] = []
  const ph = (value: string): string => {
    const key = `\x00PH${placeholders.length}\x00`
    placeholders.push(value)
    return key
  }

  let text = wrapped

  text = text.replace(/```(?:[^\n]*\n)?[\s\S]*?```/g, raw => {
    const newlineIdx = raw.indexOf('\n', 3)
    const headerEnd = newlineIdx === -1 ? 3 : newlineIdx + 1
    const header = raw.slice(0, headerEnd)
    const body = raw.slice(headerEnd, raw.length - 3)
    const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
    return ph(`${header}${escaped}\`\`\``)
  })

  text = text.replace(/`[^`\n]+`/g, raw => ph(raw.replace(/\\/g, '\\\\')))

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, display: string, url: string) => {
    const safeDisplay = escapeMarkdownV2(display)
    const safeUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)')
    return ph(`[${safeDisplay}](${safeUrl})`)
  })

  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, inner: string) => {
    const cleaned = inner.trim().replace(/\*\*(.+?)\*\*/g, '$1')
    return ph(`*${escapeMarkdownV2(cleaned)}*`)
  })

  text = text.replace(/\*\*(.+?)\*\*/g, (_match, inner: string) =>
    ph(`*${escapeMarkdownV2(inner)}*`),
  )

  text = text.replace(/\*([^*\n]+)\*/g, (_match, inner: string) =>
    ph(`_${escapeMarkdownV2(inner)}_`),
  )

  text = text.replace(/~~(.+?)~~/g, (_match, inner: string) => ph(`~${escapeMarkdownV2(inner)}~`))

  text = text.replace(/\|\|(.+?)\|\|/g, (_match, inner: string) =>
    ph(`||${escapeMarkdownV2(inner)}||`),
  )

  text = text.replace(/^(>{1,3}) (.+)$/gm, (_match, marker: string, body: string) =>
    ph(`${marker} ${escapeMarkdownV2(body)}`),
  )

  text = escapeMarkdownV2(text)

  for (let i = placeholders.length - 1; i >= 0; i--) {
    const value = placeholders[i] ?? ''
    text = text.replace(`\x00PH${i}\x00`, value)
  }

  text = escapeStrayParens(text)

  return text
}

/**
 * Last-ditch pass over `( ) { }` that survived the placeholder dance. Runs
 * outside code spans only — anything inside `` `…` `` or ``` ```…``` ``` is
 * preserved verbatim. Mirrors hermes safety net at telegram.py:1957-1991.
 */
function escapeStrayParens(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g)
  return segments
    .map((seg, idx) => {
      if (idx % 2 === 1) return seg
      return seg.replace(/[(){}]/g, (ch, offset: number) => {
        if (offset > 0 && seg[offset - 1] === '\\') return ch
        if (ch === '(' && offset > 0 && seg[offset - 1] === ']') return ch
        if (ch === ')' && isInsideLinkUrl(seg, offset)) return ch
        return `\\${ch}`
      })
    })
    .join('')
}

/**
 * Detect GFM table blocks in the brain's reply and wrap them in ``` fences.
 * TG MarkdownV2 doesn't render tables; without the fence, pipes show literally
 * and columns drift. With the fence, TG renders monospace + preserves the
 * brain's space padding so columns line up.
 *
 * Table boundary: a `|...|` row immediately followed by a separator row
 * `|---|---|` (or `:---:`, `---|---`, etc.) is the start. Contiguous `|...|`
 * data rows are pulled into the same block. First non-pipe line ends it.
 */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const TABLE_ROW_RE = /^\s*\|.+\|?\s*$/

export function wrapGfmTablesInCodeBlocks(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (
      TABLE_ROW_RE.test(line) &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR_RE.test(lines[i + 1] ?? '')
    ) {
      const block: string[] = [line, lines[i + 1] ?? '']
      let j = i + 2
      while (j < lines.length && TABLE_ROW_RE.test(lines[j] ?? '')) {
        block.push(lines[j] ?? '')
        j += 1
      }
      out.push('```')
      out.push(...block)
      out.push('```')
      i = j
      continue
    }
    out.push(line)
    i += 1
  }
  return out.join('\n')
}

function isInsideLinkUrl(seg: string, closeIdx: number): boolean {
  let depth = 0
  for (let j = closeIdx - 1; j >= Math.max(closeIdx - 2000, 0); j--) {
    const ch = seg[j]
    if (ch === ')') {
      depth += 1
      continue
    }
    if (ch !== '(') continue
    depth -= 1
    if (depth >= 0) continue
    return j > 0 && seg[j - 1] === ']'
  }
  return false
}
