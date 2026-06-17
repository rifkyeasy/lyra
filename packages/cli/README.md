# lyra-ai-agent

The `lyra` CLI — a **Sui-native, policy-aware AI treasury assistant**. Real
on-chain work on Sui (balances, transfers, swaps, wrap/unwrap, Scallop lending,
yield discovery, lyra::policy identity) from your terminal, where every value-moving
action is checked against a deterministic policy, dry-run simulated, and held for
approval before broadcast. The model proposes; code disposes.

## Install

```bash
bun add -g lyra-ai-agent
lyra init     # bootstrap an agent (plain-EOA identity, local encrypted keystore)
lyra          # chat with your agent
```

Requires [bun](https://bun.sh) — the CLI shebangs `bun`.

## Commands

```
lyra init                bootstrap a new agent identity + local keystore
lyra [--yolo]            interactive chat (default; --yolo skips approvals)
lyra status              agent + wallet + config state
lyra logs                tail the activity log
lyra drain --to <addr>   sweep the agent EOA balance
lyra model               re-pick the brain model
lyra identity <sub>      lyra::policy agent identity  (card | register | show)
lyra telegram <sub>      phone-DM gateway         (setup | status | remove)
lyra pairing <sub>       DM pairing approvals     (list | approve | revoke | clear-pending)
lyra gateway <sub>       always-on daemon         (run | start | stop | restart | status | logs)
```

Configure the brain with `OPENAI_API_KEY` (or any OpenAI-compatible `LYRA_LLM_*`),
set `LYRA_POLICY_*` fund-control limits, and fund the agent EOA with a little SUI
for gas. Material-risk actions pause for your approval.

See the [root README](https://github.com/rifkyeasy/lyra#readme) for architecture
and the full reference.
