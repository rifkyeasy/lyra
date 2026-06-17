import { executeAction } from '@/lib/agent-exec'
import { getSession } from '@/lib/auth/session'
import type { PendingAction } from '@/lib/chat-store'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60

// Execute a value-moving action with the signed-in owner's OWN agent wallet
// (multi-tenant: derived per owner, server-side). Authorization is by Sui sign-in
// (SIWS): the session proves the caller owns the connected wallet, and they can
// only ever direct the agent derived from THAT address. The agent key lives only
// on the server (derived from the master secret) — the browser never sees it.
export async function POST(req: Request) {
  try {
    const session = await getSession().catch(() => null)
    if (!session?.address) {
      return NextResponse.json(
        { ok: false, error: 'sign in with your Sui wallet to authorize your agent (top-right)' },
        { status: 401 },
      )
    }

    const body = (await req.json()) as { action?: PendingAction }
    if (!body.action || (body.action.kind !== 'transfer' && body.action.kind !== 'swap')) {
      return NextResponse.json({ ok: false, error: 'no valid action' }, { status: 400 })
    }

    const result = await executeAction(body.action, session.address)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
