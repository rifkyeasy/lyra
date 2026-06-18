/**
 * `lyra demo` — walk the guarded pipeline end to end using the lyra-plugin-onchain
 * tools and the deterministic policy engine.
 *
 * Steps:
 *   1. policy.show           — print the active fund-control policy.
 *   2. blocked over-cap send — evaluatePolicy on an amount above the per-tx cap;
 *                              demonstrates a BLOCKED unsafe action (no network).
 *   3. policy.create         — publish an on-chain lyra::policy AgentPolicy   (--yes)
 *   4. sui.send              — a small in-cap transfer to self                (--yes)
 *   5. walrus.store          — store the run receipt durably on Walrus        (--yes)
 *
 * Steps 3–5 move value / write on-chain, so they run ONLY with `--yes`. The
 * default run is read-only + deterministic: it proves the policy blocks an
 * over-cap action and explains what the write path would do.
 */

import { formatSui, getSuiBalanceMist } from 'lyra-core'
import onchainPlugin, {
  type OnchainRuntimeContext,
  type SuiPolicy,
  evaluatePolicy,
  makeSuiClient,
  policyFromEnv,
  suiToMist,
} from 'lyra-plugin-onchain'
import { findAndLoadConfig } from '../config/load'
import { buildOnchainContext, loadAgent } from '../util/sui-runtime'

const SUI_TYPE = '0x2::sui::SUI'

export interface DemoOpts {
  yes?: boolean
}

interface DemoTool {
  name: string
  handler: (args: unknown) => Promise<unknown>
}

/**
 * Drive the plugin's own `register` against a minimal collector so we get the
 * exact ToolDefs the chat agent uses — without reaching past the public API.
 */
function collectOnchainTools(onchain: OnchainRuntimeContext): Map<string, DemoTool> {
  const tools = new Map<string, DemoTool>()
  const ctx = {
    onchain,
    registerTool: (t: DemoTool) => tools.set(t.name, t),
  }
  onchainPlugin.register(ctx as unknown as Parameters<typeof onchainPlugin.register>[0])
  return tools
}

export async function runDemo(opts: DemoOpts = {}): Promise<void> {
  const found = await findAndLoadConfig()
  if (!found) {
    console.log('No lyra.config.ts found. Run `lyra init` first.')
    process.exit(1)
  }
  const { config } = found

  const agent = loadAgent()
  if (!agent) {
    console.log('No agent key found. Run `lyra init` first.')
    process.exit(1)
  }

  console.log(`lyra demo — agent ${agent.address} on ${config.network}\n`)

  const onchain = buildOnchainContext({
    agent,
    network: config.network,
    agentDir: found.path,
    brainProvider: config.brain.provider,
    brainModel: config.brain.model,
  })
  const tools = collectOnchainTools(onchain)

  // ── Step 1: policy.show ────────────────────────────────────────────────
  console.log('1) policy.show')
  const policy = policyFromEnv()
  if (!policy) {
    console.log(
      '   (no LYRA_POLICY_* configured — set LYRA_POLICY_MAX_PER_TX_SUI to bound the agent)\n',
    )
  } else {
    console.log(`   ${describePolicy(policy)}\n`)
  }

  // ── Step 2: blocked over-cap send (deterministic, no network) ──────────
  console.log('2) blocked over-cap send (policy enforcement)')
  if (policy?.maxMistPerTx !== undefined) {
    const overCap = policy.maxMistPerTx + (suiToMist('1') ?? 0n) // 1 SUI over the cap
    const verdict = evaluatePolicy(
      {
        kind: 'transfer',
        coinType: SUI_TYPE,
        amountMist: overCap,
        to: agent.address,
        protocol: 'transfer',
      },
      policy,
    )
    if (!verdict.allowed) {
      console.log(
        `   send ${formatSui(overCap)} SUI → BLOCKED ✓  (${verdict.violations.join('; ')})\n`,
      )
    } else {
      console.log(`   send ${formatSui(overCap)} SUI was allowed (cap not enforced?)\n`)
    }
  } else {
    console.log('   skipped: no per-tx cap configured (set LYRA_POLICY_MAX_PER_TX_SUI)\n')
  }

  // ── Live balance (read-only) ────────────────────────────────────────────
  try {
    const client = makeSuiClient(config.network)
    const mist = await getSuiBalanceMist(client, agent.address)
    console.log(`   agent SUI balance: ${formatSui(mist)} SUI\n`)
  } catch {
    // RPC unavailable — fine, the rest is descriptive.
  }

  // ── Steps 3–5: write path ────────────────────────────────────────────────
  if (!opts.yes) {
    console.log('3-5) write path (policy.create → sui.send → walrus.store)')
    console.log('   dry run. Re-run `lyra demo --yes` to execute the on-chain steps:')
    console.log('     • policy.create — publish a shared lyra::policy AgentPolicy')
    console.log(
      '     • sui.send      — a small in-cap transfer to self (policy + simulate + execute)',
    )
    console.log('     • walrus.store  — store the run receipt durably on Walrus')
    return
  }

  console.log('3) policy.create')
  await runTool(tools, 'policy.create', { budgetSui: '1', maxPerTxSui: '0.1', maxSlippageBps: 100 })

  console.log('4) sui.send (in-cap, to self)')
  await runTool(tools, 'sui.send', { to: agent.address, amount: '0.001' })

  console.log('5) walrus.store (run receipt)')
  await runTool(tools, 'walrus.store', {
    content: JSON.stringify({ demo: 'lyra', agent: agent.address, ts: Date.now() }),
  })
}

async function runTool(
  tools: Map<string, DemoTool>,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const tool = tools.get(name)
  if (!tool) {
    console.log(`   tool ${name} not registered; skipped`)
    console.log('')
    return
  }
  try {
    const res = (await tool.handler(args)) as { ok?: boolean; error?: string; data?: unknown }
    if (res.ok === false) console.log(`   ${name} failed: ${res.error}`)
    else console.log(`   ${name} ok: ${JSON.stringify(res.data)}`)
  } catch (e) {
    console.log(`   ${name} threw: ${(e as Error).message.slice(0, 200)}`)
  }
  console.log('')
}

function describePolicy(p: SuiPolicy): string {
  const parts: string[] = []
  if (p.maxMistPerTx !== undefined) parts.push(`maxPerTx=${formatSui(p.maxMistPerTx)} SUI`)
  if (p.autoMaxMistPerTx !== undefined) parts.push(`autoMax=${formatSui(p.autoMaxMistPerTx)} SUI`)
  if (p.autonomy) parts.push(`autonomy=${p.autonomy}`)
  if (p.readOnly) parts.push('READ-ONLY')
  return parts.length ? parts.join(', ') : '(no caps set)'
}
