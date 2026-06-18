// In-memory device-link store for the CLI login flow.
//
// The CLI starts a login (POST /api/cli/login/start), gets a short human-typable
// code + a long pollToken, and opens the web /cli-login page. The signed-in owner
// approves the code (POST /api/cli/login/approve), at which point the server
// derives THAT owner's agent key and stashes it on the session. The CLI polls
// (GET /api/cli/login/poll) and, on approval, retrieves owner + agentKey ONCE —
// the session is deleted on retrieval so the key can never be read twice.
//
// State lives in a module-level Map. We run a single pm2 instance, so module
// state is shared across all requests; no external store is needed.
import 'server-only'

import { randomBytes } from 'node:crypto'

/** Sessions live this long before they count as expired. */
export const SESSION_TTL_MS = 600_000 // 600s

export type LinkStatus = 'pending' | 'approved'

export type LinkSession = {
  /** Human-typable pairing code, format "XXXX-XXXX". */
  code: string
  /** Long random secret the CLI holds to poll for the result. */
  pollToken: string
  status: LinkStatus
  /** Set once approved: the owner address that approved this link. */
  owner: string | null
  /** Set once approved: the owner's agent secret (suiprivkey1…). One-time read. */
  agentKey: string | null
  /** Epoch ms the session was created (drives expiry). */
  createdAt: number
}

// Keyed by code for O(1) approve lookups; pollToken lookups scan the small map.
const sessions = new Map<string, LinkSession>()

/** Unambiguous code alphabet — no 0/O/1/I to keep codes easy to read/type. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function isExpired(s: LinkSession, now: number): boolean {
  return now - s.createdAt > SESSION_TTL_MS
}

/** Drop every session past its TTL. Called lazily before each operation. */
function prune(now: number): void {
  for (const [code, s] of sessions) {
    if (isExpired(s, now)) sessions.delete(code)
  }
}

/** Random "XXXX-XXXX" code from the unambiguous alphabet. */
function makeCode(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-'
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return out
}

/** Create a fresh PENDING device-link session and return it. */
export function createSession(): LinkSession {
  const now = Date.now()
  prune(now)

  // Avoid the (astronomically unlikely) collision with a live code.
  let code = makeCode()
  while (sessions.has(code)) code = makeCode()

  const session: LinkSession = {
    code,
    pollToken: randomBytes(32).toString('hex'),
    status: 'pending',
    owner: null,
    agentKey: null,
    createdAt: now,
  }
  sessions.set(code, session)
  return session
}

/**
 * Look a session up by its pollToken. Returns the session, `'expired'` if it
 * exists but is past TTL (and removes it), or `null` if there is no such token.
 */
export function findByPollToken(token: string): LinkSession | 'expired' | null {
  const now = Date.now()
  prune(now)
  if (!token) return null
  for (const s of sessions.values()) {
    if (s.pollToken === token) {
      if (isExpired(s, now)) {
        sessions.delete(s.code)
        return 'expired'
      }
      return s
    }
  }
  return null
}

/**
 * Look a PENDING session up by its code. Returns the session, `'expired'` if it
 * exists but is past TTL (and removes it), or `null` if there is no such code.
 * Codes are matched case-insensitively and tolerate a missing dash.
 */
export function findByCode(rawCode: string): LinkSession | 'expired' | null {
  const now = Date.now()
  prune(now)
  const code = normalizeCode(rawCode)
  if (!code) return null
  const s = sessions.get(code)
  if (!s) return null
  if (isExpired(s, now)) {
    sessions.delete(s.code)
    return 'expired'
  }
  return s
}

/**
 * Mark the session for `code` approved, recording the owner + agent key. Returns
 * the updated session, `'expired'`, or `null` if no such code.
 */
export function approveSession(
  rawCode: string,
  owner: string,
  agentKey: string,
): LinkSession | 'expired' | null {
  const s = findByCode(rawCode)
  if (!s || s === 'expired') return s
  s.status = 'approved'
  s.owner = owner
  s.agentKey = agentKey
  return s
}

/** Delete a session by code (used for one-time retrieval after approval). */
export function deleteSession(code: string): void {
  sessions.delete(code)
}

/** Normalize a typed code: uppercase, strip non-alphanumerics, re-insert dash. */
export function normalizeCode(raw: string): string {
  const clean = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (clean.length !== 8) return ''
  return `${clean.slice(0, 4)}-${clean.slice(4)}`
}
