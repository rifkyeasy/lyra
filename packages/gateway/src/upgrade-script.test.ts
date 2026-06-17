import { describe, expect, test } from 'bun:test'
import {
  UPGRADE_DONE_MARKER,
  UPGRADE_FAIL_MARKER,
  UPGRADE_PROGRESS_LOG,
  UPGRADE_SUCCESS_MARKER_PREFIX,
  buildUpgradeScript,
} from './upgrade-script'

describe('buildUpgradeScript', () => {
  // baseOpts pins mode='git' so the legacy assertions about git fetch + checkout
  // + bun install retry chains keep exercising the git inner-script. The
  // dedicated "default mode" test below covers the new npm default (flipped in
  // v0.21.20).
  const baseOpts = {
    sandboxId: 'sbx-abc-123',
    operatorAddress: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
    ref: 'v0.17.0',
    mode: 'git' as const,
  }

  // Decodes the base64-baked inner subshell out of the outer `bash -c '...'`
  // wrapper. Most tests assert on the inner script's bash semantics.
  const decodeInner = (opts: Parameters<typeof buildUpgradeScript>[0] = baseOpts): string => {
    const { script } = buildUpgradeScript(opts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    return Buffer.from(m![1]!, 'base64').toString('utf8')
  }

  test('outer wrapper is `bash -c` with base64 inner; no shell metachars in payload', () => {
    const { script, doneMarkerPath, progressLogPath } = buildUpgradeScript(baseOpts)
    expect(script.startsWith("bash -c '")).toBe(true)
    expect(script.endsWith("'")).toBe(true)
    expect(script).toContain('base64 -d')
    expect(script).toContain('nohup bash /tmp/lyra-upgrade-inner.sh')
    expect(script).toContain('echo upgrade-launched')
    expect(doneMarkerPath).toBe(UPGRADE_DONE_MARKER)
    expect(progressLogPath).toBe(UPGRADE_PROGRESS_LOG)
    // Outer payload must contain no nested single-quotes.
    const inside = script.slice("bash -c '".length, -1)
    expect(inside).not.toContain("'")
    // Exactly one `echo BASE64 | base64 -d` pipe in launch body.
    expect(inside.split(' | ').length).toBe(2)
  })

  test('inner subshell carries git fetch + checkout + bun install + harness restart', () => {
    const inner = decodeInner()
    expect(inner).toContain('cd "$HOME/lyra"')
    expect(inner).toContain('git fetch --tags --depth 50 origin')
    expect(inner).toContain(`git checkout '${baseOpts.ref}'`)
    expect(inner).toContain('bun install --frozen-lockfile')
    expect(inner).toContain('pkill -f lyra-gateway')
    expect(inner).toContain('nohup bun "$HOME/lyra/packages/gateway/bin/lyra-gateway"')
    expect(inner).toContain(`echo "lyra-gateway-pid=$HARNESS_PID" > ${UPGRADE_DONE_MARKER}`)
  })

  test('inner subshell does NOT do bootstrap-only steps (apt / clone / bun-binary)', () => {
    const inner = decodeInner()
    expect(inner).not.toContain('apt-get')
    expect(inner).not.toContain('git clone')
    expect(inner).not.toContain('bun.sh/install')
  })

  test('exposes a generic retry() shell function with 3-attempt linear backoff', () => {
    const inner = decodeInner()
    expect(inner).toContain('retry() {')
    expect(inner).toContain('for n in 1 2 3; do')
    expect(inner).toContain('"$@" && return 0')
    expect(inner).toContain('sleep $((n*5))')
  })

  test('git fetch is wrapped in retry()', () => {
    const inner = decodeInner()
    expect(inner).toMatch(
      /retry 'git fetch' git fetch --tags --depth 50 origin \|\| \{ echo "git-fetch-failed"/,
    )
  })

  test('git checkout is wrapped in retry()', () => {
    const inner = decodeInner()
    expect(inner).toMatch(
      /retry 'git checkout' git checkout '[^']+' \|\| \{ echo "git-checkout-failed"/,
    )
  })

  test('bun install is wrapped in retry()', () => {
    const inner = decodeInner()
    expect(inner).toMatch(
      /retry 'bun deps' bun install --frozen-lockfile \|\| \{ echo "bun-install-failed"/,
    )
  })

  test('browser deps step uses doctor-guarded idempotent install after bun deps', () => {
    const inner = decodeInner()
    expect(inner).toContain('[browser deps]')
    expect(inner).toContain('node_modules/.bin/agent-browser doctor')
    expect(inner).toMatch(
      /retry 'browser deps' node_modules\/\.bin\/agent-browser install --with-deps \|\| \{ echo "browser-install-failed"/,
    )
    // Order: bun install runs before browser deps install.
    const bunIdx = inner.indexOf("retry 'bun deps'")
    const browserIdx = inner.indexOf("retry 'browser deps'")
    expect(bunIdx).toBeGreaterThan(0)
    expect(browserIdx).toBeGreaterThan(bunIdx)
  })

  test('clears stale agent locks after killing prior harness, before relaunch', () => {
    const inner = decodeInner()
    // The kill→clear-locks→relaunch ordering is critical: we wipe locks
    // ONLY after the prior harness is dead so we never race a live writer.
    const killIdx = inner.indexOf('pkill -f lyra-gateway')
    const lockIdx = inner.indexOf('rm -f "$HOME/.lyra/locks/"*.lock')
    const launchIdx = inner.indexOf('nohup bun "$HOME/lyra/packages/gateway/bin/lyra-gateway"')
    expect(killIdx).toBeGreaterThan(0)
    expect(lockIdx).toBeGreaterThan(killIdx)
    expect(launchIdx).toBeGreaterThan(lockIdx)
    expect(inner).toContain('[clear stale agent locks]')
  })

  test('frees port 8080 via fuser before AND on each launch attempt', () => {
    const inner = decodeInner()
    // Pre-launch + per-attempt port kill (defensive against zombie bun on rebind)
    expect(
      inner.match(/fuser -k 8080\/tcp 2>\/dev\/null \|\| true/g)?.length,
    ).toBeGreaterThanOrEqual(2)
  })

  test('honors custom port; port-kill uses the same port', () => {
    const inner = decodeInner({ ...baseOpts, port: 9090 })
    expect(inner).toContain('fuser -k 9090/tcp 2>/dev/null || true')
    expect(inner).not.toContain('fuser -k 8080/tcp')
  })

  test('harness launch has 3-attempt retry with 10s startup wait (mirror bootstrap)', () => {
    const inner = decodeInner()
    expect(inner).toContain('for h_attempt in 1 2 3; do')
    expect(inner).toContain('HARNESS_OK=0')
    expect(inner).toContain('HARNESS_OK=1')
    expect(inner).toContain('[launch attempt $h_attempt/3]')
    expect(inner).toMatch(/sleep 10[^\d]/)
    expect(inner).toMatch(/\[retrying in 5s\][\s\S]*sleep 5/)
    expect(inner).toContain('if [ "$HARNESS_OK" -ne 1 ]; then')
    expect(inner).toContain('echo "harness-died-early" >')
  })

  test('inner subshell writes fail marker on each step failure', () => {
    const inner = decodeInner()
    expect(inner).toContain('lyra-dir-missing')
    expect(inner).toContain('git-fetch-failed')
    expect(inner).toContain('git-checkout-failed')
    expect(inner).toContain('bun-install-failed')
    expect(inner).toContain('browser-install-failed')
    expect(inner).toContain('harness-died-early')
    expect(inner).toContain(UPGRADE_FAIL_MARKER)
  })

  test('embeds the requested ref + repo url + sandbox id + operator address', () => {
    const inner = decodeInner({ ...baseOpts, repoUrl: 'https://x.test/foo.git' })
    expect(inner).toContain("'https://x.test/foo.git'")
    expect(inner).toContain(`'${baseOpts.ref}'`)
    expect(inner).toContain(`export SANDBOX_ID='${baseOpts.sandboxId}'`)
    expect(inner).toContain(`export LYRA_OPERATOR_ADDRESS='${baseOpts.operatorAddress}'`)
  })

  test('honors custom port via env export', () => {
    const inner = decodeInner({ ...baseOpts, port: 9090 })
    expect(inner).toContain("export HARNESS_PORT='9090'")
  })

  test('exports the standard harness env vars (HARNESS_HOST, HARNESS_PORT, SANDBOX_ID, LYRA_OPERATOR_ADDRESS)', () => {
    const inner = decodeInner()
    expect(inner).toContain("export HARNESS_HOST='0.0.0.0'")
    expect(inner).toContain("export HARNESS_PORT='8080'")
    expect(inner).toContain(`export SANDBOX_ID='${baseOpts.sandboxId}'`)
    expect(inner).toContain(`export LYRA_OPERATOR_ADDRESS='${baseOpts.operatorAddress}'`)
  })

  test('shell-quotes injection-prone fields safely', () => {
    const inner = decodeInner({ ...baseOpts, sandboxId: "abc'; rm -rf /; echo '" })
    expect(inner).toContain("export SANDBOX_ID='abc'\\''; rm -rf /; echo '\\'''")
  })

  test('exposes UPGRADE_SUCCESS_MARKER_PREFIX matching bootstrap (callers grep done file)', () => {
    expect(UPGRADE_SUCCESS_MARKER_PREFIX).toBe('lyra-gateway-pid=')
  })

  test('outer script stays under Daytona request-size ceiling (<5000 bytes)', () => {
    // Same regression guard as bootstrap.test.ts. v0.16.6 broke at 6136 bytes.
    // Upgrade is leaner than bootstrap so this should sit comfortably ~2300.
    const { script } = buildUpgradeScript(baseOpts)
    expect(script.length).toBeLessThan(5000)
  })

  test('uses $HOME/lyra (matches bootstrap clone target; daytona user has no /opt sudo)', () => {
    const inner = decodeInner()
    expect(inner).toContain('cd "$HOME/lyra"')
    expect(inner).not.toContain('/opt/lyra')
  })

  test('idempotent on dirty working tree (git reset --hard before fetch)', () => {
    const inner = decodeInner()
    expect(inner).toContain('git reset --hard HEAD')
  })

  test('rewrites git remote URL before fetch (defends against stale credential helper)', () => {
    const inner = decodeInner()
    expect(inner).toContain('git remote set-url origin')
  })

  describe('mode=npm', () => {
    const npmOpts = {
      ...baseOpts,
      mode: 'npm' as const,
      packageVersion: '0.21.15',
    }

    test('inner subshell does `bun add -g` instead of git fetch+checkout+bun install', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain("bun add -g 'lyra-ai-cli@0.21.15'")
      expect(inner).not.toContain('git fetch')
      expect(inner).not.toContain('git checkout')
      expect(inner).not.toContain('bun install --frozen-lockfile')
    })

    test('inner subshell launches gateway from global bin', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('nohup $HOME/.bun/install/global/node_modules/.bin/lyra-gateway')
      expect(inner).not.toContain('nohup bun "$HOME/lyra/packages/gateway/bin/lyra-gateway"')
    })

    test('throws when packageVersion is missing for npm mode', () => {
      expect(() => decodeInner({ ...baseOpts, mode: 'npm' })).toThrow(
        /packageVersion is required when mode=npm/,
      )
    })

    test('outer script under 5KB cap (npm path is leaner than git)', () => {
      const { script } = buildUpgradeScript(npmOpts)
      expect(script.length).toBeLessThan(5000)
    })

    test('writes lyra-install-failed marker on bun add failure', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('lyra-install-failed')
    })

    test('mode label is reported in upgrade-start log', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('upgrade-start (mode=npm)')
    })

    test('still does the harness pkill + restart sequence', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('pkill -f lyra-gateway')
      expect(inner).toContain('for h_attempt in 1 2 3; do')
      expect(inner).toContain('clear stale agent locks')
    })
  })

  test('default mode is npm when not specified (flipped in v0.21.20; ~10x faster cold start)', () => {
    const { sandboxId, operatorAddress, ref } = baseOpts
    const inner = decodeInner({ sandboxId, operatorAddress, ref, packageVersion: '0.21.20' })
    expect(inner).toContain('upgrade-start (mode=npm)')
    expect(inner).toContain("bun add -g 'lyra-ai-cli@0.21.20'")
    expect(inner).not.toContain('git fetch')
  })
})
