import { type GitHubFetchOpts, resolveLatestRelease } from './github-releases'

/** Canonical nebula repo. Override via {@link ResolveNebulaRefOpts.repoUrl}. */
export const NEBULA_REPO_URL = 'https://github.com/rstfulzz/nebula.git'

/** Magic ref keyword that triggers GitHub `releases/latest` resolution. */
export const LATEST_KEYWORD = 'latest'

export interface ResolvedRef {
  ref: string
  /** True if `ref` looks like `vX.Y.Z`. Drives pre/post-flight version verification. */
  isTag: boolean
  /** True if user said `latest` and we resolved via API — caller skips pre-flight (already source of truth). */
  resolvedFromLatest: boolean
}

export interface ResolveNebulaRefOpts extends GitHubFetchOpts {
  repoUrl?: string
  /** Test seam. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
}

const TAG_RE = /^v\d+\.\d+\.\d+/

/**
 * Resolve user ref. Priority: rawRef → NEBULA_BOOTSTRAP_REF env → `latest`.
 * Tag-shaped refs pass through. Branch / SHA refs return isTag=false (no
 * version verification possible).
 */
export async function resolveNebulaRef(
  rawRef: string | undefined,
  opts: ResolveNebulaRefOpts = {},
): Promise<ResolvedRef> {
  const env = opts.env ?? process.env
  const arg = rawRef ?? env.NEBULA_BOOTSTRAP_REF ?? LATEST_KEYWORD

  if (arg === LATEST_KEYWORD) {
    const release = await resolveLatestRelease(opts.repoUrl ?? NEBULA_REPO_URL, opts)
    return { ref: release.tagName, isTag: true, resolvedFromLatest: true }
  }
  if (TAG_RE.test(arg)) {
    return { ref: arg, isTag: true, resolvedFromLatest: false }
  }
  return { ref: arg, isTag: false, resolvedFromLatest: false }
}

/** Pretty form of a ResolvedRef for prompts and outros. Adds `(resolved from latest)` suffix when applicable. */
export function formatResolvedRef(resolved: ResolvedRef): string {
  return resolved.resolvedFromLatest ? `${resolved.ref} (resolved from latest)` : resolved.ref
}

/** Expected `package.json` version for a ResolvedRef, or null when no strict expectation (branch / SHA). */
export function expectedVersionFromRef(resolved: ResolvedRef): string | null {
  return resolved.isTag ? resolved.ref.replace(/^v/, '') : null
}
