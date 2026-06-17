/**
 * Protocol capability registry — Lyra's honest map of what it can DO vs only SEE.
 *
 * Discovery is broad (DefiLlama indexes every Sui protocol), but execution is
 * bounded to vetted adapters and the policy's protocol-allowlist. This registry
 * is the single source of truth for that boundary, so when a user finds a great
 * yield on a protocol Lyra has not integrated, Lyra says so honestly and offers
 * what it CAN do — it never fabricates a transaction for a protocol it cannot
 * actually reach.
 */

export type ProtocolCategory = 'clob' | 'dex' | 'aggregator' | 'lending' | 'staking' | 'storage'

export interface ProtocolCapability {
  id: string
  name: string
  category: ProtocolCategory
  /** Can Lyra read live data here (markets, prices, positions)? */
  read: boolean
  /** Can Lyra execute a state-changing action here (through the policy pipeline)? */
  execute: boolean
  /** Tool names that touch this protocol. */
  tools: string[]
  /** DefiLlama `project` slugs that map to this adapter (for executability tagging). */
  llamaProjects?: string[]
  note?: string
}

export const PROTOCOLS: ProtocolCapability[] = [
  {
    id: 'walrus',
    name: 'Walrus',
    category: 'storage',
    read: false,
    execute: true,
    tools: ['walrus.store'],
  },
  {
    id: 'deepbook',
    name: 'DeepBook',
    category: 'clob',
    read: true,
    execute: false,
    tools: ['deepbook.markets'],
    llamaProjects: ['deepbook'],
    note: 'market data read; on-chain order execution not wired yet',
  },
  {
    id: 'scallop',
    name: 'Scallop',
    category: 'lending',
    read: true,
    execute: true,
    tools: ['scallop.markets', 'scallop.position', 'scallop.supply', 'scallop.withdraw'],
    llamaProjects: ['scallop-lending', 'scallop'],
  },
  {
    id: 'navi',
    name: 'NAVI',
    category: 'lending',
    read: true,
    execute: true,
    tools: ['navi.markets', 'navi.position', 'navi.supply', 'navi.withdraw'],
    llamaProjects: ['navi-lending', 'navi-protocol', 'navi'],
    note: 'largest Sui lending market by TVL',
  },
  {
    id: 'cetus',
    name: 'Cetus (aggregator)',
    category: 'aggregator',
    read: true,
    execute: false,
    tools: ['cetus.quote'],
    llamaProjects: ['cetus-amm', 'cetus-clmm', 'cetus'],
    note: 'aggregated quote across many DEXes; swap execution deferred (SDK v2 vs stack v1)',
  },
]

const PROJECT_INDEX: Record<string, ProtocolCapability> = (() => {
  const idx: Record<string, ProtocolCapability> = {}
  for (const p of PROTOCOLS) for (const slug of p.llamaProjects ?? []) idx[slug] = p
  return idx
})()

/** Map a DefiLlama `project` slug to an integrated adapter, if any. */
export function adapterForProject(project: string): ProtocolCapability | null {
  const key = project.trim().toLowerCase()
  if (PROJECT_INDEX[key]) return PROJECT_INDEX[key]
  // Loose contains-match: e.g. "scallop-lending" / "navi-lending".
  for (const p of PROTOCOLS) {
    if ((p.llamaProjects ?? []).some(s => key.includes(s) || s.includes(key))) return p
  }
  return null
}

/** Protocols Lyra can actually execute a state-changing action on. */
export function executableProtocols(): ProtocolCapability[] {
  return PROTOCOLS.filter(p => p.execute)
}
