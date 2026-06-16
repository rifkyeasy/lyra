import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encryptSecret } from './crypto'
import {
  clearSession,
  hasProfile,
  readProfile,
  readSession,
  writeProfile,
  writeSession,
} from './store'

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nebula-profile-'))
  process.env.NEBULA_ROOT = dir
})
afterEach(async () => {
  process.env.NEBULA_ROOT = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('profile store', () => {
  test('profile round-trips', async () => {
    expect(await hasProfile()).toBe(false)
    await writeProfile(ADDR, encryptSecret(PK, 'pw'))
    expect(await hasProfile()).toBe(true)
    const p = await readProfile()
    expect(p?.address).toBe(ADDR)
  })

  test('session honors expiry', async () => {
    const now = 1_000_000
    await writeSession(ADDR, PK, now, 1000)
    expect((await readSession(now + 500, ADDR))?.privkey).toBe(PK)
    expect(await readSession(now + 2000, ADDR)).toBeNull() // expired
  })

  test('session rejects a mismatched address', async () => {
    const now = 1_000_000
    await writeSession(ADDR, PK, now, 10_000)
    expect(await readSession(now + 1, '0x0000000000000000000000000000000000000001')).toBeNull()
  })

  test('clearSession removes it', async () => {
    const now = 1_000_000
    await writeSession(ADDR, PK, now, 10_000)
    await clearSession()
    expect(await readSession(now + 1, ADDR)).toBeNull()
  })
})
