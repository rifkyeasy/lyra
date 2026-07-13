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
import { simulateAndExecute } from '../execute'
import { checkMinimum } from '../minimums'
import { policyBlock, suiToMist } from '../policy'
import type { OnchainRuntimeContext } from '../types'
import { canFundFromVault } from '../vault-fund'

const SUI_TYPE = '0x2::sui::SUI'

const enc = (tx: Transaction, s: string) =>
  tx.pure.vector('u8', Array.from(new TextEncoder().encode(s)))

/**
 * Build the transfer PTB: `vault_transfer` (recipient-allowlist enforced on-chain)
 * when vault-backed, else a gas-coin split + optional `record_action` audit entry.
 * Returns the tx + whether it records on-chain.
 */
function buildSendTx(
  ctx: OnchainRuntimeContext,
  to: string,
  amountMist: bigint,
): { tx: Transaction; recordsOnChain: boolean } {
  const tx = new Transaction()
  const vaultBacked = canFundFromVault(ctx, amountMist)
  if (vaultBacked) {
    // Draw from the treasury via the full policy gate AND enforce the recipient
    // allowlist ON-CHAIN — a prompt-injected agent can't pay an un-allowlisted
    // address even within budget. The ActionReceipt is routed to the owner.
    tx.moveCall({
      target: `${ctx.packageId}::vault::vault_transfer`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.object(ctx.vaultId as string),
        tx.object(ctx.policyObjectId as string),
        tx.pure.u64(amountMist),
        tx.pure.address(to),
        enc(tx, 'send transfer'),
        tx.object.clock(),
      ],
    })
  } else {
    // Single-key mode (no vault): split from the agent's coin + transfer, plus an
    // on-chain receipt when a policy object is configured.
    const [coin] = tx.splitCoins(tx.gas, [amountMist])
    tx.transferObjects([coin], to)
    if (ctx.packageId && ctx.policyObjectId) {
      tx.moveCall({
        target: `${ctx.packageId}::policy::record_action`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(ctx.policyObjectId),
          tx.pure.u64(amountMist),
          tx.pure.address('0x0'),
          enc(tx, 'transfer'),
          enc(tx, `to ${to}`),
          tx.object.clock(),
        ],
      })
    }
  }
  return { tx, recordsOnChain: vaultBacked || Boolean(ctx.packageId && ctx.policyObjectId) }
}

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
        const tooSmall = checkMinimum('transfer', amountMist)
        if (tooSmall) return { ok: false, error: tooSmall }

        // 1. Policy gate (deterministic) — block before simulate/execute.
        const blocked = policyBlock(ctx.policy, {
          kind: 'transfer',
          coinType: SUI_TYPE,
          amountMist,
          to,
          protocol: 'transfer',
        })
        if (blocked) return { ok: false, error: blocked }

        // 2. Build the PTB (vault_transfer when vault-backed, else gas-coin split).
        const { tx, recordsOnChain } = buildSendTx(ctx, to, amountMist)

        // 3. Simulate-before-write, then execute + wait (shared helper).
        const exec = await simulateAndExecute(ctx, tx, { showObjectChanges: true })
        if (!exec.ok) return exec
        const receipt = exec.value.objectChanges?.find(
          c =>
            (c as { type?: string }).type === 'created' &&
            String((c as { objectType?: string }).objectType).endsWith('::receipt::ActionReceipt'),
        ) as { objectId?: string } | undefined

        return {
          ok: true,
          data: {
            digest: exec.value.digest,
            recipient: to,
            amountSui: args.amount,
            amountMist: amountMist.toString(),
            status: 'success',
            // Decision receipt: proof this write was policy-checked + simulated.
            simGasUsed: exec.value.gasUsed,
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
