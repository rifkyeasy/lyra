// Per-wallet chat history, ChatGPT/Claude style. Conversations are stored in
// localStorage keyed by the connected wallet address (an 'anon' bucket when
// signed out), so a user's chats follow their wallet on this browser:
// reconnect → your history returns; disconnect → the console shows the anon
// bucket. Client-only (guards every localStorage access).

export type TraceItem = { tool: string; args: unknown; result: unknown }
// A value-moving action the web brain prepared for the user's OWN wallet to sign
// + execute (the server holds no key). Mirrors `PendingAction` in lib/agent.ts.
export type PendingAction =
  | {
      kind: 'transfer'
      coinType: string
      symbol: string
      decimals: number
      amount: string
      baseUnits: string
      recipient: string
    }
  | {
      kind: 'swap'
      fromType: string
      fromSymbol: string
      toType: string
      toSymbol: string
      fromDecimals: number
      amount: string
      baseUnits: string
    }
// `pendingAction` is transient (a prepared tx awaiting wallet confirmation) and
// is intentionally NOT persisted, so a reload never re-shows a stale confirm.
export type Msg = {
  role: 'user' | 'assistant'
  content: string
  trace?: TraceItem[]
  pendingAction?: PendingAction
}

export interface Conversation {
  id: string
  title: string
  messages: Msg[]
  createdAt: number
  updatedAt: number
}

const MAX_CONVOS = 50
const MAX_MSGS = 80

function bucketKey(address: string | null): string {
  return `lyra.chats.${address ? address.toLowerCase() : 'anon'}`
}

export function loadConversations(address: string | null): Conversation[] {
  try {
    const raw = localStorage.getItem(bucketKey(address))
    const parsed = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) {
      return (parsed as Conversation[]).sort((a, b) => b.updatedAt - a.updatedAt)
    }
  } catch {}
  return []
}

export function saveConversations(address: string | null, convos: Conversation[]): void {
  try {
    const trimmed = convos.slice(0, MAX_CONVOS).map(c => ({
      ...c,
      // Drop transient pendingAction so reloads don't re-show a stale confirm.
      messages: c.messages.slice(-MAX_MSGS).map(({ pendingAction, ...m }) => m),
    }))
    localStorage.setItem(bucketKey(address), JSON.stringify(trimmed))
  } catch {}
}

export function newConversationId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
  }
}

export function titleFromMessages(messages: Msg[]): string {
  const first = messages.find(m => m.role === 'user')?.content ?? ''
  const t = first.replace(/\s+/g, ' ').trim()
  if (!t) return 'New chat'
  return t.length > 48 ? `${t.slice(0, 47)}…` : t
}

// ─── server-backed history (signed-in wallets) ──
// Synced across devices via /api/chats, scoped to the Sui sign-in session server-side.

export async function fetchRemoteConversations(): Promise<Conversation[] | null> {
  try {
    const r = await fetch('/api/chats', { cache: 'no-store' })
    if (!r.ok) return null
    const d = (await r.json()) as { conversations?: Conversation[] }
    return Array.isArray(d.conversations)
      ? d.conversations.sort((a, b) => b.updatedAt - a.updatedAt)
      : []
  } catch {
    return null
  }
}

export async function saveRemoteConversations(convos: Conversation[]): Promise<boolean> {
  try {
    const r = await fetch('/api/chats', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversations: convos.slice(0, MAX_CONVOS) }),
    })
    return r.ok
  } catch {
    return false
  }
}
