import { existsSync, statSync } from 'node:fs'
import { agentPaths, formatSui, getSuiBalanceMist, makeSuiClient, suiRpcUrl } from 'lyra-core'
import { type SuiPolicy, policyFromEnv } from 'lyra-plugin-onchain'
import { resolvePackageId, resolvePolicyEnv } from '../config/defaults'
import { findAndLoadConfig } from '../config/load'
import { loadAgent } from '../util/sui-runtime'
import { listAgentIds } from './_agents'

export async function runStatus(opts?: { cwd?: string }): Promise<void> {
  const cwd = opts?.cwd ?? process.cwd()
  const found = await findAndLoadConfig(cwd)
  if (!found) {
    console.log('No lyra.config.ts found. Run `lyra init` first.')
    process.exit(1)
  }
  const { config, path } = found

  const agent = loadAgent()
  const agentAddress = agent?.address ?? config.identity.agent ?? '(no agent key — run `lyra init`)'

  console.log(`config    ${path}`)
  console.log(`network   ${config.network}`)
  console.log(`rpc       ${suiRpcUrl(config.network)}`)
  console.log(`plugins   ${config.plugins.join(', ')}`)
  console.log(`agent     ${agentAddress}`)
  console.log(`brain     ${config.brain.provider ?? '(not picked)'}`)

  // lyra::policy package + active deterministic policy summary.
  const packageId = resolvePackageId()
  console.log(`policy pkg ${packageId}`)
  const policyObjectId = process.env.LYRA_POLICY_OBJECT_ID
  if (policyObjectId) console.log(`policy obj ${policyObjectId}`)
  const policy = policyFromEnv(resolvePolicyEnv())
  if (policy) {
    console.log(`policy     ${summarizePolicy(policy)}`)
  } else {
    console.log('policy     (none configured — set LYRA_POLICY_* to bound the agent)')
  }

  // Live SUI balance for the agent (pays gas for every PTB).
  if (agent) {
    try {
      const client = makeSuiClient(config.network)
      const mist = await getSuiBalanceMist(client, agent.address)
      console.log(`balance   ${formatSui(mist)} SUI`)
    } catch (e) {
      console.log(`balance   (rpc error: ${(e as Error).message.slice(0, 80)})`)
    }
  }

  const ids = await listAgentIds()
  if (ids.length === 0) {
    console.log('\nNo agents found in ~/.lyra/agents. Re-run `lyra init`.')
    return
  }

  for (const id of ids) {
    console.log('')
    console.log(`agent dir ${id}`)
    console.log(`dir       ${agentPaths.agent(id).dir}`)
    const activityPath = agentPaths.agent(id).activityLog
    if (existsSync(activityPath)) {
      const sz = statSync(activityPath).size
      console.log(`activity  ${sz} bytes`)
    }
  }
}

/** One-line summary of the deterministic off-chain policy mirror. */
function summarizePolicy(policy: SuiPolicy): string {
  const parts: string[] = []
  const autonomy = policy.autonomy ?? (policy.readOnly ? 'readonly' : 'auto')
  parts.push(`autonomy=${autonomy}`)
  if (policy.maxMistPerTx !== undefined)
    parts.push(`maxPerTx=${formatSui(policy.maxMistPerTx)} SUI`)
  if (policy.autoMaxMistPerTx !== undefined)
    parts.push(`autoMax=${formatSui(policy.autoMaxMistPerTx)} SUI`)
  if (policy.maxSlippageBps !== undefined) parts.push(`slippage=${policy.maxSlippageBps}bps`)
  if (policy.coinAllowlist?.length) parts.push(`coins=${policy.coinAllowlist.length}`)
  if (policy.protocolAllowlist?.length) parts.push(`protocols=${policy.protocolAllowlist.length}`)
  if (policy.recipientAllowlist?.length)
    parts.push(`recipients=${policy.recipientAllowlist.length}`)
  if (policy.expiryMs) parts.push(`expires=${new Date(policy.expiryMs).toISOString().slice(0, 16)}`)
  return parts.join(', ')
}
