/**
 * `swap` — execute a token swap on Sui via the 7k aggregator (best route across
 * Cetus, FlowX, Bluefin, DeepBook, ...). Runs through the same policy → simulate
 * → execute pipeline as every other write.
 *
 * Why 7k and not the Cetus aggregator directly: Cetus's aggregator SDK pins
 * @mysten/sui v2 (incompatible with this stack's v1.45), and DeepBook's own
 * swap needs DEEP for fees + a 1-SUI min lot. 7k (@7kprotocol/sdk-ts) is
 * v1-compatible and routes across all of them, paying fees from the route.
 */

import { MetaAg } from '@7kprotocol/sdk-ts'
import {
  Transaction,
  type TransactionObjectArgument,
  coinWithBalance,
} from '@mysten/sui/transactions'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { type CoinInfo, decimalToBase, resolveCoin } from '../coins'
import { checkMinimum } from '../minimums'
import { normalizeCoinType, policyBlock } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'
import { canFundFromVault, fundSui } from '../vault-fund'

const SUI_TYPE = '0x2::sui::SUI'
const CLOCK = '0x6'
/** Default max slippage when neither the call nor the policy specifies one. */
const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%

const enc = (tx: Transaction, s: string) =>
  tx.pure.vector('u8', Array.from(new TextEncoder().encode(s)))

/**
 * Source the swap input coin and return a `sink` for the output. Best-practice
 * (zero standing exposure) when a SUI input has a wired `Vault<SUI>` AND the owner
 * has a `Vault<outputType>`: `vault_borrow` the SUI (a FlashSpend hot potato) and
 * `vault_settle` the swapped output back into that vault — funds never leave the
 * treasury. Otherwise fall back to funding from the vault/agent SUI and sending the
 * output to the agent.
 */
function sourceAndSink(
  tx: Transaction,
  ctx: OnchainRuntimeContext,
  from: CoinInfo,
  to: CoinInfo,
  amountMist: bigint,
  memo: string,
): { coinIn: TransactionObjectArgument; sink: (coinOut: TransactionObjectArgument) => void } {
  const outVaultId =
    from.type === SUI_TYPE ? ctx.assetVaultIds?.[normalizeCoinType(to.type)] : undefined
  if (
    outVaultId &&
    ctx.vaultId &&
    ctx.policyObjectId &&
    ctx.packageId &&
    canFundFromVault(ctx, amountMist)
  ) {
    const [coinIn, flash] = tx.moveCall({
      target: `${ctx.packageId}::vault::vault_borrow`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(ctx.vaultId),
        tx.object(ctx.policyObjectId),
        tx.pure.u64(amountMist),
        tx.pure.address('0x0'),
        enc(tx, 'swap'),
        enc(tx, memo),
        tx.object(CLOCK),
      ],
    })
    const pkg = ctx.packageId
    return {
      coinIn: coinIn as TransactionObjectArgument,
      sink: coinOut => {
        tx.moveCall({
          target: `${pkg}::vault::vault_settle`,
          typeArguments: [to.type],
          arguments: [tx.object(outVaultId), flash as TransactionObjectArgument, coinOut],
        })
      },
    }
  }
  const coinIn =
    from.type === SUI_TYPE
      ? fundSui(tx, ctx, amountMist, { protocol: '0x0', kind: 'swap', memo })
      : coinWithBalance({ type: from.type, balance: amountMist })
  return {
    coinIn: coinIn as TransactionObjectArgument,
    sink: coinOut => {
      tx.transferObjects([coinOut], ctx.agentAddress)
    },
  }
}

interface ResolvedSwap {
  from: CoinInfo
  to: CoinInfo
  amountIn: bigint
}

/** Resolve both coins (real decimals — never guessed) + parse/validate the amount. */
async function resolveSwapCoins(
  ctx: OnchainRuntimeContext,
  args: { from: string; to: string; amount: string },
): Promise<ResolvedSwap | { error: string }> {
  const from = await resolveCoin(ctx.client, args.from)
  const to = await resolveCoin(ctx.client, args.to)
  if (!from)
    return { error: `unknown coin "${args.from}" (specify a known symbol or full coin type)` }
  if (!to) return { error: `unknown coin "${args.to}" (specify a known symbol or full coin type)` }
  if (from.type === to.type) return { error: 'from and to are the same coin' }
  const amountIn = decimalToBase(args.amount, from.decimals)
  if (amountIn === undefined || amountIn <= 0n) return { error: `invalid amount "${args.amount}"` }
  if (from.type === SUI_TYPE) {
    const tooSmall = checkMinimum('swap', amountIn)
    if (tooSmall) return { error: tooSmall }
  }
  return { from, to, amountIn }
}

interface PickedRoute {
  provider: string
  amountOut: number
  tx: Transaction
  gasUsed?: string
}

/**
 * Try the quoted routes in best-output order, building + simulating each; return
 * the first that simulates cleanly (some providers build PTBs that revert), or the
 * collected failures.
 */
async function pickCleanRoute(
  ctx: OnchainRuntimeContext,
  ag: MetaAg,
  // biome-ignore lint/suspicious/noExplicitAny: 7k route-quote shape
  quotes: any[],
  r: ResolvedSwap,
  toLabel: string,
): Promise<PickedRoute | { failures: string[] }> {
  const me = ctx.agentAddress
  const failures: string[] = []
  for (const q of quotes) {
    const tx = new Transaction()
    tx.setSender(me)
    tx.setGasBudget(150_000_000)
    try {
      const { coinIn, sink } = sourceAndSink(
        tx,
        ctx,
        r.from,
        r.to,
        r.amountIn,
        `swap to ${toLabel}`,
      )
      const coinOut = await ag.swap({ quote: q, signer: me, tx, coinIn: coinIn as never })
      sink(coinOut as TransactionObjectArgument)
      const sim = await simulate(ctx.client, tx, me)
      if (sim.ok) {
        return {
          provider: String(q.provider),
          amountOut: Number(q.amountOut ?? 0),
          tx,
          gasUsed: sim.gasUsed,
        }
      }
      failures.push(`${q.provider}: ${sim.reason}`)
    } catch (e) {
      failures.push(`${q.provider}: ${(e as Error).message.slice(0, 60)}`)
    }
  }
  return { failures }
}

/** Sign + execute the chosen route's PTB, wait for indexing, and shape the result. */
async function executePickedRoute(
  ctx: OnchainRuntimeContext,
  picked: PickedRoute,
  args: { from: string; to: string; amount: string },
  to: CoinInfo,
  slippageBps: number,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const res = await ctx.client.signAndExecuteTransaction({
    signer: ctx.keypair,
    transaction: picked.tx,
    options: { showEffects: true },
  })
  if (res.effects?.status?.status !== 'success') {
    return { ok: false, error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}` }
  }
  await ctx.client.waitForTransaction({ digest: res.digest })
  return {
    ok: true,
    data: {
      from: args.from,
      to: args.to,
      amountIn: args.amount,
      amountOut: (picked.amountOut / 10 ** to.decimals).toString(),
      route: picked.provider,
      slippageBps,
      digest: res.digest,
      simGasUsed: picked.gasUsed,
      policyEnforced: ctx.policy != null,
    },
  }
}

const Schema = z.object({
  from: z.string().min(1).describe('Input coin: symbol (sui, usdc, deep, wal) or full coin type.'),
  to: z.string().min(1).describe('Output coin: symbol or full coin type.'),
  amount: z.string().min(1).describe('Input amount in whole units of `from`, e.g. "1".'),
  slippageBps: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .describe('Max slippage tolerance in basis points (default 50 = 0.5%). Capped by policy.'),
})
type Args = z.infer<typeof Schema>

export function makeSwap(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'swap',
    description:
      'Swap one coin for another on Sui via the 7k aggregator (best route across Cetus/FlowX/Bluefin/DeepBook). Policy-checked → simulated → executed. Use for "swap 1 SUI to USDC", "trade X for Y".',
    searchHint: 'swap exchange trade convert dex aggregator best route sui usdc buy sell',
    schema: Schema,
    handler: async args => {
      if (ctx.network !== 'mainnet') return { ok: false, error: 'swap supports mainnet only' }
      try {
        const resolved = await resolveSwapCoins(ctx, args)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const { from, to, amountIn } = resolved

        // The slippage we'll actually enforce on the route: the caller's request
        // (or a tight 0.5% default). The policy check below BLOCKS it if it
        // exceeds the policy's max — so the cap is real, not a comparison of the
        // policy value against itself.
        const requestedSlippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS

        // Policy gate. The MIST per-tx cap is SUI-denominated, so it only bounds
        // SUI-input swaps; the slippage/protocol/expiry checks always apply.
        const blocked = policyBlock(ctx.policy, {
          kind: 'swap',
          coinType: from.type,
          amountMist: from.type === SUI_TYPE ? amountIn : 0n,
          toCoinType: to.type,
          protocol: 'swap',
          slippageBps: requestedSlippageBps,
        })
        if (blocked) return { ok: false, error: blocked }

        const me = ctx.agentAddress
        const ag = new MetaAg({ slippageBps: requestedSlippageBps })
        // Quote without the SDK's internal pre-simulation (it throws on routes it
        // can't simulate); we simulate the chosen route ourselves below.
        const quotes = (
          await ag.quote({
            coinTypeIn: from.type,
            coinTypeOut: to.type,
            amountIn: amountIn.toString(),
            signer: me,
          })
        )
          .filter(Boolean)
          .sort((a, b) => Number(b.amountOut ?? 0) - Number(a.amountOut ?? 0))
        if (quotes.length === 0) return { ok: false, error: 'no swap route found' }

        const picked = await pickCleanRoute(ctx, ag, quotes, resolved, args.to)
        if ('failures' in picked) {
          return { ok: false, error: `no route simulated cleanly — ${picked.failures.join(' | ')}` }
        }
        return await executePickedRoute(ctx, picked, args, to, requestedSlippageBps)
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
