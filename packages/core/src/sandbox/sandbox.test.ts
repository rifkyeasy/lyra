import { describe, expect, test } from 'bun:test'
import { makeSandboxBackend } from './factory'
import { buildBwrapArgs } from './linux'
import { LocalBackend } from './local'
import { MacOSSandboxExecBackend } from './macos'
import { buildSeatbeltProfile } from './seatbelt-profile'

describe('LocalBackend (passthrough)', () => {
  test('returns spawn request unchanged', async () => {
    const b = new LocalBackend()
    const req = {
      command: '/bin/sh',
      args: ['-c', 'echo ok'],
      options: { cwd: '/tmp' },
    }
    const out = await b.wrapSpawn(req)
    expect(out.command).toBe('/bin/sh')
    expect(out.args).toEqual(['-c', 'echo ok'])
    expect(out.options).toEqual({ cwd: '/tmp' })
  })

  test('mode + label expose correct identifiers', () => {
    const b = new LocalBackend()
    expect(b.mode).toBe('none')
    expect(b.label).toBe('none')
  })
})

describe('buildSeatbeltProfile', () => {
  test('emits a deny-default profile that explicitly allows agentDir + workspaceRoot', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/Users/test/.lyra/agents/abc',
      workspaceRoot: '/Users/test/Documents/proj',
      homedir: '/Users/test',
    })
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('(allow file-write* (subpath "/Users/test/.lyra/agents/abc"))')
    expect(profile).toContain('(allow file-write* (subpath "/Users/test/Documents/proj"))')
  })

  test('explicitly denies credential paths for both reads and writes', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/Users/test/.lyra/agents/abc',
      workspaceRoot: '/Users/test/work',
      homedir: '/Users/test',
    })
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/.ssh"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/.aws"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/Library/Keychains"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/.config/gcloud"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/.lyra"))')
    // Reads of credential dirs blocked too — `cat ~/.ssh/id_rsa` should fail
    expect(profile).toContain('(deny file-read* (subpath "/Users/test/.ssh"))')
    expect(profile).toContain('(deny file-read* (subpath "/Users/test/.aws"))')
    expect(profile).toContain('(deny file-read* (subpath "/Users/test/Library/Keychains"))')
    expect(profile).toContain('(deny file-read* (subpath "/Users/test/.config/gcloud"))')
  })

  test('allows process-fork + process-exec + network', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/a',
      workspaceRoot: '/b',
      homedir: '/h',
    })
    expect(profile).toContain('(allow process-fork)')
    expect(profile).toContain('(allow process-exec)')
    expect(profile).toContain('(allow network*)')
    expect(profile).toContain('(allow file-read*)')
  })

  test('allows /tmp/lyra-* + /var/folders for temp dirs', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/a',
      workspaceRoot: '/b',
      homedir: '/h',
    })
    expect(profile).toContain('(allow file-write* (regex #"^/tmp/lyra-"))')
    expect(profile).toContain('(allow file-write* (regex #"^/private/tmp/lyra-"))')
    expect(profile).toContain('(allow file-write* (subpath "/var/folders"))')
  })

  test('respects extraWriteAllow + extraWriteDeny', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/a',
      workspaceRoot: '/b',
      homedir: '/h',
      extraWriteAllow: ['/tmp/lyra-test-sandbox-XYZ'],
      extraWriteDeny: ['/Users/h/Documents/sensitive'],
    })
    expect(profile).toContain('(allow file-write* (subpath "/tmp/lyra-test-sandbox-XYZ"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/h/Documents/sensitive"))')
  })

  test('escapes embedded double quotes + backslashes in paths', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/path/with"quote',
      workspaceRoot: '/path\\with\\backslash',
      homedir: '/h',
    })
    expect(profile).toContain('/path/with\\"quote')
    expect(profile).toContain('/path\\\\with\\\\backslash')
  })

  // Property-style fuzz of the escape function: every input must produce a
  // syntactically valid (subpath "X") string — no unescaped backslashes/quotes/
  // newlines that would prematurely close the literal or break SBPL parsing.
  // The actual exploit risk is near-zero (operators don't trick themselves) but
  // the cost of a clean test is one regex check per scenario.
  test('escapes pathological inputs cleanly: nested quotes, sbpl operators, unicode', () => {
    const cases: Array<[string, string]> = [
      // Bare close-paren that could escape an SBPL form (must remain inside the literal)
      ['/tmp/test)', '/tmp/test)'],
      // Embedded "(allow file-write*" attempt to inject a new rule
      [
        '/tmp/" (allow file-write* (subpath "/etc"))',
        '/tmp/\\" (allow file-write* (subpath \\"/etc\\"))',
      ],
      // Nested quotes
      ['/path"with"many"quotes', '/path\\"with\\"many\\"quotes'],
      // Backslash-quote pair
      ['/x\\"y', '/x\\\\\\"y'],
      // Carriage return / form feed
      ['/x\ny', '/x y'], // newline becomes space
      // Unicode emoji (valid path component on macOS)
      ['/Users/alice/\u{1F600}-projects', '/Users/alice/\u{1F600}-projects'],
      // SBPL pattern delimiters embedded
      ['/path/#(literal)', '/path/#(literal)'],
    ]
    for (const [input, expectedFragment] of cases) {
      const profile = buildSeatbeltProfile({
        agentDir: input,
        workspaceRoot: '/w',
        homedir: '/h',
      })
      expect(profile).toContain(`(subpath "${expectedFragment}")`)
      // After escape + concat, no unbalanced double quote inside (subpath "..."):
      // every non-escaped " inside the literal would prematurely close it.
      const subpathPattern = /\(subpath\s+"((?:\\.|[^"\\])*)"\)/g
      // Strip well-formed (subpath "...") instances; remaining text shouldn't
      // contain a stray (subpath ".. " missing its terminator.
      const stripped = profile.replace(subpathPattern, '<<subpath>>')
      expect(stripped).not.toContain('(subpath "')
    }
  })

  test('re-allows agentDir AFTER the broad ~/.lyra deny so lyra state stays writable', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/Users/test/.lyra/agents/abc',
      workspaceRoot: '/w',
      homedir: '/Users/test',
    })
    const agentAllowIdx = profile.lastIndexOf(
      '(allow file-write* (subpath "/Users/test/.lyra/agents/abc"))',
    )
    const lyraDenyIdx = profile.indexOf('(deny file-write* (subpath "/Users/test/.lyra"))')
    expect(agentAllowIdx).toBeGreaterThan(-1)
    expect(lyraDenyIdx).toBeGreaterThan(-1)
    expect(agentAllowIdx).toBeGreaterThan(lyraDenyIdx)
  })
})

describe('MacOSSandboxExecBackend', () => {
  // sandbox-exec is macOS-only; skip these on Linux CI but assert constructor
  // there too.
  if (process.platform !== 'darwin') {
    test('skipped on non-darwin', () => {
      expect(true).toBe(true)
    })
    return
  }

  test('constructs with valid opts on darwin', () => {
    const b = new MacOSSandboxExecBackend({
      agentDir: '/tmp/lyra-test-agent',
      workspaceRoot: '/tmp',
      homedir: process.env.HOME ?? '/tmp',
    })
    expect(b.mode).toBe('os')
    expect(b.label).toBe('os:darwin')
    const profile = b.getProfile()
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('(allow file-write* (subpath "/tmp/lyra-test-agent"))')
  })

  test('wrapSpawn prepends sandbox-exec + profile to argv', async () => {
    const b = new MacOSSandboxExecBackend({
      agentDir: '/tmp/lyra-test-agent',
      workspaceRoot: '/tmp',
      homedir: process.env.HOME ?? '/tmp',
    })
    const out = await b.wrapSpawn({
      command: '/bin/sh',
      args: ['-c', 'echo hi'],
      options: { cwd: '/tmp' },
    })
    expect(out.command).toBe('/usr/bin/sandbox-exec')
    expect(out.args[0]).toBe('-p')
    expect(typeof out.args[1]).toBe('string')
    expect(out.args[1]?.includes('(deny default)')).toBe(true)
    expect(out.args.slice(2)).toEqual(['/bin/sh', '-c', 'echo hi'])
    expect(out.options).toEqual({ cwd: '/tmp' })
  })
})

describe('makeSandboxBackend factory', () => {
  test('mode=none returns LocalBackend on any platform', () => {
    const b = makeSandboxBackend({
      mode: 'none',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'darwin',
    })
    expect(b.mode).toBe('none')
    const b2 = makeSandboxBackend({
      mode: 'none',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'linux',
    })
    expect(b2.mode).toBe('none')
  })

  test('mode=docker constructs DockerBackend if a runtime exists, else falls back', () => {
    let warned = ''
    const b = makeSandboxBackend({
      mode: 'docker',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'darwin',
      warn: m => {
        warned = m
      },
    })
    // On a developer machine with docker/podman installed, mode === 'docker'.
    // On a stripped CI box with neither, factory falls back to LocalBackend
    // and emits a warning. Either is acceptable for this test.
    if (b.mode === 'docker') {
      expect(b.label.startsWith('docker:') || b.label.startsWith('podman:')).toBe(true)
    } else {
      expect(b.mode).toBe('none')
      expect(warned).toContain('docker')
    }
  })

  test('mode=docker accepts resource caps + network/runtime overrides without crashing', () => {
    // Wide-input smoke test: factory should accept all DockerBackend opts and
    // construct (or fall back) without throwing, regardless of runtime presence.
    let warned = ''
    const b = makeSandboxBackend({
      mode: 'docker',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'darwin',
      dockerCpu: 1.5,
      dockerMemoryMb: 4096,
      dockerDiskMb: 51200,
      dockerNoNetwork: true,
      dockerMountWorkspace: false,
      warn: m => {
        warned = m
      },
    })
    if (b.mode === 'docker') {
      expect(b.label.startsWith('docker:') || b.label.startsWith('podman:')).toBe(true)
    } else {
      expect(b.mode).toBe('none')
      expect(warned).toContain('docker')
    }
  })

  test('mode=os on linux constructs bubblewrap backend if bwrap exists, else falls back', () => {
    let warned = ''
    const b = makeSandboxBackend({
      mode: 'os',
      agentDir: '/tmp/lyra-agent',
      workspaceRoot: '/tmp',
      homedir: '/root',
      platform: 'linux',
      warn: m => {
        warned = m
      },
    })
    // On a Linux machine with bubblewrap installed (apt install bubblewrap),
    // mode === 'os' + label 'os:linux'. On macOS or stripped Linux without
    // bwrap, factory falls back to LocalBackend with a warning. Either is
    // acceptable; this test pins the contract, not the platform.
    if (b.mode === 'os') {
      expect(b.label).toBe('os:linux')
    } else {
      expect(b.mode).toBe('none')
      expect(warned).toContain('bubblewrap')
    }
  })

  test('mode=os on unknown platform falls back to LocalBackend with warning', () => {
    let warned = ''
    const b = makeSandboxBackend({
      mode: 'os',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'aix',
      warn: m => {
        warned = m
      },
    })
    expect(b.mode).toBe('none')
    expect(warned).toContain('aix')
  })

  if (process.platform === 'darwin') {
    test('mode=os on darwin returns MacOSSandboxExecBackend', () => {
      const b = makeSandboxBackend({
        mode: 'os',
        agentDir: '/tmp/lyra-test-agent',
        workspaceRoot: '/tmp',
        homedir: process.env.HOME ?? '/tmp',
      })
      expect(b.mode).toBe('os')
      expect(b.label).toBe('os:darwin')
    })
  }
})

describe('buildBwrapArgs (Linux profile)', () => {
  test('binds agentDir + workspaceRoot writable', () => {
    const args = buildBwrapArgs({
      agentDir: '/home/u/.lyra/agents/abc',
      workspaceRoot: '/home/u/proj',
      homedir: '/home/u',
    })
    expect(args).toContain('--bind')
    expect(args.join(' ')).toContain('/home/u/.lyra/agents/abc /home/u/.lyra/agents/abc')
    expect(args.join(' ')).toContain('/home/u/proj /home/u/proj')
  })

  test('blocks credential dirs via tmpfs overlay', () => {
    const args = buildBwrapArgs({
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/home/u',
    })
    const argString = args.join(' ')
    expect(argString).toContain('--tmpfs /home/u/.ssh')
    expect(argString).toContain('--tmpfs /home/u/.aws')
    expect(argString).toContain('--tmpfs /home/u/.config/gcloud')
    expect(argString).toContain('--tmpfs /home/u/.gnupg')
  })

  test('reads of root are allowed via --ro-bind', () => {
    const args = buildBwrapArgs({ agentDir: '/a', workspaceRoot: '/w', homedir: '/h' })
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/'])
  })

  test('shares network but unshares everything else', () => {
    const args = buildBwrapArgs({ agentDir: '/a', workspaceRoot: '/w', homedir: '/h' })
    expect(args).toContain('--unshare-all')
    expect(args).toContain('--share-net')
    expect(args).toContain('--die-with-parent')
    expect(args).toContain('--new-session')
  })

  test('respects extraWriteAllow for sandbox dirs', () => {
    const args = buildBwrapArgs({
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      extraWriteAllow: ['/tmp/lyra-test-sandbox-XYZ'],
    })
    expect(args.join(' ')).toContain('--bind /tmp/lyra-test-sandbox-XYZ /tmp/lyra-test-sandbox-XYZ')
  })

  test('respects extraWriteDeny via tmpfs', () => {
    const args = buildBwrapArgs({
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      extraWriteDeny: ['/home/u/secrets'],
    })
    expect(args.join(' ')).toContain('--tmpfs /home/u/secrets')
  })
})
