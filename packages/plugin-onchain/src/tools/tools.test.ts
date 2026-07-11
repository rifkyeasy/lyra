/**
 * Unit coverage for the DeFi tool surface: (1) the plugin registers every
 * value-moving adapter, and (2) each new write tool runs its guard checks
 * (mainnet-only, valid amount, minimum size) BEFORE it ever touches the
 * network — so a dust/invalid/testnet request fails fast and deterministically,
 * never a false success.
 *
 * These tests deliberately use a bare stub context: the guard branches return
 * before any `client`/`keypair` access, so no RPC is needed. Live end-to-end
 * PTB simulation lives in `onchain.integration.test.ts` (gated on a real key).
 */

import { describe, expect, test } from 'bun:test'
import type { PluginContext, ToolDef } from 'lyra-core'
import { capabilitySummary, TOOLS, WEB_TOOL_NAMES } from '../catalog'
import plugin from '../index'
import type { OnchainRuntimeContext } from '../types'
import { makeVoloStake } from './liquid-stake'
import { makeNaviBorrow, makeNaviRepay } from './navi'
import { makeSuilendBorrow, makeSuilendSupply } from './suilend'

// A context whose network/amount guards resolve before any client access.
function stubCtx(network: 'mainnet' | 'testnet' = 'mainnet'): OnchainRuntimeContext {
  return {
    network,
    agentAddress: '0x0000000000000000000000000000000000000000000000000000000000000abc',
    agentDir: '/tmp/lyra-test',
    // Accessing either of these would throw — guards must return first.
    client: new Proxy(
      {},
      {
        get() {
          throw new Error('network access before guard')
        },
      },
    ) as never,
    keypair: {} as never,
  }
}

describe('onchain plugin registration', () => {
  test('registers the full DeFi write surface (lending + staking + swap)', () => {
    const names: string[] = []
    const ctx = {
      registerTool: (def: ToolDef) => names.push(def.name),
      registerListener: () => {},
      addHook: () => {},
      network: 'mainnet',
      agentDir: '/tmp',
      agentId: 'test',
      // side-banded onchain runtime the plugin reads off PluginContext
      onchain: stubCtx(),
    } as unknown as PluginContext
    plugin.register(ctx)

    for (const expected of [
      // lending: the three biggest Sui money markets, full CRUD
      'scallop.supply',
      'scallop.withdraw',
      'navi.supply',
      'navi.borrow',
      'navi.repay',
      'suilend.supply',
      'suilend.withdraw',
      'suilend.borrow',
      'suilend.repay',
      'suilend.position',
      // staking: native + Volo liquid staking
      'sui.stake',
      'sui.unstake',
      'volo.stake',
      'volo.unstake',
      // swap aggregator
      'swap',
    ]) {
      expect(names).toContain(expected)
    }
  })

  test('registered tools EXACTLY match the catalog (single source of truth)', () => {
    const names: string[] = []
    const ctx = {
      registerTool: (def: ToolDef) => names.push(def.name),
      registerListener: () => {},
      addHook: () => {},
      network: 'mainnet',
      agentDir: '/tmp',
      agentId: 'test',
      onchain: stubCtx(),
    } as unknown as PluginContext
    plugin.register(ctx)
    // Nothing registered outside the catalog, and nothing in the catalog unregistered.
    expect(new Set(names)).toEqual(new Set(TOOLS.map(t => t.name)))
    expect(names.length).toBe(TOOLS.length) // no duplicate names
    // The web set + guidance are DERIVED from the same catalog.
    for (const web of WEB_TOOL_NAMES) expect(names).toContain(web)
    expect(capabilitySummary()).toContain('walrus.stake')
  })

  test('registers nothing without an onchain runtime (safe no-op for loaders)', () => {
    const names: string[] = []
    const ctx = {
      registerTool: (def: ToolDef) => names.push(def.name),
      registerListener: () => {},
      addHook: () => {},
      network: 'mainnet',
      agentDir: '/tmp',
      agentId: 'test',
    } as unknown as PluginContext
    plugin.register(ctx)
    expect(names).toHaveLength(0)
  })
})

describe('write-tool guards (fail before network)', () => {
  test('suilend.supply rejects a dust amount below the supply minimum', async () => {
    const res = await makeSuilendSupply(stubCtx()).handler({ amount: '0.001' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('amount too small')
  })

  test('suilend.borrow rejects a dust amount below the borrow minimum', async () => {
    const res = await makeSuilendBorrow(stubCtx()).handler({ amount: '0.0001' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('amount too small')
  })

  test('volo.stake rejects below the 1 SUI staking minimum', async () => {
    const res = await makeVoloStake(stubCtx()).handler({ amount: '0.1' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('amount too small')
  })

  test('navi.borrow rejects a dust amount', async () => {
    const res = await makeNaviBorrow(stubCtx()).handler({ amount: '0.001' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('amount too small')
  })

  test('invalid amount strings are rejected before any network call', async () => {
    const res = await makeVoloStake(stubCtx()).handler({ amount: 'not-a-number' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('invalid amount')
  })

  test('mainnet-only tools refuse to run on testnet', async () => {
    const supply = await makeSuilendSupply(stubCtx('testnet')).handler({ amount: '5' })
    expect(supply.ok).toBe(false)
    if (!supply.ok) expect(supply.error).toContain('mainnet only')

    const stake = await makeVoloStake(stubCtx('testnet')).handler({ amount: '5' })
    expect(stake.ok).toBe(false)
    if (!stake.ok) expect(stake.error).toContain('mainnet only')
  })

  test('navi.repay is a registered, well-formed tool', () => {
    const tool = makeNaviRepay(stubCtx())
    expect(tool.name).toBe('navi.repay')
    expect(typeof tool.handler).toBe('function')
  })
})
