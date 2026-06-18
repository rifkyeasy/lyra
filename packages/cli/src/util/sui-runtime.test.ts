import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { agentPaths } from 'lyra-core'
import { loadAgent, loadAgentFromEnv, readAgentKeyFile, writeAgentKey } from './sui-runtime'

// Isolate the agent dir per-test via LYRA_ROOT so we never touch the real
// ~/.lyra. Also clear LYRA_AGENT_KEY so file-vs-env precedence is deterministic.
// Use Reflect.deleteProperty (not the `delete` operator) for a true unset —
// assigning `undefined` would leave the string "undefined" and break the loader.
let prevRoot: string | undefined
let prevKey: string | undefined

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) Reflect.deleteProperty(process.env, key)
  else process.env[key] = prev
}

beforeEach(() => {
  prevRoot = process.env.LYRA_ROOT
  prevKey = process.env.LYRA_AGENT_KEY
  process.env.LYRA_ROOT = mkdtempSync(join(tmpdir(), 'lyra-runtime-'))
  Reflect.deleteProperty(process.env, 'LYRA_AGENT_KEY')
})

afterEach(() => {
  restoreEnv('LYRA_ROOT', prevRoot)
  restoreEnv('LYRA_AGENT_KEY', prevKey)
})

describe('writeAgentKey / readAgentKeyFile', () => {
  test('writes the secret to ~/.lyra/agent.key with mode 0600', () => {
    const secret = new Ed25519Keypair().getSecretKey()
    const path = writeAgentKey(secret)
    expect(path).toBe(agentPaths.agentKey)
    expect(readAgentKeyFile()).toBe(secret)
    // Permission bits masked to the low 9 (rwx for u/g/o) should be 0600.
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('readAgentKeyFile returns null when no key file exists', () => {
    expect(readAgentKeyFile()).toBeNull()
  })
})

describe('loadAgent (env-first, then file)', () => {
  test('returns null when neither env nor file is present', () => {
    expect(loadAgent()).toBeNull()
    expect(loadAgentFromEnv()).toBeNull()
  })

  test('reads the on-disk key when LYRA_AGENT_KEY is unset', () => {
    const kp = new Ed25519Keypair()
    writeAgentKey(kp.getSecretKey())
    // env unset → falls through to the file.
    expect(loadAgentFromEnv()).toBeNull()
    const agent = loadAgent()
    expect(agent).not.toBeNull()
    expect(agent?.address).toBe(kp.toSuiAddress())
  })

  test('LYRA_AGENT_KEY env wins over the on-disk key', () => {
    const fileKp = new Ed25519Keypair()
    const envKp = new Ed25519Keypair()
    writeAgentKey(fileKp.getSecretKey())
    process.env.LYRA_AGENT_KEY = envKp.getSecretKey()
    const agent = loadAgent()
    expect(agent?.address).toBe(envKp.toSuiAddress())
    expect(agent?.address).not.toBe(fileKp.toSuiAddress())
  })
})
