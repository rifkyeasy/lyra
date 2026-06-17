/**
 * In-place upgrade script template. Used by `lyra upgrade` (default flow,
 * v0.17.0+) to swap the harness inside an EXISTING Daytona container rather
 * than re-provisioning a fresh one. Sister of `bootstrap.ts`.
 *
 * Why in-place: per `feedback-lyra-is-unsealed-currently.md`, our Phase 11
 * deployment is unsealed (no image-hash attestation, no TDX-bound signer).
 * Heavy container swap buys no real attestation, only ~0.9 Sui testnet burn
 * per upgrade + 60-90s downtime. In-place buys the same code-rolling-forward
 * for $0 + ~30s downtime. See `decision-upgrade-in-place-default.md`.
 *
 * Two modes (mirror bootstrap.ts):
 *  - 'git' (default): cd $HOME/lyra && git fetch + checkout + bun install
 *  - 'npm': bun add -g lyra-ai-cli@<version> (overwrites global install)
 *
 * Mode is set by the caller, NOT auto-detected (would push the script over
 * Daytona's 5KB request-size cap). The CLI probes the container filesystem
 * upfront and picks the appropriate mode. Cross-mode upgrade (git → npm or
 * npm → git) requires `lyra upgrade --reprovision`.
 *
 * Same Daytona constraints as bootstrap:
 *  - `process/execute` caps each call at ~60s, so the slow work detaches into
 *    a `nohup bash -c '...' &` background subshell.
 *  - Progress via two files: `/tmp/lyra-upgrade-progress.log` (tail-able),
 *    `/tmp/lyra-upgrade-done` (success only, contains harness pid).
 *  - Failure markers in `/tmp/lyra-upgrade-failed` for each step's distinct
 *    failure keyword.
 */

import { BUN_GLOBAL_BIN_SHELL, type BootstrapMode } from './bootstrap'

export interface BuildUpgradeScriptOpts {
  /** Sandbox UUID. Stays the same across upgrade (same container). */
  sandboxId: string
  /** Operator Sui address. Re-exported into harness env. */
  operatorAddress: string
  /**
   * Bootstrap mode of the existing container. CLI should probe this via a
   * small `execInToolbox` call before invoking upgrade (so the upgrade
   * script matches whatever mode the container was originally bootstrapped
   * in). Default is 'npm' (since v0.21.20) as the safer fallback when the
   * probe is bypassed.
   */
  mode?: BootstrapMode
  /**
   * Git mode: tag/branch/SHA to checkout (e.g. 'v0.17.0', 'main', SHA).
   * Npm mode: ignored (use `packageVersion`).
   */
  ref: string
  /**
   * Npm mode: exact published version to install (e.g. '0.21.15').
   * Required when mode='npm'. Ignored in git mode.
   */
  packageVersion?: string
  /**
   * Public git URL of lyra. Defaults to canonical hackathon repo. Re-applied
   * via `git remote set-url origin` so a stale credential-helper URL doesn't
   * break the fetch. (Git mode only.)
   */
  repoUrl?: string
  /** Port the harness binds. Default 8080 (matches bootstrap). */
  port?: number
}

export interface BuildUpgradeScriptResult {
  script: string
  doneMarkerPath: string
  progressLogPath: string
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

const PROGRESS_LOG = '/tmp/lyra-upgrade-progress.log'
const DONE_MARKER = '/tmp/lyra-upgrade-done'
const FAIL_MARKER = '/tmp/lyra-upgrade-failed'

function buildPreambleLines(opts: BuildUpgradeScriptOpts, modeLabel: string): string[] {
  return [
    '#!/bin/bash',
    'set -uo pipefail',
    `exec > ${PROGRESS_LOG} 2>&1`,
    `echo "[$(date -u +%FT%TZ)] upgrade-start (mode=${modeLabel})"`,
    `echo "  ref=${opts.ref}"`,
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
    'export PATH="$HOME/.bun/bin:$PATH"',
  ]
}

function buildRestartLines(opts: BuildUpgradeScriptOpts, gatewayLaunchCmd: string): string[] {
  const port = opts.port ?? 8080
  return [
    '',
    'echo "[restart gateway]"',
    'pkill -f lyra-harness 2>/dev/null || true',
    'pkill -f lyra-gateway 2>/dev/null || true',
    `fuser -k ${port}/tcp 2>/dev/null || true`,
    'sleep 3',
    '',
    // Wipe agent-scoped locks after the prior harness is dead so the new
    // instance starts clean. Insurance for older harness versions whose
    // shutdown didn't await listener teardown and could leak a stale TG
    // bot-token lockfile. See feedback-tg-token-lock-zombie-after-upgrade.md.
    'echo "[clear stale agent locks]"',
    'rm -f "$HOME/.lyra/locks/"*.lock 2>/dev/null || true',
    '',
    `export SANDBOX_ID=${shQuote(opts.sandboxId)}`,
    `export LYRA_OPERATOR_ADDRESS=${shQuote(opts.operatorAddress)}`,
    `export HARNESS_PORT=${shQuote(String(port))}`,
    "export HARNESS_HOST='0.0.0.0'",
    '',
    'mkdir -p "$HOME/lyra-logs"',
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
    '  exit 24',
    'fi',
    `echo "lyra-gateway-pid=$HARNESS_PID" > ${DONE_MARKER}`,
    'echo "[$(date -u +%FT%TZ)] upgrade-done pid=$HARNESS_PID"',
    '',
  ]
}

function buildGitInnerScript(opts: BuildUpgradeScriptOpts): string {
  const repoUrl = opts.repoUrl ?? 'https://github.com/rifkyeasy/lyra.git'
  const preamble = buildPreambleLines(opts, 'git')
  const installLines = [
    `cd "$HOME/lyra" || { echo "lyra-dir-missing" > ${FAIL_MARKER}; exit 20; }`,
    `git remote set-url origin ${shQuote(repoUrl)} 2>/dev/null || true`,
    'git reset --hard HEAD 2>/dev/null || true',
    `retry 'git fetch' git fetch --tags --depth 50 origin || { echo "git-fetch-failed" > ${FAIL_MARKER}; exit 21; }`,
    `retry 'git checkout' git checkout ${shQuote(opts.ref)} || { echo "git-checkout-failed" > ${FAIL_MARKER}; exit 22; }`,
    `retry 'bun deps' bun install --frozen-lockfile || { echo "bun-install-failed" > ${FAIL_MARKER}; exit 23; }`,
    '',
    // doctor-guarded idempotent browser-deps install.
    'echo "[browser deps]"',
    'if node_modules/.bin/agent-browser doctor >/dev/null 2>&1; then',
    '  echo "[browser deps] already installed, skipping"',
    'else',
    `  retry 'browser deps' node_modules/.bin/agent-browser install --with-deps || { echo "browser-install-failed" > ${FAIL_MARKER}; exit 25; }`,
    'fi',
  ]
  const restart = buildRestartLines(opts, 'bun "$HOME/lyra/packages/gateway/bin/lyra-gateway"')
  return [...preamble, ...installLines, ...restart].join('\n')
}

function buildNpmInnerScript(opts: BuildUpgradeScriptOpts): string {
  if (!opts.packageVersion) {
    throw new Error('buildUpgradeScript: packageVersion is required when mode=npm')
  }
  const preamble = buildPreambleLines(opts, 'npm')
  const installLines = [
    `echo "  package=lyra-ai-cli@${opts.packageVersion}"`,
    // Idempotent: same version twice = no-op; new version = clean swap.
    `retry 'lyra install' bun add -g ${shQuote(`lyra-ai-cli@${opts.packageVersion}`)} || { echo "lyra-install-failed" > ${FAIL_MARKER}; exit 21; }`,
    `export PATH="${BUN_GLOBAL_BIN_SHELL}:$PATH"`,
    '',
    'echo "[browser deps]"',
    `if ${BUN_GLOBAL_BIN_SHELL}/agent-browser doctor >/dev/null 2>&1; then`,
    '  echo "[browser deps] already installed, skipping"',
    'else',
    `  retry 'browser deps' ${BUN_GLOBAL_BIN_SHELL}/agent-browser install --with-deps || { echo "browser-install-failed" > ${FAIL_MARKER}; exit 25; }`,
    'fi',
  ]
  const restart = buildRestartLines(opts, `${BUN_GLOBAL_BIN_SHELL}/lyra-gateway`)
  return [...preamble, ...installLines, ...restart].join('\n')
}

export function buildUpgradeScript(opts: BuildUpgradeScriptOpts): BuildUpgradeScriptResult {
  const mode: BootstrapMode = opts.mode ?? 'npm'
  const inner = mode === 'npm' ? buildNpmInnerScript(opts) : buildGitInnerScript(opts)

  const innerPath = '/tmp/lyra-upgrade-inner.sh'
  const innerB64 = Buffer.from(inner).toString('base64')
  const fileWrites = [
    `rm -f ${PROGRESS_LOG} ${DONE_MARKER} ${FAIL_MARKER}`,
    `echo ${innerB64} | base64 -d > ${innerPath}`,
    `chmod +x ${innerPath}`,
  ].join(' && ')
  const launchBody = `${fileWrites} && nohup bash ${innerPath} >/dev/null 2>&1 & echo upgrade-launched`
  const outerScript = `bash -c '${launchBody}'`

  return {
    script: outerScript,
    doneMarkerPath: DONE_MARKER,
    progressLogPath: PROGRESS_LOG,
  }
}

export const UPGRADE_DONE_MARKER = DONE_MARKER
export const UPGRADE_FAIL_MARKER = FAIL_MARKER
export const UPGRADE_PROGRESS_LOG = PROGRESS_LOG
export const UPGRADE_SUCCESS_MARKER_PREFIX = 'lyra-gateway-pid='

/** Substring keywords the inner subshell writes to FAIL_MARKER on failure. */
export const UPGRADE_FAIL_KEYWORDS = [
  'lyra-dir-missing',
  'git-fetch-failed',
  'git-checkout-failed',
  'bun-install-failed',
  'lyra-install-failed',
  'browser-install-failed',
  'harness-died-early',
] as const
