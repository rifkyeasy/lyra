import type { BrainConfig } from './brain'
import type { ToolSpec } from './tools'

/**
 * The agentic loop — Nebula's "brain", on Sui. The LLM is given a tool set and
 * runs a read→act loop: it calls tools (inspect balances/market/policy, then
 * propose writes), observes results, and iterates until it produces a final
 * answer. Every write tool enforces the policy + on-chain guard internally, so
 * the loop can be autonomous without ever exceeding the user's bounds.
 */

export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool-call'; name: string; args: string }
  | { type: 'tool-result'; name: string; text: string; failed?: boolean }

export interface RunAgentOpts {
  system: string
  tools: ToolSpec[]
  onEvent?: (e: AgentEvent) => void
  maxSteps?: number
}

export async function runAgent(goal: string, cfg: BrainConfig, opts: RunAgentOpts): Promise<string> {
  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY is not set — the brain needs an LLM key')
  // biome-ignore lint/suspicious/noExplicitAny: OpenAI message shapes are dynamic.
  const messages: any[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: goal },
  ]
  const tools = opts.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  const maxSteps = opts.maxSteps ?? 8

  for (let step = 0; step < maxSteps; step++) {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, temperature: 0, messages, tools, tool_choice: 'auto' }),
    })
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic completion payload.
    const j = (await res.json()) as any
    const msg = j.choices?.[0]?.message
    if (!msg) throw new Error('LLM returned no message')

    const toolCalls = msg.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined
    if (toolCalls && toolCalls.length > 0) {
      messages.push(msg)
      for (const tc of toolCalls) {
        const name = tc.function?.name
        const argStr = tc.function?.arguments ?? '{}'
        opts.onEvent?.({ type: 'tool-call', name, args: argStr })
        const tool = opts.tools.find((t) => t.name === name)
        let result: string
        let failed = false
        try {
          if (!tool) {
            result = `unknown tool: ${name}`
            failed = true
          } else {
            result = await tool.handler(JSON.parse(argStr || '{}'))
          }
        } catch (e) {
          result = `error: ${(e as Error).message}`
          failed = true
        }
        opts.onEvent?.({ type: 'tool-result', name, text: result, failed })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
      continue
    }

    const final = (msg.content as string) ?? ''
    opts.onEvent?.({ type: 'assistant', text: final })
    return final
  }
  return '(reached max reasoning steps)'
}
