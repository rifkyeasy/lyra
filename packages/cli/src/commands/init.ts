import { existsSync } from 'node:fs'
import { cancel, intro, isCancel, outro, password, select } from '@clack/prompts'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { type LyraNetwork, agentPaths, suiRpcUrl } from 'lyra-core'
import { keypairFromSecret } from 'lyra-plugin-onchain'
import { DEFAULT_NETWORK } from '../config/defaults'
import { finalizeSetup } from '../config/setup'
import { setDotenvVar } from '../util/dotenv'
import { type SuiAgent, loadAgent, writeAgentKey } from '../util/sui-runtime'
import { pickBrainModel } from './init/model-picker'
import { deviceLink, resolveWebBase } from './login'

/**
 * `lyra init` — bootstrap the agent for Sui with ZERO env vars.
 *
 * The user answers ~1 prompt and the CLI works:
 *   1. LLM key — reuse OPENAI_API_KEY if set, else prompt + persist to
 *      `~/.lyra/.env` (mode 0600).
 *   2. Agent — "Create new" (generate a fresh Ed25519 key, written to
 *      `~/.lyra/agent.key`) OR "Login with web" (device-link to lyraai.space →
 *      the SAME agent as the web wallet).
 *   3. Config — network + package id defaults written to `~/.lyra/config.ts`.
 *
 * Non-interactive safe: when stdin is not a TTY, or `--yes` / `--new` is passed,
 * prompts are skipped and init defaults to "Create new" using env-provided keys.
 */
export interface InitOpts {
  resume?: boolean
  /** Skip all prompts; default to "Create new" (CI / non-TTY). */
  yes?: boolean
  /** Force "Create new" even in a TTY (skip the create/login choice). */
  new?: boolean
}

type AgentResolution = { agent: SuiAgent; linkedOwner: string | null }
type ModelPick = Awaited<ReturnType<typeof pickBrainModel>>

/** Returns true when the operator aborted (caller should stop). */
async function promptOverwriteIfExists(
  configPath: string,
  resume: boolean,
  interactive: boolean,
): Promise<boolean> {
  if (!(existsSync(configPath) && !resume && interactive)) return false
  const choice = (await select({
    message: `${configPath} exists`,
    options: [
      { value: 'overwrite', label: 'Start fresh (overwrite)' },
      { value: 'cancel', label: 'Cancel' },
    ],
    initialValue: 'cancel',
  })) as 'overwrite' | 'cancel' | symbol
  if (isCancel(choice) || choice === 'cancel') {
    cancel('Aborted.')
    return true
  }
  return false
}

/**
 * 1) LLM key. Reuse OPENAI_API_KEY if present; else prompt + persist so the
 *    CLI runs keyless next time. In non-interactive mode we just use whatever
 *    the env provides (the CLI falls back to the hosted demo proxy if unset).
 *    Returns true when the operator aborted.
 */
async function promptLlmKey(interactive: boolean): Promise<boolean> {
  if (!(interactive && !process.env.OPENAI_API_KEY && !process.env.LYRA_LLM_API_KEY)) return false
  const key = await password({
    message: 'OpenAI API key (sk-…) — leave blank to use the hosted demo proxy',
  })
  if (isCancel(key)) {
    cancel('Aborted.')
    return true
  }
  const trimmed = (key ?? '').toString().trim()
  if (trimmed) {
    const envPath = setDotenvVar('OPENAI_API_KEY', trimmed)
    console.log(`  saved OPENAI_API_KEY → ${envPath}`)
  }
  return false
}

/** Login with the web wallet; returns null when login fails/cancels. */
async function loginAgent(): Promise<AgentResolution | null> {
  try {
    const result = await deviceLink({
      base: resolveWebBase(),
      fetchImpl: fetch,
      sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
      log: (m: string) => console.log(m),
    })
    // writeAgentKey already ran inside deviceLink; reload from disk.
    const loaded = loadAgent()
    if (!loaded) throw new Error('agent key was not written after login')
    console.log('')
    console.log(`✓ Linked agent ${result.address} (same as your web wallet)`)
    return { agent: loaded, linkedOwner: result.owner }
  } catch (e) {
    cancel(`Login failed: ${(e as Error).message}`)
    return null
  }
}

/** Create a fresh Ed25519 agent and persist the secret. */
function createAgent(): AgentResolution {
  const kp = new Ed25519Keypair()
  const secret = kp.getSecretKey()
  const keyPath = writeAgentKey(secret)
  const agent: SuiAgent = { keypair: keypairFromSecret(secret), address: kp.toSuiAddress() }
  console.log('')
  console.log(`✓ Created agent ${agent.address}`)
  console.log(`  key  ${keyPath} (mode 0600 — back this up; it controls funds)`)
  return { agent, linkedOwner: null }
}

/** 2) Agent: create new (default) or login with web. Null = aborted. */
async function resolveAgent(forceNew: boolean): Promise<AgentResolution | null> {
  let mode: 'create' | 'login' = 'create'
  if (!forceNew) {
    const picked = (await select({
      message: 'How do you want your agent?',
      options: [
        {
          value: 'create',
          label: 'Create new — generate a fresh agent, you hold the key',
        },
        {
          value: 'login',
          label: 'Login with web — use the same agent as lyraai.space',
        },
      ],
      initialValue: 'create',
    })) as 'create' | 'login' | symbol
    if (isCancel(picked)) {
      cancel('Aborted.')
      return null
    }
    mode = picked
  }
  return mode === 'login' ? await loginAgent() : createAgent()
}

/** 3) Network. Skip the prompt when non-interactive (default mainnet). Null = aborted. */
async function promptNetwork(interactive: boolean): Promise<LyraNetwork | null> {
  if (!interactive) return DEFAULT_NETWORK
  const picked = (await select({
    message: 'Which Sui network?',
    options: [
      { value: 'mainnet' as LyraNetwork, label: 'Sui mainnet' },
      { value: 'testnet' as LyraNetwork, label: 'Sui testnet' },
    ],
    initialValue: DEFAULT_NETWORK as LyraNetwork,
  })) as LyraNetwork | symbol
  if (isCancel(picked)) {
    cancel('Aborted.')
    return null
  }
  return picked
}

function buildSummaryLines(params: {
  agentId: string
  agent: SuiAgent
  linkedOwner: string | null
  network: LyraNetwork
  configPath: string
  packageId: string
  modelPick: ModelPick
  telegramEnabled: boolean
}): string[] {
  const {
    agentId,
    agent,
    linkedOwner,
    network,
    configPath,
    packageId,
    modelPick,
    telegramEnabled,
  } = params
  const lines = [
    '',
    `  agent id    ${agentId}`,
    `  agent addr  ${agent.address}`,
    linkedOwner ? `  owner       ${linkedOwner} (linked from web)` : '',
    `  network     ${network} (${suiRpcUrl(network)})`,
    `  config      ${configPath}`,
    `  agent key   ${agentPaths.agentKey}`,
    `  policy pkg  ${packageId}`,
  ].filter(Boolean)
  if (modelPick) lines.push(`  brain       ${modelPick.model ?? '?'} (${modelPick.provider})`)
  if (telegramEnabled) lines.push('  telegram    enabled (TELEGRAM_BOT_TOKEN set)')
  lines.push(
    '',
    'Next: `lyra` to chat · `lyra status` for health · `lyra demo` for the guarded pipeline',
  )
  return lines
}

export async function runInit(opts?: InitOpts): Promise<void> {
  const configPath = agentPaths.config
  const interactive = !!process.stdin.isTTY && !opts?.yes
  const forceNew = !!opts?.new || !interactive

  intro('lyra init')

  if (await promptOverwriteIfExists(configPath, !!opts?.resume, interactive)) return
  if (await promptLlmKey(interactive)) return

  const resolved = await resolveAgent(forceNew)
  if (!resolved) return
  const { agent, linkedOwner } = resolved

  const network = await promptNetwork(interactive)
  if (network === null) return

  const modelPick = await pickBrainModel()
  const telegramEnabled = !!process.env.TELEGRAM_BOT_TOKEN

  const { agentId, packageId } = await finalizeSetup({
    agentAddress: agent.address,
    linkedOwner,
    network,
    brainProvider: modelPick?.provider ?? null,
    brainModel: modelPick?.model ?? null,
  })
  const lines = buildSummaryLines({
    agentId,
    agent,
    linkedOwner,
    network,
    configPath,
    packageId,
    modelPick,
    telegramEnabled,
  })
  outro(lines.join('\n'))
}
