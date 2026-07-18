/**
 * `lyra login` — device-link the CLI to the same agent your web wallet
 * controls on app.lyraai.space.
 *
 * Flow (matches the web server contract exactly):
 *   1. POST {base}/api/cli/login/start  → { code, pollToken, verifyUrl, expiresInSec }
 *   2. Show the user the verify URL + code; best-effort open the browser.
 *   3. Poll GET {base}/api/cli/login/poll?pollToken=… every 2s until expiry.
 *      → { status:'pending' } keep waiting
 *      → { status:'approved', owner, agentKey } write the key, done
 *      → { status:'expired' | 'not_found' } friendly error, exit non-zero.
 *
 * The approved `agentKey` is a `suiprivkey1…` string — the SAME secret the web
 * derives for that owner — so the CLI and the web operate one identical agent.
 */

import { existsSync } from 'node:fs'
import { agentPaths } from 'lyra-core'
import { keypairFromSecret } from 'lyra-plugin-onchain'
import { DEFAULT_NETWORK } from '../config/defaults'
import { finalizeSetup } from '../config/setup'
import { writeAgentKey } from '../util/sui-runtime'

/** Default web origin; override with LYRA_WEB_URL for local/staging testing.
 *  MUST be the app subdomain — the `/api/*` routes live on app.lyraai.space; the
 *  bare lyraai.space is the landing site and 404s every API call. */
const DEFAULT_WEB_URL = 'https://app.lyraai.space'
const POLL_INTERVAL_MS = 2000

export interface LoginStart {
  code: string
  pollToken: string
  verifyUrl: string
  expiresInSec: number
}

export type LoginPoll =
  | { status: 'pending' }
  | { status: 'approved'; owner: string; agentKey: string }
  | { status: 'expired' }
  | { status: 'not_found' }

export interface LoginResult {
  owner: string
  address: string
  keyPath: string
}

export interface LoginDeps {
  base: string
  fetchImpl: typeof fetch
  /** Sleep between polls (injectable so tests run instantly). */
  sleep: (ms: number) => Promise<void>
  /** Monotonic clock (injectable so timeout tests are deterministic). */
  now?: () => number
  log: (msg: string) => void
  openBrowser?: (url: string) => void
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Best-effort: open `url` in the user's default browser. Never throws. */
function openBrowserBestEffort(url: string): void {
  try {
    const platform = process.platform
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open'
    // Lazy import so the happy path / tests don't pull in child_process.
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Headless / no browser — the printed URL is the fallback.
  }
}

/**
 * Core device-link logic, dependency-injected so tests never hit the network.
 * Resolves with the linked agent or throws a friendly Error on
 * expiry/timeout/not_found.
 */
export async function deviceLink(deps: LoginDeps): Promise<LoginResult> {
  const { base, fetchImpl, log } = deps

  const startRes = await fetchImpl(`${base}/api/cli/login/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!startRes.ok) {
    throw new Error(`login/start failed (HTTP ${startRes.status}) at ${base}`)
  }
  const start = (await startRes.json()) as LoginStart
  if (!(start?.code && start?.pollToken)) {
    throw new Error('login/start returned an unexpected response')
  }

  // Build the verify link from OUR base (where we pointed login), not the server's
  // reported origin — that can resolve to an internal proxy host behind a reverse
  // proxy. The CLI knows the public URL it called, so use it.
  const linkUrl = `${base}/cli-login?code=${encodeURIComponent(start.code)}`
  log('')
  log('Approve this login in your browser:')
  log(`  ${linkUrl}`)
  log(`  (or enter code: ${start.code})`)
  log('')
  log('Waiting for approval…')
  ;(deps.openBrowser ?? openBrowserBestEffort)(linkUrl)

  const now = deps.now ?? Date.now
  const expiresInSec = start.expiresInSec > 0 ? start.expiresInSec : 300
  const deadline = now() + expiresInSec * 1000

  while (now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS)
    const pollRes = await fetchImpl(
      `${base}/api/cli/login/poll?pollToken=${encodeURIComponent(start.pollToken)}`,
    )
    if (!pollRes.ok) {
      // Transient server hiccup — keep polling until the deadline.
      continue
    }
    const poll = (await pollRes.json()) as LoginPoll
    if (poll.status === 'approved') {
      const keyPath = writeAgentKey(poll.agentKey)
      const address = keypairFromSecret(poll.agentKey).toSuiAddress()
      return { owner: poll.owner, address, keyPath }
    }
    if (poll.status === 'expired') {
      throw new Error('Login request expired. Re-run `lyra login` and approve faster.')
    }
    if (poll.status === 'not_found') {
      throw new Error('Login request not found (already used or invalid). Re-run `lyra login`.')
    }
    // pending → keep waiting.
  }
  throw new Error('Login timed out before approval. Re-run `lyra login`.')
}

/** Resolve the web base URL (env override → default). */
export function resolveWebBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.LYRA_WEB_URL ?? DEFAULT_WEB_URL
}

/** Entry point for `lyra login`. Exits non-zero on failure. */
export async function runLogin(): Promise<void> {
  const base = resolveWebBase()
  try {
    const result = await deviceLink({
      base,
      fetchImpl: fetch,
      sleep,
      log: (m: string) => console.log(m),
    })
    console.log('')
    console.log(`✓ Linked agent ${result.address} (same as your web wallet)`)
    console.log(`  owner ${result.owner}`)
    console.log(`  key   ${result.keyPath}`)

    // Login used to write ONLY the agent key, leaving `lyra` (chat) with no config
    // to load. Write a runnable config (defaults) when one doesn't exist yet so the
    // device-link is a complete setup; never clobber an existing config.
    if (!existsSync(agentPaths.config)) {
      await finalizeSetup({
        agentAddress: result.address,
        linkedOwner: result.owner,
        network: DEFAULT_NETWORK,
      })
      console.log(`  config ${agentPaths.config}`)
    }
    console.log('')
    console.log('Next: `lyra` to chat · `lyra status` for health')
  } catch (e) {
    console.error(`lyra login: ${(e as Error).message}`)
    process.exit(1)
  }
}
