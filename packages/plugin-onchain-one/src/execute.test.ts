import { describe, expect, test } from 'bun:test'
import { submit } from './execute'
import type { OnchainRuntimeContext } from './types'

// A stand-in Transaction: submit() only calls setSenderIfNotSet + build on it.
function fakeTx(): Parameters<typeof submit>[1] {
  return {
    setSenderIfNotSet() {},
    async build() {
      return new Uint8Array([9, 9, 9])
    },
  } as unknown as Parameters<typeof submit>[1]
}

describe('submit — the single signer choke point', () => {
  test('remote path: builds, signs via signBytes, submits bytes + signature', async () => {
    const calls: Record<string, unknown> = {}
    const ctx = {
      agentAddress: '0xabc',
      signBytes: async (b: Uint8Array) => {
        calls.signed = b
        return 'SIG'
      },
      client: {
        async executeTransactionBlock(args: unknown) {
          calls.exec = args
          return { digest: 'D' }
        },
        async signAndExecuteTransaction() {
          throw new Error('keypair path must not run when signBytes is set')
        },
      },
    } as unknown as OnchainRuntimeContext

    const res = (await submit(ctx, fakeTx(), { showEffects: true })) as { digest: string }
    expect(res.digest).toBe('D')
    expect(calls.signed).toEqual(new Uint8Array([9, 9, 9]))
    expect((calls.exec as { signature: string; transactionBlock: Uint8Array }).signature).toBe(
      'SIG',
    )
  })

  test('local path: falls back to keypair via signAndExecuteTransaction', async () => {
    const calls: Record<string, unknown> = {}
    const keypair = { tag: 'kp' }
    const ctx = {
      agentAddress: '0xabc',
      keypair,
      client: {
        async signAndExecuteTransaction(args: { signer: unknown }) {
          calls.signer = args.signer
          return { digest: 'L' }
        },
        async executeTransactionBlock() {
          throw new Error('remote path must not run without signBytes')
        },
      },
    } as unknown as OnchainRuntimeContext

    const res = (await submit(ctx, fakeTx(), {})) as { digest: string }
    expect(res.digest).toBe('L')
    expect(calls.signer).toBe(keypair)
  })

  test('throws when neither signBytes nor keypair is configured', async () => {
    const ctx = { agentAddress: '0xabc', client: {} } as unknown as OnchainRuntimeContext
    await expect(submit(ctx, fakeTx(), {})).rejects.toThrow(/no signer/)
  })
})
