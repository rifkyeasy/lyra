import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { withSilencedConsole } from './silence-console'

describe('withSilencedConsole', () => {
  let writes: string[] = []
  let originalWrite: typeof process.stdout.write
  beforeEach(() => {
    writes = []
    originalWrite = process.stdout.write
    process.stdout.write = ((chunk: unknown) => {
      writes.push(typeof chunk === 'string' ? chunk : (chunk?.toString?.() ?? ''))
      return true
    }) as typeof process.stdout.write
  })
  afterEach(() => {
    process.stdout.write = originalWrite
  })

  test('mutes console.log/info/warn/error/debug for the duration of fn', async () => {
    await withSilencedConsole(async () => {
      console.log('SHOULD_BE_MUTED_LOG')
      console.info('SHOULD_BE_MUTED_INFO')
      console.warn('SHOULD_BE_MUTED_WARN')
      console.error('SHOULD_BE_MUTED_ERROR')
      console.debug('SHOULD_BE_MUTED_DEBUG')
    })
    expect(writes.join('')).not.toContain('SHOULD_BE_MUTED')
  })

  test('restores originals after fn resolves', async () => {
    const before = console.log
    await withSilencedConsole(async () => {})
    expect(console.log).toBe(before)
  })

  test('restores originals after fn throws', async () => {
    const before = console.log
    await expect(
      withSilencedConsole(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(console.log).toBe(before)
  })

  test('returns the value produced by fn', async () => {
    const result = await withSilencedConsole(async () => {
      console.log('noise')
      return 42
    })
    expect(result).toBe(42)
  })
})
