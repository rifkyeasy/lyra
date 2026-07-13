/**
 * lyra-plugin-onchain — the single on-chain plugin import.
 *
 * A facade over two SDK-isolated halves:
 *   - lyra-plugin-onchain-one — tools on @mysten/sui v1 (7k swap, NAVI/Suilend/
 *     Scallop, staking, vault/policy)
 *   - lyra-plugin-onchain-two — tools on @mysten/sui v2 (Wormhole bridge, …)
 *
 * The incompatible @mysten/sui versions can't share a Transaction object, so each
 * half builds + signs + executes its own PTBs internally; only the version-
 * agnostic ToolDef crosses this boundary. Consumers import THIS package and get
 * every tool, unaware two SDK versions run underneath.
 */
import type { NativePlugin } from 'lyra-core'
import pluginOne from 'lyra-plugin-onchain-one'
import pluginTwo from 'lyra-plugin-onchain-two'

// Re-export the full v1 surface (TOOLS, WEB_TOOL_NAMES, policyFromEnv, guidance,
// deriveAgentKeypair, isValueMovingTool, types, …).
export * from 'lyra-plugin-onchain-one'

/** The combined plugin: registration fans out to both halves. */
const plugin: NativePlugin = {
  name: 'onchain',
  register: ctx => {
    pluginOne.register(ctx)
    pluginTwo.register(ctx)
  },
}

export default plugin
