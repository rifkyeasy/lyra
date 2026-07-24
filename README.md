# Lyra

**A non-custodial, policy-bound AI finance agent on Sui.**

State a goal in plain language. The AI proposes an action; deterministic Move
code on Sui enforces the limits — budget, per-transaction cap, allowed coins,
protocols, recipients, and expiry — and moves funds from an on-chain vault you
own, never from the agent's wallet. The AI advises; the chain is the source of
truth.

- **Web console** — https://app.lyraai.space
- **CLI (npm)** — [`lyra-ai-agent`](https://www.npmjs.com/package/lyra-ai-agent)
- **Mainnet package** — `0xcd6943c0c4397f9d56c908f6e6952056bf469aa062afc7be9af358aba8fe15c5`

## Non-custodial by design

Your funds live in an on-chain `Vault` that you own. The agent can only draw
from it through three bounded, policy-gated exits:

- `vault_transfer` — recipient-checked transfers.
- `vault_borrow` / `vault_settle` — a same-transaction borrow that must return
  funds to a vault, leaving zero standing exposure.
- `vault_spend_capped` — window-capped spends for staking and lending.

Every exit re-runs the full policy check in Move. A compromised agent key stays
bounded by the policy and is revocable at any time via `owner_withdraw` — the
agent is a delegate, not a custodian. Each owner wallet maps deterministically
to one agent and one vault, identical across the CLI, web, and Telegram.

## Quick start (CLI)

Self-hosted — you hold your keys.

**Prerequisites**

- [Bun](https://bun.sh) ≥ 1.1
- A Sui keypair (`suiprivkey1…`) with a little SUI for gas
- An OpenAI-compatible API key

**Install**

```bash
bun install -g lyra-ai-agent
```

**Configure** (shell profile or `.env`)

```bash
export LYRA_AGENT_KEY=suiprivkey1...
export LYRA_NETWORK=mainnet
export LYRA_PACKAGE_ID=0xcd6943c0c4397f9d56c908f6e6952056bf469aa062afc7be9af358aba8fe15c5
export OPENAI_API_KEY=sk-...
export LYRA_LLM_BASE_URL=https://api.openai.com/v1
export LYRA_LLM_MODEL=gpt-4o-mini

# guardrails
export LYRA_POLICY_MAX_PER_TX_SUI=1.0
export LYRA_POLICY_AUTO_MAX_SUI=0.1
export LYRA_POLICY_MAX_SLIPPAGE_BPS=100
export LYRA_POLICY_ALLOWED_COINS=0x2::sui::SUI
export LYRA_POLICY_ALLOWED_PROTOCOLS=transfer,swap,scallop,navi,walrus,deepbook
```

**Run**

```bash
lyra init      # derive the agent address, write ~/.lyra/config.ts
lyra status    # address, network, balance, enforced policy
lyra           # interactive chat
```

Fund the address from `lyra init` with a little SUI. Every value-moving action
is policy-checked, simulated, then executed, and recorded as an on-chain
`ActionReceipt`.

## Interfaces

One agent, one policy, four surfaces:

| Interface | Run                   | Identity          |
| --------- | --------------------- | ----------------- |
| CLI       | `lyra`                | local key         |
| Web       | https://app.lyraai.space | Sign-In with Sui  |
| Gateway   | `lyra gateway start`  | local             |
| Telegram  | `lyra telegram setup` | `/link` challenge |

## How it works

```
natural language ─► AI proposes ─► policy check ─► simulate ─► execute
                                       │                          │
                                       └──► lyra::vault ◄─────────┘
                                            re-runs lyra::policy in Move,
                                            releases Coin, mints ActionReceipt
```

The Move package ([`lyraai-protocol/contracts`](https://github.com/lyraai-protocol/contracts))
is five modules:

- **`lyra::policy`** — the `AgentPolicy` gate: budget, per-tx cap,
  coin/protocol/recipient allowlists, expiry, revoke, and a version guard. Caps
  are owner-editable on-chain (`set_max_per_tx`, `set_budget`,
  `set_window_budget`).
- **`lyra::vault`** — the `Vault<T>` treasury and its three policy-gated exits,
  with `owner_withdraw` as the owner's escape hatch (never version-trapped).
- **`lyra::receipt`** — the immutable `ActionReceipt` audit record.
- **`lyra::allowlist`** / **`lyra::constants`** — shared allowlist rules and the
  package version.

Off-chain, the agent aggregates swaps across Cetus, FlowX, Bluefin, and
DeepBook; provides full-range Cetus CLMM liquidity zap-funded from vault SUI; and
stores receipts and memory on Walrus. Every value-moving action shows a live
preview — amounts in and out, route, and policy checks — before it is signed.

## Cross-chain funding

The vault is on Sui; the funds often aren't. Lyra bridges USDC from Ethereum,
Base, Arbitrum, Optimism, Polygon, and Avalanche via Circle CCTP (Sui is domain
8) into your `Vault<USDC>`:

```
burn on source ─► Circle attests ─► redeem on Sui ─► Vault<USDC>
```

Each step is a checked, resumable transition — the driver recovers mid-flight
transfers after a restart. CCTP charges no protocol fee, so you pay only
source-chain gas. Tools: `bridge.routes`, `bridge.deposit`, `bridge.status`.

## Development

```bash
git clone https://github.com/lyraai-protocol/lyra.git && cd lyra
bun install
bun test
```

The Move package lives in
[`lyraai-protocol/contracts`](https://github.com/lyraai-protocol/contracts)
(`sui move build` / `sui move test`).

```
lyraai-protocol/lyra          agent runtime, tools, CLI, gateway
  packages/core               agent runtime and brain
  packages/plugin-onchain     Sui tools: send, swap, lend, stake, walrus, vault, policy
  packages/plugin-onchain-two cross-chain deposits (CCTP) + driver
  packages/plugin-telegram    Telegram interface
  packages/gateway            always-on daemon
  packages/cli                the `lyra` CLI
lyraai-protocol/contracts     Move package (policy · vault · receipt · allowlist · constants)
lyraai-protocol/app           app.lyraai.space — Next.js console
lyraai-protocol/landing       lyraai.space — marketing + research
lyraai-protocol/api           api.lyraai.space — Bun + Hono + SQLite
lyraai-protocol/waitlist      waitlist.lyraai.space — testnet waitlist
```

## Deployment

- Console and landing — Next.js on Netlify, deployed on push to `main`.
- API — Bun + Hono service behind TLS.

## Security

Non-custodial by design: funds stay in the on-chain vault, bounded by policy and
revocable by the owner. A contract audit and a KMS/MPC signer (the `AgentSigner`
interface is ready) are recommended before managing significant or third-party
funds. Never commit keys or `.env` files.

## License

MIT
