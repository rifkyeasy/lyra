/**
 * Suilend lending tools (supporting integration): SUI supply / withdraw /
 * borrow / repay + a read-only position, on Suilend's MAIN_POOL lending market.
 *
 * Suilend is one of the three largest money markets on Sui. Its SDK's 3.x line
 * pins @mysten/sui v2 (a Transaction-class ABI break vs. our v1 stack), so we
 * use @suilend/sdk@1.1.x, whose @mysten/sui is a *peerDependency* — it binds to
 * our hosted v1 copy, so the v1 Transaction we build is accepted directly by the
 * SDK (verified end-to-end with a live mainnet dry-run of a deposit).
 *
 * Value semantics (checked against the SDK source):
 *   deposit / borrow / repay  → underlying MIST (clean).
 *   withdraw                  → cTokens; we convert the requested underlying via
 *                               the reserve's cToken exchange rate.
 *
 * Every write runs the same guarded pipeline as sui.send: minimum guard →
 * policy gate → dry-run simulate → execute → on-chain effects check. The
 * simulate is the safety net — an under-collateralized borrow or an over-sized
 * withdraw fails before broadcast, never a false success.
 */

import { Transaction } from '@mysten/sui/transactions'
import {
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
  SuilendClient,
  initializeSuilend,
} from '@suilend/sdk'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { checkMinimum } from '../minimums'
import { evaluatePolicy, suiToMist } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'

const SUI_TYPE = '0x2::sui::SUI'
// Canonical + long-form SUI coin types (reserve maps may use either).
const SUI_LONG = `0x${'0'.repeat(63)}2::sui::SUI`

function ensureMainnet(ctx: OnchainRuntimeContext): string | null {
  return ctx.network === 'mainnet' ? null : 'Suilend SDK supports mainnet only'
}

async function newSuilend(ctx: OnchainRuntimeContext): Promise<SuilendClient> {
  // ctx.client is @mysten/sui v1.4x; @suilend/sdk@1.1.x binds @mysten/sui as a
  // peer, so the client interops directly across the copy boundary.
  return SuilendClient.initialize(LENDING_MARKET_ID, LENDING_MARKET_TYPE, ctx.client as never)
}

/** Extract the object id from a parsed ObligationOwnerCap (`id` is a UID). */
function capObjectId(cap: { id: unknown }): string {
  const id = cap.id as string | { id: string }
  return typeof id === 'string' ? id : id.id
}

function isSuiType(t: string): boolean {
  return t === SUI_TYPE || t === SUI_LONG
}

/** The agent's obligation cap + id, or null if it has no Suilend position yet. */
async function findObligation(
  ctx: OnchainRuntimeContext,
): Promise<{ capId: string; obligationId: string } | null> {
  const caps = await SuilendClient.getObligationOwnerCaps(
    ctx.agentAddress,
    [LENDING_MARKET_TYPE],
    ctx.client as never,
  )
  if (!caps.length) return null
  const c = caps[0] as { id: unknown; obligationId: string | { id: string } }
  const obligationId = typeof c.obligationId === 'string' ? c.obligationId : c.obligationId.id
  return { capId: capObjectId(c), obligationId }
}

// --- suilend.supply --------------------------------------------------------

const AmountSchema = z.object({
  amount: z.string().min(1).describe('Amount of SUI, e.g. "1.5".'),
})
type AmountArgs = z.infer<typeof AmountSchema>

export function makeSuilendSupply(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'suilend.supply',
    description:
      'Supply (deposit) idle SUI into Suilend to earn lending yield. Creates a Suilend obligation on first use, then deposits into it. Policy-checked, simulated, then executed.',
    searchHint: 'suilend supply deposit lend sui earn yield idle money market',
    schema: AmountSchema,
    handler: async args => {
      const err = ensureMainnet(ctx)
      if (err) return { ok: false, error: err }
      const amountMist = suiToMist(args.amount)
      if (amountMist === undefined || amountMist <= 0n)
        return { ok: false, error: `invalid amount "${args.amount}"` }
      const tooSmall = checkMinimum('supply', amountMist)
      if (tooSmall) return { ok: false, error: tooSmall }
      if (ctx.policy) {
        const verdict = evaluatePolicy(
          { kind: 'transfer', coinType: SUI_TYPE, amountMist, protocol: 'suilend' },
          ctx.policy,
        )
        if (!verdict.allowed)
          return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
      }
      try {
        const suilend = await newSuilend(ctx)
        const existing = await findObligation(ctx)
        const tx = new Transaction()
        tx.setSender(ctx.agentAddress)
        const [coin] = tx.splitCoins(tx.gas, [amountMist])
        // The @suilend/sdk@1.1.x SDK carries its own nested @mysten/sui copy, so
        // TS sees a distinct Transaction class — cast at the boundary. The two
        // copies interop at runtime (verified with a live mainnet dry-run).
        if (existing) {
          suilend.deposit(coin as never, SUI_TYPE, existing.capId, tx as never)
        } else {
          const cap = suilend.createObligation(tx as never)
          suilend.deposit(coin as never, SUI_TYPE, cap, tx as never)
          tx.transferObjects([cap as never], ctx.agentAddress)
        }
        const sim = await simulate(ctx.client, tx, ctx.agentAddress)
        if (!sim.ok) return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }
        const res = await ctx.client.signAndExecuteTransaction({
          signer: ctx.keypair,
          transaction: tx,
          options: { showEffects: true },
        })
        if (res.effects?.status?.status !== 'success')
          return {
            ok: false,
            error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}`,
          }
        await ctx.client.waitForTransaction({ digest: res.digest })
        return {
          ok: true,
          data: {
            protocol: 'suilend',
            action: 'supply',
            amountSui: args.amount,
            newObligation: !existing,
            digest: res.digest,
            policyEnforced: ctx.policy != null,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// --- suilend.withdraw ------------------------------------------------------

export function makeSuilendWithdraw(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'suilend.withdraw',
    description:
      'Withdraw supplied SUI from Suilend back to the agent (amount in underlying SUI). Refreshes prices, converts to cTokens at the current exchange rate, simulated, then executed.',
    searchHint: 'suilend withdraw redeem unlend remove supplied sui money market',
    schema: AmountSchema,
    handler: async args => {
      const err = ensureMainnet(ctx)
      if (err) return { ok: false, error: err }
      const amountMist = suiToMist(args.amount)
      if (amountMist === undefined || amountMist <= 0n)
        return { ok: false, error: `invalid amount "${args.amount}"` }
      try {
        const suilend = await newSuilend(ctx)
        const obligation = await findObligation(ctx)
        if (!obligation)
          return { ok: false, error: 'no Suilend position — supply SUI before withdrawing' }
        // Convert underlying → cTokens using the SUI reserve exchange rate.
        const data = await initializeSuilend(ctx.client as never, suilend)
        const rate = suiReserveExchangeRate(data)
        if (rate === null) return { ok: false, error: 'could not read SUI reserve exchange rate' }
        // cTokens = floor(underlying / rate); floor keeps us at/under the request.
        const ctokens = BigInt(Math.floor(Number(amountMist) / rate))
        if (ctokens <= 0n) return { ok: false, error: 'amount too small to withdraw' }
        const tx = new Transaction()
        tx.setSender(ctx.agentAddress)
        await suilend.withdrawAndSendToUser(
          ctx.agentAddress,
          obligation.capId,
          obligation.obligationId,
          SUI_TYPE,
          ctokens.toString(),
          tx as never,
        )
        const sim = await simulate(ctx.client, tx, ctx.agentAddress)
        if (!sim.ok) return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }
        const res = await ctx.client.signAndExecuteTransaction({
          signer: ctx.keypair,
          transaction: tx,
          options: { showEffects: true },
        })
        if (res.effects?.status?.status !== 'success')
          return {
            ok: false,
            error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}`,
          }
        await ctx.client.waitForTransaction({ digest: res.digest })
        return {
          ok: true,
          data: {
            protocol: 'suilend',
            action: 'withdraw',
            amountSui: args.amount,
            digest: res.digest,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// --- suilend.borrow --------------------------------------------------------

export function makeSuilendBorrow(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'suilend.borrow',
    description:
      'Borrow SUI from Suilend against supplied collateral (amount in underlying SUI). Requires an existing obligation with enough health; the pre-flight simulation fails cleanly if under-collateralized. Policy-checked, simulated, then executed.',
    searchHint: 'suilend borrow loan leverage debt against collateral sui money market',
    schema: AmountSchema,
    handler: async args => {
      const err = ensureMainnet(ctx)
      if (err) return { ok: false, error: err }
      const amountMist = suiToMist(args.amount)
      if (amountMist === undefined || amountMist <= 0n)
        return { ok: false, error: `invalid amount "${args.amount}"` }
      const tooSmall = checkMinimum('borrow', amountMist)
      if (tooSmall) return { ok: false, error: tooSmall }
      if (ctx.policy) {
        const verdict = evaluatePolicy(
          { kind: 'transfer', coinType: SUI_TYPE, amountMist, protocol: 'borrow' },
          ctx.policy,
        )
        if (!verdict.allowed)
          return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
      }
      try {
        const suilend = await newSuilend(ctx)
        const obligation = await findObligation(ctx)
        if (!obligation)
          return { ok: false, error: 'no Suilend position — supply collateral before borrowing' }
        const tx = new Transaction()
        tx.setSender(ctx.agentAddress)
        // borrow() self-refreshes prices (addRefreshCalls default true).
        await suilend.borrowAndSendToUser(
          ctx.agentAddress,
          obligation.capId,
          obligation.obligationId,
          SUI_TYPE,
          amountMist.toString(),
          tx as never,
        )
        const sim = await simulate(ctx.client, tx, ctx.agentAddress)
        if (!sim.ok) return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }
        const res = await ctx.client.signAndExecuteTransaction({
          signer: ctx.keypair,
          transaction: tx,
          options: { showEffects: true },
        })
        if (res.effects?.status?.status !== 'success')
          return {
            ok: false,
            error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}`,
          }
        await ctx.client.waitForTransaction({ digest: res.digest })
        return {
          ok: true,
          data: {
            protocol: 'suilend',
            action: 'borrow',
            amountSui: args.amount,
            digest: res.digest,
            policyEnforced: ctx.policy != null,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// --- suilend.repay ---------------------------------------------------------

export function makeSuilendRepay(ctx: OnchainRuntimeContext): ToolDef<AmountArgs> {
  return {
    name: 'suilend.repay',
    description:
      'Repay borrowed SUI debt on Suilend (amount in underlying SUI). Simulated, then executed.',
    searchHint: 'suilend repay pay back debt loan close sui money market',
    schema: AmountSchema,
    handler: async args => {
      const err = ensureMainnet(ctx)
      if (err) return { ok: false, error: err }
      const amountMist = suiToMist(args.amount)
      if (amountMist === undefined || amountMist <= 0n)
        return { ok: false, error: `invalid amount "${args.amount}"` }
      if (ctx.policy) {
        const verdict = evaluatePolicy(
          { kind: 'transfer', coinType: SUI_TYPE, amountMist, protocol: 'suilend' },
          ctx.policy,
        )
        if (!verdict.allowed)
          return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
      }
      try {
        const suilend = await newSuilend(ctx)
        const obligation = await findObligation(ctx)
        if (!obligation) return { ok: false, error: 'no Suilend position — nothing to repay' }
        const tx = new Transaction()
        tx.setSender(ctx.agentAddress)
        await suilend.repayIntoObligation(
          ctx.agentAddress,
          obligation.obligationId,
          SUI_TYPE,
          amountMist.toString(),
          tx as never,
        )
        const sim = await simulate(ctx.client, tx, ctx.agentAddress)
        if (!sim.ok) return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }
        const res = await ctx.client.signAndExecuteTransaction({
          signer: ctx.keypair,
          transaction: tx,
          options: { showEffects: true },
        })
        if (res.effects?.status?.status !== 'success')
          return {
            ok: false,
            error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}`,
          }
        await ctx.client.waitForTransaction({ digest: res.digest })
        return {
          ok: true,
          data: {
            protocol: 'suilend',
            action: 'repay',
            amountSui: args.amount,
            digest: res.digest,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// --- suilend.position (read) -----------------------------------------------

const PositionSchema = z.object({})
type PositionArgs = z.infer<typeof PositionSchema>

export function makeSuilendPosition(ctx: OnchainRuntimeContext): ToolDef<PositionArgs> {
  return {
    name: 'suilend.position',
    description:
      "The agent's Suilend position: deposits, borrows, and per-asset balances. Read-only.",
    searchHint: 'suilend position portfolio deposits borrows collateral debt health',
    schema: PositionSchema,
    handler: async () => {
      const err = ensureMainnet(ctx)
      if (err) return { ok: false, error: err }
      try {
        const suilend = await newSuilend(ctx)
        const obligation = await findObligation(ctx)
        if (!obligation)
          return {
            ok: true,
            data: { protocol: 'suilend', hasPosition: false, deposits: [], borrows: [] },
          }
        const parsed = (await suilend.getObligation(obligation.obligationId)) as {
          deposits?: Array<{ coinType?: { name?: string }; depositedCtokenAmount?: bigint }>
          borrows?: Array<{ coinType?: { name?: string }; borrowedAmount?: { value?: bigint } }>
        }
        return {
          ok: true,
          data: {
            protocol: 'suilend',
            hasPosition: true,
            obligationId: obligation.obligationId,
            deposits: (parsed.deposits ?? []).map(d => ({
              coin: d.coinType?.name,
              ctokens: String(d.depositedCtokenAmount ?? 0n),
            })),
            borrows: (parsed.borrows ?? []).map(b => ({
              coin: b.coinType?.name,
              borrowed: String(b.borrowedAmount?.value ?? 0n),
            })),
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

/** Find the SUI reserve's cToken exchange rate (underlying per cToken) from an
 *  initializeSuilend() result, or null if not present. */
function suiReserveExchangeRate(data: unknown): number | null {
  const d = data as {
    reserveMap?: Record<string, { coinType?: string; cTokenExchangeRate?: unknown }>
  }
  const map = d.reserveMap
  if (!map) return null
  const reserve =
    map[SUI_TYPE] ??
    map[SUI_LONG] ??
    Object.values(map).find(r => typeof r.coinType === 'string' && isSuiType(r.coinType))
  if (!reserve) return null
  const rate = Number(String(reserve.cTokenExchangeRate))
  return Number.isFinite(rate) && rate > 0 ? rate : null
}
