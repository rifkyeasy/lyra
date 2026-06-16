/**
 * `nebula gateway <sub>` argv dispatcher.
 *
 * Subs:
 *   run       — foreground daemon (blocks; Ctrl+C to stop). Uses operator-session.
 *   start     — interactive: prompt Touch ID, write operator-session, fork daemon.
 *   stop      — SIGTERM the running daemon via the lock file's PID.
 *   restart   — stop + start.
 *   status    — show PID, uptime, socket path, lock state.
 *   logs      — tail the gateway log (--tail N, --follow).
 *
 * v0.19.x scope: run + start + stop + status. restart/logs/install/setup ship
 * in v0.19.3 alongside launchd plist generator.
 */

export type GatewaySub = 'run' | 'start' | 'stop' | 'restart' | 'status' | 'logs'

export interface ParsedGatewayArgs {
  sub: GatewaySub
  /** Optional --agent <id> override; defaults to config-derived. */
  agentId?: string
  /** --tail N for logs; default 100. */
  tail?: number
  /** --follow / -f for logs. */
  follow?: boolean
}

export type ParseResult = ParsedGatewayArgs | { error: string }

export function parseGatewayArgs(argv: string[]): ParseResult {
  const sub = argv[0]
  if (!sub) {
    return { error: 'usage: nebula gateway <run | start | stop | restart | status | logs>' }
  }
  if (!['run', 'start', 'stop', 'restart', 'status', 'logs'].includes(sub)) {
    return { error: `unknown gateway sub: ${sub}` }
  }
  let agentId: string | undefined
  let tail: number | undefined
  let follow = false
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--agent') {
      const v = argv[++i]
      if (!v) return { error: '--agent requires a value' }
      agentId = v
    } else if (a === '--tail') {
      const v = argv[++i]
      if (!v) return { error: '--tail requires a value' }
      const n = Number.parseInt(v, 10)
      if (!Number.isFinite(n) || n < 0) return { error: '--tail must be a positive integer' }
      tail = n
    } else if (a === '--follow' || a === '-f') {
      follow = true
    } else {
      return { error: `unknown flag: ${a}` }
    }
  }
  return { sub: sub as GatewaySub, agentId, tail, follow }
}

export async function runGateway(parsed: ParsedGatewayArgs): Promise<void> {
  switch (parsed.sub) {
    case 'run': {
      const { runGatewayForeground } = await import('./gateway-run')
      await runGatewayForeground({ agentId: parsed.agentId })
      return
    }
    case 'start': {
      const { runGatewayStart } = await import('./gateway-start')
      await runGatewayStart({ agentId: parsed.agentId })
      return
    }
    case 'stop': {
      const { runGatewayStop } = await import('./gateway-stop')
      await runGatewayStop({ agentId: parsed.agentId })
      return
    }
    case 'restart': {
      const { runGatewayStop } = await import('./gateway-stop')
      const { runGatewayStart } = await import('./gateway-start')
      await runGatewayStop({ agentId: parsed.agentId })
      await runGatewayStart({ agentId: parsed.agentId })
      return
    }
    case 'status': {
      const { runGatewayStatus } = await import('./gateway-status')
      await runGatewayStatus({ agentId: parsed.agentId })
      return
    }
    case 'logs': {
      const { runGatewayLogs } = await import('./gateway-logs')
      await runGatewayLogs({
        agentId: parsed.agentId,
        tail: parsed.tail ?? 100,
        follow: parsed.follow ?? false,
      })
      return
    }
  }
}
