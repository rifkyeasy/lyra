/**
 * `nebula gateway start` — interactive Touch ID + write operator-session,
 * then fork the gateway daemon detached.
 *
 * Flow:
 *   1. Load config from ~/.nebula/config.ts
 *   2. Resolve agentId (override via --agent or first agent in config)
 *   3. Check if gateway already running (lock file). If yes, error.
 *   4. Pick operator signer + interactive Touch ID via existing operator-picker
 *   5. Pre-derive scope keys via precomputeAllScopes (keystore + telegram)
 *   6. Write operator-session file (perm 0600, 24h TTL)
 *   7. Spawn nebula-gateway-local detached + wait for socket to become readable
 *      (proves the daemon booted cleanly)
 *   8. Print pid + socket path
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spinner } from '@clack/prompts'
import {
  OPERATOR_BLOB_SCOPES,
  type OperatorBlobScope,
  agentPaths,
  buildOperatorSession,
  decodeKeystoreBytes,
  decodeOperatorBlobBytes,
  isOperatorSessionComplete,
  placeholderAgentId,
  precomputeAllScopes,
  readOperatorSession,
  requiredScopesForAgent,
  tryDecryptKeystoreWithKey,
  tryDecryptOperatorBlobWithKey,
  writeOperatorSession,
} from 'nebula-ai-core'
import { type Address, getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { spawnGatewayDaemon } from '../util/gateway-spawn'
import { telegramSecretsPath } from '../util/telegram-secrets'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export interface GatewayStartOpts {
  agentId?: string
}

export async function runGatewayStart(opts: GatewayStartOpts): Promise<void> {
  const found = await findAndLoadConfig()
  if (!found?.config) {
    console.error('nebula gateway start: no nebula.config.ts found in cwd or ~/.nebula/')
    process.exit(1)
  }
  const config = found.config
  const agentAddress = getAddress(config.identity.agent as Address)
  const agentId = opts.agentId ?? placeholderAgentId(agentAddress)
  const paths = agentPaths.agent(agentId)
  const socketPath = join(paths.dir, 'gateway.sock')

  // v0.23.2: if the socket exists, check for version drift. If the running
  // daemon's version differs from the on-disk CLI binary, auto-restart so
  // operators don't have to remember `nebula gateway restart` after every
  // `bun add -g nebula-ai-cli@N`. If versions match, bail with the
  // legacy "already running" error.
  if (existsSync(socketPath)) {
    const { createHash } = await import('node:crypto')
    const { homedir } = await import('node:os')
    const identityHash = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
    const lockFile = join(homedir(), '.nebula', 'locks', `nebula-gateway-${identityHash}.lock`)
    const { ensureGatewayVersionMatchesCli } = await import('../util/gateway-version')
    const drift = await ensureGatewayVersionMatchesCli({ socketPath, lockFile })
    if (drift.action === 'ok' || drift.action === 'no-cli-version') {
      console.error(
        `nebula gateway start: socket already exists at ${socketPath} — gateway may be running (version ${drift.daemonVersion ?? 'unknown'}). Try \`nebula gateway stop\` first.`,
      )
      process.exit(1)
    }
    console.log(`note: ${drift.note}`)
  }

  // v0.21.12: derive the set of scope keys this agent's daemon will need
  // based on what's on disk (always 'keystore'; adds 'telegram' when
  // telegram-secrets.encrypted is present, etc.). The cached session is only
  // "complete enough to skip Touch ID" when it contains every required key.
  // Pre-fix, this used the binary `isOperatorSessionFresh` which returned
  // true for any non-expired session, even one written by a path that didn't
  // derive TELEGRAM. The daemon then booted, found no telegram scope key,
  // and silently dropped all inbound TG messages.
  const required = requiredScopesForAgent(agentId)
  const extraScopes = required.filter((s): s is Exclude<typeof s, 'keystore'> => s !== 'keystore')
  const complete = isOperatorSessionComplete(agentId, required)
  if (!complete) {
    const sUnlock = spinner()
    sUnlock.start('Unlocking operator wallet for session-key derivation')
    let operator: Awaited<ReturnType<typeof loadOrPickOperatorSigner>>
    try {
      operator = await loadOrPickOperatorSigner({
        network: config.network,
        hint: config.operator,
      })
    } catch (e) {
      sUnlock.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
      process.exit(1)
    }
    if (!operator) {
      sUnlock.stop('operator unlock cancelled')
      process.exit(1)
    }

    sUnlock.message(`Deriving scope keys (${required.join(' + ')})`)
    try {
      // v0.24.10: verify each derived canonical key against the on-disk
      // encrypted artifact. If verify fails (e.g. fox's pre-v0.24.9 WC
      // keystore was encrypted with the legacy empty-EIP712Domain hash),
      // `precomputeAllScopes` falls back to the legacy variant via the WC
      // signer's escape hatch and caches the WORKING key. Without this,
      // the daemon would boot with a stale canonical key + the
      // `precomputedKey skips fallback` semantic and panic on first
      // AES-GCM decrypt.
      const verifyKey = buildKeystoreVerifier(agentId)
      const keys = await precomputeAllScopes(operator, agentAddress, extraScopes, { verifyKey })
      const sess = buildOperatorSession({ agent: agentAddress, keys })
      writeOperatorSession(agentId, sess)
      sUnlock.stop('operator-session written (24h TTL)')
    } catch (e) {
      sUnlock.stop(`derive failed: ${(e as Error).message.slice(0, 160)}`)
      await operator.close?.()
      process.exit(1)
    }
    await operator.close?.()
  } else {
    console.log(`operator-session complete (${required.join(' + ')}); skipping Touch ID`)
  }

  // Spawn gateway daemon detached. Inherit stdio for the first ~3s so the
  // user sees boot errors, then redirect to log file when ready.
  const sBoot = spinner()
  sBoot.start(`Spawning gateway daemon (agent=${agentId.slice(0, 8)}…)`)

  const result = await spawnGatewayDaemon({
    agentId,
    configPath: found.path ?? '',
    socketPath,
    timeoutMs: 10_000,
    // v0.21.12: redirect daemon stdout/stderr to gateway.log (default
    // 'log-file' mode) so boot errors survive the parent's exit. Operators
    // see the log via `nebula gateway logs` or by tailing
    // ~/.nebula/agents/<id>/gateway.log directly.
  })
  if (result.ready) {
    sBoot.stop(`gateway running pid=${result.pid} socket=${socketPath}`)
    console.log('stop with: nebula gateway stop')
    console.log('logs:      nebula gateway logs -f')
  } else {
    const reason = result.reason ?? 'unknown'
    const detail = result.error ? `: ${result.error}` : ''
    sBoot.stop(
      `gateway did not bind socket within 10s (reason=${reason} pid=${result.pid ?? '?'})${detail}; check above output`,
    )
    process.exit(1)
  }
}

// Stub — wired by gateway-status when needed.
export function _operatorSessionPresent(agentId: string): boolean {
  return readOperatorSession(agentId) !== null
}

/**
 * v0.24.10: returns a verifier that `precomputeAllScopes` calls after each
 * canonical key derive. The verifier:
 *
 * - For 'keystore': trial-decrypts `<agentDir>/keystore.json` with the
 *   candidate key. Returns true on success, false on AES-GCM auth failure.
 *   False triggers the legacy empty-EIP712Domain fallback inside
 *   `precomputeAllScopes` so pre-v0.24.9 WC-init'd keystores (only known
 *   instance is fox, tokenId #5) can still flip to the correct AES key on
 *   first boot under v0.24.10+.
 *
 * - For TELEGRAM: trial-decrypts `<agentDir>/telegram-secrets.encrypted`
 *   when present. Same legacy-fallback semantic.
 *
 * - For PROFILE / unknown: returns true unconditionally. PROFILE has no
 *   on-disk artifact to verify against (the encrypted blob lives in iNFT
 *   slot 3 on chain); the keystore-scope detection above already cascades
 *   the legacy flag to PROFILE via `precomputeAllScopes`'s
 *   `useLegacyForRest` branch, so the PROFILE key is derived via the
 *   matching variant without needing a verify here.
 *
 * - On missing keystore (init flow never reached this code path, so this
 *   is a defensive fallback): returns true so the derive completes; the
 *   daemon's own decrypt at boot will surface the real error.
 */
function buildKeystoreVerifier(agentId: string) {
  const keystorePath = agentPaths.agent(agentId).keystore
  const tgSecretsPath = telegramSecretsPath(agentId)
  return async (scope: 'keystore' | OperatorBlobScope, key: Buffer): Promise<boolean> => {
    if (scope === 'keystore') {
      if (!existsSync(keystorePath)) return true
      try {
        const ks = decodeKeystoreBytes(new TextEncoder().encode(readFileSync(keystorePath, 'utf8')))
        return tryDecryptKeystoreWithKey(ks, key)
      } catch {
        return true
      }
    }
    if (scope === OPERATOR_BLOB_SCOPES.TELEGRAM) {
      if (!existsSync(tgSecretsPath)) return true
      try {
        const blob = decodeOperatorBlobBytes(new Uint8Array(readFileSync(tgSecretsPath)))
        return tryDecryptOperatorBlobWithKey(blob, key, OPERATOR_BLOB_SCOPES.TELEGRAM)
      } catch {
        return true
      }
    }
    return true
  }
}
