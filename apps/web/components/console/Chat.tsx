'use client'

import { useAgentWallet } from '@/components/AgentWalletContext'
import { useSuiAuth } from '@/components/SuiAuthContext'
import type { Msg, PendingAction, TraceItem } from '@/lib/chat-store'
import { useCurrentAccount } from '@mysten/dapp-kit'
import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { ActionCard } from './ActionCard'
import { AgentWalletBar } from './AgentWalletBar'
import { MarkdownView } from './MarkdownView'

const SUGGESTIONS = [
  "What's the best stablecoin yield on Sui right now?",
  'Show my AgentPolicy: budget, caps, and allowlists',
  'Is sending 0.02 SUI within policy?',
  "What's my SUI balance?",
]

// Telegram-bot-style template menu, grouped by on-chain activity. Picking one
// drops a real, useful prompt into the box (placeholders like 0x… or amounts
// are yours to edit). Each maps to something the agent can actually do.
const TEMPLATES: { group: string; items: { label: string; prompt: string }[] }[] = [
  {
    group: 'Yields',
    items: [
      {
        label: 'Best stablecoin yield',
        prompt: 'Where can I earn the most on stablecoins on Sui right now? Show APY and TVL.',
      },
      {
        label: 'Top pools by APY',
        prompt: 'What are the top DeFi pools on Sui by APY right now, with their TVL?',
      },
    ],
  },
  {
    group: 'Swap (you sign)',
    items: [
      { label: 'Swap SUI → USDC', prompt: 'Swap 1 SUI to USDC.' },
      { label: 'Swap USDC → SUI', prompt: 'Swap 1 USDC to SUI.' },
      {
        label: 'Just a price quote',
        prompt: 'What would I get if I swap 100 USDC to SUI? Just a quote, do not prepare a swap.',
      },
    ],
  },
  {
    group: 'Transfer (you sign)',
    items: [
      { label: 'Send SUI', prompt: 'Send 0.01 SUI to 0x….' },
      { label: 'Send a coin', prompt: 'Send 5 USDC to 0x….' },
    ],
  },
  {
    group: 'Lend & borrow (Suilend)',
    items: [
      { label: 'Supply / lend', prompt: 'Supply 5 USDC to Suilend to earn yield.' },
      { label: 'Withdraw', prompt: 'Withdraw all my USDC from Suilend.' },
      {
        label: 'Suilend rates',
        prompt: 'What are the current Suilend supply and borrow rates on Sui?',
      },
    ],
  },
  {
    group: 'Portfolio & policy',
    items: [
      {
        label: 'My portfolio value',
        prompt:
          'What is my full treasury portfolio worth right now? Break it down by coin with USD values.',
      },
      { label: 'My SUI + USDC balance', prompt: 'What is my balance in SUI and USDC right now?' },
      {
        label: 'Holdings of an address',
        prompt: 'What is the full coin portfolio of 0x… on Sui, with USD values?',
      },
      {
        label: 'My AgentPolicy',
        prompt:
          'Show my AgentPolicy: budget, spent, per-tx cap, allowed coins and protocols, expiry, and whether it is revoked.',
      },
      { label: 'Recent receipts', prompt: 'Show my recent ActionReceipts on Sui.' },
    ],
  },
]

export function Chat({
  messages,
  onMessagesChange,
  onMenu,
}: {
  messages: Msg[]
  onMessagesChange: (next: Msg[]) => void
  onMenu?: () => void
}) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const { address: authedAddress, isAuthed } = useSuiAuth()
  const account = useCurrentAccount()
  const { activeAddress } = useAgentWallet()
  const authed = isAuthed ? authedAddress : null
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function scrollToEnd() {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }),
    )
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the tail whenever the count changes
  useEffect(scrollToEnd, [messages.length])

  async function send(text: string) {
    const t = text.trim()
    if (!t || busy) return
    const next: Msg[] = [...messages, { role: 'user', content: t }]
    onMessagesChange(next)
    setInput('')
    setBusy(true)
    scrollToEnd()
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: next,
          walletAddress: activeAddress ?? account?.address ?? undefined,
        }),
      })
      const data = (await res.json()) as {
        reply?: string
        error?: string
        trace?: TraceItem[]
        action?: PendingAction
      }
      onMessagesChange([
        ...next,
        {
          role: 'assistant',
          content: data.reply ?? data.error ?? '(no reply)',
          trace: data.trace,
          pendingAction: data.action,
        },
      ])
    } catch (e) {
      onMessagesChange([...next, { role: 'assistant', content: `error: ${(e as Error).message}` }])
    } finally {
      setBusy(false)
      scrollToEnd()
    }
  }

  const empty = messages.length === 0

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <AgentWalletBar />
      <div
        ref={scrollRef}
        data-lenis-prevent
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {onMenu ? (
          <div className="sticky top-0 z-10 flex items-center border-b border-[var(--color-border)] bg-[var(--color-cream)] px-3 py-2 md:hidden">
            <button
              type="button"
              onClick={onMenu}
              aria-label="Open chats"
              className="flex items-center gap-1.5 font-mono text-[12px] text-[var(--color-ink-2)]"
            >
              <MenuIcon /> Chats
            </button>
          </div>
        ) : null}
        <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col gap-7 px-5 py-8">
          {empty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-7 text-center">
              <div className="grid gap-3">
                <h1
                  className="font-display font-light leading-[1.05] tracking-tight text-[var(--color-ink)]"
                  style={{
                    fontSize: 'clamp(30px, 4vw, 46px)',
                    fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
                  }}
                >
                  Prompt lyra.
                </h1>
                <p className="mx-auto max-w-[48ch] text-[14.5px] leading-[1.6] text-[var(--color-ink-2)]">
                  Live on-chain answers on Sui — and transfers &amp; swaps you execute with your own
                  connected wallet. The autonomous agent runs bounded by its on-chain AgentPolicy.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="rounded-full border border-[var(--color-border)] px-3.5 py-2 text-left font-mono text-[12px] text-[var(--color-ink-2)] transition-colors hover:border-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((m, i) => (
                <motion.div
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only chat log
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className={
                    m.role === 'user' ? 'flex flex-col items-end' : 'flex flex-col items-start'
                  }
                >
                  {m.role === 'user' ? (
                    <p className="max-w-[85%] overflow-hidden whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--color-paper)] px-4 py-2.5 text-[14.5px] leading-[1.55] text-[var(--color-ink)]">
                      {m.content}
                    </p>
                  ) : (
                    <div className="w-full min-w-0">
                      <span className="kicker">LYRA</span>
                      <div className="mt-1.5 break-words text-[14px] leading-[1.6] [&_h2]:text-[18px] [&_h3]:text-[16px] [&_li]:text-[14.5px] [&_li]:text-[var(--color-ink-2)] [&_p]:mb-2 [&_p]:text-[14.5px] [&_p]:leading-[1.65] [&_p]:text-[var(--color-ink-2)] [&_pre]:max-w-full [&_pre]:overflow-x-auto">
                        <MarkdownView content={m.content} />
                      </div>
                      {m.trace && m.trace.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {m.trace.map((t, ti) => (
                            <span
                              // biome-ignore lint/suspicious/noArrayIndexKey: append-only trace
                              key={ti}
                              title={
                                typeof t.result === 'object'
                                  ? JSON.stringify(t.result).slice(0, 300)
                                  : String(t.result)
                              }
                              className="rounded-full border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--color-ink-3)]"
                            >
                              ⛓ {t.tool}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {m.pendingAction ? <ActionCard action={m.pendingAction} /> : null}
                    </div>
                  )}
                </motion.div>
              ))}
              {busy ? <ThinkingIndicator /> : null}
            </>
          )}
        </div>
      </div>

      <div className="border-t border-[var(--color-border)] bg-[var(--color-cream)]">
        <div className="mx-auto w-full max-w-[760px] px-5 py-4">
          <form
            onSubmit={e => {
              e.preventDefault()
              void send(input)
            }}
            className="flex items-center gap-1.5 rounded-2xl border border-[var(--color-border)] py-2.5 pl-2 pr-4 transition-colors focus-within:border-[var(--color-ink-3)]"
          >
            <TemplateMenu
              onPick={prompt => {
                setInput(prompt)
                requestAnimationFrame(() => inputRef.current?.focus())
              }}
            />
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Prompt lyra…"
              disabled={busy}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-3)]"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded-full bg-[var(--color-ink)] px-4 py-1.5 text-[13px] text-[var(--color-cream)] transition-opacity disabled:opacity-40"
            >
              Send
            </button>
          </form>
          <p className="mt-2 text-center font-mono text-[11px] text-[var(--color-ink-3)]">
            {account
              ? `wallet ${account.address.slice(0, 6)}…${account.address.slice(-4)} connected · transfers & swaps execute from your own wallet`
              : 'connect your Sui wallet (top right) to execute transfers & swaps yourself'}
          </p>
        </div>
      </div>
    </div>
  )
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2">
      <motion.span
        className="font-mono text-[12px] leading-none text-[var(--color-ink-2)]"
        animate={{ opacity: [0.35, 1, 0.35] }}
        transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
      >
        lyra is thinking
      </motion.span>
      <span className="flex items-center gap-1">
        {[0, 1, 2].map(i => (
          <motion.span
            key={i}
            className="block h-[3px] w-[3px] rounded-full bg-[var(--color-ink-3)]"
            animate={{ opacity: [0.2, 1, 0.2] }}
            transition={{
              duration: 1.1,
              repeat: Number.POSITIVE_INFINITY,
              ease: 'easeInOut',
              delay: i * 0.2,
            }}
          />
        ))}
      </span>
    </div>
  )
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4h11M2.5 8h11M2.5 12h11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function TemplateMenu({ onPick }: { onPick: (prompt: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="Question templates"
        aria-expanded={open}
        title="Templates"
        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
      >
        <MenuIcon />
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close templates"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            data-lenis-prevent
            className="absolute bottom-full left-0 z-50 mb-2 max-h-[60vh] w-[300px] max-w-[calc(100vw-2.5rem)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-border)] bg-[var(--color-cream)] p-2 shadow-[0_30px_80px_-30px_rgba(16,15,9,0.45)]"
          >
            {TEMPLATES.map(group => (
              <div key={group.group} className="mb-1 last:mb-0">
                <p className="px-2 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
                  {group.group}
                </p>
                {group.items.map(it => (
                  <button
                    key={it.label}
                    type="button"
                    title={it.prompt}
                    onClick={() => {
                      onPick(it.prompt)
                      setOpen(false)
                    }}
                    className="block w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-[var(--color-ink)] transition-colors hover:bg-[var(--color-paper)]"
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
