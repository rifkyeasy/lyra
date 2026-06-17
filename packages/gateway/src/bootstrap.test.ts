import { describe, expect, test } from 'bun:test'
import {
  BOOTSTRAP_DONE_MARKER,
  BOOTSTRAP_FAIL_MARKER,
  BOOTSTRAP_PROGRESS_LOG,
  BOOTSTRAP_SUCCESS_MARKER_PREFIX,
  buildBootstrapScript,
} from './bootstrap'

describe('buildBootstrapScript', () => {
  // baseOpts pins mode='git' so the legacy assertions about apt + git clone +
  // bun install retry chains keep exercising the git inner-script. The dedicated
  // "default mode" test below covers the new npm default.
  const baseOpts = {
    sandboxId: 'sbx-abc-123',
    operatorAddress: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
    ref: 'v0.15.0',
    mode: 'git' as const,
  }

  // Decodes the base64-baked inner subshell out of the outer `bash -c '...'`
  // wrapper. Most tests assert on the inner script's bash semantics.
  const decodeInner = (opts: Parameters<typeof buildBootstrapScript>[0] = baseOpts) => {
    const { script } = buildBootstrapScript(opts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    return Buffer.from(m![1]!, 'base64').toString('utf8')
  }

  test('outer wrapper is `bash -c` with base64 inner; no shell metachars in payload', () => {
    const { script, doneMarkerPath, progressLogPath } = buildBootstrapScript(baseOpts)
    expect(script.startsWith("bash -c '")).toBe(true)
    expect(script.endsWith("'")).toBe(true)
    expect(script).toContain('base64 -d')
    expect(script).toContain('nohup bash /tmp/lyra-bootstrap-inner.sh')
    expect(script).toContain('echo bootstrap-launched')
    expect(doneMarkerPath).toBe(BOOTSTRAP_DONE_MARKER)
    expect(progressLogPath).toBe(BOOTSTRAP_PROGRESS_LOG)
    // The outer payload (between the bash -c quotes) must not contain nested
    // single quotes that would prematurely close the wrapper.
    const inside = script.slice("bash -c '".length, -1)
    expect(inside).not.toContain("'")
    // Exactly one `echo BASE64 | base64 -d` pipe in the launch body.
    expect(inside.split(' | ').length).toBe(2)
  })

  test('inner subshell (base64-decoded) carries apt + bun + git + harness launch', () => {
    const inner = decodeInner()
    expect(inner).toContain('sudo -n apt-get update -qq')
    expect(inner).toMatch(/sudo -n apt-get install -y -qq .*xvfb/)
    expect(inner).toContain('curl -fsSL https://bun.sh/install')
    expect(inner).toContain('git clone --depth 1 --branch')
    expect(inner).toContain('bun install --frozen-lockfile')
    expect(inner).toContain('nohup bun "$LYRA_DIR/packages/gateway/bin/lyra-gateway"')
    expect(inner).toContain(`echo "lyra-gateway-pid=$HARNESS_PID" > ${BOOTSTRAP_DONE_MARKER}`)
  })

  test('frees port 8080 via fuser before harness launch (Daytona snapshot guard)', () => {
    const inner = decodeInner()
    // Pre-launch + per-attempt port kill (defensive against pre-existing service or zombie bun)
    expect(
      inner.match(/fuser -k 8080\/tcp 2>\/dev\/null \|\| true/g)?.length,
    ).toBeGreaterThanOrEqual(2)
    // psmisc apt package required for fuser
    expect(inner).toMatch(/sudo -n apt-get install .* psmisc/)
  })

  test('honors custom port — port-kill uses the same port', () => {
    const inner = decodeInner({ ...baseOpts, port: 9090 })
    expect(inner).toContain('fuser -k 9090/tcp 2>/dev/null || true')
    expect(inner).not.toContain('fuser -k 8080/tcp')
  })

  test('harness launch has 3-attempt retry with 10s startup wait (bun cold-start jitter)', () => {
    const inner = decodeInner()
    expect(inner).toContain('for h_attempt in 1 2 3; do')
    expect(inner).toContain('HARNESS_OK=0')
    expect(inner).toContain('HARNESS_OK=1')
    expect(inner).toContain('[launch attempt $h_attempt/3]')
    // Initial wait bumped from 3s to 10s to absorb bun cold-start jitter
    expect(inner).toMatch(/sleep 10[^\d]/)
    // 5s backoff between attempts.
    expect(inner).toMatch(/\[retrying in 5s\][\s\S]*sleep 5/)
    // Failure marker still written if all 3 fail.
    expect(inner).toContain('if [ "$HARNESS_OK" -ne 1 ]; then')
    expect(inner).toContain('echo "harness-died-early" >')
  })

  test('exposes a generic retry() shell function with 3-attempt linear backoff', () => {
    const inner = decodeInner()
    expect(inner).toContain('retry() {')
    expect(inner).toContain('for n in 1 2 3; do')
    expect(inner).toContain('"$@" && return 0')
    expect(inner).toContain('sleep $((n*5))')
  })

  test('apt update is wrapped in retry() (mirror 5xx / dpkg-lock resilience)', () => {
    const inner = decodeInner()
    expect(inner).toMatch(
      /retry 'apt update' sudo -n apt-get update -qq \|\| \{ echo "apt-update-failed"/,
    )
  })

  test('apt install is wrapped in retry() (mirror 5xx / dpkg-lock resilience)', () => {
    const inner = decodeInner()
    expect(inner).toMatch(
      /retry 'apt install' sudo -n apt-get install -y -qq .*\|\| \{ echo "apt-install-failed"/,
    )
  })

  test('bun binary install is wrapped in retry() (bun.sh redirect blip resilience)', () => {
    const inner = decodeInner()
    expect(inner).toContain('install_bun() { curl -fsSL https://bun.sh/install | bash; }')
    expect(inner).toMatch(/retry 'bun binary' install_bun \|\| \{ echo "bun-install-failed"/)
  })

  test('bun deps install is wrapped in retry() (npm registry hiccup resilience)', () => {
    const inner = decodeInner()
    expect(inner).toMatch(
      /retry 'bun deps' bun install --frozen-lockfile \|\| \{ echo "bun-install-failed"/,
    )
  })

  test('git clone is wrapped in retry() with workspace cleanup between attempts', () => {
    const inner = decodeInner()
    // Helper wraps both rm + git clone so retry runs cleanup on every attempt.
    // Ref interpolated from baseOpts so a future bump doesn't silently desync.
    const refRegex = baseOpts.ref.replace(/[.\\/]/g, '\\$&')
    const helperRegex = new RegExp(
      `git_clone_one\\(\\) \\{ rm -rf "\\$LYRA_DIR"; git clone --depth 1 --branch '${refRegex}' .* "\\$LYRA_DIR"; \\}`,
    )
    expect(inner).toMatch(helperRegex)
    expect(inner).toMatch(/retry 'git clone' git_clone_one \|\| \{ echo "git-clone-failed"/)
  })

  test('inner subshell writes fail marker on each step failure', () => {
    const inner = decodeInner()
    expect(inner).toContain('apt-update-failed')
    expect(inner).toContain('apt-install-failed')
    expect(inner).toContain('bun-install-failed')
    expect(inner).toContain('git-clone-failed')
    expect(inner).toContain('harness-died-early')
    expect(inner).toContain(BOOTSTRAP_FAIL_MARKER)
  })

  test('embeds the requested ref + repo url + sandbox id + operator', () => {
    const inner = decodeInner({ ...baseOpts, repoUrl: 'https://x.test/foo.git' })
    expect(inner).toContain("'https://x.test/foo.git'")
    expect(inner).toContain(`'${baseOpts.ref}'`)
    expect(inner).toContain(`export SANDBOX_ID='${baseOpts.sandboxId}'`)
    expect(inner).toContain(`export LYRA_OPERATOR_ADDRESS='${baseOpts.operatorAddress}'`)
  })

  test('honors custom port', () => {
    const inner = decodeInner({ ...baseOpts, port: 9090 })
    expect(inner).toContain("export HARNESS_PORT='9090'")
  })

  test('apt list defaults include xvfb + git + psmisc but NOT chromium (Playwright bundles its own)', () => {
    const inner = decodeInner()
    expect(inner).toMatch(/sudo -n apt-get install .* xvfb/)
    expect(inner).toMatch(/sudo -n apt-get install .* git/)
    expect(inner).toMatch(/sudo -n apt-get install .* psmisc/)
    // v0.19.16: standalone chromium dropped — agent-browser install pulls
    // its own Chrome-for-Testing build.
    expect(inner).not.toMatch(/sudo -n apt-get install -y -qq[^\n]*\bchromium\b/)
  })

  test('extra apt packages are appended and deduped', () => {
    const inner = decodeInner({ ...baseOpts, extraAptPackages: ['ffmpeg', 'chromium'] })
    const aptLine = inner.split('\n').find(l => l.includes('apt-get install -y -qq'))!
    expect(aptLine).toContain('ffmpeg')
    expect(aptLine).toContain('chromium')
    const chromiumCount = (aptLine.match(/chromium/g) ?? []).length
    expect(chromiumCount).toBe(1)
  })

  test('browser deps step uses doctor-guarded idempotent install after bun deps', () => {
    const inner = decodeInner()
    expect(inner).toContain('[browser deps]')
    // Direct invocation, not `bunx`, because Daytona's bun.sh/install path
    // doesn't always ship a bunx symlink. node_modules/.bin/agent-browser
    // uses #!/usr/bin/env node which Daytona's image already provides.
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

  test('shell-quotes injection-prone fields safely', () => {
    const inner = decodeInner({ ...baseOpts, sandboxId: "abc'; rm -rf /; echo '" })
    expect(inner).toContain("export SANDBOX_ID='abc'\\''; rm -rf /; echo '\\'''")
  })

  test('exposes BOOTSTRAP_SUCCESS_MARKER_PREFIX for callers that grep done file', () => {
    expect(BOOTSTRAP_SUCCESS_MARKER_PREFIX).toBe('lyra-gateway-pid=')
  })

  test('outer script stays under Daytona request-size ceiling (v0.16.5 was 5340 OK, v0.16.6 was 6136 BROKEN)', () => {
    // Daytona's toolbox `process/execute` endpoint nginx config returned 400
    // "Request Header Or Cookie Too Large" once the bash payload crossed
    // ~6000 bytes. v0.16.5 at 5340 was the last known-good size; we cap
    // generously below that to absorb future field/extraApt growth.
    const { script } = buildBootstrapScript(baseOpts)
    expect(script.length).toBeLessThan(5000)
  })

  test('clones to $HOME/lyra (not /opt/lyra — daytona user has no sudo for /opt)', () => {
    const inner = decodeInner()
    expect(inner).toContain('LYRA_DIR="$HOME/lyra"')
    expect(inner).not.toContain('/opt/lyra')
    expect(inner).toContain('rm -rf "$LYRA_DIR"')
  })

  describe('mode=npm', () => {
    const npmOpts = {
      ...baseOpts,
      mode: 'npm' as const,
      packageVersion: '0.21.15',
    }

    test('inner subshell does `bun add -g lyra-ai-cli@<version>` instead of git clone', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain("bun add -g 'lyra-ai-cli@0.21.15'")
      expect(inner).not.toContain('git clone')
      expect(inner).not.toContain('bun install --frozen-lockfile')
    })

    test('inner subshell exports bun global bin to PATH so lyra-gateway resolves', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('export PATH="$HOME/.bun/install/global/node_modules/.bin:$PATH"')
    })

    test('inner subshell launches gateway from global bin (not via bun monorepo path)', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('nohup $HOME/.bun/install/global/node_modules/.bin/lyra-gateway')
      expect(inner).not.toContain('bun "$LYRA_DIR/packages/gateway/bin/lyra-gateway"')
    })

    test('browser deps install uses global bin path', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('$HOME/.bun/install/global/node_modules/.bin/agent-browser doctor')
      expect(inner).toMatch(
        /retry 'browser deps' \$HOME\/\.bun\/install\/global\/node_modules\/\.bin\/agent-browser install --with-deps/,
      )
    })

    test('throws when packageVersion is missing for npm mode', () => {
      expect(() => decodeInner({ ...baseOpts, mode: 'npm' })).toThrow(
        /packageVersion is required when mode=npm/,
      )
    })

    test('outer script under 5KB cap (npm path is leaner than git)', () => {
      const { script } = buildBootstrapScript(npmOpts)
      expect(script.length).toBeLessThan(5000)
    })

    test('preserves apt + retry helper + harness retry loop from preamble', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('sudo -n apt-get update -qq')
      expect(inner).toContain('retry() {')
      expect(inner).toContain('for h_attempt in 1 2 3; do')
      expect(inner).toContain(BOOTSTRAP_DONE_MARKER)
    })

    test('writes lyra-install-failed marker on bun add failure', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('lyra-install-failed')
    })

    test('mode label is reported in bootstrap-start log', () => {
      const inner = decodeInner(npmOpts)
      expect(inner).toContain('bootstrap-start (mode=npm)')
    })
  })

  test('default mode is npm when not specified (flipped in v0.21.20; ~10x faster cold start)', () => {
    const { sandboxId, operatorAddress, ref } = baseOpts
    const inner = decodeInner({ sandboxId, operatorAddress, ref, packageVersion: '0.21.20' })
    expect(inner).toContain('bootstrap-start (mode=npm)')
    expect(inner).toContain("bun add -g 'lyra-ai-cli@0.21.20'")
    expect(inner).not.toContain('git clone --depth 1 --branch')
  })
})
