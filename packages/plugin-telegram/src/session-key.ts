/**
 * Pure helpers for building stable session keys per inbound surface. The brain
 * prompt's `<channel source="telegram" chat="..." user="...">` wrapping uses
 * these so memory writes can be partitioned per chat (future) and rate
 * limiting can scope per chat.
 *
 * Format mirrors hermes:
 *   agent:<name>:telegram:dm:<chatId>
 *   agent:<name>:telegram:group:<chatId>:<threadId>     (post-MVP)
 *
 * Pure — no IO, no mutation. Safe to test exhaustively.
 */
export interface BuildSessionKeyInput {
  agentName: string
  chatId: number
  threadId?: number
  isGroup?: boolean
}

export function buildSessionKey(input: BuildSessionKeyInput): string {
  const safeName = sanitizeAgentName(input.agentName)
  if (input.isGroup) {
    const t = input.threadId ?? 0
    return `agent:${safeName}:telegram:group:${input.chatId}:${t}`
  }
  return `agent:${safeName}:telegram:dm:${input.chatId}`
}

/**
 * Strip characters that would confuse memory paths or prompt parsing.
 * Allow lowercase alpha + digits + hyphen only. Empty string falls back to
 * "lyra" so the key is always well-formed.
 */
export function sanitizeAgentName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, '')
  return cleaned.length > 0 ? cleaned : 'lyra'
}
