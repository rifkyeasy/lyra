import { deriveAgentKeypair } from '@/lib/agent-derive'
import { getSession } from '@/lib/auth/session'
import { approveSession } from '@/lib/cli-link'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

// The signed-in owner approves a CLI device-link code. We derive THAT owner's
// agent key server-side and stash it on the pending session for one-time pickup
// by the CLI's poll. Auth is by Sui sign-in (iron-session): the caller can only
// ever hand the CLI the agent derived from their own connected address.
export async function POST(req: Request) {
  try {
    const session = await getSession().catch(() => null)
    if (!session?.address) {
      return NextResponse.json(
        { error: 'sign in with your Sui wallet to approve this terminal' },
        { status: 401 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as { code?: string }
    const code = typeof body.code === 'string' ? body.code : ''
    if (!code.trim()) {
      return NextResponse.json({ error: 'code is required' }, { status: 400 })
    }

    const owner = session.address
    const agentKey = deriveAgentKeypair(owner).getSecretKey()

    const result = approveSession(code, owner, agentKey)
    if (result === null) {
      return NextResponse.json({ error: 'no pending login for that code' }, { status: 404 })
    }
    if (result === 'expired') {
      return NextResponse.json({ error: 'that login code has expired' }, { status: 404 })
    }

    return NextResponse.json({ ok: true, owner })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
