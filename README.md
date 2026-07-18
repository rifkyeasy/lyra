# Lyra

**A Sui-native, policy-bound, non-custodial AI finance agent.** You state a goal in
plain language; the AI proposes the action; **deterministic Move code on Sui enforces
the limits** — budget, per-tx cap, allowed coins/protocols/recipients, expiry — and
moves funds from an on-chain **vault**, not the agent's wallet. The AI advises; the
chain is the source of truth.

- 🌐 **Live web console:** https://lyraai.space
- 📦 **npm (CLI):** [`lyra-ai-agent`](https://www.npmjs.com/package/lyra-ai-agent)
- ⛓️ **Mainnet package:** `0xcd6943c0c4397f9d56c908f6e6952056bf469aa062afc7be9af358aba8fe15c5`

---

## Why it's non-custodial

Funds live in an on-chain `Vault`, owned by **you**. The agent can only draw from it
through **three bounded, policy-gated exits** — a recipient-checked `vault_transfer`, a
hot-potato `vault_borrow`/`vault_settle` that must return funds to a vault in the same
transaction (zero standing exposure), and a window-capped `vault_spend_capped` for
staking/lending. Each re-runs the full policy gate in Move on every action. So:

- A compromised agent key — or a leaked server — is **bounded by the policy** and
  **revocable** by you at any time (`owner_withdraw`).
- The agent is a **delegate, not a custodian**. It never holds your treasury.

Each owner wallet maps deterministically to **one agent + one vault**, identical across
the CLI, web, and Telegram.

---

## Quick start (CLI — self-hosted, you hold your keys)

### 1. Prerequisites
- [**Bun**](https://bun.sh) ≥ 1.1 — `curl -fsSL https://bun.sh/install | bash`
- A **Sui keypair** for the agent (a `suiprivkey1…` key) and a little **SUI** for gas
- An **OpenAI-compatible API key** for the brain

### 2. Install
```bash
bun install -g lyra-ai-agent
```

### 3. Configure
Set the agent + guardrails (e.g. in your shell profile or a `.env`):
```bash
export LYRA_AGENT_KEY=suiprivkey1...        # the agent that signs + pays gas
export LYRA_NETWORK=mainnet
export LYRA_PACKAGE_ID=0xcd6943c0c4397f9d56c908f6e6952056bf469aa062afc7be9af358aba8fe15c5
export OPENAI_API_KEY=sk-...                 # any OpenAI-compatible key
export LYRA_LLM_BASE_URL=https://api.openai.com/v1
export LYRA_LLM_MODEL=gpt-4o-mini

# deterministic guardrails (the whole point)
export LYRA_POLICY_MAX_PER_TX_SUI=1.0        # hard per-action cap
export LYRA_POLICY_AUTO_MAX_SUI=0.1          # auto-execute at/under this; above → approval
export LYRA_POLICY_MAX_SLIPPAGE_BPS=100      # block swaps over 1% slippage
export LYRA_POLICY_ALLOWED_COINS=0x2::sui::SUI
export LYRA_POLICY_ALLOWED_PROTOCOLS=transfer,swap,scallop,navi,walrus,deepbook
```

### 4. Initialize + fund
```bash
lyra init        # derives the agent's Sui address + writes ~/.lyra/config.ts
lyra status      # shows the address, network, balance, and the enforced policy
```
Send a little **SUI** to the address shown by `init` (for gas).

### 5. Use it
```bash
lyra             # interactive chat with your agent
lyra demo        # guarded-pipeline demo (policy → blocked over-cap → send → Walrus)
lyra logs        # tail the activity log
```

> Ask it things like *"what's my balance and limits?"*, *"send 0.01 SUI to 0x…"*,
> *"swap 1 SUI to USDC"*, *"best stablecoin yield on Sui?"* — every value-moving action
> is policy-checked, simulated, then executed, with an on-chain `ActionReceipt`.

---

## The four interfaces — same agent, same policy

| Interface | Run it | Identity |
| --- | --- | --- |
| **CLI** | `lyra` | local config (you hold the key) |
| **Web** | https://app.lyraai.space (console), or self-host (`apps/app`) | Sign-In-with-Sui |
| **Gateway** | `lyra gateway start` (always-on HTTP/socket daemon) | local |
| **Telegram** | `lyra telegram setup` → `lyra gateway start` | `/link` (sign a challenge) |

Each user can run their **own** bot + agent from the CLI — their token, their keys,
their machine. Fully sovereign.

---

## How it works

```
You (natural language)
      │  AI proposes an action
      ▼
Off-chain policy engine ──► simulate (dry-run) ──► execute
      │                                              │
      └───► lyra::vault (transfer / borrow+settle / spend_capped) ◄───┘
                       re-runs lyra::policy in Move:
                       version? agent? budget? per-tx? window? coin? protocol? recipient? expiry? revoked?
                       └► releases Coin from the on-chain Vault + mints ActionReceipt
```

The on-chain package is five focused Move modules (in its own repo,
[`lyraai-protocol/contracts`](https://github.com/lyraai-protocol/contracts)):

- **`lyra::policy`** — the `AgentPolicy` gate: budget, per-tx cap, coin/protocol/
  recipient allowlists (anti prompt-injection), expiry, revoke, and a version guard.
  Every cap is **owner-editable on-chain** (`set_max_per_tx` / `set_budget` /
  `set_window_budget`); provision scales them to your seed, so a whale isn't stuck at a
  toy limit.
- **`lyra::vault`** — the treasury `Vault<T>`; three bounded exits (`vault_transfer`,
  `vault_borrow`/`vault_settle`, `vault_spend_capped`) re-run the policy on-chain with a
  rolling-window blast-radius bound; `owner_withdraw` is your escape hatch (never
  version-trapped).
- **`lyra::receipt`** — the immutable `ActionReceipt` audit artifact; only the gate mints it.
- **`lyra::allowlist` / `lyra::constants`** — reusable allowlist rules + the shared version.
- **Walrus** — durable, verifiable receipts/memory.
- **Aggregated execution** — swaps route across Cetus / FlowX / Bluefin / DeepBook (7k).
- **Liquidity provision** — full-range Cetus CLMM positions, zap-funded from vault SUI
  (keep half, swap half to the pair coin, add liquidity) — all under the same policy gate.
- **Confirm before sign** — every value-moving action (transfer, swap, lend, stake, LP)
  shows a live preview (amounts in/out, route, policy checks) before the agent signs.

### Funding the vault from another chain

The vault is on Sui; the money usually isn't. `packages/plugin-onchain-two` bridges USDC
in from **Ethereum, Base, Arbitrum, Optimism, Polygon and Avalanche** over Circle CCTP
(Sui is domain 8), and lands it in your `Vault<USDC>`:

```
burn on source chain ──► Circle attests ──► redeem on Sui ──► [swap to USDC] ──► Vault<USDC>
     initiated          source_burned       attested          sui_redeemed        vault_deposited
```

Every step is a checked transition, and the state lives in the store rather than in a
process — so the driver resumes mid-flight transfers after a restart instead of stranding
them. We run the relayer ourselves; CCTP takes no protocol fee, so you pay source-chain gas
and nothing else. Tools: `bridge.routes`, `bridge.deposit`, `bridge.status`.

An upgrade can pause the agent's spend path (until the owner `migrate`s a policy/vault),
but owner controls — revoke, re-scope, `owner_withdraw` — are never version-gated, so an
upgrade can never trap your funds.

---

## Develop

```bash
git clone https://github.com/lyraai-protocol/lyra.git && cd lyra
bun install
bun test                              # TS test suite
```

The **Move package lives in its own repo**,
[`lyraai-protocol/contracts`](https://github.com/lyraai-protocol/contracts) —
`sui move build` / `sui move test` (37 Move tests).

Org layout:
```
lyraai-protocol/lyra          this repo — agent runtime, tools, CLI, gateway
  packages/core               agent runtime / brain (tool loop)
  packages/plugin-onchain     Sui tools: send, swap, lend, stake, walrus, vault, policy
  packages/plugin-onchain-two cross-chain deposits (CCTP) + the deposit driver
  packages/plugin-telegram    Telegram interface (/link, listener)
  packages/gateway            always-on daemon
  packages/cli                the `lyra` CLI
lyraai-protocol/contracts     the Move package (policy · vault · receipt · allowlist · constants)
lyraai-protocol/app           app.lyraai.space — Next.js console (dapp-kit + SIWS)
lyraai-protocol/landing       lyraai.space — marketing + research
lyraai-protocol/waitlist      waitlist.lyraai.space — testnet waitlist
lyraai-protocol/api           api.lyraai.space — Bun + Hono + SQLite (articles, chats, deposits, waitlist)
```

## Deploy

- **Console** (`app.lyraai.space`) + **landing** (`lyraai.space`) — Next.js on
  **Netlify**, auto-deployed on push to `main` via each repo's GitHub Actions.
- **API** (`api.lyraai.space`) — a Bun + Hono service behind TLS.

## Security

Non-custodial by design — funds are in the on-chain vault, bounded by policy, revocable
by you. Honest production boundaries (see `DEMO.md`): a **contract audit** and a real
**KMS/MPC signer** (the `AgentSigner` abstraction is ready) are recommended before
managing significant or third-party funds. Never commit `.env` / keys.

## License

MIT
