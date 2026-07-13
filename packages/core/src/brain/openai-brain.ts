/**
 * Provider-agnostic, OpenAI-compatible brain for Lyra.
 *
 * Replaces the legacy decentralized-compute brain. Talks to any endpoint that
 * speaks the OpenAI `/chat/completions` shape via a simple `Authorization:
 * Bearer` header, so the same adapter serves OpenAI (default GPT-4o-mini),
 * Z.AI (GLM), Tencent Hunyuan, or any other compatible gateway by changing
 * `baseUrl` / `model` / `apiKey` — no code change.
 *
 * The infer/compaction/tool-loop logic is intentionally identical to the
 * harness's prior brain; only the transport (auth + endpoint) differs.
 */
import type { ToolSchema } from '../tools/types'
import {
  type CompactionOpts,
  DEFAULT_COMPACTION_OPTS,
  SUMMARY_SYSTEM_PROMPT,
  compactHistory,
  estimateTokens,
  shouldCompact,
} from './compaction'
import { type FrozenPrefix, renderFrozenPrefix, renderUserContext } from './frozen-prefix'
import type { HistoryPersist } from './history-persist'
import { sanitizeDashes } from './sanitize'
import type { Brain, BrainInferInput, BrainMessage, BrainTurn } from './types'

/** Channel key used when none is specified — preserves single-history behavior. */
export const DEFAULT_CHANNEL_KEY = 'default'

/** Default cap on assistant output tokens per turn. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

/** Default OpenAI-compatible endpoint and model when not overridden. */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MODEL = 'gpt-4o-mini'

export interface OpenAIBrainOpts {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 (default) or a Z.AI/Tencent gateway. */
  baseUrl?: string
  /** Bearer API key for the endpoint. */
  apiKey: string
  /** Model id, e.g. gpt-4o-mini (default), glm-4.6, hunyuan-*. */
  model?: string
  tools: ToolSchema[]
  prefix: FrozenPrefix
  /** Seed history for the legacy single-history (`'default'`) channel. */
  history?: BrainMessage[]
  /** Default 4096. */
  maxOutputTokens?: number
  /** Pre-flight auto-compaction config. Omit for defaults; pass `null` to disable. */
  compaction?: CompactionOpts | null
  /** Optional persistence handle for channel histories. */
  persist?: HistoryPersist
  onToolCall?: (call: { id: string; name: string; args: unknown }) => Promise<BrainMessage>
}

export class OpenAIBrain implements Brain {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string
  private ready = false
  private readonly histories = new Map<string, BrainMessage[]>()
  private readonly lastUsage = new Map<string, BrainTurn['usage']>()
  private readonly renderedPrefix: string
  private userContextText: string | null
  private persistHydrated = false

  constructor(private readonly opts: OpenAIBrainOpts) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    if (opts.history && opts.history.length > 0) {
      this.histories.set(DEFAULT_CHANNEL_KEY, [...opts.history])
    }
    this.renderedPrefix = renderFrozenPrefix(opts.prefix)
    this.userContextText = renderUserContext(opts.prefix)
  }

  /** Refresh the per-turn user-context payload (MEMORY.md etc.) without rebuilding the prompt. */
  refreshUserContext(prefix: FrozenPrefix): void {
    this.userContextText = renderUserContext(prefix)
  }

  async init(): Promise<void> {
    if (this.ready) return
    this.ready = true
    await this.hydrateFromPersist()
  }

  private async hydrateFromPersist(): Promise<void> {
    if (this.persistHydrated || !this.opts.persist) return
    this.persistHydrated = true
    try {
      const loaded = await this.opts.persist.loadAll()
      for (const [key, history] of loaded) {
        if (this.histories.has(key) && (this.histories.get(key)?.length ?? 0) > 0) continue
        this.histories.set(key, [...history])
      }
    } catch {
      // Persist load failures must never block brain startup.
    }
  }

  getChannelHistory(channelKey: string = DEFAULT_CHANNEL_KEY): readonly BrainMessage[] {
    return [...(this.histories.get(channelKey) ?? [])]
  }

  setChannelHistory(channelKey: string, history: BrainMessage[]): void {
    this.histories.set(channelKey, [...history])
  }

  async clearChannel(channelKey: string = DEFAULT_CHANNEL_KEY): Promise<void> {
    this.histories.set(channelKey, [])
    this.lastUsage.delete(channelKey)
    if (this.opts.persist) {
      try {
        await this.opts.persist.clearChannel(channelKey)
      } catch {
        // best-effort
      }
    }
  }

  listChannels(): string[] {
    const out: string[] = []
    for (const [k, v] of this.histories) {
      if (v.length > 0) out.push(k)
    }
    return out
  }

  private getOrCreateHistory(channelKey: string): BrainMessage[] {
    let h = this.histories.get(channelKey)
    if (!h) {
      h = []
      this.histories.set(channelKey, h)
    }
    return h
  }

  async infer(input: BrainInferInput): Promise<BrainTurn> {
    if (!this.ready) await this.init()
    const signal = input.signal
    if (signal?.aborted) {
      throw new DOMException('aborted before infer started', 'AbortError')
    }
    const channelKey = input.channelKey ?? DEFAULT_CHANNEL_KEY
    await this.maybeCompact(channelKey, input)

    const history = this.getOrCreateHistory(channelKey)
    const userText = normalizeUserContent(input)
    const messages: BrainMessage[] = [{ role: 'system', content: this.renderedPrefix }, ...history]
    if (this.userContextText) {
      messages.push({ role: 'user', content: this.userContextText })
    }
    messages.push({ role: 'user', content: userText })

    let turnResult: BrainTurn | null = null
    let recoveredFromSafetyBlock = false
    // Runaway guard: bound how many model round-trips and tool calls a single
    // turn may make. Without this the loop only ends when the model stops calling
    // tools — a prompt-injected or looping model could chain unbounded tool calls
    // (each a potential spend). Overridable via env for power users.
    const readInt = (k: string, d: number): number => {
      const n = Number(
        (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[k],
      )
      return Number.isFinite(n) && n > 0 ? n : d
    }
    const maxRoundTrips = readInt('LYRA_MAX_ROUND_TRIPS', 32)
    const maxToolCalls = readInt('LYRA_MAX_TOOL_CALLS', 64)
    let roundTrips = 0
    let toolCallsMade = 0
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('aborted between round-trips', 'AbortError')
      }
      if (roundTrips >= maxRoundTrips || toolCallsMade >= maxToolCalls) {
        const hitRounds = roundTrips >= maxRoundTrips
        messages.push({
          role: 'assistant',
          content:
            turnResult?.content?.trim() ||
            `Halting this turn: hit the ${hitRounds ? `${maxRoundTrips} round-trip` : `${maxToolCalls} tool-call`} safety cap without finishing. Stopping to prevent a runaway loop.`,
        })
        break
      }
      roundTrips++
      const resp = await this.callCompletion(messages, signal)
      turnResult = resp

      if (!resp.toolCalls.length) {
        const blockedName = detectBlockedToolError(resp.content ?? '')
        if (blockedName && !recoveredFromSafetyBlock) {
          recoveredFromSafetyBlock = true
          const validNames = this.opts.tools
            .map(t => (t as { name?: string }).name ?? '')
            .filter(n => n.startsWith(`${blockedName}.`) || n.startsWith(`${blockedName}_`))
            .slice(0, 12)
          const hint =
            validNames.length > 0
              ? `Your last tool call used the bare name "${blockedName}", which is not a registered tool. Use the full name with subname (one of: ${validNames.join(', ')}). Retry now.`
              : `Your last tool call used the bare name "${blockedName}", which is not a registered tool. Use the full namespaced name (e.g., something.action). Retry now.`
          messages.push({ role: 'user', content: hint })
          continue
        }
        messages.push({ role: 'assistant', content: resp.content ?? '' })
        break
      }

      messages.push({
        role: 'assistant',
        content: resp.content ?? '',
        toolCalls: resp.toolCalls,
      })
      toolCallsMade += resp.toolCalls.length

      for (const call of resp.toolCalls) {
        if (signal?.aborted) {
          throw new DOMException('aborted between tool calls', 'AbortError')
        }
        const isMalformed =
          !call.name ||
          (typeof call.args === 'string' &&
            call.args !== '' &&
            !looksLikeValidJsonString(call.args))
        if (isMalformed) {
          const toolLabel = call.name || MALFORMED_TOOL_LABEL
          if (input.onToolEvent) {
            try {
              input.onToolEvent({
                kind: 'start',
                tool: toolLabel,
                callId: call.id,
                argsPreview: previewToolArgs(call.args),
              })
              input.onToolEvent({ kind: 'end', tool: toolLabel, callId: call.id, ok: false })
            } catch {
              /* swallow */
            }
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({
              error:
                'Tool call envelope was malformed (empty name or truncated arguments). Re-emit with a complete tool name and a parseable JSON args object.',
            }),
          })
          continue
        }
        if (!this.opts.onToolCall) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ error: 'Tool handler not wired' }),
          })
          continue
        }
        if (input.onToolEvent) {
          try {
            input.onToolEvent({
              kind: 'start',
              tool: call.name,
              callId: call.id,
              argsPreview: previewToolArgs(call.args),
            })
          } catch {
            /* observer errors must never block tool execution */
          }
        }
        const toolMsg = await this.opts.onToolCall(call)
        if (input.onToolEvent) {
          try {
            input.onToolEvent({
              kind: 'end',
              tool: call.name,
              callId: call.id,
              ok: inferToolOk(toolMsg.content ?? ''),
            })
          } catch {
            /* swallow */
          }
        }
        messages.push({ ...toolMsg, toolCallId: call.id })
      }
    }

    const finalAssistant = findLastAssistantContent(messages)
    const userMsg: BrainMessage = { role: 'user', content: userText }
    const assistantMsg: BrainMessage = { role: 'assistant', content: finalAssistant }
    history.push(userMsg)
    history.push(assistantMsg)

    if (turnResult?.usage) this.lastUsage.set(channelKey, turnResult.usage)

    if (this.opts.persist) {
      try {
        await this.opts.persist.appendTurn(channelKey, userMsg, assistantMsg)
      } catch {
        // Persist failure is non-fatal for the live turn.
      }
    }

    if (turnResult?.content) {
      turnResult.content = sanitizeDashes(turnResult.content)
    }
    return turnResult ?? { content: null, toolCalls: [] }
  }

  private async maybeCompact(channelKey: string, input: BrainInferInput): Promise<void> {
    if (this.opts.compaction === null) return
    const cfg = this.opts.compaction ?? DEFAULT_COMPACTION_OPTS
    const history = this.histories.get(channelKey)
    if (!history || history.length === 0) return
    const lastUsage = this.lastUsage.get(channelKey)
    const trigger = shouldCompact(history, lastUsage?.promptTokens ?? null, cfg)
    if (trigger == null) return
    let compacted: BrainMessage[]
    try {
      compacted = await compactHistory(history, cfg, async older => this.summarizeOlder(older))
    } catch {
      return
    }
    if (compacted.length >= history.length) return
    this.histories.set(channelKey, compacted)
    this.lastUsage.delete(channelKey)
    if (this.opts.persist) {
      try {
        await this.opts.persist.rewriteChannel(channelKey, compacted)
      } catch {
        // best-effort
      }
    }
    if (input.onCompactionEvent) {
      try {
        input.onCompactionEvent({
          channelKey,
          from: history.length,
          to: compacted.length,
          promptTokens: trigger,
        })
      } catch {
        /* observer errors swallowed */
      }
    }
  }

  private async summarizeOlder(older: readonly BrainMessage[]): Promise<string> {
    const flat = older
      .map(m => {
        const tag = m.role.toUpperCase()
        if (m.toolCalls && m.toolCalls.length > 0) {
          const calls = m.toolCalls
            .map(
              tc =>
                `${tc.name}(${typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {})})`,
            )
            .join(' | ')
          return `${tag}: ${m.content || ''}\n[TOOL_CALLS] ${calls}`
        }
        return `${tag}: ${m.content || ''}`
      })
      .join('\n\n')
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: flat },
      ],
      max_tokens: 1024,
    }
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      throw new Error(`Compaction summarize HTTP ${resp.status}`)
    }
    const json = (await resp.json()) as {
      choices: Array<{ message: { content?: string | null } }>
    }
    return (json.choices[0]?.message.content ?? '').trim()
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    }
  }

  private async callCompletion(messages: BrainMessage[], signal?: AbortSignal): Promise<BrainTurn> {
    // OpenAI requires tool names to match ^[a-zA-Z0-9_-]+$ (no dots). lyra tools
    // use dotted names (e.g. defi.yields), so sanitize on the way out and map back in.
    const toSafe = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, '_')
    const toOriginal = new Map<string, string>()
    for (const t of this.opts.tools) {
      const orig = (t as { function?: { name?: string } }).function?.name
      if (orig) toOriginal.set(toSafe(orig), orig)
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: toSafe(tc.name),
                arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
              },
            })),
          }
        }
        return { role: m.role, content: m.content }
      }),
      max_tokens: this.opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    }
    if (this.opts.tools.length > 0) {
      body.tools = this.opts.tools.map(t => {
        const fn = (t as { function?: { name?: string } }).function
        return fn?.name ? { ...t, function: { ...fn, name: toSafe(fn.name) } } : t
      })
      body.tool_choice = 'auto'
    }
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Brain HTTP ${resp.status}: ${text}`)
    }
    const json = (await resp.json()) as {
      choices: Array<{
        finish_reason?: string
        message: {
          content?: string | null
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
          reasoning_content?: string
        }
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    const choice = json.choices[0]!
    const msg = choice.message
    const rawContent = msg.content
    const reasoning = msg.reasoning_content
    const fallbackFromReasoning =
      !rawContent && reasoning && reasoning.length > 0 ? stripThinkBlocks(reasoning) : null
    return {
      content: rawContent ? rawContent : fallbackFromReasoning,
      toolCalls: (msg.tool_calls ?? []).map(tc => ({
        id: tc.id,
        name: toOriginal.get(tc.function.name) ?? tc.function.name,
        args: safeParseJson(tc.function.arguments),
      })),
      reasoningContent: msg.reasoning_content,
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
        cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens,
      },
    }
  }
}

function normalizeUserContent(input: BrainInferInput): string {
  const d = input.event.payload.data
  if (typeof d === 'string') return d
  return JSON.stringify(d)
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function looksLikeValidJsonString(raw: string): boolean {
  if (!raw || raw.length === 0) return true
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/g
const MALFORMED_TOOL_LABEL = '<malformed>'

export function stripThinkBlocks(text: string): string {
  if (!text) return text
  return text.replace(THINK_BLOCK_RE, '').trim()
}

export function detectBlockedToolError(content: string): string | null {
  if (!content) return null
  const m = content.match(/Unauthorized:\s+(\S+)\s+is a blocked tool/)
  return m ? m[1]! : null
}

function findLastAssistantContent(messages: BrainMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'assistant') return m.content
  }
  return ''
}

export function previewToolArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return truncatePreview(args)
  if (Array.isArray(args)) return `[${args.length}]`
  if (typeof args === 'object') {
    const o = args as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 0) return ''
    for (const k of ['url', 'path', 'command', 'query', 'name', 'address']) {
      const v = o[k]
      if (typeof v === 'string' && v.length > 0) return truncatePreview(`${k}=${v}`)
    }
    return truncatePreview(keys.join(','))
  }
  try {
    return truncatePreview(String(args))
  } catch {
    return ''
  }
}

function truncatePreview(s: string): string {
  const max = 60
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

export function inferToolOk(content: string): boolean {
  if (!content) return true
  try {
    const o = JSON.parse(content) as Record<string, unknown>
    if (typeof o.ok === 'boolean') return o.ok
    if (typeof o.error === 'string' && o.error.length > 0) return false
    return true
  } catch {
    return !content.toLowerCase().includes('error')
  }
}

export { estimateTokens }
