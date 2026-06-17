import { describe, expect, it } from 'bun:test'
import { escapeChunkSuffixForMarkdownV2, splitMessage } from './chunking'

describe('splitMessage', () => {
  it('returns the input unchanged when shorter than maxLen', () => {
    const r = splitMessage('hello world', { maxLen: 100 })
    expect(r).toEqual(['hello world'])
  })

  it('splits into multiple chunks with (N/N) suffix', () => {
    const text = 'word '.repeat(2000)
    const r = splitMessage(text, { maxLen: 1000 })
    expect(r.length).toBeGreaterThan(1)
    for (let i = 0; i < r.length; i++) {
      expect(r[i]).toMatch(new RegExp(`\\(${i + 1}/${r.length}\\)$`))
    }
  })

  it('omits suffix when numbered=false', () => {
    const text = 'x'.repeat(5000)
    const r = splitMessage(text, { maxLen: 1000, numbered: false })
    expect(r.length).toBeGreaterThan(1)
    for (const c of r) expect(c).not.toMatch(/\(\d+\/\d+\)$/)
  })

  it('preserves total content across chunks (modulo whitespace at split points)', () => {
    const text = 'hello '.repeat(1000)
    const r = splitMessage(text, { maxLen: 500, numbered: false })
    const reassembled = r.join(' ').replace(/\s+/g, ' ').trim()
    expect(reassembled.split(' ').length).toBe(1000)
  })

  it('avoids splitting inside fenced code blocks', () => {
    const code = `\`\`\`\n${'line\n'.repeat(100)}\`\`\``
    const text = `intro\n${code}\noutro`
    const r = splitMessage(text, { maxLen: 200, numbered: false })
    const opens = r.filter(c => c.includes('```'))
    expect(opens.length % 2).toBe(0)
  })

  it('handles single huge token without spaces', () => {
    const text = 'x'.repeat(10000)
    const r = splitMessage(text, { maxLen: 1000 })
    expect(r.length).toBe(10)
  })

  it('returns one element when text length exactly equals maxLen', () => {
    const text = 'x'.repeat(100)
    const r = splitMessage(text, { maxLen: 100 })
    expect(r).toEqual([text])
  })
})

describe('escapeChunkSuffixForMarkdownV2', () => {
  it('escapes parens in the suffix', () => {
    expect(escapeChunkSuffixForMarkdownV2('hello (1/2)')).toBe('hello \\(1/2\\)')
    expect(escapeChunkSuffixForMarkdownV2('hello (10/10)')).toBe('hello \\(10/10\\)')
  })

  it('leaves text without suffix untouched', () => {
    expect(escapeChunkSuffixForMarkdownV2('hello world')).toBe('hello world')
  })
})
