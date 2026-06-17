'use client'

// The signed-in owner's agent + treasury vault control bar. The owner provisions
// (delegate + open vault + deposit, one signature), tops up the vault, tops up the
// agent's gas float, and withdraws — all signed by the OWNER's own wallet via
// dapp-kit. The agent (derived, server-side) then spends from the vault under the
// on-chain AgentPolicy. The server never signs these owner actions.

import { useSuiAuth } from '@/components/SuiAuthContext'
import { accountUrl } from '@/lib/chainscan'
import { shortAddress } from '@/lib/format'
import { CLOCK, SUI_TYPE } from '@/lib/onchain-constants'
import { useSignAndExecuteTransaction } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useCallback, useEffect, useState } from 'react'

type VaultInfo = { vaultId: string; policyId: string; capId: string; vaultMist: string }
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
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

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
            setTimeout(refresh, 1500)
          },
          onError: e => {
            setBusy(null)
            setMsg(`✗ ${e.message.slice(0, 90)}`)
          },
        },
      )
    } catch (e) {
      setBusy(null)
      setMsg(`✗ ${(e as Error).message.slice(0, 90)}`)
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

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-border)] px-5 py-2 font-mono text-[12px] text-[var(--color-ink-2)]">
      <span className="text-[var(--color-ink-3)]">agent</span>
      <a
        href={accountUrl(agent, 'mainnet')}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--color-ink)] hover:text-[var(--color-ink-2)]"
      >
        {shortAddress(agent, 6, 4)} ↗
      </a>
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
