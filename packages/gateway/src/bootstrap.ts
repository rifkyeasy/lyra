/**
 * Bootstrap script template for first-cold-start of an lyra harness inside
 * a Sui Sandbox container. Returned as a string the init/deploy/upgrade
 * commands feed to `provider-client.execInToolbox(id, { command })`.
 *
 * Two modes:
 *  - 'git': clones the monorepo + bun install. ~5-8 min cold start. Pins to
 *    any branch/SHA.
 *  - 'npm': `bun add -g lyra-ai-cli@<version>`. ~30-60 sec cold start.
 *    Only published versions.
 *
 * Design constraint: the Daytona toolbox `process/execute` endpoint caps each
 * exec call at ~60s. Whatever install path runs blows that easily, so we
 * detach the slow work into a background subshell via `nohup bash -c '...' &`
 * and return exit 0 immediately. Progress is observable via two files:
 *
 *  - `/tmp/lyra-bootstrap-progress.log` (tail-able, line-by-line stages)
 *  - `/tmp/lyra-bootstrap-done` (created only on full success, contains harness pid)
 *
 * The caller (`sandbox-provision.ts`) launches the bootstrap, polls for the
 * `done` marker (then for `/bootstrap/pubkey` from the harness HTTP server).
 *
 * Robustness rules:
 *  - All variables shell-quote-escaped to defeat injection from operator
 *    address or sandbox id (validated upstream, defense-in-depth).
 *  - Git mode: always-clone fresh. Daytona occasionally re-uses post-delete
 *    volumes whose stale git credential helpers break re-fetch.
 *  - Npm mode: `bun add -g lyra-ai-cli@<exact-version>` is idempotent
 *    and overwrites. Same version twice = no-op. Different version = clean
 *    swap. Lower risk than git's stale-credential failure mode.
 */

export type BootstrapMode = 'git' | 'npm'

export interface BuildBootstrapScriptOpts {
  /** Sandbox UUID returned by provider's createSandbox. */
  sandboxId: string
  /** Operator Sui address. Stored in container env, used by `verifyChatSig`. */
  operatorAddress: string
  /**
   * Bootstrap mode. Defaults to 'npm' (since v0.21.20) because it's ~10x
   * faster. Callers in cli/src always pass `mode` explicitly via
   * `resolveBootstrapMode`; this default is defense-in-depth.
   */
  mode?: BootstrapMode
  /**
   * Git mode: tag/branch/SHA to clone (e.g. 'v0.15.0', 'main', or commit SHA).
   * Npm mode: ignored (use `packageVersion`).
   */
  ref: string
  /**
   * Npm mode: the exact published version to install (e.g. '0.21.15').
   * Required when mode='npm'. Ignored in git mode.
   */
  packageVersion?: string
  /**
   * Public git URL of lyra. Defaults to the canonical hackathon repo.
   * Override only when running against a fork / private mirror. (Git mode only.)
   */
  repoUrl?: string
  /** Port the harness binds inside the container. Default 8080. */
  port?: number
  /**
   * Extra `apt-get install` packages. Defaults to xvfb + git + ca-certificates
   * + curl + unzip + psmisc. Caller can append.
   */
  extraAptPackages?: string[]
  /**
   * GitHub PAT for cloning private lyra repos. Embedded in clone URL as
   * `https://x-access-token:TOKEN@github.com/...`. For public repos, leave
   * unset. Token is base64-wrapped inside the inner script (which itself is
   * base64-encoded into the outer command), and the inner script is written
   * to /tmp on the container; ensure the container is single-tenant (Daytona
   * containers are by-operator). Gets cleared from container env after clone.
   * (Git mode only.)
   */
  githubToken?: string
}

export interface BuildBootstrapScriptResult {
  /** Outer script: launches the inner subshell + returns exit 0. ~1s execution. */
  script: string
  /**
   * Path the caller should poll via `execInToolbox(id, { command: cat <path> })`
   * to detect bootstrap completion. Returns success line `lyra-gateway-pid=<N>`
   * once everything is up; absent until then.
   */
  doneMarkerPath: string
  /** Path the caller can tail to surface bootstrap progress. */
  progressLogPath: string
}

/**
 * Quote a string for safe inclusion in a single-quoted bash literal.
 * Single-quoted strings forbid `'`; we escape it as `'\''`.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

const DEFAULT_APT_PACKAGES: readonly string[] = [
  'curl',
  'unzip',
  'ca-certificates',
  'git',
  // psmisc provides `fuser` which the harness launch step uses to free port
  // 8080 if Daytona's snapshot ships a default service squatting on it.
  'psmisc',
  // xvfb retained as headed-browser fallback insurance; agent-browser's
  // installed Chrome-for-Testing runs headless natively but xvfb is cheap
  // (~5MB) and keeps the door open for visual debugging.
  'xvfb',
] as const

const PROGRESS_LOG = '/tmp/lyra-bootstrap-progress.log'
const DONE_MARKER = '/tmp/lyra-bootstrap-done'
const FAIL_MARKER = '/tmp/lyra-bootstrap-failed'

/**
 * Stage marker bodies emitted as `STAGE: <body>` lines into the progress log.
 * Single source of truth for both the script generator (writes them) and the
 * CLI poll loop (reads them via `extractBootstrapProgressLine` and routes to
 * `BootstrapProgressBox`). Strings are prefixes — the apt/lyra/chrome rows
 * append details after a space.
 */
export const BOOTSTRAP_STAGE_MARKERS = {
  aptUpdate: 'updating package index',
  systemDeps: 'installing system deps',
  bunInstall: 'installing bun runtime',
  lyraInstall: 'installing lyra',
  browserDeps: 'installing chrome for browser tools',
  harnessSpawn: 'starting harness daemon',
  harnessReady: 'harness ready',
} as const

/**
 * Shell literal (NOT a Node path). Where Bun symlinks third-party global bins
 * after `bun add -g`. Don't pass to `path.join` — `$HOME` won't expand.
 */
export const BUN_GLOBAL_BIN_SHELL = '$HOME/.bun/install/global/node_modules/.bin'

function buildPreambleLines(
  opts: BuildBootstrapScriptOpts,
  modeLabel: string,
  aptList: string,
): string[] {
  return [
    '#!/bin/bash',
    'set -uo pipefail',
    `exec > ${PROGRESS_LOG} 2>&1`,
    `echo "[$(date -u +%FT%TZ)] bootstrap-start (mode=${modeLabel})"`,
    `echo "  sandbox=${opts.sandboxId}"`,
    'retry() {',
    '  local L=$1; shift',
    '  local n',
    '  for n in 1 2 3; do',
    '    echo "[$L attempt $n/3]"',
    '    "$@" && return 0',
    '    [ $n -lt 3 ] && { echo "[$L failed, retry in $((n*5))s]"; sleep $((n*5)); }',
    '  done',
    '  return 1',
    '}',
    'export DEBIAN_FRONTEND=noninteractive',
    `echo "STAGE: ${BOOTSTRAP_STAGE_MARKERS.aptUpdate}"`,
    `retry 'apt update' sudo -n apt-get update -qq || { echo "apt-update-failed" > ${FAIL_MARKER}; exit 11; }`,
    `echo "STAGE: ${BOOTSTRAP_STAGE_MARKERS.systemDeps} (build-essential, curl, git, xvfb)"`,
    `retry 'apt install' sudo -n apt-get install -y -qq ${aptList} || { echo "apt-install-failed" > ${FAIL_MARKER}; exit 12; }`,
    'install_bun() { curl -fsSL https://bun.sh/install | bash; }',
    'if ! command -v bun >/dev/null 2>&1; then',
    `  echo "STAGE: ${BOOTSTRAP_STAGE_MARKERS.bunInstall}"`,
    `  retry 'bun binary' install_bun || { echo "bun-install-failed" > ${FAIL_MARKER}; exit 13; }`,
    'fi',
    'export PATH="$HOME/.bun/bin:$PATH"',
  ]
}

function buildLaunchLines(opts: BuildBootstrapScriptOpts, gatewayLaunchCmd: string): string[] {
  const port = opts.port ?? 8080
  return [
    'mkdir -p "$HOME/lyra-logs" "$HOME/workspace"',
    '',
    `export SANDBOX_ID=${shQuote(opts.sandboxId)}`,
    `export LYRA_OPERATOR_ADDRESS=${shQuote(opts.operatorAddress)}`,
    `export HARNESS_PORT=${shQuote(String(port))}`,
    "export HARNESS_HOST='0.0.0.0'",
    '',
    `fuser -k ${port}/tcp 2>/dev/null || true`,
    'sleep 2',
    `echo "STAGE: ${BOOTSTRAP_STAGE_MARKERS.harnessSpawn}"`,
    'echo "[launch harness daemon]"',
    'HARNESS_PID=""',
    'HARNESS_OK=0',
    'for h_attempt in 1 2 3; do',
    '  echo "[launch attempt $h_attempt/3]"',
    `  fuser -k ${port}/tcp 2>/dev/null || true`,
    '  sleep 1',
    `  nohup ${gatewayLaunchCmd} > "$HOME/lyra-logs/lyra-gateway.log" 2>&1 &`,
    '  HARNESS_PID=$!',
    '  disown',
    '  sleep 10',
    '  if kill -0 "$HARNESS_PID" 2>/dev/null; then',
    '    HARNESS_OK=1',
    '    break',
    '  fi',
    '  echo "[harness died on attempt $h_attempt, log tail:]"',
    '  tail -n 50 "$HOME/lyra-logs/lyra-gateway.log" 2>/dev/null',
    '  if [ $h_attempt -lt 3 ]; then',
    '    echo "[retrying in 5s]"',
    '    sleep 5',
    '  fi',
    'done',
    'if [ "$HARNESS_OK" -ne 1 ]; then',
    '  echo "[all 3 harness launch attempts failed, full log dump:]"',
    '  tail -n 200 "$HOME/lyra-logs/lyra-gateway.log" 2>/dev/null',
    `  echo "harness-died-early" > ${FAIL_MARKER}`,
    '  exit 18',
    'fi',
    `echo "STAGE: ${BOOTSTRAP_STAGE_MARKERS.harnessReady}"`,
    `echo "lyra-gateway-pid=$HARNESS_PID" > ${DONE_MARKER}`,
    'echo "[$(date -u +%FT%TZ)] bootstrap-done pid=$HARNESS_PID"',
    '',
  ]
}

function buildGitInnerScript(opts: BuildBootstrapScriptOpts, aptList: string): string {
  const repoUrl = opts.repoUrl ?? 'https://github.com/rifkyeasy/lyra.git'
  const cloneUrl = opts.githubToken
    ? repoUrl.replace(
        'https://github.com/',
        `https://x-access-token:${opts.githubToken}@github.com/`,
      )
    : repoUrl
  const preamble = buildPreambleLines(opts, 'git', aptList)
  const installLines = [
    `echo "  ref=${opts.ref}"`,
    `echo "  repo=${repoUrl}"`,
    'LYRA_DIR="$HOME/lyra"',
    `echo "STAGE: ${BOOTSTRAP_STAGE_MARKERS.lyraInstall} (git ${opts.ref})"`,
    `git_clone_one() { rm -rf "$LYRA_DIR"; git clone --depth 1 --branch ${shQuote(opts.ref)} ${shQuote(cloneUrl)} "$LYRA_DIR"; }`,
    `retry 'git clone' git_clone_one || { echo "git-clone-failed" > ${FAIL_MARKER}; exit 14; }`,
    `cd "$LYRA_DIR" && git remote set-url origin ${shQuote(repoUrl)}`,
    `retry 'bun deps' bun install --frozen-lockfile || { echo "bun-install-failed" > ${FAIL_MARKER}; exit 17; }`,
    '',
    // Install Chrome-for-Testing for browser tools. `agent-browser install`
    // pulls a Chromium build + Linux system libs (`--with-deps`). `doctor`
    // exits 0 only when the install state is healthy, so re-runs are no-ops
    // on container restarts that share a persisted volume.
    //
    // Invoked via `node_modules/.bin/agent-browser` directly (not `bunx`)
    // because Daytona's `curl bun.sh/install` install path doesn't always
    // ship a `bunx` symlink.
    `echo "STAGE: ${BOOTSTRAP_STAGE_MARKERS.browserDeps}"`,
    'echo "[browser deps]"',
    'if node_modules/.bin/agent-browser doctor >/dev/null 2>&1; then',
    '  echo "[browser deps] already installed, skipping"',
    'else',
    `  retry 'browser deps' node_modules/.bin/agent-browser install --with-deps || { echo "browser-install-failed" > ${FAIL_MARKER}; exit 19; }`,
    'fi',
    '',
  ]
  const launch = buildLaunchLines(opts, 'bun "$LYRA_DIR/packages/gateway/bin/lyra-gateway"')
  return [...preamble, ...installLines, ...launch].join('\n')
}

function buildNpmInnerScript(opts: BuildBootstrapScriptOpts, aptList: string): string {
  if (!opts.packageVersion) {
    throw new Error('buildBootstrapScript: packageVersion is required when mode=npm')
  }
  const preamble = buildPreambleLines(opts, 'npm', aptList)
  const installLines = [
    `echo "  package=lyra-ai-cli@${opts.packageVersion}"`,
    `echo "STAGE: ${BOOTSTRAP_STAGE_MARKERS.lyraInstall} (${opts.packageVersion})"`,
    // Install lyra from npm. `bun add -g <pkg>@<exact-version>` is idempotent
    // and overwrites whatever is in the global store. Atomic on success; on
    // failure the prior version remains (which may be empty on a fresh container).
    `retry 'lyra install' bun add -g ${shQuote(`lyra-ai-cli@${opts.packageVersion}`)} || { echo "lyra-install-failed" > ${FAIL_MARKER}; exit 14; }`,
    // Add Bun's global package binaries to PATH so lyra-gateway + agent-browser
    // resolve. ~/.bun/bin only contains bun's own binary, NOT third-party global
    // package bins (those live at ~/.bun/install/global/node_modules/.bin/).
    `export PATH="${BUN_GLOBAL_BIN_SHELL}:$PATH"`,
    '',
    // Browser deps (Chrome-for-Testing + Linux libs) installed via the global
    // agent-browser binary. `doctor` is the idempotent guard.
    `echo "STAGE: ${BOOTSTRAP_STAGE_MARKERS.browserDeps}"`,
    'echo "[browser deps]"',
    `if ${BUN_GLOBAL_BIN_SHELL}/agent-browser doctor >/dev/null 2>&1; then`,
    '  echo "[browser deps] already installed, skipping"',
    'else',
    `  retry 'browser deps' ${BUN_GLOBAL_BIN_SHELL}/agent-browser install --with-deps || { echo "browser-install-failed" > ${FAIL_MARKER}; exit 19; }`,
    'fi',
    '',
  ]
  const launch = buildLaunchLines(opts, `${BUN_GLOBAL_BIN_SHELL}/lyra-gateway`)
  return [...preamble, ...installLines, ...launch].join('\n')
}

export function buildBootstrapScript(opts: BuildBootstrapScriptOpts): BuildBootstrapScriptResult {
  const mode: BootstrapMode = opts.mode ?? 'npm'
  const aptPkgs = [...DEFAULT_APT_PACKAGES, ...(opts.extraAptPackages ?? [])]
  const aptList = [...new Set(aptPkgs)].join(' ')
  const inner =
    mode === 'npm' ? buildNpmInnerScript(opts, aptList) : buildGitInnerScript(opts, aptList)

  // Daytona's `process/execute` API does NOT run via a shell — it splits the
  // command string argv-style. Heredocs / pipes / `>` redirects fail because
  // they're passed as literal args to the first binary. To run our complex
  // inner script we base64-encode it (yields only [A-Za-z0-9+/=], no shell
  // metachars) and have `bash -c '...'` decode + write + launch. The single-
  // quoted bash -c wrapper has no internal quotes to escape.
  //
  // Sequencing rules:
  //   - File-write steps chain with `&&` (must succeed in order).
  //   - `nohup ... &` sends the inner script to background. After `&` you
  //     CANNOT use `&&` (syntax error: `& && X`) so we use `;` to follow up
  //     with the success marker echo. The launching shell exits ~instantly.
  const innerPath = '/tmp/lyra-bootstrap-inner.sh'
  const innerB64 = Buffer.from(inner).toString('base64')
  const fileWrites = [
    `rm -f ${PROGRESS_LOG} ${DONE_MARKER} ${FAIL_MARKER}`,
    `echo ${innerB64} | base64 -d > ${innerPath}`,
    `chmod +x ${innerPath}`,
  ].join(' && ')
  const launchBody = `${fileWrites} && nohup bash ${innerPath} >/dev/null 2>&1 & echo bootstrap-launched`
  const outerScript = `bash -c '${launchBody}'`

  return {
    script: outerScript,
    doneMarkerPath: DONE_MARKER,
    progressLogPath: PROGRESS_LOG,
  }
}

export const BOOTSTRAP_DONE_MARKER = DONE_MARKER
export const BOOTSTRAP_FAIL_MARKER = FAIL_MARKER
export const BOOTSTRAP_PROGRESS_LOG = PROGRESS_LOG
export const BOOTSTRAP_SUCCESS_MARKER_PREFIX = 'lyra-gateway-pid='

/**
 * The exact strings the inner subshell writes to FAIL_MARKER on each step
 * failure. Kept in sync with the per-step `echo "X-failed"` calls inside
 * `buildBootstrapScript`. Pollers compare via substring match (the marker
 * file may also contain bash setlocale warnings).
 */
export const BOOTSTRAP_FAIL_KEYWORDS = [
  'apt-update-failed',
  'apt-install-failed',
  'bun-install-failed',
  'git-clone-failed',
  'lyra-install-failed',
  'browser-install-failed',
  'harness-died-early',
] as const
