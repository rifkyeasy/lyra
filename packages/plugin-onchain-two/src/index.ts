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
// Agent-facing deposit tools (bound to an owner + a store): open + track a deposit.
export { makeBridgeDeposit, makeBridgeStatus } from './bridge-tools'
export { makeV2Context, type V2Context } from './context'
// Cross-chain deposit orchestration (pure, chain-agnostic): the state machine +
// pending-transfer store that drive a deposit from source-burn → attestation →
// Sui redeem → vault. Chain calls report results back as transitions.
export {
  type DepositStatus,
  type DepositAction,
  canTransition,
  isTerminal,
  nextAction,
} from './deposit-lifecycle'
export {
  type PendingDeposit,
  type NewDeposit,
  type DepositStore,
  InMemoryDepositStore,
} from './deposit-store'
// The runtime that advances deposits one step per tick via injected chain executors
// (fully testable with mocks; real CCTP/Sui executors plug in behind the interface).
export {
  type DepositExecutors,
  driveOnce,
  driveTick,
  reapStale,
} from './deposit-driver'
// Entry validation: turn a bridge.deposit request into a validated NewDeposit
// (supported CCTP chains, token classification → needsSwap, amount/owner checks).
export {
  type DepositRequest,
  type IntentResult,
  type TokenClass,
  CCTP_DOMAINS,
  MIN_DEPOSIT,
  classifyToken,
  isSupportedSourceChain,
  supportedSourceChains,
  validateDepositRequest,
} from './deposit-intent'

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
