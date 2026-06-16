import type { SuiClient } from '@mysten/sui/client'
import type { Signer } from '@mysten/sui/cryptography'
import { Transaction } from '@mysten/sui/transactions'
import {
  evaluatePolicy,
  mistToSui,
  NO_ARGS,
  type Network,
  type SuiPolicy,
  SUI_TYPE,
  suiToMist,
  type ToolSpec,
} from 'lyra-core'
import {
  buildRecord,
  buildWithdrawTransfer,
  execute,
  getBalances,
  getPolicyState,
  queryReceipts,
  txUrl,
} from 'lyra-plugin-sui'
import { getSummary } from 'lyra-plugin-deepbook'
import { readBlob, storeBlobOnChain } from 'lyra-plugin-walrus'

export interface ExecutedAction {
  summary: string
  txUrl: string
  walrusUrl?: string
}

export interface ToolContext {
  cfg: { network: Network; packageId: string }
  client: SuiClient
  owner: Signer
  ownerAddr: string
  policy: SuiPolicy
  policyId: string
  capId: string
}

/** Build the agent's tool set, plus a mutable list collecting executed actions. */
export function buildTools(ctx: ToolContext): { tools: ToolSpec[]; executed: ExecutedAction[] } {
  const { cfg, client, owner, ownerAddr, policy, policyId, capId } = ctx
  const coinType = SUI_TYPE
  const executed: ExecutedAction[] = []
  const receipt = (record: Record<string, unknown>) =>
    storeBlobOnChain(JSON.stringify(record, null, 2), {
      suiClient: client,
      signer: owner,
      network: cfg.network,
      epochs: 2,
    })

  const tools: ToolSpec[] = [
    {
      name: 'get_balances',
      description: 'Get the agent wallet balances (SUI, WAL, and any other coins).',
      parameters: NO_ARGS,
      handler: async () => {
        const b = await getBalances(client, ownerAddr)
        return b.length ? b.map((x) => `${x.symbol}: ${mistToSui(x.total)}`).join(', ') : 'no coins'
      },
    },
    {
      name: 'policy_status',
      description:
        'Inspect the on-chain policy: remaining budget, spent, per-tx cap, allowed protocols, expiry, revoked.',
      parameters: NO_ARGS,
      handler: async () => {
        const s = await getPolicyState(client, policyId)
        if (!s) return 'no policy found'
        return JSON.stringify({
          remainingSui: mistToSui(s.remaining),
          spentSui: mistToSui(s.spent),
          perTxCapSui: mistToSui(s.maxPerTx),
          protocols: s.allowedProtocols,
          revoked: s.revoked,
          expiryMs: s.expiryMs,
        })
      },
    },
    {
      name: 'deepbook_market',
      description: 'Live DeepBook (Sui mainnet) prices and 24h volume for the top pools.',
      parameters: NO_ARGS,
      handler: async () => {
        const s = await getSummary()
        const top = s
          .filter((x) => x.quoteVolume)
          .sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
          .slice(0, 10)
        return top.map((x) => `${x.pool}=${x.lastPrice}`).join(', ')
      },
    },
    {
      name: 'defillama_sui_yields',
      description: 'Top Sui DeFi yield opportunities (project, symbol, APY, TVL) from DefiLlama.',
      parameters: NO_ARGS,
      handler: async () => {
        const r = await fetch('https://yields.llama.fi/pools')
        if (!r.ok) return `defillama error ${r.status}`
        // biome-ignore lint/suspicious/noExplicitAny: external API payload.
        const j = (await r.json()) as any
        const sui = (j.data ?? [])
          // biome-ignore lint/suspicious/noExplicitAny: external API payload.
          .filter((p: any) => p.chain === 'Sui')
          // biome-ignore lint/suspicious/noExplicitAny: external API payload.
          .sort((a: any, b: any) => b.tvlUsd - a.tvlUsd)
          .slice(0, 8)
        // biome-ignore lint/suspicious/noExplicitAny: external API payload.
        return sui
          .map((p: any) => `${p.project} ${p.symbol}: ${Number(p.apy ?? 0).toFixed(2)}% APY, $${Math.round(p.tvlUsd).toLocaleString()} TVL`)
          .join('\n')
      },
    },
    {
      name: 'list_receipts',
      description: 'Recent on-chain action receipts (the audit trail), with Walrus blob ids.',
      parameters: NO_ARGS,
      handler: async () => {
        const r = await queryReceipts(client, cfg.packageId, 10)
        return r.length
          ? r.map((x) => `#${x.seq} ${x.status} ${x.protocol} walrus=${x.walrusBlob}`).join('\n')
          : '(none)'
      },
    },
    {
      name: 'read_memory',
      description: 'Read a previously stored Walrus artifact/memory by its blob id.',
      parameters: { type: 'object', properties: { blobId: { type: 'string' } }, required: ['blobId'] },
      handler: async ({ blobId }: { blobId: string }) => {
        try {
          return (await readBlob(blobId)).slice(0, 1000)
        } catch (e) {
          return `could not read: ${(e as Error).message}`
        }
      },
    },
    {
      name: 'transfer_sui',
      description:
        'Send SUI to a recipient address. Routed through the on-chain policy guard; BLOCKED if it exceeds the policy (cap/budget/protocol/expiry).',
      parameters: {
        type: 'object',
        properties: {
          amountSui: { type: 'number' },
          recipient: { type: 'string', description: '0x Sui address' },
        },
        required: ['amountSui', 'recipient'],
      },
      handler: async ({ amountSui, recipient }: { amountSui: number; recipient: string }) => {
        const amountMist = suiToMist(amountSui)
        const verdict = evaluatePolicy(
          { kind: 'transfer', protocol: 'transfer', coinType, amountRaw: amountMist, to: recipient },
          policy,
        )
        if (!verdict.allowed) return `BLOCKED by policy: ${verdict.violations.join('; ')}`
        const blob = await receipt({
          kind: 'lyra.receipt.v1',
          network: cfg.network,
          policyId,
          agent: ownerAddr,
          action: 'transfer',
          amountSui,
          recipient,
          ts: new Date().toISOString(),
        })
        const tx = new Transaction()
        buildWithdrawTransfer(tx, { packageId: cfg.packageId, coinType, policyId, capId, amountMist, protocol: 'transfer', recipient })
        buildRecord(tx, {
          packageId: cfg.packageId,
          coinType,
          policyId,
          capId,
          protocol: 'transfer',
          summary: `sent ${amountSui} SUI`,
          amountMist,
          coinTypeStr: coinType,
          status: 'executed',
          walrusBlob: blob.blobId,
        })
        const res = await execute(client, owner, tx)
        const u = txUrl(cfg.network, res.digest)
        executed.push({ summary: `sent ${amountSui} SUI to ${recipient}`, txUrl: u, walrusUrl: blob.url })
        return `executed: sent ${amountSui} SUI to ${recipient}. tx=${u} walrus=${blob.url}`
      },
    },
    {
      name: 'store_memory',
      description:
        'Store a durable note/report/strategy on Walrus and record it on-chain as an immutable receipt.',
      parameters: { type: 'object', properties: { memo: { type: 'string' } }, required: ['memo'] },
      handler: async ({ memo }: { memo: string }) => {
        const blob = await receipt({
          kind: 'lyra.memory.v1',
          network: cfg.network,
          policyId,
          agent: ownerAddr,
          memo,
          ts: new Date().toISOString(),
        })
        const tx = new Transaction()
        buildRecord(tx, {
          packageId: cfg.packageId,
          coinType,
          policyId,
          capId,
          protocol: 'walrus',
          summary: String(memo).slice(0, 80),
          amountMist: 0n,
          coinTypeStr: coinType,
          status: 'memory',
          walrusBlob: blob.blobId,
        })
        const res = await execute(client, owner, tx)
        executed.push({ summary: 'stored memory', txUrl: txUrl(cfg.network, res.digest), walrusUrl: blob.url })
        return `stored on Walrus: ${blob.url}`
      },
    },
  ]

  return { tools, executed }
}
