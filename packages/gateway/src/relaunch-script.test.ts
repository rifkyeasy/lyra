import { describe, expect, test } from 'bun:test'
import {
  RELAUNCH_DONE_MARKER,
  RELAUNCH_FAIL_MARKER,
  RELAUNCH_PROGRESS_LOG,
  RELAUNCH_SUCCESS_MARKER_PREFIX,
  buildGatewayRelaunchScript,
} from './relaunch-script'

describe('buildGatewayRelaunchScript', () => {
  const baseOpts = {
    sandboxId: 'sbx-abc-123',
    operatorAddress: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
  }

  const decodeInner = (
    opts: Parameters<typeof buildGatewayRelaunchScript>[0] = baseOpts,
  ): string => {
    const { script } = buildGatewayRelaunchScript(opts)
    const m = script.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)
    return Buffer.from(m![1]!, 'base64').toString('utf8')
  }

  test('outer wrapper is `bash -c` with base64 inner', () => {
    const { script, doneMarkerPath, failMarkerPath, progressLogPath } =
      buildGatewayRelaunchScript(baseOpts)
    expect(script.startsWith("bash -c '")).toBe(true)
    expect(script.endsWith("'")).toBe(true)
    expect(script).toContain('base64 -d')
    expect(script).toContain('nohup bash /tmp/lyra-relaunch-inner.sh')
    expect(script).toContain('echo relaunch-launched')
    expect(doneMarkerPath).toBe(RELAUNCH_DONE_MARKER)
    expect(failMarkerPath).toBe(RELAUNCH_FAIL_MARKER)
    expect(progressLogPath).toBe(RELAUNCH_PROGRESS_LOG)
  })

  test('exposes RELAUNCH_SUCCESS_MARKER_PREFIX matching success line', () => {
    expect(RELAUNCH_SUCCESS_MARKER_PREFIX).toBe('lyra-gateway-pid=')
    const inner = decodeInner()
    expect(inner).toContain(`echo "${RELAUNCH_SUCCESS_MARKER_PREFIX}$HARNESS_PID" >`)
  })

  test('auto-detects bootstrap mode by probing filesystem (no hard $HOME/lyra check)', () => {
    const inner = decodeInner()
    // Probe checks both modes BEFORE hard-failing.
    expect(inner).toContain('if [ -x "$GLOBAL_BIN/lyra-gateway" ]; then')
    expect(inner).toContain('GATEWAY_MODE="npm"')
    expect(inner).toContain('elif [ -d "$LYRA_DIR" ]; then')
    expect(inner).toContain('GATEWAY_MODE="git"')
    // Only fails when NEITHER install is present.
    expect(inner).toContain('echo "lyra-not-installed"')
  })

  test('launch_gateway function picks the right binary per detected mode', () => {
    const inner = decodeInner()
    expect(inner).toContain('launch_gateway() {')
    expect(inner).toContain('if [ "$GATEWAY_MODE" = "npm" ]; then')
    expect(inner).toContain('nohup "$GLOBAL_BIN/lyra-gateway"')
    expect(inner).toContain('nohup bun "$LYRA_DIR/packages/gateway/bin/lyra-gateway"')
  })

  test('legacy "lyra-dir-missing" failure keyword removed in favor of "lyra-not-installed"', () => {
    const inner = decodeInner()
    expect(inner).not.toContain('lyra-dir-missing')
    expect(inner).toContain('lyra-not-installed')
  })

  test('honors custom port', () => {
    const inner = decodeInner({ ...baseOpts, port: 9090 })
    expect(inner).toContain("export HARNESS_PORT='9090'")
    expect(inner).toContain('fuser -k 9090/tcp')
  })

  test('exports heartbeat interval when provided', () => {
    const inner = decodeInner({ ...baseOpts, heartbeatIntervalMs: 5000 })
    expect(inner).toContain("export HARNESS_HEARTBEAT_INTERVAL_MS='5000'")
  })

  test('omits heartbeat env var when not provided (uses harness default)', () => {
    const inner = decodeInner()
    expect(inner).not.toContain('HARNESS_HEARTBEAT_INTERVAL_MS')
  })

  test('three-attempt retry loop wraps gateway launch', () => {
    const inner = decodeInner()
    expect(inner).toContain('for h_attempt in 1 2 3; do')
    expect(inner).toContain('HARNESS_OK=0')
    expect(inner).toContain('HARNESS_OK=1')
  })

  test('mode label appears in relaunch-done log', () => {
    const inner = decodeInner()
    expect(inner).toContain('relaunch-done pid=$HARNESS_PID mode=$GATEWAY_MODE')
  })

  test('shell-quotes injection-prone fields safely', () => {
    const inner = decodeInner({ ...baseOpts, sandboxId: "abc'; rm -rf /; echo '" })
    expect(inner).toContain("export SANDBOX_ID='abc'\\''; rm -rf /; echo '\\'''")
  })
})
