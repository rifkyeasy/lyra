import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OPERATOR_BLOB_SCOPES,
  agentPaths,
  buildOperatorSession,
  writeOperatorSession,
} from 'nebula-ai-core'
import { loadProfileScopeKeyHex } from './profile-key'

const FAKE_AGENT = '0xaabbccddeeff00112233445566778899aabbccdd'.toLowerCase() as `0x${string}`
const FAKE_AGENT_ID = 'fake'.repeat(4)
const FAKE_AGENT_ID_NO_PROFILE = 'eeeeeeeeeeeeeeee'
const PROFILE_KEY_HEX = `0x${'a'.repeat(64)}` as `0x${string}`
const KEYSTORE_KEY_HEX = `0x${'b'.repeat(64)}` as `0x${string}`

describe('loadProfileScopeKeyHex', () => {
  const original = process.env.HOME
  let tmpHome: string

  beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'nebula-profile-key-'))
    process.env.HOME = tmpHome
    mkdirSync(agentPaths.agent(FAKE_AGENT_ID).dir, { recursive: true })
    mkdirSync(agentPaths.agent(FAKE_AGENT_ID_NO_PROFILE).dir, { recursive: true })
  })

  afterAll(() => {
    process.env.HOME = original
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('returns undefined when no session exists', () => {
    expect(loadProfileScopeKeyHex('ffffffffffffffff')).toBeUndefined()
  })

  it('returns the hex-encoded key when session contains PROFILE scope', () => {
    const sess = buildOperatorSession({
      agent: FAKE_AGENT,
      keys: {
        keystore: KEYSTORE_KEY_HEX,
        [OPERATOR_BLOB_SCOPES.PROFILE]: PROFILE_KEY_HEX,
      },
    })
    writeOperatorSession(FAKE_AGENT_ID, sess)
    const out = loadProfileScopeKeyHex(FAKE_AGENT_ID)
    expect(out).toBe(PROFILE_KEY_HEX)
  })

  it('returns undefined when PROFILE scope is missing from session', () => {
    const sess = buildOperatorSession({
      agent: FAKE_AGENT,
      keys: { keystore: KEYSTORE_KEY_HEX },
    })
    writeOperatorSession(FAKE_AGENT_ID_NO_PROFILE, sess)
    expect(loadProfileScopeKeyHex(FAKE_AGENT_ID_NO_PROFILE)).toBeUndefined()
  })
})
