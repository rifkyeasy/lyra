import * as p from '@clack/prompts'
import { brainFromEnv } from 'lyra-core'
import pc from 'picocolors'
import { upsertEnv } from '../util/env'

const MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini']

/** Re-pick the LLM model (writes LYRA_LLM_MODEL to .env). */
export async function runModel(): Promise<void> {
  const current = brainFromEnv().model
  const m = await p.select({
    message: `LLM model (current: ${current})`,
    options: MODELS.map((v) => ({ value: v, label: v })),
    initialValue: MODELS.includes(current) ? current : MODELS[0],
  })
  if (p.isCancel(m)) {
    p.cancel('cancelled')
    return
  }
  await upsertEnv({ LYRA_LLM_MODEL: m as string })
  console.log(pc.green(`✓ model set to ${m as string} (.env)`))
}
