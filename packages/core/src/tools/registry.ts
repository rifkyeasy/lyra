import type { ToolCall, ToolDef, ToolResult, ToolSchema } from './types'
import { zodToJsonSchema } from './zod-schema'

interface EnablementRule {
  pattern: string
  regex: RegExp | null
  enabled: boolean
}

/**
 * Symbol-based tool registry. Tools self-register at import time (plugins
 * contribute by importing their entry module, which triggers the registry
 * call). Glob-style enable/disable via `config.tools` is applied at `list()`.
 *
 * Deferred-tool model (Claude Code-compatible): tools default to alwaysLoad
 * (eager). A tool with `shouldDefer: true` (and not `alwaysLoad: true`) is
 * hidden from `schemas()` until `unlock(name)` is called. The brain hydrates
 * deferred schemas via the `tool.search` meta-tool.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>()
  private readonly rules: EnablementRule[]
  private readonly unlocked = new Set<string>()

  constructor(enabled: Record<string, boolean> = {}) {
    this.rules = Object.entries(enabled).map(([pattern, on]) => ({
      pattern,
      regex: pattern.includes('*') ? new RegExp(`^${pattern.replace(/\*/g, '.*')}$`) : null,
      enabled: on,
    }))
  }

  register(def: ToolDef): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`)
    }
    this.tools.set(def.name, def as ToolDef<unknown>)
  }

  find(name: string): ToolDef | undefined {
    const tool = this.tools.get(name)
    if (!tool) return undefined
    if (!this.isEnabled(name)) return undefined
    return tool
  }

  /** All registered + enabled tools, regardless of defer state. */
  list(): ToolDef[] {
    return [...this.tools.values()].filter(t => this.isEnabled(t.name))
  }

  /** Tools whose schemas the brain should see this turn. */
  loadedList(): ToolDef[] {
    return this.list().filter(t => this.isLoaded(t))
  }

  /** OpenAI-format schemas for the eager (loaded) set; sent to Sui Compute. */
  schemas(): ToolSchema[] {
    return this.loadedList().map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parametersOverride ?? zodToJsonSchema(t.schema),
      },
    }))
  }

  /**
   * Mark a deferred tool as loaded so its schema appears in the next
   * `schemas()` call. Idempotent.
   */
  unlock(name: string): boolean {
    const tool = this.tools.get(name)
    if (!tool) return false
    this.unlocked.add(name)
    return true
  }

  /** Whether the brain currently sees the tool's schema. */
  isLoaded(tool: ToolDef): boolean {
    if (tool.shouldDefer && tool.alwaysLoad !== true) {
      return this.unlocked.has(tool.name)
    }
    return true
  }

  /**
   * Search the registry for tools matching either an exact-name select query
   * (`select:fs.read,fs.write`) or a free-text keyword query that matches
   * names, descriptions, and searchHints.
   */
  search(query: string, maxResults = 5): ToolDef[] {
    const trimmed = query.trim()
    if (trimmed.startsWith('select:')) {
      return this.selectByNames(trimmed, maxResults)
    }
    const { required, keywords } = parseSearchTerms(trimmed)
    const scored: { tool: ToolDef; score: number }[] = []
    for (const tool of this.list()) {
      const score = this.scoreToolMatch(tool, required, keywords)
      if (score > 0) scored.push({ tool, score })
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(c => c.tool)
  }

  /** Exact-name `select:a,b,c` lookup restricted to enabled tools. */
  private selectByNames(trimmed: string, maxResults: number): ToolDef[] {
    const names = trimmed
      .slice('select:'.length)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    return names
      .map(n => this.tools.get(n))
      .filter((t): t is ToolDef => !!t && this.isEnabled(t.name))
      .slice(0, maxResults)
  }

  /**
   * Score a tool against a keyword query. Returns 0 when a `+required` term is
   * missing (so the caller skips it) or when nothing matched.
   */
  private scoreToolMatch(tool: ToolDef, required: string[], keywords: string[]): number {
    const haystack = [tool.name, tool.description, tool.searchHint ?? ''].join(' ').toLowerCase()
    if (!required.every(r => haystack.includes(r))) return 0
    let score = required.length > 0 ? 1 : 0
    for (const kw of keywords) {
      if (haystack.includes(kw)) score++
    }
    return score
  }

  async dispatch(call: ToolCall): Promise<ToolResult> {
    const tool = this.find(call.name)
    if (!tool) return { ok: false, error: `Unknown tool: ${call.name}` }
    const parsed = tool.schema.safeParse(call.args)
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` }
    }
    try {
      return await tool.handler(parsed.data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msg }
    }
  }

  private isEnabled(name: string): boolean {
    // Right-most matching rule wins. No explicit rule = enabled by default.
    let decision: boolean | null = null
    for (const rule of this.rules) {
      const matches = rule.regex ? rule.regex.test(name) : rule.pattern === name
      if (matches) decision = rule.enabled
    }
    return decision ?? true
  }
}

/** Split a free-text query into `+required` terms and plain keywords. */
function parseSearchTerms(trimmed: string): { required: string[]; keywords: string[] } {
  const required: string[] = []
  const keywords: string[] = []
  for (const part of trimmed.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (part.startsWith('+')) required.push(part.slice(1))
    else keywords.push(part)
  }
  return { required, keywords }
}
