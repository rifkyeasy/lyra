'use client'

// Lyra's web brain prepares value-moving actions; the policy-bound AGENT wallet
// executes them server-side (identical to CLI / gateway / Telegram). The browser
// never signs — the connected wallet's Sui sign-in (SIWS) is the authorization
// that lets you direct your agent. Clicking Execute POSTs to /api/execute, which
// runs the action with the agent key under the on-chain AgentPolicy's bounds.

import { useSuiAuth } from '@/components/SuiAuthContext'
import type { PendingAction } from '@/lib/chat-store'
import { useState } from 'react'

type Status =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; digest: string; route?: string }
  | { phase: 'error'; message: string }

export function ActionCard({ action }: { action: PendingAction }) {
  const { isAuthed } = useSuiAuth()
  const [status, setStatus] = useState<Status>({ phase: 'idle' })

  const title =
    action.kind === 'transfer'
      ? `Send ${action.amount} ${action.symbol}`
      : `Swap ${action.amount} ${action.fromSymbol} → ${action.toSymbol}`
  const subtitle =
    action.kind === 'transfer'
      ? `to ${action.recipient.slice(0, 10)}…${action.recipient.slice(-6)}`
      : 'best route via the 7k aggregator (Cetus / FlowX / Bluefin / DeepBook)'

  async function execute() {
    setStatus({ phase: 'running' })
    try {
      const res = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = (await res.json()) as { ok: boolean; digest?: string; route?: string; error?: string }
      if (data.ok && data.digest) setStatus({ phase: 'done', digest: data.digest, route: data.route })
      else setStatus({ phase: 'error', message: data.error ?? `failed (${res.status})` })
    } catch (e) {
      setStatus({ phase: 'error', message: (e as Error).message.slice(0, 180) })
    }
  }

  const busy = status.phase === 'running'

  return (
    <div className="mt-3 w-full max-w-[460px] rounded-xl border border-[var(--color-border)] bg-[var(--color-paper)] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            {action.kind === 'transfer' ? 'Transfer' : 'Swap'} · policy-bound agent
          </p>
          <p className="mt-1 truncate text-[15px] font-medium text-[var(--color-ink)]">{title}</p>
          <p className="truncate font-mono text-[11.5px] text-[var(--color-ink-3)]">{subtitle}</p>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-ink-3)]">
          mainnet
        </span>
      </div>

      {status.phase === 'done' ? (
        <a
          href={`https://suiscan.xyz/mainnet/tx/${status.digest}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex items-center justify-center rounded-lg bg-[var(--color-ink)] px-3 py-2 text-[13px] text-[var(--color-cream)]"
        >
          ✓ Executed{status.route ? ` via ${status.route}` : ''} — {status.digest.slice(0, 8)}… on Suiscan ↗
        </a>
      ) : (
        <button
          type="button"
          onClick={execute}
          disabled={!isAuthed || busy}
          className="mt-3 flex w-full items-center justify-center rounded-lg bg-[var(--color-ink)] px-3 py-2 text-[13px] text-[var(--color-cream)] transition-opacity disabled:opacity-40"
        >
          {!isAuthed
            ? 'Sign in (top-right) to authorize your agent'
            : busy
              ? 'Agent executing under policy…'
              : 'Execute — your agent signs'}
        </button>
      )}

      {status.phase === 'error' ? (
        <p className="mt-2 break-words font-mono text-[11px] text-[#b4341f]">{status.message}</p>
      ) : null}
      <p className="mt-2 font-mono text-[10.5px] leading-[1.5] text-[var(--color-ink-3)]">
        Your policy-bound agent wallet signs this — checked against the on-chain AgentPolicy. You
        never expose a key; sign-in just proves you're the owner.
      </p>
    </div>
  )
}
