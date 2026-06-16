<h1 align="center">Lyra AI</h1>

<p align="center">
  <b>A Sui-native, policy-bound AI agent for autonomous DeFi.</b><br/>
  <sub>The AI proposes. Sui policies enforce. Walrus remembers.</sub>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"/></a>
  <a href="https://sui.io"><img src="https://img.shields.io/badge/built%20on-Sui-6fbcf0.svg" alt="Built on Sui"/></a>
  <a href="https://www.walrus.xyz"><img src="https://img.shields.io/badge/storage-Walrus-7c5cff.svg" alt="Walrus"/></a>
</p>

---

Lyra AI is an autonomous finance agent for **Sui** that can discover DeFi
opportunities, build transaction plans, and execute approved actions across Sui
protocols. What makes Lyra more than a chatbot with a wallet is the part the AI
cannot override: every value-moving action is checked against deterministic
policy, previewed as a Sui Programmable Transaction Block, and recorded as an
auditable receipt.

**One line:** Lyra AI lets users delegate bounded financial work to an AI agent
without giving that agent unlimited wallet authority.

## Why Lyra

LLMs are useful for understanding goals, comparing strategies, and explaining
risk. They are not a safety boundary. A confused tool call or persuasive
hallucination should never be enough to move funds.

Lyra splits the system into two layers:

- **Advisory layer:** AI interprets user goals, discovers protocol options, and
  proposes actions.
- **Control layer:** Sui policies, deterministic checks, PTB previews, and
  revocation rules decide what can actually execute.

The result is an agent that can act autonomously, but only inside explicit
limits set by the user.

## Core Flow

```text
goal
  -> AI plan
  -> policy check
  -> PTB preview
  -> simulation / confirmation
  -> Sui execution
  -> on-chain + Walrus receipt
```

Example policy:

```text
Max spend: 100 dUSDC
Allowed protocols: DeepBook, Walrus receipt storage
Allowed actions: swap, place order, cancel order
Max slippage: 1%
Expiry: 24 hours
Owner revocation: enabled
```

If the agent tries to spend more than the cap, use an unapproved protocol, or
execute after expiry, Lyra blocks the action before broadcast.

## Capabilities

| Area | Capability | Notes |
| --- | --- | --- |
| Agent policy | Budget, protocol scope, expiry, revocation | Enforced before execution |
| Sui execution | Programmable Transaction Block generation | Human-readable preview before signing |
| DeFi discovery | Protocol, pool, yield, and liquidity discovery | DefiLlama plus protocol-specific adapters |
| Sponsor execution | DeepBook or DeepBook Predict flows | Slippage-capped and policy-checked |
| Memory | Walrus / MemWal durable agent memory | Strategy logs, reports, receipts |
| Supporting DeFi | Cetus/Turbos swaps or NAVI/Suilend lending | Add only when useful for the demo |
| Audit trail | On-chain events and stored receipts | Every accepted or rejected action is explainable |
| Safety | Blocked-action demos | Shows the policy boundary is real |

## Sui-Native Design

Lyra is designed around Sui primitives:

- **Move objects** represent agent policies, spend caps, revocation state, and
  receipts.
- **Programmable Transaction Blocks** make multi-step execution previewable and
  atomic.
- **Sui events** provide an on-chain action trail.
- **zkLogin** can simplify onboarding for non-crypto-native users.
- **DeepBook** provides Sui-native liquidity and financial execution.
- **Walrus** stores durable agent memory, reports, and receipt artifacts.
- **Seal** can protect private memory or sensitive strategy data.

## Protocol Integration Plan

Lyra should integrate Sui protocols in stages:

1. **Read-only discovery**
   - DefiLlama Sui analytics
   - wallet balances
   - protocol TVL, yield, and pool metadata

2. **Sponsor protocol core**
   - Walrus or MemWal for durable memory, reports, and receipts
   - DeepBook or DeepBook Predict for Sui-native financial execution
   - PTB preview, policy checks, and receipt storage

3. **Supporting DeFi**
   - Cetus or Turbos swaps only if needed for route comparison
   - NAVI or Suilend supply/withdraw flows
   - position monitoring
   - liquidation and health-factor warnings

4. **Advanced track expansion**
   - DeepBook Predict strategies
   - keeper services
   - agent-to-agent coordination
   - private memory with Seal

## Hackathon Positioning

Lyra AI is built for **Sui Overflow 2026**.

Primary track:

- **Agentic Web**: Lyra uses Sui policies, PTBs, and revocation to make AI
  agents safer and more composable.

Secondary track:

- **Walrus**: Lyra uses Walrus or MemWal as a verifiable memory and receipt
  layer for long-running agents.

Optional track angle:

- **DeFi & Payments**: Lyra can become a programmable money agent across Sui
  DeFi.
- **DeepBook**: Lyra can specialize in DeepBook or DeepBook Predict execution.

## MVP

The first working version should prove the safety boundary and one real
protocol flow:

1. Connect a Sui wallet.
2. Create an agent policy object.
3. Ask Lyra for a goal-driven action.
4. Generate a PTB preview.
5. Execute an allowed Sui testnet transaction.
6. Store a receipt with Walrus.
7. Attempt an unsafe action and show it being blocked.
8. Revoke the policy.

## Suggested Architecture

```text
apps/
  web                 # Sui wallet UI, policy builder, PTB preview, activity log

packages/
  agent               # LLM planner, tool selection, explanations
  policy              # deterministic checks: caps, scope, slippage, expiry
  sui                 # Sui client, PTB builder, Move package bindings
  protocols           # DeepBook first; optional Cetus/Turbos, NAVI/Suilend adapters
  memory              # Walrus / MemWal receipt and memory storage

move/
  lyra_policy         # AgentPolicy, ActionReceipt, revocation, events

knowledge/
  ...                 # local hackathon and product research, gitignored
```

## Demo Evidence

A competitive demo should include:

- A public GitHub repository during judging.
- A working Sui testnet or mainnet deployment.
- Package ID for any Move package.
- A demo video under 5 minutes.
- At least one real transaction.
- A successful policy-compliant action.
- A blocked unsafe action.
- A visible Walrus memory or receipt artifact.

## Knowledge Base

Local planning notes live in `knowledge/`. This folder is intentionally
gitignored because it contains working research and hackathon context.

Start with:

- `knowledge/README.md`
- `knowledge/00-project-knowledge.md`
- `knowledge/product/recommended-concept.md`
- `knowledge/product/mvp-architecture.md`

## License

MIT.
