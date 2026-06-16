import type { BootstrapMode } from 'nebula-ai-gateway'

/**
 * Resolve the sandbox bootstrap mode from operator env.
 *
 * Default is `'npm'` since v0.21.20 (~10x faster cold start: `bun add -g
 * nebula-ai-cli@<ver>` finishes in ~30-60s vs ~5-8min for `git clone +
 * bun install`). The npm path was shipped in v0.21.15 and lived as opt-in
 * for several releases before this flip.
 *
 * Resolution order:
 *   1. `NEBULA_BOOTSTRAP_MODE=git|npm` — explicit operator override, wins.
 *   2. `NEBULA_BOOTSTRAP_REF` set without explicit mode → 'git'. The REF env
 *      is a git-mode concept (branch tip / commit SHA); auto-implying git
 *      preserves the existing "deploy main", "deploy <sha>" dev workflows.
 *   3. Otherwise → 'npm'.
 *
 * Callers pass `opts.mode` directly to bypass this resolver entirely.
 */
export function resolveBootstrapMode(env: NodeJS.ProcessEnv = process.env): BootstrapMode {
  if (env.NEBULA_BOOTSTRAP_MODE === 'git') return 'git'
  if (env.NEBULA_BOOTSTRAP_MODE === 'npm') return 'npm'
  if (env.NEBULA_BOOTSTRAP_REF) return 'git'
  return 'npm'
}
