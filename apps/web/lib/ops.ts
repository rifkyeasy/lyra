// Operational helpers: a configurable Sui RPC (point at a dedicated/paid node in
// production via LYRA_RPC_URL instead of the shared public fullnode) and a
// structured audit log for value-moving actions. Every agent execution emits one
// JSON line so a log pipeline (Loki / CloudWatch / Datadog) can alert + audit:
// who (owner/agent), what (kind/amount/recipient), and the on-chain digest.
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'

export function suiRpcUrl(): string {
  return process.env.LYRA_RPC_URL || getFullnodeUrl('mainnet')
}

export function webSuiClient(): SuiClient {
  return new SuiClient({ url: suiRpcUrl() })
}

export interface ActionLog {
  owner: string
  agent?: string
  kind: 'transfer' | 'swap'
  amount: string
  coin?: string
  recipient?: string
  route?: string
  ok: boolean
  digest?: string
  error?: string
}

/** Emit one structured JSON line per value-moving action (audit + ops trail). */
export function logAction(entry: ActionLog): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), evt: 'agent.action', ...entry }))
  } catch {
    // logging must never break execution
  }
}
