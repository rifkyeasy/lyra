/**
 * Local persistence for telegram bot secrets, encrypted via the operator's
 * sign-derived AEAD key (scope `OPERATOR_BLOB_SCOPES.TELEGRAM`).
 *
 * On-disk file: `~/.nebula/agents/<id>/telegram-secrets.encrypted`
 *
 *   {
 *     version: 2,
 *     scope: 'nebula-telegram-v1',
 *     blob: <base64(iv|tag|ciphertext)>,
 *   }
 *
 * Plaintext shape inside the blob:
 *
 *   {
 *     botToken: string,         // from @BotFather
 *     botUsername?: string,     // cached at setup-time getMe
 *     botId?: number,           // cached at setup-time getMe
 *     allowedUserIds: number[],
 *   }
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  OPERATOR_BLOB_SCOPES,
  type OperatorEncryptedBlob,
  type OperatorSigner,
  agentPaths,
  decodeOperatorBlobBytes,
  decryptOperatorBlob,
  encodeOperatorBlobBytes,
  encryptOperatorBlob,
} from 'nebula-ai-core'
import type { Address } from 'viem'

export interface TelegramSecretsPlaintext {
  botToken: string
  botUsername?: string
  botId?: number
  allowedUserIds: number[]
}

/**
 * Subset of `TelegramSecretsPlaintext` that the CLI ships into the harness
 * provision envelope on init / upgrade / resume. The harness doesn't need
 * the operator-side metadata (`botUsername`, `botId`); it only needs the
 * token + allowlist + optional pairing list. Centralising this as a named
 * type avoids drift between the four CLI handoff sites that previously
 * inlined the literal shape (init wizard, upgrade, resume, the
 * `HandoffAgentToGateway` + `ResumeArchivedSandbox` interfaces).
 */
export interface TelegramHandoffSecrets {
  botToken: string
  allowedUserIds: number[]
  pairingApproved?: number[]
}

export function telegramSecretsPath(agentId: string): string {
  return join(agentPaths.agent(agentId).dir, 'telegram-secrets.encrypted')
}

export function telegramSecretsExist(agentId: string): boolean {
  return existsSync(telegramSecretsPath(agentId))
}

export async function loadTelegramSecrets(opts: {
  signer: OperatorSigner
  agentAddress: Address
  agentId: string
}): Promise<TelegramSecretsPlaintext | null> {
  const path = telegramSecretsPath(opts.agentId)
  if (!existsSync(path)) return null
  const fileBytes = await readFile(path)
  const blob: OperatorEncryptedBlob = decodeOperatorBlobBytes(new Uint8Array(fileBytes))
  const ptBytes = await decryptOperatorBlob({
    signer: opts.signer,
    scope: OPERATOR_BLOB_SCOPES.TELEGRAM,
    agentAddress: opts.agentAddress,
    blob,
  })
  const parsed = JSON.parse(new TextDecoder().decode(ptBytes)) as TelegramSecretsPlaintext
  if (typeof parsed.botToken !== 'string' || !Array.isArray(parsed.allowedUserIds)) {
    throw new Error('telegram-secrets: malformed plaintext (missing botToken or allowedUserIds)')
  }
  return parsed
}

/**
 * Load + project telegram secrets into the shape the gateway provision envelope
 * expects. Used by every sandbox-handoff flow that ships TG (init/upgrade/
 * resume/deploy/chat-sandbox auto-resume); centralises the try/decrypt/swallow
 * pattern so future TG-secret schema changes touch one place.
 *
 * Errors are non-fatal: TG is opt-in. Failure fires `onNotice` (so the operator
 * sees the reason in the spinner) and returns undefined.
 *
 * `chat.tsx` keeps its own loader because it needs the full plaintext (including
 * `botUsername` for the unlock spinner UX).
 */
export async function loadTelegramHandoffSecrets(opts: {
  signer: OperatorSigner
  agentAddress: Address
  agentId: string
  onNotice?: (msg: string) => void
}): Promise<TelegramHandoffSecrets | undefined> {
  const agentId = opts.agentId
  try {
    const tg = await loadTelegramSecrets({
      signer: opts.signer,
      agentAddress: opts.agentAddress,
      agentId,
    })
    if (!tg) return undefined
    return { botToken: tg.botToken, allowedUserIds: tg.allowedUserIds }
  } catch (err) {
    opts.onNotice?.(`telegram secrets read failed: ${(err as Error).message.slice(0, 120)}`)
    return undefined
  }
}

export async function saveTelegramSecrets(opts: {
  signer: OperatorSigner
  agentAddress: Address
  agentId: string
  plaintext: TelegramSecretsPlaintext
  /**
   * v0.24.3: pre-derived TELEGRAM scope key (32 bytes). The init wizard
   * derives this once and passes it both here AND into `.operator-session`,
   * so encryptOperatorBlob skips the redundant sign it would otherwise make.
   * Threads through to encryptOperatorBlob; see that helper for fallback.
   */
  precomputedKey?: Buffer
}): Promise<void> {
  const path = telegramSecretsPath(opts.agentId)
  await mkdir(dirname(path), { recursive: true })
  const ptBytes = new TextEncoder().encode(JSON.stringify(opts.plaintext))
  const blob = await encryptOperatorBlob({
    signer: opts.signer,
    scope: OPERATOR_BLOB_SCOPES.TELEGRAM,
    agentAddress: opts.agentAddress,
    plaintext: ptBytes,
    precomputedKey: opts.precomputedKey,
  })
  await writeFile(path, encodeOperatorBlobBytes(blob))
}

export async function removeTelegramSecrets(agentId: string): Promise<boolean> {
  const path = telegramSecretsPath(agentId)
  if (!existsSync(path)) return false
  await rm(path, { force: true })
  return true
}

const BOT_TOKEN_RE = /^\d{6,15}:[A-Za-z0-9_-]{30,}$/

export function looksLikeBotToken(s: string): boolean {
  return BOT_TOKEN_RE.test(s.trim())
}

export interface ValidatedBotInfo {
  id: number
  username: string
  firstName: string
}

/**
 * Telegram Bot API getMe — cheap, free, no message side-effect. Used by
 * `nebula telegram setup` to validate the token before persisting it AND by
 * `nebula telegram status` to confirm the stored token still works.
 *
 * Throws on non-200 / `ok: false` with a clean error message; caller wraps
 * the throw in a clack spinner.stop().
 */
export async function fetchBotInfo(
  botToken: string,
  opts?: { signal?: AbortSignal },
): Promise<ValidatedBotInfo> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`
  const res = await fetch(url, { signal: opts?.signal })
  if (!res.ok) {
    throw new Error(`getMe HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const body = (await res.json()) as {
    ok: boolean
    description?: string
    result?: { id: number; username?: string; first_name?: string }
  }
  if (!body.ok || !body.result) {
    throw new Error(`getMe rejected: ${body.description ?? 'unknown error'}`)
  }
  if (!body.result.username) throw new Error('bot has no username; create one in @BotFather')
  return {
    id: body.result.id,
    username: body.result.username,
    firstName: body.result.first_name ?? body.result.username,
  }
}

export function parseAllowedUserIds(
  input: string,
): { ok: true; ids: number[] } | { ok: false; reason: string } {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { ok: true, ids: [] }
  const parts = trimmed
    .split(/[,\s]+/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
  const ids: number[] = []
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return { ok: false, reason: `not a numeric id: "${p}"` }
    const n = Number(p)
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: `not a positive id: "${p}"` }
    ids.push(n)
  }
  // Dedupe, preserve first-seen order.
  return { ok: true, ids: [...new Set(ids)] }
}
