/**
 * Resolve an owner's on-chain setup: their `AgentPolicy` (delegating to their
 * derived agent) + the treasury `Vault` bound to it. The binding lives on-chain
 * (owner holds the `PolicyOwnerCap` → policy → vault), so any surface resolves
 * "this owner's agent + vault" without a database. Mirrors
 * `apps/web/lib/vault.ts`.
 */

import { type SuiNetwork, makeSuiClient } from './client'
import { deriveAgentAddress } from './derive'

// A module keeps its DEFINING package id for types/events: `policy` shipped in
// the original publish; `vault` was added in the first upgrade.
const ORIGINAL_PKG = '0x250880a4c1a268da8011b164f599d4e100cefce84f862d36396cd1a943ee8a35'
const VAULT_PKG = '0xa40689cc541f57af123e90819e73eab8a551e4385ab91bee89d02f6691590211'

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
