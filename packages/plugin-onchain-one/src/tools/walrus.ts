/**
 * `walrus.store` — write a durable, verifiable artifact (receipt, report,
 * memory snapshot) to Walrus and return its blobId.
 *
 * This is what makes a short-lived action auditable across sessions: the agent
 * stores receipts and analysis on Walrus, and on-chain ActionReceipts can
 * reference the blob. Storing costs WAL from the agent address.
 */

import { WalrusClient } from '@mysten/walrus'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import type { OnchainRuntimeContext } from '../types'

const Schema = z.object({
  content: z.string().min(1).describe('The text/JSON artifact to store durably.'),
  epochs: z
    .number()
    .int()
    .min(1)
    .max(53)
    .optional()
    .describe('Storage duration in Walrus epochs. Default 3.'),
})
type Args = z.infer<typeof Schema>

export function makeWalrusStore(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'walrus.store',
    description:
      'Store a durable, verifiable artifact (receipt, report, or memory) on Walrus. Returns a blobId you can cite later. Use to persist agent memory or an execution receipt across sessions.',
    searchHint: 'walrus store blob save receipt memory durable artifact persist record',
    schema: Schema,
    handler: async args => {
      try {
        const walrus = new WalrusClient({
          network: ctx.walrusNetwork ?? ctx.network,
          // cast: @mysten/walrus bundles a different @mysten/sui minor; runtime-
          // compatible (verified: real mainnet blob written) but not type-identical.
          suiClient: ctx.client as never,
        })
        const blob = new TextEncoder().encode(args.content)
        const result = await walrus.writeBlob({
          blob,
          deletable: false,
          epochs: args.epochs ?? 3,
          signer: ctx.keypair as never,
        })
        return {
          ok: true,
          data: {
            blobId: result.blobId,
            bytes: blob.length,
            epochs: args.epochs ?? 3,
            network: ctx.walrusNetwork ?? ctx.network,
          },
        }
      } catch (e) {
        return {
          ok: false,
          error: `walrus store failed (needs WAL for storage): ${(e as Error).message.slice(0, 200)}`,
        }
      }
    },
  }
}
