// Server-side AGENT execution for the web console. The policy-bound agent wallet
// (LYRA_AGENT_KEY) signs + pays — identical model to the CLI / gateway / Telegram.
// The browser never signs: the connected wallet only proves owner identity (SIWS
// session); this module, gated by /api/execute, runs the action with the agent
// key, enforcing the same LYRA_POLICY_* guardrails before broadcasting.
import 'server-only'

import type { PendingAction } from '@/lib/chat-store'
import sevenk from '@7kprotocol/sdk-ts'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction, coinWithBalance } from '@mysten/sui/transactions'

const SUI_TYPE = '0x2::sui::SUI'
const isSui = (t: string) => t === SUI_TYPE || t.endsWith('::sui::SUI')

const sui = new SuiClient({ url: getFullnodeUrl('mainnet') })

function agentKeypair(): Ed25519Keypair {
  const secret = process.env.LYRA_AGENT_KEY
  if (!secret) throw new Error('agent key not configured on the server (LYRA_AGENT_KEY)')
  return Ed25519Keypair.fromSecretKey(secret.trim())
}

/** Off-chain mirror of the AgentPolicy — the same LYRA_POLICY_* vars the CLI reads. */
function policyCheck(opts: { coinTypeIn: string; amountMist: bigint; coinTypeOut?: string }): string | null {
  const maxPerTxSui = Number(process.env.LYRA_POLICY_MAX_PER_TX_SUI ?? '1')
  const maxPerTx = BigInt(Math.round(maxPerTxSui * 1e9))
  if (isSui(opts.coinTypeIn) && opts.amountMist > maxPerTx) {
    return `amount ${opts.amountMist} MIST exceeds per-tx cap ${maxPerTx} MIST`
  }
  const allowed = (process.env.LYRA_POLICY_ALLOWED_COINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (allowed.length > 0) {
    if (!allowed.includes(opts.coinTypeIn)) return `input coin ${opts.coinTypeIn} not in policy allowlist`
    if (opts.coinTypeOut && !allowed.includes(opts.coinTypeOut)) {
      return `output coin ${opts.coinTypeOut} not in policy allowlist`
    }
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

async function executeTransfer(action: Extract<PendingAction, { kind: 'transfer' }>): Promise<ExecResult> {
  const amount = BigInt(action.baseUnits)
  const violation = policyCheck({ coinTypeIn: action.coinType, amountMist: amount })
  if (violation) return { ok: false, error: `policy blocked: ${violation}` }

  const kp = agentKeypair()
  const tx = new Transaction()
  tx.setSender(kp.toSuiAddress())
  const coin = isSui(action.coinType)
    ? tx.splitCoins(tx.gas, [amount])[0]
    : coinWithBalance({ type: action.coinType, balance: amount })
  tx.transferObjects([coin], action.recipient)

  const res = await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } })
  if (res.effects?.status?.status !== 'success') {
    return { ok: false, error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}` }
  }
  await sui.waitForTransaction({ digest: res.digest })
  return { ok: true, digest: res.digest }
}

async function executeSwap(action: Extract<PendingAction, { kind: 'swap' }>): Promise<ExecResult> {
  const amount = BigInt(action.baseUnits)
  const violation = policyCheck({ coinTypeIn: action.fromType, amountMist: amount, coinTypeOut: action.toType })
  if (violation) return { ok: false, error: `policy blocked: ${violation}` }

  const kp = agentKeypair()
  const me = kp.toSuiAddress()
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

  // Try routes by best output, dry-run each, execute the first that simulates.
  const failures: string[] = []
  for (const q of quotes) {
    const tx = new Transaction()
    tx.setSender(me)
    tx.setGasBudget(150_000_000)
    try {
      const coinIn = isSui(action.fromType)
        ? tx.splitCoins(tx.gas, [amount])[0]
        : coinWithBalance({ type: action.fromType, balance: amount })
      const coinOut = await ag.swap({ quote: q, signer: me, tx, coinIn })
      tx.transferObjects([coinOut], me)
      const dr = await sui.dryRunTransactionBlock({ transactionBlock: await tx.build({ client: sui }) })
      if (dr.effects?.status?.status !== 'success') {
        failures.push(`${q.provider}: ${dr.effects?.status?.error ?? 'revert'}`)
        continue
      }
      const res = await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } })
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

export async function executeAction(action: PendingAction): Promise<ExecResult> {
  try {
    if (action.kind === 'transfer') return await executeTransfer(action)
    if (action.kind === 'swap') return await executeSwap(action)
    return { ok: false, error: 'unknown action' }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) }
  }
}

/** The agent's own Sui address (server-derived), for display / owner checks. */
export function agentAddress(): string | null {
  try {
    return agentKeypair().toSuiAddress()
  } catch {
    return null
  }
}
