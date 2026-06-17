import type { PairingStore } from 'lyra-core'
import type { TelegramInboundEvent } from './types'

/**
 * MVP filter: only DMs from authorized users are dispatched. Group chat,
 * channel posts, forwarded messages, and bot-to-bot messages are dropped.
 *
 * Authorization (hermes default-deny model):
 *  - If `allowedUserIds` contains the sender, accept.
 *  - Else if `pairingStore` is provided and the sender is approved, accept.
 *  - Else if `pairingStore` is provided, generate a pairing code and return
 *    `{ ok: false, action: 'send-pairing-code', code }` so the listener can
 *    DM the code to the sender. The operator approves out-of-band via
 *    `lyra pairing approve telegram <code>`.
 *  - Else (no allowlist + no pairing) reject with `no-allowlist-default-deny`.
 *
 * Returns null when the message should be dropped (with reason in debug logs).
 * Returns a normalized TelegramInboundEvent when accepted.
 */
export interface SanitizeOpts {
  allowedUserIds: number[]
  /** Hard cap on text length. Default 2000 chars (TG max is 4096). */
  maxTextLength?: number
  /** Optional pairing store. When present, unknown senders get a pairing code. */
  pairingStore?: Pick<PairingStore, 'isApproved' | 'generateCode'>
  /** Platform key passed to pairingStore (always 'telegram' for this plugin). */
  pairingPlatform?: string
}

export interface SanitizeInput {
  chatType: 'private' | 'group' | 'supergroup' | 'channel'
  chatId: number
  fromId: number | null
  fromIsBot: boolean
  fromUsername: string | null
  fromFirstName: string | null
  fromLastName: string | null
  text: string | null
  messageId: number
  forwardedFrom: unknown
  mediaGroupId: string | null
}

export type SanitizeResult =
  | { ok: true; event: TelegramInboundEvent }
  | {
      ok: false
      reason: SanitizeReason
      action?: 'send-pairing-code'
      code?: string
      pairedUserId?: number
      pairedUserName?: string | null
    }

export type SanitizeReason =
  | 'not-private-chat'
  | 'sender-is-bot'
  | 'sender-not-allowed'
  | 'no-allowlist-default-deny'
  | 'pairing-rate-limited'
  | 'forwarded-message'
  | 'no-text'
  | 'no-sender-id'
  | 'media-group'

export function sanitizeInbound(input: SanitizeInput, opts: SanitizeOpts): SanitizeResult {
  if (input.chatType !== 'private') return { ok: false, reason: 'not-private-chat' }
  if (input.fromIsBot) return { ok: false, reason: 'sender-is-bot' }
  if (input.fromId === null) return { ok: false, reason: 'no-sender-id' }
  if (input.forwardedFrom != null) return { ok: false, reason: 'forwarded-message' }
  if (input.mediaGroupId != null) return { ok: false, reason: 'media-group' }
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    return { ok: false, reason: 'no-text' }
  }

  const platform = opts.pairingPlatform ?? 'telegram'
  const inAllowlist = opts.allowedUserIds.includes(input.fromId)
  const pairingApproved = opts.pairingStore?.isApproved(platform, String(input.fromId)) ?? false

  if (!inAllowlist && !pairingApproved) {
    if (opts.pairingStore) {
      const code = opts.pairingStore.generateCode(
        platform,
        String(input.fromId),
        input.fromUsername ?? formatDisplayName(input.fromFirstName, input.fromLastName) ?? '',
      )
      if (code) {
        return {
          ok: false,
          reason: 'sender-not-allowed',
          action: 'send-pairing-code',
          code,
          pairedUserId: input.fromId,
          pairedUserName:
            input.fromUsername ?? formatDisplayName(input.fromFirstName, input.fromLastName),
        }
      }
      return { ok: false, reason: 'pairing-rate-limited' }
    }
    if (opts.allowedUserIds.length === 0) {
      return { ok: false, reason: 'no-allowlist-default-deny' }
    }
    return { ok: false, reason: 'sender-not-allowed' }
  }

  const cap = opts.maxTextLength ?? 2000
  let text = input.text
  if (text.length > cap) text = `${text.slice(0, cap)}\n[message truncated]`
  const displayName = formatDisplayName(input.fromFirstName, input.fromLastName)
  return {
    ok: true,
    event: {
      chatId: input.chatId,
      userId: input.fromId,
      username: input.fromUsername,
      displayName,
      text,
      messageId: input.messageId,
      ts: Date.now(),
    },
  }
}

function formatDisplayName(first: string | null, last: string | null): string | null {
  const parts = [first, last].filter((s): s is string => typeof s === 'string' && s.length > 0)
  if (parts.length === 0) return null
  return parts.join(' ')
}
