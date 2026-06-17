/**
 * lyra-plugin-telegram
 *
 * Long-poll Telegram bot listener. Operator DMs `@lyra_<name>_bot` from any
 * phone; the agent (running in Sui Sandbox or local) replies via the same
 * brain that handles stdin TUI turns.
 *
 * Required side-band ctx (`(ctx as any).telegram` field set by chat.tsx in
 * local mode or build-runtime.ts in sandbox mode):
 *
 *   - botToken, allowedUserIds, agentName
 *   - dispatchUserMessage: invoked per debounced inbound; runs brain.infer
 *   - onProcessingStart, onProcessingEnd: optional hooks for TUI surfacing
 *
 * Without `ctx.telegram`, the plugin registers nothing (graceful no-op for
 * unit-test loaders).
 */
import type { NativePlugin } from 'lyra-core'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FileLinkStore, deriveAgentAddress } from './link'
import { TelegramListener, type TelegramListenerOpts } from './listener'
import type { TelegramRuntimeContext } from './types'

export type {
  TelegramRuntimeContext,
  TelegramDispatchInput,
  TelegramDispatchResult,
  TelegramInboundEvent,
  TelegramToolEvent,
} from './types'
export { ProgressTracker, PROGRESS_EDIT_INTERVAL } from './progress'
export {
  TelegramListener,
  TELEGRAM_ALLOWED_UPDATES,
  capForTelegram,
  formatApprovalResolution,
} from './listener'
export { buildSessionKey, sanitizeAgentName } from './session-key'
export {
  formatTelegramChannel,
  formatInboundPreview,
  stripTelegramChannelEnvelope,
} from './format'
export { RateLimiter } from './limits'
export { sanitizeInbound, type SanitizeReason, type SanitizeResult } from './sanitize'
export { formatPairingMessage } from './pairing-flow'
export {
  ActiveSessionTracker,
  BYPASS_COMMANDS,
  parseBypassCommand,
  type ActiveSession,
  type BypassCommand,
  type ParsedBypass,
} from './session-state'
export { buildTelegramCommands, type TelegramBotCommand } from './commands'
export {
  type ApprovalChoice,
  APPROVAL_CALLBACK_PREFIX,
  buildApprovalKeyboard,
  handleApprovalCallback,
  makeApprovalIdFactory,
  parseCallbackData,
  type ParsedCallback,
  type ResolveOutcome,
} from './approval-keyboard'
export {
  escapeMarkdownV2,
  formatMarkdownV2,
  isMarkdownParseError,
  stripMarkdownV2,
} from './markdown'
export { escapeChunkSuffixForMarkdownV2, splitMessage, type SplitOpts } from './chunking'
export type { TelegramApprovalBridge, ApprovalChoiceKind } from './types'
export { DebounceBuffer } from './debounce'
export {
  sendWithRetry,
  classifyError,
  isRetryable,
  isTimeout,
  isReplyNotFound,
  isThreadNotFound,
  RETRYABLE_PATTERNS,
  TIMEOUT_PATTERNS,
  DELIVERY_FAILURE_NOTICE,
} from './retry'
export {
  acquireTelegramTokenLock,
  BotTokenLockedError,
  clearStaleTelegramTokenLock,
  clearWebhookBeforePolling,
  classifyStartFailure,
  TELEGRAM_TOKEN_LOCK_SCOPE,
  type StartFailure,
  type StartFailureKind,
  type TokenLock,
  type AcquireTokenLockOpts,
} from './recovery'
export {
  reactProcessing,
  reactSuccess,
  reactError,
  REACTION_PROCESSING,
  REACTION_OK,
  REACTION_ERR,
} from './reactions'
export { TELEGRAM_GUIDANCE } from './guidance'
export { startTypingLoop, TYPING_REFRESH_INTERVAL_MS } from './typing'
export {
  type OwnerLinkStore,
  FileLinkStore,
  InMemoryLinkStore,
  linkChallenge,
  verifyLink,
  startLink,
  completeLink,
  makeNonce,
} from './link'

const plugin: NativePlugin = {
  name: 'telegram',
  register: ctx => {
    const tg = (ctx as unknown as { telegram?: TelegramRuntimeContext }).telegram
    if (!tg) return
    // Enable Telegram↔owner-wallet linking when a master secret is configured:
    // /link + /verify bind a Telegram user to their owner wallet, and we resolve
    // owner → derived agent for display. Off (no behaviour change) otherwise.
    const master = process.env.LYRA_MASTER_SECRET
    if (master && master.length >= 32) {
      const root = process.env.LYRA_ROOT || join(homedir(), '.lyra')
      const opts = tg as TelegramListenerOpts
      opts.linkStore = new FileLinkStore(join(root, 'telegram-owners.json'))
      opts.resolveAgentAddress = (owner: string) => {
        try {
          return deriveAgentAddress(owner, master)
        } catch {
          return null
        }
      }
    }
    const listener = new TelegramListener(tg)
    ctx.registerListener({
      name: 'telegram-bot',
      start: async () => {
        await listener.start()
      },
      stop: async () => {
        await listener.stop()
      },
    } as never)
  },
}

export default plugin
