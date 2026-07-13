import http from 'node:http'
import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH, decryptWithPrivkey } from 'lyra-core'
import { keypairFromSecret } from 'lyra-plugin-onchain'
import {
  type AdminAction,
  type ProvisionRequest,
  verifyAdminTickSig,
  verifyApprovalSig,
  verifyChatSig,
  verifyProvisionSig,
} from './auth'
import type { EventHub, GatewayEvent, SubscriberKind } from './events'
import { type Address, normalizeAddress } from './operator-sig'
import type { RuntimeConfig } from './runtime'
import { type GatewaySession, transitionToProvisioned, transitionToReady } from './state'

export interface ServerDeps {
  session: GatewaySession
  logger?: (line: string) => void
  /**
   * When true, skip operator-signature checks on /chat and /approval routes.
   * Used by the local-mode gateway where the unix socket file permission
   * (0600) provides equivalent authentication: only the user who owns the
   * socket can connect, so signature replay defense is unnecessary.
   * /provision is unreachable in local mode anyway (session starts in Ready
   * state).
   */
  trustLocal?: boolean
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function readJson(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

/**
 * v0.24.14: parse `?client=tui|dashboard|other` from a /events URL. Anything
 * unrecognized falls through to `other`. Used to tag SSE subscribers so the
 * TG forward gate in build-runtime.ts can distinguish operator TUIs from
 * passive web dashboards.
 */
function parseClientKind(url: string): SubscriberKind {
  const q = url.indexOf('?')
  if (q < 0) return 'other'
  const params = new URLSearchParams(url.slice(q + 1))
  const raw = params.get('client')
  if (raw === 'tui' || raw === 'dashboard' || raw === 'other') return raw
  return 'other'
}

function ssePayload(event: GatewayEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify({ ts: event.ts, data: event.data })}\n\n`
}

function attachSse(
  res: http.ServerResponse,
  hub: EventHub,
  sinceSeq?: number,
  clientKind: SubscriberKind = 'other',
): () => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })

  // Guard with `res.writable` (false once the stream is ended OR the socket is
  // destroyed) — `writableEnded` stays false on an abruptly-dropped connection,
  // so a heartbeat/event write would otherwise throw on the dead socket. The
  // try/catch covers the residual write-vs-disconnect race.
  const safeWrite = (chunk: string): void => {
    if (!res.writable) return
    try {
      res.write(chunk)
    } catch {
      // peer vanished mid-write; the 'close' handler runs cleanup.
    }
  }

  safeWrite(': hello\n\n')

  const heartbeat = setInterval(() => {
    safeWrite(': heartbeat\n\n')
  }, 15_000)
  heartbeat.unref?.()

  const unsub = hub.subscribe(
    event => {
      safeWrite(ssePayload(event))
    },
    sinceSeq,
    clientKind,
  )

  const cleanup = (): void => {
    clearInterval(heartbeat)
    unsub()
    if (res.writable) {
      try {
        res.end()
      } catch {
        // already torn down
      }
    }
  }
  res.on('close', cleanup)
  return cleanup
}

/**
 * Per-request context threaded to each route handler. Bundles the raw
 * request/response, the parsed method+url, and the server-wide deps so
 * handlers stay pure module functions (keeps each one's cognitive complexity
 * low and the router a thin dispatch loop).
 */
interface RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: string
  method: string
  session: GatewaySession
  log: (line: string) => void
  trustLocal: boolean
}

type RouteHandler = (ctx: RouteContext) => void | Promise<void>

interface Route {
  match: (method: string, url: string) => boolean
  handle: RouteHandler
}

const APPROVAL_URL_RE = /^\/approval\/([^/]+)\/respond$/

/**
 * Shared operator-signature check for the sandbox admin endpoints
 * (/admin/profile-key, /admin/pairing/approve — both read their body up front).
 * Sends the failure response itself and returns `false` so the caller can
 * early-return; returns `true` when the signature verifies. `/admin/autotopup/tick`
 * keeps its own inline variant because it reads the body lazily inside the
 * trustLocal gate.
 */
async function verifyAdminSig(
  ctx: RouteContext,
  action: AdminAction,
  body: { ts?: number; signature?: string },
): Promise<boolean> {
  const { res, session } = ctx
  const operator = session.operatorAddress
  if (!operator) {
    send(res, 500, { error: 'operator-not-set' })
    return false
  }
  if (typeof body.ts !== 'number' || !body.signature) {
    send(res, 401, {
      error: 'unauthorized',
      reason: 'sandbox admin requires {ts, signature} body signed by operator',
    })
    return false
  }
  const verify = await verifyAdminTickSig({
    action,
    ts: body.ts,
    sandboxId: session.sandboxId,
    signature: body.signature,
    expectedOperator: operator,
  })
  if (!verify.ok) {
    send(res, 401, { error: 'unauthorized', reason: verify.reason })
    return false
  }
  return true
}

function handleBootstrapPubkey({ res, session }: RouteContext): void {
  send(res, 200, {
    pubkeyHex: session.bootstrap.pubkeyHexCompressed,
    version: session.version,
    sandboxId: session.sandboxId,
    state: session.state,
    bootedAt: session.bootedAt,
  })
}

function handleHealthz({ res, session }: RouteContext): void {
  // v0.21.12: include per-listener state so operators (and the live
  // verification matrix) can probe whether the telegram listener is
  // actually wired up without parsing logs. `disabled` means no
  // telegram-secrets blob was decrypted at boot (intentional config or
  // missing scope key). `active` = listener registered. `failed` =
  // registered but start threw (future, once we plumb start outcomes).
  const listeners = session.runtime.listenerStates?.() ?? { telegram: 'disabled' as const }
  // v0.21.13: surface the current permission mode so the TUI thin client
  // can sync its statusline. Pre-fix the TUI hardcoded `approvalsMode: 'off'`
  // and never reflected /perms or /yolo flips routed through dispatchBypass.
  const permsMode = session.runtime.permissionMode?.()
  // v0.23.0: surface every iNFT slot's restore/flush status so operators
  // (and /console) can see whether profile / identity / persona / MEMORY
  // / activity-log are anchored, pending, or skipped. Missing field on
  // pre-Ready containers — keep undefined rather than empty {} so tests
  // can distinguish "not wired yet" from "wired but all skipped".
  const slots = session.runtime.slotStatus?.()
  send(res, 200, {
    state: session.state,
    sandboxId: session.sandboxId,
    version: session.version,
    uptimeMs: Date.now() - session.bootedAt,
    bootedAt: session.bootedAt,
    provisionedAt: session.provisionedAt,
    readyAt: session.readyAt,
    agentAddress: session.agentAddress,
    runtimeReady: session.runtime.ready(),
    eventsLastSeq: session.events.lastSeq(),
    subscribers: session.events.size(),
    pendingApprovals: session.approvals.pendingCount(),
    listeners,
    permsMode,
    slots,
  })
}

function handleEvents({ req, res, url, session }: RouteContext): void {
  const sinceHeader = req.headers['last-event-id']
  const sinceSeq = sinceHeader ? Number.parseInt(String(sinceHeader), 10) : undefined
  // v0.24.14: accept `?client=tui|dashboard|other` so the daemon can
  // distinguish a live operator TUI from passive web dashboards.
  // Default is `other` (back-compat: pre-v0.24.14 clients keep
  // existing semantics, and the TG forward gate only blocks on `tui`).
  const clientKind = parseClientKind(url)
  attachSse(res, session.events, Number.isFinite(sinceSeq) ? sinceSeq : undefined, clientKind)
}

async function handleProvision({ req, res, session, log }: RouteContext): Promise<void> {
  if (session.state !== 'Bootstrapping') {
    return send(res, 409, { error: 'already-provisioned', state: session.state })
  }

  const body = (await readJson(req)) as {
    envelope: ProvisionRequest['envelope']
    secretsEnvelope?: ProvisionRequest['envelope']
    operatorAddress: Address
    iNFTRef: ProvisionRequest['iNFTRef']
    config: RuntimeConfig
    ts: number
    signature: string
  }

  if (!(body?.envelope && body.operatorAddress && body.iNFTRef && body.config && body.signature)) {
    return send(res, 400, { error: 'missing-fields' })
  }

  const request: ProvisionRequest = {
    envelope: body.envelope,
    secretsEnvelope: body.secretsEnvelope,
    operatorAddress: normalizeAddress(body.operatorAddress),
    iNFTRef: {
      contract: normalizeAddress(body.iNFTRef.contract),
      tokenId: body.iNFTRef.tokenId,
    },
    config: body.config,
    ts: body.ts,
  }

  const verified = await verifyProvisionSig({
    request,
    signature: body.signature,
    bootstrapPubkey: session.bootstrap.pubkeyHexCompressed,
    expectedOperator: session.expectedOperatorAddress,
  })
  if (!verified.ok) {
    log(`provision-rejected reason=${verified.reason}`)
    return send(res, 401, { error: 'unauthorized', reason: verified.reason })
  }

  let agentPrivkeyBytes: Uint8Array
  try {
    agentPrivkeyBytes = decryptWithPrivkey({
      recipientPrivkey: session.bootstrap.privkeyHex,
      envelope: request.envelope,
    })
  } catch (e) {
    log(`provision-decrypt-fail: ${(e as Error).message}`)
    return send(res, 400, { error: 'decrypt-failed' })
  }
  if (agentPrivkeyBytes.length !== 32) {
    return send(res, 400, { error: 'plaintext-length', length: agentPrivkeyBytes.length })
  }

  // The provision envelope ships a raw 32-byte Ed25519 seed. Encode it
  // as base64 so it round-trips as a string through the session/runtime
  // (keypairFromSecret accepts `suiprivkey1...` or base64 seed).
  const agentSecret = Buffer.from(agentPrivkeyBytes).toString('base64')
  const agentAddress = keypairFromSecret(agentSecret).toSuiAddress()

  // Optional secrets envelope (Phase 12 / B6). Decrypted with the
  // bootstrap privkey same as the agent privkey envelope. JSON parsed
  // against the GatewaySecrets zod schema; failures abort provision.
  let secrets: import('./secrets').GatewaySecrets | undefined
  if (request.secretsEnvelope) {
    let secretsBytes: Uint8Array
    try {
      secretsBytes = decryptWithPrivkey({
        recipientPrivkey: session.bootstrap.privkeyHex,
        envelope: request.secretsEnvelope,
      })
    } catch (e) {
      log(`secrets-decrypt-fail: ${(e as Error).message}`)
      return send(res, 400, { error: 'secrets-decrypt-failed' })
    }
    try {
      const { parseGatewaySecrets } = await import('./secrets')
      secrets = parseGatewaySecrets(new TextDecoder().decode(secretsBytes))
    } catch (e) {
      log(`secrets-parse-fail: ${(e as Error).message}`)
      return send(res, 400, { error: 'secrets-parse-failed' })
    }
  }

  transitionToProvisioned(session, {
    agentSecret,
    agentAddress,
    operatorAddress: request.operatorAddress,
    config: request.config,
  })
  log(
    `provisioned agent=${agentAddress} state=${session.state}${secrets?.telegram ? ' (with telegram secrets)' : ''}`,
  )

  send(res, 200, {
    ok: true,
    agentAddress,
    state: session.state,
    provisionedAt: session.provisionedAt,
  })

  // v0.21.10: enrich the provision config with operator + deployTarget
  // before runtime.start so account.balance can read the sandbox billing
  // reserve (needs both fields). The provision envelope already carries
  // operatorAddress at the top level for sig verification; we mirror it
  // into config.identity.operator for the runtime ctx, and force
  // deployTarget='sandbox' since the harness only ever runs in a sandbox.
  const enrichedConfig: RuntimeConfig = {
    ...request.config,
    identity: {
      ...request.config.identity,
      operator: request.operatorAddress,
    },
    deployTarget: 'sandbox',
  }
  Promise.resolve()
    .then(async () => {
      await session.runtime.start({
        agentSecret,
        config: enrichedConfig,
        events: session.events,
        secrets,
      })
      transitionToReady(session)
      log(`runtime ready agent=${agentAddress}`)
    })
    .catch(err => {
      log(`runtime-start-error: ${(err as Error).message}`)
    })
}

async function handleChat({ req, res, session, log, trustLocal }: RouteContext): Promise<void> {
  if (session.state !== 'Ready') {
    return send(res, 409, { error: 'not-ready', state: session.state })
  }
  const body = (await readJson(req)) as {
    message: string
    ts: number
    signature?: string
    operatorAddress?: Address
  }
  if (!body?.message || typeof body.ts !== 'number') {
    return send(res, 400, { error: 'missing-fields' })
  }
  const operator = session.operatorAddress
  if (!operator) {
    return send(res, 500, { error: 'operator-not-set' })
  }
  if (!trustLocal) {
    if (!body.signature) {
      return send(res, 400, { error: 'missing-fields' })
    }
    const verified = await verifyChatSig({
      message: body.message,
      ts: body.ts,
      sandboxId: session.sandboxId,
      signature: body.signature,
      expectedOperator: operator,
    })
    if (!verified.ok) {
      log(`chat-rejected reason=${verified.reason}`)
      return send(res, 401, { error: 'unauthorized', reason: verified.reason })
    }
  }
  try {
    const result = await session.runtime.runChatTurn({
      message: body.message,
      ts: body.ts,
      signature: body.signature ?? '0x',
      operatorAddress: operator,
    })
    return send(res, 200, result)
  } catch (e) {
    log(`chat-error: ${(e as Error).message}`)
    return send(res, 500, { error: 'turn-failed', detail: (e as Error).message })
  }
}

async function handleSync({ res, session }: RouteContext): Promise<void> {
  if (session.state !== 'Ready') {
    return send(res, 409, { error: 'not-ready', state: session.state })
  }
  try {
    const result = await session.runtime.flushSync()
    return send(res, 200, result)
  } catch (e) {
    return send(res, 500, { error: 'sync-failed', detail: (e as Error).message })
  }
}

// v0.21.5 → v0.21.9: admin endpoint to live-fire an AutoTopupManager tick.
// Two auth paths:
//   1. Local sock (trustLocal=true via 0600 unix-sock perm): direct allow.
//   2. Sandbox endpoint (trustLocal=false): requires { ts, signature } body
//      signed by the operator over `adminTickDigest('autotopup-tick',
//      ts, sandboxId)`. Replay-protected by ts window (±5min) and bound to
//      the sandboxId so a sig for one container can't fire on another.
async function handleAutotopupTick({ req, res, session, trustLocal }: RouteContext): Promise<void> {
  if (!trustLocal) {
    const operator = session.operatorAddress
    if (!operator) {
      return send(res, 500, { error: 'operator-not-set' })
    }
    const body = (await readJson(req).catch(() => null)) as {
      ts?: number
      signature?: string
    } | null
    if (!body || typeof body.ts !== 'number' || !body.signature) {
      return send(res, 401, {
        error: 'unauthorized',
        reason: 'sandbox admin requires {ts, signature} body signed by operator',
      })
    }
    const verify = await verifyAdminTickSig({
      action: 'autotopup-tick',
      ts: body.ts,
      sandboxId: session.sandboxId,
      signature: body.signature,
      expectedOperator: operator,
    })
    if (!verify.ok) {
      return send(res, 401, { error: 'unauthorized', reason: verify.reason })
    }
  }
  if (session.state !== 'Ready') {
    return send(res, 409, { error: 'not-ready', state: session.state })
  }
  if (!session.runtime.triggerTopupTick) {
    return send(res, 501, { error: 'not-supported' })
  }
  try {
    const result = await session.runtime.triggerTopupTick()
    return send(res, result.ok ? 200 : 503, result)
  } catch (e) {
    return send(res, 500, { error: 'tick-failed', detail: (e as Error).message })
  }
}

// v0.23.0: ship the operator-scoped PROFILE AES key into the sandbox.
// Same operator-signature auth shape as /admin/autotopup/tick — body must
// be signed by the operator over `adminTickDigest('profile-key', ts, sandboxId)`.
// The key field is sent in the clear over an authenticated session;
// sandbox endpoints are operator-only via the sandbox provider's
// network policy. Once installed, MemorySyncManager picks it up on
// the next flush and the gateway fires a one-shot restore for the
// profile slot.
async function handleProfileKey(ctx: RouteContext): Promise<void> {
  const { req, res, session, trustLocal } = ctx
  const body = (await readJson(req).catch(() => null)) as {
    ts?: number
    signature?: string
    profileScopeKeyHex?: string
  } | null
  if (!body || typeof body.profileScopeKeyHex !== 'string') {
    return send(res, 400, { error: 'missing-fields', need: 'profileScopeKeyHex' })
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(body.profileScopeKeyHex)) {
    return send(res, 400, { error: 'bad-key-format' })
  }
  if (!trustLocal) {
    const authed = await verifyAdminSig(ctx, 'profile-key', body)
    if (!authed) return
  }
  if (session.state !== 'Ready') {
    return send(res, 409, { error: 'not-ready', state: session.state })
  }
  if (!session.runtime.setProfileKey) {
    return send(res, 501, { error: 'not-supported' })
  }
  try {
    const result = await session.runtime.setProfileKey(body.profileScopeKeyHex as `0x${string}`)
    return send(res, result.ok ? 200 : 503, result)
  } catch (e) {
    return send(res, 500, { error: 'set-failed', detail: (e as Error).message })
  }
}

// v0.24.4: route an operator pair-mode approval into the container's
// pairing dir so sandbox-deployed agents are reachable from the host
// CLI without SSHing into the container. Mirrors `/admin/profile-key`
// auth shape — body must be signed by the operator over
// `adminTickDigest('pairing-approve', ts, sandboxId)`. Platform is
// currently restricted to `telegram` (single live listener); extend
// this allowlist as new platforms ship listeners. Code format must
// match `PairingStore.generateCode` (8-char uppercase from
// `PAIRING_ALPHABET`, no 0/O/1/I); a 400 here saves a wasted lookup
// round-trip and gives the operator's CLI a clean reject signal.
async function handlePairingApprove(ctx: RouteContext): Promise<void> {
  const { req, res, session, trustLocal } = ctx
  const body = (await readJson(req).catch(() => null)) as {
    platform?: string
    code?: string
    ts?: number
    signature?: string
  } | null
  if (!body || typeof body.platform !== 'string' || typeof body.code !== 'string') {
    return send(res, 400, { error: 'missing-fields', need: 'platform,code' })
  }
  if (body.platform !== 'telegram') {
    return send(res, 400, { error: 'unsupported-platform', platform: body.platform })
  }
  const normalizedCode = body.code.toUpperCase().trim()
  if (normalizedCode.length !== PAIRING_CODE_LENGTH) {
    return send(res, 400, { error: 'bad-code-format', reason: 'wrong-length' })
  }
  for (const ch of normalizedCode) {
    if (!PAIRING_ALPHABET.includes(ch)) {
      return send(res, 400, { error: 'bad-code-format', reason: 'invalid-character' })
    }
  }
  if (!trustLocal) {
    const authed = await verifyAdminSig(ctx, 'pairing-approve', body)
    if (!authed) return
  }
  if (session.state !== 'Ready') {
    return send(res, 409, { error: 'not-ready', state: session.state })
  }
  if (!session.runtime.approvePairing) {
    return send(res, 501, { error: 'not-supported' })
  }
  try {
    const result = session.runtime.approvePairing(body.platform, normalizedCode)
    // Non-200 only for transport-level failure; an unknown code or a
    // locked-out platform is still a successful round-trip — the
    // operator's CLI prints `result.reason` either way.
    return send(res, 200, result)
  } catch (e) {
    return send(res, 500, { error: 'approve-failed', detail: (e as Error).message })
  }
}

async function handleApprovalRespond({
  req,
  res,
  url,
  method,
  session,
  log,
  trustLocal,
}: RouteContext): Promise<void> {
  const approvalId = url.match(APPROVAL_URL_RE)?.[1]
  if (!approvalId) {
    // Unreachable: the router only dispatches here when APPROVAL_URL_RE
    // matches, which guarantees a captured id. Kept for type-narrowing.
    return send(res, 404, { error: 'not-found', method, url })
  }
  const body = (await readJson(req)) as {
    decision: 'allow' | 'allow-session' | 'deny'
    ts: number
    signature?: string
  }
  if (!body?.decision || typeof body.ts !== 'number') {
    return send(res, 400, { error: 'missing-fields' })
  }
  const operator = session.operatorAddress
  if (!operator) {
    return send(res, 500, { error: 'operator-not-set' })
  }
  if (!session.approvals.has(approvalId)) {
    return send(res, 404, { error: 'unknown-approval', id: approvalId })
  }
  if (!trustLocal) {
    if (!body.signature) {
      return send(res, 400, { error: 'missing-fields' })
    }
    const verified = await verifyApprovalSig({
      approvalId,
      decision: body.decision,
      ts: body.ts,
      sandboxId: session.sandboxId,
      signature: body.signature,
      expectedOperator: operator,
    })
    if (!verified.ok) {
      log(`approval-rejected id=${approvalId} reason=${verified.reason}`)
      return send(res, 401, { error: 'unauthorized', reason: verified.reason })
    }
  }
  const ok = session.approvals.resolve(approvalId, body.decision)
  return send(res, ok ? 200 : 409, { ok, id: approvalId, decision: body.decision })
}

// Ordered dispatch table. The first route whose `match` returns true wins;
// preserving this order keeps the exact routing semantics of the original
// sequential if-chain (with the /approval regex evaluated last, before 404).
const ROUTES: Route[] = [
  { match: (m, u) => m === 'GET' && u === '/bootstrap/pubkey', handle: handleBootstrapPubkey },
  { match: (m, u) => m === 'GET' && u === '/healthz', handle: handleHealthz },
  {
    match: (m, u) => m === 'GET' && (u === '/events' || u.startsWith('/events?')),
    handle: handleEvents,
  },
  { match: (m, u) => m === 'POST' && u === '/bootstrap/provision', handle: handleProvision },
  { match: (m, u) => m === 'POST' && u === '/chat', handle: handleChat },
  { match: (m, u) => m === 'POST' && u === '/sync', handle: handleSync },
  {
    match: (m, u) => m === 'POST' && u === '/admin/autotopup/tick',
    handle: handleAutotopupTick,
  },
  { match: (m, u) => m === 'POST' && u === '/admin/profile-key', handle: handleProfileKey },
  {
    match: (m, u) => m === 'POST' && u === '/admin/pairing/approve',
    handle: handlePairingApprove,
  },
  { match: (m, u) => m === 'POST' && APPROVAL_URL_RE.test(u), handle: handleApprovalRespond },
]

export function createGatewayServer(deps: ServerDeps): http.Server {
  const log = deps.logger ?? (() => {})
  const { session } = deps
  const trustLocal = deps.trustLocal === true

  return http.createServer(async (req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      for (const route of ROUTES) {
        if (route.match(method, url)) {
          await route.handle({ req, res, url, method, session, log, trustLocal })
          return
        }
      }
      send(res, 404, { error: 'not-found', method, url })
    } catch (e) {
      log(`server-error: ${(e as Error).message}`)
      if (!res.headersSent) send(res, 500, { error: 'internal' })
    }
  })
}
