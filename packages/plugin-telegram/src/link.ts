/**
 * Telegram ↔ owner-wallet linking.
 *
 * Completes the unified identity model: a Telegram user proves they own a Sui
 * wallet (their Lyra OWNER address) by signing a one-time challenge. Once bound,
 * the bot resolves that owner → their derived agent → their on-chain vault — the
 * SAME agent they drive from the web (SIWS) and the CLI. No custody is granted by
 * the signature; it only proves wallet ownership (like Sign-In-with-Sui).
 *
 * The flow: `/link` → bot issues a nonce → the user signs the challenge with any
 * Sui wallet's "sign message" → sends the signature → the bot verifies it,
 * recovers the signer address, and binds it to their Telegram user id.
 */

import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { verifyPersonalMessageSignature } from '@mysten/sui/verify'

/**
 * Derive the agent address that belongs to `owner`. MUST stay byte-identical to
 * `packages/plugin-onchain/src/derive.ts` + `apps/web/lib/agent-derive.ts` so
 * every surface resolves the same agent for the same owner.
 */
export function deriveAgentAddress(owner: string, masterSecret: string): string {
  const seed = createHmac('sha256', masterSecret)
    .update(`lyra-agent:v1:${owner.trim().toLowerCase()}`)
    .digest()
  return Ed25519Keypair.fromSecretKey(new Uint8Array(seed)).toSuiAddress()
}

/** The canonical challenge a user signs to link their Telegram to their wallet. */
export function linkChallenge(opts: { telegramUserId: number; nonce: string }): string {
  return [
    'Lyra — link this Telegram account to your agent.',
    `Telegram user: ${opts.telegramUserId}`,
    `Nonce: ${opts.nonce}`,
    'Signing only proves you own this wallet; it authorizes no transfer.',
  ].join('\n')
}

/**
 * Verify a link signature against the expected challenge and return the signer's
 * Sui address (the owner), or null if the signature is invalid.
 */
export async function verifyLink(opts: {
  telegramUserId: number
  nonce: string
  signature: string
}): Promise<string | null> {
  try {
    const message = new TextEncoder().encode(linkChallenge(opts))
    const publicKey = await verifyPersonalMessageSignature(message, opts.signature.trim())
    return publicKey.toSuiAddress()
  } catch {
    return null
  }
}

/** A 0x-prefixed 16-byte random nonce. */
export function makeNonce(): string {
  return `0x${[...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

// ─── binding store ──────────────────────────────────────────────────────────

/** Persists Telegram-user → owner-wallet bindings + the pending link nonce. */
export interface OwnerLinkStore {
  getOwner(telegramUserId: number): Promise<string | null>
  setOwner(telegramUserId: number, owner: string): Promise<void>
  removeOwner(telegramUserId: number): Promise<void>
  getPendingNonce(telegramUserId: number): Promise<string | null>
  setPendingNonce(telegramUserId: number, nonce: string): Promise<void>
}

/** JSON-file store (e.g. ~/.lyra/telegram-owners.json) for persistent bindings. */
export class FileLinkStore implements OwnerLinkStore {
  constructor(private readonly path: string) {}
  private read(): { owners: Record<string, string>; nonces: Record<string, string> } {
    try {
      const d = JSON.parse(readFileSync(this.path, 'utf8'))
      return { owners: d.owners ?? {}, nonces: d.nonces ?? {} }
    } catch {
      return { owners: {}, nonces: {} }
    }
  }
  private write(d: { owners: Record<string, string>; nonces: Record<string, string> }): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(d, null, 2))
  }
  async getOwner(id: number) {
    return this.read().owners[String(id)] ?? null
  }
  async setOwner(id: number, owner: string) {
    const d = this.read()
    d.owners[String(id)] = owner
    delete d.nonces[String(id)]
    this.write(d)
  }
  async removeOwner(id: number) {
    const d = this.read()
    delete d.owners[String(id)]
    this.write(d)
  }
  async getPendingNonce(id: number) {
    return this.read().nonces[String(id)] ?? null
  }
  async setPendingNonce(id: number, nonce: string) {
    const d = this.read()
    d.nonces[String(id)] = nonce
    this.write(d)
  }
}

/** In-memory store (tests + ephemeral runs). For persistence use a file store. */
export class InMemoryLinkStore implements OwnerLinkStore {
  private owners = new Map<number, string>()
  private nonces = new Map<number, string>()
  async getOwner(id: number) {
    return this.owners.get(id) ?? null
  }
  async setOwner(id: number, owner: string) {
    this.owners.set(id, owner)
    this.nonces.delete(id)
  }
  async removeOwner(id: number) {
    this.owners.delete(id)
  }
  async getPendingNonce(id: number) {
    return this.nonces.get(id) ?? null
  }
  async setPendingNonce(id: number, nonce: string) {
    this.nonces.set(id, nonce)
  }
}

/**
 * Drive the two-step link from a store: `start` issues + persists a nonce and
 * returns the challenge to show the user; `complete` verifies the signature and,
 * on success, binds the recovered owner. Returns the owner address or null.
 */
export async function startLink(store: OwnerLinkStore, telegramUserId: number): Promise<string> {
  const nonce = makeNonce()
  await store.setPendingNonce(telegramUserId, nonce)
  return linkChallenge({ telegramUserId, nonce })
}

export async function completeLink(
  store: OwnerLinkStore,
  telegramUserId: number,
  signature: string,
): Promise<string | null> {
  const nonce = await store.getPendingNonce(telegramUserId)
  if (!nonce) return null
  const owner = await verifyLink({ telegramUserId, nonce, signature })
  if (!owner) return null
  await store.setOwner(telegramUserId, owner)
  return owner
}
