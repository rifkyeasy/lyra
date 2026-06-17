// Inline-keyboard approval for tool calls when the active session is on TG.
//
// Pattern from hermes telegram.py:1080-1132 (button layout) + 1462-1473
// (callback re-validation). 4 buttons in 2 rows: Once / Session / Always /
// Deny. Callback data format: `ea:<once|session|always|deny>:<approvalId>`.
//
// The handler re-validates the clicker against `allowedUserIds` because
// inline-keyboard buttons are visible to any chat-member but only authorized
// users may click. One-shot pop pattern: the resolver Map drops the entry
// after the first match so a stale double-click can't re-resolve.

import type { InlineKeyboardMarkup } from 'grammy/types'

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export const APPROVAL_CALLBACK_PREFIX = 'ea'

export function buildApprovalKeyboard(approvalId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Allow Once', callback_data: makeCallbackData('once', approvalId) },
        { text: '✅ Session', callback_data: makeCallbackData('session', approvalId) },
      ],
      [
        { text: '✅ Always', callback_data: makeCallbackData('always', approvalId) },
        { text: '❌ Deny', callback_data: makeCallbackData('deny', approvalId) },
      ],
    ],
  }
}

function makeCallbackData(choice: ApprovalChoice, approvalId: string): string {
  // 64-byte callback_data limit — approvalId must stay short. We use a
  // monotonic counter (e.g. `a-12345`) so well within budget.
  return `${APPROVAL_CALLBACK_PREFIX}:${choice}:${approvalId}`
}

export interface ParsedCallback {
  choice: ApprovalChoice
  approvalId: string
}

export function parseCallbackData(data: string | undefined): ParsedCallback | null {
  if (!data) return null
  const parts = data.split(':')
  if (parts.length !== 3) return null
  if (parts[0] !== APPROVAL_CALLBACK_PREFIX) return null
  const choice = parts[1]
  const approvalId = parts[2]
  if (
    !approvalId ||
    (choice !== 'once' && choice !== 'session' && choice !== 'always' && choice !== 'deny')
  ) {
    return null
  }
  return { choice: choice as ApprovalChoice, approvalId }
}

export type ResolveOutcome =
  | { kind: 'resolved'; approvalId: string; choice: ApprovalChoice; clicker: number }
  | { kind: 'unauthorized'; approvalId: string; clicker: number }
  | { kind: 'unknown-approval'; approvalId: string; clicker: number }
  | { kind: 'malformed' }

export interface HandleCallbackInput {
  callbackData: string | undefined
  fromUserId: number
  allowedUserIds: number[]
  pendingApprovals: Map<string, (choice: ApprovalChoice) => void>
}

/**
 * Decide what to do with a `callback_query`. The bot handler should call this
 * pure function then `answerCallbackQuery` based on the outcome.
 */
export function handleApprovalCallback(input: HandleCallbackInput): ResolveOutcome {
  const parsed = parseCallbackData(input.callbackData)
  if (!parsed) return { kind: 'malformed' }

  if (input.allowedUserIds.length > 0 && !input.allowedUserIds.includes(input.fromUserId)) {
    return { kind: 'unauthorized', approvalId: parsed.approvalId, clicker: input.fromUserId }
  }

  const resolver = input.pendingApprovals.get(parsed.approvalId)
  if (!resolver) {
    return { kind: 'unknown-approval', approvalId: parsed.approvalId, clicker: input.fromUserId }
  }

  // One-shot pop closes the race against double-clicks
  input.pendingApprovals.delete(parsed.approvalId)
  resolver(parsed.choice)
  return {
    kind: 'resolved',
    approvalId: parsed.approvalId,
    choice: parsed.choice,
    clicker: input.fromUserId,
  }
}

/**
 * Mint a new approval id. Monotonic counter as a string so callback_data
 * stays short. Caller seeds and increments.
 */
export function makeApprovalIdFactory(): () => string {
  let next = 1
  return () => `a-${next++}`
}
