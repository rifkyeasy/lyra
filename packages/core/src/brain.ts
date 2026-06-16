/**
 * The agent brain — the ADVISORY layer.
 *
 * It turns a natural-language goal into exactly ONE proposed action via an
 * OpenAI-compatible LLM (function calling). The brain has no authority: its
 * output is just a proposal that the deterministic policy engine and the Move
 * contract then check and (if allowed) execute. A hallucinated or jailbroken
 * proposal is harmless — it still has to pass the policy and the on-chain guard.
 */

export interface BrainConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export function brainFromEnv(env: Record<string, string | undefined> = process.env): BrainConfig {
  return {
    apiKey: env.OPENAI_API_KEY ?? '',
    baseUrl: env.LYRA_LLM_BASE_URL ?? 'https://api.openai.com/v1',
    model: env.LYRA_LLM_MODEL ?? 'gpt-4o-mini',
  }
}

export interface ProposedAction {
  kind: 'transfer' | 'store_memory' | 'noop'
  /** Protocol tag the policy will scope-check, e.g. "transfer" or "walrus". */
  protocol: string
  amountSui?: number
  recipient?: string
  memo?: string
  reasoning: string
}

export interface PlanContext {
  policySummary: string
  ownerAddress: string
}

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['transfer', 'store_memory', 'noop'] },
    protocol: {
      type: 'string',
      description: 'Protocol tag: "transfer" for a SUI transfer, "walrus" for store_memory, "none" for noop.',
    },
    amountSui: { type: 'number', description: 'Amount of SUI to send (transfer only).' },
    recipient: { type: 'string', description: '0x recipient address (transfer only).' },
    memo: { type: 'string', description: 'The note/report text to store durably (store_memory only).' },
    reasoning: { type: 'string', description: 'Short explanation of the decision.' },
  },
  required: ['kind', 'protocol', 'reasoning'],
  additionalProperties: false,
}

function systemPrompt(ctx: PlanContext): string {
  return `You are Lyra, a Sui-native autonomous finance agent. Translate the user's goal into exactly ONE proposed on-chain action. You are ADVISORY ONLY: a deterministic policy engine and an on-chain Move contract enforce all limits — you cannot move funds yourself.

Available actions (call the propose_action tool with one):
- transfer: send SUI to a recipient. Set kind="transfer", protocol="transfer", amountSui (number), recipient (0x address).
- store_memory: store a note or report durably on Walrus. Set kind="store_memory", protocol="walrus", memo (string).
- noop: when the goal is unclear, unsafe, or outside scope. Set kind="noop", protocol="none", and explain in reasoning.

Active policy (your hard limits):
${ctx.policySummary}

Owner/agent address: ${ctx.ownerAddress}

Rules:
- Propose exactly ONE action.
- If the goal would exceed a cap or use a protocol outside the allowlist, still propose the closest reasonable action OR noop, and explain — the policy engine makes the final decision, so be honest.
- "send to me" / "myself" → use the owner address.
- Keep reasoning to one or two sentences.`
}

export async function planAction(
  goal: string,
  ctx: PlanContext,
  cfg: BrainConfig,
): Promise<ProposedAction> {
  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY is not set — the brain needs an LLM key')
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt(ctx) },
        { role: 'user', content: goal },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'propose_action',
            description: 'Propose exactly one bounded action for the user goal.',
            parameters: ACTION_SCHEMA,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'propose_action' } },
    }),
  })
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`)
  const j = (await res.json()) as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[]
  }
  const argStr = j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments
  if (!argStr) throw new Error('LLM returned no proposed action')
  return JSON.parse(argStr) as ProposedAction
}
