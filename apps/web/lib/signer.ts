// AgentSigner — decouples WHERE the agent key lives from the execution code, so
// the same code runs against:
//   • LocalDerivedSigner (dev / single box): derives the key in-process from
//     LYRA_MASTER_SECRET. Simple, but the master lives in the app process.
//   • RemoteSigner (production): an external signer service (KMS / MPC such as
//     Turnkey or Lit / an AWS Nitro enclave) holds the keys and returns only a
//     signature. The master + agent keys NEVER touch the app process — the
//     recommended posture, including on a self-hosted VPS (isolate the signer in
//     a separate hardened process and point LYRA_SIGNER_URL at it).
//
// Execution code calls `signAndExecute(owner, tx)` and never sees a private key.
import 'server-only'

import { deriveAgentKeypair } from '@/lib/agent-derive'
import type { SuiClient, SuiTransactionBlockResponse } from '@mysten/sui/client'
import { toBase64 } from '@mysten/sui/utils'
import type { Transaction } from '@mysten/sui/transactions'

export interface AgentSigner {
  /** The Sui address of `owner`'s agent. */
  agentAddress(owner: string): Promise<string>
  /** Sign the built transaction bytes for `owner`'s agent; return the signature. */
  signTransaction(owner: string, txBytes: Uint8Array): Promise<string>
}

/** Dev / single-box signer: derives the agent key in-process. */
class LocalDerivedSigner implements AgentSigner {
  async agentAddress(owner: string): Promise<string> {
    return deriveAgentKeypair(owner).toSuiAddress()
  }
  async signTransaction(owner: string, txBytes: Uint8Array): Promise<string> {
    const { signature } = await deriveAgentKeypair(owner).signTransaction(txBytes)
    return signature
  }
}

/**
 * Production signer: an external service holds the keys. The app POSTs
 * {owner, txBytes}; the service returns a signature. Implement the endpoint with
 * Turnkey / Lit / a Nitro enclave / an isolated signer process. Keys stay out of
 * the app process entirely.
 */
class RemoteSigner implements AgentSigner {
  constructor(
    private readonly url: string,
    private readonly apiKey?: string,
  ) {}
  private headers() {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    }
  }
  async agentAddress(owner: string): Promise<string> {
    const r = await fetch(`${this.url}/agent-address`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ owner }),
    })
    if (!r.ok) throw new Error(`remote signer agent-address ${r.status}`)
    return (await r.json()).address
  }
  async signTransaction(owner: string, txBytes: Uint8Array): Promise<string> {
    const r = await fetch(`${this.url}/sign`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ owner, txBytes: toBase64(txBytes) }),
    })
    if (!r.ok) throw new Error(`remote signer sign ${r.status}`)
    return (await r.json()).signature
  }
}

/** Select the signer from env: a remote signer if configured, else local. */
export function getAgentSigner(): AgentSigner {
  const url = process.env.LYRA_SIGNER_URL
  return url ? new RemoteSigner(url, process.env.LYRA_SIGNER_API_KEY) : new LocalDerivedSigner()
}

/** Build → sign (via the configured signer) → execute. The key never appears here. */
export async function signAndExecute(
  client: SuiClient,
  owner: string,
  tx: Transaction,
  signer: AgentSigner = getAgentSigner(),
): Promise<SuiTransactionBlockResponse> {
  const txBytes = await tx.build({ client })
  const signature = await signer.signTransaction(owner, txBytes)
  return client.executeTransactionBlock({
    transactionBlock: txBytes,
    signature,
    options: { showEffects: true },
  })
}
