/**
 * Sui native staking — delegate SUI to a validator and unstake.
 *
 *   sui.stake   → 0x3::sui_system::request_add_stake  (min 1 SUI, hard on-chain)
 *   sui.unstake → 0x3::sui_system::request_withdraw_stake
 *
 * Same guarded pipeline as the other write tools: minimum-amount guard →
 * deterministic policy → dry-run simulate → execute → on-chain effects check.
 * Sui native staking rejects anything below 1 SUI, so a too-small amount returns
 * a clear "amount too small" error BEFORE any transaction is built.
 */

import { Transaction } from '@mysten/sui/transactions'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { checkMinimum } from '../minimums'
import { evaluatePolicy, suiToMist } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'

const SUI_TYPE = '0x2::sui::SUI'
const SUI_SYSTEM_STATE = '0x5'
const STAKED_SUI_TYPE = '0x3::staking_pool::StakedSui'

/** Resolve a validator: match `want` by address/name, else pick a large active one. */
async function resolveValidator(
  client: OnchainRuntimeContext['client'],
  want?: string,
): Promise<{ address: string; name: string } | null> {
  const state = await client.getLatestSuiSystemState()
  // biome-ignore lint/suspicious/noExplicitAny: SuiSystemState validator fields
  const vals = (state.activeValidators ?? []) as any[]
  if (vals.length === 0) return null
  if (want?.trim()) {
    const w = want.trim().toLowerCase()
    const m = vals.find(
      v => String(v.suiAddress).toLowerCase() === w || String(v.name ?? '').toLowerCase() === w,
    )
    if (m) return { address: m.suiAddress, name: m.name ?? '' }
    // A raw 0x address the user gave is honored even if not in the top set.
    if (w.startsWith('0x')) return { address: want.trim(), name: '' }
    return null
  }
  // Default: the validator with the most voting power (a large, reliable one).
  const best = vals.reduce((a, b) => (Number(b.votingPower) > Number(a.votingPower) ? b : a))
  return { address: best.suiAddress, name: best.name ?? '' }
}

const StakeSchema = z.object({
  amount: z.string().min(1).describe('Amount of SUI to stake (minimum 1 SUI).'),
  validator: z
    .string()
    .optional()
    .describe('Validator address (0x…) or name. Optional — defaults to a large active validator.'),
})
type StakeArgs = z.infer<typeof StakeSchema>

export function makeStake(ctx: OnchainRuntimeContext): ToolDef<StakeArgs> {
  return {
    name: 'sui.stake',
    description:
      'Stake SUI to a validator (Sui native staking) to earn staking rewards. Minimum 1 SUI (enforced by the network). Policy-checked → simulated → executed; returns a StakedSui object.',
    searchHint: 'stake staking delegate validator earn rewards yield sui native',
    schema: StakeSchema,
    handler: async args => {
      try {
        const amountMist = suiToMist(args.amount)
        if (amountMist === undefined || amountMist <= 0n) {
          return { ok: false, error: `invalid amount "${args.amount}"` }
        }
        const tooSmall = checkMinimum('stake', amountMist)
        if (tooSmall) return { ok: false, error: tooSmall }

        if (ctx.policy) {
          const verdict = evaluatePolicy(
            { kind: 'transfer', coinType: SUI_TYPE, amountMist, protocol: 'stake' },
            ctx.policy,
          )
          if (!verdict.allowed) {
            return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
          }
        }

        const validator = await resolveValidator(ctx.client, args.validator)
        if (!validator) return { ok: false, error: 'no active validator found to stake with' }

        const tx = new Transaction()
        const [coin] = tx.splitCoins(tx.gas, [amountMist])
        tx.moveCall({
          target: '0x3::sui_system::request_add_stake',
          arguments: [tx.object(SUI_SYSTEM_STATE), coin, tx.pure.address(validator.address)],
        })

        const sim = await simulate(ctx.client, tx, ctx.agentAddress)
        if (!sim.ok) return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }

        const res = await ctx.client.signAndExecuteTransaction({
          signer: ctx.keypair,
          transaction: tx,
          options: { showEffects: true, showObjectChanges: true },
        })
        if (res.effects?.status?.status !== 'success') {
          return {
            ok: false,
            error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}`,
          }
        }
        await ctx.client.waitForTransaction({ digest: res.digest })
        const staked = res.objectChanges?.find(
          c =>
            c.type === 'created' &&
            String((c as { objectType?: string }).objectType).includes('staking_pool::StakedSui'),
        ) as { objectId?: string } | undefined

        return {
          ok: true,
          data: {
            protocol: 'sui-staking',
            action: 'stake',
            amountSui: args.amount,
            validator: validator.address,
            validatorName: validator.name || undefined,
            digest: res.digest,
            stakedSuiId: staked?.objectId ?? null,
            status: 'success',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const UnstakeSchema = z.object({
  stakedSuiId: z
    .string()
    .optional()
    .describe('StakedSui object id to withdraw. Optional — defaults to the first staked position.'),
})
type UnstakeArgs = z.infer<typeof UnstakeSchema>

export function makeUnstake(ctx: OnchainRuntimeContext): ToolDef<UnstakeArgs> {
  return {
    name: 'sui.unstake',
    description:
      'Withdraw staked SUI (unstake) from a validator, returning principal + earned rewards. Uses a specific StakedSui object id, or the first staked position if omitted.',
    searchHint: 'unstake withdraw staking redeem claim rewards validator',
    schema: UnstakeSchema,
    handler: async args => {
      try {
        let stakedId = args.stakedSuiId?.trim()
        if (!stakedId) {
          const owned = await ctx.client.getOwnedObjects({
            owner: ctx.agentAddress,
            filter: { StructType: STAKED_SUI_TYPE },
          })
          stakedId = owned.data[0]?.data?.objectId
          if (!stakedId) return { ok: false, error: 'no staked SUI position found to unstake' }
        }

        if (ctx.policy) {
          const verdict = evaluatePolicy(
            { kind: 'transfer', coinType: SUI_TYPE, amountMist: 0n, protocol: 'stake' },
            ctx.policy,
          )
          if (!verdict.allowed) {
            return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
          }
        }

        const tx = new Transaction()
        tx.moveCall({
          target: '0x3::sui_system::request_withdraw_stake',
          arguments: [tx.object(SUI_SYSTEM_STATE), tx.object(stakedId)],
        })

        const sim = await simulate(ctx.client, tx, ctx.agentAddress)
        if (!sim.ok) return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }

        const res = await ctx.client.signAndExecuteTransaction({
          signer: ctx.keypair,
          transaction: tx,
          options: { showEffects: true },
        })
        if (res.effects?.status?.status !== 'success') {
          return {
            ok: false,
            error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}`,
          }
        }
        await ctx.client.waitForTransaction({ digest: res.digest })

        return {
          ok: true,
          data: {
            protocol: 'sui-staking',
            action: 'unstake',
            stakedSuiId: stakedId,
            digest: res.digest,
            status: 'success',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
