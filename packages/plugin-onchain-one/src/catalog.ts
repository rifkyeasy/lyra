/**
 * The tool catalog — the ONE place every on-chain tool is declared. Adding a tool
 * is a single entry here (plus the tool file itself); everything downstream is
 * derived:
 *
 *   - registration        → the plugin iterates TOOLS (index.ts)
 *   - web console tool set → WEB_TOOL_NAMES (apps import it; no hand-kept allowlist)
 *   - agent guidance       → capabilitySummary() feeds the system prompt (CLI + web),
 *                            so the model learns a new capability with no prose edit
 *
 * `web` marks a tool for the browser console's inline-execute set (the rest run on
 * the CLI/gateway, or have a web-native equivalent). `blurb` is an optional one-line
 * capability description surfaced in the guidance — omit it for secondary tools in a
 * family that a sibling already covers.
 */

import type { ToolDef } from 'lyra-core'
import { makeAccountInfo, makeSuiBalance } from './tools/balance'
import { makeCetusQuote } from './tools/cetus'
import { makeCetusLp } from './tools/cetus-lp'
import { makeDeepbookMarkets } from './tools/deepbook'
import { makeDefiYields } from './tools/defillama'
import { makeVoloStake, makeVoloUnstake } from './tools/liquid-stake'
import {
  makeNaviBorrow,
  makeNaviMarkets,
  makeNaviPosition,
  makeNaviRepay,
  makeNaviSupply,
  makeNaviWithdraw,
} from './tools/navi'
import { makePolicyCreate, makePolicyShow } from './tools/policy'
import { makeProtocolsList } from './tools/protocols'
import {
  makeScallopMarkets,
  makeScallopPosition,
  makeScallopSupply,
  makeScallopWithdraw,
} from './tools/scallop'
import { makeSuiSend } from './tools/send'
import { makeStake, makeUnstake } from './tools/stake'
import {
  makeSuilendBorrow,
  makeSuilendPosition,
  makeSuilendRepay,
  makeSuilendSupply,
  makeSuilendWithdraw,
} from './tools/suilend'
import { makeSwap } from './tools/swap'
import { makeWalrusStore } from './tools/walrus'
import { makeWalrusStake, makeWalrusStaking, makeWalrusUnstake } from './tools/walrus-stake'
import type { OnchainRuntimeContext } from './types'

// biome-ignore lint/suspicious/noExplicitAny: tools carry heterogeneous arg schemas
type Make = (ctx: OnchainRuntimeContext) => ToolDef<any>

export interface CatalogEntry {
  /** The tool's registered name (also its dispatch key). */
  name: string
  /** Factory that binds the tool to a runtime context. */
  make: Make
  /** Exposed in the browser console's inline-execute tool set. */
  web: boolean
  /**
   * Read-only: the tool moves NO value and needs no approval/permission gate.
   * SECURITY: this is fail-closed — a tool is treated as value-moving (gated by
   * the session permission mode + the deterministic approval floor) UNLESS it is
   * explicitly marked `read: true`. So a newly-added on-chain tool is gated by
   * default; you must consciously opt out to make it ungated.
   */
  read?: boolean
  /** One-line capability blurb for the agent guidance (optional). */
  blurb?: string
}

export const TOOLS: CatalogEntry[] = [
  // Reads / discovery
  {
    name: 'account.info',
    read: true,
    make: makeAccountInfo,
    web: false,
    blurb: 'account.info — the agent address, network, balance, and active policy.',
  },
  {
    name: 'sui.balance',
    read: true,
    make: makeSuiBalance,
    web: false,
    blurb: 'sui.balance — SUI + coin balances for the agent or any address.',
  },
  {
    name: 'policy.show',
    read: true,
    make: makePolicyShow,
    web: false,
    blurb: 'policy.show — the active fund-control policy (caps, allowlists, expiry).',
  },
  {
    name: 'protocols.list',
    read: true,
    make: makeProtocolsList,
    web: true,
    blurb: 'protocols.list — which protocols Lyra can READ vs EXECUTE on.',
  },
  {
    name: 'defi.yields',
    read: true,
    make: makeDefiYields,
    web: true,
    blurb: 'defi.yields — best yields across Sui (DefiLlama), tagged executable / executeWith.',
  },
  {
    name: 'deepbook.markets',
    read: true,
    make: makeDeepbookMarkets,
    web: true,
    blurb: 'deepbook.markets — DeepBook spot mid prices.',
  },
  {
    name: 'cetus.quote',
    read: true,
    make: makeCetusQuote,
    web: false,
    blurb: 'cetus.quote — best swap route/price across DEXes (read-only aggregator).',
  },
  { name: 'scallop.markets', make: makeScallopMarkets, web: true, read: true },
  { name: 'scallop.position', make: makeScallopPosition, web: true, read: true },
  { name: 'navi.markets', make: makeNaviMarkets, web: true, read: true },
  { name: 'navi.position', make: makeNaviPosition, web: true, read: true },
  { name: 'suilend.position', make: makeSuilendPosition, web: true, read: true },
  {
    name: 'walrus.staking',
    read: true,
    make: makeWalrusStaking,
    web: true,
    blurb:
      "walrus.staking — the agent's WAL balance, StakedWal positions, and nodes to stake with.",
  },

  // Policy / transfer / swap
  {
    name: 'policy.create',
    make: makePolicyCreate,
    web: false,
    blurb: 'policy.create — publish a shared on-chain AgentPolicy (arms enforcement + receipts).',
  },
  {
    name: 'sui.send',
    make: makeSuiSend,
    web: false,
    blurb: 'sui.send — transfer SUI; blocked if out of policy, mints an on-chain receipt.',
  },
  {
    name: 'swap',
    make: makeSwap,
    web: false,
    blurb: 'swap — best-route swap across the major Sui DEXes (7k aggregator).',
  },

  // Liquidity provision (value-moving; web-executable via the deferred Execute card)
  {
    name: 'cetus.add_liquidity',
    make: makeCetusLp,
    web: true,
    blurb:
      'cetus.add_liquidity — provide full-range liquidity to a Cetus pool, zap-funded from vault SUI (SUI-paired pools).',
  },

  // Lending
  {
    name: 'scallop.supply',
    make: makeScallopSupply,
    web: true,
    blurb:
      'Lending — scallop.supply/withdraw, navi.supply/withdraw/borrow/repay, suilend.supply/withdraw/borrow/repay.',
  },
  { name: 'scallop.withdraw', make: makeScallopWithdraw, web: true },
  { name: 'navi.supply', make: makeNaviSupply, web: true },
  { name: 'navi.withdraw', make: makeNaviWithdraw, web: true },
  { name: 'navi.borrow', make: makeNaviBorrow, web: true },
  { name: 'navi.repay', make: makeNaviRepay, web: true },
  { name: 'suilend.supply', make: makeSuilendSupply, web: true },
  { name: 'suilend.withdraw', make: makeSuilendWithdraw, web: true },
  { name: 'suilend.borrow', make: makeSuilendBorrow, web: true },
  { name: 'suilend.repay', make: makeSuilendRepay, web: true },

  // Staking
  {
    name: 'sui.stake',
    make: makeStake,
    web: true,
    blurb: 'sui.stake / sui.unstake — native SUI staking to a validator (min 1 SUI).',
  },
  { name: 'sui.unstake', make: makeUnstake, web: true },
  {
    name: 'volo.stake',
    make: makeVoloStake,
    web: true,
    blurb: 'volo.stake / volo.unstake — liquid staking, SUI ↔ vSUI.',
  },
  { name: 'volo.unstake', make: makeVoloUnstake, web: true },
  {
    name: 'walrus.stake',
    make: makeWalrusStake,
    web: true,
    blurb:
      'walrus.stake / walrus.unstake — stake WAL to a Walrus storage node (min 1 WAL; unstake returns WAL next epoch).',
  },
  { name: 'walrus.unstake', make: makeWalrusUnstake, web: true },

  // Storage
  {
    name: 'walrus.store',
    make: makeWalrusStore,
    web: false,
    blurb: 'walrus.store — persist a receipt/report/memory artifact to Walrus.',
  },
]

/** Tool names exposed in the browser console's inline-execute set (derived). */
export const WEB_TOOL_NAMES: string[] = TOOLS.filter(t => t.web).map(t => t.name)

/**
 * On-chain tools that move value / write state — everything NOT marked `read`
 * (fail-closed). The permission-mode gate and the deterministic approval floor
 * key off this set so EVERY such tool is covered, not a hand-maintained list.
 */
export const VALUE_MOVING_TOOL_NAMES: Set<string> = new Set(
  TOOLS.filter(t => !t.read).map(t => t.name),
)

/** True when `name` is an on-chain tool that moves value / writes state. */
export function isValueMovingTool(name: string): boolean {
  return VALUE_MOVING_TOOL_NAMES.has(name)
}

/** The capability inventory for the agent guidance (derived from the catalog). */
export function capabilitySummary(): string {
  return TOOLS.filter(t => t.blurb)
    .map(t => `- ${t.blurb}`)
    .join('\n')
}
