import { mkdir, readFile } from 'node:fs/promises'
import {
  ActivityLog,
  type BrainMessage,
  DEMO_LLM_BASE_URL,
  DEMO_LLM_TOKEN,
  HookBus,
  type Listener,
  OpenAIBrain,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  PermissionService,
  type PostToolCallContext,
  type PreToolCallContext,
  type PreToolCallResult,
  type SkillRef,
  ToolRegistry,
  type VisionInferFn,
  applyPerms,
  applyYolo,
  buildFrozenPrefix,
  createFsHistoryPersist,
  detectFetchEscalation,
  loadPlugins,
  makeMemoryListTool,
  makeMemoryReadTool,
  makeMemorySaveTool,
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
  type OnchainRuntimeContext,
  isValueMovingTool,
  keypairFromSecret,
  makeSuiClient,
  policyFromEnv,
  policyRequiresApprovalForCall,
  resolveVaultForAgent,
} from 'lyra-plugin-onchain'
import {
  type ApprovalChoiceKind,
  type ParsedBypass,
  TELEGRAM_GUIDANCE,
  type TelegramApprovalBridge,
  type TelegramDispatchInput,
  type TelegramDispatchResult,
  type TelegramRuntimeContext,
  formatInboundPreview as formatTelegramInboundPreview,
  makeApprovalIdFactory,
  parseBypassCommand,
  stripTelegramChannelEnvelope,
} from 'lyra-plugin-telegram'
import type { ApprovalRelay } from './approval-relay'
import type { EventHub } from './events'
import type { RuntimeConfig } from './runtime'
import type { GatewaySecrets } from './secrets'

export interface BuildRuntimeOpts {
  config: RuntimeConfig
  /** Agent's Sui secret key (`suiprivkey1...` or base64 32-byte seed). */
  agentSecret: string
  /** Agent's Sui address (`keypair.toSuiAddress()`). */
  agentAddress: string
  agentDir: string
  events: EventHub
  approvals: ApprovalRelay
  /**
   * Optional: forwarded into PluginContext so plugins that read
   * `~/.lyra/config.ts` know where to write back. The harness creates an
   * in-memory placeholder if not supplied (default `${agentDir}/.config-handle.ts`).
   */
  configPath?: string
  /**
   * Optional: workspace cwd for shell.run / code.execute / shell.process_*
   * plus the cwd field exposed to the brain via envInfo. Default
   * `process.cwd()`, matching local-mode chat.tsx. The bootstrap script does
   * `cd "$LYRA_DIR"` (= `$HOME/lyra` on Daytona) before launching the
   * harness, so process.cwd() already points at the cloned repo. Override
   * only for tests or a non-standard layout.
   */
  workspaceRoot?: string
  /**
   * Optional secrets shipped via the second provision envelope. When
   * `secrets.telegram` is present, the harness wires a telegram listener +
   * approval bridge so the operator can DM the bot from their phone and
   * approve tool calls via inline keyboard.
   */
  secrets?: GatewaySecrets
}

export interface BuiltRuntime {
  brain: OpenAIBrain
  tools: ToolRegistry
  permission: PermissionService
  hooks: HookBus
  sync: {
    flushTurn: () => Promise<{ txHash: string | null; changedSlots: string[] }>
    flushAll: () => Promise<{ txHash: string | null; changedSlots: string[] }>
    setProfileKey: (key: Buffer) => void
  }
  activity: ActivityLog
  listeners: Listener[]
  buildPrefix: () => Promise<ReturnType<typeof buildFrozenPrefix>>
  refreshUserContext: () => Promise<void>
  dispose: () => Promise<void>
  agentId: string
  /** Compute auto-topup was removed with the decentralized-compute backend. Always null. */
  autoTopup: null
  /**
   * v0.23.0: snapshot of the latest restore/flush outcome per slot. Mutated
   * by the boot-time restore, lazy retries, and successful flushes. Read by
   * `/healthz.slots`.
   */
  slotStatus: Map<string, { status: string; reason?: string; bytes?: number }>
  /**
   * v0.23.0: flip the operator-scoped PROFILE key. Updates the live
   * MemorySyncManager and re-triggers a one-shot restore for the profile
   * slot so the new key's anchored blob (if any) lands on disk this turn.
   */
  setProfileKey: (keyHex: `0x${string}`) => Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * v0.24.4: approve a pending pairing code in the canonical pairing dir.
   * Mirrors `PairingStore.approveCode` semantics. Used by the
   * `/admin/pairing/approve` HTTP endpoint so sandbox-deployed agents can
   * route pair-mode approvals from the host CLI to the container's pairing
   * dir. `ok:false` with `reason: 'unknown-or-expired-code'` covers both the
   * normal-miss case and the security-lockout case (5-failure throttle); the
   * caller layer above translates this into a 200 with `{ ok: false, reason }`
   * so the operator's CLI can render a clean message either way.
   */
  approvePairing: (
    platform: string,
    code: string,
  ) => { ok: true; userId: string; userName: string } | { ok: false; reason: string }
}

const PERMISSION_MODE_MAP: Record<NonNullable<RuntimeConfig['permissions']>, PermissionMode> = {
  off: 'off',
  prompt: 'prompt',
  strict: 'strict',
  yolo: 'off',
}

/**
 * Resolve the user-facing agent name. Sourced from `config.subname` when
 * registered (e.g. "specter" for `specter.lyra.0g`); falls back to a
 * `agent-<8 hex>` slug. Used by the TG pairing greeting so unknown DM users
 * see "Hi! I'm specter and I don't recognize you yet." instead of the slug.
 */
export function resolveAgentName(subname: string | null | undefined, agentId: string): string {
  const trimmed = typeof subname === 'string' ? subname.trim() : ''
  return trimmed.length > 0 ? trimmed : `agent-${agentId.slice(0, 8)}`
}

function describePermissionCheck(call: { name: string; args: unknown }): PermissionRequest | null {
  const a = (call.args ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  switch (call.name) {
    case 'shell.run':
      return { kind: 'shell.run', command: str(a.command), reason: 'shell command execution' }
    case 'code.execute':
      return {
        kind: 'code.execute',
        command: `[${str(a.language) || '?'}] ${str(a.code)}`,
        reason: 'arbitrary code execution',
      }
    case 'shell.process_start':
      return { kind: 'shell.process', command: str(a.command), reason: 'background process start' }
    case 'fs.write':
      return { kind: 'fs.write', path: str(a.path), reason: 'fs.write request' }
    case 'fs.patch':
      return { kind: 'fs.patch', path: str(a.path), reason: 'fs.patch request' }
    case 'sui.send':
      return {
        kind: 'chain.send',
        amount: optStr(a.amount) ?? '?',
        recipient: optStr(a.to) ?? '?',
        token: 'SUI',
        reason: 'SUI transfer',
      }
    case 'navi.supply':
    case 'navi.withdraw':
    case 'scallop.supply':
    case 'scallop.withdraw':
      return {
        kind: 'chain.write',
        command: `${call.name} ${optStr(a.amount) ?? '?'} SUI`,
        reason: `${call.name.split('.')[0]} ${call.name.split('.')[1]}`,
      }
    case 'policy.create':
      return {
        kind: 'chain.write',
        command: 'policy.create',
        reason: 'create on-chain lyra::policy AgentPolicy',
      }
    case 'walrus.store':
      return {
        kind: 'chain.write',
        command: `walrus.store (${optStr(a.epochs) ?? '3'} epochs)`,
        reason: 'pay to store a durable Walrus blob',
      }
    default:
      // Fail-closed: any value-moving on-chain tool not richly described above
      // still gets gated (strict denies, prompt asks) so nothing slips through.
      if (isValueMovingTool(call.name)) {
        return {
          kind: 'chain.write',
          command: `${call.name} ${optStr(a.amount) ?? ''}`.trim(),
          reason: `on-chain write: ${call.name}`,
        }
      }
      return null
  }
}

async function readMemoryFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Construct the full lyra runtime (tools, brain, plugins, listeners, sync)
 * inside the sandbox harness. Mirrors `chat.tsx` local-mode setup minus the
 * TUI rendering layer; plugin events publish through the EventHub instead.
 *
 * Lifecycle:
 *   1. Build Sui client/keypair + onchain ctx + plugins
 *   2. Construct PermissionService bridged to ApprovalRelay
 *   3. Build prefix + activity log + sync manager
 *   4. Init brain + start listeners (background)
 *   5. Returned object is the long-lived runtime handle real-runtime keeps
 */
export async function buildLyraRuntime(opts: BuildRuntimeOpts): Promise<BuiltRuntime> {
  const { config, agentSecret, agentAddress, events, approvals } = opts
  const network = config.network
  const agentId = placeholderAgentId(agentAddress)
  const agentDir = opts.agentDir
  const memoryDir = `${agentDir}/memory`
  const memoryIndexPath = `${agentDir}/memory/MEMORY.md`
  const activityLogPath = `${agentDir}/activity.jsonl`
  const configPath = opts.configPath ?? `${agentDir}/.config-handle.ts`
  const workspaceRoot = opts.workspaceRoot ?? process.cwd()

  await mkdir(memoryDir, { recursive: true })
  await mkdir(`${memoryDir}/agent`, { recursive: true })
  await mkdir(`${memoryDir}/user`, { recursive: true })

  // Memory is local-only: the agent's memory + activity-log persist as plain
  // files under `${agentDir}` via the memory.save/read tools. The previous
  // on-chain (iNFT slot) rehydrate was removed. `slotStatus` is retained
  // (empty) for the /healthz response shape; `triggerLazyRestore` is a no-op.
  const slotStatus = new Map<string, { status: string; reason?: string; bytes?: number }>()
  const triggerLazyRestore = (): void => {}

  // 1. ToolRegistry + memory tools
  const tools = new ToolRegistry(config.tools as Record<string, boolean> | undefined)
  tools.register(makeMemorySaveTool({ agentId, agentDir }) as Parameters<typeof tools.register>[0])
  tools.register(makeMemoryReadTool({ agentId, agentDir }) as Parameters<typeof tools.register>[0])
  tools.register(makeMemoryListTool({ agentId, agentDir }) as Parameters<typeof tools.register>[0])
  tools.register(makeToolSearchTool(tools) as Parameters<typeof tools.register>[0])

  // 2. Permission service. Default sandbox mode = 'off' (yolo) for autonomous
  // runtime; operator can override via config.permissions = 'prompt' but must
  // stay online for the modal round-trip in that case.
  const permissionMode: PermissionMode = PERMISSION_MODE_MAP[config.permissions ?? 'off']
  const permission = new PermissionService({ mode: permissionMode })

  // Bridge prompter → ApprovalRelay → SSE event for operator's TUI to see.
  permission.setPrompter(async req => {
    const { promise } = approvals.request({
      kind: req.kind,
      command: req.command,
      path: req.path,
      amount: req.amount,
      recipient: req.recipient,
      token: req.token,
      reason: req.reason,
    })
    const decision = await promise
    if (decision === 'allow') return 'allow-once' as PermissionDecision
    if (decision === 'allow-session') return 'allow-session' as PermissionDecision
    return 'deny' as PermissionDecision
  })

  const hooks = new HookBus()
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
        policyFromEnv(process.env),
      )
    ) {
      checks.force = true
    }
    const result = await permission.resolve(checks)
    if (result.allowed) return undefined
    return {
      short: {
        ok: false,
        error: `Denied: ${result.reason ?? 'permission check failed'} (mode=${permission.getMode()}). Operator rejected this call. Do NOT retry, instruct another tool, or claim the transaction is queued.`,
      },
    }
  })

  // 3. LLM config (OpenAI-compatible) + Sui client/keypair
  const { llmApiKey, llmBaseUrl, llmModel, brainModelLabel } = resolveLlmConfig(config)
  // Vision routing via the OpenAI-compatible brain is a follow-up; disabled for now.
  const visionInfer: VisionInferFn | null = null

  // 4. Plugin filter + side-band ctxs (onchain + telegram)
  const pluginNames = (config.plugins ?? ['system', 'onchain']).filter(
    p => p === 'system' || p === 'onchain' || p === 'telegram',
  )

  // Build the Sui runtime context the plugin reads via `(ctx as any).onchain`.
  // One Ed25519 agent keypair signs + pays gas; the deterministic policy
  // (off-chain mirror, re-enforced on-chain by lyra::policy) bounds it.
  const onchain = await buildOnchainContext({
    pluginNames,
    config,
    network,
    agentSecret,
    agentAddress,
    agentDir,
  })

  // Phase 12 / B6: telegram side-band ctx for sandbox mode.
  // Closes G3 (the hollow telegram block in this file). The dispatcher mirrors
  // the chat-telegram local-mode pattern: forward inbound DMs through brain
  // with source='telegram', publish events to EventHub so chat-sandbox.tsx
  // renders the row, fire-and-forget per-turn sync. Approval bridge slots
  // are filled by listener.start() so the operator can approve tool calls
  // from their phone via inline keyboard.
  // v0.24.4: pairing store is hoisted out of the telegram conditional so the
  // /admin/pairing/approve endpoint can route an operator-signed approval to
  // it even before any TG listener is wired. Lives at the canonical CLI-shared
  // path (`~/.lyra/agents/<id>/pairing`) so codes generated by the daemon
  // are visible to `lyra pairing approve` running on the operator's machine.
  // The daemon's tmp-scratch agentDir (under TMPDIR/lyra-gateway) is NOT
  // the right location; it diverges from where the CLI reads from.
  const { PairingStore, agentPaths } = await import('lyra-core')
  const pairingStore = new PairingStore({ dir: agentPaths.agent(agentId).pairingDir })

  let telegram: TelegramRuntimeContext | undefined
  let telegramDispatchSlot: {
    current: ((i: TelegramDispatchInput) => Promise<TelegramDispatchResult>) | null
  } | null = null
  let telegramPendingApprovals: Map<string, (choice: ApprovalChoiceKind) => void> | null = null
  let telegramApprovalIdFactory: (() => string) | null = null
  let telegramApprovalBridge: TelegramApprovalBridge | null = null
  // v0.24.12: slot the TG listener fills on start with a broadcast method;
  // gateway calls it on clarify tool calls when no TUI is connected.
  const telegramOperatorNotifier: { current: ((text: string) => Promise<void>) | null } = {
    current: null,
  }
  if (opts.secrets?.telegram && pluginNames.includes('telegram')) {
    const tg = opts.secrets.telegram
    telegramDispatchSlot = { current: null }
    telegramPendingApprovals = new Map()
    telegramApprovalIdFactory = makeApprovalIdFactory()
    telegramApprovalBridge = {
      sendApproval: { current: null },
      installCallbackHandler: { current: null },
    }
    telegram = {
      botToken: tg.botToken,
      allowedUserIds: tg.allowedUserIds,
      agentName: resolveAgentName(config.subname, agentId),
      pairingStore,
      dispatchUserMessage: async input => {
        const cb = telegramDispatchSlot?.current
        if (!cb) return { response: 'agent is still booting; try again in a moment.' }
        return cb(input)
      },
      onProcessingStart: async (chatId, msgId) => {
        events.publish('listener-event', {
          kind: 'telegram-processing-start',
          chatId,
          messageId: msgId,
        })
      },
      onProcessingEnd: async (chatId, msgId, ok) => {
        events.publish('listener-event', {
          kind: 'telegram-processing-end',
          chatId,
          messageId: msgId,
          ok,
        })
      },
      approvalBridge: telegramApprovalBridge,
      operatorNotifier: telegramOperatorNotifier,
    }
  }

  const collectedListeners: Listener[] = []
  const skillsDisabled = { current: [] as string[] }

  // Sub-brain factory for delegate.task. Mirrors chat.tsx: a fresh
  // OGComputeBrain on the same provider/model with a custom system prompt
  // and the requested tool subset. Without this the delegate.task tool
  // never registers (the plugin gates registration on ctx.delegateFactory).
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

  // Resolver imports plugin packages directly (workspace deps; cycle-free).
  const loadResult = await loadPlugins(pluginNames, {
    tools,
    hooks,
    listeners: { register: l => collectedListeners.push(l) },
    agentDir,
    agentId,
    network,
    configPath,
    imports: { claudeCode: true },
    skillsDisabled,
    activityLogPath,
    workspaceRoot,
    claudeAgents: [],
    brainSupportsVision: false,
    brainModelLabel,
    visionInfer,
    onchain,
    telegram,
    delegateFactory,
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
  if (loadResult.errors.length > 0) {
    events.publish('log', {
      level: 'warn',
      message: `plugin-load-errors: ${loadResult.errors.map(e => `${e.plugin}=${e.error}`).join(', ')}`,
    })
  }

  // 5. MemorySyncManager + activity log + frozen prefix
  //
  // Path split that matters for /sync correctness (v0.23.0):
  //   - `activityLogPath` is the DAEMON's runtime log (under TMPDIR) - the
  //     gateway appends every wake/tool-call/brain-response there, so /sync
  //     must read from this path to capture the live history.
  //   - `memoryDir` MUST point at the same `${agentDir}/memory` that the
  //     memory.save/read/list tools now write to (we override the legacy
  //     `agentPaths.agent(id)` resolution via `agentDir` in makeMemory*Tool
  //     args above). Without this override /sync uploads the stale
  //     `~/.lyra/agents/<id>/memory` snapshot and ignores the operator's
  //     live saves under TMPDIR.
  //   - `profileKey` (optional) keys the operator-scoped PROFILE slot. When
  //     undefined (sandbox cold-start), profile flush is skipped silently
  //     until `lyra profile init` ships a key via /admin/profile-key.
  // Local-only memory: the on-chain (iNFT slot) sync was removed. This no-op
  // preserves the per-turn flush + flushAll call sites (which now do nothing)
  // without any chain work; memory persists as files via the memory.* tools.
  const sync = {
    flushTurn: async (): Promise<{ txHash: string | null; changedSlots: string[] }> => ({
      txHash: null,
      changedSlots: [],
    }),
    flushAll: async (): Promise<{ txHash: string | null; changedSlots: string[] }> => ({
      txHash: null,
      changedSlots: [],
    }),
    setProfileKey: (_key: Buffer): void => {},
  }
  const activity = new ActivityLog(activityLogPath)

  const [memoryIndex, identityText, personaText, scannedSkills] = await Promise.all([
    readIndexFile(memoryIndexPath).catch(() => null),
    readMemoryFileOrNull(`${memoryDir}/agent/identity.md`),
    readMemoryFileOrNull(`${memoryDir}/agent/persona.md`),
    scanSkills({ importsClaudeCode: true }).catch(() => [] as SkillRef[]),
  ])
  const skillsRef = { current: scannedSkills }

  const loadedToolNames = tools.list().map(t => t.name)
  const promptAppend = config.promptAppend ?? null
  const envInfo = {
    cwd: workspaceRoot,
    platform: process.platform,
    sandbox: {
      mode: 'docker' as const,
      label: 'lyra-sandbox (docker)',
      innerOs: 'linux' as const,
      workspaceMount: workspaceRoot,
      scope: 'sandbox-deploy',
    },
  }
  const extraGuidance: string[] = []
  if (onchain) extraGuidance.push(ONCHAIN_GUIDANCE)
  if (telegram) extraGuidance.push(TELEGRAM_GUIDANCE)

  const buildPrefix = async () => {
    // v0.22.0: re-read identity/persona/index each turn so a successful
    // lazy-retry restore lands in the next prompt without a daemon restart.
    // Also kick the lazy retry (single-flight) for any slot still missing.
    triggerLazyRestore()
    const [idx, identityFresh, personaFresh] = await Promise.all([
      readIndexFile(memoryIndexPath).catch(() => null),
      readMemoryFileOrNull(`${memoryDir}/agent/identity.md`),
      readMemoryFileOrNull(`${memoryDir}/agent/persona.md`),
    ])
    return buildFrozenPrefix({
      memoryIndex: idx,
      identity: identityFresh ?? identityText,
      persona: personaFresh ?? personaText,
      loadedToolNames,
      skills: skillsRef.current,
      promptAppend,
      envInfo,
      extraGuidance,
    })
  }
  const initialPrefix = buildFrozenPrefix({
    memoryIndex,
    identity: identityText,
    persona: personaText,
    loadedToolNames,
    skills: skillsRef.current,
    promptAppend,
    envInfo,
    extraGuidance,
  })

  // Skill auto-trigger
  const pendingSkillInjections = new Set<string>()
  hooks.add<PostToolCallContext, void>('post_tool_call', async ({ call, result }) => {
    if (result.ok === false) return
    const matches = matchSkillTriggers({ name: call.name, args: call.args }, skillsRef.current)
    for (const match of matches) {
      if (pendingSkillInjections.has(match.skill.id)) continue
      pendingSkillInjections.add(match.skill.id)
      events.publish('log', {
        level: 'info',
        message: `skill auto-loaded: ${match.skill.id} (matched ${match.reason})`,
      })
    }
  })

  // 6. Brain. onToolCall fires tool-call-start/end events on the EventHub so
  // the operator's TUI renders ▸/↳ indicators.
  const persistConversations = config.brain?.persistConversations !== false
  const brain = new OpenAIBrain({
    apiKey: llmApiKey,
    baseUrl: llmBaseUrl,
    model: llmModel,
    tools: tools.schemas(),
    prefix: initialPrefix,
    maxOutputTokens: config.brain?.maxOutputTokens,
    compaction: resolveCompaction(config),
    persist: persistConversations
      ? createFsHistoryPersist({ dir: `${agentDir}/conversations` })
      : undefined,
    onToolCall: async call => {
      const startedAt = Date.now()
      events.publish('tool-call-start', {
        name: call.name,
        args: summarizeArgs(call.args),
        callId: call.id,
      })
      const pre = await hooks.runPreToolCall({ call })
      if (pre.short) {
        const durationMs = Date.now() - startedAt
        await activity.append({
          ts: Date.now(),
          kind: 'tool-call',
          data: { call, result: pre.short, blocked: true },
        })
        events.publish('tool-call-end', {
          name: call.name,
          ok: pre.short.ok !== false,
          callId: call.id,
          durationMs,
          summary: summarizeToolResult(pre.short),
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
      const durationMs = Date.now() - startedAt
      events.publish('tool-call-end', {
        name: call.name,
        ok: result.ok !== false,
        callId: call.id,
        durationMs,
        summary: summarizeToolResult(result),
      })
      // v0.24.12+v0.24.14: forward clarify questions to Telegram operators
      // when no live TUI is connected. v0.24.12 originally gated on
      // `events.size() === 0` (no SSE subscribers at all) but in practice
      // /console + lyra-launch dashboards hold persistent SSE
      // connections, so the gate never fired. v0.24.14 swaps to
      // `events.sizeOfKind("tui") === 0`: chat.tsx tags itself `tui` on
      // subscribe, web dashboards tag themselves `dashboard`. Only a
      // missing TUI triggers TG forwarding now.
      maybeForwardClarifyToTelegram({
        call,
        effectiveCall,
        result,
        telegramOperatorNotifier,
        events,
      })
      // v0.21.2 R1: see chat.tsx for paired logic. Gateway sinks are SSE
      // start/end events instead of TUI state rows; orchestration shared
      // via runEscalation.
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
            events.publish('tool-call-start', {
              name: c.name,
              args: summarizeArgs(c.args),
              callId: c.id,
              autoEscalated: true,
            }),
          onEnd: (c, r, durationMs) =>
            events.publish('tool-call-end', {
              name: c.name,
              ok: r.ok !== false,
              callId: c.id,
              durationMs,
              summary: summarizeToolResult(r),
              autoEscalated: true,
            }),
        })
        return { role: 'tool', content: JSON.stringify(merged) } as BrainMessage
      }
      return { role: 'tool', content: JSON.stringify(result) } as BrainMessage
    },
  })

  await brain.init()

  // 6.5. Phase 12 telegram dispatch + approval bridge wiring. Slot must be
  // filled BEFORE listeners start so any inbound TG message that races sees
  // the real dispatcher, not the boot-time stub.
  if (telegram && telegramDispatchSlot && telegramPendingApprovals && telegramApprovalIdFactory) {
    telegramDispatchSlot.current = makeTelegramDispatcher({
      pending: telegramPendingApprovals,
      idFactory: telegramApprovalIdFactory,
      bridge: telegramApprovalBridge,
      permission,
      brain,
      activity,
      events,
      sync,
    })
  }

  // 7. Start gateway listeners in the background. Don't await; catch-up can
  // be slow and the harness needs to accept /chat immediately after Ready.
  for (const l of collectedListeners) {
    void l.start(undefined as never).catch(err => {
      events.publish('log', {
        level: 'error',
        message: `listener ${l.name} failed: ${(err as Error).message}`,
      })
    })
  }

  const dispose = async (): Promise<void> => {
    for (const l of collectedListeners) {
      try {
        await l.stop?.()
      } catch {
        // best-effort
      }
    }
  }

  // v0.21.0: agent funds its own compute bills out of its EOA. Manager polls
  // the per-provider envelope and refills via depositFund + transferFund when
  // it drops below threshold. Notifications flow through `events` (TUI ✂︎-style
  // system row) and the activity log. Disabled when `economy.autoTopup.enabled
  // === false`.
  // Compute self-funding (auto-topup) was removed with the decentralized-compute backend.
  const autoTopup = null

  // v0.23.0: live-flip the operator-scoped PROFILE key. Called when the
  // operator runs `lyra profile init` against a sandbox endpoint and the
  // gateway forwards the raw 32-byte key here. Updates the live sync manager
  // + fires a one-shot restore so the profile blob (if anchored) lands on
  // disk this turn.
  const setProfileKey = async (
    keyHex: `0x${string}`,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(keyHex)) {
      return { ok: false, reason: 'invalid-key-format' }
    }
    const buf = Buffer.from(keyHex.slice(2), 'hex')
    sync.setProfileKey(buf)
    return { ok: true }
  }

  // v0.24.4: approve a pending pairing code via PairingStore.approveCode.
  // Returns a normalized result shape (`{ ok, userId, userName }` on success,
  // `{ ok: false, reason }` on failure) so the HTTP layer + tests don't have
  // to repeat the platform-locked-out / unknown-code branching.
  const approvePairing = (
    platform: string,
    code: string,
  ): { ok: true; userId: string; userName: string } | { ok: false; reason: string } => {
    const result = pairingStore.approveCode(platform, code)
    if (result) return { ok: true, userId: result.userId, userName: result.userName }
    if (pairingStore.isLockedOut(platform)) {
      return { ok: false, reason: 'locked-out' }
    }
    return { ok: false, reason: 'unknown-or-expired-code' }
  }

  return {
    brain,
    tools,
    permission,
    hooks,
    sync,
    activity,
    listeners: collectedListeners,
    buildPrefix,
    refreshUserContext: async () => {
      const next = await buildPrefix()
      brain.refreshUserContext(next)
    },
    dispose,
    agentId,
    autoTopup,
    slotStatus,
    setProfileKey,
    approvePairing,
  }
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

function summarizeToolResult(result: unknown): string {
  const r = result as { ok?: boolean; error?: string; data?: { path?: string } } | null | undefined
  if (!r || r.ok === undefined) return 'done'
  if (r.ok === false) return (r.error ?? 'failed').slice(0, 200)
  const path = typeof r.data?.path === 'string' ? r.data.path : null
  return path ? path : 'ok'
}

/**
 * v0.24.12: pull the `question` string out of clarify tool args. Schema is
 * `{ question: string, options?: string[] }`. Returns null for unexpected
 * shapes so the forwarder no-ops silently rather than spamming garbage.
 */
function extractClarifyQuestion(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const q = (args as { question?: unknown }).question
  if (typeof q !== 'string' || q.trim().length === 0) return null
  const opts = (args as { options?: unknown }).options
  if (Array.isArray(opts) && opts.length > 0) {
    const lines = opts
      .filter((o): o is string => typeof o === 'string')
      .map((o, i) => `${i + 1}. ${o}`)
      .join('\n')
    return lines ? `${q.trim()}\n\n${lines}` : q.trim()
  }
  return q.trim()
}

/**
 * Mirror of chat-telegram.ts handleBypass for the gateway dispatch path.
 * Runs BEFORE brain.infer so /yolo, /perms, /reset operate without burning
 * compute. Returns the reply text the listener will deliver to the chat.
 */
async function dispatchTelegramBypass(
  bypass: ParsedBypass,
  sessionKey: string,
  permission: PermissionService,
  brain: OpenAIBrain,
): Promise<string> {
  switch (bypass.command) {
    case '/stop':
      return 'no active turn to stop in this dispatch path.'
    case '/new':
    case '/reset':
      try {
        await brain.clearChannel(sessionKey)
        return "conversation reset (this chat's history cleared)."
      } catch (err) {
        return `reset failed: ${(err as Error).message?.slice(0, 200) ?? 'unknown error'}`
      }
    case '/status':
      return 'idle.'
    case '/approve':
    case '/deny':
      return 'inline-keyboard approval is the supported path; click the buttons in the modal.'
    case '/yolo':
      return applyYolo(permission).message
    case '/perms':
      return applyPerms(permission, bypass.args[0]).message
    case '/background':
    case '/restart':
      return `${bypass.command} is reserved for a future bundle.`
  }
}

/**
 * Resolve the OpenAI-compatible LLM settings from env + config. No personal
 * key set → fall back to the hosted demo proxy so lyra runs keyless.
 */
function resolveLlmConfig(config: RuntimeConfig): {
  llmApiKey: string
  llmBaseUrl: string | undefined
  llmModel: string
  brainModelLabel: string
} {
  const userLlmKey = process.env.OPENAI_API_KEY ?? process.env.LYRA_LLM_API_KEY
  const llmApiKey = userLlmKey ?? DEMO_LLM_TOKEN
  const llmBaseUrl = process.env.LYRA_LLM_BASE_URL ?? (userLlmKey ? undefined : DEMO_LLM_BASE_URL)
  const llmModel = process.env.LYRA_LLM_MODEL ?? config.brain?.model ?? 'gpt-4o-mini'
  const brainModelLabel = config.brain.model ?? config.brain.provider
  return { llmApiKey, llmBaseUrl, llmModel, brainModelLabel }
}

/**
 * Mirror of the inline brain-compaction default resolution. Returns null when
 * compaction is explicitly disabled (`config.brain.compaction === null`).
 */
function resolveCompaction(
  config: RuntimeConfig,
): { threshold: number; contextWindow: number; keepRecent: number } | null {
  if (config.brain?.compaction === null) return null
  return {
    threshold: config.brain?.compaction?.threshold ?? 0.5,
    contextWindow: config.brain?.contextWindow ?? 1_000_000,
    keepRecent: config.brain?.compaction?.keepRecent ?? 8,
  }
}

/**
 * Build the Sui runtime context the onchain plugin reads via `(ctx).onchain`.
 * One Ed25519 agent keypair signs + pays gas; the deterministic policy bounds
 * it. Auto-resolves the agent's treasury vault (best-effort) so DeFi tools
 * source funds from the vault via policy-gated vault_spend; falls back to the
 * agent's own SUI when there's no vault. Returns undefined when the onchain
 * plugin isn't enabled.
 */
async function buildOnchainContext(params: {
  pluginNames: string[]
  config: RuntimeConfig
  network: RuntimeConfig['network']
  agentSecret: string
  agentAddress: string
  agentDir: string
}): Promise<OnchainRuntimeContext | undefined> {
  const { pluginNames, config, network, agentSecret, agentAddress, agentDir } = params
  if (!pluginNames.includes('onchain')) return undefined
  const client = makeSuiClient(network)
  const keypair = keypairFromSecret(agentSecret)
  const vault = await resolveVaultForAgent(agentAddress, network).catch(() => null)
  return {
    client,
    keypair,
    agentAddress,
    network,
    policy: policyFromEnv(process.env),
    packageId: config.identity.packageId ?? process.env.LYRA_PACKAGE_ID,
    policyObjectId:
      config.identity.policyObjectId ?? process.env.LYRA_POLICY_OBJECT_ID ?? vault?.policyId,
    vaultId: vault?.vaultId,
    vaultMist: vault?.vaultMist,
    ownerAddress: vault?.owner,
    agentDir,
    brainProvider: config.brain.provider,
    brainModel: config.brain.model,
  }
}

/**
 * v0.24.12+v0.24.14: forward clarify questions to Telegram operators when no
 * live TUI is connected. Extracted from the brain's onToolCall so its deep
 * nesting doesn't inflate that callback's cognitive complexity. Only a missing
 * TUI (`events.sizeOfKind('tui') === 0`) triggers TG forwarding — web
 * dashboards tag themselves `dashboard`, so a persistent /console connection
 * no longer suppresses it.
 */
function maybeForwardClarifyToTelegram(params: {
  call: { name: string }
  effectiveCall: { args: unknown }
  result: { ok?: boolean }
  telegramOperatorNotifier: { current: ((text: string) => Promise<void>) | null }
  events: EventHub
}): void {
  const { call, effectiveCall, result, telegramOperatorNotifier, events } = params
  if (call.name !== 'clarify' || result.ok === false) return
  const tgNotify = telegramOperatorNotifier.current
  if (!tgNotify || events.sizeOfKind('tui') !== 0) return
  const question = extractClarifyQuestion(effectiveCall.args)
  if (!question) return
  void tgNotify(question).catch(err => {
    console.warn(
      `[gateway] tg operator notify failed: ${(err as Error).message?.slice(0, 200) ?? 'unknown'}`,
    )
  })
}

/**
 * Map a Telegram inline-keyboard approval choice to a PermissionDecision.
 * Extracted so the resolver arrow carries no nested ternary.
 */
function mapApprovalChoice(choice: ApprovalChoiceKind): PermissionDecision {
  return choice === 'once'
    ? 'allow-once'
    : choice === 'session' || choice === 'always'
      ? 'allow-session'
      : 'deny'
}

/**
 * Build the per-turn approval prompter used when Telegram inline-keyboard
 * approvals are active. Hoisted to module scope so its Promise/timeout/resolver
 * nesting doesn't inflate the dispatcher's cognitive complexity.
 */
function buildTelegramTurnPrompter(params: {
  send: (chatId: number, text: string, approvalId: string) => Promise<void>
  pending: Map<string, (choice: ApprovalChoiceKind) => void>
  idFactory: () => string
  chatId: number
}): (req: PermissionRequest) => Promise<PermissionDecision> {
  const { send, pending, idFactory, chatId } = params
  return async req => {
    const approvalId = idFactory()
    const body = `🔐 Approval needed for ${req.kind}\n\n${req.command ?? req.path ?? req.recipient ?? ''}\n\nReason: ${req.reason}`
    console.log(`[tg-approval] prompter invoked: id=${approvalId} kind=${req.kind} chat=${chatId}`)
    return new Promise<PermissionDecision>(resolve => {
      const timeoutMs = 5 * 60_000
      const timer = setTimeout(() => {
        if (pending.delete(approvalId)) {
          console.log(`[tg-approval] TIMEOUT after ${timeoutMs}ms: id=${approvalId} → deny`)
          resolve('deny')
        }
      }, timeoutMs)
      pending.set(approvalId, choice => {
        console.log(`[tg-approval] resolver fired: id=${approvalId} choice=${choice}`)
        clearTimeout(timer)
        resolve(mapApprovalChoice(choice))
      })
      void send(chatId, body, approvalId)
        .then(() => console.log(`[tg-approval] inline keyboard sent: id=${approvalId}`))
        .catch(err => {
          console.log(
            `[tg-approval] inline keyboard send FAILED: id=${approvalId} err=${(err as Error).message?.slice(0, 100)}`,
          )
          clearTimeout(timer)
          if (pending.delete(approvalId)) resolve('deny')
        })
    })
  }
}

/**
 * Configure the permission service for a single Telegram turn and return a
 * restore fn for the caller's finally block. When inline-keyboard approvals
 * are available (`send`), install the TG prompter and (unless the operator has
 * globally set yolo/strict) force 'prompt' mode; otherwise force 'off'.
 * LYRA_TG_YOLO=1 skips the approval dance and is read per-turn so it can be
 * flipped without restarting.
 */
function beginTelegramTurnPermission(params: {
  permission: PermissionService
  bridge: TelegramApprovalBridge | null
  pending: Map<string, (choice: ApprovalChoiceKind) => void>
  idFactory: () => string
  chatId: number
}): () => void {
  const { permission, bridge, pending, idFactory, chatId } = params
  const previousMode = permission.getMode()
  const previousPrompterRef = (
    permission as unknown as {
      prompter: (req: PermissionRequest) => Promise<PermissionDecision>
    }
  ).prompter
  const tgYolo = process.env.LYRA_TG_YOLO === '1'
  const send = !tgYolo ? bridge?.sendApproval.current : undefined
  if (send) {
    permission.setPrompter(buildTelegramTurnPrompter({ send, pending, idFactory, chatId }))
    if (previousMode !== 'off' && previousMode !== 'strict') {
      permission.setMode('prompt')
    }
  } else if (previousMode !== 'off') {
    permission.setMode('off')
  }
  return () => {
    permission.setMode(previousMode)
    if (send && previousPrompterRef) permission.setPrompter(previousPrompterRef)
  }
}

/**
 * Build the sandbox-mode Telegram dispatcher (mirrors chat-telegram local
 * mode): forward inbound DMs through the brain with source='telegram', publish
 * events to the EventHub, intercept bypass commands before brain.infer, and
 * fire-and-forget per-turn sync. The returned handler is stored in the
 * dispatch slot BEFORE listeners start so any racing inbound TG message sees
 * the real dispatcher, not the boot-time stub.
 */
function makeTelegramDispatcher(deps: {
  pending: Map<string, (choice: ApprovalChoiceKind) => void>
  idFactory: () => string
  bridge: TelegramApprovalBridge | null
  permission: PermissionService
  brain: OpenAIBrain
  activity: ActivityLog
  events: EventHub
  sync: { flushTurn: () => Promise<{ txHash: string | null; changedSlots: string[] }> }
}): (input: TelegramDispatchInput) => Promise<TelegramDispatchResult> {
  const { pending, idFactory, bridge, permission, brain, activity, events, sync } = deps
  let approvalCallbackInstalled = false
  const ensureApprovalCallback = (): void => {
    if (approvalCallbackInstalled) return
    const install = bridge?.installCallbackHandler.current
    if (!install) return
    install((approvalId, choice, _fromUserId) => {
      const r = pending.get(approvalId)
      if (r) {
        pending.delete(approvalId)
        r(choice)
      }
    })
    approvalCallbackInstalled = true
  }

  return async input => {
    ensureApprovalCallback()
    // Strip the channel envelope ONCE for preview + bypass parsing. The brain
    // dispatch path further down still receives `input.text` with envelope
    // intact (source/chat/user context matters for brain reasoning). Without
    // the strip, parseBypassCommand sees `<channel ...>` not `/`, so `/yolo`
    // `/perms` `/reset` from TG silently fall through to the brain.
    const innerText = stripTelegramChannelEnvelope(input.text)

    // Publish inbound event so chat-sandbox.tsx renders a row.
    events.publish('listener-event', {
      kind: 'telegram-inbound',
      chatId: input.chatId,
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      preview: formatTelegramInboundPreview({
        chatId: input.chatId,
        username: input.username,
        displayName: input.displayName,
        text: innerText,
      }),
    })

    // v0.20.0: bypass commands intercepted BEFORE brain.infer so /yolo, /perms,
    // /reset work in sandbox + gateway-local mode, not just the legacy TUI path.
    const bypass = parseBypassCommand(innerText)
    if (bypass) {
      const reply = await dispatchTelegramBypass(bypass, input.sessionKey, permission, brain)
      return { response: reply }
    }
    // Configure a TG-aware prompter for this turn (closes over input.chatId)
    // and capture a restore fn for the finally block.
    const restorePermission = beginTelegramTurnPermission({
      permission,
      bridge,
      pending,
      idFactory,
      chatId: input.chatId,
    })
    try {
      await activity.append({
        ts: Date.now(),
        kind: 'wake',
        data: {
          source: 'telegram',
          chatId: input.chatId,
          userId: input.userId,
          text: input.text,
        },
      })
      const turn = await brain.infer({
        event: {
          id: newEventId(),
          source: 'telegram',
          payload: { label: 'telegram-message', data: input.text },
          ts: Date.now(),
        },
        channelKey: input.sessionKey,
        // Forward per-turn tool-call observer so the listener's ProgressTracker
        // can render a live progress message in TG.
        onToolEvent: input.onToolEvent
          ? ev => {
              input.onToolEvent?.({
                kind: ev.kind,
                tool: ev.tool,
                callId: ev.callId,
                argsPreview: ev.argsPreview,
                ok: ev.ok,
              })
            }
          : undefined,
        onCompactionEvent: ev => {
          events.publish('context-compacted', ev)
          void activity
            .append({ ts: Date.now(), kind: 'context-compacted', data: ev })
            .catch(() => {})
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
          source: 'telegram',
        },
      })
      const response = (turn.content ?? '').trim()
      events.publish('listener-event', {
        kind: 'telegram-outbound',
        chatId: input.chatId,
        length: response.length,
      })
      // Fire-and-forget memory sync (Walrus, when wired). Awaiting it would
      // block the dispatch lock and stack up queued telegram messages behind a
      // single in-flight turn. Surface the tx via the listener-event channel.
      void sync
        .flushTurn()
        .then(r => {
          if (r.txHash) {
            events.publish('listener-event', {
              kind: 'sync-flush',
              source: 'telegram',
              chatId: input.chatId,
              txHash: r.txHash,
            })
          }
        })
        .catch(() => {
          /* swallow — sync errors should never block reply */
        })
      return { response: response.length === 0 ? '(no reply)' : response }
    } finally {
      restorePermission()
    }
  }
}
