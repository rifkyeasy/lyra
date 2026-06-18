'use client'

import { useSuiAuth } from '@/components/SuiAuthContext'
import { shortAddress } from '@/lib/format'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'
import { useEffect, useState } from 'react'

const PILL_DARK =
  'inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--color-ink)] px-7 py-3.5 text-[15px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-wait disabled:opacity-70 disabled:hover:translate-y-0 disabled:hover:scale-100'

type ApproveState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; owner: string }
  | { kind: 'error'; message: string }

export default function CliLoginPage() {
  const account = useCurrentAccount()
  const { address, isAuthed, signIn, isPending } = useSuiAuth()

  const [code, setCode] = useState('')
  const [state, setState] = useState<ApproveState>({ kind: 'idle' })

  // Pre-fill the code from ?code= (the CLI links here with it filled in).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('code')
    if (fromUrl) setCode(fromUrl.toUpperCase())
  }, [])

  async function approve() {
    setState({ kind: 'submitting' })
    try {
      const res = await fetch('/api/cli/login/approve', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        owner?: string
        error?: string
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `approve failed (${res.status})`)
      }
      setState({ kind: 'done', owner: data.owner ?? address ?? '' })
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message || 'approve failed' })
    }
  }

  return (
    <main className="relative min-h-screen bg-[var(--color-cream)] text-[var(--color-ink)]">
      <div className="mx-auto flex min-h-screen w-full max-w-[var(--container-narrow)] flex-col justify-center px-6 py-24 sm:px-8">
        <header className="grid gap-3">
          <span className="font-mono text-[13px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            Lyra CLI · device link
          </span>
          <h1
            className="max-w-[18ch] font-display font-light leading-[1.05] tracking-tight text-[var(--color-ink)]"
            style={{
              fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
              fontSize: 'clamp(34px, 4vw, 56px)',
            }}
          >
            Link a terminal to your agent.
          </h1>
          <p className="mt-1 max-w-[52ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
            A Lyra CLI started a login and showed you a code. Sign in with the wallet that owns the
            agent, confirm the code matches, and approve to link that terminal.
          </p>
        </header>

        <section className="mt-10">
          {isAuthed && address ? (
            state.kind === 'done' ? (
              <LinkedPanel owner={state.owner} />
            ) : (
              <ApprovePanel
                code={code}
                setCode={setCode}
                address={address}
                onApprove={approve}
                submitting={state.kind === 'submitting'}
                error={state.kind === 'error' ? state.message : null}
              />
            )
          ) : (
            <SignInPanel
              connected={Boolean(account)}
              isPending={isPending}
              onSignIn={() => void signIn()}
            />
          )}
        </section>
      </div>
    </main>
  )
}

function SignInPanel({
  connected,
  isPending,
  onSignIn,
}: {
  connected: boolean
  isPending: boolean
  onSignIn: () => void
}) {
  let action: React.ReactNode
  if (isPending) {
    action = (
      <button type="button" disabled className={PILL_DARK}>
        Signing…
      </button>
    )
  } else if (connected) {
    action = (
      <button type="button" onClick={onSignIn} className={PILL_DARK}>
        Sign in <span aria-hidden>→</span>
      </button>
    )
  } else {
    action = <ConnectButton connectText="Connect wallet" />
  }

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-paper)] p-7 shadow-[var(--shadow-card)] sm:p-8">
      <h2 className="text-[17px] font-medium tracking-tight text-[var(--color-ink)]">
        Sign in to continue
      </h2>
      <p className="mt-2 max-w-[46ch] text-[14.5px] leading-[1.6] text-[var(--color-ink-2)]">
        Connect your Sui wallet and sign in. The signature proves ownership and creates a session —
        no transaction is sent. Lyra derives your agent from this wallet.
      </p>
      <div className="mt-6">{action}</div>
    </div>
  )
}

function ApprovePanel({
  code,
  setCode,
  address,
  onApprove,
  submitting,
  error,
}: {
  code: string
  setCode: (v: string) => void
  address: string
  onApprove: () => void
  submitting: boolean
  error: string | null
}) {
  return (
    <div className="grid gap-6">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-paper)] p-7 shadow-[var(--shadow-card)] sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-medium tracking-tight text-[var(--color-ink)]">
            Approve this terminal
          </h2>
          <span className="font-mono text-[12.5px] text-[var(--color-ink-3)]" title={address}>
            {shortAddress(address, 6, 4)}
          </span>
        </div>

        <label
          htmlFor="cli-code"
          className="mt-6 block text-[13px] font-medium text-[var(--color-ink-2)]"
        >
          Pairing code
        </label>
        <input
          id="cli-code"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          className="mt-2 w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-cream)] px-4 py-3.5 font-mono text-[20px] tracking-[0.18em] text-[var(--color-ink)] outline-none transition-colors focus:border-[var(--color-accent)]"
        />
        <p className="mt-2 text-[13px] text-[var(--color-ink-3)]">
          Confirm this matches the code shown in your terminal before approving.
        </p>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={onApprove}
            disabled={submitting || code.trim().length < 8}
            className={`${PILL_DARK} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {submitting ? 'Approving…' : 'Approve'}
          </button>
          {error ? <span className="text-[14px] text-[#c0392b]">{error}</span> : null}
        </div>
      </div>

      <Warning />
    </div>
  )
}

function Warning() {
  return (
    <div className="rounded-2xl border border-[color-mix(in_oklab,#c0392b_36%,var(--color-border-strong))] bg-[color-mix(in_oklab,#c0392b_6%,var(--color-paper))] p-6">
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 select-none text-[16px]">
          ⚠️
        </span>
        <div>
          <h3 className="text-[14.5px] font-semibold tracking-tight text-[var(--color-ink)]">
            This hands the terminal your agent's signing key
          </h3>
          <p className="mt-1.5 max-w-[58ch] text-[13.5px] leading-[1.6] text-[var(--color-ink-2)]">
            Approving sends the agent secret derived from this wallet to the terminal that started
            this login, so it can sign transactions locally. Only approve a terminal you control and
            trust. The agent stays bounded by its on-chain AgentPolicy, but anyone with this key can
            act as your agent within that policy. The code expires in 10 minutes.
          </p>
        </div>
      </div>
    </div>
  )
}

function LinkedPanel({ owner }: { owner: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-paper)] p-7 shadow-[var(--shadow-card)] sm:p-8">
      <h2 className="flex items-center gap-2 text-[18px] font-medium tracking-tight text-[var(--color-ink)]">
        <span aria-hidden className="text-[var(--color-accent)]">
          ✓
        </span>
        Terminal linked
      </h2>
      <p className="mt-2 max-w-[48ch] text-[14.5px] leading-[1.6] text-[var(--color-ink-2)]">
        Return to your CLI — it now holds the agent for{' '}
        <span className="font-mono text-[13px] text-[var(--color-ink)]">
          {shortAddress(owner, 6, 4)}
        </span>{' '}
        and can sign locally. You can close this tab.
      </p>
    </div>
  )
}
