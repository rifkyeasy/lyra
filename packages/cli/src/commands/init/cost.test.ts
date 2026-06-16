import { describe, expect, it } from 'bun:test'
import { parseEther } from 'viem'
import { estimateCosts, renderCostSummary } from './cost'

describe('estimateCosts', () => {
  it('local target: agent gas float only (no mint/ledger/storage)', () => {
    const c = estimateCosts({ deployTarget: 'local' })
    expect(c.deployTarget).toBe('local')
    expect(c.agentFloat).toBe(parseEther('0.1'))
    expect(c.totalOperator).toBe(parseEther('0.1'))
  })
})

describe('renderCostSummary', () => {
  it('shows only the agent gas float; no 0G cost lines', () => {
    const out = renderCostSummary(estimateCosts({ deployTarget: 'local' }))
    expect(out).toContain('operator spend (Mantle mainnet)')
    expect(out).toContain('agent infra float (gas)')
    expect(out).not.toContain('mint + setApprovalForAll')
    expect(out).not.toContain('compute ledger deposit')
    expect(out).not.toContain('storage upload')
    expect(out).not.toContain('subname')
  })
})
