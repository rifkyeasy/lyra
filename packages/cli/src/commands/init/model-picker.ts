import { DEFAULT_LLM_MODEL } from '../../config/defaults'

export interface ModelPick {
  provider: string
  model: string | null
}

/**
 * Lyra uses a fixed OpenAI-compatible model configured via env
 * (`LYRA_LLM_MODEL` / `LYRA_LLM_BASE_URL` / `OPENAI_API_KEY`), so there's
 * no live provider catalog to pick from. Return the configured default so
 * `init` / `model` proceed without prompting.
 */
export async function pickBrainModel(): Promise<ModelPick | null> {
  return {
    provider: 'openai-compatible',
    model: process.env.LYRA_LLM_MODEL ?? DEFAULT_LLM_MODEL,
  }
}
