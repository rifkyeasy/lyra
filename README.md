<h1 align="center">Lyra AI</h1>

<p align="center">
  <b>A Sui-native, policy-bound AI agent for autonomous DeFi.</b><br/>
  <sub>The AI proposes. Sui policies enforce. Walrus remembers.</sub>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"/></a>
  <a href="https://sui.io"><img src="https://img.shields.io/badge/built%20on-Sui-6fbcf0.svg" alt="Built on Sui"/></a>
  <a href="https://www.walrus.xyz"><img src="https://img.shields.io/badge/storage-Walrus-7c5cff.svg" alt="Walrus"/></a>
  <img src="https://img.shields.io/badge/contract-verified-22c55e.svg" alt="verified"/>
</p>

---

Lyra is an AI agent that does real on-chain work on **Sui** — check balances, transfer, discover yield, store durable memory — from a **terminal TUI**, a **web console**, **Telegram**, or an **HTTP gateway**. What makes it more than a chatbot with a wallet is the part the AI *cannot* override: every value-moving action is checked against a deterministic policy that lives in an **on-chain Move object**, executed inside a Programmable Transaction Block, and recorded as a verifiable **Walrus** receipt. The model proposes; the chain disposes.

> **One line:** an AI agent you can trust with a wallet, because the spending limits, protocol scope, expiry, and revocation live in an auditable on-chain object — not in a prompt the model could rationalize its way around.

**Live on Sui mainnet** · package [`0x26e5c029…316885`](https://suiscan.xyz/mainnet/object/0x26e5c029a07f74308d2a72002f09c54affd5b0914e401de25480046f45316885) (source-verified via `sui client verify-source`).

## Why this design

LLMs are good at *deciding what to do* and bad at *being a safety boundary*. A jailbreak, a confused tool call, or a hallucinated "the user said it was fine" should never be the only thing standing between an agent and your funds. So Lyra splits the two:

- **Advisory layer (the AI):** an agentic tool-loop — it reads balances, market data, and policy, then proposes actions.
- **Control layer (deterministic):** an off-chain policy mirror **and** an on-chain `AgentPolicy` Move object that custodies the budget. The agent can only spend through a `withdraw` that aborts if the action is revoked, expired, over its per-tx cap, over budget, or targets a protocol outside the allow-list. Because the agent holds no other funds, it *physically cannot* exceed these bounds.

## The write pipeline

Every value-moving action goes through the same gates:

```
intent → POLICY (pure mirror) → on-chain GUARD (Move withdraw) → EXECUTE (PTB) → RECEIPT (Walrus + frozen ActionReceipt)
```

The policy mirror lets the agent refuse instantly; the on-chain guard is the backstop that can't be bypassed — `withdraw` and the real action live in **one atomic PTB**, so if the guard aborts, the whole transaction reverts.

## Capabilities (agent tools)

| Kind | Tools |
| --- | --- |
| Read | `get_balances`, `policy_status`, `deepbook_market`, `defillama_sui_yields`, `list_receipts`, `read_memory` |
| Write (policy-gated) | `transfer_sui`, `store_memory` |

The agent runs a real multi-step loop: it inspects state with read tools, then acts with write tools — each write enforcing the policy + on-chain guard internally.

## Interfaces

| Interface | Command |
| --- | --- |
| Terminal TUI | `lyra` / `lyra chat` (`@opentui/solid`) |
| One-shot | `lyra agent "<goal>"` |
| Web console | `apps/web` (Next.js + `@mysten/dapp-kit`) |
| Telegram | `lyra telegram` (needs `TELEGRAM_BOT_TOKEN`) |
| HTTP gateway | `lyra-gateway` → `POST /api/goal` |

Full CLI: `init · chat · agent · status · balance · policy · receipts · deepbook · model · demo · telegram`.

## Quickstart

```bash
bun install
cp .env.example .env            # set LYRA_AGENT_KEY (a funded Sui key) + OPENAI_API_KEY
bun run agent "what's my balance and the top 3 Sui yields?"
bun run chat                    # interactive TUI
bun run demo                    # full guarded-pipeline demo on mainnet
```

The agent owns a single funded `AgentPolicy` (created on first run, cached in `.lyra/policy.json`). Configure the policy from the environment:

```bash
LYRA_NETWORK=mainnet
LYRA_POLICY_MAX_PER_TX_SUI=1.0
LYRA_POLICY_ALLOWED_PROTOCOLS=transfer,deepbook,walrus
LYRA_POLICY_EXPIRY_MINUTES=60
```

## Architecture

A bun monorepo of npm-publishable packages:

```
move/lyra              # the lyra::policy Move package (AgentPolicy, AgentCap, ActionReceipt)
packages/
  core                 # brain (LLM agentic loop) + deterministic policy engine + config/keys
  plugin-sui           # Sui client + lyra::policy PTB builders + write pipeline + read queries
  plugin-walrus        # durable verifiable receipts/memory (mainnet Walrus SDK)
  plugin-deepbook      # read-only DeepBook mainnet market context (indexer)
  plugin-telegram      # Telegram bot interface
  cli                  # `lyra` — TUI chat + agent/status/policy/receipts/... commands
  gateway              # long-running HTTP daemon (POST /api/goal)
apps/
  web                  # Next.js console: dapp-kit wallet + gateway-backed agent chat
```

### The Move package

- `AgentPolicy<T>` — a shared object custodying a `Balance<T>` budget, with owner, agent, per-tx cap, protocol allow-list, expiry, revoked flag, and spend accounting. `withdraw` is the guard; `deposit` / `reclaim` / `revoke` round it out.
- `AgentCap` — the agent's transferable authority for a policy.
- `ActionReceipt` — an immutable (frozen) on-chain receipt linking each action to its Walrus blob.

Build & verify:

```bash
cd move/lyra && sui move test            # 8 unit tests
sui client verify-source                 # confirms on-chain bytecode matches source
```

## Development

```bash
bun run typecheck     # tsc across the workspace
bun test              # policy-engine unit tests
```

## Demo evidence

- Mainnet package (verified): `0x26e5c029a07f74308d2a72002f09c54affd5b0914e401de25480046f45316885`
- The demo runs a full trust boundary on mainnet: create policy → allowed guarded spend + Walrus receipt → blocked over-cap (aborted on-chain) → revoke → post-revoke abort → reclaim.
- Receipts are durable Walrus blobs, retrievable from the public mainnet aggregator and linked from each on-chain `ActionReceipt`.

## License

MIT.
