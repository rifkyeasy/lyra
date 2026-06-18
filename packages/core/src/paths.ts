import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve `~/.lyra` at call time so tests can override via LYRA_ROOT or HOME. */
function lyraRoot(): string {
  return process.env.LYRA_ROOT ?? join(homedir(), '.lyra')
}

export interface AgentPaths {
  readonly root: string
  readonly config: string
  /** `~/.lyra/agent.key` — the agent's `suiprivkey1…` secret (file mode 0600). */
  readonly agentKey: string
  /** `~/.lyra/.env` — optional `KEY=value` lines loaded into env on startup. */
  readonly dotenv: string
  readonly skills: string
  readonly plugins: string
  readonly agentsDir: string
  agent(id: string): {
    dir: string
    keystore: string
    cache: string
    memoryDir: string
    memoryIndex: string
    agentMemoryDir: string
    userMemoryDir: string
    publicDir: string
    activityLog: string
    runtimeState: string
    inboxDir: string
    pairingDir: string
  }
}

export const agentPaths: AgentPaths = {
  get root() {
    return lyraRoot()
  },
  get config() {
    return join(lyraRoot(), 'config.ts')
  },
  get agentKey() {
    return join(lyraRoot(), 'agent.key')
  },
  get dotenv() {
    return join(lyraRoot(), '.env')
  },
  get skills() {
    return join(lyraRoot(), 'skills')
  },
  get plugins() {
    return join(lyraRoot(), 'plugins')
  },
  get agentsDir() {
    return join(lyraRoot(), 'agents')
  },
  agent(id: string) {
    const dir = join(lyraRoot(), 'agents', id)
    return {
      dir,
      keystore: join(dir, 'keystore.json'),
      cache: join(dir, 'cache'),
      memoryDir: join(dir, 'memory'),
      memoryIndex: join(dir, 'memory', 'MEMORY.md'),
      agentMemoryDir: join(dir, 'memory', 'agent'),
      userMemoryDir: join(dir, 'memory', 'user'),
      publicDir: join(dir, 'memory', 'public'),
      activityLog: join(dir, 'activity.jsonl'),
      runtimeState: join(dir, 'runtime', 'state.json'),
      inboxDir: join(dir, 'inbox'),
      pairingDir: join(dir, 'pairing'),
    }
  },
}

/** Compute the deterministic agent id from a wallet address. Stable pre-iNFT. */
export function placeholderAgentId(walletAddress: string): string {
  const clean = walletAddress.toLowerCase().replace(/^0x/, '')
  return clean.slice(0, 16)
}
