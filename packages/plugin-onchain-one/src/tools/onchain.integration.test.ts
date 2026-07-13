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
import { MAINNET_WALRUS_PACKAGE_CONFIG, WalrusClient } from '@mysten/walrus'
import { LENDING_MARKET_ID, LENDING_MARKET_TYPE, SuilendClient } from '@suilend/sdk/client'
import { stakeTovSuiPTB } from 'navi-sdk'
import { keypairFromSecret, makeSuiClient } from '../client'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'
import { makeScallopMarkets } from './scallop'
import { makeSuilendPosition } from './suilend'
import { makeWalrusStaking } from './walrus-stake'

const SUI = '0x2::sui::SUI'
const WAL = '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL'
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

  test('Walrus WAL stake (1 WAL → node) simulates success', async () => {
    const ctx = realCtx()
    const walrus = new WalrusClient({ network: 'mainnet', suiClient: ctx.client as never })
    const [stakingObj, state, coins] = await Promise.all([
      walrus.stakingObject(),
      walrus.systemState(),
      ctx.client.getCoins({ owner: ctx.agentAddress, coinType: WAL }),
    ])
    const nodeId = state.committee.members[0]?.node_id
    const walCoin = coins.data[0]?.coinObjectId
    if (!(nodeId && walCoin)) throw new Error('no committee node or WAL coin available')
    const tx = new Transaction()
    tx.setSender(ctx.agentAddress)
    const [toStake] = tx.splitCoins(tx.object(walCoin), [1_000_000_000n]) // 1 WAL (Walrus min)
    const staked = tx.moveCall({
      target: `${stakingObj.package_id}::staking::stake_with_pool`,
      arguments: [
        tx.object(MAINNET_WALRUS_PACKAGE_CONFIG.stakingPoolId),
        toStake,
        tx.pure.id(nodeId),
      ],
    })
    tx.transferObjects([staked], ctx.agentAddress)
    // Use the tool's own dry-run path (dryRunTransactionBlock) — devInspect can't
    // model a split from a non-gas coin object, but dryRun executes it faithfully.
    const sim = await simulate(ctx.client, tx, ctx.agentAddress)
    expect(sim.ok).toBe(true)
  }, 45_000)

  test('read-only tools return live data', async () => {
    const ctx = realCtx()
    const position = await makeSuilendPosition(ctx).handler({})
    expect(position.ok).toBe(true)

    const markets = await makeScallopMarkets(ctx).handler({ coins: 'sui' })
    expect(markets.ok).toBe(true)

    const walStaking = await makeWalrusStaking(ctx).handler({})
    expect(walStaking.ok).toBe(true)
  }, 45_000)
})
