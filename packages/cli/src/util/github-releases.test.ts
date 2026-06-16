import { describe, expect, it } from 'bun:test'
import { checkTagExists, parseGitHubRepoUrl, resolveLatestRelease } from './github-releases'

describe('parseGitHubRepoUrl', () => {
  it('handles https URL with .git suffix', () => {
    expect(parseGitHubRepoUrl('https://github.com/rstfulzz/nebula.git')).toEqual({
      owner: 'rstfulzz',
      repo: 'nebula',
    })
  })
  it('handles https URL without .git suffix', () => {
    expect(parseGitHubRepoUrl('https://github.com/rstfulzz/nebula')).toEqual({
      owner: 'rstfulzz',
      repo: 'nebula',
    })
  })
  it('handles SSH URL form', () => {
    expect(parseGitHubRepoUrl('git@github.com:rstfulzz/nebula.git')).toEqual({
      owner: 'rstfulzz',
      repo: 'nebula',
    })
  })
  it('throws on unparseable URL', () => {
    expect(() => parseGitHubRepoUrl('not-a-url')).toThrow(/cannot parse/)
    expect(() => parseGitHubRepoUrl('https://gitlab.com/foo/bar.git')).toThrow(/cannot parse/)
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('resolveLatestRelease', () => {
  it('parses 200 response into GitHubRelease', async () => {
    const fetchImpl = ((url: string) => {
      expect(url).toBe('https://api.github.com/repos/rstfulzz/nebula/releases/latest')
      return Promise.resolve(
        jsonResponse(200, {
          tag_name: 'v0.17.8',
          published_at: '2026-05-03T04:00:00Z',
          html_url: 'https://github.com/rstfulzz/nebula/releases/tag/v0.17.8',
        }),
      )
    }) as unknown as typeof fetch
    const r = await resolveLatestRelease('https://github.com/rstfulzz/nebula.git', { fetchImpl })
    expect(r.tagName).toBe('v0.17.8')
    expect(r.publishedAt).toBe('2026-05-03T04:00:00Z')
    expect(r.htmlUrl).toBe('https://github.com/rstfulzz/nebula/releases/tag/v0.17.8')
  })
  it('throws on 404 (no releases yet)', async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(404, { message: 'Not Found' }))) as unknown as typeof fetch
    await expect(
      resolveLatestRelease('https://github.com/rstfulzz/nebula.git', { fetchImpl }),
    ).rejects.toThrow(/no published releases/)
  })
  it('throws on 500', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('server error', { status: 500 }))) as unknown as typeof fetch
    await expect(
      resolveLatestRelease('https://github.com/rstfulzz/nebula.git', { fetchImpl }),
    ).rejects.toThrow(/GitHub API 500/)
  })
  it('passes timeout signal to fetch', async () => {
    let captured: RequestInit | undefined
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      captured = init
      return Promise.resolve(
        jsonResponse(200, { tag_name: 'v1', published_at: 'x', html_url: 'y' }),
      )
    }) as unknown as typeof fetch
    await resolveLatestRelease('https://github.com/rstfulzz/nebula.git', {
      fetchImpl,
      timeoutMs: 1234,
    })
    expect(captured?.signal).toBeDefined()
  })
})

describe('checkTagExists', () => {
  it('returns true on 200', async () => {
    const fetchImpl = ((url: string) => {
      expect(url).toBe('https://api.github.com/repos/rstfulzz/nebula/git/refs/tags/v0.17.8')
      return Promise.resolve(jsonResponse(200, { ref: 'refs/tags/v0.17.8' }))
    }) as unknown as typeof fetch
    expect(
      await checkTagExists('https://github.com/rstfulzz/nebula.git', 'v0.17.8', { fetchImpl }),
    ).toBe(true)
  })
  it('returns false on 404', async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(404, { message: 'Not Found' }))) as unknown as typeof fetch
    expect(
      await checkTagExists('https://github.com/rstfulzz/nebula.git', 'v9.99.99', { fetchImpl }),
    ).toBe(false)
  })
  it('throws on 500', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('server error', { status: 500 }))) as unknown as typeof fetch
    await expect(
      checkTagExists('https://github.com/rstfulzz/nebula.git', 'v0.17.8', { fetchImpl }),
    ).rejects.toThrow(/GitHub API 500/)
  })
  it('url-encodes tag with special characters', async () => {
    let captured = ''
    const fetchImpl = ((url: string) => {
      captured = url
      return Promise.resolve(jsonResponse(200, { ref: 'x' }))
    }) as unknown as typeof fetch
    await checkTagExists('https://github.com/rstfulzz/nebula.git', 'v0.17.8+build', { fetchImpl })
    expect(captured).toContain('v0.17.8%2Bbuild')
  })
})
