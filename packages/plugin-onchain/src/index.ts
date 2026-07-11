/**
 * lyra-plugin-onchain
 *
 * Brain limbs for on-chain operations on Sui:
 *
 *   Account:     account.info, sui.balance
 *   Transfers:   sui.send            (policy → simulate → execute → on-chain receipt)
 *   Policy:      policy.show, policy.create   (lyra::policy AgentPolicy)
 *   Storage:     walrus.store        (durable, verifiable receipts/memory)
 *   WAL staking: walrus.stake, walrus.unstake, walrus.staking  (Walrus storage nodes)
 *   Markets:     deepbook.markets    (DeepBook spot mid prices, read-only)
 *
 * Value-moving tools run through policy → simulate → (approval) → execute, and
 * are re-enforced on-chain by the lyra::policy Move package.
 *
 * Runtime ctx is side-banded onto PluginContext under `.onchain` (see
 * `OnchainRuntimeContext` in `./types.ts`). Without it the plugin registers
 * nothing — a graceful no-op for unit-test loaders.
 */

// MUST be first: guards Error.captureStackTrace before ./tools/navi pulls in
// navi-sdk → axios → follow-redirects, which crashes Bun at import otherwise.
import './capture-shim'
import type { NativePlugin, ToolDef } from 'lyra-core'
import { TOOLS } from './catalog'
import type { OnchainRuntimeContext } from './types'

export { TOOLS, WEB_TOOL_NAMES, capabilitySummary, type CatalogEntry } from './catalog'
export {
  makeSuiClient,
  keypairFromSecret,
  suiRpcUrl,
  type SuiNetwork,
} from './client'
export { simulate, type SimResult } from './simulate'
export {
  evaluatePolicy,
  policyFromEnv,
  suiToMist,
  normalizeCoinType,
  MIST_PER_SUI,
  type SuiPolicy,
  type SuiPolicyAction,
  type PolicyVerdict,
} from './policy'
export { policyRequiresApprovalForCall } from './approval'
export { deriveAgentKeypair, deriveAgentAddress } from './derive'
export {
  resolveOwnerVault,
  resolveVaultForAgent,
  type OwnerVault,
  type AgentVault,
} from './vault'
export { ONCHAIN_GUIDANCE } from './guidance'
export type { OnchainRuntimeContext } from './types'
export {
  PROTOCOL_IDS,
  PROTOCOL_LABELS,
  ALLOWLISTABLE_PROTOCOLS,
  NO_PROTOCOL,
  type ProtocolKey,
} from './protocol-ids'

const plugin: NativePlugin = {
  name: 'onchain',
  register: ctx => {
    const onchain = (ctx as unknown as { onchain?: OnchainRuntimeContext }).onchain
    if (!onchain) return // soft-init for tests / non-onchain contexts

    // Every tool is declared once in the catalog; registration just iterates it.
    for (const tool of TOOLS) ctx.registerTool(tool.make(onchain) as ToolDef)
  },
}

export default plugin
