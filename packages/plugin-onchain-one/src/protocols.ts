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
    id: 'walrus-staking',
    name: 'Walrus staking',
    category: 'staking',
    read: true,
    execute: true,
    tools: ['walrus.stake', 'walrus.unstake', 'walrus.staking'],
    note: 'stake WAL to a Walrus storage node to earn rewards + secure decentralized storage (min 1 WAL)',
  },
  {
    id: 'deepbook',
    name: 'DeepBook',
    category: 'clob',
    read: true,
    execute: false,
    tools: ['deepbook.markets'],
    llamaProjects: ['deepbook'],
    note: 'market data read; swaps route through DeepBook via the 7k aggregator',
  },
  {
    id: 'scallop',
    name: 'Scallop',
    category: 'lending',
    read: true,
    execute: true,
    tools: ['scallop.markets', 'scallop.position', 'scallop.supply', 'scallop.withdraw'],
    llamaProjects: ['scallop-lending', 'scallop'],
    note: 'supply / withdraw lending yield (borrow/repay via NAVI or Suilend)',
  },
  {
    id: 'navi',
    name: 'NAVI',
    category: 'lending',
    read: true,
    execute: true,
    tools: [
      'navi.markets',
      'navi.position',
      'navi.supply',
      'navi.withdraw',
      'navi.borrow',
      'navi.repay',
    ],
    llamaProjects: ['navi-lending', 'navi-protocol', 'navi'],
    note: 'largest Sui lending market by TVL; full supply / withdraw / borrow / repay',
  },
  {
    id: 'suilend',
    name: 'Suilend',
    category: 'lending',
    read: true,
    execute: true,
    tools: [
      'suilend.position',
      'suilend.supply',
      'suilend.withdraw',
      'suilend.borrow',
      'suilend.repay',
    ],
    llamaProjects: ['suilend'],
    note: 'MAIN_POOL market; full supply / withdraw / borrow / repay',
  },
  {
    id: 'native-staking',
    name: 'Sui Native Staking',
    category: 'staking',
    read: false,
    execute: true,
    tools: ['sui.stake', 'sui.unstake'],
    note: 'delegate SUI to a validator (min 1 SUI); classic staking rewards',
  },
  {
    id: 'volo',
    name: 'Volo (Liquid Staking)',
    category: 'staking',
    read: false,
    execute: true,
    tools: ['volo.stake', 'volo.unstake'],
    llamaProjects: ['volo', 'volo-staked-sui'],
    note: 'stake SUI → vSUI, a liquid staking token usable across DeFi while earning',
  },
  {
    id: 'aggregator',
    name: 'DEX aggregator (7k best-route)',
    category: 'aggregator',
    read: true,
    execute: true,
    tools: ['swap', 'cetus.quote'],
    llamaProjects: [
      'cetus-amm',
      'cetus-clmm',
      'cetus',
      'flowx-finance',
      'flowx-v3',
      'bluefin-spot',
      'bluefin',
      'turbos',
      'kriya-dex',
      'aftermath-amm',
      'aftermath',
      'momentum',
      'mmt',
    ],
    note: 'swap executes via the 7k aggregator, routing best price across Cetus / Turbos / FlowX / Bluefin / Aftermath / Momentum / Kriya / DeepBook',
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
