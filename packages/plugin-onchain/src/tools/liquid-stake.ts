/**
 * Volo liquid staking — stake SUI for vSUI (a liquid staking token that keeps
 * earning while remaining tradeable / usable in DeFi), and unstake vSUI back to
 * SUI. Built on navi-sdk's Volo PTB helpers.
 *
 *   volo.stake   → SUI → vSUI  (stake_pool::stake)
 *   volo.unstake → vSUI → SUI  (stake_pool::unstake)
 *
 * Same guarded pipeline: minimum guard → policy → dry-run simulate → execute →
 * on-chain effects check.
 */

import { Transaction, coinWithBalance } from '@mysten/sui/transactions'
import type { ToolDef } from 'lyra-core'
import { stakeTovSuiPTB, unstakeTovSui } from 'navi-sdk'
import { z } from 'zod'
import { checkMinimum } from '../minimums'
import { evaluatePolicy, suiToMist } from '../policy'
import { PROTOCOL_IDS } from '../protocol-ids'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'
import { fundSui } from '../vault-fund'

const SUI_TYPE = '0x2::sui::SUI'
const VSUI_TYPE = '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT'

const StakeSchema = z.object({
  amount: z.string().min(1).describe('Amount of SUI to liquid-stake (minimum 1 SUI).'),
})
type StakeArgs = z.infer<typeof StakeSchema>

const UnstakeSchema = z.object({
  amount: z.string().min(1).describe('Amount of vSUI to unstake back to SUI.'),
})
type UnstakeArgs = z.infer<typeof UnstakeSchema>

export function makeVoloStake(ctx: OnchainRuntimeContext): ToolDef<StakeArgs> {
  return {
    name: 'volo.stake',
    description:
      'Liquid-stake SUI with Volo and receive vSUI — a liquid staking token that keeps earning staking rewards while remaining tradeable and usable across Sui DeFi (unlike native staking, which locks the position). Minimum 1 SUI. Policy-checked, simulated, then executed.',
    searchHint:
      'volo liquid stake vsui lst liquid-staking derivative earn yield tradeable sui defi',
    schema: StakeSchema,
    handler: async args => {
      try {
        if (ctx.network !== 'mainnet') return { ok: false, error: 'Volo supports mainnet only' }
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

        const tx = new Transaction()
        // Source the stake from the treasury vault (policy-enforced) when wired.
        const suiCoin = fundSui(tx, ctx, amountMist, {
          protocol: PROTOCOL_IDS.volo,
          kind: 'stake',
          memo: 'volo liquid stake',
        })
        const vsui = await stakeTovSuiPTB(tx as never, suiCoin as never)
        tx.transferObjects([vsui as never], ctx.agentAddress)

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
            protocol: 'volo',
            action: 'liquid-stake',
            amountSui: args.amount,
            received: 'vSUI',
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

export function makeVoloUnstake(ctx: OnchainRuntimeContext): ToolDef<UnstakeArgs> {
  return {
    name: 'volo.unstake',
    description:
      'Unstake vSUI back to SUI via Volo (returns SUI including accrued staking rewards). The amount is denominated in vSUI. Simulated, then executed.',
    searchHint: 'volo unstake vsui redeem convert back sui liquid staking withdraw',
    schema: UnstakeSchema,
    handler: async args => {
      try {
        if (ctx.network !== 'mainnet') return { ok: false, error: 'Volo supports mainnet only' }
        const amountMist = suiToMist(args.amount)
        if (amountMist === undefined || amountMist <= 0n) {
          return { ok: false, error: `invalid amount "${args.amount}"` }
        }

        // Same deterministic policy gate as every other write (previously this
        // path had none): readonly/expiry/protocol-allowlist checks apply, and
        // the permission layer escalates it via the value-moving capability gate.
        if (ctx.policy) {
          const verdict = evaluatePolicy(
            { kind: 'transfer', coinType: VSUI_TYPE, amountMist, protocol: 'stake' },
            ctx.policy,
          )
          if (!verdict.allowed) {
            return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
          }
        }

        const tx = new Transaction()
        // coinWithBalance resolves the agent's vSUI coins into one of the exact size.
        const vsuiCoin = coinWithBalance({ type: VSUI_TYPE, balance: amountMist })
        const sui = await unstakeTovSui(tx as never, vsuiCoin as never)
        tx.transferObjects([sui as never], ctx.agentAddress)

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
            protocol: 'volo',
            action: 'unstake',
            amountVsui: args.amount,
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
