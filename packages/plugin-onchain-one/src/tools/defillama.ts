/**
 * `defi.yields` — read-only yield discovery across Sui DeFi via DefiLlama.
 *
 * Discovery only: it never moves funds. It gives the agent market context — the
 * best APYs on Sui, with TVL, stablecoin, and impermanent-loss-risk signals — so
 * a supply/swap proposal is grounded in real data before it hits the policy gate.
 */

import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { adapterForProject } from '../protocols'
import type { OnchainRuntimeContext } from '../types'

const YIELDS_URL = 'https://yields.llama.fi/pools'

interface LlamaPool {
  chain: string
  project: string
  symbol: string
  apy: number | null
  tvlUsd: number | null
  stablecoin: boolean
  ilRisk: string
  exposure: string
}

const Schema = z.object({
  asset: z.string().optional().describe('Filter by symbol substring, e.g. "USDC", "SUI".'),
  project: z.string().optional().describe('Filter by protocol, e.g. "scallop", "navi-lending".'),
  limit: z.number().int().min(1).max(25).optional().describe('Max pools to return. Default 8.'),
})
type Args = z.infer<typeof Schema>

export function makeDefiYields(_ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'defi.yields',
    description:
      'Discover the best yields on Sui (DefiLlama, read-only): pools ranked by APY with TVL, stablecoin, and IL-risk signals. Use for "where can I earn yield", "best stablecoin yield on Sui". Never moves funds.',
    searchHint: 'yield apy best earn discover defillama pools tvl stablecoin opportunities sui',
    schema: Schema,
    handler: async args => {
      try {
        const res = await fetch(YIELDS_URL)
        if (!res.ok) return { ok: false, error: `DefiLlama returned ${res.status}` }
        const body = (await res.json()) as { data: LlamaPool[] }
        const asset = args.asset?.trim().toUpperCase()
        const project = args.project?.trim().toLowerCase()
        const pools = body.data
          .filter(p => p.chain === 'Sui')
          .filter(p => (asset ? p.symbol?.toUpperCase().includes(asset) : true))
          .filter(p => (project ? p.project?.toLowerCase().includes(project) : true))
          .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
          .slice(0, args.limit ?? 8)
          .map(p => {
            // Tag each opportunity with whether Lyra can actually ACT on it.
            const adapter = adapterForProject(p.project)
            return {
              project: p.project,
              symbol: p.symbol,
              apy: p.apy != null ? `${p.apy.toFixed(2)}%` : null,
              tvlUsd: p.tvlUsd,
              stablecoin: p.stablecoin,
              ilRisk: p.ilRisk,
              exposure: p.exposure,
              executable: adapter?.execute ?? false,
              executeWith: adapter?.execute
                ? (adapter.tools.find(t => /supply|stake|deposit/.test(t)) ?? adapter.tools[0])
                : null,
            }
          })
        const executable = pools.filter(p => p.executable).length
        return {
          ok: true,
          data: {
            chain: 'Sui',
            count: pools.length,
            pools,
            note:
              executable < pools.length
                ? `${executable}/${pools.length} are directly executable by Lyra (Scallop/NAVI). For others Lyra can discover + explain, but cannot execute — propose the best executable alternative or give manual steps.`
                : undefined,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
