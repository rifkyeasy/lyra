import { formatEther } from 'viem'

/** Mantle mainnet spot price used for USD estimates. Not authoritative, just a hint. */
const MNT_USD = 0.5

export type DeployTarget = 'local'

export interface CostBreakdown {
  agentFloat: bigint
  totalOperator: bigint
  deployTarget: DeployTarget
}

export function estimateCosts(opts?: {
  ledgerSizeOg?: number
  withSubname?: boolean
  deployTarget?: DeployTarget
  agentFloatWei?: bigint
}): CostBreakdown {
  // The only init cost is funding the agent EOA with a small gas float. There
  // is no iNFT mint, no storage anchor, and no compute ledger.
  const agentFloat = opts?.agentFloatWei ?? 100_000_000_000_000_000n // 0.1 MNT
  return { agentFloat, totalOperator: agentFloat, deployTarget: opts?.deployTarget ?? 'local' }
}

export function formatUsd(valueWei: bigint): string {
  const mnt = Number(formatEther(valueWei))
  return `$${(mnt * MNT_USD).toFixed(2)}`
}

export function renderCostSummary(c: CostBreakdown): string {
  const line = (label: string, wei: bigint): string =>
    `    ${label.padEnd(32)}${formatEther(wei).padStart(8)} Mantle  (${formatUsd(wei)})`
  return [
    '  operator spend (Mantle mainnet):',
    line('agent infra float (gas)', c.agentFloat),
    `    ${'─'.repeat(32)}${'─'.repeat(18)}`,
    line('total operator spend', c.totalOperator),
  ].join('\n')
}
