// Resolve an owner's on-chain setup: their AgentPolicy + treasury Vault. The
// binding lives on-chain (owner holds the PolicyOwnerCap → policy → vault), so
// any surface can resolve "this owner's agent + vault" without a database. Used
// by the web execution path to source the agent's funds from the owner's vault.
import 'server-only'

import { deriveAgentAddress } from '@/lib/agent-derive'
import { CLOCK, LYRA_PKG, ORIGINAL_PKG, SUI_TYPE, VAULT_PKG } from '@/lib/onchain-constants'
import { webSuiClient } from '@/lib/ops'

// LATEST package id (env override wins), re-exported for the execution path.
export const PKG = process.env.LYRA_PACKAGE_ID ?? LYRA_PKG
export { SUI_TYPE, CLOCK, ORIGINAL_PKG, VAULT_PKG }

const sui = webSuiClient()

export interface OwnerVault {
  policyId: string
  vaultId: string
  /** The owner's PolicyOwnerCap object id (for withdraw / revoke). */
  capId: string
  agent: string
  /** SUI balance held in the vault (treasury), in MIST. */
  vaultMist: string
  /** Allowed transfer recipients; null = open (any), [] = locked to none. */
  allowedRecipients: string[] | null
}

/** Read the policy's recipient allowlist (dynamic field). null = no allowlist set. */
export async function readAllowedRecipients(policyId: string): Promise<string[] | null> {
  try {
    const o = await sui.getDynamicFieldObject({
      parentId: policyId,
      name: { type: 'vector<u8>', value: Array.from(new TextEncoder().encode('lyra.recipients')) },
    })
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Move object fields
    const v = (o.data?.content as any)?.fields?.value
    return Array.isArray(v) ? (v as string[]) : null
  } catch {
    return null
  }
}

/**
 * Find the owner's policy (delegating to their derived agent) + the SUI vault
 * bound to it. Returns null when the owner hasn't provisioned yet.
 */
export async function resolveOwnerVault(owner: string): Promise<OwnerVault | null> {
  const agent = deriveAgentAddress(owner)
  const caps = await sui
    .getOwnedObjects({
      owner,
      filter: { StructType: `${ORIGINAL_PKG}::policy::PolicyOwnerCap` },
      options: { showContent: true },
    })
    .catch(() => null)
  if (!caps) return null

  for (const c of caps.data) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Move object fields
    const policyId = (c.data?.content as any)?.fields?.policy_id as string | undefined
    if (!policyId) continue
    const pol = await sui.getObject({ id: policyId, options: { showContent: true } }).catch(() => null)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Move object fields
    const pf = (pol?.data?.content as any)?.fields
    if (!pf || pf.agent !== agent || pf.revoked) continue
    const vaultId = await findVaultForPolicy(policyId)
    if (!vaultId) continue
    const v = await sui.getObject({ id: vaultId, options: { showContent: true } }).catch(() => null)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Move object fields
    const vaultMist = (v?.data?.content as any)?.fields?.balance ?? '0'
    const capId = c.data?.objectId
    if (!capId) continue
    const allowedRecipients = await readAllowedRecipients(policyId)
    return { policyId, vaultId, capId, agent, vaultMist: String(vaultMist), allowedRecipients }
  }
  return null
}

/** Locate the SUI vault bound to `policyId` via its `VaultOpened` event. */
async function findVaultForPolicy(policyId: string): Promise<string | null> {
  const ev = await sui
    .queryEvents({
      query: { MoveEventType: `${VAULT_PKG}::vault::VaultOpened` },
      limit: 100,
      order: 'descending',
    })
    .catch(() => null)
  if (!ev) return null
  for (const e of ev.data) {
    // biome-ignore lint/suspicious/noExplicitAny: parsed Move event
    const f = e.parsedJson as any
    if (f?.policy_id === policyId) return f?.vault_id ?? null
  }
  return null
}
