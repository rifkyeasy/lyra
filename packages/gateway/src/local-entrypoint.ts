#!/usr/bin/env bun
/**
 * Local-mode gateway entrypoint. Used by `lyra gateway run` (foreground)
 * and `lyra gateway start` (forks this into background).
 *
 * Sui port: the agent identity is a single Ed25519 keypair derived from the
 * `LYRA_AGENT_KEY` secret (`suiprivkey1...`). There is no separate keystore /
 * operator-session Touch-ID decrypt dance — the operator supplies the secret
 * via the environment (the CLI reads it from its own keystore before exec).
 *
 * Differences from the sandbox entrypoint:
 *  - No ECIES bootstrap handshake. The agent secret is read straight from env.
 *  - Binds a unix socket at `~/.lyra/agents/<id>/gateway.sock` (perm 0600)
 *    instead of TCP. File-perm-based authentication replaces signature
 *    verification (server-side `trustLocal: true`).
 *  - No Daytona-specific env vars (SANDBOX_ID, LYRA_OPERATOR_ADDRESS).
 *  - No self-heartbeat (Daytona-only concern).
 *  - PID lock at `~/.lyra/agents/<id>/locks/gateway.lock` via `acquireScopedLock`.
 *
 * Required env (set by the parent `lyra gateway` CLI):
 *   LYRA_AGENT_KEY   — agent Sui secret (`suiprivkey1...` or base64 seed).
 *   LYRA_NETWORK     — 'testnet' | 'mainnet' (default 'mainnet').
 * Optional env:
 *   LYRA_AGENT_ID    — pins which agent dir to use (default derived from address).
 *   LYRA_CONFIG      — absolute path to a lyra.config.ts (overrides env defaults).
 *   LYRA_PACKAGE_ID  — deployed lyra::policy package id.
 *   LYRA_POLICY_OBJECT_ID — shared AgentPolicy object id.
 *   LYRA_OPERATOR_ADDRESS — operator-auth address (optional; local mode trusts the socket).
 *   LYRA_SUBNAME     — optional display name for the TG pairing greeting.
 *   LYRA_TELEGRAM_BOT_TOKEN + LYRA_TELEGRAM_ALLOWED_USER_IDS — enable the TG listener.
 */

import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  acquireScopedLock,
  agentPaths,
  generateBootstrapKeypair,
  placeholderAgentId,
} from 'lyra-core'
import { keypairFromSecret } from 'lyra-plugin-onchain'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'
import { RealRuntime } from './real-runtime'
import type { RuntimeConfig } from './runtime'
import type { GatewaySecrets } from './secrets'
import { createGatewayServer } from './server'
import {
  GATEWAY_VERSION,
  createSession,
  transitionToProvisioned,
  transitionToReady,
  transitionToShuttingDown,
} from './state'

function die(msg: string): never {
  process.stderr.write(`gateway: ${msg}\n`)
  process.exit(1)
}

function envOrNull(name: string): string | null {
  const v = process.env[name]
  return v && v.trim() !== '' ? v.trim() : null
}

/** Read telegram secrets from the environment (local mode). */
function loadLocalTelegramSecrets(): GatewaySecrets | undefined {
  const botToken = envOrNull('LYRA_TELEGRAM_BOT_TOKEN')
  if (!botToken) return undefined
  const allowedRaw = envOrNull('LYRA_TELEGRAM_ALLOWED_USER_IDS') ?? ''
  const allowedUserIds = allowedRaw
    .split(',')
    .map(s => Number.parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 0)
  return { telegram: { botToken, allowedUserIds } }
}

/**
 * Build the RuntimeConfig for local mode. If LYRA_CONFIG points at a
 * lyra.config.ts module, its fields are merged on top of the env defaults.
 */
async function buildLocalConfig(agentAddress: string): Promise<RuntimeConfig> {
  const network = (envOrNull('LYRA_NETWORK') ?? 'mainnet') as RuntimeConfig['network']
  if (network !== 'testnet' && network !== 'mainnet') {
    die(`LYRA_NETWORK must be 'testnet' or 'mainnet' (got '${network}')`)
  }

  let fileConfig: Partial<RuntimeConfig> = {}
  const configPath = envOrNull('LYRA_CONFIG')
  if (configPath) {
    if (!existsSync(configPath)) die(`config not found at ${configPath}`)
    const mod = (await import(configPath)) as { default?: Record<string, unknown> }
    fileConfig = (mod.default ?? {}) as Partial<RuntimeConfig>
  }

  return {
    network: (fileConfig.network as RuntimeConfig['network']) ?? network,
    brain: {
      provider: fileConfig.brain?.provider ?? process.env.LYRA_LLM_PROVIDER ?? 'openai',
      model:
        fileConfig.brain?.model ?? process.env.LYRA_LLM_MODEL ?? 'gpt-4o-mini',
      ...fileConfig.brain,
    },
    identity: {
      agent: agentAddress,
      packageId: fileConfig.identity?.packageId ?? envOrNull('LYRA_PACKAGE_ID') ?? undefined,
      policyObjectId:
        fileConfig.identity?.policyObjectId ?? envOrNull('LYRA_POLICY_OBJECT_ID') ?? undefined,
      operator: fileConfig.identity?.operator,
    },
    deployTarget: 'local',
    plugins: fileConfig.plugins ?? ['system', 'onchain'],
    tools: fileConfig.tools,
    permissions: fileConfig.permissions,
    promptAppend: fileConfig.promptAppend,
    subname: fileConfig.subname ?? envOrNull('LYRA_SUBNAME'),
  }
}

async function main(): Promise<void> {
  const agentSecret = envOrNull('LYRA_AGENT_KEY')
  if (!agentSecret) die('LYRA_AGENT_KEY env var required (suiprivkey1... or base64 seed)')

  let agentAddress: string
  try {
    agentAddress = keypairFromSecret(agentSecret).toSuiAddress()
  } catch (e) {
    return die(`invalid LYRA_AGENT_KEY: ${(e as Error).message}`)
  }

  const agentId = envOrNull('LYRA_AGENT_ID') ?? placeholderAgentId(agentAddress)
  const paths = agentPaths.agent(agentId)
  // Operator-auth address is optional in local mode (the unix-socket perm is
  // the trust boundary). Fall back to the agent address as a stable label.
  const operatorAddress = envOrNull('LYRA_OPERATOR_ADDRESS') ?? agentAddress

  const config = await buildLocalConfig(agentAddress)
  const secrets = loadLocalTelegramSecrets()

  // Proactively reap a zombie/crashed listener's bot-token lock so the
  // TelegramListener doesn't get stuck waiting for TTL eviction.
  if (secrets?.telegram?.botToken) {
    try {
      const { clearStaleTelegramTokenLock } = await import('lyra-plugin-telegram')
      const cleanup = clearStaleTelegramTokenLock(secrets.telegram.botToken, { agentId })
      if (cleanup.cleared) {
        process.stdout.write(
          `[gateway] ${new Date().toISOString()} cleared stale TG bot-token lock (${cleanup.reason})\n`,
        )
      }
    } catch (err) {
      process.stderr.write(
        `gateway: stale-tg-lock-cleanup failed: ${(err as Error).message?.slice(0, 200) ?? 'unknown'}\n`,
      )
    }
  }

  // Acquire host-wide gateway lock so two `lyra gateway run` calls for the
  // same agent can't both bind the socket. 5-minute TTL with refresh below.
  const lockResult = acquireScopedLock({
    scope: 'lyra-gateway',
    identity: agentId,
    ttl: 5 * 60,
  })
  if (!lockResult.acquired || !lockResult.handle) {
    die(`gateway already running pid=${lockResult.existing?.pid ?? '?'}`)
  }
  const lockHandle = lockResult.handle
  const lockRefresh = setInterval(() => {
    try {
      lockHandle.refreshFn()
    } catch {
      /* lock evicted; daemon will exit on next iteration */
    }
  }, 60 * 1000).unref()

  // Build harness session with stub bootstrap (never used in local mode —
  // /bootstrap/* routes are unreachable because session starts in Ready).
  const events = new EventHub()
  const approvals = new ApprovalRelay(events)
  const runtime = new RealRuntime({ approvals })
  const sandboxId = `local-${hostname()}-${agentId.slice(0, 8)}`
  const sess = createSession({
    bootstrap: generateBootstrapKeypair(),
    expectedOperatorAddress: operatorAddress as `0x${string}`,
    sandboxId,
    events,
    approvals,
    runtime,
    version: GATEWAY_VERSION,
  })

  // Provision inline: skip /bootstrap/provision HTTP roundtrip.
  transitionToProvisioned(sess, {
    agentSecret,
    agentAddress,
    operatorAddress: operatorAddress as `0x${string}`,
    config,
  })

  const log = (line: string): void => {
    process.stdout.write(`[gateway] ${new Date().toISOString()} ${line}\n`)
  }

  // Start runtime async so we can bind the socket before brain.init resolves.
  // Server returns 409 on /chat until state === 'Ready'.
  void runtime
    .start({ agentSecret, config, events, secrets })
    .then(() => {
      transitionToReady(sess)
      log(`runtime ready agent=${agentAddress}`)
    })
    .catch(err => {
      log(`runtime-start-error: ${(err as Error).message}`)
    })

  const server = createGatewayServer({ session: sess, logger: log, trustLocal: true })

  const socketPath = join(paths.dir, 'gateway.sock')
  // Clean stale socket from prior crash.
  try {
    unlinkSync(socketPath)
  } catch {
    /* ENOENT or similar; ignore */
  }
  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600)
    } catch {
      /* non-POSIX */
    }
    log(`listening unix:${socketPath} agent=${agentId}`)
    log('bootstrap pubkey=(skipped — local mode)')
    log(`network=${config.network} operator=${operatorAddress}`)
  })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log(`signal=${signal} shutting down`)
    transitionToShuttingDown(sess)
    clearInterval(lockRefresh)
    approvals.stop()
    // Backstop in case runtime.stop hangs (e.g. grammy bot.stop deadlock).
    const forceExit = setTimeout(() => {
      log('shutdown timeout, forcing exit')
      process.exit(1)
    }, 10_000)
    forceExit.unref()
    // Plugin listeners (Telegram especially) release their bot-token lock
    // during runtime.stop teardown. Exiting before this resolves leaves a
    // stale lock with the dying PID; the next boot then refuses to start the
    // listener. Await teardown first.
    try {
      await runtime.stop()
    } catch {
      /* best-effort */
    }
    try {
      lockHandle.releaseFn()
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
    server.close(() => {
      log('server closed')
      clearTimeout(forceExit)
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => {
  process.stderr.write(`gateway: fatal — ${(err as Error).message}\n`)
  process.exit(1)
})
