import type { z } from 'zod'

/** OpenAI-compatible JSON Schema for a function parameter spec. */
export interface JSONSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  description?: string
}

/** Shape we hand to the brain when asking it to plan with tools. */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JSONSchema
  }
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export interface ToolDef<TArgs = unknown> {
  name: string
  description: string
  /** zod schema the runtime uses to both validate AND build JSONSchema for the brain. */
  schema: z.ZodType<TArgs>
  handler: (args: TArgs) => Promise<ToolResult> | ToolResult
  /**
   * When set with `shouldDefer`, overrides the deferral so the tool's schema
   * still ships every turn. Has no effect when `shouldDefer` is false/unset.
   */
  alwaysLoad?: boolean
  /**
   * Hide this tool's schema by default; the brain only sees it after
   * `tool.search` matches it (mirrors Claude Code's shouldDefer). Combine with
   * `alwaysLoad: true` to force eager loading even though the tool is meant
   * to be searchable.
   */
  shouldDefer?: boolean
  /**
   * 3-10 word hint used by `tool.search` keyword matching when this tool is
   * deferred. Should describe domain ("filesystem read text"), not phrasing.
   */
  searchHint?: string
  /**
   * Optional JSON Schema override for tools whose param shape isn't expressed
   * as a top-level `z.object({})` (MCP tools, dynamically-discovered remote
   * tools). When set, `registry.schemas()` and `tool.search` use this verbatim
   * instead of running `zodToJsonSchema(schema)`. The `schema.safeParse()`
   * still gates dispatch.
   */
  parametersOverride?: JSONSchema
  /**
   * The tool moves value / writes on-chain state when executed. When true, the
   * permission-mode gate (strict/prompt) and the deterministic approval floor
   * apply — so it can't execute autonomously without the operator's configured
   * approval. Read-only tools omit this (or set false).
   */
  movesValue?: boolean
}

export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: string
}
