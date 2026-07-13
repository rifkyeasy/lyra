import { PairingStore, agentPaths, placeholderAgentId } from 'lyra-core'
import { findAndLoadConfig } from '../config/load'

export interface RunPairingListOpts {
  platform?: string
}

type PendingEntry = ReturnType<PairingStore['listPending']>[number]
type ApprovedEntry = ReturnType<PairingStore['listApproved']>[number]

function pairingUserLabel(userName: string | undefined): string {
  return userName ? `@${userName}` : '(unknown)'
}

function printPendingSection(title: string, pending: PendingEntry[]): void {
  console.log(`\n${title} (1h TTL):`)
  if (pending.length === 0) {
    console.log('  (none)')
    return
  }
  for (const p of pending) {
    console.log(
      `  [${p.platform}] ${p.code}  ${pairingUserLabel(p.userName)} id=${p.userId}  age=${p.ageMinutes}m`,
    )
  }
}

function printApprovedSection(title: string, approved: ApprovedEntry[]): void {
  console.log(`\n${title}:`)
  if (approved.length === 0) {
    console.log('  (none)')
    return
  }
  for (const a of approved) {
    console.log(`  [${a.platform}] ${pairingUserLabel(a.userName)} id=${a.userId}`)
  }
}

export async function runPairingList(opts: RunPairingListOpts): Promise<void> {
  const store = await openPairingStore()
  if (!store) return

  const pending = store.listPending(opts.platform)
  const approved = store.listApproved(opts.platform)

  printPendingSection(opts.platform ? `Pending (${opts.platform})` : 'Pending', pending)
  printApprovedSection(opts.platform ? `Approved (${opts.platform})` : 'Approved', approved)
  console.log()
}

async function openPairingStore(): Promise<PairingStore | null> {
  const loaded = await findAndLoadConfig()
  if (!loaded) {
    console.error('No lyra.config.ts found. Run `lyra init` first.')
    return null
  }
  const { config } = loaded
  if (!config.identity.agent) {
    console.error('Config has no agent. Run `lyra init` first.')
    return null
  }
  const agentId = placeholderAgentId(config.identity.agent)
  const dir = agentPaths.agent(agentId).pairingDir
  return new PairingStore({ dir })
}
