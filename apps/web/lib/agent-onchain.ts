// Reuse the CLI's on-chain tool registry in the web so the agent can EXECUTE the
// same lending + staking actions the CLI does — no re-implementation. Each tool
// is bound to the signed-in owner's derived agent (deriveAgentKeypair), so a
// caller can only ever direct the agent derived from THEIR wallet. Importing the
// plugin runs its capture-shim first (guards navi-sdk's Bun/Node import crash).
//
// Transfer + swap keep the web's vault-backed propose→Execute card (agent-exec.ts);
// balances/policy/receipts have web-native read tools. What this adds is the DeFi
// surface the web previously couldn't touch: supply/withdraw/borrow/repay across
// NAVI · Suilend · Scallop, and native + Volo staking — executed under the same
// deterministic policy gate as the CLI.
import 'server-only'

// Type-only lyra-core import (erased at build) — a VALUE import would pull
// lyra-core's index → sqlite storage → `bun:sqlite`, which Node (the web runtime)
// can't resolve. plugin-onchain imports lyra-core type-only too, so the runtime
// graph here stays Node-safe.
import type { ToolDef, ToolResult } from 'lyra-core'
import onchainPlugin, {
  deriveAgentKeypair,
  makeSuiClient,
  policyFromEnv,
  type OnchainRuntimeContext,
} from 'lyra-plugin-onchain'
import { zodToJsonSchema } from 'zod-to-json-schema'

interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

// Lending + staking + read discovery. (sui.send/swap stay on the vault-backed
// card flow; account.info/sui.balance/policy.*/walrus.store have web equivalents.)
const WEB_TOOLS = new Set<string>([
  'scallop.markets',
  'scallop.position',
  'scallop.supply',
  'scallop.withdraw',
  'navi.markets',
  'navi.position',
  'navi.supply',
  'navi.withdraw',
  'navi.borrow',
  'navi.repay',
  'suilend.position',
  'suilend.supply',
  'suilend.withdraw',
  'suilend.borrow',
  'suilend.repay',
  'sui.stake',
  'sui.unstake',
  'volo.stake',
  'volo.unstake',
  'defi.yields',
  'protocols.list',
  'deepbook.markets',
])

function buildCtx(owner: string): OnchainRuntimeContext {
  const keypair = deriveAgentKeypair(owner)
  return {
    client: makeSuiClient('mainnet'), // honours LYRA_RPC_URL
    keypair,
    agentAddress: keypair.toSuiAddress(),
    network: 'mainnet',
    policy: policyFromEnv(process.env),
    packageId: process.env.LYRA_PACKAGE_ID,
    agentDir: '/tmp/lyra-web',
  }
}

export interface OwnerOnchain {
  agentAddress: string
  schemas: ToolSchema[]
  names: Set<string>
  dispatch: (name: string, args: unknown) => Promise<ToolResult>
}

/**
 * The plugin-onchain lending/staking tools bound to `owner`'s derived agent,
 * shaped as OpenAI function specs (`schemas`) with a `dispatch` that executes
 * them under the policy gate. Returns null if the stack can't init (e.g. no
 * master secret configured) — the web agent then falls back to read + propose.
 */
export function ownerOnchain(owner: string): OwnerOnchain | null {
  if (!process.env.LYRA_MASTER_SECRET) return null
  try {
    const ctx = buildCtx(owner)
    const tools: ToolDef[] = []
    const pluginCtx = {
      registerTool: (t: ToolDef) => {
        if (WEB_TOOLS.has(t.name)) tools.push(t)
      },
      registerListener: () => {},
      addHook: () => {},
      network: 'mainnet',
      agentDir: '/tmp/lyra-web',
      agentId: owner,
      onchain: ctx,
    }
    // The plugin reads `.onchain` off the ctx and registers every tool; our
    // registerTool filters to the WEB_TOOLS allowlist.
    ;(onchainPlugin.register as (c: unknown) => void)(pluginCtx)

    // OpenAI requires tool names to match ^[a-zA-Z0-9_-]+$ (no dots). plugin-onchain
    // tools use dotted names (e.g. suilend.supply), so send a sanitized name to the
    // API and map it back to the real tool on dispatch (mirrors lyra-core's brain).
    const toSafe = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, '_')
    const byName = new Map(tools.map(t => [toSafe(t.name), t]))
    const schemas: ToolSchema[] = tools.map(t => ({
      type: 'function',
      function: {
        name: toSafe(t.name),
        description: t.description,
        // $refStrategy:'none' inlines refs — OpenAI function params reject $ref.
        parameters: zodToJsonSchema(t.schema, { $refStrategy: 'none' }) as Record<string, unknown>,
      },
    }))

    return {
      agentAddress: ctx.agentAddress,
      schemas,
      names: new Set(byName.keys()),
      dispatch: async (name, args): Promise<ToolResult> => {
        const tool = byName.get(name)
        if (!tool) return { ok: false, error: `unknown tool ${name}` }
        const parsed = tool.schema.safeParse(args ?? {})
        if (!parsed.success) return { ok: false, error: `invalid args: ${parsed.error.message}` }
        try {
          return await tool.handler(parsed.data)
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      },
    }
  } catch {
    return null
  }
}
