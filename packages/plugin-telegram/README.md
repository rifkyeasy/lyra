# lyra-plugin-telegram

Telegram channel for **lyra**. DM your bot from any phone; the agent replies —
with the **same** policy → simulation → approval gates, surfaced as inline-keyboard
approvals so you can authorize material-risk actions from your pocket.

## Highlights

- **Long-poll outbound only** — works without exposing an inbound port.
- **Allowlisted DMs** — only configured `allowedUserIds` reach the brain.
- **Reactions as feedback** — 👀 on processing start, 👍 on success, 👎 on error.
- **Per-chat debounce** — a 600ms quiet window collapses fragmented typing into one turn.
- **Rate-limited** — 30 messages / 60s per user via token bucket.
- **Inline-keyboard approvals** — the operator approves risky tool calls from their phone.

## Quickstart

```bash
# either: set TELEGRAM_BOT_TOKEN (+ optional TELEGRAM_CHAT_ID) in your env
# or:     lyra telegram setup     # one-time interactive: bot token + allowed user IDs
lyra                              # start the TUI; the listener boots automatically
# DM your bot from your phone — the agent replies.
```

## Install

Auto-installed with [`lyra-ai-agent`](https://www.npmjs.com/package/lyra-ai-agent).
Or directly: `bun add lyra-plugin-telegram`.

Built on [grammy](https://grammy.dev) (TS-first, bun-compatible). See the
[root README](https://github.com/rifkyeasy/lyra#readme).
