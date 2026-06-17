/**
 * `lyra gateway start` — fork the gateway daemon detached.
 *
 * On Sui the agent key comes from the `LYRA_AGENT_KEY` env var, so there is no
 * operator wallet, Touch ID, or operator-session to derive. The daemon reads
 * the same env the CLI runs in.
 *
 * Flow:
 *   1. Load config from ~/.lyra/config.ts
 *   2. Resolve agentId (override via --agent or derived from LYRA_AGENT_KEY)
 *   3. Check if gateway already running (socket present). If yes, error.
 *   4. Spawn the gateway daemon detached + wait for socket to bind.
 *   5. Print pid + socket path.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spinner } from '@clack/prompts'
import { agentPaths, placeholderAgentId } from 'lyra-core'
import { findAndLoadConfig } from '../config/load'
import { spawnGatewayDaemon } from '../util/gateway-spawn'
import { loadAgentFromEnv } from '../util/sui-runtime'

export interface GatewayStartOpts {
  agentId?: string
}

export async function runGatewayStart(opts: GatewayStartOpts): Promise<void> {
  const found = await findAndLoadConfig()
  if (!found?.config) {
    console.error('lyra gateway start: no lyra.config.ts found in cwd or ~/.lyra/')
    process.exit(1)
  }
  const config = found.config

  const agent = loadAgentFromEnv()
  const agentAddress = agent?.address ?? config.identity.agent
  if (!agentAddress) {
    console.error(
      'lyra gateway start: no LYRA_AGENT_KEY set and no agent in config. Run `lyra init`.',
    )
    process.exit(1)
  }
  const agentId = opts.agentId ?? placeholderAgentId(agentAddress)
  const paths = agentPaths.agent(agentId)
  const socketPath = join(paths.dir, 'gateway.sock')

  // If the socket exists, check for version drift; auto-restart on mismatch so
  // operators don't have to `lyra gateway restart` after upgrading the binary.
  if (existsSync(socketPath)) {
    const { createHash } = await import('node:crypto')
    const { homedir } = await import('node:os')
    const identityHash = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
    const lockFile = join(homedir(), '.lyra', 'locks', `lyra-gateway-${identityHash}.lock`)
    const { ensureGatewayVersionMatchesCli } = await import('../util/gateway-version')
    const drift = await ensureGatewayVersionMatchesCli({ socketPath, lockFile })
    if (drift.action === 'ok' || drift.action === 'no-cli-version') {
      console.error(
        `lyra gateway start: socket already exists at ${socketPath} — gateway may be running (version ${drift.daemonVersion ?? 'unknown'}). Try \`lyra gateway stop\` first.`,
      )
      process.exit(1)
    }
    console.log(`note: ${drift.note}`)
  }

  // Spawn gateway daemon detached. The daemon reads LYRA_AGENT_KEY + LYRA_*
  // from the inherited environment; no key derivation happens here.
  const sBoot = spinner()
  sBoot.start(`Spawning gateway daemon (agent=${agentId.slice(0, 8)}…)`)

  const result = await spawnGatewayDaemon({
    agentId,
    configPath: found.path ?? '',
    socketPath,
    timeoutMs: 10_000,
  })
  if (result.ready) {
    sBoot.stop(`gateway running pid=${result.pid} socket=${socketPath}`)
    console.log('stop with: lyra gateway stop')
    console.log('logs:      lyra gateway logs -f')
  } else {
    const reason = result.reason ?? 'unknown'
    const detail = result.error ? `: ${result.error}` : ''
    sBoot.stop(
      `gateway did not bind socket within 10s (reason=${reason} pid=${result.pid ?? '?'})${detail}; check above output`,
    )
    process.exit(1)
  }
}
