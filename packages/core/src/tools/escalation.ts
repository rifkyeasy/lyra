import type { ToolCall, ToolResult } from './types'

/**
 * v0.21.2/v0.21.3: web.fetch can fail in many ways. Some failures are transient
 * (Cloudflare interstitial, Google bot block, captcha, rate-limit, HTTP 5xx,
 * timeout, network error) and the browser primitive often recovers because it
 * runs a real headless Chromium that handles cookies, JS challenges, and uses
 * different DNS / network stack. Other failures are permanent (invalid URL,
 * unsupported protocol, private/loopback host) and re-trying via browser would
 * not help.
 *
 * The dispatcher (chat.tsx onToolCall + build-runtime.ts onToolCall) calls
 * `runEscalation`. Both wrappers share orchestration (pre/post hooks, dispatch,
 * activity append, merge) here; only the UX side effects (state.pushRow vs
 * events.publish) are passed as callbacks. Brain sees one merged tool message
 * regardless of how many wrapper-level retries happened.
 *
 * Live drives showed Qwen3.6 ignores conditional escalation rules in long
 * contexts: pre-fix, the brain ended turn with toolCalls=0 on a blocked fetch
 * and replied "(no reply)" / memory disclaimer. v0.21.2 escalated on the
 * structured `blocked:true` signal. v0.21.3 extends to ANY transient web.fetch
 * failure ("ensure browser routing is active so agent proactively go with
 * browser every time it gets any hiccup or issues").
 */

const ESCALATED_ID_PREFIX = 'auto-escalate-'

/**
 * Errors web.fetch returns for input it must refuse outright. Browser would
 * not fix them and we don't want to drive it to file:// / private IPs / etc.
 * Match-prefix on the error string.
 */
const PERMANENT_FAILURE_PATTERNS: readonly RegExp[] = [
  /^invalid URL$/i,
  /^unsupported protocol/i,
  /^host blocked/i,
]

export interface FetchEscalation {
  needed: boolean
  escalatedCall?: ToolCall
  reason?: string
  url?: string
}

/**
 * Decide whether a web.fetch result warrants an automatic browser.navigate
 * retry. Fires on:
 *   - bot-block / captcha / rate-limit interstitial (data.blocked === true)
 *   - any web.fetch failure (result.ok === false) UNLESS the error is one of
 *     the permanent-failure patterns above (invalid URL, unsupported
 *     protocol, host blocked for security)
 *
 * URL preference order: `result.data.final_url` (post-redirect canonical URL),
 * then `call.args.url` (original request). If neither is present we cannot
 * synthesize a browser.navigate call, so escalation is skipped. Recursion
 * guard refuses to re-escalate calls that are themselves synthetic
 * escalations.
 */
export function detectFetchEscalation(call: ToolCall, result: ToolResult): FetchEscalation {
  if (call.name !== 'web.fetch') return { needed: false }
  if (typeof call.id === 'string' && call.id.startsWith(ESCALATED_ID_PREFIX))
    return { needed: false }

  const data = result.data as Record<string, unknown> | undefined
  const url = resolveEscalationUrl(call, data)
  if (!url) return { needed: false }

  if (result.ok && data?.blocked === true) {
    const reason = typeof data.block_reason === 'string' ? data.block_reason : 'unknown'
    return synthesize(call, url, reason)
  }
  if (!result.ok) {
    const error = typeof result.error === 'string' ? result.error : 'unknown'
    if (PERMANENT_FAILURE_PATTERNS.some(re => re.test(error))) return { needed: false }
    return synthesize(call, url, classifyError(error))
  }
  return { needed: false }
}

/**
 * Pick the URL to escalate to: prefer `data.final_url` (post-redirect canonical
 * URL), then the original `call.args.url`. Returns null when neither is usable.
 */
function resolveEscalationUrl(
  call: ToolCall,
  data: Record<string, unknown> | undefined,
): string | null {
  const finalUrl = data && typeof data.final_url === 'string' ? data.final_url : null
  const argUrl = extractUrlFromCallArgs(call)
  return finalUrl && finalUrl.length > 0 ? finalUrl : argUrl
}

function synthesize(call: ToolCall, url: string, reason: string): FetchEscalation {
  return {
    needed: true,
    escalatedCall: {
      id: `${ESCALATED_ID_PREFIX}${call.id}`,
      name: 'browser.navigate',
      args: { url },
    },
    reason,
    url,
  }
}

function extractUrlFromCallArgs(call: ToolCall): string | null {
  if (!call.args || typeof call.args !== 'object') return null
  const args = call.args as Record<string, unknown>
  return typeof args.url === 'string' && args.url.length > 0 ? args.url : null
}

/**
 * Classify a non-block web.fetch error into a short symbolic reason. Keeps
 * the merged auto_escalation.reason field readable for the brain instead of
 * pasting raw stack traces.
 */
function classifyError(error: string): string {
  if (/^timeout/i.test(error)) return 'timeout'
  const httpMatch = error.match(/^http\s+(\d{3})/i)
  if (httpMatch) return `http-${httpMatch[1]}`
  if (/dns|enotfound|getaddrinfo/i.test(error)) return 'dns'
  if (/connection|econnrefused|econnreset|socket/i.test(error)) return 'connection'
  if (/aborted|abortError/i.test(error)) return 'aborted'
  return 'fetch-error'
}

/**
 * Merge a failed/blocked web.fetch result with an escalated browser.navigate
 * result into the single tool message the brain receives. Original `data.body`
 * (the bot-block markdown, if any) is preserved alongside `data.auto_escalation`
 * so the brain has full context to call `browser.snapshot` next.
 *
 * `mergedResult.ok` reflects the ESCALATED call's success: if browser.navigate
 * also failed (no agent-browser binary, headless Chrome flake, etc.), the
 * brain sees ok:false and can degrade gracefully.
 */
export function mergeEscalationResult(
  original: ToolResult,
  escalated: ToolResult,
  escalation: FetchEscalation,
): ToolResult {
  const originalData =
    original.data && typeof original.data === 'object'
      ? (original.data as Record<string, unknown>)
      : {}
  const merged: ToolResult = {
    ok: escalated.ok,
    data: {
      ...originalData,
      auto_escalation: {
        triggered: true,
        from: 'web.fetch',
        to: 'browser.navigate',
        reason: escalation.reason ?? 'unknown',
        url: escalation.url ?? '',
        original_error: original.error,
        result: escalated,
      },
    },
  }
  if (!escalated.ok) {
    merged.error = `auto-escalation failed: ${escalated.error ?? 'unknown'}`
  }
  return merged
}

export interface EscalationDeps {
  /** Run pre-tool hooks (permission, sandbox bridge). Mirrors HookBus shape. */
  runPreCall: (call: ToolCall) => Promise<{ short?: ToolResult; call?: ToolCall }>
  /** Run post-tool hooks (audit, telemetry). */
  runPostCall: (call: ToolCall, result: ToolResult) => Promise<void>
  /** Dispatch the (possibly hook-replaced) call to the tool registry. */
  dispatch: (call: ToolCall) => Promise<ToolResult>
  /** Append a `kind:'tool-call'` activity entry tagged `autoEscalated:true`. */
  appendActivity: (call: ToolCall, result: ToolResult) => Promise<void>
  /** UX sink: notify the operator a follow-up call is starting. */
  onStart: (call: ToolCall) => void
  /** UX sink: notify the operator the follow-up call finished. */
  onEnd: (call: ToolCall, result: ToolResult, durationMs: number) => void
}

/**
 * Orchestrate the escalated browser.navigate dispatch on behalf of the brain
 * wrapper. Owns: UX start → pre-hook → dispatch (or short-circuit) → post-hook →
 * activity append → UX end → merge. Both `chat.tsx` and `build-runtime.ts` call
 * this so any future change (extra hook, retry policy, telemetry) lands in one
 * place instead of drifting between TUI and gateway paths.
 */
export async function runEscalation(
  escalation: FetchEscalation,
  originalResult: ToolResult,
  deps: EscalationDeps,
): Promise<ToolResult> {
  if (!(escalation.needed && escalation.escalatedCall)) return originalResult
  const synthCall = escalation.escalatedCall
  const startedAt = Date.now()
  deps.onStart(synthCall)
  const pre = await deps.runPreCall(synthCall)
  const effective = pre.call ?? synthCall
  let result: ToolResult
  if (pre.short) {
    result = pre.short
  } else {
    result = await deps.dispatch(effective)
    await deps.runPostCall(effective, result)
  }
  await deps.appendActivity(effective, result)
  deps.onEnd(effective, result, Date.now() - startedAt)
  return mergeEscalationResult(originalResult, result, escalation)
}
