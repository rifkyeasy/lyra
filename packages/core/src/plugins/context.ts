import type { ClaudeAgent } from '../claude-plugins/types'
import type { LyraNetwork } from '../config'
import type { Listener } from '../events/listeners'
import type { SandboxBackend } from '../sandbox/types'
import type { ToolRegistry } from '../tools/registry'
import type { ToolDef, ToolSchema } from '../tools/types'
import type { HookBus, HookHandler, HookName } from './hooks'

/** Vision inputs for image-capable models (provider-agnostic). */
export type VisionInferImage = { bytes: Uint8Array; mediaType: string }
export type VisionInferInput = {
  prompt: string
  images: VisionInferImage[]
  maxOutputTokens?: number
}
export type VisionInferResult = {
  content: string
  model?: string | null
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedTokens?: number
  }
  finishReason?: string
}
export type VisionInferFn = (input: VisionInferInput) => Promise<VisionInferResult>

/**
 * Factory chat.tsx supplies for `delegate.task` to spin up a sub-brain. The
 * implementation typically wraps `OGComputeBrain` with a custom system prompt
 * + restricted tool surface.
 */
export interface DelegateBrainFactoryOpts {
  systemPrompt: string
  tools: ToolSchema[]
}

export interface DelegateBrainTurn {
  content: string | null
  finishReason?: string
  toolCalls?: Array<{ id: string; name: string; args: unknown }>
  usage?: {
    totalTokens?: number
    cachedTokens?: number
    promptTokens?: number
    completionTokens?: number
  }
}

export interface DelegateBrainHandle {
  infer(input: {
    event: { id: string; source: 'stdin'; payload: { label: string; data: string }; ts: number }
  }): Promise<DelegateBrainTurn>
}

export type DelegateBrainFactory = (opts: DelegateBrainFactoryOpts) => Promise<DelegateBrainHandle>

/**
 * Context handed to a plugin's `register(ctx)` function. Plugins use this
 * to contribute tools, listeners, and lifecycle hooks; we deliberately
 * keep the surface tiny so future plugin features extend it without
 * breaking existing native plugins.
 */
export interface PluginContext {
  registerTool: (def: ToolDef) => void
  registerListener: (l: Listener) => void
  addHook: <TIn = unknown, TOut = void>(name: HookName, fn: HookHandler<TIn, TOut>) => void
  /** Network the agent is configured for. */
  network: LyraNetwork
  /** Agent state directory (`~/.lyra/agents/<id>/`). */
  agentDir: string
  /** Per-agent unique id (matches `iNFTAgentId(...)` for non-stub agents). */
  agentId: string
  /** Absolute path to ~/.lyra/config.ts. Plugins that persist user-level state write here. */
  configPath: string
  /** Imports surface from config (e.g. claudeCode toggle for skills + MCP discovery). */
  imports: { claudeCode: boolean }
  /**
   * Mutable cell holding the user-disabled skill ids. Plugin tools that
   * change the list update this, and the chat rebuilds the skill index from
   * the current value next turn.
   */
  skillsDisabled: { current: string[] }
  /** Path to the agent's activity log (~/.lyra/agents/<id>/activity.jsonl). */
  activityLogPath: string
  /** Workspace cwd. Used by tools that spawn subprocesses. */
  workspaceRoot: string
  /**
   * Sub-brain factory (Phase 9.3 delegate.task). Chat.tsx supplies a closure
   * that builds an OGComputeBrain with broker creds. Tools without a brain
   * dependency ignore this.
   */
  delegateFactory?: DelegateBrainFactory
  /** Claude Code agents discovered from the local plugin cache. */
  claudeAgents: ClaudeAgent[]
  /** Whether the configured brain supports image inputs. */
  brainSupportsVision: boolean
  /** Brain model label (string). Surfaces in tool error messages. */
  brainModelLabel: string | null
  /**
   * v0.11 vision routing: when set, vision.analyze + browser.vision call
   * this function (backed by a BrokerPool entry pinned to the configured
   * vision provider). Null when no vision provider is configured.
   */
  visionInfer?: VisionInferFn | null
  /**
   * Phase 9.5: sandbox backend wrapping every spawn() in shell.run / code.execute /
   * shell.process_start. Optional for back-compat: legacy callers + tests that
   * don't supply one get a LocalBackend (passthrough) inside the plugin.
   */
  sandbox?: SandboxBackend
  /**
   * Phase 7 side-band runtime context for plugin-comms. Opaque to core; the
   * plugin reads its concrete shape via a typed cast. Holding the field as
   * `unknown` keeps core free of a back-edge to the comms package.
   */
  comms?: unknown
  /**
   * Phase 10 side-band runtime context for plugin-onchain. Same opaque
   * pattern as `comms`.
   */
  onchain?: unknown
  /**
   * Phase 12 side-band runtime context for plugin-telegram. Same opaque
   * pattern: chat.tsx (local) or build-runtime.ts (sandbox) builds the typed
   * `TelegramRuntimeContext` and passes it; the plugin casts on read.
   */
  telegram?: unknown
}

export interface NativePlugin {
  name: string
  register: (ctx: PluginContext) => void | Promise<void>
}

export interface PluginLoadResult {
  loaded: string[]
  errors: { plugin: string; error: string }[]
}

export interface PluginLoaderDeps {
  tools: ToolRegistry
  hooks: HookBus
  listeners: { register: (l: Listener) => void }
  agentDir: string
  agentId: string
  network: LyraNetwork
  configPath: string
  imports: { claudeCode: boolean }
  skillsDisabled: { current: string[] }
  activityLogPath: string
  workspaceRoot: string
  delegateFactory?: DelegateBrainFactory
  claudeAgents?: ClaudeAgent[]
  brainSupportsVision?: boolean
  brainModelLabel?: string | null
  visionInfer?: VisionInferFn | null
  /** Phase 9.5 sandbox backend, propagated to plugin context. Optional. */
  sandbox?: SandboxBackend
  /** Phase 7 side-band runtime context for plugin-comms. Opaque to core. */
  comms?: unknown
  /** Phase 10 side-band runtime context for plugin-onchain. Opaque to core. */
  onchain?: unknown
  /** Phase 12 side-band runtime context for plugin-telegram. Opaque to core. */
  telegram?: unknown
  /**
   * Resolver for `name` → ESM module path. Defaults to dynamic import of
   * `lyra-ai-plugin-<name>`. Tests pass a stub.
   */
  resolve?: (name: string) => Promise<{ default?: NativePlugin } & Partial<NativePlugin>>
}

export async function loadPlugins(
  names: readonly string[],
  deps: PluginLoaderDeps,
): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], errors: [] }
  const ctx = buildPluginContext(deps)
  for (const name of names) {
    await loadSinglePlugin(name, deps, ctx, result)
  }
  return result
}

/** Assemble the immutable plugin context handed to every plugin's `register()`. */
function buildPluginContext(deps: PluginLoaderDeps): PluginContext {
  return {
    registerTool: def => deps.tools.register(def),
    registerListener: l => deps.listeners.register(l),
    addHook: (name, fn) => deps.hooks.add(name, fn),
    network: deps.network,
    agentDir: deps.agentDir,
    agentId: deps.agentId,
    configPath: deps.configPath,
    imports: deps.imports,
    skillsDisabled: deps.skillsDisabled,
    activityLogPath: deps.activityLogPath,
    workspaceRoot: deps.workspaceRoot,
    delegateFactory: deps.delegateFactory,
    claudeAgents: deps.claudeAgents ?? [],
    brainSupportsVision: deps.brainSupportsVision ?? false,
    brainModelLabel: deps.brainModelLabel ?? null,
    visionInfer: deps.visionInfer ?? null,
    sandbox: deps.sandbox,
    comms: deps.comms,
    onchain: deps.onchain,
    telegram: deps.telegram,
  }
}

/** Pick the `register(ctx)`-bearing plugin from a resolved module (default or named export). */
function selectPlugin(
  mod: { default?: NativePlugin } & Partial<NativePlugin>,
): NativePlugin | undefined {
  if (mod.default && 'register' in mod.default) return mod.default
  if ('register' in mod && typeof mod.register === 'function') {
    return mod as unknown as NativePlugin
  }
  return undefined
}

/** Resolve, validate, and register a single plugin, recording success/error into `result`. */
async function loadSinglePlugin(
  name: string,
  deps: PluginLoaderDeps,
  ctx: PluginContext,
  result: PluginLoadResult,
): Promise<void> {
  try {
    const mod = deps.resolve
      ? await deps.resolve(name)
      : ((await import(`lyra-ai-plugin-${name}`)) as {
          default?: NativePlugin
        } & Partial<NativePlugin>)
    const plugin = selectPlugin(mod)
    if (!plugin) {
      result.errors.push({ plugin: name, error: 'no exported register(ctx)' })
      return
    }
    await plugin.register(ctx)
    result.loaded.push(name)
  } catch (e) {
    result.errors.push({ plugin: name, error: (e as Error).message ?? String(e) })
  }
}
