import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { spinner } from '@clack/prompts'
import {
  ActivityLog,
  type BrainMessage,
  type ClaudeAgent,
  type ClaudeCommand,
  DEMO_LLM_BASE_URL,
  DEMO_LLM_TOKEN,
  HookBus,
  type Listener,
  LocalBackend,
  type LyraConfig,
  McpManager,
  OpenAIBrain,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  PermissionService,
  type PostToolCallContext,
  type PreToolCallContext,
  type PreToolCallResult,
  type SandboxBackend,
  type SkillRef,
  ToolRegistry,
  type VisionInferFn,
  agentPaths,
  applyPerms,
  applyYolo,
  buildFrozenPrefix,
  createFsHistoryPersist,
  detectFetchEscalation,
  discoverClaudeExtras,
  discoverMcpServers,
  formatSui,
  getSuiBalanceMist,
  loadPlugins,
  makeMemoryListTool,
  makeMemoryReadTool,
  makeMemorySaveTool,
  makeSandboxBackend,
  makeToolSearchTool,
  matchSkillTriggers,
  newEventId,
  placeholderAgentId,
  readIndexFile,
  runEscalation,
  scanSkills,
} from 'lyra-core'
import {
  ONCHAIN_GUIDANCE,
  isValueMovingTool,
  policyFromEnv,
  policyRequiresApprovalForCall,
} from 'lyra-plugin-onchain'
import {
  TELEGRAM_GUIDANCE,
  type TelegramApprovalBridge,
  type TelegramRuntimeContext,
  formatInboundPreview as formatTelegramInboundPreview,
} from 'lyra-plugin-telegram'
import { DEFAULT_LLM_MODEL, resolveLlmBaseUrl } from '../config/defaults'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { shortAddr } from '../util/format'
import { buildOnchainContext, loadAgent } from '../util/sui-runtime'
import {
  type TelegramDispatchSlot,
  buildTelegramDispatch,
  buildTelegramRuntimeContext,
} from './chat-telegram'

type TelegramSecrets = { botToken: string; botUsername?: string; allowedUserIds: number[] }

function warnAgentAddressMismatch(config: LyraConfig, agentAddress: string): void {
  // Keep the config in sync if the address derived from the key differs from
  // what `lyra init` last wrote (e.g. the operator rotated keys).
  if (config.identity.agent && config.identity.agent !== agentAddress) {
    console.log(
      `warning: LYRA_AGENT_KEY resolves to ${agentAddress}, but config has ${config.identity.agent}.`,
    )
  }
}

/**
 * Telegram secrets are env-driven on Sui (no operator-encrypted blob).
 * TELEGRAM_BOT_TOKEN enables the phone-DM gateway; TELEGRAM_CHAT_ID (optional)
 * is the sole allowed DM user (blank = open access). Returns a (possibly
 * plugin-augmented) config alongside the parsed secrets.
 */
function resolveTelegramSecrets(config: LyraConfig): {
  telegramSecrets: TelegramSecrets | null
  config: LyraConfig
} {
  const envTgToken = process.env.TELEGRAM_BOT_TOKEN
  if (!envTgToken) return { telegramSecrets: null, config }
  const envChatId = process.env.TELEGRAM_CHAT_ID
  const telegramSecrets: TelegramSecrets = {
    botToken: envTgToken,
    botUsername: process.env.TELEGRAM_USERNAME,
    allowedUserIds: envChatId ? [Number(envChatId)] : [],
  }
  let nextConfig = config
  if (!(config.plugins ?? []).includes('telegram')) {
    nextConfig = { ...config, plugins: [...(config.plugins ?? []), 'telegram'] }
  }
  return { telegramSecrets, config: nextConfig }
}

async function ensureBrainProvider(config: LyraConfig, configPath: string): Promise<LyraConfig> {
  if (config.brain.provider) return config
  const updated = await runModelPicker(config, configPath)
  if (!updated) process.exit(1)
  return updated
}

function buildCommandIndex(claudeCommands: ClaudeCommand[]): Map<string, ClaudeCommand> {
  const commandIndex = new Map<string, ClaudeCommand>()
  for (const cmd of claudeCommands) {
    if (!commandIndex.has(cmd.name)) commandIndex.set(cmd.name, cmd)
    if (!commandIndex.has(cmd.id)) commandIndex.set(cmd.id, cmd)
  }
  return commandIndex
}

/** OpenAI-compatible LLM config (env-driven; default gpt-4o-mini, swappable to Z.AI/Tencent). */
function resolveLlmSettings(config: LyraConfig): {
  llmApiKey: string
  llmBaseUrl: string
  llmModel: string
} {
  const userLlmKey = process.env.OPENAI_API_KEY ?? process.env.LYRA_LLM_API_KEY
  // No personal key set → fall back to the hosted demo proxy so lyra runs keyless.
  const llmApiKey = userLlmKey ?? DEMO_LLM_TOKEN
  // With a personal key, default to the OpenAI endpoint; keyless uses the demo proxy.
  const llmBaseUrl = userLlmKey
    ? resolveLlmBaseUrl()
    : (process.env.LYRA_LLM_BASE_URL ?? DEMO_LLM_BASE_URL)
  const llmModel = process.env.LYRA_LLM_MODEL ?? config.brain?.model ?? DEFAULT_LLM_MODEL
  return { llmApiKey, llmBaseUrl, llmModel }
}

function resolveSandboxMode(config: LyraConfig): 'none' | 'os' | 'docker' {
  // LYRA_SANDBOX_MODE env var wins over config (matches hermes' TERMINAL_ENV
  // pattern — per-launch override without editing config).
  const envOverride = process.env.LYRA_SANDBOX_MODE
  return envOverride === 'none' || envOverride === 'os' || envOverride === 'docker'
    ? envOverride
    : (config.sandbox?.mode ?? 'none')
}

/**
 * Phase 9.5: build the sandbox backend BEFORE plugins load. Tools that spawn
 * subprocesses wrap their spawn argv through this backend. Falls back to a
 * LocalBackend if init fails, and emits the active-mode banner to stderr.
 */
function createSandbox(config: LyraConfig, paths: { dir: string }): SandboxBackend {
  const sandboxMode = resolveSandboxMode(config)
  let sandbox: SandboxBackend
  try {
    sandbox = makeSandboxBackend({
      mode: sandboxMode,
      agentDir: paths.dir,
      workspaceRoot: process.cwd(),
      homedir: homedir(),
      dockerImage: config.sandbox?.dockerImage,
      dockerMountWorkspace: config.sandbox?.dockerMountWorkspace,
      dockerRuntimePath: config.sandbox?.dockerRuntimePath,
      dockerCpu: config.sandbox?.dockerCpu,
      dockerMemoryMb: config.sandbox?.dockerMemoryMb,
      dockerDiskMb: config.sandbox?.dockerDiskMb,
      dockerNoNetwork: config.sandbox?.dockerNoNetwork,
    })
  } catch (err) {
    process.stderr.write(
      `lyra: sandbox init failed (${(err as Error).message}), continuing without sandbox\n`,
    )
    sandbox = new LocalBackend()
  }
  if (sandbox.mode === 'os') {
    process.stderr.write(
      `lyra: sandbox active [${sandbox.label}] — limb spawns gated to agentDir + cwd + /tmp/lyra-* + /var/folders; reads of ~/.ssh ~/.aws ~/Library/Keychains ~/.config/gcloud denied\n`,
    )
  } else if (sandbox.mode === 'docker') {
    process.stderr.write(
      `lyra: container sandbox active [${sandbox.label}] — every shell-class spawn runs inside the container; host fs invisible to those tools${config.sandbox?.dockerMountWorkspace ? ' except mounted /workspace' : ''}\n`,
    )
  }
  return sandbox
}

/**
 * Register a dispose hook so docker containers don't leak when lyra exits.
 * Signal handlers MUST await dispose before exiting; a sync `process.exit(0)`
 * would discard the dispose promise and leave the container orphaned.
 */
function registerSandboxDisposal(sandbox: SandboxBackend): void {
  if (!sandbox.dispose) return
  const disposeOnce = (() => {
    let done = false
    return async () => {
      if (done) return
      done = true
      await sandbox.dispose?.().catch(() => {})
    }
  })()
  process.once('SIGINT', () => {
    void disposeOnce().then(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    void disposeOnce().then(() => process.exit(0))
  })
}

async function maybeWritePluginDebug(
  paths: { dir: string },
  pluginNames: string[],
  loadResult: Awaited<ReturnType<typeof loadPlugins>>,
  tools: ToolRegistry,
): Promise<void> {
  if (!(loadResult.errors.length > 0 || process.env.LYRA_DEBUG_PLUGINS)) return
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await writeFile(
    join(paths.dir, 'plugin-debug.log'),
    JSON.stringify(
      {
        ts: Date.now(),
        pluginNames,
        loadResult,
        registeredTools: tools.list().map(t => t.name),
      },
      null,
      2,
    ),
  ).catch(() => {})
}

/**
 * MCP discovery: scan ~/.lyra/.mcp.json + ~/.claude/.mcp.json + plugin cache,
 * spawn each stdio server, register tools as deferred. Failures are logged but
 * never block startup.
 */
async function discoverAndRegisterMcp(
  config: LyraConfig,
  tools: ToolRegistry,
  paths: { dir: string },
): Promise<McpManager | null> {
  let mcpManager: McpManager | null = null
  try {
    const { servers } = await discoverMcpServers({
      importsClaudeCode: config.imports?.claudeCode ?? true,
    })
    if (servers.length > 0) {
      mcpManager = new McpManager(servers)
      const mcpResult = await mcpManager.registerAll(def =>
        tools.register(def as Parameters<typeof tools.register>[0]),
      )
      if (mcpResult.failed.length > 0 || process.env.LYRA_DEBUG_PLUGINS) {
        const { writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        await writeFile(
          join(paths.dir, 'mcp-debug.log'),
          JSON.stringify(
            { ts: Date.now(), servers: servers.map(s => s.name), result: mcpResult },
            null,
            2,
          ),
        ).catch(() => {})
      }
    }
  } catch {
    // Discovery itself failed (probably I/O); proceed without MCP.
  }
  return mcpManager
}

/** Plugin-contributed prompt sections. */
function buildExtraGuidance(onchain: unknown, telegram: unknown): string[] {
  const extraGuidance: string[] = []
  if (onchain) extraGuidance.push(ONCHAIN_GUIDANCE)
  if (telegram) extraGuidance.push(TELEGRAM_GUIDANCE)
  return extraGuidance
}

function buildCompaction(config: LyraConfig) {
  if (config.brain?.compaction === null) return null
  return {
    threshold: config.brain?.compaction?.threshold ?? 0.5,
    contextWindow: config.brain?.contextWindow ?? 1_000_000,
    keepRecent: config.brain?.compaction?.keepRecent ?? 8,
  }
}

function buildPersist(config: LyraConfig, dir: string) {
  const persistConversations = config.brain?.persistConversations !== false
  return persistConversations ? createFsHistoryPersist({ dir: `${dir}/conversations` }) : undefined
}

export async function runChat(opts?: { cwd?: string; yolo?: boolean }): Promise<void> {
  const found = await findAndLoadConfig(opts?.cwd)
  if (!found) {
    console.log('No lyra.config.ts found. Run `lyra init` first.')
    process.exit(1)
  }
  let { config } = found
  const configPath = found.path

  // On Sui the agent IS the signer: one Ed25519 keypair, sourced from the
  // `LYRA_AGENT_KEY` env (`suiprivkey1…`). No operator wallet, keystore
  // decrypt, or a Sui wallet dance. The deterministic policy (mirrored
  // on-chain by `lyra::policy`) bounds what the key may do.
  const agent = loadAgent()
  if (!agent) {
    console.log('No agent key found. Run `lyra init` first (or export a suiprivkey1… key).')
    process.exit(1)
  }
  const agentAddress = agent.address
  warnAgentAddressMismatch(config, agentAddress)
  const agentId = placeholderAgentId(agentAddress)
  const paths = agentPaths.agent(agentId)

  const tgSecretsResult = resolveTelegramSecrets(config)
  config = tgSecretsResult.config
  const telegramSecrets = tgSecretsResult.telegramSecrets

  config = await ensureBrainProvider(config, configPath)
  const importsClaudeCode = config.imports?.claudeCode ?? true

  const tools = new ToolRegistry(config.tools)
  tools.register(makeMemorySaveTool({ agentId }) as Parameters<typeof tools.register>[0])
  tools.register(makeMemoryReadTool({ agentId }) as Parameters<typeof tools.register>[0])
  tools.register(makeMemoryListTool({ agentId }) as Parameters<typeof tools.register>[0])
  tools.register(makeToolSearchTool(tools) as Parameters<typeof tools.register>[0])

  const initialMode: PermissionMode = opts?.yolo ? 'off' : (config.approvals?.mode ?? 'prompt')
  const permission = new PermissionService({ mode: initialMode })
  const hooks = new HookBus()

  // Plugin failures are reported but do not abort startup; the brain still has
  // memory tools.
  //
  // The dynamic `import()` MUST happen from the CLI package context: that's
  // where the workspace deps `lyra-ai-plugin-*` live. Passing this
  // resolver pins the import site to chat.tsx so bun's resolver finds them.
  // Claude Code extras (commands + agents) discovery happens BEFORE plugin
  // load so delegate.task can surface agents.
  let claudeCommands: ClaudeCommand[] = []
  let claudeAgents: ClaudeAgent[] = []
  try {
    const extras = await discoverClaudeExtras({ importsClaudeCode })
    claudeCommands = extras.commands
    claudeAgents = extras.agents
  } catch {
    // Discovery failed; continue without commands/agents.
  }
  const commandIndex = buildCommandIndex(claudeCommands)

  const { llmApiKey, llmBaseUrl, llmModel } = resolveLlmSettings(config)

  // Sub-brain factory for delegate.task (Phase 9.3). The factory creates a
  // fresh OpenAIBrain with a custom system prompt. Tools default to none for
  // delegated work; the parent calls delegate.task only when isolation matters.
  const delegateFactory: import('lyra-core').DelegateBrainFactory = async ({
    systemPrompt,
    tools: subTools,
  }) => {
    const subBrain = new OpenAIBrain({
      apiKey: llmApiKey,
      baseUrl: llmBaseUrl,
      model: llmModel,
      tools: subTools,
      prefix: buildFrozenPrefix({
        systemPrompt,
        memoryIndex: null,
        identity: null,
        persona: null,
        loadedToolNames: [],
        skills: [],
        timestamp: null,
      }),
    })
    await subBrain.init()
    return subBrain as unknown as import('lyra-core').DelegateBrainHandle
  }

  // Phase 9.5: build sandbox backend BEFORE plugins load. Tools that spawn
  // subprocesses (shell.run, code.execute, shell.process_start) wrap their
  // spawn argv through this backend.
  const sandbox = createSandbox(config, paths)
  registerSandboxDisposal(sandbox)

  // Vision routing via the OpenAI-compatible brain is a follow-up; disabled for now.
  const visionInfer: VisionInferFn | null = null

  // Plugin filter: system + onchain ship; telegram is opt-in via
  // `lyra telegram setup` which writes ~/.lyra/agents/<id>/telegram-secrets.encrypted
  // and adds 'telegram' to config.plugins.
  const pluginNames = (config.plugins ?? []).filter(
    p => p === 'system' || p === 'onchain' || p === 'telegram',
  )
  // Onchain side-band ctx: the Sui client + agent keypair drive every PTB, and
  // the deterministic policy (mirrored on-chain by lyra::policy) bounds writes.
  // The standalone balanceClient backs the statusbar balance refresher so the
  // segment works regardless of which plugins loaded.
  const buildOnchainContexts = async () => {
    const onchain = pluginNames.includes('onchain')
      ? await buildOnchainContext({
          agent,
          network: config.network,
          agentDir: paths.dir,
          brainProvider: config.brain.provider,
          brainModel: config.brain.model,
        })
      : undefined
    const balanceClient =
      onchain?.client ??
      (
        await buildOnchainContext({
          agent,
          network: config.network,
          agentDir: paths.dir,
        })
      ).client
    return { onchain, balanceClient }
  }
  const { onchain, balanceClient } = await buildOnchainContexts()
  // Phase 12: telegram side-band ctx. We build the runtime context now (before
  // brain.init) so the plugin can register its listener via ctx.registerListener,
  // but the dispatch callback is deferred — the slot's `.current` is null until
  // brain.init resolves and we wire it below. Same for the system-row sink:
  // populated once state exists.
  const telegramSlot: TelegramDispatchSlot = { current: null }
  const telegramSystemRowSink: { current: ((text: string) => void) | null } = { current: null }
  const telegramInboundRowSink: { current: ((text: string) => void) | null } = { current: null }
  const telegramAssistantRowSink: { current: ((text: string) => void) | null } = { current: null }
  // Bridge for inline-keyboard approval. Listener fills the inner refs on
  // start; chat-telegram's runOne reads them at turn time.
  const telegramApprovalBridge: TelegramApprovalBridge = {
    sendApproval: { current: null },
    installCallbackHandler: { current: null },
  }
  const buildTelegram = (): TelegramRuntimeContext | undefined => {
    if (!(telegramSecrets && pluginNames.includes('telegram'))) return undefined
    const tgCtx = buildTelegramRuntimeContext({
      botToken: telegramSecrets.botToken,
      allowedUserIds: telegramSecrets.allowedUserIds,
      agentName: `agent-${agentId.slice(0, 8)}`,
      slot: telegramSlot,
      systemRowSink: telegramSystemRowSink,
    })
    tgCtx.approvalBridge = telegramApprovalBridge
    return tgCtx
  }
  const telegram = buildTelegram()
  // Local listener registry: plugins register listeners via ctx.registerListener
  // (e.g. telegram's inbound poller); we collect them here so chat can start them
  // once brain init is done.
  const collectedListeners: Listener[] = []
  const skillsDisabled = { current: [...(config.skills?.disabled ?? [])] }
  const loadResult = await loadPlugins(pluginNames, {
    tools,
    hooks,
    listeners: {
      register: l => {
        collectedListeners.push(l)
      },
    },
    agentDir: paths.dir,
    agentId,
    network: config.network,
    configPath,
    imports: { claudeCode: importsClaudeCode },
    skillsDisabled,
    activityLogPath: paths.activityLog,
    workspaceRoot: process.cwd(),
    delegateFactory,
    claudeAgents,
    brainSupportsVision: false,
    brainModelLabel: config.brain.model ?? config.brain.provider,
    visionInfer,
    sandbox,
    onchain,
    telegram,
    resolve: async name => {
      switch (name) {
        case 'system':
          return await import('lyra-plugin-system')
        case 'onchain':
          return await import('lyra-plugin-onchain')
        case 'telegram':
          return await import('lyra-plugin-telegram')
        default:
          throw new Error(`unknown first-party plugin: ${name}`)
      }
    },
  })
  await maybeWritePluginDebug(paths, pluginNames, loadResult, tools)

  const mcpManager = await discoverAndRegisterMcp(config, tools, paths)

  // Memory is local-only; durable receipts/memory go to Walrus via the
  // walrus.store tool, not a per-turn anchor. This no-op preserves the
  // per-turn flush call sites; memory persists as files via the memory.* tools.
  const sync = {
    flushTurn: async (): Promise<{ txHash: string | null; changedSlots: string[] }> => ({
      txHash: null,
      changedSlots: [],
    }),
    flushAll: async (): Promise<{ txHash: string | null; changedSlots: string[] }> => ({
      txHash: null,
      changedSlots: [],
    }),
  }

  await mkdir(paths.memoryDir, { recursive: true })
  const [memoryIndex, identityText, personaText, scannedSkills] = await Promise.all([
    readIndexFile(paths.memoryIndex).catch(() => null),
    readMemoryFileOrNull(`${paths.memoryDir}/agent/identity.md`),
    readMemoryFileOrNull(`${paths.memoryDir}/agent/persona.md`),
    scanSkills({ importsClaudeCode }).catch(() => [] as SkillRef[]),
  ])
  // Use tools.list() (includes deferred) for guidance lookup — guidance
  // fires per-tool-namespace, not per-prompt-schema. tools.schemas() is the
  // separate set the brain SEES in its prompt; deferred tools stay hidden
  // there until tool.search loads them. But the brain still needs to know
  // they EXIST via guidance, otherwise it never thinks to search.
  const loadedToolNames = tools.list().map(t => t.name)
  const disabledSkillSet = new Set(skillsDisabled.current)
  const skillsRef: { current: SkillRef[] } = {
    current: scannedSkills.filter(s => !disabledSkillSet.has(s.id)),
  }
  const promptAppend = config.prompt?.append ?? null
  // Surface sandbox awareness so the brain doesn't have to empirically discover
  // its container/profile via pwd + ls + uname round-trips. Without it,
  // qwen3.6-plus would hit fs.read('/workspace/X') → ENOENT (fs.* runs on host),
  // sed -i '' (BSD) → fails on Linux GNU sed, and answer "where am I?" only
  // after probing. Each wasted call costs latency + tokens.
  const envInfo = {
    cwd: process.cwd(),
    platform: process.platform,
    sandbox: sandbox.envHint?.() ?? null,
  }
  const extraGuidance = buildExtraGuidance(onchain, telegram)

  const buildPrefix = async () => {
    const idx = await readIndexFile(paths.memoryIndex).catch(() => null)
    return buildFrozenPrefix({
      memoryIndex: idx,
      identity: identityText,
      persona: personaText,
      loadedToolNames,
      skills: skillsRef.current,
      promptAppend,
      envInfo,
      extraGuidance,
    })
  }
  const prefix = buildFrozenPrefix({
    memoryIndex,
    identity: identityText,
    persona: personaText,
    loadedToolNames,
    skills: skillsRef.current,
    promptAppend,
    envInfo,
    extraGuidance,
  })
  const activity = new ActivityLog(paths.activityLog)

  // Brain init must happen BEFORE createCliRenderer. clack/prompts spinner
  // calls setRawMode(false) + stdin.pause() on stop, which undoes the
  // stdin.resume() that opentui's setupTerminal sets up. If brain init
  // (and its spinner) ran AFTER createCliRenderer, the stop would flip
  // stdin back into a state where opentui can't read keypresses, AND the
  // event loop would empty (no stdin keepalive) so the process exits.
  // The fix: every clack interaction finishes before opentui takes the wheel.
  const { render } = await import('@opentui/solid')
  const { createCliRenderer } = await import('@opentui/core')
  const { createChatState } = await import('../ui/state')
  const { ChatApp } = await import('../ui/app')

  const state = createChatState({
    initialSystem: opts?.yolo
      ? 'connected. YOLO mode: approval prompts disabled.'
      : 'connected. type messages and press enter.',
    // Show the configured agent name when set, else the 16-char agent ID hash.
    // Use the FULL agent EOA (no shortAddr) so operators see the complete
    // address — useful for chain explorers.
    identityLabel: `agent ${agentId}  ${agentAddress}`,
    approvalsMode: initialMode,
    // v0.24.4: embedded chat runs in-process on the operator's machine — by
    // definition local. Tag it so the statusbar hides the sandbox-billing
    // segment, matching the standalone-local-gateway path.
    isLocalGateway: true,
  })

  // Phase 12: now that state exists, point the telegram row sinks at it. The
  // dispatch slot stays null until brain.init resolves below.
  const wireTelegramRowSinks = (): void => {
    if (!telegram) return
    telegramSystemRowSink.current = (text: string) => state.pushRow({ role: 'system', text })
    telegramInboundRowSink.current = (text: string) => state.pushRow({ role: 'inbox-tg', text })
    telegramAssistantRowSink.current = (text: string) =>
      state.pushRow({ role: 'telegram-assistant', text })
  }
  wireTelegramRowSinks()

  // Statusline balance refreshers; fired at boot and post-turn. The agent
  // keypair pays gas for every PTB, so its SUI balance is the one that matters.
  const refreshEoaBalance = () => {
    getSuiBalanceMist(balanceClient, agentAddress)
      .then(mist => state.setEoaBalance(Number(formatSui(mist))))
      .catch(() => {})
  }
  const refreshBalances = () => {
    refreshEoaBalance()
  }

  permission.setPrompter(req => {
    return new Promise<PermissionDecision>(resolve => {
      // Value-moving onchain ops carry amount/recipient/token so we render a
      // friendlier "send 0.05 SUI to 0xC635...87Ec" instead of a raw command.
      const detail =
        req.amount !== undefined
          ? `${req.amount}${req.token ? ` ${req.token}` : ''}${req.recipient ? ` to ${req.recipient}` : ''}`
          : (req.command ?? req.path ?? '(?)')
      state.pushRow({
        role: 'system',
        text: `[approval requested] ${req.reason}: ${detail}`,
      })
      state.setPendingApproval({ request: req, resolve })
    })
  })

  hooks.add<PreToolCallContext, PreToolCallResult>('pre_tool_call', async ({ call }) => {
    const checks = describePermissionCheck(call)
    if (!checks) return undefined
    // Deterministic policy floor: escalate to approval beneath the session mode
    // (even YOLO) when the on-chain policy flags this call as material-risk.
    if (
      !checks.force &&
      policyRequiresApprovalForCall(
        call.name,
        (call.args ?? {}) as Record<string, unknown>,
        policyFromEnv(),
      )
    ) {
      checks.force = true
    }
    const result = await permission.resolve(checks)
    if (result.allowed) return undefined
    return {
      short: {
        ok: false,
        error: `Denied: ${result.reason ?? 'permission check failed'} (mode=${permission.getMode()}). Operator rejected this call. Do NOT retry, instruct another tool, or claim the transaction is queued. Surface the rejection to the operator and ask whether to proceed differently.`,
      },
    }
  })

  // Skills auto-trigger: when a tool call matches a skill's filePattern or
  // bashPattern, surface a system row so the operator sees the auto-load AND
  // queue the SKILL.md body for next-turn injection via brain.injectContext().
  const pendingSkillInjections = new Set<string>()
  hooks.add<PostToolCallContext, void>('post_tool_call', async ({ call, result }) => {
    if (result.ok === false) return
    const matches = matchSkillTriggers({ name: call.name, args: call.args }, skillsRef.current)
    for (const match of matches) {
      if (pendingSkillInjections.has(match.skill.id)) continue
      pendingSkillInjections.add(match.skill.id)
      state.pushRow({
        role: 'system',
        text: `↳ skill auto-loaded: ${match.skill.id} (matched ${match.reason}). use skills.view to read body.`,
      })
    }
  })

  const bootSpinner = spinner()
  bootSpinner.start(`Connecting to model ${llmModel}`)
  const brain = new OpenAIBrain({
    apiKey: llmApiKey,
    baseUrl: llmBaseUrl,
    model: llmModel,
    tools: tools.schemas(),
    prefix,
    maxOutputTokens: config.brain?.maxOutputTokens,
    compaction: buildCompaction(config),
    persist: buildPersist(config, paths.dir),
    onToolCall: async call => {
      state.pushRow({
        role: 'tool-call',
        text: '',
        toolName: call.name,
        args: summarizeArgs(call.args),
      })
      const pre = await hooks.runPreToolCall({ call })
      if (pre.short) {
        await activity.append({
          ts: Date.now(),
          kind: 'tool-call',
          data: { call, result: pre.short, blocked: true },
        })
        state.pushRow({
          role: 'tool-result',
          text: summarizeToolResult(pre.short),
          failed: pre.short.ok === false,
        })
        return { role: 'tool', content: JSON.stringify(pre.short) } as BrainMessage
      }
      const effectiveCall = pre.call ?? call
      const result = await tools.dispatch(effectiveCall)
      await hooks.runPostToolCall({ call: effectiveCall, result })
      await activity.append({
        ts: Date.now(),
        kind: 'tool-call',
        data: { call: effectiveCall, result },
      })
      state.pushRow({
        role: 'tool-result',
        text: summarizeToolResult(result),
        failed: result.ok === false,
      })
      // v0.21.2 R1: deterministic browser.navigate retry when web.fetch hits
      // a bot-block. Mirror block in build-runtime.ts; both share orchestration
      // via runEscalation so any future change lands in one place. Sinks differ:
      // TUI pushes rows here, gateway publishes SSE events.
      const escalation = detectFetchEscalation(effectiveCall, result)
      if (escalation.needed) {
        const merged = await runEscalation(escalation, result, {
          runPreCall: c => hooks.runPreToolCall({ call: c }),
          runPostCall: (c, r) => hooks.runPostToolCall({ call: c, result: r }),
          dispatch: c => tools.dispatch(c),
          appendActivity: (c, r) =>
            activity.append({
              ts: Date.now(),
              kind: 'tool-call',
              data: { call: c, result: r, autoEscalated: true },
            }),
          onStart: c =>
            state.pushRow({
              role: 'tool-call',
              text: '',
              toolName: c.name,
              args: summarizeArgs(c.args),
              autoEscalated: true,
            }),
          onEnd: (_c, r) =>
            state.pushRow({
              role: 'tool-result',
              text: summarizeToolResult(r),
              failed: r.ok === false,
              autoEscalated: true,
            }),
        })
        return { role: 'tool', content: JSON.stringify(merged) } as BrainMessage
      }
      return {
        role: 'tool',
        content: JSON.stringify(result),
      } as BrainMessage
    },
  })
  try {
    await brain.init()
    bootSpinner.stop('Connected')
  } catch (e) {
    bootSpinner.stop(`Connection failed: ${(e as Error).message.slice(0, 120)}`)
    process.exit(1)
  }

  // Phase 12: brain is up. Wire the deferred TG dispatch slot so any inbound
  // TG message that lands once collectedListeners[i].start() fires below
  // routes through brain.infer with source=telegram.
  const wireTelegramDispatch = (): void => {
    if (!telegram) return
    const handle = buildTelegramDispatch({
      activity,
      sync,
      permission,
      pushAssistantRow: text => telegramAssistantRowSink.current?.(text),
      pushInboundRow: text => telegramInboundRowSink.current?.(text),
      isBusy: () => state.status() === 'thinking',
      buildPrefix,
      brain,
      setThinking: on => state.setStatus(on ? 'thinking' : 'idle'),
      setActiveAbort: ctrl => state.setActiveAbort(ctrl),
      refreshBalances,
      formatInboundPreview: input =>
        formatTelegramInboundPreview({
          chatId: input.chatId,
          username: input.username,
          displayName: input.displayName,
          text: input.text.replace(/^<channel[^>]*>([\s\S]*)<\/channel>$/, '$1'),
        }),
      approvalBridge: telegramApprovalBridge,
    })
    telegramSlot.current = handle.dispatch
    // Drain queued TG messages whenever the brain returns to idle (closes G4
    // starvation: a stdin turn ending while a TG message was queued used to
    // leave it stuck until the next inbound).
    state.onStatusChange(next => {
      if (next === 'idle' && handle.getQueueSize() > 0) handle.drainQueue()
    })
  }
  wireTelegramDispatch()

  // Initial balances for the status bar (best-effort, never blocks boot).
  refreshBalances()

  // Redirect noisy SDK chatter (Sui RPC + Walrus progress logs) to a
  // log file so it doesn't fall through opentui's alt-screen and pollute the
  // chat UI. Keep process.stdout intact - opentui itself needs to write there.
  const { createWriteStream } = await import('node:fs')
  const chatLog = createWriteStream(`${paths.dir}/chat.log`, { flags: 'a' })
  const stringifyArg = (a: unknown): string => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return a.stack ?? a.message
    try {
      return JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
    } catch {
      return String(a)
    }
  }
  const logTo =
    (level: string) =>
    (...args: unknown[]) => {
      const line = args.map(stringifyArg).join(' ')
      chatLog.write(`[${new Date().toISOString()}] [${level}] ${line}\n`)
    }
  console.log = logTo('log') as typeof console.log
  console.warn = logTo('warn') as typeof console.warn
  console.error = logTo('error') as typeof console.error
  console.info = logTo('info') as typeof console.info
  console.debug = logTo('debug') as typeof console.debug
  process.on('unhandledRejection', err => {
    chatLog.write(`[unhandled] ${(err as Error)?.stack ?? String(err)}\n`)
  })

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    consoleMode: 'disabled',
    openConsoleOnError: false,
  })

  // Listener catch-up + WS subscribe runs in the background. `start` only
  // resolves after catch-up finishes, which can be slow on long-restored
  // agents; awaiting it would block the chat from accepting input.
  const startListeners = (): void => {
    for (const l of collectedListeners) {
      l.start(undefined as never).catch(e => {
        state.pushRow({
          role: 'system',
          text: `listener ${l.name} failed to start: ${(e as Error).message.slice(0, 160)}`,
        })
      })
    }
  }
  startListeners()

  // Per-turn flush. Memory persists locally; durable copies go to Walrus via
  // walrus.store. The no-op flush keeps the call site for future anchoring
  // work. Fire-and-forget; chat doesn't wait.
  const flushTurnInBackground = (): void => {
    sync
      .flushTurn()
      .then(res => {
        if (res.txHash && res.changedSlots.length > 0) {
          state.pushRow({
            role: 'system',
            text: `synced ${res.changedSlots.join(', ')} (${res.txHash})`,
          })
        }
      })
      .catch(e => {
        state.pushRow({
          role: 'system',
          text: `sync error: ${summarizeError(e)}`,
        })
      })
  }

  const handleTurnError = async (e: unknown, abortCtrl: AbortController): Promise<void> => {
    // AbortError = operator pressed Esc; render as a clean sys row, NOT an
    // error. The activity log gets a paired entry so the post-mortem reflects
    // operator intent, not a real fault.
    if ((e instanceof Error && e.name === 'AbortError') || abortCtrl.signal.aborted) {
      state.pushRow({
        role: 'system',
        text: 'turn interrupted (esc). brain stopped at the last completed step.',
      })
      await activity.append({
        ts: Date.now(),
        kind: 'brain-response',
        data: { content: '(aborted by operator)', toolCalls: 0, finishReason: 'aborted' },
      })
      state.setStatus('idle')
      return
    }
    // Mirror real errors to chat.log too — render-layer bugs can swallow the
    // sys row before it hits the screen, and chat.log is the only artifact
    // the operator can read post-mortem.
    const errMsg = e instanceof Error ? e.message : String(e ?? 'unknown error')
    const dumped = e instanceof Error ? (e.stack ?? e.message) : errMsg
    console.error('[handleSubmit] error:', dumped)
    state.pushRow({ role: 'system', text: `error: ${errMsg.slice(0, 300)}` })
    state.setStatus('error')
  }

  const handleSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed.startsWith('/')) {
      const handled = await handleSlash(trimmed)
      if (handled) {
        // Slash commands skip brain.infer; reset thinking → idle so the
        // spinner row stops. (The keyboard handler in app.tsx flips
        // status='thinking' on every Enter, regardless of payload.)
        state.setStatus('idle')
        return
      }
    }
    // Per-turn AbortController. Esc in the TUI calls .abort() on this.
    // Stored on state so the keyboard handler can reach it from app.tsx.
    const abortCtrl = new AbortController()
    state.setActiveAbort(abortCtrl)
    try {
      // Refresh per-turn user-context (MEMORY.md may have grown last turn).
      // The system prefix stays cached; only the user-msg context updates.
      const refreshed = await buildPrefix()
      brain.refreshUserContext(refreshed)
      await activity.append({
        ts: Date.now(),
        kind: 'wake',
        data: { source: 'stdin', text },
      })
      const turn = await brain.infer({
        event: {
          id: newEventId(),
          source: 'stdin',
          payload: { label: 'user-message', data: text },
          ts: Date.now(),
        },
        channelKey: 'tui:stdin',
        signal: abortCtrl.signal,
        onCompactionEvent: ev => {
          state.pushRow({
            role: 'system',
            text: `✂︎ context compacted (${ev.from} → ${ev.to} messages, ~${Math.round(ev.promptTokens / 1000)}K tokens)`,
          })
        },
      })
      await activity.append({
        ts: Date.now(),
        kind: 'brain-response',
        data: {
          content: turn.content,
          toolCalls: turn.toolCalls.length,
          finishReason: turn.finishReason,
          usage: turn.usage,
        },
      })
      state.pushRow({ role: 'assistant', text: turn.content ?? '(no content)' })
      state.setStatus('idle')
      // Compute ledger drains via inference; agent EOA via tool chain writes.
      refreshBalances()
      if (turn.usage) {
        state.setUsage({
          total: turn.usage.totalTokens,
          cached: turn.usage.cachedTokens,
        })
      }
      flushTurnInBackground()
    } catch (e) {
      await handleTurnError(e, abortCtrl)
    } finally {
      state.setActiveAbort(null)
    }
  }

  const slashSync = async (): Promise<boolean> => {
    state.pushRow({ role: 'system', text: 'flushing memory + activity…' })
    try {
      const res = await sync.flushAll()
      if (res.txHash) {
        state.pushRow({
          role: 'system',
          text: `synced ${res.changedSlots.join(', ')} (${res.txHash})`,
        })
        refreshEoaBalance()
      } else {
        state.pushRow({ role: 'system', text: 'nothing to sync (everything up to date)' })
      }
    } catch (e) {
      state.pushRow({ role: 'system', text: `sync error: ${summarizeError(e)}` })
    }
    return true
  }

  const slashReset = async (): Promise<boolean> => {
    try {
      await brain.clearChannel('tui:stdin')
      state.pushRow({ role: 'system', text: 'conversation reset (TUI channel cleared)' })
    } catch (e) {
      state.pushRow({ role: 'system', text: `reset error: ${summarizeError(e)}` })
    }
    return true
  }

  const slashJobs = async (): Promise<boolean> => {
    const tool = tools.find('market.listMyJobs')
    if (!tool) {
      state.pushRow({
        role: 'system',
        text: 'market plugin not loaded; cannot list jobs.',
      })
      return true
    }
    state.pushRow({ role: 'system', text: 'fetching active jobs…' })
    try {
      const res = await tool.handler({ status: 'active', limit: 20 } as never)
      const data = (res as { ok: boolean; data?: { jobs: unknown[] } }).data
      const jobs = (data?.jobs ?? []) as Array<{
        jobId: string
        role: string
        counterparty: string | null
        amount0g: string
        status: string
      }>
      if (jobs.length === 0) {
        state.pushRow({ role: 'system', text: 'no active escrow jobs.' })
      } else {
        const lines = jobs.map(
          j =>
            `  job#${j.jobId} · ${j.role}${j.counterparty ? ` w/ ${shortAddr(j.counterparty)}` : ''} · ${j.amount0g} SUI · ${j.status}`,
        )
        state.pushRow({
          role: 'system',
          text: `active jobs (${jobs.length}):\n${lines.join('\n')}`,
        })
      }
    } catch (e) {
      state.pushRow({ role: 'system', text: `jobs error: ${summarizeError(e)}` })
    }
    return true
  }

  const slashHelp = (): boolean => {
    const builtins =
      "  /sync                flush memory + activity locally\n  /model               switch brain (run lyra model after exiting)\n  /yolo                toggle approval prompts off/on for this session\n  /perms <mode>        set permission mode (off|prompt|strict); no arg shows current\n  /reset               clear this channel's conversation history\n  /exit                quit lyra\n  /help                this message"
    const claudeBlock =
      commandIndex.size === 0
        ? ''
        : `\n\nClaude Code commands (auto-loaded):\n${[
            ...new Set([...commandIndex.values()].map(c => c.name)),
          ]
            .sort()
            .map(name => {
              const c = commandIndex.get(name)!
              return `  /${c.name}  ${c.description.slice(0, 80)}`
            })
            .join('\n')}`
    state.pushRow({
      role: 'system',
      text: `slash commands:\n${builtins}${claudeBlock}`,
    })
    return true
  }

  // Claude Code command match. Strip leading `/`, take first whitespace
  // segment as the command name, treat the rest as the user-supplied args.
  const slashClaudeCommand = async (cmd: string): Promise<boolean> => {
    const rest = cmd.slice(1).trim()
    if (!rest) return false
    const { name, args } = splitSlashCommand(rest)
    const command = commandIndex.get(name)
    if (!command) return false
    const inlined = buildCommandMessage(command, args)
    state.pushRow({
      role: 'system',
      text: `↳ command: /${command.name} (${command.id}, ${command.body.length} bytes inlined as user message)`,
    })
    // Send the command body as a user message so the brain executes it.
    try {
      const refreshed = await buildPrefix()
      brain.refreshUserContext(refreshed)
      const turn = await brain.infer({
        event: {
          id: newEventId(),
          source: 'stdin',
          payload: { label: 'user-message', data: inlined },
          ts: Date.now(),
        },
        channelKey: 'tui:stdin',
      })
      state.pushRow({ role: 'assistant', text: turn.content ?? '(no content)' })
      state.setStatus('idle')
    } catch (e) {
      state.pushRow({
        role: 'system',
        text: `command error: ${(e as Error).message.slice(0, 200)}`,
      })
    }
    return true
  }

  // Exact-match builtins that carry no arguments. `/perms` (prefix form) and
  // the Claude-Code fallthrough are handled separately in handleSlash.
  const exactSlash: Record<string, () => boolean | Promise<boolean>> = {
    '/exit': () => {
      state.pushRow({ role: 'system', text: 'goodbye.' })
      handleExit()
      return true
    },
    '/quit': () => {
      state.pushRow({ role: 'system', text: 'goodbye.' })
      handleExit()
      return true
    },
    '/model': () => {
      state.pushRow({
        role: 'system',
        text: 'Switching brain. (Quit chat first; run `lyra model` to pick a new brain, then re-launch `lyra`.)',
      })
      return true
    },
    '/sync': slashSync,
    '/yolo': () => {
      const result = applyYolo(permission)
      state.setApprovalsMode(result.mode)
      state.pushRow({ role: 'system', text: result.message })
      return true
    },
    '/reset': slashReset,
    '/jobs': slashJobs,
    '/help': slashHelp,
  }

  const handleSlash = async (cmd: string): Promise<boolean> => {
    const exact = exactSlash[cmd]
    if (exact) return await exact()
    if (cmd === '/perms' || cmd.startsWith('/perms ')) {
      const arg = cmd.split(/\s+/)[1]
      const result = applyPerms(permission, arg)
      state.setApprovalsMode(result.mode)
      state.pushRow({ role: 'system', text: result.message })
      return true
    }
    if (cmd.startsWith('/')) return await slashClaudeCommand(cmd)
    return false
  }

  // @opentui/solid's render() resolves once the component mounts; it does not
  // block. On macOS the renderer's animation loop runs in a worker thread, so
  // the main thread has no JS task keeping the event loop alive after render
  // returns. Anchor: a never-resolving promise after render(); handleExit is
  // the only escape via process.exit.
  const handleExit = (): void => {
    try {
      renderer.destroy()
    } catch {}
    try {
      mcpManager?.closeAll()
    } catch {}
    // Best-effort: kill any background processes registered via shell.process.
    try {
      const { killAllProcesses } = require('lyra-plugin-system') as {
        killAllProcesses: () => void
      }
      killAllProcesses()
    } catch {}
    // Best-effort drain: if a flush is mid-flight, await it. Caps at 30s so
    // we never hang the CLI on a wedged RPC.
    Promise.race([sync.flushTurn(), new Promise(r => setTimeout(r, 30_000))]).finally(() =>
      process.exit(0),
    )
  }

  // Map Claude Code commands into SlashCommand shape so the slash
  // autocomplete popup lists them alongside the bundled registry.
  const extraSlashCommands = [...new Set([...commandIndex.values()].map(c => c.name))].map(name => {
    const c = commandIndex.get(name)!
    return {
      name: c.name.toLowerCase(),
      description: c.description ?? `Claude Code command (${c.id})`,
      surfaces: ['tui'] as ('tui' | 'tg')[],
      scope: 'local' as const,
      bypassesBrain: false,
      argHint: c.argumentHint,
    }
  })

  await render(
    () => (
      <ChatApp
        state={state}
        onSubmit={handleSubmit}
        onExit={handleExit}
        extraSlashCommands={extraSlashCommands}
      />
    ),
    renderer,
  )

  await new Promise<void>(() => {
    // Block forever; only handleExit (via process.exit) escapes this.
  })
}

async function runModelPicker(config: LyraConfig, configPath: string): Promise<LyraConfig | null> {
  // Lyra uses a fixed OpenAI-compatible model (env-configured); no live catalog.
  const model = process.env.LYRA_LLM_MODEL ?? config.brain?.model ?? DEFAULT_LLM_MODEL
  const updated: LyraConfig = {
    ...config,
    brain: { provider: 'openai-compatible', model },
  }
  await writeConfigTs(configPath, updated)
  return updated
}

/** Split `<name> <rest…>` (leading `/` already stripped) into name + args. */
function splitSlashCommand(rest: string): { name: string; args: string } {
  const space = rest.indexOf(' ')
  return {
    name: space === -1 ? rest : rest.slice(0, space),
    args: space === -1 ? '' : rest.slice(space + 1).trim(),
  }
}

/** Inline a Claude Code command body as a user message (with optional args header). */
function buildCommandMessage(command: ClaudeCommand, args: string): string {
  const trimmedBody = command.body.trim()
  const argHint = command.argumentHint ? ` (${command.argumentHint})` : ''
  return args
    ? `# Command: /${command.name}${argHint}\n# User args: ${args}\n\n${trimmedBody}`
    : `# Command: /${command.name}\n\n${trimmedBody}`
}

/**
 * Squash a ToolResult down to a single-line summary for the chat row. The TUI
 * adds the `⎿` indent + color from the role, so this returns just the content:
 *   - failed   → the error message (truncated)
 *   - ok+path  → the file path the tool acted on
 *   - ok+data  → "ok"
 *   - done     → "done" (legacy: pre-ok results)
 */
function summarizeToolResult(result: unknown): string {
  const r = result as { ok?: boolean; error?: string; data?: { path?: string } } | null | undefined
  if (!r || r.ok === undefined) return 'done'
  if (r.ok === false) return (r.error ?? 'failed').slice(0, 200)
  const path = typeof r.data?.path === 'string' ? r.data.path : null
  return path ? path : 'ok'
}

/**
 * Squash an Error into a single-line, length-capped string for the TUI.
 * Sui SDK multi-line stack traces blow up the chat UX otherwise.
 * Strategy: collapse whitespace, drop everything after the first ` (action=`
 * marker (where some SDKs append transaction blobs), cap at 90 chars so the
 * row stays on one terminal line in any reasonably-sized pane.
 */
function summarizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  let s = raw.replace(/\s+/g, ' ').trim()
  const annotIdx = s.indexOf(' (action=')
  if (annotIdx >= 0) s = s.slice(0, annotIdx)
  return s.length > 90 ? `${s.slice(0, 87)}...` : s
}

type PermArgs = Record<string, unknown>
const _str = (v: unknown): string => (typeof v === 'string' ? v : '')
const _strOpt = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const PERMISSION_DESCRIBERS: Record<string, (a: PermArgs) => PermissionRequest | null> = {
  'shell.run': a => ({
    kind: 'shell.run',
    command: _str(a.command),
    reason: 'shell command execution',
  }),
  'code.execute': a => ({
    kind: 'code.execute',
    command: `[${_str(a.language) || '?'}] ${_str(a.code)}`,
    reason: 'arbitrary code execution',
  }),
  'shell.process_start': a => ({
    kind: 'shell.process',
    command: _str(a.command),
    reason: 'background process start',
  }),
  'shell.process_output': () => null,
  'shell.process_list': () => null,
  'shell.process_kill': () => null,
  'fs.write': a => ({ kind: 'fs.write', path: _str(a.path), reason: 'fs.write request' }),
  'fs.patch': a => ({ kind: 'fs.patch', path: _str(a.path), reason: 'fs.patch request' }),
  // Value-moving Sui tools. Pre-fill amount/recipient/token so the modal
  // renders "send 0.05 SUI to 0xC635…" not a raw command.
  'sui.send': a => ({
    kind: 'chain.send',
    amount: _strOpt(a.amount) ?? '?',
    recipient: _strOpt(a.to) ?? '?',
    token: 'SUI',
    reason: 'SUI transfer',
  }),
  'policy.create': a => ({
    kind: 'chain.write',
    command: `policy.create budget=${_strOpt(a.budgetSui) ?? '?'} maxPerTx=${_strOpt(a.maxPerTxSui) ?? '?'} SUI`,
    reason: 'publish an on-chain lyra::policy AgentPolicy',
  }),
  'scallop.supply': a => ({
    kind: 'chain.write',
    command: `scallop.supply ${_strOpt(a.amount) ?? '?'} SUI`,
    reason: 'supply SUI to Scallop',
  }),
  'scallop.withdraw': a => ({
    kind: 'chain.write',
    command: `scallop.withdraw ${_strOpt(a.amount) ?? '?'} SUI`,
    reason: 'withdraw SUI from Scallop',
  }),
  'navi.supply': a => ({
    kind: 'chain.write',
    command: `navi.supply ${_strOpt(a.amount) ?? '?'} SUI`,
    reason: 'supply SUI to NAVI',
  }),
  'navi.withdraw': a => ({
    kind: 'chain.write',
    command: `navi.withdraw ${_strOpt(a.amount) ?? '?'} SUI`,
    reason: 'withdraw SUI from NAVI',
  }),
  'walrus.store': a => ({
    kind: 'chain.write',
    command: `walrus.store ${_strOpt(a.label) ?? '(blob)'}`,
    reason: 'store a durable blob on Walrus',
  }),
}

function describePermissionCheck(call: { name: string; args: unknown }): PermissionRequest | null {
  const fn = PERMISSION_DESCRIBERS[call.name]
  if (fn) return fn((call.args ?? {}) as PermArgs)
  // Fail-closed: any value-moving on-chain tool without a rich describer still
  // gets gated (strict denies, prompt asks) so nothing slips through unchecked.
  if (isValueMovingTool(call.name)) {
    const a = (call.args ?? {}) as Record<string, unknown>
    const amount = typeof a.amount === 'string' ? a.amount : ''
    return {
      kind: 'chain.write',
      command: `${call.name} ${amount}`.trim(),
      reason: `on-chain write: ${call.name}`,
    }
  }
  return null
}

function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return String(args ?? '').slice(0, 60)
  const entries = Object.entries(args as Record<string, unknown>)
  return entries
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}=${s.length > 40 ? `${s.slice(0, 40)}…` : s}`
    })
    .slice(0, 3)
    .join(', ')
}

async function readMemoryFileOrNull(path: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
