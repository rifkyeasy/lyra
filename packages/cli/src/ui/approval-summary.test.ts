import { describe, expect, it } from 'bun:test'
import { summarizeApprovalSubject } from './approval-summary'

describe('summarizeApprovalSubject', () => {
  it('renders chain.send native with amount + recipient', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.send',
        amount: '0.001',
        recipient: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
        token: 'MNT',
        reason: 'native/ERC-20 transfer',
      }),
    ).toBe('send 0.001 MNT to 0xC635…87Ec')
  })

  it('renders chain.send ERC-20 with explicit token symbol', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.send',
        amount: '0.5',
        recipient: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
        token: 'USDCe',
        reason: 'native/ERC-20 transfer',
      }),
    ).toBe('send 0.5 USDCe to 0xC635…87Ec')
  })

  it('renders chain.send native fallback label when token omitted', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.send',
        amount: '0.001',
        recipient: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
        reason: 'native/ERC-20 transfer',
      }),
    ).toBe('send 0.001 MNT to 0xC635…87Ec')
  })

  it('renders chain.wrap as the arrow form (no recipient noise)', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.send',
        amount: '0.01',
        token: 'MNT→WMNT',
        reason: 'wrap native to WMNT',
      }),
    ).toBe('0.01 MNT→WMNT')
  })

  it('renders chain.unwrap', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.send',
        amount: '0.01',
        token: 'WMNT→MNT',
        reason: 'unwrap WMNT to native',
      }),
    ).toBe('0.01 WMNT→MNT')
  })

  it('renders chain.swap with token-pair encoding', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.swap',
        amount: '0.005',
        token: 'MNT→USDCe',
        reason: 'Agni swap execution',
      }),
    ).toBe('swap 0.005 MNT→USDCe')
  })

  it('renders chain.swap with empty amt + tok', () => {
    expect(
      summarizeApprovalSubject({
        kind: 'chain.swap',
        reason: 'Agni swap execution',
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
