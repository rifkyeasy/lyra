import { describe, expect, it } from 'bun:test'
import { summarizeApprovalSubject } from './approval-summary'

describe('summarizeApprovalSubject', () => {
  it('renders chain.send native with amount + recipient', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.send',
        amount: '0.001',
        recipient: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
        token: 'SUI',
        reason: 'SUI transfer',
      }),
    ).toBe('send 0.001 SUI to 0xC635…87Ec')
  })

  it('renders chain.send coin with explicit token symbol', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.send',
        amount: '0.5',
        recipient: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
        token: 'USDC',
        reason: 'coin transfer',
      }),
    ).toBe('send 0.5 USDC to 0xC635…87Ec')
  })

  it('renders chain.send native fallback label when token omitted', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.send',
        amount: '0.001',
        recipient: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
        reason: 'SUI transfer',
      }),
    ).toBe('send 0.001 SUI to 0xC635…87Ec')
  })

  it('renders the arrow form (no recipient noise)', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.send',
        amount: '0.01',
        token: 'SUI→USDC',
        reason: 'wrap',
      }),
    ).toBe('0.01 SUI→USDC')
  })

  it('renders chain.swap with token-pair encoding', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.swap',
        amount: '0.005',
        token: 'SUI→USDC',
        reason: 'Cetus swap execution',
      }),
    ).toBe('swap 0.005 SUI→USDC')
  })

  it('renders chain.swap with empty amt + tok', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.swap',
        reason: 'Cetus swap execution',
      }),
    ).toBe('swap')
  })

  it('renders chain.write with signature + recipient + value', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.write',
        recipient: '0x9e71d79f06f956d4d2666b5c93dafab721c84721',
        command: 'transfer(address,uint256)',
        amount: '1 wei',
        reason: 'arbitrary state-changing call',
      }),
    ).toBe('transfer(address,uint256) (value: 1 wei) on 0x9e71…4721')
  })

  it('renders chain.write with no recipient (Aave command) without a trailing "on"', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.write',
        command: 'aave.borrow 100 USDC',
        reason: 'borrow from Aave V3 (leverage)',
      }),
    ).toBe('aave.borrow 100 USDC')
  })

  it('renders chain.write with no value', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.write',
        recipient: '0x9e71d79f06f956d4d2666b5c93dafab721c84721',
        command: 'totalSupply()',
        reason: 'arbitrary state-changing call',
      }),
    ).toBe('totalSupply() on 0x9e71…4721')
  })

  it('falls back to command for shell.run', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'shell.run',
        command: 'rm -rf /tmp/foo',
        reason: 'shell command execution',
      }),
    ).toBe('rm -rf /tmp/foo')
  })

  it('falls back to path for fs.write', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'fs.write',
        path: '/tmp/x.txt',
        reason: 'fs.write request',
      }),
    ).toBe('/tmp/x.txt')
  })

  it('falls back to (unspecified) when nothing usable', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'fs.patch',
        reason: 'fs.patch request',
      }),
    ).toBe('(unspecified)')
  })
})
