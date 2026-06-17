import { describe, expect, it } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisionInferFn, VisionInferInput, VisionInferResult } from 'lyra-core'
import { makeVisionAnalyze, sniffMimeFromBytes } from './vision'

function fakeVisionInfer(): {
  infer: VisionInferFn
  calls: VisionInferInput[]
} {
  const calls: VisionInferInput[] = []
  const infer: VisionInferFn = async input => {
    calls.push(input)
    const result: VisionInferResult = {
      content: 'a stub vision answer',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }
    return result
  }
  return { infer, calls }
}

describe('sniffMimeFromBytes', () => {
  it('detects PNG', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff])
    expect(sniffMimeFromBytes(png, null)).toBe('image/png')
  })

  it('detects JPEG', () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff])
    expect(sniffMimeFromBytes(jpg, null)).toBe('image/jpeg')
  })

  it('detects GIF87a', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00])
    expect(sniffMimeFromBytes(gif, null)).toBe('image/gif')
  })

  it('falls back to extension on unknown bytes', () => {
    const bogus = new Uint8Array([0x00, 0x00, 0x00, 0x00])
    expect(sniffMimeFromBytes(bogus, 'jpeg')).toBe('image/jpeg')
    expect(sniffMimeFromBytes(bogus, 'webp')).toBe('image/webp')
  })

  it('returns null on truly unknown', () => {
    expect(sniffMimeFromBytes(new Uint8Array([0x00, 0x00]), null)).toBeNull()
    expect(sniffMimeFromBytes(new Uint8Array([0x00, 0x00]), 'xyz')).toBeNull()
  })
})

describe('vision.analyze', () => {
  it('rejects when no provider configured', async () => {
    const tool = makeVisionAnalyze({ visionInfer: null, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({ image_path: '/tmp/x.png', prompt: 'describe it' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('vision provider not configured')
  })

  it('rejects relative paths', async () => {
    const { infer } = fakeVisionInfer()
    const tool = makeVisionAnalyze({ visionInfer: infer, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({ image_path: 'relative/path.png', prompt: 'q' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('absolute')
  })

  it('rejects when both image_path and image_url given', async () => {
    const { infer } = fakeVisionInfer()
    const tool = makeVisionAnalyze({ visionInfer: infer, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({
      image_path: '/tmp/a.png',
      image_url: 'https://example.com/b.png',
      prompt: 'q',
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('exactly one')
  })

  it('rejects when neither image_path nor image_url given', async () => {
    const { infer } = fakeVisionInfer()
    const tool = makeVisionAnalyze({ visionInfer: infer, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({ prompt: 'q' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('exactly one')
  })

  it('refuses image_path under credential dirs (~/.ssh, ~/.aws)', async () => {
    const { infer } = fakeVisionInfer()
    const tool = makeVisionAnalyze({ visionInfer: infer, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({
      image_path: '~/.ssh/id_rsa',
      prompt: 'leak',
    })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/protected path|denied/i)
  })

  it('refuses image_path inside the agent state tree', async () => {
    const { infer } = fakeVisionInfer()
    const tool = makeVisionAnalyze({ visionInfer: infer, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({
      image_path: '/tmp/lyra-test-agent/keystore.json',
      prompt: 'leak',
    })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/protected path|denied/i)
  })

  it('rejects URLs to private IPs', async () => {
    const { infer } = fakeVisionInfer()
    const tool = makeVisionAnalyze({ visionInfer: infer, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({
      image_url: 'http://127.0.0.1/leak.png',
      prompt: 'describe',
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('blocked')
  })

  it('rejects non-image file content', async () => {
    const path = join(tmpdir(), `lyra-vision-bogus-${Date.now()}.dat`)
    writeFileSync(path, 'not an image at all')
    const { infer } = fakeVisionInfer()
    const tool = makeVisionAnalyze({ visionInfer: infer, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({ image_path: path, prompt: 'q' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('unrecognized image format')
  })

  it('happy path: reads PNG from disk and calls vision', async () => {
    const path = join(tmpdir(), `lyra-vision-png-${Date.now()}.png`)
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
      0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])
    writeFileSync(path, png)
    const { infer, calls } = fakeVisionInfer()
    const tool = makeVisionAnalyze({ visionInfer: infer, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({ image_path: path, prompt: 'what is this' })
    expect(out.ok).toBe(true)
    expect((out.data as { content?: string } | undefined)?.content).toBe('a stub vision answer')
    expect(calls.length).toBe(1)
    expect(calls[0]!.images.length).toBe(1)
    expect(calls[0]!.images[0]!.mediaType).toBe('image/png')
    expect(calls[0]!.prompt).toBe('what is this')
  })

  it('happy path: reads JPEG from disk', async () => {
    const path = join(tmpdir(), `lyra-vision-jpg-${Date.now()}.jpg`)
    const jpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ])
    writeFileSync(path, jpg)
    const { infer, calls } = fakeVisionInfer()
    const tool = makeVisionAnalyze({ visionInfer: infer, agentDir: '/tmp/lyra-test-agent' })
    const out = await tool.handler({ image_path: path, prompt: 'colour?' })
    expect(out.ok).toBe(true)
    expect(calls[0]!.images[0]!.mediaType).toBe('image/jpeg')
  })

  it('surfaces vision call failure as tool error', async () => {
    const path = join(tmpdir(), `lyra-vision-fail-${Date.now()}.png`)
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const tool = makeVisionAnalyze({
      visionInfer: async () => {
        throw new Error('upstream HTTP 500')
      },
      agentDir: '/tmp/lyra-test-agent',
    })
    const out = await tool.handler({ image_path: path, prompt: 'q' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('vision call failed')
    expect(out.error).toContain('HTTP 500')
  })
})
