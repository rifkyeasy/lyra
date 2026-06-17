/**
 * Builds the bash script the CLI runs via `provider.execInToolbox` after
 * Daytona restores an archived sandbox. The container filesystem is intact
 * (preserved across archive→restore) but every process inside the container
 * was terminated when archive happened. The harness daemon needs to be
 * relaunched.
 *
 * This is a SLIMMED version of `buildBootstrapScript`: no apt-get, no install.
 * Just env-export + fuser-kill + nohup launch + 10s wait for kill -0.
 *
 * Bootstrap-mode-agnostic: the script auto-detects whether the container was
 * bootstrapped via git-clone (gateway at `$HOME/lyra/packages/gateway/bin/`)
 * or via npm (gateway at `~/.bun/install/global/node_modules/.bin/`). Whichever
 * one exists is what we relaunch. Both paths supported indefinitely so legacy
 * git-bootstrapped containers keep working forever after the npm path lands.
 *
 * Returns a single base64-wrapped `bash -c '...'` invocation (under
 * Daytona's 6KB execInToolbox payload cap).
 */
export interface BuildRelaunchScriptOpts {
  sandboxId: string
  operatorAddress: string
  port?: number
  /**
   * Optional override of the heartbeat interval inside the relaunched harness.
   * Pass milliseconds; falls through to the harness's default (30 min) if
   * unset. Used by canary scripts to compress verification windows.
   */
  heartbeatIntervalMs?: number
}

export interface BuildRelaunchScriptResult {
  /** Single-line bash -c invocation safe to pass to execInToolbox. */
  script: string
  /** File the caller can tail to read relaunch progress. */
  progressLogPath: string
  /** File written when relaunch succeeds (line: `lyra-gateway-pid=<N>`). */
  doneMarkerPath: string
  /** File written when relaunch fails. Body contains a short failure keyword. */
  failMarkerPath: string
}

const PROGRESS_LOG = '/tmp/lyra-relaunch-progress.log'
const DONE_MARKER = '/tmp/lyra-relaunch-done'
const FAIL_MARKER = '/tmp/lyra-relaunch-failed'

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export function buildGatewayRelaunchScript(
  opts: BuildRelaunchScriptOpts,
): BuildRelaunchScriptResult {
  const port = opts.port ?? 8080
  const env: string[] = [
    `export SANDBOX_ID=${shQuote(opts.sandboxId)}`,
    `export LYRA_OPERATOR_ADDRESS=${shQuote(opts.operatorAddress)}`,
    `export HARNESS_PORT=${shQuote(String(port))}`,
    "export HARNESS_HOST='0.0.0.0'",
    'export PATH="$HOME/.bun/bin:$PATH"',
  ]
  if (typeof opts.heartbeatIntervalMs === 'number' && opts.heartbeatIntervalMs > 0) {
    env.push(`export HARNESS_HEARTBEAT_INTERVAL_MS=${shQuote(String(opts.heartbeatIntervalMs))}`)
  }

  const inner = [
    'set -u',
    'mkdir -p "$HOME/lyra-logs"',
    `rm -f ${DONE_MARKER} ${FAIL_MARKER} ${PROGRESS_LOG}`,
    `exec > >(tee -a ${PROGRESS_LOG}) 2>&1`,
    'echo "[$(date -u +%FT%TZ)] relaunch-start"',
    // Bootstrap-mode probe. Each container was bootstrapped one of two ways:
    //  - git mode: $HOME/lyra/ has the cloned monorepo
    //  - npm mode: ~/.bun/install/global/node_modules/.bin/lyra-gateway exists
    // Whichever one is present is what we relaunch. If neither, the container
    // snapshot must have lost its install (rare; usually means manual wipe).
    'LYRA_DIR="$HOME/lyra"',
    'GLOBAL_BIN="$HOME/.bun/install/global/node_modules/.bin"',
    'GATEWAY_MODE=""',
    'if [ -x "$GLOBAL_BIN/lyra-gateway" ]; then',
    '  GATEWAY_MODE="npm"',
    '  echo "[mode=npm] launching $GLOBAL_BIN/lyra-gateway"',
    'elif [ -d "$LYRA_DIR" ]; then',
    '  GATEWAY_MODE="git"',
    '  echo "[mode=git] launching bun $LYRA_DIR/packages/gateway/bin/lyra-gateway"',
    'else',
    `  echo "lyra-not-installed" > ${FAIL_MARKER}`,
    '  echo "[fail] no lyra install found at $GLOBAL_BIN/lyra-gateway nor $LYRA_DIR; container snapshot may have been wiped"',
    '  exit 21',
    'fi',
    ...env,
    `fuser -k ${port}/tcp 2>/dev/null || true`,
    'sleep 2',
    'echo "[launch harness daemon]"',
    'launch_gateway() {',
    '  if [ "$GATEWAY_MODE" = "npm" ]; then',
    '    nohup "$GLOBAL_BIN/lyra-gateway" > "$HOME/lyra-logs/lyra-gateway.log" 2>&1 &',
    '  else',
    '    nohup bun "$LYRA_DIR/packages/gateway/bin/lyra-gateway" > "$HOME/lyra-logs/lyra-gateway.log" 2>&1 &',
    '  fi',
    '  HARNESS_PID=$!',
    '  disown',
    '}',
    'HARNESS_PID=""',
    'HARNESS_OK=0',
    'for h_attempt in 1 2 3; do',
    '  echo "[launch attempt $h_attempt/3]"',
    `  fuser -k ${port}/tcp 2>/dev/null || true`,
    '  sleep 1',
    '  launch_gateway',
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
    '  exit 22',
    'fi',
    `echo "lyra-gateway-pid=$HARNESS_PID" > ${DONE_MARKER}`,
    'echo "[$(date -u +%FT%TZ)] relaunch-done pid=$HARNESS_PID mode=$GATEWAY_MODE"',
  ].join('\n')

  // base64-wrapped bash -c so Daytona's argv-only execInToolbox handles it.
  // Note the trailing `& echo` (NOT `& && echo`): `&` is the background operator
  // that fires-and-continues; `&&` after it would be a syntax error.
  const innerB64 = Buffer.from(inner, 'utf8').toString('base64')
  const innerPath = '/tmp/lyra-relaunch-inner.sh'
  const fileWrites = `echo ${shQuote(innerB64)} | base64 -d > ${innerPath} && chmod +x ${innerPath}`
  const launchBody = `${fileWrites} && nohup bash ${innerPath} >/dev/null 2>&1 & echo relaunch-launched`

  return {
    script: `bash -c '${launchBody}'`,
    progressLogPath: PROGRESS_LOG,
    doneMarkerPath: DONE_MARKER,
    failMarkerPath: FAIL_MARKER,
  }
}

export const RELAUNCH_DONE_MARKER = DONE_MARKER
export const RELAUNCH_FAIL_MARKER = FAIL_MARKER
export const RELAUNCH_PROGRESS_LOG = PROGRESS_LOG
export const RELAUNCH_SUCCESS_MARKER_PREFIX = 'lyra-gateway-pid='
