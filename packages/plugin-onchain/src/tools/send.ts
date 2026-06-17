/**
 * `sui.send` — transfer SUI through the full guarded pipeline:
 *   policy → simulate → execute → on-chain lyra::policy receipt.
 *
 * The deterministic policy is checked in code BEFORE anything is built. When a
 * shared AgentPolicy object is configured, the PTB also calls
 * `lyra::policy::record_action`, so the SAME on-chain limits are re-enforced in
 * Move and an ActionReceipt is minted atomically with the transfer.
 */

import { Transaction } from '@mysten/sui/transactions'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { evaluatePolicy, suiToMist } from '../policy'
import { simulate } from '../simulate'
import type { OnchainRuntimeContext } from '../types'

const SUI_TYPE = '0x2::sui::SUI'

const Schema = z.object({
  to: z.string().min(3).describe('Recipient Sui address (0x...).'),
  amount: z.string().min(1).describe('Amount in SUI, e.g. "0.05".'),
})
type Args = z.infer<typeof Schema>

export function makeSuiSend(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'sui.send',
    description:
      'Transfer SUI from the agent to a recipient. Deterministically policy-checked, dry-run simulated, then executed; mints an on-chain lyra::policy ActionReceipt when a policy object is configured.',
    searchHint: 'send transfer sui pay native move funds remit',
    schema: Schema,
    handler: async args => {
      try {
        const to = args.to.trim()
        if (!to.startsWith('0x')) {
          return { ok: false, error: `invalid recipient "${to}": expected a 0x Sui address` }
        }
        const amountMist = suiToMist(args.amount)
        if (amountMist === undefined || amountMist <= 0n) {
          return { ok: false, error: `invalid amount "${args.amount}"` }
        }

        // 1. Policy gate (deterministic) — block before simulate/execute.
        if (ctx.policy) {
          const verdict = evaluatePolicy(
            { kind: 'transfer', coinType: SUI_TYPE, amountMist, to, protocol: 'transfer' },
            ctx.policy,
          )
          if (!verdict.allowed) {
            return { ok: false, error: `policy blocked: ${verdict.violations.join('; ')}` }
          }
        }

        // 2. Build the PTB: split + transfer, plus on-chain receipt/enforcement.
        const tx = new Transaction()
        const [coin] = tx.splitCoins(tx.gas, [amountMist])
        tx.transferObjects([coin], to)
        const recordsOnChain = Boolean(ctx.packageId && ctx.policyObjectId)
        if (recordsOnChain) {
          tx.moveCall({
            target: `${ctx.packageId}::policy::record_action`,
            typeArguments: [SUI_TYPE],
            arguments: [
              tx.object(ctx.policyObjectId as string),
              tx.pure.u64(amountMist),
              tx.pure.address('0x0'),
              tx.pure.vector('u8', Array.from(new TextEncoder().encode('transfer'))),
              tx.pure.vector('u8', Array.from(new TextEncoder().encode(`to ${to}`))),
              tx.object.clock(),
            ],
          })
        }

        // 3. Simulate-before-write.
        const sim = await simulate(ctx.client, tx, ctx.agentAddress)
        if (!sim.ok) {
          return { ok: false, error: `pre-flight simulation failed: ${sim.reason}` }
        }

        // 4. Execute.
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
        const receipt = res.objectChanges?.find(
          c =>
            c.type === 'created' &&
            String((c as { objectType?: string }).objectType).endsWith('::policy::ActionReceipt'),
        ) as { objectId?: string } | undefined

        return {
          ok: true,
          data: {
            digest: res.digest,
            recipient: to,
            amountSui: args.amount,
            amountMist: amountMist.toString(),
            status: 'success',
            // Decision receipt: proof this write was policy-checked + simulated.
            simGasUsed: sim.gasUsed,
            policyEnforced: ctx.policy != null,
            onchainReceipt: recordsOnChain,
            receiptId: receipt?.objectId ?? null,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
