import { cancel, isCancel, select } from '@clack/prompts'
import qrcode from 'qrcode-terminal'
import { type Address, type PublicClient, formatEther } from 'viem'

export interface FundingGateOpts {
  publicClient: PublicClient
  operatorAddress: Address
  requiredOg: bigint
  pollIntervalMs?: number
  maxWaitMs?: number
}

export type FundingGateOutcome =
  | { kind: 'funded'; balance: bigint }
  | { kind: 'skip-ledger' }
  | { kind: 'cancel' }

/**
 * Show operator address as a QR and poll balance until it meets required
 * threshold. User can cancel or choose to proceed with minimum-only (skip
 * full compute ledger) at any point.
 *
 * Console prints the QR once; the polling loop updates a single line
 * using `process.stdout.write` so the display doesn't scroll.
 */
export async function fundingGate(opts: FundingGateOpts): Promise<FundingGateOutcome> {
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000
  const maxWaitMs = opts.maxWaitMs ?? 30 * 60_000 // 30 minutes

  console.log('')
  console.log(`  Send at least ${formatEther(opts.requiredOg)} Mantle to:`)
  console.log(`    ${opts.operatorAddress}`)
  console.log('')
  qrcode.generate(opts.operatorAddress, { small: true })
  console.log('')

  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const balance = await opts.publicClient.getBalance({ address: opts.operatorAddress })
    if (balance >= opts.requiredOg) {
      process.stdout.write('\r')
      return { kind: 'funded', balance }
    }
    process.stdout.write(
      `\r  polling... current balance ${formatEther(balance)} Mantle (need ${formatEther(opts.requiredOg)}) `,
    )
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }

  process.stdout.write('\n\n')
  const choice = await select({
    message: 'Balance still insufficient. What now?',
    options: [
      { value: 'skip' as const, label: 'Skip compute ledger for now (mint + subname only)' },
      { value: 'cancel' as const, label: 'Cancel init' },
    ],
    initialValue: 'cancel',
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    return { kind: 'cancel' }
  }
  return choice === 'skip' ? { kind: 'skip-ledger' } : { kind: 'cancel' }
}
