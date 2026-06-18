import { SESSION_TTL_MS, createSession } from '@/lib/cli-link'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

// Begin a CLI device-link. The CLI POSTs here, shows the user the returned `code`
// and `verifyUrl`, then polls /api/cli/login/poll with the `pollToken`. No auth:
// starting a pending session leaks nothing — the agent key is only handed out
// after a signed-in owner approves the code on the web.
export async function POST(req: Request) {
  const session = createSession()
  return NextResponse.json({
    code: session.code,
    pollToken: session.pollToken,
    verifyUrl: `${resolveOrigin(req)}/cli-login`,
    expiresInSec: Math.floor(SESSION_TTL_MS / 1000),
  })
}

/**
 * Origin the CLI should open. Prefer an explicit env override (so the canonical
 * public URL is shown even behind a proxy), then fall back to the request's own
 * origin, then the production default.
 */
function resolveOrigin(req: Request): string {
  const fromEnv = process.env.LYRA_WEB_URL || process.env.NEXT_PUBLIC_APP_URL
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  try {
    return new URL(req.url).origin
  } catch {
    return 'https://lyraai.space'
  }
}
