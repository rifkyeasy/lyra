import type { SuiClient } from '@mysten/sui/client'

/** Read helpers for on-chain Lyra state (policy objects, receipt events, balances). */

export interface PolicyState {
  owner: string
  agent: string
  remaining: bigint
  totalDeposited: bigint
  spent: bigint
  maxPerTx: bigint
  maxSlippageBps: number
  allowedProtocols: string[]
  expiryMs: number
  revoked: boolean
  nonce: number
}

/** Fetch and parse an on-chain AgentPolicy object. Returns null if not found. */
export async function getPolicyState(client: SuiClient, policyId: string): Promise<PolicyState | null> {
  const res = await client.getObject({ id: policyId, options: { showContent: true } })
  const content = res.data?.content
  if (!content || content.dataType !== 'moveObject') return null
  // biome-ignore lint/suspicious/noExplicitAny: dynamic Move object fields.
  const f = (content as any).fields
  const bal = f.budget
  const balVal = typeof bal === 'string' ? bal : (bal?.fields?.value ?? bal?.value ?? '0')
  return {
    owner: f.owner,
    agent: f.agent,
    remaining: BigInt(balVal),
    totalDeposited: BigInt(f.total_deposited ?? 0),
    spent: BigInt(f.spent ?? 0),
    maxPerTx: BigInt(f.max_per_tx ?? 0),
    maxSlippageBps: Number(f.max_slippage_bps ?? 0),
    allowedProtocols: f.allowed_protocols ?? [],
    expiryMs: Number(f.expiry_ms ?? 0),
    revoked: !!f.revoked,
    nonce: Number(f.nonce ?? 0),
  }
}

export interface ReceiptEvent {
  policyId: string
  receiptId: string
  seq: number
  protocol: string
  status: string
  walrusBlob: string
  txDigest: string
  timestampMs?: number
}

/** Query the most recent ActionRecorded events (the on-chain audit trail). */
export async function queryReceipts(
  client: SuiClient,
  packageId: string,
  limit = 20,
): Promise<ReceiptEvent[]> {
  const res = await client.queryEvents({
    query: { MoveEventType: `${packageId}::policy::ActionRecorded` },
    limit,
    order: 'descending',
  })
  return res.data.map((e) => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic event payload.
    const j = e.parsedJson as any
    return {
      policyId: j.policy_id,
      receiptId: j.receipt_id,
      seq: Number(j.seq),
      protocol: j.protocol,
      status: j.status,
      walrusBlob: j.walrus_blob,
      txDigest: e.id.txDigest,
      timestampMs: e.timestampMs ? Number(e.timestampMs) : undefined,
    }
  })
}

export interface CoinBalance {
  coinType: string
  symbol: string
  total: bigint
}

/** All coin balances for an address (SUI, WAL, …). */
export async function getBalances(client: SuiClient, owner: string): Promise<CoinBalance[]> {
  const all = await client.getAllBalances({ owner })
  return all.map((b) => ({
    coinType: b.coinType,
    symbol: b.coinType.split('::').pop() ?? b.coinType,
    total: BigInt(b.totalBalance),
  }))
}
