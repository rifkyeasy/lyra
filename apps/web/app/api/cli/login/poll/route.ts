import { deleteSession, findByPollToken } from '@/lib/cli-link'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

// The CLI polls here with its pollToken until the owner approves the code on the
// web. On approval we return the owner + their agent secret ONCE, then delete the
// session so the key can never be retrieved twice.
export async function GET(req: Request) {
  const pollToken = new URL(req.url).searchParams.get('pollToken') ?? ''
  const result = findByPollToken(pollToken)

  if (result === null) return NextResponse.json({ status: 'not_found' })
  if (result === 'expired') return NextResponse.json({ status: 'expired' })

  if (result.status === 'approved' && result.owner && result.agentKey) {
    const { owner, agentKey, code } = result
    // One-time retrieval: burn the session so the key is never returned again.
    deleteSession(code)
    return NextResponse.json({ status: 'approved', owner, agentKey })
  }

  return NextResponse.json({ status: 'pending' })
}
