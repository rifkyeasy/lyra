import { readFile } from 'node:fs/promises'
import { agentPaths } from 'nebula-ai-core'
import { pickDefaultAgent } from './_agents'

export async function runLogs(opts: { agent?: string; tail?: number } = {}): Promise<void> {
  // Local mode: read from agentPaths
  const id = opts.agent ?? (await pickDefaultAgent())
  if (!id) {
    console.log('No agents found in ~/.nebula/agents. Run `nebula init` first.')
    process.exit(1)
  }
  const path = agentPaths.agent(id).activityLog

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`No activity log at ${path}`)
      return
    }
    throw e
  }

  const lines = raw.trimEnd().split('\n').filter(Boolean)
  const slice = opts.tail ? lines.slice(-opts.tail) : lines
  for (const line of slice) {
    try {
      const entry = JSON.parse(line) as { ts: number; kind: string; data: unknown }
      const d = new Date(entry.ts).toISOString()
      const body = JSON.stringify(entry.data)
      console.log(`${d}  ${entry.kind.padEnd(16)} ${body.slice(0, 200)}`)
    } catch {
      console.log(line)
    }
  }
}
