/**
 * bridge.deposit / bridge.status — the agent-facing surface over the deposit spine.
 *
 * `bridge.deposit` validates a request (via {@link validateDepositRequest}) and
 * OPENS a tracked deposit in the store; the user then signs the source-chain burn
 * and a poller (the driver) carries it to the vault. `bridge.status` reports an
 * owner's deposits. Both are bound to a single `owner` (you can only deposit into
 * your OWN vault) and take a `DepositStore` by injection, so they're storage-
 * agnostic + unit-testable; the integration point wires a durable store + the
 * chain executors. `bridge.complete`/`bridge.withdraw` (which need the live
 * executors) are a follow-up — see DESIGN.md.
 */

import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { validateDepositRequest } from './deposit-intent'
import { nextAction } from './deposit-lifecycle'
import type { DepositStore } from './deposit-store'

type ToolOut = { ok: boolean; data?: unknown; error?: string }

const DepositSchema = z.object({
  from: z.string().describe('Source chain to deposit from, e.g. "Ethereum", "Base", "Arbitrum".'),
  token: z.string().describe('Source-chain token symbol. "USDC" takes the native CCTP route.'),
  amount: z.string().min(1).describe('Amount to deposit, e.g. "50".'),
})
type DepositArgs = z.infer<typeof DepositSchema>

/** `bridge.deposit`, bound to `owner`'s vault, backed by `store`. `newId` is
 *  injectable for deterministic tests (defaults to a random uuid). */
export function makeBridgeDeposit(
  store: DepositStore,
  owner: string,
  newId: () => string = () => crypto.randomUUID(),
): ToolDef<DepositArgs> {
  return {
    name: 'bridge.deposit',
    description:
      'Open a cross-chain deposit of a token from another chain into your Sui USDC vault. Validates + tracks it; you sign the source-chain burn, then it bridges (via CCTP for USDC) and lands as USDC in your vault. Poll bridge.status for progress.',
    searchHint: 'bridge deposit cross-chain cctp usdc from evm solana into sui vault',
    schema: DepositSchema,
    handler: async (args): Promise<ToolOut> => {
      const res = validateDepositRequest({
        id: newId(),
        owner,
        sourceChain: args.from,
        sourceToken: args.token,
        amount: args.amount,
      })
      if (!res.ok) return { ok: false, error: res.error }
      const d = store.create(res.deposit)
      return {
        ok: true,
        data: {
          depositId: d.id,
          status: d.status,
          route: d.needsSwap ? 'bridge + Sui swap → USDC' : 'CCTP (native USDC)',
          nextStep: nextAction(d.status, d.needsSwap),
          note: 'sign the source-chain burn to proceed; track with bridge.status',
        },
      }
    },
  }
}

const StatusSchema = z.object({
  depositId: z.string().optional().describe('A specific deposit id, or omit to list all yours.'),
})
type StatusArgs = z.infer<typeof StatusSchema>

/** `bridge.status`, bound to `owner`, backed by `store`. */
export function makeBridgeStatus(store: DepositStore, owner: string): ToolDef<StatusArgs> {
  return {
    name: 'bridge.status',
    description: 'List your cross-chain deposits and their current status (or one by id).',
    searchHint: 'bridge status deposit pending complete track transfer progress',
    schema: StatusSchema,
    handler: async (args): Promise<ToolOut> => {
      const owned = store.listByOwner(owner)
      const list = args.depositId ? owned.filter(d => d.id === args.depositId) : owned
      return {
        ok: true,
        data: {
          deposits: list.map(d => ({
            id: d.id,
            status: d.status,
            sourceChain: d.sourceChain,
            sourceToken: d.sourceToken,
            amount: d.amount,
            nextStep: nextAction(d.status, d.needsSwap),
            error: d.error ?? null,
          })),
        },
      }
    },
  }
}
