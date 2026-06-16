/**
 * On-disk profile + session for password login.
 *
 *  - profile.json : the agent key encrypted at rest under the password (scrypt +
 *    AES-256-GCM). Never holds a plaintext key.
 *  - session.json : a short-lived unlock so commands don't re-prompt every time.
 *    Holds the decrypted key with `0600` perms and an expiry — the convenience/
 *    security trade-off of a password profile. `nebula logout` clears it.
 *
 * Both live under `~/.nebula` (overridable via NEBULA_ROOT).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProfileCipher } from './crypto'

function root(): string {
  return process.env.NEBULA_ROOT ?? join(homedir(), '.nebula')
}
export function profilePath(): string {
  return join(root(), 'profile.json')
}
export function sessionPath(): string {
  return join(root(), 'session.json')
}

export interface ProfileFile {
  v: 1
  address: string
  cipher: ProfileCipher
}

export interface SessionFile {
  address: string
  privkey: string
  expiresAt: number
}

export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12h

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

export async function readProfile(): Promise<ProfileFile | null> {
  const p = await readJson<ProfileFile>(profilePath())
  return p?.address && p?.cipher ? p : null
}

export async function hasProfile(): Promise<boolean> {
  return (await readProfile()) !== null
}

export async function writeProfile(address: string, cipher: ProfileCipher): Promise<void> {
  await mkdir(root(), { recursive: true })
  const body: ProfileFile = { v: 1, address, cipher }
  await writeFile(profilePath(), JSON.stringify(body, null, 2), { mode: 0o600 })
}

/** A non-expired session whose address matches `address` (if given), else null. */
export async function readSession(now: number, address?: string): Promise<SessionFile | null> {
  const s = await readJson<SessionFile>(sessionPath())
  if (!s || !s.privkey || !s.address) return null
  if (typeof s.expiresAt !== 'number' || s.expiresAt <= now) return null
  if (address && s.address.toLowerCase() !== address.toLowerCase()) return null
  return s
}

export async function writeSession(
  address: string,
  privkey: string,
  now: number,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): Promise<void> {
  await mkdir(root(), { recursive: true })
  const body: SessionFile = { address, privkey, expiresAt: now + ttlMs }
  await writeFile(sessionPath(), JSON.stringify(body), { mode: 0o600 })
}

export async function clearSession(): Promise<void> {
  await rm(sessionPath(), { force: true })
}
