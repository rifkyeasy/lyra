/**
 * Dangerous command pattern set ported from hermes-agent/tools/approval.py.
 * Pattern matching is the cheap pre-LLM safety floor for `shell.run` and
 * destructive shell-equivalent tool args. Brain still needs explicit approval
 * for matches in `prompt` mode, but YOLO mode (`approvals.mode = "off"`) skips.
 *
 * Patterns adapted to JS regex flavor (no \b on hex/utf, no DOTALL by default).
 * Each entry returns the human description used in approval prompts.
 */

const SENSITIVE_WRITE_TARGETS =
  '/etc/[a-z]|/etc/passwd|/etc/shadow|/etc/sudoers|/boot/|/usr/local/etc/'

export const DANGEROUS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\s+(-[^\s]*\s+)*\//, 'delete in root path'],
  [/\brm\s+-[^\s]*r/, 'recursive delete'],
  [/\brm\s+--recursive\b/, 'recursive delete (long flag)'],
  [/\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b/, 'world/other-writable permissions'],
  [/\bchown\s+(-[^\s]*)?R\s+root/, 'recursive chown to root'],
  [/\bmkfs\b/, 'format filesystem'],
  [/\bdd\s+.*if=/, 'disk copy'],
  [/>\s*\/dev\/sd/, 'write to block device'],
  [/\bDROP\s+(TABLE|DATABASE)\b/i, 'SQL DROP'],
  [/\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, 'SQL DELETE without WHERE'],
  [/\bTRUNCATE\s+(TABLE)?\s*\w/i, 'SQL TRUNCATE'],
  [/>\s*\/etc\//, 'overwrite system config'],
  [/\bsystemctl\s+(stop|disable|mask)\b/, 'stop/disable system service'],
  [/\bkill\s+-9\s+-1\b/, 'kill all processes'],
  [/\bpkill\s+-9\b/, 'force kill processes'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  [/\b(bash|sh|zsh|ksh)\s+-[^\s]*c(\s+|$)/, 'shell command via -c/-lc flag'],
  [/\b(python[23]?|perl|ruby|node)\s+-[ec]\s+/, 'script execution via -e/-c flag'],
  [/\b(curl|wget)\b.*\|\s*(ba)?sh\b/, 'pipe remote content to shell'],
  [
    /\b(bash|sh|zsh|ksh)\s+<\s*<?\s*\(\s*(curl|wget)\b/,
    'execute remote script via process substitution',
  ],
  [new RegExp(`\\btee\\b.*["']?(${SENSITIVE_WRITE_TARGETS})`), 'overwrite system file via tee'],
  [new RegExp(`>>?\\s*["']?(${SENSITIVE_WRITE_TARGETS})`), 'overwrite system file via redirection'],
  [/\bxargs\s+.*\brm\b/, 'xargs with rm'],
  [/\bfind\b.*-exec\s+(\/\S*\/)?rm\b/, 'find -exec rm'],
  [/\bfind\b.*-delete\b/, 'find -delete'],
  // Self-termination protection
  [/\b(pkill|killall)\b.*\b(lyra|cli\.ts|lyra\/bin)\b/, 'kill lyra process (self-termination)'],
  [/\bkill\b.*\$\(\s*pgrep\b/, 'kill process via pgrep expansion (self-termination)'],
  [/\bkill\b.*`\s*pgrep\b/, 'kill process via backtick pgrep expansion (self-termination)'],
  [/\b(cp|mv|install)\b.*\s\/etc\//, 'copy/move file into /etc/'],
  [/\bsed\s+-[^\s]*i.*\s\/etc\//, 'in-place edit of system config'],
  [/\bsed\s+--in-place\b.*\s\/etc\//, 'in-place edit of system config (long flag)'],
  [/\b(python[23]?|perl|ruby|node)\s+<</, 'script execution via heredoc'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard (destroys uncommitted changes)'],
  [/\bgit\s+push\b.*--force\b/, 'git force push (rewrites remote history)'],
  [/\bgit\s+push\b.*\s-f\b/, 'git force push short flag (rewrites remote history)'],
  [/\bgit\s+clean\s+-[^\s]*f/, 'git clean with force (deletes untracked files)'],
  [/\bgit\s+branch\s+-D\b/, 'git branch force delete'],
  [/\bchmod\s+\+x\b.*[;&|]+\s*\.\//, 'chmod +x followed by immediate execution'],
] as const

export interface DangerousMatch {
  match: true
  key: string
  description: string
}

export interface NoMatch {
  match: false
}

/**
 * Pre-compiled case-insensitive twin of every pattern. `detectDangerousCommand`
 * runs on the hot path of every shell.run; building 35 RegExp objects per call
 * was visible in profiles. Compile once at module load, reuse forever.
 */
const COMPILED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = DANGEROUS_PATTERNS.map(
  ([pattern, description]) =>
    [
      pattern.flags.includes('i') ? pattern : new RegExp(pattern.source, `${pattern.flags}i`),
      description,
    ] as const,
)

/**
 * Normalize a command before pattern matching: strip ANSI sequences, NULs,
 * and Unicode lookalikes (NFKC). Mirrors hermes' defense-in-depth so
 * obfuscation tricks don't bypass detection. The patterns below intentionally
 * include the control characters they detect, hence the noControlCharactersInRegex
 * suppressions.
 */
function normalize(command: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI matcher
  const ansi = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|P[^\x1B]*\x1B\\)/g
  let s = command.replace(ansi, '')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional NUL stripping
  s = s.replace(/\x00/g, '')
  s = s.normalize('NFKC')
  return s
}

export function detectDangerousCommand(command: string): DangerousMatch | NoMatch {
  const norm = normalize(command).toLowerCase()
  for (const [re, description] of COMPILED_PATTERNS) {
    if (re.test(norm)) return { match: true, key: description, description }
  }
  return { match: false }
}
