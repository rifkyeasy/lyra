import type { SkillRef } from './types'

/**
 * Match a comma-separated glob list (`*.test.ts,*.spec.ts`) against an
 * absolute path. Globs are matched against the basename and against the
 * trailing path segment (e.g. `tests/foo.spec.ts` matches `tests/*.spec.ts`).
 */
export function matchFilePattern(pattern: string, absPath: string): boolean {
  const globs = pattern
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (globs.length === 0) return false
  const basename = absPath.split('/').pop() ?? absPath
  for (const g of globs) {
    if (globToRegex(g).test(basename) || globToRegex(g).test(absPath)) return true
  }
  return false
}

export function matchBashPattern(pattern: string, command: string): boolean {
  try {
    return new RegExp(pattern).test(command)
  } catch {
    return false
  }
}

/**
 * Find skills whose triggers match the given tool call. Returns the matched
 * skills paired with the reason (so the brain sees "auto-loaded by file
 * pattern" or "auto-loaded by bash pattern" in the injected context).
 */
export interface SkillTriggerMatch {
  skill: SkillRef
  reason: 'filePattern' | 'bashPattern'
}

export function matchTriggers(
  call: { name: string; args: unknown },
  skills: readonly SkillRef[],
): SkillTriggerMatch[] {
  const args = (call.args ?? {}) as { path?: unknown; command?: unknown }
  const matches: SkillTriggerMatch[] = []
  if (
    typeof args.path === 'string' &&
    (call.name === 'fs.read' || call.name === 'fs.write' || call.name === 'fs.patch')
  ) {
    collectFilePatternMatches(args.path, skills, matches)
  }
  if (typeof args.command === 'string' && call.name === 'shell.run') {
    collectBashPatternMatches(args.command, skills, matches)
  }
  return matches
}

function collectFilePatternMatches(
  path: string,
  skills: readonly SkillRef[],
  matches: SkillTriggerMatch[],
): void {
  for (const skill of skills) {
    const fp = skill.frontmatter.filePattern
    if (fp && matchFilePattern(fp, path)) {
      matches.push({ skill, reason: 'filePattern' })
    }
  }
}

function collectBashPatternMatches(
  command: string,
  skills: readonly SkillRef[],
  matches: SkillTriggerMatch[],
): void {
  for (const skill of skills) {
    const bp = skill.frontmatter.bashPattern
    if (bp && matchBashPattern(bp, command)) {
      matches.push({ skill, reason: 'bashPattern' })
    }
  }
}

function globToRegex(glob: string): RegExp {
  let pat = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') pat += '.*'
    else if (c === '?') pat += '.'
    else if (c === '.') pat += '\\.'
    else if (c === '/') pat += '/'
    else pat += c
  }
  return new RegExp(`^${pat}$`)
}
