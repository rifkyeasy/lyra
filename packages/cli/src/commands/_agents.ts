import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { agentPaths } from 'nebula-ai-core'

export async function listAgentIds(): Promise<string[]> {
  if (!existsSync(agentPaths.agentsDir)) return []
  const entries = await readdir(agentPaths.agentsDir, { withFileTypes: true })
  return entries.filter(e => e.isDirectory()).map(e => e.name)
}

export async function pickDefaultAgent(): Promise<string | null> {
  const ids = await listAgentIds()
  return ids[0] ?? null
}
