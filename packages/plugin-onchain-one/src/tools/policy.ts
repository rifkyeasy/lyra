/**
 * Policy tools: `policy.show` (legible control layer) and `policy.create`
 * (mint an on-chain `lyra::policy::AgentPolicy`).
 *
 * The control layer is only trustworthy if it is legible and enforceable.
 * `policy.show` reports the active off-chain caps; `policy.create` publishes a
 * shared AgentPolicy on Sui so the same budget/per-tx/expiry are enforced in
 * Move and every action mints an auditable receipt.
 */

import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { submit } from '../execute'
import { type SuiPolicy, suiToMist } from '../policy'
import type { OnchainRuntimeContext } from '../types'
import { fmtSui } from './balance'

// --- policy.show -----------------------------------------------------------

const ShowSchema = z.object({})
type ShowArgs = z.infer<typeof ShowSchema>

/** Human-readable one-line-each summary of the caps an active policy enforces. */
function policySummaryLines(
  p: SuiPolicy,
  readOnly: boolean,
  maxPerTx: string | null,
  autoUpTo: string | null,
): string[] {
  const lines: string[] = []
  if (readOnly) lines.push('READ-ONLY: all writes are blocked.')
  if (maxPerTx) lines.push(`Hard cap: sends over ${maxPerTx} are blocked.`)
  if (autoUpTo) lines.push(`Auto-execute up to ${autoUpTo}; above that requires approval.`)
  if (p.maxSlippageBps !== undefined)
    lines.push(`Swaps over ${p.maxSlippageBps} bps slippage are blocked.`)
  if (p.coinAllowlist?.length)
    lines.push(`Only ${p.coinAllowlist.length} allowlisted coin type(s) may be moved.`)
  if (p.protocolAllowlist?.length) lines.push(`Only protocols: ${p.protocolAllowlist.join(', ')}.`)
  if (p.recipientAllowlist?.length)
    lines.push(`Transfers only to ${p.recipientAllowlist.length} allowlisted recipient(s).`)
  if (p.expiryMs !== undefined) lines.push(`Policy expires ${new Date(p.expiryMs).toISOString()}.`)
  if (p.autonomy === 'confirm') lines.push('Autonomy=confirm: every write needs approval.')
  return lines
}

/** Shape the read-model reported by `policy.show` for an active (armed) policy. */
function describeActivePolicy(
  p: SuiPolicy,
  policyPackage: string | null,
  policyObject: string | null,
): Record<string, unknown> {
  const readOnly = p.readOnly === true || p.autonomy === 'readonly'
  const maxPerTx = p.maxMistPerTx === undefined ? null : `${fmtSui(p.maxMistPerTx)} SUI`
  const autoUpTo = p.autoMaxMistPerTx === undefined ? null : `${fmtSui(p.autoMaxMistPerTx)} SUI`
  const lines = policySummaryLines(p, readOnly, maxPerTx, autoUpTo)
  return {
    enforced: true,
    readOnly,
    autonomy: p.autonomy ?? 'auto',
    maxPerTx,
    autoApproveUpTo: autoUpTo,
    maxSlippageBps: p.maxSlippageBps ?? null,
    coinAllowlist: p.coinAllowlist ?? null,
    protocolAllowlist: p.protocolAllowlist ?? null,
    recipientAllowlist: p.recipientAllowlist ?? null,
    expiry: p.expiryMs ? new Date(p.expiryMs).toISOString() : null,
    policyPackage,
    policyObject,
    summary: lines.length > 0 ? lines.join(' ') : 'Policy armed but with no specific caps set.',
  }
}

export function makePolicyShow(ctx: OnchainRuntimeContext): ToolDef<ShowArgs> {
  return {
    name: 'policy.show',
    description:
      'Show the active deterministic fund-control policy: per-tx cap, auto-approve ceiling, autonomy tier, coin/protocol allowlists, slippage cap, and expiry. Read-only. Call for "what are my limits", "what can you spend", or before explaining why an action was blocked.',
    searchHint:
      'policy limits caps allowlist autonomy approval guardrails rules what can you spend',
    schema: ShowSchema,
    handler: async () => {
      const p = ctx.policy
      if (!p) {
        return {
          ok: true,
          data: {
            enforced: false,
            policyPackage: ctx.packageId ?? null,
            note: 'No LYRA_POLICY_* configured — no in-code caps this session. Value-moving actions still go through simulation and the session permission mode.',
          },
        }
      }
      return {
        ok: true,
        data: describeActivePolicy(p, ctx.packageId ?? null, ctx.policyObjectId ?? null),
      }
    },
  }
}

// --- policy.create ---------------------------------------------------------

const CreateSchema = z.object({
  budgetSui: z.string().min(1).describe('Lifetime spend ceiling in SUI, e.g. "10".'),
  maxPerTxSui: z.string().min(1).describe('Hard per-action cap in SUI, e.g. "1".'),
  maxSlippageBps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Reference slippage cap (bps). Default 100.'),
  expiryMinutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Minutes until the policy expires. 0 / omit = never.'),
})
type CreateArgs = z.infer<typeof CreateSchema>

/** Build the `create_policy` PTB from the parsed budget/cap/expiry inputs. */
function buildCreatePolicyTx(
  ctx: OnchainRuntimeContext,
  budget: bigint,
  maxPerTx: bigint,
  expiryMs: number,
  maxSlippageBps?: number,
): Transaction {
  // Rolling blast-radius window: default 1h, allowing ~10 max-per-tx actions
  // per window (never above the lifetime budget). Bounds a single burst.
  const windowMs = 3_600_000n
  const windowBudget = maxPerTx * 10n < budget ? maxPerTx * 10n : budget
  const tx = new Transaction()
  tx.moveCall({
    target: `${ctx.packageId}::policy::create_policy`,
    arguments: [
      tx.pure.address(ctx.agentAddress),
      tx.pure.u64(budget),
      tx.pure.u64(maxPerTx),
      tx.pure.u64(windowMs),
      tx.pure.u64(windowBudget),
      tx.pure.u64(BigInt(maxSlippageBps ?? 100)),
      // allowed_coins: vector<vector<u8>> — empty = any coin (off-chain policy still applies).
      tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize([])),
      // allowed_protocols: vector<address> — empty = any protocol.
      tx.pure(bcs.vector(bcs.Address).serialize([])),
      tx.pure.u64(BigInt(expiryMs)),
      tx.object.clock(),
    ],
  })
  return tx
}

/** Pick the newly-created AgentPolicy + PolicyOwnerCap ids out of objectChanges. */
function extractPolicyObjects(objectChanges: unknown[]): {
  policyObject: string | null
  ownerCap: string | null
} {
  const created = objectChanges.filter(c => (c as { type?: string }).type === 'created') as {
    objectId: string
    objectType?: string
  }[]
  const policyObj = created.find(c => String(c.objectType).endsWith('::policy::AgentPolicy'))
  const ownerCap = created.find(c => String(c.objectType).endsWith('::policy::PolicyOwnerCap'))
  return { policyObject: policyObj?.objectId ?? null, ownerCap: ownerCap?.objectId ?? null }
}

/** Execute the create-policy PTB, wait for indexing, and pull out the new ids. */
async function runCreatePolicy(
  ctx: OnchainRuntimeContext,
  tx: Transaction,
): Promise<
  | { digest: string; policyObject: string | null; ownerCap: string | null }
  | {
      error: string
    }
> {
  const res = await submit(ctx, tx, { showEffects: true, showObjectChanges: true })
  if (res.effects?.status?.status !== 'success') {
    return { error: `execution failed: ${res.effects?.status?.error ?? 'unknown'}` }
  }
  // Wait for indexing so the new shared policy object is queryable before the
  // next action references it (avoids a notExists race on sui.send).
  await ctx.client.waitForTransaction({ digest: res.digest })
  return { digest: res.digest, ...extractPolicyObjects(res.objectChanges ?? []) }
}

export function makePolicyCreate(ctx: OnchainRuntimeContext): ToolDef<CreateArgs> {
  return {
    name: 'policy.create',
    description:
      'Publish a shared on-chain lyra::policy::AgentPolicy bounding this agent: a lifetime budget, a per-tx cap, slippage, and an expiry. Enforced in Move on every subsequent action. Returns the policy object id + owner cap.',
    searchHint: 'create policy on-chain agentpolicy budget cap expiry mint publish guardrail',
    schema: CreateSchema,
    handler: async args => {
      try {
        if (!ctx.packageId)
          return { ok: false, error: 'no lyra::policy package configured (LYRA_PACKAGE_ID)' }
        const budget = suiToMist(args.budgetSui)
        const maxPerTx = suiToMist(args.maxPerTxSui)
        if (budget === undefined || maxPerTx === undefined) {
          return { ok: false, error: 'invalid budget or per-tx amount' }
        }
        const expiryMs = args.expiryMinutes ? Date.now() + args.expiryMinutes * 60_000 : 0
        const tx = buildCreatePolicyTx(ctx, budget, maxPerTx, expiryMs, args.maxSlippageBps)
        const result = await runCreatePolicy(ctx, tx)
        if ('error' in result) return { ok: false, error: result.error }
        // Wire subsequent writes to record against this policy on-chain.
        if (result.policyObject) ctx.policyObjectId = result.policyObject

        return {
          ok: true,
          data: {
            digest: result.digest,
            policyObject: result.policyObject,
            ownerCap: result.ownerCap,
            budgetSui: args.budgetSui,
            maxPerTxSui: args.maxPerTxSui,
            expiry: expiryMs ? new Date(expiryMs).toISOString() : 'never',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
