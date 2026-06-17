// GitHub Releases API helpers. Unauthenticated (60 req/hr per IP) which is
// plenty for the upgrade hot path: one resolveLatestRelease + zero-or-one
// checkTagExists per invocation. Pin `--ref vX.Y.Z` to skip the API entirely.
export interface GitHubRelease {
  tagName: string
  publishedAt: string
  htmlUrl: string
}

export interface GitHubFetchOpts {
  /** Override fetch (mainly for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Per-call timeout. Defaults to 10s. */
  timeoutMs?: number
}

/**
 * Parse `https://github.com/owner/repo.git`, `https://github.com/owner/repo`,
 * or `git@github.com:owner/repo.git` into `{owner, repo}`. Throws on shapes
 * the regex doesn't recognize.
 */
export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
  if (!match || !match[1] || !match[2]) throw new Error(`cannot parse GitHub repo URL: ${url}`)
  return { owner: match[1], repo: match[2] }
}

/**
 * Resolve the most recent published GitHub release for a repo. Skips drafts
 * and pre-releases (that's what GitHub's `/releases/latest` endpoint returns
 * by default). Throws on 404 (no published release) or non-200.
 */
export async function resolveLatestRelease(
  repoUrl: string,
  opts: GitHubFetchOpts = {},
): Promise<GitHubRelease> {
  const { owner, repo } = parseGitHubRepoUrl(repoUrl)
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 10_000
  const r = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (r.status === 404) {
    throw new Error(`no published releases found for ${owner}/${repo}`)
  }
  if (!r.ok) {
    throw new Error(`GitHub API ${r.status} for ${owner}/${repo}/releases/latest`)
  }
  const data = (await r.json()) as { tag_name: string; published_at: string; html_url: string }
  return { tagName: data.tag_name, publishedAt: data.published_at, htmlUrl: data.html_url }
}

/**
 * Probe whether a tag exists on the remote. Returns `false` on 404 (the
 * conventional "tag not found" signal), `true` on 200, throws on other
 * errors so callers can surface "API down" vs "tag missing" distinctly.
 */
export async function checkTagExists(
  repoUrl: string,
  tag: string,
  opts: GitHubFetchOpts = {},
): Promise<boolean> {
  const { owner, repo } = parseGitHubRepoUrl(repoUrl)
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 10_000
  const r = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/git/refs/tags/${encodeURIComponent(tag)}`,
    {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    },
  )
  if (r.status === 404) return false
  if (!r.ok) {
    throw new Error(`GitHub API ${r.status} for ${owner}/${repo}/git/refs/tags/${tag}`)
  }
  return true
}
