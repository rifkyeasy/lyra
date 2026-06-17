import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { type ToolDef, type VisionInferFn, coerceBool, coerceInt, redactEnv } from 'lyra-core'
import { z } from 'zod'
import { sniffMimeFromBytes } from './vision'

/**
 * Phase 9.4 + Task #74 browser tools. Wraps the `agent-browser` CLI with
 * hermes-grade resilience: PATH-walker for unlinked Homebrew node@N installs,
 * per-session AGENT_BROWSER_SOCKET_DIR (sidesteps macOS 104-byte AF_UNIX
 * limit), stdout/stderr to temp files (avoids daemon-fd pipe deadlock),
 * optional `LYRA_BROWSER_CDP_URL` override for connecting to a user-supplied
 * CDP endpoint, and on-exit cleanup of the spawned daemon.
 *
 * Defaults to local headless Chromium via `agent-browser --session`. Set
 * `LYRA_BROWSER_CDP_URL` to opt into CDP override (e.g. qutebrowser proxy,
 * Browserbase websocket).
 */

interface BrowserDeps {
  /** Override the agent-browser binary path. Default: PATH walker resolves it lazily. */
  binPath?: string
  /** Working directory for the spawned process. Default cwd. */
  cwd?: string
  /** Override timeout (ms). Default 60000. */
  timeoutMs?: number
}

interface RunResult {
  ok: boolean
  data?: { stdout: string; stderr?: string; exit_code: number | null }
  error?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const SANE_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
]

let cachedSessionName: string | null = null
let cachedSocketDir: string | null = null
let cleanupRegistered = false

function discoverHomebrewNodeDirs(): string[] {
  const homebrewOpt = '/opt/homebrew/opt'
  if (!existsSync(homebrewOpt)) return []
  try {
    return readdirSync(homebrewOpt)
      .filter(name => name.startsWith('node') && name !== 'node')
      .map(name => join(homebrewOpt, name, 'bin'))
      .filter(dir => existsSync(dir))
  } catch {
    return []
  }
}

function whichIn(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, name)
    // Use statSync (follows symlinks) so a dangling brew symlink (target
    // moved by `brew upgrade`) returns null instead of pointing at a path
    // that exists but can't be exec'd. Returns null on ENOENT via the
    // throwIfNoEntry: false flag.
    const stat = statSync(candidate, { throwIfNoEntry: false })
    if (stat?.isFile()) return candidate
  }
  return null
}

/**
 * Resolve the `agent-browser` CLI. Canonical path is the workspace's
 * `node_modules/.bin/agent-browser` (npm dep, bun-workspace hoist). PATH and
 * known-dir walks catch operator-installed copies (e.g. Homebrew on the host).
 *
 * NOT cached: resolution is a few syscalls (microseconds), and caching invites
 * the dangling-symlink trap when `brew upgrade` runs in another shell.
 *
 * `cwdOverride` is a test-only hook. Production callers leave it unset.
 */
function findAgentBrowser(override?: string, cwdOverride?: string): string | null {
  if (override) return override

  const cwd = cwdOverride ?? process.cwd()

  // Search a small ladder of candidate roots: the operator-supplied cwd
  // first, then the daemon's bun cwd, then a probe one level deeper
  // ("./lyra") which catches the sandbox-harness case where the daemon
  // boots from $HOME but the workspace tree (with node_modules) lives in
  // a sibling dir. Without that probe enigma's `findAgentBrowser` would
  // miss `/home/daytona/lyra/node_modules/.bin/agent-browser` and the
  // brain quietly falls back to web.fetch.
  const candidates = Array.from(new Set([cwd, process.cwd(), join(cwd, 'lyra')]))
  for (const root of candidates) {
    const localBin = join(root, 'node_modules', '.bin', 'agent-browser')
    if (statSync(localBin, { throwIfNoEntry: false })?.isFile()) return localBin
    const localPkg = join(root, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js')
    if (statSync(localPkg, { throwIfNoEntry: false })?.isFile()) return localPkg
  }

  // Bun global install layout (npm-bootstrapped sandbox containers + any
  // `bun add -g lyra-ai-cli` install). Bun symlinks third-party bins
  // here but does NOT add this dir to $PATH automatically, so the PATH walk
  // below would miss it. Probe explicitly.
  const homeDir = process.env.HOME
  if (homeDir) {
    const bunGlobalBin = join(
      homeDir,
      '.bun',
      'install',
      'global',
      'node_modules',
      '.bin',
      'agent-browser',
    )
    if (statSync(bunGlobalBin, { throwIfNoEntry: false })?.isFile()) return bunGlobalBin
    const bunGlobalPkg = join(
      homeDir,
      '.bun',
      'install',
      'global',
      'node_modules',
      'agent-browser',
      'bin',
      'agent-browser.js',
    )
    if (statSync(bunGlobalPkg, { throwIfNoEntry: false })?.isFile()) return bunGlobalPkg
  }

  const pathEnv = process.env.PATH ?? ''
  const pathDirs = pathEnv.split(delimiter).filter(Boolean)
  const inPath = whichIn('agent-browser', pathDirs)
  if (inPath) return inPath

  const extraDirs = [...discoverHomebrewNodeDirs(), ...SANE_PATH_DIRS].filter(d => existsSync(d))
  const inExtra = whichIn('agent-browser', extraDirs)
  if (inExtra) return inExtra

  return null
}

/**
 * True when `agent-browser` resolves on this machine. Gates browser.* tool
 * registration so dev installs that skip `bun install` don't crash on first
 * browser.* call.
 */
/**
 * Detect whether the agent-browser binary is reachable from disk. Accepts
 * an optional `cwdOverride` because the daemon's `process.cwd()` is not
 * always the workspace root — in the enigma sandbox the harness boots
 * from `/home/daytona`, but `node_modules/.bin/agent-browser` lives one
 * level deeper at `/home/daytona/lyra/node_modules/.bin/`. The plugin
 * loader passes `ctx.workspaceRoot` here so registration uses the right
 * tree on both surfaces.
 */
export function isBrowserAvailable(cwdOverride?: string): boolean {
  return findAgentBrowser(undefined, cwdOverride) !== null
}

/**
 * Same as `isBrowserAvailable` but returns the resolved path (or null).
 * Plugin loaders use this once at registration time and pass the result
 * as `binPath` to each factory so per-call spawns don't re-search PATH —
 * a re-search would fail again when daemon cwd ≠ workspace root.
 */
export function findAgentBrowserOrNull(cwdOverride?: string): string | null {
  return findAgentBrowser(undefined, cwdOverride)
}

function socketSafeTmpdir(): string {
  if (process.platform === 'darwin') return '/tmp'
  return tmpdir()
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('')
}

function getSessionName(): string {
  if (cachedSessionName) return cachedSessionName
  cachedSessionName = `a_${randomHex(5)}`
  return cachedSessionName
}

function getSocketDir(): string {
  if (cachedSocketDir) return cachedSocketDir
  const dir = join(socketSafeTmpdir(), `agent-browser-${getSessionName()}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  cachedSocketDir = dir
  registerCleanup()
  return dir
}

function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  const cleanup = () => {
    try {
      const bin = findAgentBrowser()
      const sess = cachedSessionName
      if (bin && sess && !process.env.LYRA_BROWSER_CDP_URL) {
        try {
          // spawnSync so the daemon actually receives `close` before we exit.
          // Async + detached drops the message: the parent exits before the
          // child IPC connects to the daemon socket. 5s cap prevents hangs
          // on a frozen daemon.
          spawnSync(bin, ['--session', sess, 'close'], {
            stdio: 'ignore',
            env: cachedSocketDir
              ? { ...process.env, AGENT_BROWSER_SOCKET_DIR: cachedSocketDir }
              : process.env,
            timeout: 5000,
          })
        } catch {}
      }
      if (cachedSocketDir) {
        rmSync(cachedSocketDir, { recursive: true, force: true })
      }
    } catch {}
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })
}

function buildBrowserEnv(socketDir: string): NodeJS.ProcessEnv {
  const { env } = redactEnv(process.env as Record<string, string>)
  const existing = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const candidates = [...discoverHomebrewNodeDirs(), ...SANE_PATH_DIRS]
  for (const dir of candidates) {
    if (existsSync(dir) && !existing.includes(dir)) existing.unshift(dir)
  }
  return {
    ...env,
    PATH: existing.join(delimiter),
    AGENT_BROWSER_SOCKET_DIR: socketDir,
  }
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function rmSafe(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {}
}

interface RunOpts {
  /**
   * After the primary command completes, run `agent-browser wait <ms>` so
   * page transitions (navigation, JS-handled form submits) settle before
   * the next snapshot. Set to 0 to skip. Default 0 (the caller chooses).
   */
  settleAfterMs?: number
}

async function runAgentBrowser(
  command: string,
  extraArgs: string[],
  deps: BrowserDeps,
  opts: RunOpts = {},
): Promise<RunResult> {
  const result = await runAgentBrowserOnce(command, extraArgs, deps)
  if (!result.ok || !opts.settleAfterMs) return result
  // Best-effort settle wait — the primary call's result is what we report;
  // a wait failure (e.g. timeout) doesn't invalidate the action that just
  // succeeded. We DO surface it via stderr though.
  const settleMs = Math.min(opts.settleAfterMs, 10_000)
  await runAgentBrowserOnce('wait', [String(settleMs)], deps)
  return result
}

async function runAgentBrowserOnce(
  command: string,
  extraArgs: string[],
  deps: BrowserDeps,
): Promise<RunResult> {
  const bin = findAgentBrowser(deps.binPath)
  if (!bin) {
    return {
      ok: false,
      error:
        'agent-browser CLI not found in node_modules/.bin or PATH. Re-run `lyra upgrade` to repair, or `bun install` in the workspace root if running from source.',
    }
  }
  // Path may contain a space if a user-supplied override was passed; preserve
  // it as a single argv0 since spawn() doesn't shell-tokenize.
  const cmdParts = [bin]

  const cdpOverride = process.env.LYRA_BROWSER_CDP_URL
  const backendArgs = cdpOverride ? ['--cdp', cdpOverride] : ['--session', getSessionName()]

  const socketDir = getSocketDir()
  const sanitizedCmd = command.replace(/[^a-z0-9_-]/gi, '_')
  const stdoutPath = join(socketDir, `_stdout_${sanitizedCmd}_${Date.now()}`)
  const stderrPath = join(socketDir, `_stderr_${sanitizedCmd}_${Date.now()}`)

  const fullArgs = [...cmdParts.slice(1), ...backendArgs, command, ...extraArgs]
  const env = buildBrowserEnv(socketDir)

  let stdoutFd = -1
  let stderrFd = -1
  try {
    stdoutFd = openSync(stdoutPath, 'w', 0o600)
    stderrFd = openSync(stderrPath, 'w', 0o600)
  } catch (err) {
    return { ok: false, error: `failed to open browser temp files: ${(err as Error).message}` }
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return await new Promise<RunResult>(resolve => {
    let proc: ChildProcess
    try {
      proc = spawn(cmdParts[0]!, fullArgs, {
        cwd: deps.cwd ?? process.cwd(),
        env,
        stdio: ['ignore', stdoutFd, stderrFd],
      })
    } catch (err) {
      try {
        closeSync(stdoutFd)
      } catch {}
      try {
        closeSync(stderrFd)
      } catch {}
      rmSafe(stdoutPath)
      rmSafe(stderrPath)
      const msg = (err as Error).message
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        resolve({
          ok: false,
          error:
            'agent-browser binary not executable at resolved path. Re-run `lyra upgrade` (sandbox) or `bun install` (host) to repair the workspace install.',
        })
      } else {
        resolve({ ok: false, error: msg })
      }
      return
    }
    try {
      closeSync(stdoutFd)
    } catch {}
    try {
      closeSync(stderrFd)
    } catch {}

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill('SIGKILL')
      } catch {}
    }, timeoutMs)

    proc.on('error', err => {
      clearTimeout(timer)
      rmSafe(stdoutPath)
      rmSafe(stderrPath)
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        resolve({
          ok: false,
          error:
            'agent-browser binary not executable at resolved path. Re-run `lyra upgrade` (sandbox) or `bun install` (host) to repair the workspace install.',
        })
        return
      }
      resolve({ ok: false, error: err.message })
    })

    proc.on('close', code => {
      clearTimeout(timer)
      const stdout = readFileSafe(stdoutPath).slice(-100_000)
      const stderr = readFileSafe(stderrPath).slice(-50_000)
      rmSafe(stdoutPath)
      rmSafe(stderrPath)
      if (timedOut) {
        resolve({
          ok: false,
          error: `agent-browser ${command} timed out after ${timeoutMs}ms`,
          data: { stdout, stderr, exit_code: code },
        })
        return
      }
      resolve({
        ok: (code ?? 1) === 0,
        data: { stdout, stderr, exit_code: code },
      })
    })
  })
}

const NavigateSchema = z.object({
  url: z.string().min(1).describe('Absolute URL to navigate to (e.g. https://...).'),
})

export function makeBrowserNavigate(deps: BrowserDeps): ToolDef<z.infer<typeof NavigateSchema>> {
  return {
    name: 'browser.navigate',
    description:
      'Open a URL in the agent-browser tab. Returns the new page metadata. Auto-waits 1500ms after navigation so the next browser.snapshot reflects the new page.',
    shouldDefer: true,
    searchHint: 'browser navigate open url page',
    schema: NavigateSchema,
    handler: async args => runAgentBrowser('open', [args.url], deps, { settleAfterMs: 1500 }),
  }
}

const SnapshotSchema = z.object({
  with_image: coerceBool
    .optional()
    .describe('When true, also captures a screenshot saved alongside the accessibility tree.'),
  cap: coerceBool
    .optional()
    .describe('Cap the snapshot output for compactness. Defaults to true (-c flag).'),
})

export function makeBrowserSnapshot(deps: BrowserDeps): ToolDef<z.infer<typeof SnapshotSchema>> {
  return {
    name: 'browser.snapshot',
    description:
      'Capture the page accessibility tree with element refs (@e1, @e2, ...). Use refs returned here for click/type/scroll actions. Set with_image=true to also write a screenshot.',
    shouldDefer: true,
    searchHint: 'browser snapshot accessibility tree refs page state',
    schema: SnapshotSchema,
    handler: async args => {
      const flags: string[] = []
      if (args.with_image !== false) flags.push('-i')
      if (args.cap !== false) flags.push('-c')
      return runAgentBrowser('snapshot', flags, deps)
    },
  }
}

const ClickSchema = z.object({
  selector: z
    .string()
    .min(1)
    .describe(
      "Snapshot ref (e.g. '@e5') from the most recent browser.snapshot — preferred — OR a plain CSS selector ('button.primary', '#submit'). NOT a Playwright-style pseudo-class: ':has-text()', ':has()', ':contains()' are NOT supported and will fail.",
    ),
})

export function makeBrowserClick(deps: BrowserDeps): ToolDef<z.infer<typeof ClickSchema>> {
  return {
    name: 'browser.click',
    description:
      "Click an element. Arg name is `selector` (snapshot @ref like '@e5' or plain CSS like 'button.primary'). Auto-waits 1200ms post-click so any triggered navigation/state change settles before the next snapshot. To click a link by visible text, take a fresh `browser.snapshot` first and pass the @eN ref of the matching node — Playwright pseudo-classes (:has-text, :contains) are not supported.",
    shouldDefer: true,
    searchHint: 'browser click element selector ref',
    schema: ClickSchema,
    handler: async args => runAgentBrowser('click', [args.selector], deps, { settleAfterMs: 1200 }),
  }
}

const TypeSchema = z.object({
  selector: z.string().min(1),
  text: z.string().describe('Text to type into the element.'),
})

export function makeBrowserType(deps: BrowserDeps): ToolDef<z.infer<typeof TypeSchema>> {
  return {
    name: 'browser.type',
    description:
      'Type text into an element by selector or snapshot ref. Auto-waits 600ms post-type so debounced input handlers settle before the next snapshot.',
    shouldDefer: true,
    searchHint: 'browser type input text fill',
    schema: TypeSchema,
    handler: async args =>
      runAgentBrowser('type', [args.selector, args.text], deps, { settleAfterMs: 600 }),
  }
}

const ScrollSchema = z.object({
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe(
      "Scroll direction. Defaults to 'down' when omitted. Pass 'up'/'left'/'right' when needed.",
    ),
  pixels: coerceInt
    .refine(n => n > 0, 'pixels must be > 0')
    .optional()
    .describe('Optional scroll distance in pixels. Default 800.'),
  // `amount` is a tolerated alias for `pixels` — observed brain calls
  // (qwen3.6-plus) routinely emit `amount=N` instead of `pixels=N` because
  // the operator's natural-language prompt says "scroll N pixels" and the
  // brain projects that onto a generic `amount` slot. Without this alias
  // the schema silently strips the unknown key and the tool defaults to
  // 800 — the call succeeds but with the wrong distance, which reads as
  // the tool ignoring the operator's intent. Accept both spellings; merge
  // in the handler.
  amount: coerceInt
    .refine(n => n > 0, 'amount must be > 0')
    .optional()
    .describe('Alias for `pixels`. Prefer `pixels`; `amount` accepted for compatibility.'),
})

export function makeBrowserScroll(deps: BrowserDeps): ToolDef<z.infer<typeof ScrollSchema>> {
  return {
    name: 'browser.scroll',
    description:
      "Scroll the page. Both args are optional: `direction` defaults to 'down' (override with 'up'/'left'/'right'); `pixels` defaults to 800. For 'scroll down N pixels' pass pixels=N. The schema also accepts `amount` as an alias for `pixels` — use either; pixels is preferred.",
    shouldDefer: true,
    searchHint: 'browser scroll page up down',
    schema: ScrollSchema,
    handler: async args => {
      const args2: string[] = [args.direction ?? 'down']
      const px = args.pixels ?? args.amount
      if (px) args2.push(String(px))
      return runAgentBrowser('scroll', args2, deps)
    },
  }
}

const BackSchema = z.object({})

export function makeBrowserBack(deps: BrowserDeps): ToolDef<z.infer<typeof BackSchema>> {
  return {
    name: 'browser.back',
    description:
      'Navigate the browser history back one step. Auto-waits 1500ms for the previous page to render before the next snapshot.',
    shouldDefer: true,
    searchHint: 'browser back history previous page',
    schema: BackSchema,
    handler: async () => runAgentBrowser('back', [], deps, { settleAfterMs: 1500 }),
  }
}

const PressSchema = z.object({
  key: z.string().min(1).describe("Key to press, e.g. 'Enter', 'Tab', 'Escape', 'Control+a'."),
})

export function makeBrowserPress(deps: BrowserDeps): ToolDef<z.infer<typeof PressSchema>> {
  return {
    name: 'browser.press',
    description:
      'Send a single key press (Enter, Tab, Escape, Ctrl+A, etc.). Auto-waits 1500ms post-press so a form submit triggered by Enter has time to navigate before the next snapshot.',
    shouldDefer: true,
    searchHint: 'browser press key keyboard',
    schema: PressSchema,
    handler: async args => runAgentBrowser('press', [args.key], deps, { settleAfterMs: 1500 }),
  }
}

const GetImagesSchema = z.object({
  selector: z.string().optional().describe('Optional CSS selector to scope image extraction.'),
  limit: coerceInt
    .refine(n => n > 0 && n <= 200, 'limit must be 1..200')
    .optional()
    .describe('Cap on returned URLs. Default 50.'),
})

export function makeBrowserGetImages(deps: BrowserDeps): ToolDef<z.infer<typeof GetImagesSchema>> {
  return {
    name: 'browser.get_images',
    description:
      'Extract image URLs from the current page. Optionally scoped to a CSS selector. Returns up to `limit` (default 50) src URLs as a JSON array string.',
    shouldDefer: true,
    searchHint: 'browser images src extract list',
    schema: GetImagesSchema,
    handler: async args => {
      const sel = (args.selector ?? 'img').replace(/'/g, "\\'")
      const limit = args.limit ?? 50
      // agent-browser `get attr` only returns the first match; eval gets all.
      const js = `JSON.stringify(Array.from(document.querySelectorAll('${sel}')).slice(0, ${limit}).map(i => i.src || i.getAttribute('src') || '').filter(Boolean))`
      return runAgentBrowser('eval', [js], deps)
    },
  }
}

const VisionSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('What you want the vision model to answer/describe about the screenshot.'),
})

export function makeBrowserVision(
  deps: BrowserDeps & { visionInfer: VisionInferFn | null },
): ToolDef<z.infer<typeof VisionSchema>> {
  return {
    name: 'browser.vision',
    description:
      "Capture the current page as a screenshot and send it to the configured vision model with a prompt. Returns the model's reply. Routes to the configured vision provider on Sui Compute (qwen3-vl-30b on mainnet by default).",
    shouldDefer: true,
    searchHint: 'browser vision screenshot describe ocr image',
    schema: VisionSchema,
    handler: async args => {
      if (!deps.visionInfer) {
        return {
          ok: false,
          error:
            'vision provider not configured. Set `vision.provider` in ~/.lyra/config.ts to a Sui Compute multimodal provider.',
        }
      }
      const path = join(tmpdir(), `lyra-vision-${Date.now()}-${process.pid}.png`)
      const shot = await runAgentBrowser('screenshot', [path], deps)
      if (!shot.ok) return shot
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(readFileSync(path))
      } catch (e) {
        return { ok: false, error: `screenshot read failed: ${(e as Error).message}` }
      } finally {
        rmSafe(path)
      }
      const mediaType = sniffMimeFromBytes(bytes, 'png') ?? 'image/png'
      try {
        const result = await deps.visionInfer({
          images: [{ bytes, mediaType }],
          prompt: args.prompt,
          maxOutputTokens: 1024,
        })
        return {
          ok: true,
          data: {
            content: result.content,
            model: result.model ?? null,
            usage: result.usage,
            finishReason: result.finishReason,
          },
        }
      } catch (e) {
        return { ok: false, error: `vision call failed: ${(e as Error).message.slice(0, 240)}` }
      }
    },
  }
}

const ConsoleSchema = z.object({
  clear: coerceBool.optional().describe('When true, clears console after reading.'),
})

export function makeBrowserConsole(deps: BrowserDeps): ToolDef<z.infer<typeof ConsoleSchema>> {
  return {
    name: 'browser.console',
    description: 'Read accumulated console output (logs, warnings, errors) from the page.',
    shouldDefer: true,
    searchHint: 'browser console logs warnings errors',
    schema: ConsoleSchema,
    handler: async args => {
      const flags: string[] = []
      if (args.clear) flags.push('--clear')
      return runAgentBrowser('console', flags, deps)
    },
  }
}

export const ALL_BROWSER_TOOL_FACTORIES = [
  makeBrowserNavigate,
  makeBrowserSnapshot,
  makeBrowserClick,
  makeBrowserType,
  makeBrowserScroll,
  makeBrowserBack,
  makeBrowserPress,
  makeBrowserGetImages,
  makeBrowserConsole,
]

// Test-only hooks for the regression suite. Resets module-level cache so a
// test can stub PATH or override the platform without leaking state.
export const __test = {
  reset(): void {
    cachedSessionName = null
    if (cachedSocketDir) {
      try {
        rmSync(cachedSocketDir, { recursive: true, force: true })
      } catch {}
    }
    cachedSocketDir = null
    cleanupRegistered = false
  },
  findAgentBrowser,
  isBrowserAvailable,
  socketSafeTmpdir,
  getSessionName,
  getSocketDir,
  buildBrowserEnv,
}
