import { describe, expect, it } from 'bun:test'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import {
  InMemoryLinkStore,
  completeLink,
  linkChallenge,
  makeNonce,
  startLink,
  verifyLink,
} from './link'

async function sign(kp: Ed25519Keypair, message: string): Promise<string> {
  const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(message))
  return signature
}

describe('telegram link', () => {
  it('verifies a valid signature → the signer (owner) address', async () => {
    const kp = Ed25519Keypair.generate()
    const tg = 12345
    const nonce = makeNonce()
    const sig = await sign(kp, linkChallenge({ telegramUserId: tg, nonce }))
    expect(await verifyLink({ telegramUserId: tg, nonce, signature: sig })).toBe(kp.toSuiAddress())
  })

  it('rejects a wrong nonce', async () => {
    const kp = Ed25519Keypair.generate()
    const tg = 1
    const sig = await sign(kp, linkChallenge({ telegramUserId: tg, nonce: makeNonce() }))
    expect(await verifyLink({ telegramUserId: tg, nonce: makeNonce(), signature: sig })).toBeNull()
  })

  it('rejects a wrong telegram user id (challenge mismatch)', async () => {
    const kp = Ed25519Keypair.generate()
    const nonce = makeNonce()
    const sig = await sign(kp, linkChallenge({ telegramUserId: 1, nonce }))
    expect(await verifyLink({ telegramUserId: 2, nonce, signature: sig })).toBeNull()
  })

  it('rejects a garbage signature', async () => {
    expect(
      await verifyLink({ telegramUserId: 1, nonce: makeNonce(), signature: 'not-a-sig' }),
    ).toBeNull()
  })

  it('binds the owner via the store round-trip', async () => {
    const store = new InMemoryLinkStore()
    const kp = Ed25519Keypair.generate()
    const tg = 99
    const challenge = await startLink(store, tg)
    const owner = await completeLink(store, tg, await sign(kp, challenge))
    expect(owner).toBe(kp.toSuiAddress())
    expect(await store.getOwner(tg)).toBe(kp.toSuiAddress())
  })

  it('completeLink without a pending nonce returns null', async () => {
    const store = new InMemoryLinkStore()
    expect(await completeLink(store, 5, 'sig')).toBeNull()
  })

  it('a signature for a different telegram user cannot bind this one', async () => {
    const store = new InMemoryLinkStore()
    const kp = Ed25519Keypair.generate()
    // start a link for user 7, but sign the challenge for a different user.
    await startLink(store, 7)
    const wrong = await sign(kp, linkChallenge({ telegramUserId: 8, nonce: makeNonce() }))
    expect(await completeLink(store, 7, wrong)).toBeNull()
    expect(await store.getOwner(7)).toBeNull()
  })

  it('issues distinct nonces', () => {
    expect(makeNonce()).not.toBe(makeNonce())
  })
})
