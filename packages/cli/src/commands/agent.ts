/**
 * The Lyra agent runtime — Nebula's agentic loop, on Sui.
 *
 *   goal -> LLM tool-loop (read state, then act) -> policy + on-chain guard -> Walrus
 *
 * `runGoal` is shared by the CLI (`lyra agent` / chat TUI) and the gateway. The
 * LLM drives a multi-step loop over the tool set (balances, DeepBook, DefiLlama,
 * policy, receipts, transfer, memory); every write tool enforces the policy and
 * the on-chain guard internally, so the loop is autonomous but always bounded.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Transaction } from '@mysten/sui/transactions'
import {
  type AgentEvent,
  brainFromEnv,
  loadConfig,
  loadKeypair,
  mistToSui,
  policyFromEnv,
  runAgent,
  SUI_TYPE,
  suiToMist,
} from 'lyra-core'
import { buildCreatePolicy, createdObjectByType, execute, makeClient, txUrl } from 'lyra-plugin-sui'
import { buildTools, type ExecutedAction } from '../agent/tools'

const cfg = loadConfig()
const client = makeClient(cfg.network)
const brain = brainFromEnv()
const policy = policyFromEnv()
const coinType = SUI_TYPE
const POLICY_FILE = '.lyra/policy.json'

function reqEnv(k: string): string {
  const v = process.env[k]
  if (!v) throw new Error(`${k} is required`)
  return v
}
const owner = loadKeypair(reqEnv('LYRA_AGENT_KEY'))
const ownerAddr = owner.toSuiAddress()

interface PolicyRef {
  packageId: string
  policyId: string
  capId: string
}

export interface GoalResult {
  goal: string
  finalText: string
  events: AgentEvent[]
  executed: ExecutedAction[]
}

async function ensurePolicy(log: (s: string) => void): Promise<PolicyRef> {
  if (existsSync(POLICY_FILE)) {
    const j = JSON.parse(await readFile(POLICY_FILE, 'utf8')) as PolicyRef
    if (j.packageId === cfg.packageId && j.policyId && j.capId) return j
  }
  const allowedProtocols = policy.allowedProtocols ?? ['transfer', 'walrus', 'deepbook']
  const expiryMs = policy.expiryMs ?? Date.now() + 60 * 60_000
  const tx = new Transaction()
  buildCreatePolicy(tx, {
    packageId: cfg.packageId,
    coinType,
    agent: ownerAddr,
    budgetMist: suiToMist(0.05),
    maxPerTxMist: policy.maxNativeMistPerTx ?? suiToMist(0.02),
    maxSlippageBps: policy.maxSlippageBps ?? 100,
    allowedProtocols,
    expiryMs,
  })
  const res = await execute(client, owner, tx)
  const policyId = createdObjectByType(res, '::policy::AgentPolicy<')
  const capId = createdObjectByType(res, '::policy::AgentCap')
  if (!policyId || !capId) throw new Error('failed to create policy')
  const ref: PolicyRef = { packageId: cfg.packageId, policyId, capId }
  await mkdir('.lyra', { recursive: true })
  await writeFile(POLICY_FILE, JSON.stringify({ ...ref, createdAt: new Date().toISOString() }, null, 2))
  log(`policy : created ${policyId}\n         ${txUrl(cfg.network, res.digest)}`)
  return ref
}

function systemPrompt(): string {
  const cap = mistToSui(policy.maxNativeMistPerTx ?? suiToMist(0.02))
  const protos = (policy.allowedProtocols ?? ['transfer', 'walrus']).join(', ')
  return `You are Lyra, a Sui-native autonomous finance agent running on ${cfg.network}. You help the user by calling tools to inspect on-chain/market state and to act. You are ADVISORY: every write tool enforces a deterministic policy and an on-chain Move guard, so you cannot exceed the user's bounds even if you try.

Active policy:
- per-transaction cap: ${cap} SUI
- allowed protocols: [${protos}]
- autonomy: ${policy.autonomy ?? 'auto'}
- a total budget is held in an on-chain policy object; spends draw from it.

Guidance:
- Use read tools (get_balances, policy_status, deepbook_market, defillama_sui_yields, list_receipts) to gather facts before acting.
- Use transfer_sui / store_memory to act. If a write is blocked by policy, explain why and stop — do not retry to circumvent it.
- "send to me" / "myself" → the owner address ${ownerAddr}.
- Be concise. End with a short plain-English summary of what you did or found.`
}

function logEvent(e: AgentEvent): void {
  if (e.type === 'tool-call') {
    console.log(`  ⏺ ${e.name}${e.args && e.args !== '{}' ? `(${e.args})` : '()'}`)
  } else if (e.type === 'tool-result') {
    const first = (e.text.split('\n')[0] ?? '').slice(0, 140)
    console.log(`    ⎿ ${first}`)
  } else if (e.type === 'assistant' && e.text.trim()) {
    console.log(`\n${e.text}`)
  }
}

export async function runGoal(
  goal: string,
  opts: { log?: boolean; onEvent?: (e: AgentEvent) => void } = {},
): Promise<GoalResult> {
  const log = (s: string) => {
    if (opts.log) console.log(s)
  }
  log(`Lyra · ${cfg.network} · package ${cfg.packageId.slice(0, 10)}…`)
  log(`goal   : "${goal}"\n`)

  const { policyId, capId } = await ensurePolicy(log)
  const { tools, executed } = buildTools({ cfg, client, owner, ownerAddr, policy, policyId, capId })

  const events: AgentEvent[] = []
  const onEvent = (e: AgentEvent) => {
    events.push(e)
    if (opts.log) logEvent(e)
    opts.onEvent?.(e)
  }

  const finalText = await runAgent(goal, brain, { system: systemPrompt(), tools, onEvent, maxSteps: 8 })
  return { goal, finalText, events, executed }
}
