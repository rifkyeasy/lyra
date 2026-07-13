/**
 * `protocols.list` — Lyra's honest capability map: which Sui protocols it can
 * READ vs EXECUTE on. The agent calls this before claiming it can act somewhere,
 * so it never promises a transaction on a protocol it has no adapter for.
 */

import type { ToolDef } from 'lyra-core'
import { z } from 'zod'
import { PROTOCOLS } from '../protocols'
import type { OnchainRuntimeContext } from '../types'

export function makeProtocolsList(_ctx: OnchainRuntimeContext): ToolDef<Record<string, never>> {
  return {
    name: 'protocols.list',
    description:
      "Lyra's integrated protocols and what it can do with each: read-only vs executable, by category (lending, DEX, staking, storage, CLOB). Call this to answer 'what can you do', 'which protocols do you support', or before telling a user whether an action is possible. Discovery (defi.yields) spans ALL Sui protocols; execution is bounded to this list.",
    searchHint:
      'protocols supported integrations capabilities what can you do execute adapters list',
    schema: z.object({}),
    handler: async () => ({
      ok: true,
      data: {
        protocols: PROTOCOLS.map(p => ({
          id: p.id,
          name: p.name,
          category: p.category,
          canRead: p.read,
          canExecute: p.execute,
          tools: p.tools,
          note: p.note,
        })),
        executable: PROTOCOLS.filter(p => p.execute).map(p => p.id),
        boundary:
          'Lyra can DISCOVER yields on any Sui protocol (defi.yields) but only EXECUTE on the protocols marked canExecute. For others, it surfaces the opportunity and proposes the best executable alternative or manual steps — it does not fabricate transactions.',
      },
    }),
  }
}
