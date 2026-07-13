/**
 * Lightweight markdown parser for the assistant chat rows. Pure logic only,
 * no JSX, so tests can import without dragging in the JSX runtime (CI's bun
 * defaults to react-jsx and fails to resolve `react/jsx-dev-runtime` when
 * a .tsx file is imported by a test).
 *
 * Subset the brain actually emits: `**bold**`, `*italic*`, `` `code` ``,
 * `# headings`, `- bullet lists`, `1. numbered lists`, fenced code blocks,
 * GFM tables (`| col | col |` + `|---|---|` separator).
 */

export interface MdSegment {
  text: string
  fg?: string
  bold?: boolean
  italic?: boolean
}

export const MD_COLORS = {
  text: '#e5e7eb',
  code: '#fda4af',
  heading: '#fbbf24',
  bullet: '#94a3b8',
  codeBlock: '#f9a8d4',
  tableBorder: '#6b7280',
  tableHeader: '#fbbf24',
}

/** A matched inline token: the styled segment plus the index to resume at. */
type InlineMatch = { seg: MdSegment; next: number }

function matchCode(line: string, i: number): InlineMatch | null {
  if (line[i] !== '`') return null
  const end = line.indexOf('`', i + 1)
  if (end <= i) return null
  return { seg: { text: line.slice(i + 1, end), fg: MD_COLORS.code }, next: end + 1 }
}

function matchBold(line: string, i: number, baseFg: string): InlineMatch | null {
  if (!(line[i] === '*' && line[i + 1] === '*')) return null
  const end = line.indexOf('**', i + 2)
  if (end <= i + 2) return null
  return { seg: { text: line.slice(i + 2, end), fg: baseFg, bold: true }, next: end + 2 }
}

function matchItalic(line: string, i: number, baseFg: string): InlineMatch | null {
  if (!(line[i] === '*' && line[i + 1] !== '*' && line[i + 1] !== ' ')) return null
  const end = line.indexOf('*', i + 1)
  if (!(end > i + 1 && line[end - 1] !== ' ' && line[end + 1] !== '*')) return null
  return { seg: { text: line.slice(i + 1, end), fg: baseFg, italic: true }, next: end + 1 }
}

/**
 * Parse a single line's inline markup (`**bold**`, `*italic*`, `` `code` ``)
 * into a flat list of segments. Caller handles the line-level structure.
 */
function parseInline(line: string, baseFg: string = MD_COLORS.text): MdSegment[] {
  const out: MdSegment[] = []
  let i = 0
  let plain = ''
  const flushPlain = () => {
    if (plain) {
      out.push({ text: plain, fg: baseFg })
      plain = ''
    }
  }
  while (i < line.length) {
    const match = matchCode(line, i) ?? matchBold(line, i, baseFg) ?? matchItalic(line, i, baseFg)
    if (match) {
      flushPlain()
      out.push(match.seg)
      i = match.next
      continue
    }
    plain += line[i]
    i++
  }
  flushPlain()
  return out
}

// GFM table separator row: `|---|---|` (optionally with alignment colons).
// Allows single-column tables (`|---|`), multi-column (`|---|---|`), and
// missing leading/trailing pipes (`---|---`).
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(c => c.trim())
}

/**
 * Detect a GFM table starting at `lines[startIdx]`. Returns the parsed rows
 * (header included as row 0) plus the index AFTER the last data row, or null
 * if no table block matches.
 */
function detectTable(lines: string[], startIdx: number): { rows: string[][]; end: number } | null {
  const header = lines[startIdx]
  if (header === undefined) return null
  if (!/^\s*\|.+\|?\s*$/.test(header)) return null
  const sep = lines[startIdx + 1]
  if (!(sep && TABLE_SEPARATOR_RE.test(sep))) return null

  const rows: string[][] = [parseTableRow(header)]
  let i = startIdx + 2
  while (i < lines.length) {
    const ln = lines[i]
    if (ln === undefined || !/^\s*\|.+\|?\s*$/.test(ln)) break
    rows.push(parseTableRow(ln))
    i++
  }
  return { rows, end: i }
}

/**
 * Render a parsed table as flat segments. Uses box-drawing characters for the
 * separator under the header row; columns are padded to the widest cell. First
 * row is rendered bold + heading color so it stands out.
 */
function renderTable(rows: string[][], out: MdSegment[], pushNewline: () => void): void {
  if (rows.length === 0) return
  const colCount = Math.max(...rows.map(r => r.length))
  const widths = new Array(colCount).fill(0) as number[]
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      widths[c] = Math.max(widths[c]!, row[c]!.length)
    }
  }
  for (let r = 0; r < rows.length; r++) {
    pushNewline()
    const row = rows[r]!
    const cells: string[] = []
    for (let c = 0; c < colCount; c++) {
      const cell = (row[c] ?? '').padEnd(widths[c]!, ' ')
      cells.push(cell)
    }
    const lineText = `│ ${cells.join(' │ ')} │`
    out.push({
      text: lineText,
      fg: r === 0 ? MD_COLORS.tableHeader : MD_COLORS.text,
      bold: r === 0,
    })
    if (r === 0) {
      pushNewline()
      const sep = `├${widths.map(w => '─'.repeat(w + 2)).join('┼')}┤`
      out.push({ text: sep, fg: MD_COLORS.tableBorder })
    }
  }
}

function pushHeading(out: MdSegment[], text: string, pushNewline: () => void): void {
  pushNewline()
  const inner = parseInline(text, MD_COLORS.heading)
  for (const seg of inner) {
    out.push({ ...seg, fg: seg.fg ?? MD_COLORS.heading, bold: true })
  }
}

/**
 * Render one non-fenced block line (heading / table / bullet / numbered /
 * plain) into `out`, returning the index AFTER the consumed source line(s).
 * Tables span multiple source lines, so this returns the block's end index.
 */
function renderBlockLine(
  lines: string[],
  i: number,
  out: MdSegment[],
  pushNewline: () => void,
): number {
  const rawLine = lines[i]!
  const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/)
  if (headingMatch) {
    pushHeading(out, headingMatch[2]!, pushNewline)
    return i + 1
  }
  const table = detectTable(lines, i)
  if (table) {
    renderTable(table.rows, out, pushNewline)
    return table.end
  }
  const bulletMatch = rawLine.match(/^(\s*)([-*])\s+(.*)$/)
  if (bulletMatch) {
    pushNewline()
    out.push({ text: `${bulletMatch[1]}• `, fg: MD_COLORS.bullet })
    out.push(...parseInline(bulletMatch[3]!))
    return i + 1
  }
  const numberedMatch = rawLine.match(/^(\s*)(\d+)\.\s+(.*)$/)
  if (numberedMatch) {
    pushNewline()
    out.push({
      text: `${numberedMatch[1]}${numberedMatch[2]}. `,
      fg: MD_COLORS.bullet,
    })
    out.push(...parseInline(numberedMatch[3]!))
    return i + 1
  }
  pushNewline()
  out.push(...parseInline(rawLine))
  return i + 1
}

/**
 * Parse the full text into a flat list of segments separated by newlines.
 * Block-level structure is encoded as styled prefixes in the segments
 * (heading -> bold colored line; bullet -> "• " + content; table -> aligned
 * cells with box-drawing separator).
 */
export function parseMarkdown(text: string): MdSegment[] {
  if (!text) return []
  const out: MdSegment[] = []
  const lines = text.split('\n')
  let inFence = false
  let firstLine = true

  const pushNewline = () => {
    if (!firstLine) out.push({ text: '\n', fg: MD_COLORS.text })
    firstLine = false
  }

  let i = 0
  while (i < lines.length) {
    const rawLine = lines[i]!
    if (rawLine.trim().startsWith('```')) {
      inFence = !inFence
      i++
      continue
    }
    if (inFence) {
      pushNewline()
      out.push({ text: rawLine, fg: MD_COLORS.codeBlock })
      i++
      continue
    }
    i = renderBlockLine(lines, i, out, pushNewline)
  }
  return out
}
