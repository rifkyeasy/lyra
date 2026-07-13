/**
 * bridge.routes — quote CCTP routes to bring **native USDC** from an EVM chain
 * into the Sui vault. Read-only: returns fee, ETA, and estimated USDC received.
 *
 * Uses the @mysten/sui v2 Wormhole SDK (isolated in this package). Execution
 * (source-chain burn → attestation → Sui redeem + vault::deposit) is a follow-up;
 * see DESIGN.md. The source-chain burn is always signed by the USER's own wallet.
 * (Solana/SVM sources are phase 2 — add the solana platform loader then.)
 */
// NOTE: `routes` comes from the main barrel (deprecated but intentional). The
// standalone `@wormhole-foundation/sdk-connect/routes` resolves to a DIFFERENT
// sdk-connect instance than the one `wormhole()`/`Wormhole` use (the meta package
// bundles its own nested copy), so a RouteTransferRequest built here wouldn't be
// assignable there. Using the barrel keeps a single, type-consistent instance.
import { Wormhole, amount, routes, wormhole } from '@wormhole-foundation/sdk'
import { circle } from '@wormhole-foundation/sdk-base'
import evm from '@wormhole-foundation/sdk/evm'
import sui from '@wormhole-foundation/sdk/sui'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'

const SOURCE_CHAINS = ['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'Avalanche'] as const

const Schema = z.object({
  from: z.enum(SOURCE_CHAINS).describe('Source EVM chain to bridge native USDC from.'),
  amount: z.string().min(1).describe('USDC amount to bridge, e.g. "10".'),
})
type Args = z.infer<typeof Schema>

// Minimal read-only shapes for the SDK's route/quote objects (their full generics
// aren't needed here — we only read a few fields).
interface RouteQuote {
  success: boolean
  error?: { message?: string }
  destinationToken?: { amount?: amount.Amount }
  eta?: number
}
interface ResolvedRoute {
  getDefaultOptions?: () => unknown
  validate: (
    tr: unknown,
    params: { amount: string; options?: unknown },
  ) => Promise<{ valid: boolean; error?: { message?: string }; params?: unknown }>
  quote: (tr: unknown, params: unknown) => Promise<RouteQuote>
}

/** Resolve + validate + quote the best CCTP route USDC(source) → USDC(Sui). Throws on any failure. */
async function quoteCctpToSui(
  from: (typeof SOURCE_CHAINS)[number],
  amt: string,
): Promise<RouteQuote> {
  const srcAddr = circle.usdcContract.get('Mainnet', from)
  const dstAddr = circle.usdcContract.get('Mainnet', 'Sui')
  if (!srcAddr) throw new Error(`no native USDC on ${from}`)
  if (!dstAddr) throw new Error('no native USDC on Sui')

  const wh = await wormhole('Mainnet', [evm, sui])
  const tr = await routes.RouteTransferRequest.create(wh, {
    source: Wormhole.tokenId(from, srcAddr),
    destination: Wormhole.tokenId('Sui', dstAddr),
  })
  const found = await wh.resolver([routes.AutomaticCCTPRoute, routes.CCTPRoute]).findRoutes(tr)
  const route = found[0] as unknown as ResolvedRoute | undefined
  if (!route) throw new Error(`no CCTP route from ${from} to Sui`)

  const validated = await route.validate(tr, { amount: amt, options: route.getDefaultOptions?.() })
  if (!validated.valid) throw new Error(`route invalid: ${validated.error?.message ?? 'unknown'}`)
  const quote = await route.quote(tr, validated.params)
  if (!quote.success) throw new Error(`quote failed: ${quote.error?.message ?? 'unknown'}`)
  return quote
}

export function makeBridgeRoutes(): ToolDef<Args> {
  return {
    name: 'bridge.routes',
    description:
      'Quote CCTP routes to bridge native USDC from an EVM chain into the Sui vault. Read-only: fee, ETA, estimated USDC received. Does not execute (the user signs the source-chain burn).',
    searchHint: 'bridge cross-chain cctp usdc deposit evm sui quote route fee',
    schema: Schema,
    handler: async (args): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
      try {
        const quote = await quoteCctpToSui(args.from, args.amount)
        const recv = quote.destinationToken?.amount
        return {
          ok: true,
          data: {
            from: args.from,
            to: 'Sui',
            amountIn: `${args.amount} USDC`,
            estReceived: recv ? `${amount.display(recv)} USDC` : 'see quote',
            route: 'CCTP',
            etaMs: quote.eta ?? null,
            note: 'native USDC via CCTP — user signs the burn on the source chain',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
