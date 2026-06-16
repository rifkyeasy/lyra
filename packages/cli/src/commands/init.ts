import { mkdir, writeFile } from 'node:fs/promises'
import { Transaction } from '@mysten/sui/transactions'
import * as p from '@clack/prompts'
import { generateKeypair, loadConfig, loadKeypair, SUI_TYPE, suiToMist } from 'lyra-core'
import { buildCreatePolicy, createdObjectByType, execute, makeClient, txUrl } from 'lyra-plugin-sui'
import pc from 'picocolors'
import { upsertEnv } from '../util/env'

/** Bootstrap wizard: agent key, network, model, policy, and (optionally) the
 * on-chain policy object — written to .env / .lyra. */
export async function runInit(): Promise<void> {
  p.intro(`${pc.bold(pc.magenta('Lyra init'))} — bootstrap a policy-bound Sui agent`)

  const network = await p.select({
    message: 'Network',
    initialValue: 'mainnet',
    options: [
      { value: 'mainnet', label: 'Sui mainnet' },
      { value: 'testnet', label: 'Sui testnet' },
    ],
  })
  if (p.isCancel(network)) return void p.cancel('cancelled')

  const keyMode = await p.select({
    message: 'Agent key',
    options: [
      ...(process.env.LYRA_AGENT_KEY ? [{ value: 'keep', label: 'Keep existing LYRA_AGENT_KEY' }] : []),
      { value: 'generate', label: 'Generate a new key' },
      { value: 'import', label: 'Paste an existing suiprivkey…' },
    ],
  })
  if (p.isCancel(keyMode)) return void p.cancel('cancelled')

  let agentKey: string | undefined
  if (keyMode === 'generate') {
    const kp = generateKeypair()
    agentKey = kp.getSecretKey()
    p.note(
      `${kp.toSuiAddress()}\n${pc.yellow('Fund this address with SUI (and WAL for Walrus) before running the agent.')}`,
      'new agent address',
    )
  } else if (keyMode === 'import') {
    const k = await p.password({ message: 'suiprivkey1…' })
    if (p.isCancel(k)) return void p.cancel('cancelled')
    agentKey = (k as string).trim()
  }
  const effectiveKey = agentKey ?? process.env.LYRA_AGENT_KEY
  const addr = effectiveKey ? loadKeypair(effectiveKey).toSuiAddress() : '(no key)'

  const model = await p.select({
    message: 'LLM model',
    initialValue: 'gpt-4o-mini',
    options: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'].map((v) => ({ value: v, label: v })),
  })
  if (p.isCancel(model)) return void p.cancel('cancelled')

  const budget = await p.text({ message: 'Budget to lock in the policy (SUI)', initialValue: '0.05' })
  if (p.isCancel(budget)) return void p.cancel('cancelled')
  const cap = await p.text({ message: 'Per-transaction cap (SUI)', initialValue: '0.02' })
  if (p.isCancel(cap)) return void p.cancel('cancelled')
  const protocols = await p.text({
    message: 'Allowed protocols (comma-separated)',
    initialValue: 'transfer,deepbook,walrus',
  })
  if (p.isCancel(protocols)) return void p.cancel('cancelled')
  const expiry = await p.text({ message: 'Policy expiry (minutes)', initialValue: '60' })
  if (p.isCancel(expiry)) return void p.cancel('cancelled')

  const protoList = (protocols as string)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const env: Record<string, string> = {
    LYRA_NETWORK: network as string,
    LYRA_LLM_MODEL: model as string,
    LYRA_POLICY_MAX_PER_TX_SUI: cap as string,
    LYRA_POLICY_ALLOWED_PROTOCOLS: protoList.join(','),
    LYRA_POLICY_EXPIRY_MINUTES: expiry as string,
    WALRUS_NETWORK: network as string,
  }
  if (agentKey) env.LYRA_AGENT_KEY = agentKey
  await upsertEnv(env)

  const cfg = loadConfig({ ...process.env, ...env })
  if (effectiveKey && cfg.packageId) {
    const createNow = await p.confirm({
      message: `Create the on-chain policy now? (locks ${budget as string} SUI on ${network as string})`,
      initialValue: false,
    })
    if (!p.isCancel(createNow) && createNow) {
      const owner = loadKeypair(effectiveKey)
      const client = makeClient(cfg.network)
      const s = p.spinner()
      s.start('creating policy on-chain')
      try {
        const tx = new Transaction()
        buildCreatePolicy(tx, {
          packageId: cfg.packageId,
          coinType: SUI_TYPE,
          agent: owner.toSuiAddress(),
          budgetMist: suiToMist(budget as string),
          maxPerTxMist: suiToMist(cap as string),
          maxSlippageBps: 100,
          allowedProtocols: protoList,
          expiryMs: Date.now() + Number(expiry) * 60_000,
        })
        const res = await execute(client, owner, tx)
        const policyId = createdObjectByType(res, '::policy::AgentPolicy<')
        const capId = createdObjectByType(res, '::policy::AgentCap')
        await mkdir('.lyra', { recursive: true })
        await writeFile(
          '.lyra/policy.json',
          JSON.stringify({ packageId: cfg.packageId, policyId, capId, createdAt: new Date().toISOString() }, null, 2),
        )
        s.stop(`policy created · ${txUrl(cfg.network, res.digest)}`)
      } catch (e) {
        s.stop(pc.red(`failed: ${(e as Error).message.slice(0, 160)}`))
      }
    }
  }

  p.outro(`${pc.green('Ready.')} Agent ${pc.dim(`${addr.slice(0, 12)}…`)} · try ${pc.cyan('lyra status')} then ${pc.cyan('lyra chat')}`)
}
