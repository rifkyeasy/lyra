import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cancel, intro, isCancel, outro, password, select } from '@clack/prompts'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import {
  type LyraNetwork,
  agentPaths,
  defineConfig,
  placeholderAgentId,
  suiRpcUrl,
} from 'lyra-core'
import { keypairFromSecret } from 'lyra-plugin-onchain'
import { DEFAULT_NETWORK, resolvePackageId } from '../config/defaults'
import { writeConfigTs } from '../config/render'
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

export async function runInit(opts?: InitOpts): Promise<void> {
  const configPath = agentPaths.config
  const interactive = !!process.stdin.isTTY && !opts?.yes
  const forceNew = !!opts?.new || !interactive

  intro('lyra init')

  if (existsSync(configPath) && !opts?.resume && interactive) {
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
      return
    }
  }

  // 1) LLM key. Reuse OPENAI_API_KEY if present; else prompt + persist so the
  //    CLI runs keyless next time. In non-interactive mode we just use whatever
  //    the env provides (the CLI falls back to the hosted demo proxy if unset).
  if (interactive && !process.env.OPENAI_API_KEY && !process.env.LYRA_LLM_API_KEY) {
    const key = await password({
      message: 'OpenAI API key (sk-…) — leave blank to use the hosted demo proxy',
    })
    if (isCancel(key)) {
      cancel('Aborted.')
      return
    }
    const trimmed = (key ?? '').toString().trim()
    if (trimmed) {
      const envPath = setDotenvVar('OPENAI_API_KEY', trimmed)
      console.log(`  saved OPENAI_API_KEY → ${envPath}`)
    }
  }

  // 2) Agent: create new (default) or login with web.
  let agent: SuiAgent
  let linkedOwner: string | null = null

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
      return
    }
    mode = picked
  }

  if (mode === 'login') {
    try {
      const result = await deviceLink({
        base: resolveWebBase(),
        fetchImpl: fetch,
        sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
        log: (m: string) => console.log(m),
      })
      linkedOwner = result.owner
      // writeAgentKey already ran inside deviceLink; reload from disk.
      const loaded = loadAgent()
      if (!loaded) throw new Error('agent key was not written after login')
      agent = loaded
      console.log('')
      console.log(`✓ Linked agent ${result.address} (same as your web wallet)`)
    } catch (e) {
      cancel(`Login failed: ${(e as Error).message}`)
      return
    }
  } else {
    // Create new: generate a fresh Ed25519 agent and persist the secret.
    const kp = new Ed25519Keypair()
    const secret = kp.getSecretKey()
    const keyPath = writeAgentKey(secret)
    agent = { keypair: keypairFromSecret(secret), address: kp.toSuiAddress() }
    console.log('')
    console.log(`✓ Created agent ${agent.address}`)
    console.log(`  key  ${keyPath} (mode 0600 — back this up; it controls funds)`)
  }

  // 3) Network. Skip the prompt when non-interactive (default mainnet).
  let network: LyraNetwork = DEFAULT_NETWORK
  if (interactive) {
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
      return
    }
    network = picked
  }

  const modelPick = await pickBrainModel()

  const agentId = placeholderAgentId(agent.address)
  const paths = agentPaths.agent(agentId)
  await mkdir(paths.dir, { recursive: true })

  // Telegram is env-driven on Sui (TELEGRAM_BOT_TOKEN). Auto-enable the plugin
  // when the token is present so `lyra` brings the DM gateway online.
  const telegramEnabled = !!process.env.TELEGRAM_BOT_TOKEN

  await seedStarterMemoryFiles({
    paths,
    network,
    agentAddress: agent.address,
    brainProvider: modelPick?.provider ?? null,
    brainModel: modelPick?.model ?? null,
  })

  const cfg = defineConfig({
    identity: {
      operator: linkedOwner,
      agent: agent.address,
    },
    network,
    storage: { network },
    brain: {
      provider: modelPick?.provider ?? null,
      model: modelPick?.model ?? null,
    },
    plugins: telegramEnabled ? ['onchain', 'system', 'telegram'] : ['onchain', 'system'],
    tools: {},
    imports: { claudeCode: true },
  })
  await writeConfigTs(configPath, cfg, {
    header: '// Regenerated by `lyra init`. Edit freely; type-safe.',
  })

  const packageId = resolvePackageId()
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
  outro(lines.join('\n'))
}

interface SeedStarterOpts {
  paths: ReturnType<typeof agentPaths.agent>
  network: LyraNetwork
  agentAddress: string
  brainProvider: string | null
  brainModel: string | null
}

/**
 * Seed `MEMORY.md`, `/agent/identity.md`, and `/agent/persona.md` so the
 * brain's first turn sees a parseable memory index and introduces itself.
 */
async function seedStarterMemoryFiles(opts: SeedStarterOpts): Promise<void> {
  const memDir = opts.paths.memoryDir
  const agentMem = `${memDir}/agent`
  const userMem = `${memDir}/user`
  await mkdir(agentMem, { recursive: true })
  await mkdir(userMem, { recursive: true })

  const now = new Date().toISOString().slice(0, 10)
  const identity = `---\nname: identity\ndescription: Auto-written agent identity facts.\ntype: agent-identity\n---\n# Lyra identity\n\n- Name: Lyra\n- Agent address: ${opts.agentAddress} (${opts.network})\n- Created: ${now}\n${opts.brainProvider ? `- Brain provider: ${opts.brainProvider}\n` : ''}${opts.brainModel ? `- Brain model: ${opts.brainModel}\n` : ''}`
  const persona =
    '---\nname: persona\ndescription: Voice + behavior style.\ntype: agent-persona\n---\n# Persona\n\nI am Lyra, a Sui-native autonomous finance agent. I convert goals into policy-checked PTBs, execute only within my approved protocol scope, and store auditable memory and receipts with Walrus. Every value-moving action is checked by a deterministic policy (mirrored on-chain by lyra::policy) before it runs. I am direct, concise, and factual.\n'
  const profile =
    '---\nname: profile\ndescription: User profile (local only).\ntype: user\n---\n# User profile\n\n(empty, fills as we chat)\n'

  await writeFile(join(agentMem, 'identity.md'), identity, 'utf8')
  await writeFile(join(agentMem, 'persona.md'), persona, 'utf8')
  await writeFile(join(userMem, 'profile.md'), profile, 'utf8')
  await writeFile(opts.paths.memoryIndex, '# Lyra Memory Index\n\n', 'utf8')
}
