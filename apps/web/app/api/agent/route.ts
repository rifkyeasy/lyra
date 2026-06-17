import { deriveAgentAddress } from '@/lib/agent-derive'
import { getSession } from '@/lib/auth/session'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

const sui = new SuiClient({ url: getFullnodeUrl('mainnet') })

// The agent wallet that belongs to the signed-in owner (multi-tenant: derived
// per owner address). The UI uses this to show "your agent" + its balance so the
// owner can fund it. Returns nulls when not signed in.
export async function GET() {
  try {
    const session = await getSession().catch(() => null)
    if (!session?.address) return NextResponse.json({ owner: null, agent: null, suiMist: '0' })
    const agent = deriveAgentAddress(session.address)
    const bal = await sui.getBalance({ owner: agent }).catch(() => null)
    return NextResponse.json({ owner: session.address, agent, suiMist: bal?.totalBalance ?? '0' })
  } catch (e) {
    return NextResponse.json({ owner: null, agent: null, suiMist: '0', error: (e as Error).message })
  }
}
