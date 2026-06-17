import { describe, expect, it } from 'bun:test'
// Import from the .ts file (pure logic) so the test doesn't trigger the
// JSX transform on markdown.tsx. CI's bun runtime resolves react-jsx by
// default unless a per-file pragma or workspace tsconfig override applies,
// and pulling solid-js JSX into the test file isn't worth the coupling.
import { parseMarkdown } from './markdown-parse'

describe('parseMarkdown', () => {
  it('renders plain text as a single segment', () => {
    const segs = parseMarkdown('hello world')
    expect(segs).toHaveLength(1)
    expect(segs[0]?.text).toBe('hello world')
    expect(segs[0]?.bold).toBeUndefined()
  })

  it('parses **bold** as bold segment between plain', () => {
    const segs = parseMarkdown('the **fast** fox')
    const labels = segs.map(s => `${s.text}${s.bold ? '*' : ''}`)
    expect(labels).toContain('fast*')
    expect(segs.find(s => s.text === 'fast')?.bold).toBe(true)
  })

  it('parses *italic* as italic segment', () => {
    const segs = parseMarkdown('the *quick* fox')
    expect(segs.find(s => s.text === 'quick')?.italic).toBe(true)
  })

  it('parses `code` as code-colored segment', () => {
    const segs = parseMarkdown('use `browser.snapshot` next')
    const code = segs.find(s => s.text === 'browser.snapshot')
    expect(code?.fg).toBeDefined()
    expect(code?.fg).not.toBe('#e5e7eb')
  })

  it('renders heading with bold + heading color, drops the # prefix', () => {
    const segs = parseMarkdown('# Title\nbody')
    const titleSeg = segs.find(s => s.text === 'Title')
    expect(titleSeg?.bold).toBe(true)
    expect(titleSeg?.fg).not.toBe('#e5e7eb')
    // The leading '#' should not appear as text
    expect(segs.some(s => s.text.startsWith('#'))).toBe(false)
  })

  it('renders bullet lists with bullet glyph + content', () => {
    const segs = parseMarkdown('- one\n- two')
    const bullets = segs.filter(s => s.text.includes('•'))
    expect(bullets.length).toBe(2)
    // Bullet should be a SEPARATE segment from content (different style)
    expect(segs.find(s => s.text === 'one')).toBeDefined()
    expect(segs.find(s => s.text === 'two')).toBeDefined()
  })

  it('renders fenced code block with code-block color, skips fence lines', () => {
    const segs = parseMarkdown('```ts\nconst x = 1;\nconst y = 2;\n```')
    const codeLines = segs.filter(s => s.text.includes('const'))
    expect(codeLines.length).toBe(2)
    expect(codeLines[0]?.fg).toBeDefined()
    // Fence syntax (```ts and ```) should NOT appear in output
    expect(segs.some(s => s.text.startsWith('```'))).toBe(false)
  })

  it('parses inline code inside bold without breaking either', () => {
    const segs = parseMarkdown('use **`foo`** now')
    // The combined ** + `` is unusual; we accept either bold-with-code or plain-with-code, but no crash
    expect(segs.length).toBeGreaterThan(0)
  })

  it('preserves newlines between blocks', () => {
    const segs = parseMarkdown('one\ntwo\nthree')
    const newlines = segs.filter(s => s.text === '\n')
    expect(newlines.length).toBe(2)
  })

  it('handles the screenshot regression case (mixed bold + inline code + bullets)', () => {
    const text = `**What I did successfully:**
- \`browser.navigate\` → done
- \`browser.type\` worked

**What failed:**
- \`browser.snapshot\` returned home`
    const segs = parseMarkdown(text)
    // Bold "What I did successfully:" present
    expect(segs.find(s => s.text === 'What I did successfully:' && s.bold)).toBeDefined()
    // Inline code segments
    expect(segs.find(s => s.text === 'browser.navigate')).toBeDefined()
    expect(segs.find(s => s.text === 'browser.snapshot')).toBeDefined()
    // No literal ** or ` in output
    expect(segs.some(s => s.text.includes('**'))).toBe(false)
    expect(segs.some(s => s.text.includes('`'))).toBe(false)
  })

  // v0.22.0: brain emits GFM tables. Previously the renderer treated every
  // `|...|` line as plain text, leaving the operator with literal pipes + a
  // useless separator row. The new path detects header + `|---|---|` + data
  // rows and emits aligned cells with a box-drawing divider.
  describe('GFM tables', () => {
    it('renders a 2-column table with header + data rows', () => {
      const md = '| Mode | Behavior |\n|------|----------|\n| yolo | auto |\n| prompt | modal |'
      const segs = parseMarkdown(md)
      // Header row text should contain both column headers + box-drawing pipes
      const headerSeg = segs.find(s => s.text.includes('Mode') && s.text.includes('Behavior'))
      expect(headerSeg).toBeDefined()
      expect(headerSeg?.bold).toBe(true)
      expect(headerSeg?.text).toContain('│')
      // Separator row should be present once
      expect(segs.some(s => s.text.includes('─') && s.text.includes('┼'))).toBe(true)
      // Data rows
      expect(segs.some(s => s.text.includes('yolo') && s.text.includes('auto'))).toBe(true)
      expect(segs.some(s => s.text.includes('prompt') && s.text.includes('modal'))).toBe(true)
      // Cells are padded to a common width — column 0 should be 6 chars wide
      // ("prompt") so "yolo" appears as "yolo  " (4 + 2 spaces of padding).
      const yoloRow = segs.find(s => s.text.includes('yolo'))
      expect(yoloRow?.text).toMatch(/yolo\s{2,}/)
    })

    it('pads short cells so columns align', () => {
      const md = '| col |\n|-----|\n| a |\n| longer cell |'
      const segs = parseMarkdown(md)
      const longRow = segs.find(s => s.text.includes('longer cell'))
      const shortRow = segs.find(s => s.text.match(/│\s+a\s+│/))
      expect(longRow).toBeDefined()
      expect(shortRow).toBeDefined()
      // Both rows should have identical visual width (same number of chars)
      expect(shortRow?.text.length).toBe(longRow?.text.length)
    })

    it('falls through to plain text when no separator row follows the header', () => {
      const md = '| col1 | col2 |\nplain text below'
      const segs = parseMarkdown(md)
      // No table-style border characters
      expect(segs.some(s => s.text.includes('│'))).toBe(false)
      expect(segs.some(s => s.text.includes('┼'))).toBe(false)
    })

    it('does not emit em-dashes in the separator row (project rule)', () => {
      const md = '| col |\n|-----|\n| a |'
      const segs = parseMarkdown(md)
      // U+2014 (em-dash) must NOT appear anywhere in the rendered output.
      // U+2013 (en-dash) also forbidden. Only ASCII hyphens or box-drawing
      // U+2500 are allowed.
      const joined = segs.map(s => s.text).join('')
      expect(joined.includes('—')).toBe(false)
      expect(joined.includes('–')).toBe(false)
    })
  })
})
