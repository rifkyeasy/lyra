import { describe, expect, it } from 'bun:test'
import {
  escapeMarkdownV2,
  formatMarkdownV2,
  isMarkdownParseError,
  stripMarkdownV2,
  wrapGfmTablesInCodeBlocks,
} from './markdown'

describe('wrapGfmTablesInCodeBlocks (v0.22.1)', () => {
  it('wraps a basic 3x3 GFM table in fences', () => {
    const input = `Here you go:

| Mode   | Behavior | Modal |
|--------|----------|-------|
| yolo   | auto     | no    |
| prompt | approve  | yes   |
| strict | deny     | no    |

That's the table.`
    const out = wrapGfmTablesInCodeBlocks(input)
    expect(out).toContain('```\n| Mode')
    expect(out).toContain('| strict | deny     | no    |\n```')
    expect(out).toContain("That's the table.")
  })

  it('passes through text with no tables unchanged', () => {
    expect(wrapGfmTablesInCodeBlocks('just prose')).toBe('just prose')
    expect(wrapGfmTablesInCodeBlocks('| not | a table without separator')).toBe(
      '| not | a table without separator',
    )
  })

  it('handles alignment colons in separator row', () => {
    const input = `| a | b |
|:--|--:|
| 1 | 2 |`
    const out = wrapGfmTablesInCodeBlocks(input)
    expect(out.startsWith('```')).toBe(true)
    expect(out.endsWith('```')).toBe(true)
  })

  it('keeps non-table pipes intact', () => {
    expect(wrapGfmTablesInCodeBlocks('use | as separator')).toBe('use | as separator')
  })
})

describe('escapeMarkdownV2', () => {
  it('escapes all reserved characters', () => {
    expect(escapeMarkdownV2('a_b*c')).toBe('a\\_b\\*c')
    expect(escapeMarkdownV2('hello [world]')).toBe('hello \\[world\\]')
    expect(escapeMarkdownV2('1.2.3')).toBe('1\\.2\\.3')
    expect(escapeMarkdownV2('a-b+c')).toBe('a\\-b\\+c')
    expect(escapeMarkdownV2('!hi')).toBe('\\!hi')
  })

  it('passes plain text untouched', () => {
    expect(escapeMarkdownV2('hello world')).toBe('hello world')
    expect(escapeMarkdownV2('abc 123')).toBe('abc 123')
  })

  it('escapes backslashes themselves', () => {
    expect(escapeMarkdownV2('path\\to')).toBe('path\\\\to')
  })
})

describe('stripMarkdownV2', () => {
  it('removes escape backslashes', () => {
    expect(stripMarkdownV2('a\\.b\\.c')).toBe('a.b.c')
    expect(stripMarkdownV2('hello\\!')).toBe('hello!')
  })

  it('strips bold markers', () => {
    expect(stripMarkdownV2('*hello*')).toBe('hello')
    expect(stripMarkdownV2('this is *bold*.')).toBe('this is bold.')
  })

  it('strips spoiler markers', () => {
    expect(stripMarkdownV2('this is ||hidden||.')).toBe('this is hidden.')
  })

  it('strips strikethrough markers', () => {
    expect(stripMarkdownV2('~deleted~ now')).toBe('deleted now')
  })

  it('preserves plain text', () => {
    expect(stripMarkdownV2('hello world')).toBe('hello world')
  })

  it('strips a chain of formatting on one line', () => {
    expect(stripMarkdownV2('*bold* and ~strike~ together')).toBe('bold and strike together')
  })
})

describe('formatMarkdownV2', () => {
  it('passes through plain text but escapes reserved chars', () => {
    expect(formatMarkdownV2('your balance is 0.0819 Sui.')).toBe(
      'your balance is 0\\.0819 Sui\\.',
    )
  })

  it('translates **bold** into MarkdownV2 *bold*', () => {
    expect(formatMarkdownV2('**balance**: 0.08 Sui')).toBe('*balance*: 0\\.08 Sui')
  })

  it('translates *italic* into MarkdownV2 _italic_', () => {
    expect(formatMarkdownV2('see *details* below.')).toBe('see _details_ below\\.')
  })

  it('keeps ** bold-with-inner-text translated', () => {
    expect(formatMarkdownV2('**Your balance**: 0.0819 Sui')).toBe(
      '*Your balance*: 0\\.0819 Sui',
    )
  })

  it('translates headers into bold', () => {
    expect(formatMarkdownV2('# Title\nbody.')).toBe('*Title*\nbody\\.')
    expect(formatMarkdownV2('## Sub Title\nmore.')).toBe('*Sub Title*\nmore\\.')
  })

  it('strips redundant bold markers inside headers', () => {
    expect(formatMarkdownV2('# **Hello**')).toBe('*Hello*')
  })

  it('preserves inline code, escaping only backslashes inside', () => {
    expect(formatMarkdownV2('use `0.5 Sui` as the threshold')).toBe(
      'use `0.5 Sui` as the threshold',
    )
  })

  it('preserves fenced code blocks, escaping backticks and backslashes inside', () => {
    expect(formatMarkdownV2('```\nfoo()\nbar\n```')).toBe('```\nfoo()\nbar\n```')
  })

  it('preserves fenced code blocks with language hint', () => {
    expect(formatMarkdownV2('```js\nconst x = 1;\n```')).toBe('```js\nconst x = 1;\n```')
  })

  it('escapes backslashes inside fenced code', () => {
    expect(formatMarkdownV2('```\npath\\to\nfile\n```')).toBe('```\npath\\\\to\nfile\n```')
  })

  it('translates links with escaped display + URL', () => {
    expect(formatMarkdownV2('[example](https://example.com/path)')).toBe(
      '[example](https://example.com/path)',
    )
  })

  it('escapes display text but not URL parens-friendly chars', () => {
    expect(formatMarkdownV2('see [the docs](https://example.com)')).toBe(
      'see [the docs](https://example.com)',
    )
  })

  it('translates ~~strike~~ into MarkdownV2 ~strike~', () => {
    expect(formatMarkdownV2('~~done~~')).toBe('~done~')
  })

  it('preserves ||spoiler||', () => {
    expect(formatMarkdownV2('||hidden||')).toBe('||hidden||')
  })

  it('preserves blockquote markers', () => {
    expect(formatMarkdownV2('> a quote here.')).toBe('> a quote here\\.')
  })

  it('escapes stray parens and braces in plain text', () => {
    expect(formatMarkdownV2('foo (bar) baz')).toBe('foo \\(bar\\) baz')
    expect(formatMarkdownV2('use {x} for substitution')).toBe('use \\{x\\} for substitution')
  })

  it('does not escape parens that belong to a translated link', () => {
    expect(formatMarkdownV2('see [docs](https://example.com/foo)')).toBe(
      'see [docs](https://example.com/foo)',
    )
  })

  it('handles real brain reply with mixed formatting', () => {
    const input = 'Your balance: **0.0819 Sui**. Wallet `0xd56b...9683`.'
    const expected = 'Your balance: *0\\.0819 Sui*\\. Wallet `0xd56b...9683`\\.'
    expect(formatMarkdownV2(input)).toBe(expected)
  })

  it('handles empty input', () => {
    expect(formatMarkdownV2('')).toBe('')
  })

  it('escapes backslashes inside inline code', () => {
    expect(formatMarkdownV2('see `a\\b` for the regex')).toBe('see `a\\\\b` for the regex')
  })
})

describe('isMarkdownParseError', () => {
  it('matches the canonical TG parse error string', () => {
    expect(isMarkdownParseError(new Error("Bad Request: can't parse entities: ..."))).toBe(true)
  })

  it('matches hermes-cited variant', () => {
    expect(isMarkdownParseError(new Error('cannot parse entities at offset 5'))).toBe(true)
  })

  it('is false for unrelated errors', () => {
    expect(isMarkdownParseError(new Error('Forbidden'))).toBe(false)
    expect(isMarkdownParseError(new Error('ECONNRESET'))).toBe(false)
  })
})
