/**
 * A tool the agent brain can call (OpenAI function-calling shape). Read tools
 * are unrestricted; write tools enforce the policy inside their handler before
 * touching the chain. The handler returns a human/LLM-readable result string.
 */
export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>
  // biome-ignore lint/suspicious/noExplicitAny: args are dynamic per schema.
  handler: (args: any) => Promise<string>
}

/** Convenience for a no-argument tool schema. */
export const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const
