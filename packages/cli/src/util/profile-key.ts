/**
 * Local accessor for the cached PROFILE scope key.
 *
 * Wraps `getSessionKey(agentId, OPERATOR_BLOB_SCOPES.PROFILE)` with the
 * hex-encoding the gateway handoff envelopes expect. Used by `nebula upgrade`
 * (both `--reprovision` + in-place) to ship the cached key to the new sandbox
 * daemon so it boots with `slots.profile` ready to anchor instead of
 * `{ status: 'skipped', reason: 'no-profile-key' }`.
 *
 * Returns undefined when the operator session is absent / expired / missing
 * the PROFILE scope (pre-v0.23.1 agents). Callers should surface a one-line
 * note in that case so the operator knows to refresh the session before the
 * next upgrade.
 */

import { OPERATOR_BLOB_SCOPES, getSessionKey } from 'nebula-ai-core'

export function loadProfileScopeKeyHex(agentId: string): `0x${string}` | undefined {
  try {
    const buf = getSessionKey(agentId, OPERATOR_BLOB_SCOPES.PROFILE)
    return buf ? (`0x${buf.toString('hex')}` as `0x${string}`) : undefined
  } catch {
    return undefined
  }
}
