import { verifyPersonalMessageSignature } from '@mysten/sui/verify'
import {
  type Address,
  type DigestField,
  type Hex,
  digestFields,
  isAddressEqual,
} from './operator-sig'
import type { RuntimeConfig } from './runtime'

/** Agent reference carried in a (legacy remote) provision request. */
interface ProvisionAgentRef {
  contract: Address
  tokenId: string
}

export interface ProvisionEnvelope {
  ephPubkeyHex: Hex
  ivHex: Hex
  tagHex: Hex
  ciphertextHex: Hex
}

export interface ProvisionRequest {
  envelope: ProvisionEnvelope
  /**
   * Optional second ECIES envelope sealing the harness secrets JSON
   * (telegram bot token + allowlist, etc.). Sealed to the same bootstrap
   * pubkey. The operator's signature covers both envelopes so a stolen
   * secrets envelope can't be replayed against a different harness.
   */
  secretsEnvelope?: ProvisionEnvelope
  operatorAddress: Address
  iNFTRef: ProvisionAgentRef
  config: RuntimeConfig
  ts: number
}

function envelopeDigest(env: ProvisionEnvelope): Hex {
  const digest = digestFields([
    { type: 'bytes', name: 'eph', value: env.ephPubkeyHex },
    { type: 'bytes', name: 'iv', value: env.ivHex },
    { type: 'bytes', name: 'tag', value: env.tagHex },
    { type: 'bytes', name: 'ct', value: env.ciphertextHex },
  ])
  return `0x${Buffer.from(digest).toString('hex')}` as Hex
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  // Skip undefined-valued keys to match `JSON.stringify` semantics. Critical
  // because the wire path is `JSON.stringify` → JSON.parse, which silently
  // drops undefined object values. If we hashed them as the literal text
  // `undefined`, the CLI's pre-wire hash and the harness's post-wire hash
  // would diverge for any optional field the caller leaves unset (e.g.
  // `RuntimeConfig.promptAppend`), surfacing as `provision-rejected: sig-mismatch`.
  const v = value as Record<string, unknown>
  const keys = Object.keys(v)
    .filter(k => v[k] !== undefined)
    .sort()
  const props = keys.map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
  return `{${props.join(',')}}`
}

function configDigestField(config: RuntimeConfig): DigestField {
  // Stable JSON via recursive key-sorted stringify; harness + client must agree.
  return { type: 'string', name: 'config', value: stableStringify(config) }
}

/**
 * Build the deterministic 32-byte digest the operator signs over. Anchored to
 * the harness bootstrap pubkey + config so a stolen envelope cannot be replayed
 * against a different harness or a different runtime config.
 */
export function provisionMessageDigest(req: ProvisionRequest, bootstrapPubkey: Hex): Uint8Array {
  // Extends the digest with a secretsEnvelope digest so a second envelope can
  // ship telegram secrets etc. alongside the agent privkey. Zero-digest
  // sentinel preserves the layout when no secrets envelope is sent.
  const secretsDigest: Hex = req.secretsEnvelope
    ? envelopeDigest(req.secretsEnvelope)
    : ('0x0000000000000000000000000000000000000000000000000000000000000000' as Hex)
  return digestFields([
    { type: 'bytes32', name: 'envelopeDigest', value: envelopeDigest(req.envelope) },
    { type: 'bytes32', name: 'secretsEnvelopeDigest', value: secretsDigest },
    configDigestField(req.config),
    { type: 'address', name: 'operator', value: req.operatorAddress },
    { type: 'address', name: 'inftContract', value: req.iNFTRef.contract },
    { type: 'uint', name: 'tokenId', value: BigInt(req.iNFTRef.tokenId) },
    { type: 'uint', name: 'ts', value: BigInt(req.ts) },
    { type: 'bytes', name: 'bootstrapPubkey', value: bootstrapPubkey },
  ])
}

export interface VerifyOpts {
  request: ProvisionRequest
  signature: string
  bootstrapPubkey: Hex
  expectedOperator: Address
  /** Reject ts older than this (default 5min). */
  maxAgeMs?: number
  /** Reject ts further into the future than this (default 1min for clock skew). */
  maxFutureMs?: number
  now?: number
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/**
 * Verify a Sui personal-message signature over `digest` was produced by the
 * `expectedOperator` address. Returns a structured result so call sites can
 * surface the reject reason without throwing.
 */
async function verifyOperatorSig(
  digest: Uint8Array,
  signature: string,
  expectedOperator: Address,
): Promise<VerifyResult> {
  let signer: string
  try {
    const pubkey = await verifyPersonalMessageSignature(digest, signature)
    signer = pubkey.toSuiAddress()
  } catch (e) {
    return { ok: false, reason: `sig-decode: ${(e as Error).message}` }
  }
  if (!isAddressEqual(signer, expectedOperator)) {
    return { ok: false, reason: 'sig-mismatch' }
  }
  return { ok: true }
}

export async function verifyProvisionSig(opts: VerifyOpts): Promise<VerifyResult> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000
  const maxFuture = opts.maxFutureMs ?? 60 * 1000

  if (!isAddressEqual(opts.request.operatorAddress, opts.expectedOperator)) {
    return { ok: false, reason: 'operator-mismatch' }
  }
  if (opts.request.ts > now + maxFuture) {
    return { ok: false, reason: 'ts-future' }
  }
  if (opts.request.ts < now - maxAge) {
    return { ok: false, reason: 'ts-stale' }
  }

  const digest = provisionMessageDigest(opts.request, opts.bootstrapPubkey)
  return verifyOperatorSig(digest, opts.signature, opts.expectedOperator)
}

/**
 * Digest the operator signs to authenticate a chat message turn. Anchored to
 * sandboxId so a chat sig cannot be replayed against a different sandbox
 * harness running on the same operator.
 */
export function chatMessageDigest(message: string, ts: number, sandboxId: string): Uint8Array {
  return digestFields([
    { type: 'string', name: 'message', value: message },
    { type: 'uint', name: 'ts', value: BigInt(ts) },
    { type: 'string', name: 'sandboxId', value: sandboxId },
  ])
}

export interface VerifyChatOpts {
  message: string
  ts: number
  sandboxId: string
  signature: string
  expectedOperator: Address
  maxAgeMs?: number
  maxFutureMs?: number
  now?: number
}

export async function verifyChatSig(opts: VerifyChatOpts): Promise<VerifyResult> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000
  const maxFuture = opts.maxFutureMs ?? 60 * 1000
  if (opts.ts > now + maxFuture) return { ok: false, reason: 'ts-future' }
  if (opts.ts < now - maxAge) return { ok: false, reason: 'ts-stale' }

  const digest = chatMessageDigest(opts.message, opts.ts, opts.sandboxId)
  return verifyOperatorSig(digest, opts.signature, opts.expectedOperator)
}

/**
 * Digest the operator signs to authenticate an admin tick (e.g.
 * `POST /admin/autotopup/tick`) against the sandbox endpoint. Anchored to
 * `action` + `sandboxId` so a sig for one admin endpoint can't be replayed
 * against another, and the `chat`/`approval` sig spaces stay isolated from
 * admin operations. Pattern mirrors `chatMessageDigest` / `approvalResponseDigest`.
 *
 * `AdminAction` is a documentation-only union of actions currently accepted by
 * sandbox endpoints. The digest + verifier accept arbitrary strings (so
 * cross-action replay tests can sign non-existent actions); the allowlist is
 * enforced at the route layer in `server.ts`. Add new admin endpoints here so
 * call-site authors can grep for the canonical name.
 *
 *   - 'autotopup-tick'  → POST /admin/autotopup/tick
 *   - 'profile-key'     → POST /admin/profile-key
 *   - 'pairing-approve' → POST /admin/pairing/approve
 */
export type AdminAction = 'autotopup-tick' | 'profile-key' | 'pairing-approve'

export function adminTickDigest(opts: {
  action: AdminAction | string
  ts: number
  sandboxId: string
}): Uint8Array {
  return digestFields([
    { type: 'string', name: 'action', value: opts.action },
    { type: 'uint', name: 'ts', value: BigInt(opts.ts) },
    { type: 'string', name: 'sandboxId', value: opts.sandboxId },
  ])
}

export interface VerifyAdminTickOpts {
  action: AdminAction | string
  ts: number
  sandboxId: string
  signature: string
  expectedOperator: Address
  maxAgeMs?: number
  maxFutureMs?: number
  now?: number
}

export async function verifyAdminTickSig(opts: VerifyAdminTickOpts): Promise<VerifyResult> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000
  const maxFuture = opts.maxFutureMs ?? 60 * 1000
  if (opts.ts > now + maxFuture) return { ok: false, reason: 'ts-future' }
  if (opts.ts < now - maxAge) return { ok: false, reason: 'ts-stale' }

  const digest = adminTickDigest({
    action: opts.action,
    ts: opts.ts,
    sandboxId: opts.sandboxId,
  })
  return verifyOperatorSig(digest, opts.signature, opts.expectedOperator)
}

/**
 * Digest the operator signs for an approval response.
 */
export function approvalResponseDigest(opts: {
  approvalId: string
  decision: 'allow' | 'allow-session' | 'deny'
  ts: number
  sandboxId: string
}): Uint8Array {
  return digestFields([
    { type: 'string', name: 'approvalId', value: opts.approvalId },
    { type: 'string', name: 'decision', value: opts.decision },
    { type: 'uint', name: 'ts', value: BigInt(opts.ts) },
    { type: 'string', name: 'sandboxId', value: opts.sandboxId },
  ])
}

export interface VerifyApprovalOpts {
  approvalId: string
  decision: 'allow' | 'allow-session' | 'deny'
  ts: number
  sandboxId: string
  signature: string
  expectedOperator: Address
  maxAgeMs?: number
  maxFutureMs?: number
  now?: number
}

export async function verifyApprovalSig(opts: VerifyApprovalOpts): Promise<VerifyResult> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000
  const maxFuture = opts.maxFutureMs ?? 60 * 1000
  if (opts.ts > now + maxFuture) return { ok: false, reason: 'ts-future' }
  if (opts.ts < now - maxAge) return { ok: false, reason: 'ts-stale' }

  const digest = approvalResponseDigest({
    approvalId: opts.approvalId,
    decision: opts.decision,
    ts: opts.ts,
    sandboxId: opts.sandboxId,
  })
  return verifyOperatorSig(digest, opts.signature, opts.expectedOperator)
}
