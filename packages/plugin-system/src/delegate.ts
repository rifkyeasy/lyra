import { type ClaudeAgent, type DelegateBrainFactory, type ToolDef, coerceInt } from 'lyra-core'
import { z } from 'zod'

/**
 * `delegate.task` spawns an isolated sub-brain with a constrained system
 * prompt + tool subset. Used by the parent brain to off-load focused work
 * (extraction, drafting, classification) without polluting its own context.
 * Claude Code agents (~/.claude/plugins/cache/<m>/<p>/<v>/agents/<name>.md)
 * are addressable via the `agent:` arg.
 */

interface DelegateDeps {
  /** Builds a fresh brain instance. Chat.tsx supplies this with broker creds. */
  makeBrain: DelegateBrainFactory
  /** Claude Code agents available by short name. */
  agents: ClaudeAgent[]
}

const DelegateSchema = z.object({
  agent: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Name of a Claude Code agent (e.g. 'thymos', 'contract-explainer') OR omit and provide system_prompt directly.",
    ),
  system_prompt: z
    .string()
    .min(1)
    .optional()
    .describe('Custom system prompt for the sub-brain. Used when no agent is specified.'),
  task: z.string().min(1).describe('The task description / user-message the sub-brain receives.'),
  max_output_tokens: coerceInt
    .refine(n => n > 0 && n <= 8_000, 'max_output_tokens must be 1..8000')
    .optional(),
})

export function makeDelegateTask(deps: DelegateDeps): ToolDef<z.infer<typeof DelegateSchema>> {
  return {
    name: 'delegate.task',
    description:
      'Run a task on a sub-brain (same provider, isolated context). Useful for extraction, summarisation, classification. Pass `agent: <name>` for a Claude Code agent OR `system_prompt` for ad-hoc instructions. Returns content + token usage.',
    searchHint: 'delegate task subagent isolated sub brain',
    schema: DelegateSchema,
    handler: async args => {
      let systemPrompt: string
      if (args.agent) {
        const agent = deps.agents.find(a => a.name === args.agent || a.id === args.agent)
        if (!agent) {
          return { ok: false, error: `unknown agent: ${args.agent}` }
        }
        systemPrompt =
          agent.body.trim().length > 0 ? agent.body : `You are ${agent.name}. ${agent.description}`
      } else if (args.system_prompt) {
        systemPrompt = args.system_prompt
      } else {
        return { ok: false, error: 'either agent or system_prompt is required' }
      }
      try {
        const subBrain = await deps.makeBrain({ systemPrompt, tools: [] })
        const turn = await subBrain.infer({
          event: {
            id: `delegate-${Date.now()}`,
            source: 'stdin',
            payload: { label: 'delegate', data: args.task },
            ts: Date.now(),
          },
        })
        return {
          ok: true,
          data: {
            content: turn.content,
            finishReason: turn.finishReason,
            usage: turn.usage,
            agent: args.agent ?? null,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  }
}
