/**
 * lyra-plugin-onchain-two — on-chain tools that require @mysten/sui v2
 * (Wormhole bridge, and later DeepBook v3 / Cetus execution).
 *
 * Isolated in its own package so its v2 SDK coexists with the v1 stack in
 * lyra-plugin-onchain-one. Tools register here and build their own PTBs with the
 * v2 client/keypair; the version-agnostic ToolDef interface is the only boundary.
 */
import type { NativePlugin, ToolDef } from 'lyra-core'
import { makeBridgeRoutes } from './bridge'

export { makeBridgeRoutes } from './bridge'
export { makeV2Context, type V2Context } from './context'

const plugin: NativePlugin = {
  name: 'onchain-two',
  register: ctx => {
    const c = ctx as unknown as { registerTool?: (t: ToolDef) => void }
    // Read-only quote tool needs no v2 signer context. Execute tools (bridge
    // deposit/withdraw) will build a v2 context from the shared secret when added.
    c.registerTool?.(makeBridgeRoutes() as ToolDef)
  },
}

export default plugin
