/**
 * Resolve an owner's on-chain setup: their `AgentPolicy` (delegating to their
 * derived agent) + the treasury `Vault` bound to it. The binding lives on-chain
 * (owner holds the `PolicyOwnerCap` → policy → vault), so any surface resolves
 * "this owner's agent + vault" without a database. Mirrors
 * `apps/web/lib/vault.ts`.
 */

import { type SuiNetwork, makeSuiClient } from './client'
import { deriveAgentAddress } from './derive'

// Types/events are addressed by the id of the package that DEFINES them. The v1
// package is a single fresh publish (policy, vault, receipt, allowlist, constants
// all shipped together), so every module shares one id today. These stay separate
// constants so a FUTURE upgrade can again split the LATEST (moveCall) id from a
// module's DEFINING id without touching call sites.
const ORIGINAL_PKG = '0x1925bced9aeb16ca8159be0a10d39a0778fe618404443a4b6149116ad9997617'
const VAULT_PKG = '0x1925bced9aeb16ca8159be0a10d39a0778fe618404443a4b6149116ad9997617'

export interface OwnerVault {
  policyId: string
  vaultId: string
  capId: string
  agent: string
  vaultMist: string
}

export interface AgentVault {
  policyId: string
  vaultId: string
  owner: string
  vaultMist: string
}

/**
 * Resolve the treasury vault for a delegated `agentAddress` WITHOUT knowing the
 * owner — the CLI/gateway single-tenant path (the running agent knows only its own
 * address). Finds the `AgentPolicy` delegating to this agent via `PolicyCreated`
 * events, then its `Vault` via `VaultOpened`. Returns null when the agent has no
 * (unrevoked) policy+vault, so the tools fall back to the agent's own SUI.
 */
export async function resolveVaultForAgent(
  agentAddress: string,
  network: SuiNetwork = 'mainnet',
): Promise<AgentVault | null> {
  const client = makeSuiClient(network)
  const created = await client
    .queryEvents({
      query: { MoveEventType: `${ORIGINAL_PKG}::policy::PolicyCreated` },
      limit: 200,
      order: 'descending',
    })
    .catch(() => null)
  if (!created) return null

  for (const e of created.data) {
    // biome-ignore lint/suspicious/noExplicitAny: parsed Move event
    const f = e.parsedJson as any
    if (f?.agent !== agentAddress) continue
    const policyId = f.policy_id as string | undefined
    const owner = f.owner as string | undefined
    if (!policyId || !owner) continue
    const pol = await client
      .getObject({ id: policyId, options: { showContent: true } })
      .catch(() => null)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Move object fields
    const pf = (pol?.data?.content as any)?.fields
    if (!pf || pf.revoked) continue

    const ev = await client
      .queryEvents({
        query: { MoveEventType: `${VAULT_PKG}::vault::VaultOpened` },
        limit: 200,
        order: 'descending',
      })
      .catch(() => null)
    // biome-ignore lint/suspicious/noExplicitAny: parsed Move event
    const match = ev?.data.find(x => (x.parsedJson as any)?.policy_id === policyId)
    // biome-ignore lint/suspicious/noExplicitAny: parsed Move event
    const vaultId = (match?.parsedJson as any)?.vault_id as string | undefined
    if (!vaultId) continue
    const v = await client
      .getObject({ id: vaultId, options: { showContent: true } })
      .catch(() => null)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Move object fields
    const vaultMist = String((v?.data?.content as any)?.fields?.balance ?? '0')
    return { policyId, vaultId, owner, vaultMist }
  }
  return null
}

/** Find the owner's policy (delegating to their derived agent) + its SUI vault. */
export async function resolveOwnerVault(
  owner: string,
  network: SuiNetwork = 'mainnet',
  masterSecret?: string,
): Promise<OwnerVault | null> {
  const client = makeSuiClient(network)
  const agent = deriveAgentAddress(owner, masterSecret)
  const caps = await client
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
    const pol = await client
      .getObject({ id: policyId, options: { showContent: true } })
      .catch(() => null)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Move object fields
    const pf = (pol?.data?.content as any)?.fields
    if (!pf || pf.agent !== agent || pf.revoked) continue

    const ev = await client
      .queryEvents({
        query: { MoveEventType: `${VAULT_PKG}::vault::VaultOpened` },
        limit: 100,
        order: 'descending',
      })
      .catch(() => null)
    // biome-ignore lint/suspicious/noExplicitAny: parsed Move event
    const match = ev?.data.find(e => (e.parsedJson as any)?.policy_id === policyId)
    // biome-ignore lint/suspicious/noExplicitAny: parsed Move event
    const vaultId = (match?.parsedJson as any)?.vault_id as string | undefined
    if (!vaultId) continue

    const v = await client
      .getObject({ id: vaultId, options: { showContent: true } })
      .catch(() => null)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Move object fields
    const vaultMist = String((v?.data?.content as any)?.fields?.balance ?? '0')
    const capId = c.data?.objectId
    if (!capId) continue
    return { policyId, vaultId, capId, agent, vaultMist }
  }
  return null
}
