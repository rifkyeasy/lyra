// Server-side AGENT execution for the web console. NON-CUSTODIAL + MULTI-TENANT:
// each owner has a deterministically-derived agent (agent-derive.ts) AND an
// on-chain treasury Vault (lyra::vault). This module signs with the SIGNED-IN
// owner's agent and sources funds from THAT owner's vault via `vault_spend`,
// which re-runs the on-chain policy gate. Funds never sit in the agent's EOA; a
// compromised key is bounded by the policy and revocable by the owner. The
// browser only proves owner identity (SIWS); /api/execute passes the owner here.
import 'server-only'

import { deriveAgentKeypair } from '@/lib/agent-derive'
import type { PendingAction } from '@/lib/chat-store'
import { getAgentSigner, signAndExecute } from '@/lib/signer'
import { CLOCK, PKG, SUI_TYPE, resolveOwnerVault } from '@/lib/vault'
import sevenk from '@7kprotocol/sdk-ts'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'

const isSui = (t: string) => t === SUI_TYPE || t.endsWith('::sui::SUI')
const sui = new SuiClient({ url: getFullnodeUrl('mainnet') })

const enc = (tx: Transaction, s: string) => tx.pure.vector('u8', Array.from(new TextEncoder().encode(s)))

/** Friendly off-chain pre-check (the on-chain vault_spend is the authoritative gate). */
function preCheck(amountMist: bigint, coinTypeIn: string): string | null {
  const maxPerTx = BigInt(Math.round(Number(process.env.LYRA_POLICY_MAX_PER_TX_SUI ?? '1') * 1e9))
  if (isSui(coinTypeIn) && amountMist > maxPerTx) {
    return `amount exceeds the per-tx cap (${Number(maxPerTx) / 1e9} SUI)`
  }
  return null
}

export interface ExecResult {
  ok: boolean
  digest?: string
  route?: string
  amountOut?: string
  error?: string
}

async function executeTransfer(
  action: Extract<PendingAction, { kind: 'transfer' }>,
  owner: string,
  agentAddr: string,
): Promise<ExecResult> {
  if (!isSui(action.coinType)) {
    return { ok: false, error: 'your treasury vault holds SUI — only SUI transfers are vault-backed for now' }
  }
  const amount = BigInt(action.baseUnits)
  const bad = preCheck(amount, action.coinType)
  if (bad) return { ok: false, error: `policy blocked: ${bad}` }

  const ov = await resolveOwnerVault(owner)
  if (!ov) return { ok: false, error: 'no agent vault yet — provision your agent (delegate + fund) first' }
  if (BigInt(ov.vaultMist) < amount) {
    return { ok: false, error: `vault holds ${Number(ov.vaultMist) / 1e9} SUI; deposit more to send this` }
  }

  const tx = new Transaction()
  tx.setSender(agentAddr)
  // vault_transfer enforces the policy's recipient allowlist ON-CHAIN (a prompt-
  // injected agent can't pay an un-allowlisted address even within budget), then
  // draws from the vault via the full policy gate and sends to the recipient.
  tx.moveCall({
    target: `${PKG}::vault::vault_transfer`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(ov.vaultId),
      tx.object(ov.policyId),
      tx.pure.u64(amount),
      tx.pure.address(action.recipient),
      enc(tx, 'web transfer'),
      tx.object(CLOCK),
    ],
  })

  const res = await signAndExecute(sui, owner, tx)
  if (res.effects?.status?.status !== 'success') {
    return { ok: false, error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}` }
  }
  await sui.waitForTransaction({ digest: res.digest })
  return { ok: true, digest: res.digest }
}

async function executeSwap(
  action: Extract<PendingAction, { kind: 'swap' }>,
  owner: string,
  agentAddr: string,
): Promise<ExecResult> {
  if (!isSui(action.fromType)) {
    return { ok: false, error: 'your treasury vault holds SUI — only SUI-funded swaps are vault-backed for now' }
  }
  const amount = BigInt(action.baseUnits)
  const bad = preCheck(amount, action.fromType)
  if (bad) return { ok: false, error: `policy blocked: ${bad}` }

  const ov = await resolveOwnerVault(owner)
  if (!ov) return { ok: false, error: 'no agent vault yet — provision your agent (delegate + fund) first' }
  if (BigInt(ov.vaultMist) < amount) {
    return { ok: false, error: `vault holds ${Number(ov.vaultMist) / 1e9} SUI; deposit more to swap this` }
  }

  const me = agentAddr
  const slippageBps = Number(process.env.LYRA_POLICY_MAX_SLIPPAGE_BPS ?? '100')
  // biome-ignore lint/suspicious/noExplicitAny: 7k default export carries MetaAg
  const ag = new (sevenk as any).MetaAg({ slippageBps })
  const quotes = (
    await ag.quote({ coinTypeIn: action.fromType, coinTypeOut: action.toType, amountIn: action.baseUnits, signer: me })
  )
    .filter(Boolean)
    // biome-ignore lint/suspicious/noExplicitAny: route quote shape from sdk
    .sort((a: any, b: any) => Number(b.amountOut ?? 0) - Number(a.amountOut ?? 0))
  if (!quotes.length) return { ok: false, error: 'no swap route found' }

  // Draw the input from the vault (policy-enforced), route the swap, send the
  // output coin to the owner. Try routes by best output; use the first clean one.
  const failures: string[] = []
  for (const q of quotes) {
    const tx = new Transaction()
    tx.setSender(me)
    tx.setGasBudget(150_000_000)
    try {
      const [coinIn, receipt] = tx.moveCall({
        target: `${PKG}::vault::vault_spend`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(ov.vaultId),
          tx.object(ov.policyId),
          tx.pure.u64(amount),
          tx.pure.address('0x0'),
          enc(tx, 'swap'),
          enc(tx, `swap to ${action.toSymbol}`),
          tx.object(CLOCK),
        ],
      })
      const coinOut = await ag.swap({ quote: q, signer: me, tx, coinIn })
      tx.transferObjects([coinOut, receipt], owner)
      const dr = await sui.dryRunTransactionBlock({ transactionBlock: await tx.build({ client: sui }) })
      if (dr.effects?.status?.status !== 'success') {
        failures.push(`${q.provider}: ${dr.effects?.status?.error ?? 'revert'}`)
        continue
      }
      const res = await signAndExecute(sui, owner, tx)
      if (res.effects?.status?.status !== 'success') {
        failures.push(`${q.provider}: ${res.effects?.status?.error ?? 'exec failed'}`)
        continue
      }
      await sui.waitForTransaction({ digest: res.digest })
      return { ok: true, digest: res.digest, route: String(q.provider), amountOut: String(q.amountOut ?? '') }
    } catch (e) {
      failures.push(`${q.provider}: ${(e as Error).message.slice(0, 50)}`)
    }
  }
  return { ok: false, error: `no route executed cleanly — ${failures.join(' | ')}` }
}

/** Execute `action` with the agent + vault that belong to `owner` (signed-in). */
export async function executeAction(action: PendingAction, owner: string): Promise<ExecResult> {
  try {
    // The agent address comes from the signer (local-derived in dev, or a remote
    // KMS/MPC signer in prod) — the private key never appears in this module.
    const agentAddr = await getAgentSigner().agentAddress(owner)
    if (action.kind === 'transfer') return await executeTransfer(action, owner, agentAddr)
    if (action.kind === 'swap') return await executeSwap(action, owner, agentAddr)
    return { ok: false, error: 'unknown action' }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) }
  }
}

/** The Sui address of the agent that belongs to `owner` (for display / gas float). */
export function agentAddress(owner: string): string | null {
  try {
    return deriveAgentKeypair(owner).toSuiAddress()
  } catch {
    return null
  }
}
