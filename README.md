# Lyra

**A Sui-native, policy-bound, non-custodial AI finance agent.** You state a goal in
plain language; the AI proposes the action; **deterministic Move code on Sui enforces
the limits** — budget, per-tx cap, allowed coins/protocols/recipients, expiry — and
moves funds from an on-chain **vault**, not the agent's wallet. The AI advises; the
chain is the source of truth.

- 🌐 **Live web console:** https://lyraai.space
- 📦 **npm (CLI):** [`lyra-ai-agent`](https://www.npmjs.com/package/lyra-ai-agent)
- ⛓️ **Mainnet package:** `0x811bb37d66e8639e205bd41003a7fb8121133faa68abcf0b17488794c34823d5`

---

## Why it's non-custodial

Funds live in an on-chain `Vault`, owned by **you**. The agent can only draw from it
through `vault_spend`, which re-runs the full policy gate in Move on every action. So:

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
export LYRA_PACKAGE_ID=0x811bb37d66e8639e205bd41003a7fb8121133faa68abcf0b17488794c34823d5
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
| **Web** | https://lyraai.space, or self-host (`apps/web`) | Sign-In-with-Sui |
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
      └──────────────► lyra::vault::vault_spend ◄─────┘
                       re-runs lyra::policy in Move:
                       agent? budget? per-tx? coin? protocol? recipient? expiry? revoked?
                       └► releases Coin from the on-chain Vault + mints ActionReceipt
```

- **`lyra::policy`** — the `AgentPolicy` shared object: budget, caps, allowlists,
  recipient allowlist (anti prompt-injection), expiry, revoke.
- **`lyra::vault`** — the treasury `Vault<T>`; `vault_spend` / `vault_transfer` enforce
  the policy on-chain; `owner_withdraw` is your escape hatch.
- **Walrus** — durable, verifiable receipts/memory.
- **Aggregated execution** — swaps route across Cetus / FlowX / Bluefin / DeepBook (7k).

---

## Develop

```bash
git clone https://github.com/rifkyeasy/lyra.git && cd lyra
bun install
bun test                              # 930 TS tests
sui move test --path move/lyra        # 21 Move tests
cd apps/web && bun run dev            # web console on :3210
```

Monorepo layout:
```
move/lyra            on-chain policy + vault (Move)
packages/core        agent runtime / brain (tool loop)
packages/plugin-onchain   Sui tools: send, swap, lend, walrus, vault, policy
packages/plugin-telegram  Telegram interface (/link, listener)
packages/gateway     always-on daemon
packages/cli         the `lyra` CLI
apps/web             Next.js web console (dapp-kit + SIWS)
```

## Deploy (web)

The web console auto-deploys on push to `main` via GitHub Actions
(`.github/workflows/deploy.yml`) → SSH to the host → `scripts/deploy-vps.sh`
(build → atomic swap → `pm2 reload`). See the script for the self-host recipe
(nginx reverse proxy + certbot TLS).

## Security

Non-custodial by design — funds are in the on-chain vault, bounded by policy, revocable
by you. Honest production boundaries (see `DEMO.md`): a **contract audit** and a real
**KMS/MPC signer** (the `AgentSigner` abstraction is ready) are recommended before
managing significant or third-party funds. Never commit `.env` / keys.

## License

MIT
