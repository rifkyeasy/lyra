'use client'

// The web brain prepares value-moving actions (transfer / swap) but holds no
// key. This card renders the prepared action and lets the USER execute it with
// their own connected wallet: we build the PTB in the browser and dapp-kit's
// signAndExecute routes it through the wallet for signing. The server never
// signs and never holds funds.

import type { PendingAction } from '@/lib/chat-store'
import sevenk from '@7kprotocol/sdk-ts'
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'
import { Transaction, coinWithBalance } from '@mysten/sui/transactions'
import { useState } from 'react'

const SUI_TYPE = '0x2::sui::SUI'
const isSui = (t: string) => t === SUI_TYPE || t.endsWith('::sui::SUI')

type Status =
  | { phase: 'idle' }
  | { phase: 'preparing' }
  | { phase: 'signing' }
  | { phase: 'done'; digest: string }
  | { phase: 'error'; message: string }

/** Build a transfer PTB: split (SUI from gas, else from owned coins) → transfer. */
function buildTransfer(action: Extract<PendingAction, { kind: 'transfer' }>): Transaction {
  const tx = new Transaction()
  const amount = BigInt(action.baseUnits)
  const coin = isSui(action.coinType)
    ? tx.splitCoins(tx.gas, [amount])[0]
    : coinWithBalance({ type: action.coinType, balance: amount })
  tx.transferObjects([coin], action.recipient)
  return tx
}

/**
 * Build a swap PTB via the 7k aggregator, for the connected wallet as signer.
 * Mirrors the agent's `swap` tool: quote → try routes in output order, dry-run
 * each, use the first that simulates cleanly (some providers leave an unconsumed
 * value). Throws if none simulate.
 */
async function buildSwap(
  action: Extract<PendingAction, { kind: 'swap' }>,
  address: string,
  // biome-ignore lint/suspicious/noExplicitAny: dapp-kit SuiClient vs sdk client shape
  client: any,
): Promise<Transaction> {
  // biome-ignore lint/suspicious/noExplicitAny: 7k default export carries MetaAg
  const ag = new (sevenk as any).MetaAg({ slippageBps: 100 })
  const quotes = (
    await ag.quote({
      coinTypeIn: action.fromType,
      coinTypeOut: action.toType,
      amountIn: action.baseUnits,
      signer: address,
    })
  )
    // biome-ignore lint/suspicious/noExplicitAny: route quote shape from sdk
    .filter(Boolean)
    .sort((a: any, b: any) => Number(b.amountOut ?? 0) - Number(a.amountOut ?? 0))
  if (!quotes.length) throw new Error('no swap route found')

  const failures: string[] = []
  for (const q of quotes) {
    const tx = new Transaction()
    tx.setSender(address)
    tx.setGasBudget(150_000_000)
    try {
      const amount = BigInt(action.baseUnits)
      const coinIn = isSui(action.fromType)
        ? tx.splitCoins(tx.gas, [amount])[0]
        : coinWithBalance({ type: action.fromType, balance: amount })
      const coinOut = await ag.swap({ quote: q, signer: address, tx, coinIn })
      tx.transferObjects([coinOut], address)
      const dr = await client.dryRunTransactionBlock({
        transactionBlock: await tx.build({ client }),
      })
      if (dr.effects?.status?.status === 'success') return tx
      failures.push(`${q.provider}: ${dr.effects?.status?.error ?? 'revert'}`)
    } catch (e) {
      failures.push(`${q.provider}: ${(e as Error).message.slice(0, 50)}`)
    }
  }
  throw new Error(`no route simulated cleanly — ${failures.join(' | ')}`)
}

export function ActionCard({ action }: { action: PendingAction }) {
  const account = useCurrentAccount()
  const client = useSuiClient()
  const { mutate: signAndExecute } = useSignAndExecuteTransaction()
  const [status, setStatus] = useState<Status>({ phase: 'idle' })

  const connected = Boolean(account?.address)
  const title =
    action.kind === 'transfer'
      ? `Send ${action.amount} ${action.symbol}`
      : `Swap ${action.amount} ${action.fromSymbol} → ${action.toSymbol}`
  const subtitle =
    action.kind === 'transfer'
      ? `to ${action.recipient.slice(0, 10)}…${action.recipient.slice(-6)}`
      : 'best route via the 7k aggregator (Cetus / FlowX / Bluefin / DeepBook)'

  async function execute() {
    if (!account?.address) return
    try {
      setStatus({ phase: 'preparing' })
      const tx =
        action.kind === 'transfer'
          ? buildTransfer(action)
          : await buildSwap(action, account.address, client)
      setStatus({ phase: 'signing' })
      // Pass the serialized tx (a string) so dapp-kit rebuilds it with its own
      // bundled @mysten/sui copy — avoids the duplicate-Transaction-class skew.
      signAndExecute(
        { transaction: tx.serialize() },
        {
          onSuccess: r => setStatus({ phase: 'done', digest: r.digest }),
          onError: e => setStatus({ phase: 'error', message: e.message.slice(0, 160) }),
        },
      )
    } catch (e) {
      setStatus({ phase: 'error', message: (e as Error).message.slice(0, 180) })
    }
  }

  const busy = status.phase === 'preparing' || status.phase === 'signing'

  return (
    <div className="mt-3 w-full max-w-[460px] rounded-xl border border-[var(--color-border)] bg-[var(--color-paper)] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            {action.kind === 'transfer' ? 'Transfer' : 'Swap'} · you sign
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
          ✓ Executed — view {status.digest.slice(0, 8)}… on Suiscan ↗
        </a>
      ) : (
        <button
          type="button"
          onClick={execute}
          disabled={!connected || busy}
          className="mt-3 flex w-full items-center justify-center rounded-lg bg-[var(--color-ink)] px-3 py-2 text-[13px] text-[var(--color-cream)] transition-opacity disabled:opacity-40"
        >
          {!connected
            ? 'Connect your wallet to execute'
            : status.phase === 'preparing'
              ? 'Preparing best route…'
              : status.phase === 'signing'
                ? 'Confirm in your wallet…'
                : 'Execute with your wallet'}
        </button>
      )}

      {status.phase === 'error' ? (
        <p className="mt-2 break-words font-mono text-[11px] text-[#b4341f]">{status.message}</p>
      ) : null}
      <p className="mt-2 font-mono text-[10.5px] leading-[1.5] text-[var(--color-ink-3)]">
        Lyra prepared this; it never holds your keys. Your wallet signs and broadcasts.
      </p>
    </div>
  )
}
