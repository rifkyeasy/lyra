import { deriveAgentAddress } from '@/lib/agent-derive'
import { getSession } from '@/lib/auth/session'
import { LYRA_PKG } from '@/lib/onchain-constants'
import { webSuiClient } from '@/lib/ops'
import { resolveOwnerVault } from '@/lib/vault'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

const sui = webSuiClient()

// The signed-in owner's agent (derived per owner) + their on-chain treasury vault
// status. The UI shows the agent gas-float balance, whether they've provisioned a
// vault, and the vault's treasury balance. Returns nulls when not signed in.
export async function GET() {
  try {
    const session = await getSession().catch(() => null)
    if (!session?.address) {
      return NextResponse.json({ owner: null, agent: null, agentMist: '0', vault: null, pkg: LYRA_PKG })
    }
    const owner = session.address
    const agent = deriveAgentAddress(owner)
    const [bal, ov] = await Promise.all([
      sui.getBalance({ owner: agent }).catch(() => null),
      resolveOwnerVault(owner).catch(() => null),
    ])
    return NextResponse.json({
      owner,
      agent,
      agentMist: bal?.totalBalance ?? '0',
      pkg: LYRA_PKG,
      vault: ov
        ? { vaultId: ov.vaultId, policyId: ov.policyId, capId: ov.capId, vaultMist: ov.vaultMist }
        : null,
    })
  } catch (e) {
    return NextResponse.json({ owner: null, agent: null, agentMist: '0', vault: null, error: (e as Error).message })
  }
}
