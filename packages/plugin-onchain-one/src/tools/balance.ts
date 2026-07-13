/**
 * Read-only account tools: `sui.balance` and `account.info`.
 */

import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import type { OnchainRuntimeContext } from '../types'

const SUI_TYPE = '0x2::sui::SUI'

/** Format a MIST amount as a human SUI string. */
export function fmtSui(mist: string | bigint): string {
  return (Number(BigInt(mist)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 6 })
}

const BalanceSchema = z.object({
  address: z.string().optional().describe('Address to check. Defaults to the agent address.'),
})
type BalanceArgs = z.infer<typeof BalanceSchema>

export function makeSuiBalance(ctx: OnchainRuntimeContext): ToolDef<BalanceArgs> {
  return {
    name: 'sui.balance',
    description:
      "Show SUI and other coin balances for the agent (or a given address). Read-only. Use for 'what's my balance', 'how much SUI do I have'.",
    searchHint: 'balance sui holdings funds wallet how much do i have coins',
    schema: BalanceSchema,
    handler: async args => {
      try {
        const owner = args.address?.trim() || ctx.agentAddress
        const sui = await ctx.client.getBalance({ owner, coinType: SUI_TYPE })
        const all = await ctx.client.getAllBalances({ owner })
        return {
          ok: true,
          data: {
            address: owner,
            network: ctx.network,
            sui: { mist: sui.totalBalance, formatted: `${fmtSui(sui.totalBalance)} SUI` },
            coins: all
              .filter(b => b.coinType !== SUI_TYPE && BigInt(b.totalBalance) > 0n)
              .map(b => ({ coinType: b.coinType, balance: b.totalBalance })),
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const InfoSchema = z.object({})
type InfoArgs = z.infer<typeof InfoSchema>

export function makeAccountInfo(ctx: OnchainRuntimeContext): ToolDef<InfoArgs> {
  return {
    name: 'account.info',
    description:
      "The agent's on-chain identity: Sui address, network, SUI balance, the lyra::policy package + policy object in force, and whether a deterministic policy is armed. Read-only.",
    searchHint: 'account identity who am i address agent network policy package',
    schema: InfoSchema,
    handler: async () => {
      try {
        const sui = await ctx.client.getBalance({ owner: ctx.agentAddress, coinType: SUI_TYPE })
        return {
          ok: true,
          data: {
            agentAddress: ctx.agentAddress,
            network: ctx.network,
            sui: `${fmtSui(sui.totalBalance)} SUI`,
            policyPackage: ctx.packageId ?? null,
            policyObject: ctx.policyObjectId ?? null,
            policyArmed: ctx.policy != null,
            brainModel: ctx.brainModel ?? null,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
