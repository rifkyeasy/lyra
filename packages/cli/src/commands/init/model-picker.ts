import type { NebulaNetwork } from 'nebula-ai-core'

export interface ModelPick {
  provider: string
  model: string | null
  inputPricePerTokenWei: bigint
  outputPricePerTokenWei: bigint
}

/**
 * Nebula uses a fixed OpenAI-compatible model configured via env
 * (`NEBULA_LLM_MODEL` / `NEBULA_LLM_BASE_URL` / `OPENAI_API_KEY`), so there's
 * no live provider catalog to pick from. Return the configured default so
 * `init` / `model` proceed without prompting.
 */
export async function pickBrainModel(_opts: {
  network: NebulaNetwork
}): Promise<ModelPick | null> {
  return {
    provider: 'openai-compatible',
    model: process.env.NEBULA_LLM_MODEL ?? 'gpt-4o-mini',
    inputPricePerTokenWei: 0n,
    outputPricePerTokenWei: 0n,
  }
}
