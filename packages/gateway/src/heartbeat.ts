export interface StartHeartbeatOpts {
  /**
   * Heartbeat target URL. Falls back to `process.env.SANDBOX_PUBLIC_URL` when
   * not provided. One of the two must resolve to a non-empty URL.
   */
  targetUrl?: string
  /**
   * Tick interval in milliseconds. Default 30 minutes (1_800_000ms).
   * No floor enforced; the canary path passes very small values and the
   * harness's wrapper (entrypoint.ts) reads `HARNESS_HEARTBEAT_INTERVAL_MS`
   * env to choose the boot-time value.
   */
  intervalMs?: number
  /** Per-ping fetch timeout. Default 15s. */
  fetchTimeoutMs?: number
  fetchImpl?: typeof fetch
  logger?: (line: string) => void
}

export interface Heartbeat {
  stop(): void
  successCount(): number
  failCount(): number
  /** The resolved target URL (handy for boot logging + tests). */
  targetUrl(): string
  /** Force a single ping. Used by tests; production uses the interval. */
  runOnce(): Promise<void>
}

/**
 * Self-heartbeat from inside the harness back to its own public proxy URL.
 *
 * The Sui Sandbox provider hardcodes `autoArchiveInterval=60min`, and Daytona's
 * auto-archive cron only fires for sandboxes in `state=stopped`. By making
 * regular HTTP requests through the public proxy, we keep activity flowing,
 * which (empirically) reduces the chance of the proxy treating a healthy
 * sandbox as idle.
 *
 * Failures are logged at warn level but never throw — a network blip should
 * not crash the harness.
 *
 * The first ping fires after `intervalMs`, NOT immediately. The harness has
 * just bound its listener; firing immediately could race the listener
 * accept() loop on slow systems.
 */
export function startHeartbeat(opts: StartHeartbeatOpts): Heartbeat {
  const intervalMs = opts.intervalMs ?? 30 * 60_000
  const fetchImpl = opts.fetchImpl ?? fetch
  const logger = opts.logger ?? (() => {})
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 15_000
  const url = opts.targetUrl ?? process.env.SANDBOX_PUBLIC_URL
  if (!url) {
    throw new Error('startHeartbeat: targetUrl or SANDBOX_PUBLIC_URL is required')
  }

  let success = 0
  let fail = 0
  let inFlight = false

  const ping = async (): Promise<void> => {
    try {
      const r = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(fetchTimeoutMs),
      })
      if (r.ok) {
        success += 1
        logger(`heartbeat ok url=${url} success=${success}`)
      } else {
        fail += 1
        logger(`heartbeat http=${r.status} url=${url} fail=${fail}`)
      }
    } catch (e) {
      fail += 1
      logger(`heartbeat error=${(e as Error).message.slice(0, 120)} fail=${fail}`)
    }
  }

  // inFlight guard: if a prior tick is still hung past intervalMs (only
  // possible with canary-tight intervals + a stuck proxy), skip the new tick
  // rather than pile up concurrent fetches.
  const handle = setInterval(() => {
    if (inFlight) return
    inFlight = true
    void ping().finally(() => {
      inFlight = false
    })
  }, intervalMs)

  return {
    stop: () => clearInterval(handle),
    successCount: () => success,
    failCount: () => fail,
    targetUrl: () => url,
    runOnce: ping,
  }
}
