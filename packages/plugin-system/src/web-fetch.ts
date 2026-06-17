import type { ToolDef } from 'lyra-core'
import { z } from 'zod'

/**
 * `web.fetch` — GET a URL and return its body as text/markdown/json.
 *
 * Mirrors Claude Code's `WebFetch` capability: GET-only, follows redirects
 * via the platform fetch, decodes content-type into the most useful shape
 * for the brain to consume. POST/PUT/DELETE are intentionally NOT supported
 * — those have side effects that should route through `shell.run curl`
 * with the approval modal in play.
 *
 * Permission scope vs `shell.run curl`:
 *   - shell.run hits the approval modal every time + redactEnv strips
 *     wallet/API-key env vars (correct for safety, but blocks legitimate
 *     auth headers if the brain wanted to construct them).
 *   - web.fetch is read-only by construction. Refuses non-GET, refuses
 *     non-http(s), refuses private/loopback/metadata IPs. No subprocess
 *     spawn, no redactEnv. Lower-risk surface, no modal needed.
 *
 * The HTML→markdown conversion is intentionally minimal (~80 LOC inline,
 * no new deps). It strips script/style, converts headings/links/lists
 * to markdown, drops everything else. Good enough for "let me read this
 * doc page" workflows; not suitable for fully-rendered SPA scraping
 * (use browser.* tools for that).
 */

const FetchSchema = z.object({
  url: z.string().url().describe('http(s) URL to GET. Private/loopback IPs are blocked.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(30_000)
    .optional()
    .describe('Abort the request after N ms. Default 15000.'),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(500_000)
    .optional()
    .describe('Truncate response body to N bytes. Default 50000.'),
})

interface FetchResult {
  ok: boolean
  data?: {
    status: number
    content_type: string | null
    body: string
    truncated: boolean
    final_url: string
    /**
     * v0.20.2: structured signal that the response body is a bot-block,
     * captcha, rate-limit, or other anti-scrape interstitial — even though
     * the HTTP status itself was 200/2xx. Brain should escalate to
     * `browser.navigate` (frozen-prefix says so) instead of trying to read
     * the markdown body.
     */
    blocked?: boolean
    block_reason?: string
  }
  error?: string
}

const BLOCK_PATTERNS: Array<{ reason: string; re: RegExp }> = [
  // Cloudflare anti-bot interstitial
  {
    reason: 'cloudflare',
    re: /just a moment\.\.\.|attention required.*cloudflare|cf-browser-verification|challenges\.cloudflare\.com/i,
  },
  // Google search bot block
  {
    reason: 'google-bot-block',
    re: /unusual traffic from your computer network|sending automated queries|enablejs\?sei=|please show you're not a robot/i,
  },
  // DuckDuckGo captcha / anomaly page
  {
    reason: 'ddg-anomaly',
    re: /anomaly detected|please complete the captcha|duckassist.*captcha/i,
  },
  // Bing / Microsoft account verify
  { reason: 'bing-verify', re: /verify you are not a robot|verify-bing|blockedreason=botnet/i },
  // Wikipedia rate-limit / API throttle
  { reason: 'rate-limit', re: /rate[- ]?limit|too many requests|hit our rate limit|throttled/i },
  // Generic captcha / hCaptcha / reCAPTCHA gates
  { reason: 'captcha', re: /g-recaptcha|h-captcha|recaptcha\/api\.js|hcaptcha\.com\/captcha/i },
  // Akamai / Imperva / Datadome / PerimeterX bot interstitials
  {
    reason: 'bot-block',
    re: /access denied.*reference #|datadome-captcha|perimeterx|bot detection|imperva incident id/i,
  },
]

export function detectBlock(
  rawHtml: string,
  status: number,
  finalUrl: string,
): { reason: string } | null {
  // Status-based: 429, 451, 503 from a search engine domain are usually bot-blocks
  if (status === 429 || status === 451) return { reason: 'rate-limit' }
  if (status === 403) {
    if (/google\.com|bing\.com|duckduckgo\.com|wikipedia\.org/i.test(finalUrl))
      return { reason: 'bot-block' }
  }
  // Body-based pattern match (truncated to first 4KB for speed; interstitials are always near top)
  const head = rawHtml.slice(0, 4096)
  for (const p of BLOCK_PATTERNS) {
    if (p.re.test(head)) return { reason: p.reason }
  }
  return null
}

const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fe80::/i,
  /^fc00::/i,
  /^fd00::/i,
]

const PRIVATE_HOST_LITERALS = new Set([
  'localhost',
  '0.0.0.0',
  '169.254.169.254',
  'metadata.google.internal',
])

export function hostIsPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (PRIVATE_HOST_LITERALS.has(h)) return true
  if (h.endsWith('.local')) return true
  if (h.endsWith('.internal')) return true
  return PRIVATE_IP_PATTERNS.some(re => re.test(h))
}

export function makeWebFetch(): ToolDef<z.infer<typeof FetchSchema>> {
  return {
    name: 'web.fetch',
    description:
      'GET an http(s) URL and return its body as markdown (HTML), JSON-pretty (application/json), or plain text. Read-only; no POST/PUT/DELETE. Refuses private/loopback/metadata IPs. For interactive SPAs or pages requiring login, use the browser.* tools instead.',
    searchHint: 'web fetch http https url get download read article docs',
    schema: FetchSchema,
    handler: async args => fetchUrl(args.url, args.timeout_ms ?? 15_000, args.max_bytes ?? 50_000),
  }
}

async function fetchUrl(rawUrl: string, timeoutMs: number, maxBytes: number): Promise<FetchResult> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: 'invalid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol: ${url.protocol}` }
  }
  if (hostIsPrivate(url.hostname)) {
    return { ok: false, error: `host blocked (private/loopback/metadata): ${url.hostname}` }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'lyra/web.fetch' },
    })
    const contentType = res.headers.get('content-type')
    // Stream until we hit `maxBytes`, then cancel the reader so the rest of
    // the body never crosses the wire. Without this, a misleading URL pointing
    // at a multi-GB file would still pull the whole thing before truncation,
    // burning bandwidth + memory long before the cap kicks in.
    const { bytes, truncated } = await collectUpToBytes(res.body, maxBytes)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const block = detectBlock(text, res.status, res.url)
    const body = renderBody(text, contentType)
    return {
      ok: res.ok || block != null,
      data: {
        status: res.status,
        content_type: contentType,
        body,
        truncated,
        final_url: res.url,
        ...(block ? { blocked: true, block_reason: block.reason } : {}),
      },
      ...(res.ok || block ? {} : { error: `http ${res.status}` }),
    }
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError') return { ok: false, error: `timeout after ${timeoutMs}ms` }
    return { ok: false, error: err.message }
  } finally {
    clearTimeout(timer)
  }
}

export async function collectUpToBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    received += value.length
    if (received >= maxBytes) {
      truncated = received > maxBytes
      const fitting = truncated ? value.slice(0, value.length - (received - maxBytes)) : value
      chunks.push(fitting)
      try {
        await reader.cancel()
      } catch {}
      break
    }
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return { bytes: out, truncated }
}

function renderBody(text: string, contentType: string | null): string {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('application/json') || ct.includes('+json')) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }
  if (ct.includes('text/html') || ct.includes('application/xhtml')) {
    return htmlToMarkdown(text)
  }
  return text
}

/**
 * Minimal HTML→markdown. Goal: produce a readable digest of doc/article
 * pages without pulling in turndown or jsdom. Order of operations:
 *
 *  1. Strip <script>, <style>, comments — never useful for the brain.
 *  2. Collapse heading tags to `# … `.
 *  3. Collapse <a href="x">text</a> to `[text](x)`.
 *  4. Add paragraph breaks for <br>, <p>, <li>, <tr>, <h*>.
 *  5. Strip all remaining tags.
 *  6. Decode common HTML entities.
 *  7. Collapse multiple blank lines.
 */
export function htmlToMarkdown(html: string): string {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
  s = s.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_m, level, inner) => `\n\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n\n`,
  )
  s = s.replace(
    /<a\b[^>]*?href\s*=\s*['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, href, inner) => `[${stripTags(inner).trim()}](${href})`,
  )
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_m, inner) => `\n- ${stripTags(inner)}`)
  s = s.replace(/<br\s*\/?\s*>/gi, '\n')
  s = s.replace(/<\/p\s*>/gi, '\n\n')
  s = s.replace(/<\/tr\s*>/gi, '\n')
  s = s.replace(/<\/td\s*>/gi, ' | ')
  s = stripTags(s)
  s = decodeEntities(s)
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\n[ \t]+/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(Number.parseInt(code, 16)))
}
