'use client'

// Shows the signed-in owner's OWN agent wallet (multi-tenant: derived per owner,
// fetched from /api/agent) + its balance, with a fund hint when empty. This is
// the agent that executes when you direct it from chat — funded by you, bounded
// by its on-chain AgentPolicy.

import { useSuiAuth } from '@/components/SuiAuthContext'
import { accountUrl } from '@/lib/chainscan'
import { shortAddress } from '@/lib/format'
import { useEffect, useState } from 'react'

type AgentInfo = { owner: string | null; agent: string | null; suiMist: string }

export function AgentWalletBar() {
  const { isAuthed } = useSuiAuth()
  const [info, setInfo] = useState<AgentInfo | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isAuthed) {
      setInfo(null)
      return
    }
    let alive = true
    fetch('/api/agent', { cache: 'no-store' })
      .then(r => r.json())
      .then((d: AgentInfo) => {
        if (alive) setInfo(d)
      })
      .catch(() => {})
    const t = setInterval(() => {
      fetch('/api/agent', { cache: 'no-store' })
        .then(r => r.json())
        .then((d: AgentInfo) => alive && setInfo(d))
        .catch(() => {})
    }, 15000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [isAuthed])

  if (!isAuthed) {
    return (
      <div className="flex items-center border-b border-[var(--color-border)] px-5 py-2 font-mono text-[12px] text-[var(--color-ink-2)]">
        Sign in (top-right) to provision your policy-bound agent wallet.
      </div>
    )
  }

  const agent = info?.agent ?? null
  const sui = info ? Number(info.suiMist) / 1e9 : null
  const unfunded = sui !== null && sui < 0.01

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-border)] px-5 py-2 font-mono text-[12px] text-[var(--color-ink-2)]">
      {agent ? (
        <>
          <span className="text-[var(--color-ink-3)]">your agent</span>
          <a
            href={accountUrl(agent, 'mainnet')}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-ink)] transition-colors hover:text-[var(--color-ink-2)]"
          >
            {shortAddress(agent, 6, 4)} ↗
          </a>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(agent)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
            className="text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-ink)]"
          >
            {copied ? 'copied ✓' : 'copy'}
          </button>
          <span className="text-[var(--color-ink-3)]">· {sui !== null ? `${sui.toFixed(4)} SUI` : '…'}</span>
          {unfunded ? (
            <span className="text-[var(--color-ink-3)]">· fund it — send SUI to this address to start acting</span>
          ) : null}
        </>
      ) : (
        <span>deriving your agent…</span>
      )}
    </div>
  )
}
