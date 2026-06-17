import { executeAction } from '@/lib/agent-exec'
import { getSession } from '@/lib/auth/session'
import type { PendingAction } from '@/lib/chat-store'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60

// Execute a value-moving action with the policy-bound AGENT wallet. Authorization
// is by Sui sign-in (SIWS): the caller must hold a session proving they own the
// connected wallet. If LYRA_OWNER_ADDRESS is set, only that owner may direct the
// agent; otherwise any signed-in wallet may (single-tenant demo). The agent key
// lives only on the server — the browser never sees it and never signs.
export async function POST(req: Request) {
  try {
    const session = await getSession().catch(() => null)
    if (!session?.address) {
      return NextResponse.json(
        { ok: false, error: 'sign in with your Sui wallet to authorize the agent (top-right)' },
        { status: 401 },
      )
    }
    const owner = process.env.LYRA_OWNER_ADDRESS
    if (owner && session.address.toLowerCase() !== owner.toLowerCase()) {
      return NextResponse.json({ ok: false, error: 'this wallet is not the agent owner' }, { status: 403 })
    }

    const body = (await req.json()) as { action?: PendingAction }
    if (!body.action || (body.action.kind !== 'transfer' && body.action.kind !== 'swap')) {
      return NextResponse.json({ ok: false, error: 'no valid action' }, { status: 400 })
    }

    const result = await executeAction(body.action)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
