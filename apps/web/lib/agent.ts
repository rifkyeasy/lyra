// Server-side Lyra agent for the web console. Runs a real OpenAI tool-calling
// loop over live Sui reads (@mysten/sui) — balances, the agent's on-chain
// AgentPolicy, recent ActionReceipts, and DeFiLlama yield discovery.
//
// Transfer/swap are prepared as vault-backed actions the signed-in owner executes
// via an "Execute" card. Lending + staking now EXECUTE inline through the same
// plugin-onchain tool registry the CLI uses (see agent-onchain.ts), bound to the
// signed-in owner's derived agent and gated by the deterministic on-chain policy —
// so the web can do everything the CLI can, not just read + advise.
import 'server-only'

import { ownerOnchain } from '@/lib/agent-onchain'
import {
  LYRA_POLICY_PACKAGE_ID,
  SUI_COIN_TYPE,
  type SuiNetwork,
  getActionReceiptsForOwner,
  getAgentPolicy,
} from '@/lib/chain/sui'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'

const NETWORK: SuiNetwork = (process.env.NEXT_PUBLIC_SUI_NETWORK as SuiNetwork) || 'mainnet'
const sui = new SuiClient({ url: getFullnodeUrl(NETWORK) })

// 1 SUI = 1e9 MIST.
const MIST_PER_SUI = 1_000_000_000n

function fmtSui(mist: bigint, decimals = 4): string {
  const negative = mist < 0n
  const w = negative ? -mist : mist
  const whole = w / MIST_PER_SUI
  const frac = w % MIST_PER_SUI
  const fracStr = frac.toString().padStart(9, '0').slice(0, decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fracStr ? `.${fracStr}` : ''}`
}

function isSuiAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(s)
}

// ─── tool context ─────────────────────────────────────────────────────────────
interface ToolContext {
  /** The signed-in / connected wallet, used as the default "my" subject. */
  walletAddress: string | null
}

// ─── tool implementations ─────────────────────────────────────────────────────

async function getBalanceTool(args: Record<string, unknown>, ctx: ToolContext) {
  const addr = (typeof args.address === 'string' && args.address) || ctx.walletAddress
  if (!addr || !isSuiAddress(addr))
    return { error: 'no valid Sui address (connect a wallet or pass one)' }
  const [suiBal, all] = await Promise.all([
    sui.getBalance({ owner: addr, coinType: SUI_COIN_TYPE }),
    sui.getAllBalances({ owner: addr }).catch(() => []),
  ])
  const coins = all
    .filter(b => b.coinType !== SUI_COIN_TYPE && BigInt(b.totalBalance) > 0n)
    .slice(0, 12)
    .map(b => ({ coinType: b.coinType, raw: b.totalBalance }))
  return {
    address: addr,
    sui: fmtSui(BigInt(suiBal.totalBalance)),
    suiMist: suiBal.totalBalance,
    otherCoins: coins,
  }
}

async function portfolioTool(args: Record<string, unknown>, ctx: ToolContext) {
  const addr = (typeof args.address === 'string' && args.address) || ctx.walletAddress
  if (!addr || !isSuiAddress(addr))
    return { error: 'no valid Sui address (connect a wallet or pass one)' }
  const all = await sui.getAllBalances({ owner: addr }).catch(() => [])
  const holdings = all
    .filter(b => BigInt(b.totalBalance) > 0n)
    .map(b => ({
      coinType: b.coinType,
      raw: b.totalBalance,
      ...(b.coinType === SUI_COIN_TYPE ? { sui: fmtSui(BigInt(b.totalBalance)) } : {}),
    }))
  return {
    address: addr,
    holdings,
    note: 'Raw balances are in base units; SUI shown in whole SUI.',
  }
}

async function agentPolicyTool(args: Record<string, unknown>, ctx: ToolContext) {
  const id =
    (typeof args.policyObjectId === 'string' && args.policyObjectId) ||
    process.env.NEXT_PUBLIC_LYRA_POLICY_OBJECT_ID ||
    null
  if (!id) return { error: 'no AgentPolicy object id configured or provided' }
  const p = await getAgentPolicy(id, NETWORK)
  if (!p) return { error: `no AgentPolicy at ${id}` }
  return {
    objectId: p.objectId,
    owner: p.owner,
    agent: p.agent,
    budgetSui: fmtSui(p.budgetMist),
    spentSui: fmtSui(p.spentMist),
    remainingSui: fmtSui(p.budgetMist - p.spentMist),
    maxPerTxSui: fmtSui(p.maxPerTxMist),
    allowedCoins: p.allowedCoins,
    allowedProtocols: p.allowedProtocols,
    expiry: p.expiryMs > 0n ? new Date(Number(p.expiryMs)).toISOString() : 'no expiry',
    revoked: p.revoked,
  }
}

async function recentReceiptsTool(args: Record<string, unknown>, ctx: ToolContext) {
  const agent =
    (typeof args.agent === 'string' && args.agent) ||
    process.env.NEXT_PUBLIC_LYRA_AGENT_ADDRESS ||
    ctx.walletAddress
  if (!agent || !isSuiAddress(agent)) return { error: 'no valid agent address' }
  const receipts = await getActionReceiptsForOwner(agent, NETWORK, 15).catch(() => [])
  return {
    agent,
    count: receipts.length,
    receipts: receipts.map(r => ({
      objectId: r.objectId,
      action: r.action,
      amountSui: r.amountMist !== undefined ? fmtSui(r.amountMist) : undefined,
      timestamp:
        r.timestampMs !== undefined ? new Date(Number(r.timestampMs)).toISOString() : undefined,
    })),
  }
}

async function defiYieldsTool(args: Record<string, unknown>) {
  const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 12) : 5
  try {
    const json = (await fetch('https://yields.llama.fi/pools').then(r => r.json())) as {
      data?: Array<{
        chain: string
        project: string
        symbol: string
        tvlUsd: number
        apy: number
        stablecoin?: boolean
      }>
    }
    const pools = (json.data ?? [])
      .filter(p => p.chain === 'Sui')
      .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
      .slice(0, limit)
      .map(p => ({
        project: p.project,
        symbol: p.symbol,
        apyPct: Number((p.apy ?? 0).toFixed(2)),
        tvlUsd: Math.round(p.tvlUsd ?? 0),
        stablecoin: Boolean(p.stablecoin),
      }))
    return { chain: 'Sui', pools }
  } catch (e) {
    return { error: `DeFiLlama unreachable: ${(e as Error).message}` }
  }
}

// ─── action proposals (executed client-side by the user's own wallet) ──────────
// The web brain holds no key. For value-moving actions it returns a structured
// PendingAction; the browser builds the PTB and the connected wallet signs +
// executes it. These are the USER's funds (not the agent's), so the AgentPolicy
// does not gate them — we only validate the inputs are well-formed.

/** symbol → mainnet coin type + decimals for the assets we can transfer/swap. */
const COINS: Record<string, { type: string; decimals: number }> = {
  sui: { type: SUI_COIN_TYPE, decimals: 9 },
  usdc: {
    type: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    decimals: 6,
  },
  deep: {
    type: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
    decimals: 6,
  },
  wal: {
    type: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
    decimals: 9,
  },
}
function resolveCoin(s: string): { symbol: string; type: string; decimals: number } | null {
  const k = s.trim().toLowerCase()
  if (COINS[k]) return { symbol: k.toUpperCase(), ...COINS[k] }
  // full coin type passed through (decimals default 9, unknown symbol)
  if (/^0x[0-9a-fA-F]+::[^:]+::[A-Za-z0-9_]+$/.test(s.trim())) {
    const sym = s.trim().split('::').pop() ?? 'TOKEN'
    return { symbol: sym, type: s.trim(), decimals: 9 }
  }
  return null
}

export type PendingAction =
  | {
      kind: 'transfer'
      coinType: string
      symbol: string
      decimals: number
      amount: string
      baseUnits: string
      recipient: string
    }
  | {
      kind: 'swap'
      fromType: string
      fromSymbol: string
      toType: string
      toSymbol: string
      fromDecimals: number
      amount: string
      baseUnits: string
    }

function proposeTransferTool(args: Record<string, unknown>, ctx: ToolContext) {
  if (!ctx.walletAddress)
    return {
      error: 'no wallet connected — ask the user to connect + sign in (top-right) to authorize their agent.',
    }
  const coin = resolveCoin(typeof args.coin === 'string' ? args.coin : 'sui')
  if (!coin) return { error: `unknown coin "${args.coin}"` }
  const recipient = typeof args.recipient === 'string' ? args.recipient.trim() : ''
  if (!isSuiAddress(recipient) || recipient.length !== 66)
    return { error: `invalid recipient address "${recipient}"` }
  const amount = typeof args.amount === 'string' ? args.amount : String(args.amount ?? '')
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return { error: `invalid amount "${amount}"` }
  const baseUnits = BigInt(Math.round(n * 10 ** coin.decimals)).toString()
  const action: PendingAction = {
    kind: 'transfer',
    coinType: coin.type,
    symbol: coin.symbol,
    decimals: coin.decimals,
    amount,
    baseUnits,
    recipient,
  }
  return {
    proposed: true,
    summary: `Send ${amount} ${coin.symbol} to ${recipient.slice(0, 8)}…${recipient.slice(-4)}`,
    __action: action,
  }
}

function proposeSwapTool(args: Record<string, unknown>, ctx: ToolContext) {
  if (!ctx.walletAddress)
    return {
      error: 'no wallet connected — ask the user to connect + sign in (top-right) to authorize their agent.',
    }
  const from = resolveCoin(typeof args.from === 'string' ? args.from : '')
  const to = resolveCoin(typeof args.to === 'string' ? args.to : '')
  if (!from) return { error: `unknown input coin "${args.from}"` }
  if (!to) return { error: `unknown output coin "${args.to}"` }
  if (from.type === to.type) return { error: 'from and to are the same coin' }
  const amount = typeof args.amount === 'string' ? args.amount : String(args.amount ?? '')
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return { error: `invalid amount "${amount}"` }
  const baseUnits = BigInt(Math.round(n * 10 ** from.decimals)).toString()
  const action: PendingAction = {
    kind: 'swap',
    fromType: from.type,
    fromSymbol: from.symbol,
    toType: to.type,
    toSymbol: to.symbol,
    fromDecimals: from.decimals,
    amount,
    baseUnits,
  }
  return {
    proposed: true,
    summary: `Swap ${amount} ${from.symbol} → ${to.symbol} (best route via 7k aggregator)`,
    __action: action,
  }
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case 'get_balance':
      return getBalanceTool(args, ctx)
    case 'portfolio':
      return portfolioTool(args, ctx)
    case 'agent_policy':
      return agentPolicyTool(args, ctx)
    case 'recent_receipts':
      return recentReceiptsTool(args, ctx)
    case 'defi_yields':
      return defiYieldsTool(args)
    case 'propose_transfer':
      return proposeTransferTool(args, ctx)
    case 'propose_swap':
      return proposeSwapTool(args, ctx)
    default:
      return { error: `unknown tool ${name}` }
  }
}

// ─── tool specs (OpenAI function-calling) ──────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_balance',
      description:
        'Get the SUI balance (and other coin balances) of a Sui address. Defaults to the connected wallet.',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'Sui 0x address. Defaults to the connected wallet.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'portfolio',
      description:
        "Full coin portfolio for a Sui address: balances of every coin type held. Defaults to the user's connected wallet — use for 'my portfolio / my treasury / my positions'.",
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'Sui 0x address. Defaults to the connected wallet.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agent_policy',
      description:
        "Read the agent's on-chain AgentPolicy: budget, spent, per-tx cap (in SUI), allowed coins and protocols, expiry, and whether it is revoked. This is the deterministic fund-control boundary the agent runs under.",
      parameters: {
        type: 'object',
        properties: {
          policyObjectId: {
            type: 'string',
            description: 'AgentPolicy object id. Defaults to the configured policy.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recent_receipts',
      description:
        "List the agent's recent on-chain ActionReceipts (what it has done, policy-checked).",
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Agent Sui address. Defaults to the configured agent.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'defi_yields',
      description: 'Top Sui DeFi pools by APY (DeFiLlama), with TVL. Read-only discovery.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'How many pools (default 5).' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_transfer',
      description:
        'Prepare a SUI/coin transfer for the user to execute with their OWN connected wallet (the user signs — you never do). Use when the user asks to send/transfer coins. Returns a pending action the UI turns into an Execute button.',
      parameters: {
        type: 'object',
        properties: {
          recipient: { type: 'string', description: 'Destination Sui 0x address (full 66-char).' },
          amount: { type: 'string', description: 'Amount in whole units, e.g. "0.01".' },
          coin: {
            type: 'string',
            description: 'Coin symbol (sui, usdc, deep, wal) or full coin type. Default sui.',
          },
        },
        required: ['recipient', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_swap',
      description:
        'Prepare a token swap for the user to execute with their OWN connected wallet (best route via the 7k aggregator across Cetus/FlowX/Bluefin/DeepBook; the user signs — you never do). Use when the user asks to swap/trade/convert. Returns a pending action the UI turns into an Execute button.',
      parameters: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description: 'Input coin symbol (sui, usdc, deep, wal) or full coin type.',
          },
          to: { type: 'string', description: 'Output coin symbol or full coin type.' },
          amount: { type: 'string', description: 'Input amount in whole units, e.g. "1".' },
        },
        required: ['from', 'to', 'amount'],
      },
    },
  },
] as const

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

export interface AgentResult {
  reply: string
  trace: { tool: string; args: unknown; result: unknown }[]
  /** A value-moving action prepared for the user's wallet to sign + execute. */
  action?: PendingAction
}

const SYSTEM_PROMPT = `You are lyra, a Sui-native, policy-aware AI treasury assistant.
You operate on Sui. Use the tools to answer with live on-chain data — never invent numbers.
The defensible idea: the AI advises, deterministic Move code enforces the fund controls. An agent acts
ONLY within its on-chain AgentPolicy (budget, per-tx cap, allowed coins/protocols, expiry) — read it
with agent_policy and explain the bounds when asked.
Across EVERY surface (CLI / gateway / Telegram / this web chat) the SAME policy-bound AGENT wallet signs
the PTBs — bounded by the on-chain AgentPolicy and recorded as ActionReceipts. The web does not make the
user sign; the connected wallet's Sui sign-in just proves they are the owner authorized to direct their
agent. When the user asks to SEND/TRANSFER coins call propose_transfer; when they ask to SWAP/TRADE/CONVERT
call propose_swap. These return a pending action the UI renders as an "Execute" button — when the signed-in
owner clicks it, the AGENT signs and executes under policy (you never sign). Say you've prepared it and it
will run within the AgentPolicy bounds on confirm; if it would exceed the per-tx cap, say so. If the user
isn't signed in, ask them to connect + sign in (top-right) to authorize their agent.
LENDING + STAKING execute directly when signed in — call the tools and they run under the on-chain policy
gate (simulate → execute → receipt), returning a tx digest: supply/withdraw/borrow/repay on NAVI and
Suilend (Suilend borrows a stablecoin like USDC against SUI collateral by default), supply/withdraw on
Scallop, native staking (sui.stake/sui.unstake), and Volo liquid staking (volo.stake/volo.unstake). These
act with the owner's own derived agent, so its address must hold SUI; if a tool reports too-small/
insufficient/simulation-failed, report that honestly and suggest funding the agent or a larger amount.
Always read live data (balances, policy, yields) with the read tools before acting, and never invent numbers.
Amounts are in SUI (1 SUI = 1e9 MIST). Memory and receipts are anchored with Walrus.
Be concise and concrete. When you cite a balance, yield, policy field, or receipt, it must come from a tool result.`

const OPENAI_URL =
  (process.env.LYRA_LLM_BASE_URL ?? 'https://api.openai.com/v1') + '/chat/completions'
const MODEL = process.env.LYRA_LLM_MODEL ?? 'gpt-4o-mini'

export interface RunAgentOptions {
  /** Authenticated / connected wallet address for this request, if any. */
  authedAddress?: string | null
}

export async function runAgent(
  history: ChatMessage[],
  opts: RunAgentOptions = {},
): Promise<AgentResult> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LYRA_LLM_API_KEY
  if (!apiKey)
    return {
      reply: 'The agent brain is not configured (no OPENAI_API_KEY on the server).',
      trace: [],
    }

  const walletAddress =
    opts.authedAddress && isSuiAddress(opts.authedAddress) ? opts.authedAddress : null
  const ctx: ToolContext = { walletAddress }

  // When signed in, expose the plugin-onchain lending/staking tools bound to the
  // owner's derived agent (executed inline under policy). Nulled out when not
  // signed in (no owner to derive) or no master secret — then read + propose only.
  const onchain = walletAddress ? ownerOnchain(walletAddress) : null
  const TOOL_LIST = onchain ? [...TOOLS, ...onchain.schemas] : TOOLS

  const sys = walletAddress
    ? `${SYSTEM_PROMPT}\nThe user's connected Sui wallet is ${walletAddress}. When they say "my", treat that as this address — call tools with no address (they default to it) and never ask them to paste an address.`
    : `${SYSTEM_PROMPT}\nThe user is not signed in, so there is no connected wallet. If they ask about "my" balance/portfolio, ask them to connect their Sui wallet (top-right) — or answer for a specific address if they give one.\nThe live Lyra policy package on Sui mainnet is ${LYRA_POLICY_PACKAGE_ID}.`

  const messages: ChatMessage[] = [{ role: 'system', content: sys }, ...history]
  const trace: AgentResult['trace'] = []
  let pendingAction: PendingAction | undefined

  for (let turn = 0; turn < 6; turn++) {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: TOOL_LIST,
        tool_choice: 'auto',
        temperature: 0.3,
      }),
    })
    if (!res.ok)
      return { reply: `brain error: ${res.status} ${(await res.text()).slice(0, 160)}`, trace }
    const data = (await res.json()) as {
      choices: { message: ChatMessage & { tool_calls?: ChatMessage['tool_calls'] } }[]
    }
    const msg = data.choices?.[0]?.message
    if (!msg) return { reply: 'no response from brain', trace }
    messages.push(msg)

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content || '(no reply)', trace, action: pendingAction }
    }

    for (const call of msg.tool_calls) {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(call.function.arguments || '{}')
      } catch {}
      let result: unknown
      try {
        // plugin-onchain tools (lending/staking) execute inline via the owner's
        // agent registry; everything else is a web-native read/propose tool.
        result =
          onchain && onchain.names.has(call.function.name)
            ? await onchain.dispatch(call.function.name, parsed)
            : await runTool(call.function.name, parsed, ctx)
      } catch (e) {
        result = { error: (e as Error).message }
      }
      if (result && typeof result === 'object' && '__action' in result) {
        pendingAction = (result as { __action: PendingAction }).__action
      }
      trace.push({ tool: call.function.name, args: parsed, result })
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }
  return {
    reply: 'Stopped after several tool calls without a final answer — try rephrasing.',
    trace,
    action: pendingAction,
  }
}
