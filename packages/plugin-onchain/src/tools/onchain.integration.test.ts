/**
 * Integration coverage — LIVE mainnet dry-runs (devInspect, never broadcast).
 *
 * Gated: runs only when `LYRA_RUN_INTEGRATION=1` and a real `LYRA_AGENT_KEY` is
 * present. In CI (no secret) the whole suite is skipped, so it never flakes the
 * default `bun test`. Run locally with:
 *
 *   LYRA_RUN_INTEGRATION=1 bun test src/tools/onchain.integration.test.ts
 *
 * Each write case builds the exact PTB its tool builds and simulates it against
 * mainnet, proving the SDK integration + PTB are valid on-chain without moving
 * funds. Read-only tools are invoked directly (safe).
 */

import { describe, expect, test } from 'bun:test'
import { Transaction } from '@mysten/sui/transactions'
import { LENDING_MARKET_ID, LENDING_MARKET_TYPE, SuilendClient } from '@suilend/sdk/client'
import { stakeTovSuiPTB } from 'navi-sdk'
import { keypairFromSecret, makeSuiClient } from '../client'
import type { OnchainRuntimeContext } from '../types'
import { makeScallopMarkets } from './scallop'
import { makeSuilendPosition } from './suilend'

const SUI = '0x2::sui::SUI'
const RUN = process.env.LYRA_RUN_INTEGRATION === '1' && !!process.env.LYRA_AGENT_KEY
const ONE_SUI = 1_000_000_000n

function realCtx(): OnchainRuntimeContext {
  const client = makeSuiClient('mainnet')
  const keypair = keypairFromSecret(process.env.LYRA_AGENT_KEY as string)
  return {
    client,
    keypair,
    agentAddress: keypair.getPublicKey().toSuiAddress(),
    network: 'mainnet',
    agentDir: '/tmp/lyra-integration',
  }
}

async function simStatus(ctx: OnchainRuntimeContext, tx: Transaction): Promise<string | undefined> {
  const r = await ctx.client.devInspectTransactionBlock({
    sender: ctx.agentAddress,
    transactionBlock: tx as never,
  })
  return r.effects?.status?.status
}

describe.skipIf(!RUN)('mainnet dry-run integration', () => {
  test('native stake (1 SUI → validator) simulates success', async () => {
    const ctx = realCtx()
    const state = await ctx.client.getLatestSuiSystemState()
    const validator = state.activeValidators
      .slice()
      .sort((a, b) => Number(b.votingPower) - Number(a.votingPower))[0]
    if (!validator) throw new Error('no active validators')
    const tx = new Transaction()
    tx.setSender(ctx.agentAddress)
    const [coin] = tx.splitCoins(tx.gas, [ONE_SUI])
    tx.moveCall({
      target: '0x3::sui_system::request_add_stake',
      arguments: [tx.object('0x5'), coin, tx.pure.address(validator.suiAddress)],
    })
    expect(await simStatus(ctx, tx)).toBe('success')
  }, 45_000)

  test('Volo liquid stake (1 SUI → vSUI) simulates success', async () => {
    const ctx = realCtx()
    const tx = new Transaction()
    tx.setSender(ctx.agentAddress)
    const [coin] = tx.splitCoins(tx.gas, [ONE_SUI])
    const vsui = await stakeTovSuiPTB(tx as never, coin as never)
    tx.transferObjects([vsui as never], ctx.agentAddress)
    expect(await simStatus(ctx, tx)).toBe('success')
  }, 45_000)

  test('Suilend supply (1 SUI) simulates success', async () => {
    const ctx = realCtx()
    const suilend = await SuilendClient.initialize(
      LENDING_MARKET_ID,
      LENDING_MARKET_TYPE,
      ctx.client as never,
    )
    const caps = await SuilendClient.getObligationOwnerCaps(
      ctx.agentAddress,
      [LENDING_MARKET_TYPE],
      ctx.client as never,
    )
    const tx = new Transaction()
    tx.setSender(ctx.agentAddress)
    const [coin] = tx.splitCoins(tx.gas, [ONE_SUI])
    if (caps.length === 0) {
      const cap = suilend.createObligation(tx as never)
      suilend.deposit(coin as never, SUI, cap, tx as never)
      tx.transferObjects([cap as never], ctx.agentAddress)
    } else {
      const c = caps[0] as { id: string | { id: string } }
      const capId = typeof c.id === 'string' ? c.id : c.id.id
      suilend.deposit(coin as never, SUI, capId, tx as never)
    }
    expect(await simStatus(ctx, tx)).toBe('success')
  }, 45_000)

  test('read-only tools return live data', async () => {
    const ctx = realCtx()
    const position = await makeSuilendPosition(ctx).handler({})
    expect(position.ok).toBe(true)

    const markets = await makeScallopMarkets(ctx).handler({ coins: 'sui' })
    expect(markets.ok).toBe(true)
  }, 45_000)
})
