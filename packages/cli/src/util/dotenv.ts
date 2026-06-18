/**
 * Minimal `~/.lyra/.env` loader.
 *
 * `lyra init` persists the OpenAI key to `~/.lyra/.env` (mode 0600) so the CLI
 * runs with zero shell env vars. On startup we read that file and fill any
 * UNSET vars — real shell env always wins (we never clobber an existing value).
 * Kept dependency-free (no dotenv pkg) and intentionally simple: `KEY=value`
 * lines, `#` comments, optional surrounding quotes.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { agentPaths } from 'lyra-core'

/** Parse `KEY=value` lines (ignoring blanks/comments) into a record. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

/**
 * Load `~/.lyra/.env` into `process.env`, filling only UNSET keys. No-op when
 * the file is absent. Returns the keys it actually set.
 */
export function loadDotenvFile(): string[] {
  const path = agentPaths.dotenv
  if (!existsSync(path)) return []
  const parsed = parseDotenv(readFileSync(path, 'utf8'))
  const set: string[] = []
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v
      set.push(k)
    }
  }
  return set
}

/**
 * Persist (or update) a single `KEY=value` in `~/.lyra/.env`, preserving other
 * lines, and lock the file to mode 0600. Also updates `process.env[key]`.
 */
export function setDotenvVar(key: string, value: string): string {
  const path = agentPaths.dotenv
  mkdirSync(dirname(path), { recursive: true })
  const existing = existsSync(path) ? parseDotenv(readFileSync(path, 'utf8')) : {}
  existing[key] = value
  const body = `${Object.entries(existing)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`
  writeFileSync(path, body, { mode: 0o600 })
  chmodSync(path, 0o600)
  process.env[key] = value
  return path
}
