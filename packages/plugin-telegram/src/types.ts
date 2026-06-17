import type { PairingStore } from 'lyra-core'

/**
 * Side-band runtime context for plugin-telegram. The CLI (chat.tsx, local
 * mode) or harness (build-runtime.ts, sandbox mode) builds this and attaches
 * it to the plugin context as `(ctx as any).telegram` before loadPlugins.
 *
 * Without this side-band, the plugin registers nothing (soft-init for unit
 * tests / non-telegram contexts). Mirrors the comms / onchain pattern.
 */
export interface TelegramRuntimeContext {
  /** Bot token from @BotFather, post-decryption. NEVER goes to activity log. */
  botToken: string
  /**
   * Telegram user IDs allowed to DM this bot. Anyone else's messages are
   * dropped silently (no reply, no reaction, no log entry beyond a debug line).
   */
  allowedUserIds: number[]
  /**
   * Agent's display name (e.g. "specter", "enigma"). Used in session-key
   * formatting so each agent's TG context is distinct in the brain prompt.
   */
  agentName: string
  /**
   * Brain dispatch callback. The listener invokes this when a debounced inbound
   * is ready. The CLI or harness implementation:
   *   1. wraps `text` in a `<channel source="telegram" ...>` prompt fragment
   *   2. fires brain.infer with `source: 'telegram'`
   *   3. flushes per-turn sync
   *   4. returns the assistant string for the listener to send back via TG
   */
  dispatchUserMessage: (input: TelegramDispatchInput) => Promise<TelegramDispatchResult>
  /** Optional hook fired before reaction transitions to 👀. CLI may push a TUI row. */
  onProcessingStart?: (chatId: number, messageId: number) => Promise<void> | void
  /** Optional hook fired after reaction transitions to 👍/👎. */
  onProcessingEnd?: (chatId: number, messageId: number, ok: boolean) => Promise<void> | void
  /** Verbose grammy logs. Default false. */
  debug?: boolean
  /**
   * Optional pairing store. When present, unknown senders get a pairing code
   * via DM and the operator approves via `lyra pairing approve telegram <code>`.
   * When absent, the listener uses static allowlist only (default-deny on empty).
   */
  pairingStore?: PairingStore
  /**
   * Optional approval bridge. When present, the listener fills the inner
   * `sendApproval` + `installCallbackHandler` slots on start so chat-telegram
   * (or the harness build-runtime in sandbox mode) can swap a TG-side
   * permission prompter at the start of a turn. When absent, the local TUI
   * modal handles all approvals as before.
   */
  approvalBridge?: TelegramApprovalBridge
  /**
   * v0.24.12: outbound slot the listener fills on `start()` with a method
   * that broadcasts a short text to every allowed operator chat. The
   * gateway uses it to forward unsolicited brain prompts (clarify on
   * autonomous market wakes) when no TUI is connected. When absent, the
   * gateway logs the question to activity-log only.
   */
  operatorNotifier?: OperatorNotifierSlot
}

/** Mutable slot the listener fills on start so the gateway can broadcast clarify questions. */
export interface OperatorNotifierSlot {
  current: ((text: string) => Promise<void>) | null
}

export type ApprovalChoiceKind = 'once' | 'session' | 'always' | 'deny'

/**
 * Mutable bridge object created by the dispatcher (chat-telegram or
 * harness/build-runtime) and filled by the listener on start. The dispatcher
 * holds the resolver Map; the listener holds the bot. They cooperate via this
 * bridge so the inline-keyboard approval can roundtrip TG → brain → TG.
 */
export interface TelegramApprovalBridge {
  /** Filled by listener.start(). Sends the approval inline keyboard. */
  sendApproval: {
    current: ((chatId: number, text: string, approvalId: string) => Promise<void>) | null
  }
  /**
   * Filled by listener.start(). Lets the dispatcher install a single
   * callback_query handler that the listener fans out per click. Returns
   * an unregister function.
   */
  installCallbackHandler: {
    current:
      | ((
          handler: (approvalId: string, choice: ApprovalChoiceKind, fromUserId: number) => void,
        ) => () => void)
      | null
  }
}

/** Tool-call lifecycle event observed by the TG dispatcher for live UI rendering. */
export interface TelegramToolEvent {
  kind: 'start' | 'end'
  tool: string
  callId: string
  argsPreview?: string
  ok?: boolean
}

export interface TelegramDispatchInput {
  /** Composed text after debounce flush; safe to feed into brain prompt. */
  text: string
  /** TG numeric chat id (== user id for 1-on-1 DMs). */
  chatId: number
  /** TG numeric user id of the sender (always in `allowedUserIds`). */
  userId: number
  /** Display username of the sender (no `@` prefix), or null if unset. */
  username: string | null
  /** Display first/last name of the sender, or null. */
  displayName: string | null
  /** TG message id of the LATEST fragment in the debounced burst. Used for reactions. */
  latestMessageId: number
  /** Stable session key for this chat: `agent:<name>:telegram:dm:<chatId>`. */
  sessionKey: string
  /**
   * Per-turn observer of tool-call lifecycle. Listener supplies this so it
   * can stream progress to a TG message as the brain works through the turn.
   * Dispatch implementation (chat-telegram.ts in local mode, build-runtime.ts
   * in sandbox mode) must forward this to `brain.infer({ onToolEvent: ... })`.
   * Errors swallowed; observer must NEVER block dispatch.
   */
  onToolEvent?: (ev: TelegramToolEvent) => void
}

export interface TelegramDispatchResult {
  /** Assistant text to echo back to the user. Empty string skips the reply. */
  response: string
  /** Optional Sui mainnet sync tx hash, surfaced as a footer if non-empty. */
  syncTx?: string
}

export interface TelegramInboundEvent {
  chatId: number
  userId: number
  username: string | null
  displayName: string | null
  text: string
  messageId: number
  ts: number
}
