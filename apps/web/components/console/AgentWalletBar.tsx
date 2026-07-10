'use client'

// The signed-in owner's agent + treasury vault control bar. The owner provisions
// (delegate + open vault + deposit, one signature), tops up the vault, tops up the
// agent's gas float, and withdraws — all signed by the OWNER's own wallet via
// dapp-kit. The agent (derived, server-side) then spends from the vault under the
// on-chain AgentPolicy. The server never signs these owner actions.

import { useSuiAuth } from '@/components/SuiAuthContext'
import { TxResultDialog, type TxResult } from '@/components/console/TxResultDialog'
import { accountUrl } from '@/lib/chainscan'
import { shortAddress } from '@/lib/format'
import { ALLOWLISTABLE_PROTOCOLS, CLOCK, NO_PROTOCOL, SUI_TYPE } from '@/lib/onchain-constants'
import { useSignAndExecuteTransaction } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'

type VaultInfo = {
  vaultId: string
  policyId: string
  capId: string
  vaultMist: string
  allowedRecipients: string[] | null
  allowedProtocols: string[]
}
type AgentInfo = {
  owner: string | null
  agent: string | null
  agentMist: string
  pkg: string
  vault: VaultInfo | null
}

const toMist = (sui: string): bigint => BigInt(Math.round(Number(sui || '0') * 1e9))
const fmt = (mist: string): string => (Number(mist) / 1e9).toFixed(4)

export function AgentWalletBar() {
  const { isAuthed } = useSuiAuth()
  const { mutate: sign } = useSignAndExecuteTransaction()
  const [info, setInfo] = useState<AgentInfo | null>(null)
  const [amount, setAmount] = useState('0.2')
  const [payeeInput, setPayeeInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [result, setResult] = useState<TxResult | null>(null)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [showQr, setShowQr] = useState(false)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(() => {
    fetch('/api/agent', { cache: 'no-store' })
      .then(r => r.json())
      .then(setInfo)
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!isAuthed) {
      setInfo(null)
      return
    }
    refresh()
    const t = setInterval(refresh, 15000)
    return () => clearInterval(t)
  }, [isAuthed, refresh])

  // QR of the agent address so the owner can scan to deposit SUI/coins into it.
  // SVG (not a data: URI) keeps it CSP-safe.
  const agentAddr = info?.agent
  useEffect(() => {
    if (!agentAddr) {
      setQrSvg(null)
      return
    }
    QRCode.toString(agentAddr, {
      type: 'svg',
      margin: 1,
      color: { dark: '#0b0e15', light: '#ffffff' },
    })
      .then(setQrSvg)
      .catch(() => setQrSvg(null))
  }, [agentAddr])

  if (!isAuthed) {
    return <Bar>Sign in (top-right) to provision your policy-bound agent vault.</Bar>
  }
  if (!info?.agent) return <Bar>deriving your agent…</Bar>

  const { pkg, agent, owner, vault } = info

  const run = (label: string, build: () => Transaction) => {
    setBusy(label)
    setMsg(null)
    try {
      const tx = build()
      sign(
        { transaction: tx.serialize() },
        {
          onSuccess: r => {
            setBusy(null)
            setMsg(`✓ ${label} (${r.digest.slice(0, 8)}…)`)
            setResult({ kind: 'success', label, digest: r.digest })
            setTimeout(refresh, 1500)
          },
          onError: e => {
            setBusy(null)
            setMsg(`✗ ${e.message.slice(0, 90)}`)
            setResult({ kind: 'error', label, error: e.message })
          },
        },
      )
    } catch (e) {
      setBusy(null)
      const message = (e as Error).message
      setMsg(`✗ ${message.slice(0, 90)}`)
      setResult({ kind: 'error', label, error: message })
    }
  }

  const provision = () =>
    run('provision', () => {
      const tx = new Transaction()
      const [funds] = tx.splitCoins(tx.gas, [toMist(amount)])
      tx.moveCall({
        target: `${pkg}::vault::provision`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.pure.address(agent),
          tx.pure.u64(10_000_000_000n), // budget 10 SUI
          tx.pure.u64(1_000_000_000n), // per-tx 1 SUI
          tx.pure.u64(100n), // 1% slippage
          tx.makeMoveVec({ type: 'vector<u8>', elements: [] }), // any coin
          tx.makeMoveVec({ type: 'address', elements: [] }), // any protocol
          tx.pure.u64(0n), // no expiry
          funds,
          tx.object(CLOCK),
        ],
      })
      return tx
    })

  const deposit = () =>
    run('deposit', () => {
      const tx = new Transaction()
      const [c] = tx.splitCoins(tx.gas, [toMist(amount)])
      tx.moveCall({
        target: `${pkg}::vault::deposit_entry`,
        typeArguments: [SUI_TYPE],
        arguments: [tx.object((vault as VaultInfo).vaultId), c],
      })
      return tx
    })

  const withdraw = () =>
    run('withdraw', () => {
      const v = vault as VaultInfo
      const tx = new Transaction()
      tx.moveCall({
        target: `${pkg}::vault::owner_withdraw_to`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(v.vaultId),
          tx.object(v.capId),
          tx.pure.u64(toMist(amount)),
          tx.pure.address(owner ?? agent),
        ],
      })
      return tx
    })

  const fundGas = () =>
    run('gas top-up', () => {
      const tx = new Transaction()
      const [c] = tx.splitCoins(tx.gas, [toMist('0.05')])
      tx.transferObjects([c], agent)
      return tx
    })

  // Set the policy's transfer-recipient allowlist (empty = allow any). Bounds a
  // prompt-injected agent to the owner's approved payees.
  const setPayees = (addrs: string[]) =>
    run(addrs.length ? 'restrict payees' : 'allow any', () => {
      const v = vault as VaultInfo
      const tx = new Transaction()
      tx.moveCall({
        target: `${pkg}::policy::set_allowed_recipients`,
        arguments: [
          tx.object(v.policyId),
          tx.object(v.capId),
          tx.makeMoveVec({ type: 'address', elements: addrs.map(a => tx.pure.address(a)) }),
        ],
      })
      return tx
    })

  // Set which yield protocols the agent may deploy vault funds into. Empty = any
  // protocol (fully open). A non-empty list always includes 0x0 (the transfer/swap
  // tag) so restricting protocols never blocks a plain transfer or swap.
  const setProtocols = (ids: string[]) =>
    run(ids.length ? 'restrict protocols' : 'allow any protocol', () => {
      const v = vault as VaultInfo
      const list = ids.length ? [...ids, NO_PROTOCOL] : []
      const tx = new Transaction()
      tx.moveCall({
        target: `${pkg}::policy::set_allowed_protocols`,
        arguments: [
          tx.object(v.policyId),
          tx.object(v.capId),
          tx.makeMoveVec({ type: 'address', elements: list.map(a => tx.pure.address(a)) }),
        ],
      })
      return tx
    })

  const payees = vault?.allowedRecipients ?? null
  const restricted = Array.isArray(payees) && payees.length > 0

  // Protocol allowlist UI state. An empty on-chain list = open (all allowed), so
  // every toggle shows "on"; unchecking one restricts to the rest. Re-checking all
  // collapses back to the open ([]) state.
  const allProtoIds = ALLOWLISTABLE_PROTOCOLS.map(p => p.id)
  const savedProtocols = (vault?.allowedProtocols ?? []).filter(id => allProtoIds.includes(id))
  const protoRestricted = savedProtocols.length > 0
  const effectiveProtocols = protoRestricted ? savedProtocols : allProtoIds
  const protoAllowed = (id: string) => effectiveProtocols.includes(id)
  const toggleProtocol = (id: string) => {
    const cur = new Set(effectiveProtocols)
    cur.has(id) ? cur.delete(id) : cur.add(id)
    const next = Array.from(cur)
    setProtocols(next.length === allProtoIds.length ? [] : next)
  }

  return (
    <div className="border-b border-[var(--color-border)] font-mono text-[12px] text-[var(--color-ink-2)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2">
        <span className="text-[var(--color-ink-3)]">agent</span>
        <a
          href={accountUrl(agent, 'mainnet')}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-ink)] hover:text-[var(--color-ink-2)]"
        >
          {shortAddress(agent, 6, 4)} ↗
        </a>
        <button
          type="button"
          onClick={() => setShowQr(v => !v)}
          className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10.5px] text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink-3)]"
          aria-expanded={showQr}
        >
          {showQr ? 'hide QR' : 'deposit ⊞'}
        </button>
        <span className="text-[var(--color-ink-3)]">gas {fmt(info.agentMist)}</span>
        {vault ? (
          <span className="text-[var(--color-ink-3)]">· vault {fmt(vault.vaultMist)} SUI</span>
        ) : (
          <span className="text-[var(--color-ink-3)]">· no vault yet</span>
        )}

        <span className="mx-1 h-3 w-px bg-[var(--color-border)]" />
        <input
          value={amount}
          onChange={e => setAmount(e.target.value)}
          className="w-14 rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 text-[11px] text-[var(--color-ink)] outline-none"
          aria-label="SUI amount"
        />
        <span className="text-[var(--color-ink-3)]">SUI</span>

        {vault ? (
          <>
            <Btn onClick={deposit} busy={busy === 'deposit'}>
              deposit
            </Btn>
            <Btn onClick={withdraw} busy={busy === 'withdraw'}>
              withdraw
            </Btn>
          </>
        ) : (
          <Btn onClick={provision} busy={busy === 'provision'}>
            provision agent
          </Btn>
        )}
        <Btn onClick={fundGas} busy={busy === 'gas top-up'}>
          +gas
        </Btn>

        {msg ? <span className="text-[var(--color-ink-3)]">{msg}</span> : null}
      </div>

      {showQr ? (
        <div className="flex flex-col items-center gap-2 border-t border-[var(--color-border)] px-5 py-4">
          {qrSvg ? (
            <div
              className="h-40 w-40 rounded-lg bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: qrcode's own SVG, no user input
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <div className="h-40 w-40 rounded-lg bg-[var(--color-cream-deep)]" />
          )}
          <div className="text-center text-[11px] text-[var(--color-ink-3)]">
            Scan to deposit SUI or coins into your agent
          </div>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(agent).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
            className="max-w-full truncate rounded border border-[var(--color-border)] px-2 py-1 text-[10.5px] text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink-3)]"
            title="copy agent address"
          >
            {copied ? 'copied ✓' : `${agent}  ·  copy`}
          </button>
        </div>
      ) : null}

      {vault ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--color-border)] px-5 py-1.5">
          <span className="text-[var(--color-ink-3)]">payees</span>
          <span className={restricted ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-3)]'}>
            {restricted ? `restricted to ${payees.length}` : 'any (open)'}
          </span>
          {restricted ? (
            <span className="truncate text-[var(--color-ink-3)]">
              {payees.map(p => `${p.slice(0, 8)}…${p.slice(-4)}`).join(', ')}
            </span>
          ) : null}
          <span className="mx-1 h-3 w-px bg-[var(--color-border)]" />
          <input
            value={payeeInput}
            onChange={e => setPayeeInput(e.target.value)}
            placeholder="0x… (comma-separated)"
            className="w-48 rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 text-[11px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-3)]"
            aria-label="allowed payees"
          />
          <Btn
            onClick={() =>
              setPayees(
                payeeInput
                  .split(',')
                  .map(s => s.trim())
                  .filter(s => /^0x[0-9a-fA-F]{1,64}$/.test(s)),
              )
            }
            busy={busy === 'restrict payees'}
          >
            restrict
          </Btn>
          <Btn onClick={() => setPayees([])} busy={busy === 'allow any'}>
            allow any
          </Btn>
        </div>
      ) : null}

      {vault ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-[var(--color-border)] px-5 py-1.5">
          <span className="text-[var(--color-ink-3)]">protocols</span>
          <span className={protoRestricted ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-3)]'}>
            {protoRestricted ? `restricted to ${effectiveProtocols.length}` : 'any (open)'}
          </span>
          <span className="mx-1 h-3 w-px bg-[var(--color-border)]" />
          {ALLOWLISTABLE_PROTOCOLS.map(p => {
            const on = protoAllowed(p.id)
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => toggleProtocol(p.id)}
                disabled={busy != null}
                className={`rounded-full border px-2 py-0.5 text-[10.5px] transition-colors disabled:opacity-50 ${
                  on
                    ? 'border-[var(--color-ink-3)] text-[var(--color-ink)]'
                    : 'border-[var(--color-border)] text-[var(--color-ink-3)] line-through'
                }`}
                title={on ? `${p.label} allowed — click to block` : `${p.label} blocked — click to allow`}
              >
                {p.label}
              </button>
            )
          })}
          {protoRestricted ? (
            <Btn onClick={() => setProtocols([])} busy={busy === 'allow any protocol'}>
              allow any
            </Btn>
          ) : null}
        </div>
      ) : null}

      <TxResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  )
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center border-b border-[var(--color-border)] px-5 py-2 font-mono text-[12px] text-[var(--color-ink-2)]">
      {children}
    </div>
  )
}

function Btn({
  children,
  onClick,
  busy,
}: {
  children: React.ReactNode
  onClick: () => void
  busy: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5 text-[11px] text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink-3)] disabled:opacity-40"
    >
      {busy ? '…' : children}
    </button>
  )
}
