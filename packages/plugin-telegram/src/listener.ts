import { Bot, type Context, GrammyError, HttpError } from 'grammy'
import { type ApprovalChoice, parseCallbackData } from './approval-keyboard'
import { escapeChunkSuffixForMarkdownV2, splitMessage } from './chunking'
import { buildTelegramCommands } from './commands'
import { DebounceBuffer, type FlushedBatch } from './debounce'
import { formatTelegramChannel } from './format'
import { RateLimiter } from './limits'
import { type OwnerLinkStore, completeLink, startLink } from './link'
import { formatMarkdownV2, isMarkdownParseError, stripMarkdownV2 } from './markdown'
import { formatPairingMessage } from './pairing-flow'
import { ProgressTracker } from './progress'
import { reactError, reactProcessing, reactSuccess } from './reactions'
import {
  BotTokenLockedError,
  TELEGRAM_TOKEN_LOCK_SCOPE,
  type TokenLock,
  acquireTelegramTokenLock,
  classifyStartFailure,
  clearWebhookBeforePolling,
} from './recovery'
import { DELIVERY_FAILURE_NOTICE, sendWithRetry } from './retry'
import { sanitizeInbound } from './sanitize'
import { buildSessionKey } from './session-key'
import type { TelegramDispatchInput, TelegramRuntimeContext } from './types'
import { startTypingLoop } from './typing'

/**
 * Long-poll Telegram bot. Inbound DMs from allowedUserIds are debounced and
 * dispatched to the brain via `dispatchUserMessage`. Reactions transition
 * from 👀 (processing) → 👍/👎 (success/error). Reply text is sent back via
 * grammy's `bot.api.sendMessage` with retry-classified backoff.
 *
 * Lifecycle: `start()` acquires a host-wide token lock, clears any stale
 * webhook, then boots grammy in long-poll mode. `stop()` releases the lock
 * and stops the bot. Both are idempotent.
 */
/** Retry cadence + cap when the TG bot-token lock is held by a (possibly
 *  zombie) prior holder. 12 × 30s = 6 minutes, comfortably past the 5-minute
 *  lock TTL so a stale-but-tenable lock auto-evicts. */
const RETRY_INTERVAL_MS = 30_000
const MAX_LOCK_RETRY_ATTEMPTS = 12

/**
 * Map an `ApprovalChoice` to the human-readable resolution label appended
 * to the approval message after a click. Mirrors the keyboard labels so
 * operators see the same wording in the resolved message that they tapped.
 */
export function formatApprovalResolution(choice: ApprovalChoice, byUserId: number): string {
  const label =
    choice === 'once'
      ? '✅ Allowed once'
      : choice === 'session'
        ? '✅ Allowed for session'
        : choice === 'always'
          ? '✅ Always allowed'
          : '❌ Denied'
  return `${label} (by ${byUserId})`
}

/**
 * Update kinds we ask Telegram to deliver via long-poll.
 *
 * `'message'` covers inbound DMs we dispatch to the brain. `'callback_query'`
 * covers inline-keyboard taps (the [Allow Once / Session / Always / Deny]
 * buttons rendered for tool approvals). Without `'callback_query'` here,
 * Telegram silently filters the click events out of `getUpdates`, the
 * `bot.on('callback_query:data', ...)` handler never fires, and operator
 * taps register on the device but never reach the harness — the modal
 * appears stuck and the brain's tool call hangs until timeout.
 *
 * Latent bug from v0.18.0 (the introduction of inline-keyboard approvals);
 * v0.19.10 fixed handler registration but not the polling spec, which is
 * why no live drive caught it before v0.19.18.
 */
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query'] as const

export interface TelegramListenerOpts extends TelegramRuntimeContext {
  /** Optional override of the Telegram Bot API root. Used by the mock-bot test. */
  apiRoot?: string
  /** Optional per-user rate-limit. Default capacity=30, window=60s. */
  rateLimit?: { capacity: number; windowMs: number }
  /** Optional debounce window. Default 600ms. */
  debounceMs?: number
  /** Optional override of the locks dir (test only). */
  lockRootDir?: string
  /**
   * Optional Telegram↔owner-wallet link store. When present, `/link` + `/verify`
   * let a user prove wallet ownership (Sign-In-with-Sui style) and bind their
   * Telegram account to their Lyra owner address. Unset → linking is disabled
   * and these commands fall through to normal dispatch (no behaviour change).
   */
  linkStore?: OwnerLinkStore
  /** Optional resolver: owner address → their derived agent address (for display). */
  resolveAgentAddress?: (owner: string) => string | null
}

export class TelegramListener {
  private readonly opts: TelegramListenerOpts
  private readonly bot: Bot
  private readonly limiter: RateLimiter
  private readonly debounce: DebounceBuffer
  private readonly inflight = new Map<number, Promise<void>>()
  private running = false
  private tokenLock: TokenLock | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempts = 0
  private stopped = false
  private approvalResolver:
    | ((approvalId: string, choice: ApprovalChoice, fromUserId: number) => void)
    | null = null

  constructor(opts: TelegramListenerOpts) {
    this.opts = opts
    this.bot = new Bot(opts.botToken, opts.apiRoot ? { client: { apiRoot: opts.apiRoot } } : {})
    this.limiter = new RateLimiter(opts.rateLimit)
    this.debounce = new DebounceBuffer((chatId, batch) => this.handleFlushed(chatId, batch), {
      quietPeriodMs: opts.debounceMs,
    })
    this.bot.on('message', ctx => this.onMessage(ctx))
    // Register callback_query handler at construction time. grammY rejects
    // late `bot.on()` registration once polling starts, so any approval
    // resolver wiring must happen via the `approvalResolver` slot, not by
    // calling `bot.on()` again. See approvalBridge.installCallbackHandler.
    this.bot.on('callback_query:data', ctx => this.handleCallbackQuery(ctx))
    this.bot.catch(err => {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`grammy.catch: ${msg.slice(0, 200)}`)
    })
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const q = ctx.callbackQuery
    if (!q) return
    console.log(
      `[telegram] callback_query received from user=${q.from.id} data=${(q.data ?? '').slice(0, 80)}`,
    )
    const parsed = parseCallbackData(q.data)
    if (!parsed) {
      console.log(
        `[telegram] callback_query dropped: malformed data=${(q.data ?? '').slice(0, 80)}`,
      )
      try {
        await ctx.answerCallbackQuery({ text: 'malformed approval callback' })
      } catch {
        /* ignore */
      }
      return
    }
    if (this.opts.allowedUserIds.length > 0 && !this.opts.allowedUserIds.includes(q.from.id)) {
      console.log(
        `[telegram] callback_query dropped: unauthorized user=${q.from.id} (allowlist=${this.opts.allowedUserIds.join(',')})`,
      )
      try {
        await ctx.answerCallbackQuery({ text: '⛔ You are not authorized to approve commands.' })
      } catch {
        /* ignore */
      }
      return
    }
    const resolver = this.approvalResolver
    if (!resolver) {
      console.log(
        `[telegram] callback_query dropped: no resolver pending for approval=${parsed.approvalId} choice=${parsed.choice}`,
      )
      try {
        await ctx.answerCallbackQuery({ text: 'no approval pending' })
      } catch {
        /* ignore */
      }
      return
    }
    console.log(
      `[telegram] callback_query resolved: approval=${parsed.approvalId} choice=${parsed.choice} from=${q.from.id}`,
    )
    resolver(parsed.approvalId, parsed.choice, q.from.id)
    try {
      await ctx.answerCallbackQuery({ text: `✓ ${parsed.choice}` })
    } catch {
      /* ignore */
    }
    // Resolve the modal visually: append the choice + drop the inline
    // keyboard. Without this, every clicked approval message stays on
    // screen with all four buttons, leaving operators unsure whether
    // their tap registered. Best-effort — if the edit fails (rate
    // limit, message age, deleted), the underlying approval is still
    // resolved at the runtime level, so we swallow the error.
    const originalText =
      typeof q.message?.text === 'string' && q.message.text.length > 0 ? q.message.text : null
    const suffix = formatApprovalResolution(parsed.choice, q.from.id)
    try {
      if (originalText) {
        await ctx.editMessageText(`${originalText}\n\n${suffix}`, { reply_markup: undefined })
      } else {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined })
      }
    } catch {
      /* ignore — modal was clicked, runtime already resolved; keyboard cleanup is cosmetic */
    }
  }

  async start(): Promise<void> {
    if (this.running || this.stopped) return

    try {
      this.tokenLock = acquireTelegramTokenLock(this.opts.botToken, {
        agentId: this.opts.agentName,
        rootDir: this.opts.lockRootDir,
      })
    } catch (err) {
      // Lock contention is recoverable: the prior holder may be a zombie or
      // a stale lockfile from an ungraceful exit (see
      // feedback-tg-token-lock-zombie-after-upgrade.md). Retry every 30s up
      // to 12 attempts (6 minutes, past the 5-minute lock TTL) so we
      // eventually reclaim once the existing entry expires. Without this,
      // a single failed lock acquisition silenced the bot for the entire
      // harness lifetime.
      if (err instanceof BotTokenLockedError) {
        console.warn(
          `[telegram] cannot start listener: ${err.message}; will retry in ${RETRY_INTERVAL_MS / 1000}s`,
        )
        this.scheduleStartRetry()
        return
      }
      throw err
    }

    this.retryAttempts = 0
    this.running = true
    console.log(`[telegram] listener.start() called for @${this.opts.agentName}`)

    if (this.opts.allowedUserIds.length === 0 && !this.opts.pairingStore) {
      console.warn(
        '[telegram] no allowlist configured AND no pairing store. ' +
          'All inbound messages will be DROPPED. Configure allowedUserIds via ' +
          '`lyra telegram setup` or enable pairing.',
      )
    }

    // Wire approval bridge if the dispatcher provided one. The bridge has two
    // slots: sendApproval (we fill with a closure over this.bot) and
    // installCallbackHandler (we fill with a registrar over bot.on('callback_query')).
    if (this.opts.approvalBridge) {
      this.opts.approvalBridge.sendApproval.current = (chatId, text, approvalId) =>
        this.sendApprovalMessage(chatId, text, approvalId)
      this.opts.approvalBridge.installCallbackHandler.current = handler =>
        this.installCallbackHandler(handler)
    }

    // v0.24.12: operator-notifier slot. Gateway fills it with brain clarify
    // questions on autonomous market wakes; we broadcast to every allowed
    // chat so the operator sees the question on their phone when no TUI is
    // attached.
    if (this.opts.operatorNotifier) {
      this.opts.operatorNotifier.current = text => this.notifyOperators(text)
    }

    await clearWebhookBeforePolling(this.bot)

    // v0.20.0: register the bot command menu so Telegram clients show
    // the autocomplete list when the operator types `/`. Sourced from the
    // shared registry; safe to call repeatedly (Telegram dedupes).
    try {
      await this.bot.api.setMyCommands(buildTelegramCommands(), {
        scope: { type: 'default' },
      })
    } catch (err) {
      console.warn(
        `[telegram] setMyCommands failed (non-fatal): ${(err as Error).message?.slice(0, 200) ?? 'unknown'}`,
      )
    }

    this.refreshTimer = setInterval(() => {
      if (this.tokenLock && !this.tokenLock.refresh()) {
        console.warn('[telegram] token lock lost - stopping listener')
        void this.stop()
      }
    }, 60_000)

    void this.bot
      .start({
        onStart: info => console.log(`[telegram] listener active @${info.username}`),
        drop_pending_updates: true,
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      })
      .catch(err => {
        const verdict = classifyStartFailure(err)
        console.error(`[telegram] bot.start ${verdict.kind}: ${verdict.detail.slice(0, 400)}`)
        this.running = false
        this.releaseLock()
      })
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.opts.operatorNotifier) this.opts.operatorNotifier.current = null
    if (!this.running) {
      this.releaseLock()
      return
    }
    this.running = false
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.debounce.flushAll()
    try {
      await this.bot.stop()
    } catch {
      // grammy stop can throw if start hasn't completed; ignore.
    }
    await Promise.allSettled([...this.inflight.values()])
    this.releaseLock()
  }

  /**
   * v0.24.12: broadcast a short text to every allowed operator chat. Used
   * by the gateway to forward unsolicited brain prompts (clarify on
   * autonomous market wakes) when no TUI is connected. Best-effort: per-chat
   * failures are logged but don't stop the broadcast.
   */
  private async notifyOperators(text: string): Promise<void> {
    if (!this.running) return
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const body = trimmed.length > 3500 ? `${trimmed.slice(0, 3500)}\n[truncated]` : trimmed
    await Promise.allSettled(
      this.opts.allowedUserIds.map(async chatId => {
        try {
          await this.bot.api.sendMessage(chatId, body)
        } catch (err) {
          console.warn(
            `[telegram] notifyOperators chat=${chatId} failed: ${(err as Error).message?.slice(0, 200) ?? 'unknown'}`,
          )
        }
      }),
    )
  }

  private scheduleStartRetry(): void {
    if (this.stopped) return
    if (this.retryAttempts >= MAX_LOCK_RETRY_ATTEMPTS) {
      console.error(
        `[telegram] gave up acquiring bot-token lock after ${this.retryAttempts} attempts; manual intervention required (rm ~/.lyra/locks/${TELEGRAM_TOKEN_LOCK_SCOPE}-*.lock)`,
      )
      return
    }
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryAttempts += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.start()
    }, RETRY_INTERVAL_MS)
    this.retryTimer.unref?.()
  }

  private releaseLock(): void {
    if (this.tokenLock) {
      try {
        this.tokenLock.release()
      } catch {
        /* best-effort */
      }
      this.tokenLock = null
    }
  }

  /** Send the inline-keyboard approval message. Used by the approval bridge. */
  private async sendApprovalMessage(
    chatId: number,
    body: string,
    approvalId: string,
  ): Promise<void> {
    const { buildApprovalKeyboard } = await import('./approval-keyboard')
    await sendWithRetry(() =>
      this.bot.api.sendMessage(chatId, body, {
        reply_markup: buildApprovalKeyboard(approvalId),
      }),
    )
  }

  /**
   * Register the caller's approval resolver. The actual `bot.on('callback_query:data', ...)`
   * middleware is installed once in the constructor (grammY rejects late
   * registration after polling starts, so we cannot wire the handler lazily
   * inside a dispatch turn). This method just swaps the resolver slot the
   * pre-installed handler reads from. Returns a no-op uninstaller for
   * back-compat with the previous API; teardown happens via `bot.stop()`.
   */
  private installCallbackHandler(
    onResolve: (approvalId: string, choice: ApprovalChoice, fromUserId: number) => void,
  ): () => void {
    this.approvalResolver = onResolve
    return () => {
      this.approvalResolver = null
    }
  }

  /**
   * Handle one inbound TG update. Sanitize → rate-limit → debounce.
   * Errors here are swallowed (logged) so grammy stays alive.
   */
  /**
   * Handle the Telegram↔owner-wallet link commands. Returns true when the message
   * was a link command (and was handled), false to fall through to dispatch.
   *   /link            → issue a challenge to sign with your Sui wallet
   *   /verify <sig>    → bind the recovered owner to this Telegram account
   *   /whoami          → show the linked owner + their agent
   */
  private async maybeHandleLink(ctx: Context, userId: number, text: string): Promise<boolean> {
    const store = this.opts.linkStore as OwnerLinkStore
    const reply = (t: string) => ctx.reply(t).catch(() => {})

    if (text === '/link') {
      const challenge = await startLink(store, userId)
      await reply(
        `Link your wallet: sign this message with your Sui wallet, then send\n/verify <signature>\n\n— message to sign —\n${challenge}`,
      )
      return true
    }
    if (text.startsWith('/verify')) {
      const sig = text.slice('/verify'.length).trim()
      if (!sig) {
        await reply('Usage: /verify <signature>. Send /link first to get the message to sign.')
        return true
      }
      const owner = await completeLink(store, userId, sig)
      if (!owner) {
        await reply('Could not verify that signature — run /link again and sign the exact message.')
        return true
      }
      const agent = this.opts.resolveAgentAddress?.(owner) ?? null
      await reply(
        `✓ Linked to owner ${owner.slice(0, 10)}…${owner.slice(-6)}${agent ? `\nYour agent: ${agent.slice(0, 12)}…` : ''}`,
      )
      return true
    }
    if (text === '/whoami') {
      const owner = await store.getOwner(userId)
      if (!owner) {
        await reply('Not linked yet. Send /link to bind your Sui wallet.')
        return true
      }
      const agent = this.opts.resolveAgentAddress?.(owner) ?? null
      await reply(`owner ${owner.slice(0, 10)}…${owner.slice(-6)}\nagent ${agent ? `${agent.slice(0, 12)}…` : '(not resolved)'}`)
      return true
    }
    return false
  }

  private async onMessage(ctx: Context): Promise<void> {
    const msg = ctx.message
    if (!msg) return
    // Wallet linking is self-serve (handled before the allowedUserIds gate so a
    // new owner can prove ownership). Only active when a link store is wired.
    if (this.opts.linkStore && msg.from?.id && typeof msg.text === 'string') {
      const handled = await this.maybeHandleLink(ctx, msg.from.id, msg.text.trim())
      if (handled) return
    }
    const sanitized = sanitizeInbound(
      {
        chatType: msg.chat.type,
        chatId: msg.chat.id,
        fromId: msg.from?.id ?? null,
        fromIsBot: msg.from?.is_bot ?? false,
        fromUsername: msg.from?.username ?? null,
        fromFirstName: msg.from?.first_name ?? null,
        fromLastName: msg.from?.last_name ?? null,
        text: msg.text ?? msg.caption ?? null,
        messageId: msg.message_id,
        forwardedFrom:
          (msg as { forward_from?: unknown; forward_origin?: unknown }).forward_from ??
          (msg as { forward_origin?: unknown }).forward_origin ??
          null,
        mediaGroupId: msg.media_group_id ?? null,
      },
      {
        allowedUserIds: this.opts.allowedUserIds,
        pairingStore: this.opts.pairingStore,
      },
    )
    if (!sanitized.ok) {
      if (sanitized.action === 'send-pairing-code' && sanitized.code) {
        const text = formatPairingMessage({
          code: sanitized.code,
          agentName: this.opts.agentName,
        })
        try {
          await this.bot.api.sendMessage(msg.chat.id, text)
        } catch (sendErr) {
          this.log(`pairing-code send failed: ${(sendErr as Error).message?.slice(0, 200) ?? ''}`)
        }
      }
      this.log(`drop: ${sanitized.reason} from chat=${msg.chat.id}`)
      return
    }
    const event = sanitized.event
    if (this.limiter.shouldDrop(event.userId)) {
      this.log(`rate-limit-drop user=${event.userId}`)
      void reactError(this.bot, event.chatId, event.messageId)
      return
    }
    this.debounce.push(event.chatId, {
      text: event.text,
      messageId: event.messageId,
      ts: event.ts,
      userId: event.userId,
      username: event.username,
      displayName: event.displayName,
    })
  }

  private handleFlushed(chatId: number, batch: FlushedBatch): void {
    const existing = this.inflight.get(chatId)
    const next = (existing ?? Promise.resolve()).then(() => this.dispatchOne(chatId, batch))
    this.inflight.set(
      chatId,
      next.finally(() => {
        if (this.inflight.get(chatId) === next) this.inflight.delete(chatId)
      }),
    )
  }

  private async dispatchOne(chatId: number, batch: FlushedBatch): Promise<void> {
    const messageId = batch.latestMessageId
    void reactProcessing(this.bot, chatId, messageId)
    if (this.opts.onProcessingStart) {
      try {
        await this.opts.onProcessingStart(chatId, messageId)
      } catch {
        /* never block on hook failures */
      }
    }
    // Show "typing..." in the chat header for the duration of the brain turn.
    // TG's chat action expires after ~5s, so the loop refreshes on a 4.5s
    // interval. Cancel via try/finally so it stops in both happy and error
    // paths. See `typing.ts` for the cancel-fn pattern.
    const stopTyping = startTypingLoop(this.bot, chatId)
    // Tool-call progress message: hermes-style scratch message that gets
    // edited as the brain progresses through tools. See `progress.ts`.
    // Always created; the tracker only sends a message when the brain
    // actually fires a tool event, so prompts that go straight to a
    // text answer don't get a noisy progress preamble.
    const tracker = new ProgressTracker(this.bot, chatId)
    let ok = true
    try {
      const input: TelegramDispatchInput = {
        text: batch.text,
        chatId,
        userId: batch.userId,
        username: batch.username,
        displayName: batch.displayName,
        latestMessageId: messageId,
        sessionKey: buildSessionKey({ agentName: this.opts.agentName, chatId }),
        onToolEvent: ev => {
          void tracker.push(ev)
        },
      }
      const channelText = formatTelegramChannel({
        chatId,
        username: batch.username,
        displayName: batch.displayName,
        text: batch.text,
      })
      const result = await this.opts.dispatchUserMessage({ ...input, text: channelText })
      const reply = result.response.trim()
      if (reply.length > 0) {
        await this.sendChunked(chatId, reply, messageId)
      }
      void reactSuccess(this.bot, chatId, messageId)
    } catch (err) {
      ok = false
      const msg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error && err.stack ? `\n${err.stack}` : ''
      console.error(`[telegram] dispatch failed: ${msg.slice(0, 500)}${stack}`)
      void reactError(this.bot, chatId, messageId)
      // Translate LedgerInsufficientError into an actionable topup hint
      // instead of the generic "something went wrong" reply. Detect by
      // name (avoids requiring the plugin to import core's typed class).
      const isLedger = err instanceof Error && err.name === 'LedgerInsufficientError'
      const replyText = isLedger
        ? `⚠️ I need a top-up to keep working.\n\n${msg}`
        : 'sorry, something went wrong on my side. try again in a moment.'
      try {
        await this.bot.api.sendMessage(chatId, replyText, {
          reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
        })
      } catch {
        /* swallow */
      }
    } finally {
      // Flush any pending throttled progress edit before clearing the
      // typing loop. finalize() is idempotent, swallows errors, and is safe
      // even if the tracker never rendered anything.
      await tracker.finalize().catch(() => {})
      stopTyping()
    }
    if (this.opts.onProcessingEnd) {
      try {
        await this.opts.onProcessingEnd(chatId, messageId, ok)
      } catch {
        /* never block */
      }
    }
  }

  /**
   * Send a (possibly long) reply with MarkdownV2 + chunking. Falls back to
   * plain-text on parse_error. On retry exhaustion, sends the delivery-failure
   * notice. First chunk is reply-linked; subsequent chunks are not.
   */
  private async sendChunked(chatId: number, body: string, replyToMessageId: number): Promise<void> {
    const chunks = splitMessage(body)
    let firstSend = true
    for (const chunk of chunks) {
      const md = escapeChunkSuffixForMarkdownV2(formatMarkdownV2(chunk))
      try {
        await sendWithRetry(() =>
          this.bot.api.sendMessage(chatId, md, {
            parse_mode: 'MarkdownV2',
            reply_parameters: firstSend
              ? { message_id: replyToMessageId, allow_sending_without_reply: true }
              : undefined,
          }),
        )
      } catch (err) {
        if (isMarkdownParseError(err)) {
          // Plain-text fallback for this chunk
          try {
            await sendWithRetry(() =>
              this.bot.api.sendMessage(chatId, stripMarkdownV2(chunk), {
                reply_parameters: firstSend
                  ? { message_id: replyToMessageId, allow_sending_without_reply: true }
                  : undefined,
              }),
            )
          } catch (fallbackErr) {
            // Even plain-text failed; surface delivery-failure notice once.
            this.log(`send fallback failed: ${(fallbackErr as Error).message?.slice(0, 200)}`)
            try {
              await this.bot.api.sendMessage(chatId, DELIVERY_FAILURE_NOTICE)
            } catch {
              /* best-effort */
            }
            return
          }
        } else {
          this.log(`send failed: ${(err as Error).message?.slice(0, 200)}`)
          try {
            await this.bot.api.sendMessage(chatId, DELIVERY_FAILURE_NOTICE)
          } catch {
            /* best-effort */
          }
          return
        }
      }
      firstSend = false
    }
  }

  private log(line: string): void {
    if (this.opts.debug) console.log(`[telegram] ${line}`)
  }
}

/** Telegram caps messages at 4096 chars. We cap at 4000 to leave header room. */
export function capForTelegram(text: string): string {
  if (text.length <= 4000) return text
  return `${text.slice(0, 3970)}\n[reply truncated]`
}

export { GrammyError, HttpError }
