import { describe, expect, it } from 'bun:test'
import { resolveLyraRef } from './ref-resolver'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const latestFetch = (tagName: string) =>
  (() =>
    Promise.resolve(
      jsonResponse(200, {
        tag_name: tagName,
        published_at: '2026-05-03T04:00:00Z',
        html_url: `https://github.com/rifkyeasy/lyra/releases/tag/${tagName}`,
      }),
    )) as unknown as typeof fetch

describe('resolveLyraRef', () => {
  it('defaults to latest when rawRef + env both unset', async () => {
    const r = await resolveLyraRef(undefined, { fetchImpl: latestFetch('v0.17.8'), env: {} })
    expect(r.ref).toBe('v0.17.8')
    expect(r.isTag).toBe(true)
    expect(r.resolvedFromLatest).toBe(true)
  })
  it('resolves explicit "latest" keyword', async () => {
    const r = await resolveLyraRef('latest', { fetchImpl: latestFetch('v0.17.9'), env: {} })
    expect(r.ref).toBe('v0.17.9')
    expect(r.resolvedFromLatest).toBe(true)
  })
  it('passes through tag-shaped ref without API call', async () => {
    let called = false
    const fetchImpl = (() => {
      called = true
      return Promise.resolve(jsonResponse(200, {}))
    }) as unknown as typeof fetch
    const r = await resolveLyraRef('v0.17.8', { fetchImpl, env: {} })
    expect(r.ref).toBe('v0.17.8')
    expect(r.isTag).toBe(true)
    expect(r.resolvedFromLatest).toBe(false)
    expect(called).toBe(false)
  })
  it('passes through branch refs as non-tag', async () => {
    const r = await resolveLyraRef('main', { env: {} })
    expect(r.ref).toBe('main')
    expect(r.isTag).toBe(false)
    expect(r.resolvedFromLatest).toBe(false)
  })
  it('passes through SHA refs as non-tag', async () => {
    const r = await resolveLyraRef('3d6d10f', { env: {} })
    expect(r.ref).toBe('3d6d10f')
    expect(r.isTag).toBe(false)
  })
  it('respects LYRA_BOOTSTRAP_REF env override', async () => {
    let called = false
    const fetchImpl = (() => {
      called = true
      return Promise.resolve(jsonResponse(200, {}))
    }) as unknown as typeof fetch
    const r = await resolveLyraRef(undefined, {
      fetchImpl,
      env: { LYRA_BOOTSTRAP_REF: 'main' },
    })
    expect(r.ref).toBe('main')
    expect(r.isTag).toBe(false)
    expect(called).toBe(false)
  })
  it('rawRef takes priority over env', async () => {
    const r = await resolveLyraRef('v0.17.8', {
      env: { LYRA_BOOTSTRAP_REF: 'main' },
    })
    expect(r.ref).toBe('v0.17.8')
    expect(r.isTag).toBe(true)
  })
})
