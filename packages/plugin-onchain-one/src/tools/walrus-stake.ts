/**
 * Walrus (WAL) staking — delegate WAL to a Walrus storage node's staking pool to
 * earn rewards + help secure the storage network. This is the integration behind
 * https://stake-wal.wal.app, exposed to the agent:
 *
 *   walrus.stake    → <walrus>::staking::stake_with_pool        → StakedWal
 *   walrus.unstake  → <walrus>::staking::request_withdraw_stake (returns WAL next epoch)
 *   walrus.staking  → read: WAL balance, StakedWal positions, top nodes
 *
 * Same guarded pipeline as the other write tools: minimum-amount guard →
 * deterministic off-chain policy → dry-run simulate → execute → on-chain effects
 * check. WAL is drawn from the agent's WAL balance (not the SUI vault — the vault
 * is SUI-typed), so the on-chain SUI budget doesn't apply; the action is bounded
 * by the `walrus` protocol allowlist and audited by the on-chain StakedWal object.
 */

import { Transaction } from '@mysten/sui/transactions'
import {
  MAINNET_WALRUS_PACKAGE_CONFIG,
  TESTNET_WALRUS_PACKAGE_CONFIG,
  WalrusClient,
} from '@mysten/walrus'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { simulateAndExecute } from '../execute'
import { policyBlock, suiToMist } from '../policy'
import type { OnchainRuntimeContext } from '../types'

// WAL has 9 decimals (like SUI). Walrus rejects a pool contribution below its
// minimum stake (staked_wal::mint aborts with code 7 for a too-small stake) — the
// on-chain floor is 1 WAL, so reject anything smaller early with a clear message.
const MIN_WAL_FROST = 1_000_000_000n // 1 WAL (Walrus minimum stake)
const STAKED_WAL_SUFFIX = '::staked_wal::StakedWal'

const WAL_TYPE: Record<string, string> = {
  mainnet: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
}

function fmtWal(frost: bigint): string {
  return (Number(frost) / 1e9).toString()
}

interface WalrusStaking {
  pkg: string // walrus package (moveCall target; resolved live so upgrades are safe)
  stakingId: string // the shared Staking system object
  walType: string
  walrus: WalrusClient
}

/** Resolve the live Walrus staking objects + WAL coin type for the network. */
async function resolveWalrus(ctx: OnchainRuntimeContext): Promise<WalrusStaking> {
  const network = ctx.walrusNetwork ?? ctx.network
  const walrus = new WalrusClient({
    network,
    // cast: @mysten/walrus bundles a different @mysten/sui minor; runtime-compatible.
    suiClient: ctx.client as never,
  })
  const stakingObj = await walrus.stakingObject()
  const cfg = network === 'testnet' ? TESTNET_WALRUS_PACKAGE_CONFIG : MAINNET_WALRUS_PACKAGE_CONFIG
  let walType = WAL_TYPE[network]
  if (!walType) {
    // Non-mainnet: discover the WAL type from the agent's own balances.
    const balances = await ctx.client.getAllBalances({ owner: ctx.agentAddress })
    walType = balances.find(b => b.coinType.endsWith('::wal::WAL'))?.coinType ?? ''
    if (!walType) throw new Error(`could not resolve the WAL coin type on ${network}`)
  }
  return { pkg: stakingObj.package_id, stakingId: cfg.stakingPoolId, walType, walrus }
}

/** Pick a storage node to stake with: match `want` by node id, else the node with
 *  the most stake weight (a large, reliable committee member). */
async function resolveNode(
  walrus: WalrusClient,
  want?: string,
): Promise<{ nodeId: string; weight: number } | null> {
  const state = await walrus.systemState()
  const members = state.committee.members
  if (members.length === 0) return null
  if (want?.trim()) {
    const w = want.trim().toLowerCase()
    const m = members.find(x => String(x.node_id).toLowerCase() === w)
    if (m) return { nodeId: m.node_id, weight: m.weight }
    if (w.startsWith('0x')) return { nodeId: want.trim(), weight: 0 }
    return null
  }
  const best = members.reduce((a, b) => (Number(b.weight) > Number(a.weight) ? b : a))
  return { nodeId: best.node_id, weight: best.weight }
}

/** Merge the agent's WAL coins, split off `frost`, stake it with `node`, and send
 *  the resulting StakedWal back to the agent. */
function buildWalrusStakeTx(
  pkg: string,
  stakingId: string,
  node: { nodeId: string },
  frost: bigint,
  firstCoin: { coinObjectId: string },
  restCoins: { coinObjectId: string }[],
  agentAddress: string,
): Transaction {
  const tx = new Transaction()
  const primary = tx.object(firstCoin.coinObjectId)
  if (restCoins.length > 0) {
    tx.mergeCoins(
      primary,
      restCoins.map(c => tx.object(c.coinObjectId)),
    )
  }
  const [toStake] = tx.splitCoins(primary, [tx.pure.u64(frost)])
  const staked = tx.moveCall({
    target: `${pkg}::staking::stake_with_pool`,
    arguments: [tx.object(stakingId), toStake, tx.pure.id(node.nodeId)],
  })
  tx.transferObjects([staked], agentAddress)
  return tx
}

// ─────────────────────────── walrus.stake ───────────────────────────

const StakeSchema = z.object({
  amount: z.string().min(1).describe('Amount of WAL to stake (minimum 1 WAL).'),
  node: z
    .string()
    .optional()
    .describe('Storage node id (0x…) to stake with. Optional — defaults to a large active node.'),
})
type StakeArgs = z.infer<typeof StakeSchema>

interface WalrusStakePrep {
  pkg: string
  stakingId: string
  node: { nodeId: string; weight: number }
  frost: bigint
  firstCoin: { coinObjectId: string }
  restCoins: { coinObjectId: string }[]
}

/** Validate the amount, gate on policy, and resolve the live staking objects, the
 *  target node, and the agent's WAL coins — everything the stake PTB needs. */
async function prepareWalrusStake(
  ctx: OnchainRuntimeContext,
  amount: string,
  wantNode?: string,
): Promise<WalrusStakePrep | { error: string }> {
  const frost = suiToMist(amount) // WAL shares SUI's 9-decimal scaling
  if (frost === undefined || frost <= 0n) return { error: `invalid amount "${amount}"` }
  if (frost < MIN_WAL_FROST)
    return {
      error: `amount too small: ${fmtWal(frost)} WAL is below the ${fmtWal(MIN_WAL_FROST)} WAL minimum for staking`,
    }

  const { pkg, stakingId, walType, walrus } = await resolveWalrus(ctx)

  const blocked = policyBlock(ctx.policy, {
    kind: 'transfer',
    coinType: walType,
    amountMist: frost,
    protocol: 'walrus',
  })
  if (blocked) return { error: blocked }

  const bal = await ctx.client.getBalance({ owner: ctx.agentAddress, coinType: walType })
  if (BigInt(bal.totalBalance) < frost)
    return {
      error: `insufficient WAL: have ${fmtWal(BigInt(bal.totalBalance))}, need ${fmtWal(frost)}`,
    }

  const node = await resolveNode(walrus, wantNode)
  if (!node) return { error: 'no active Walrus storage node found to stake with' }

  const coins = await ctx.client.getCoins({ owner: ctx.agentAddress, coinType: walType })
  const [firstCoin, ...restCoins] = coins.data
  if (!firstCoin) return { error: 'no WAL coins in the agent wallet' }

  return { pkg, stakingId, node, frost, firstCoin, restCoins }
}

export function makeWalrusStake(ctx: OnchainRuntimeContext): ToolDef<StakeArgs> {
  return {
    name: 'walrus.stake',
    description:
      'Stake WAL to a Walrus storage node to earn staking rewards and help secure decentralized storage. Minimum 1 WAL. Policy-checked → simulated → executed; returns a StakedWal object.',
    searchHint: 'walrus stake WAL storage node delegate earn rewards staking wal.app',
    schema: StakeSchema,
    handler: async args => {
      try {
        const prep = await prepareWalrusStake(ctx, args.amount, args.node)
        if ('error' in prep) return { ok: false, error: prep.error }
        const { pkg, stakingId, node, frost, firstCoin, restCoins } = prep

        const tx = buildWalrusStakeTx(
          pkg,
          stakingId,
          node,
          frost,
          firstCoin,
          restCoins,
          ctx.agentAddress,
        )

        const exec = await simulateAndExecute(ctx, tx, { showObjectChanges: true })
        if (!exec.ok) return exec
        const stakedWal = exec.value.objectChanges?.find(
          c =>
            (c as { type?: string }).type === 'created' &&
            String((c as { objectType?: string }).objectType).endsWith(STAKED_WAL_SUFFIX),
        ) as { objectId?: string } | undefined

        return {
          ok: true,
          data: {
            protocol: 'walrus-staking',
            action: 'stake',
            amountWal: args.amount,
            node: node.nodeId,
            digest: exec.value.digest,
            stakedWalId: stakedWal?.objectId ?? null,
            status: 'success',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─────────────────────────── walrus.unstake ───────────────────────────

const UnstakeSchema = z.object({
  stakedWalId: z
    .string()
    .optional()
    .describe('StakedWal object id to withdraw. Optional — defaults to the first staked position.'),
})
type UnstakeArgs = z.infer<typeof UnstakeSchema>

export function makeWalrusUnstake(ctx: OnchainRuntimeContext): ToolDef<UnstakeArgs> {
  return {
    name: 'walrus.unstake',
    description:
      'Request to withdraw staked WAL from a Walrus node. The principal + rewards become withdrawable after the next epoch. Uses a StakedWal object id, or the first staked position if omitted.',
    searchHint: 'walrus unstake withdraw WAL staking redeem claim rewards storage node',
    schema: UnstakeSchema,
    handler: async args => {
      try {
        const { pkg, stakingId, walType } = await resolveWalrus(ctx)

        let stakedId = args.stakedWalId?.trim()
        if (!stakedId) {
          const owned = await ctx.client.getOwnedObjects({
            owner: ctx.agentAddress,
            filter: { StructType: `${walType.split('::')[0]}${STAKED_WAL_SUFFIX}` },
          })
          stakedId = owned.data[0]?.data?.objectId
          if (!stakedId) return { ok: false, error: 'no StakedWal position found to unstake' }
        }

        const blocked = policyBlock(ctx.policy, {
          kind: 'transfer',
          coinType: walType,
          amountMist: 0n,
          protocol: 'walrus',
        })
        if (blocked) return { ok: false, error: blocked }

        const tx = new Transaction()
        tx.moveCall({
          target: `${pkg}::staking::request_withdraw_stake`,
          arguments: [tx.object(stakingId), tx.object(stakedId)],
        })

        const exec = await simulateAndExecute(ctx, tx)
        if (!exec.ok) return exec
        return {
          ok: true,
          data: {
            protocol: 'walrus-staking',
            action: 'unstake',
            stakedWalId: stakedId,
            digest: exec.value.digest,
            note: 'WAL becomes withdrawable after the next Walrus epoch',
            status: 'success',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─────────────────────────── walrus.staking (read) ───────────────────────────

const ReadSchema = z.object({})
type ReadArgs = z.infer<typeof ReadSchema>

export function makeWalrusStaking(ctx: OnchainRuntimeContext): ToolDef<ReadArgs> {
  return {
    name: 'walrus.staking',
    description:
      "Read the agent's Walrus staking position: WAL balance, current StakedWal positions, and a few large storage nodes to stake with.",
    searchHint: 'walrus staking position WAL balance staked nodes committee read status',
    schema: ReadSchema,
    handler: async () => {
      try {
        const { walType, walrus } = await resolveWalrus(ctx)
        const [bal, owned, state] = await Promise.all([
          ctx.client.getBalance({ owner: ctx.agentAddress, coinType: walType }),
          ctx.client.getOwnedObjects({
            owner: ctx.agentAddress,
            filter: { StructType: `${walType.split('::')[0]}${STAKED_WAL_SUFFIX}` },
            options: { showType: true },
          }),
          walrus.systemState(),
        ])
        const topNodes = [...state.committee.members]
          .sort((a, b) => Number(b.weight) - Number(a.weight))
          .slice(0, 5)
          .map(m => ({ nodeId: m.node_id, weight: m.weight }))
        return {
          ok: true,
          data: {
            walBalance: fmtWal(BigInt(bal.totalBalance)),
            stakedPositions: owned.data.map(o => o.data?.objectId).filter(Boolean),
            committeeSize: state.committee.members.length,
            topNodes,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
