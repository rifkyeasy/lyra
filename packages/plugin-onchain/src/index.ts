/**
 * lyra-plugin-onchain
 *
 * Brain limbs for on-chain operations on Sui:
 *
 *   Account:     account.info, sui.balance
 *   Transfers:   sui.send            (policy → simulate → execute → on-chain receipt)
 *   Policy:      policy.show, policy.create   (lyra::policy AgentPolicy)
 *   Storage:     walrus.store        (durable, verifiable receipts/memory)
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
import { makeAccountInfo, makeSuiBalance } from './tools/balance'
import { makeCetusQuote } from './tools/cetus'
import { makeDeepbookMarkets } from './tools/deepbook'
import { makeDefiYields } from './tools/defillama'
import { makeNaviMarkets, makeNaviPosition, makeNaviSupply, makeNaviWithdraw } from './tools/navi'
import { makePolicyCreate, makePolicyShow } from './tools/policy'
import { makeProtocolsList } from './tools/protocols'
import {
  makeScallopMarkets,
  makeScallopPosition,
  makeScallopSupply,
  makeScallopWithdraw,
} from './tools/scallop'
import { makeSuiSend } from './tools/send'
import { makeSwap } from './tools/swap'
import { makeWalrusStore } from './tools/walrus'
import type { OnchainRuntimeContext } from './types'

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
export { resolveOwnerVault, type OwnerVault } from './vault'
export { ONCHAIN_GUIDANCE } from './guidance'
export type { OnchainRuntimeContext } from './types'

const plugin: NativePlugin = {
  name: 'onchain',
  register: ctx => {
    const onchain = (ctx as unknown as { onchain?: OnchainRuntimeContext }).onchain
    if (!onchain) return // soft-init for tests / non-onchain contexts

    ctx.registerTool(makeAccountInfo(onchain) as ToolDef)
    ctx.registerTool(makeSuiBalance(onchain) as ToolDef)
    ctx.registerTool(makeSuiSend(onchain) as ToolDef)
    ctx.registerTool(makeSwap(onchain) as ToolDef)
    ctx.registerTool(makePolicyShow(onchain) as ToolDef)
    ctx.registerTool(makePolicyCreate(onchain) as ToolDef)
    ctx.registerTool(makeWalrusStore(onchain) as ToolDef)
    ctx.registerTool(makeDeepbookMarkets(onchain) as ToolDef)

    // Discovery + capability map.
    ctx.registerTool(makeProtocolsList(onchain) as ToolDef)
    ctx.registerTool(makeDefiYields(onchain) as ToolDef)
    ctx.registerTool(makeCetusQuote(onchain) as ToolDef)

    // Lending (the two largest Sui money markets).
    ctx.registerTool(makeScallopMarkets(onchain) as ToolDef)
    ctx.registerTool(makeScallopPosition(onchain) as ToolDef)
    ctx.registerTool(makeScallopSupply(onchain) as ToolDef)
    ctx.registerTool(makeScallopWithdraw(onchain) as ToolDef)
    ctx.registerTool(makeNaviMarkets(onchain) as ToolDef)
    ctx.registerTool(makeNaviPosition(onchain) as ToolDef)
    ctx.registerTool(makeNaviSupply(onchain) as ToolDef)
    ctx.registerTool(makeNaviWithdraw(onchain) as ToolDef)
  },
}

export default plugin
