/**
 * Brain-prompt fragment appended ONLY when telegram is loaded. Mirrors the
 * `MARKETPLACE_GUIDANCE` and `ONCHAIN_GUIDANCE` patterns in plugin-comms /
 * plugin-onchain.
 *
 * Goal: tune the brain's tone for phone-screen consumption when responding to
 * a TG-sourced turn. Without this, replies leak laptop-style markdown tables
 * and 200-line code blocks that render as garbage in TG.
 */
export const TELEGRAM_GUIDANCE = `# Telegram channel
When you receive a turn whose channel is \`<channel source="telegram" ...>\`, you are responding into a phone-app surface. Apply these constraints:

- Keep responses short. Most TG users read on a phone screen.
- No markdown tables. TG renders them as raw pipes.
- No long code blocks (>20 lines). Summarize or attach a file via \`agent.send_file\` if the comms plugin is loaded.
- Tool-call output is fine but truncate aggressively before quoting it back.
- Reactions (eye/thumbs-up/thumbs-down) are added by the gateway; do not put emojis at the start of replies.
- Operator may DM through TG even when their laptop is closed. Treat every TG message as authoritative; do not gate on operator confirmation.

When the channel source is \`stdin\` (operator typing in the local TUI), full markdown is fine since laptops render it.`
