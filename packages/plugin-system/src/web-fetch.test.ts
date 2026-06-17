import { describe, expect, it } from 'bun:test'
import { detectBlock, htmlToMarkdown, makeWebFetch } from './web-fetch'

describe('web.fetch host-allowlist', () => {
  const tool = makeWebFetch()

  it('rejects file:// URLs', async () => {
    const out = await tool.handler({ url: 'file:///etc/hosts' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/invalid URL|unsupported protocol/)
  })

  it('rejects ftp:// URLs', async () => {
    const out = await tool.handler({ url: 'ftp://example.com/foo' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('unsupported protocol')
  })

  it('rejects loopback IPs (127.0.0.1)', async () => {
    const out = await tool.handler({ url: 'http://127.0.0.1:8080/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects private RFC1918 IPs (10.x)', async () => {
    const out = await tool.handler({ url: 'http://10.0.0.1/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects 192.168.x.x', async () => {
    const out = await tool.handler({ url: 'http://192.168.1.1/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects link-local (169.254.x.x including AWS metadata)', async () => {
    const out = await tool.handler({ url: 'http://169.254.169.254/latest/meta-data/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects localhost literal', async () => {
    const out = await tool.handler({ url: 'http://localhost/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects .internal TLD', async () => {
    const out = await tool.handler({ url: 'http://service.internal/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects metadata.google.internal explicitly', async () => {
    const out = await tool.handler({ url: 'http://metadata.google.internal/computeMetadata/v1/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })
})

describe('htmlToMarkdown', () => {
  it('strips script and style tags entirely', () => {
    const html =
      '<html><head><script>alert(1)</script><style>body{}</style></head><body>hi</body></html>'
    expect(htmlToMarkdown(html)).toBe('hi')
  })

  it('converts headings to # syntax', () => {
    expect(htmlToMarkdown('<h1>Title</h1><p>body</p>')).toContain('# Title')
    expect(htmlToMarkdown('<h2>Sub</h2>')).toContain('## Sub')
  })

  it('converts links to [text](href)', () => {
    expect(htmlToMarkdown('<a href="https://example.com">click</a>')).toBe(
      '[click](https://example.com)',
    )
  })

  it('converts list items to - bullets', () => {
    const out = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')
    expect(out).toContain('- one')
    expect(out).toContain('- two')
  })

  it('decodes common HTML entities', () => {
    expect(htmlToMarkdown('<p>R&amp;D &gt; 0</p>')).toContain('R&D > 0')
    expect(htmlToMarkdown('<p>caf&#233;</p>')).toContain('café')
  })

  it('collapses runs of blank lines', () => {
    const html = '<p>a</p>\n\n\n\n\n<p>b</p>'
    const md = htmlToMarkdown(html)
    expect(md).not.toMatch(/\n{3,}/)
  })

  it('strips HTML comments', () => {
    expect(htmlToMarkdown('<!-- secret --><p>visible</p>')).toBe('visible')
  })
})

describe('detectBlock (v0.20.2 anti-bot signal)', () => {
  it('detects Cloudflare interstitial', () => {
    const html = '<html><body><h1>Just a moment...</h1></body></html>'
    expect(detectBlock(html, 200, 'https://example.com')?.reason).toBe('cloudflare')
  })

  it('detects Google bot block by body phrase', () => {
    const html = 'Our systems have detected unusual traffic from your computer network'
    expect(detectBlock(html, 200, 'https://www.google.com/search?q=anything')?.reason).toBe(
      'google-bot-block',
    )
  })

  it('detects DDG anomaly page', () => {
    const html = '<html><body>anomaly detected, please complete the captcha</body></html>'
    expect(detectBlock(html, 200, 'https://duckduckgo.com/')?.reason).toBe('ddg-anomaly')
  })

  it('detects rate-limit by status', () => {
    expect(detectBlock('any body', 429, 'https://api.example.com')?.reason).toBe('rate-limit')
    expect(detectBlock('any body', 451, 'https://api.example.com')?.reason).toBe('rate-limit')
  })

  it('detects bot-block on 403 from search engines', () => {
    expect(detectBlock('forbidden', 403, 'https://www.google.com/search')?.reason).toBe('bot-block')
    expect(detectBlock('forbidden', 403, 'https://en.wikipedia.org/wiki/X')?.reason).toBe(
      'bot-block',
    )
  })

  it('does NOT flag plain 200 with normal HTML', () => {
    const html =
      '<html><body><h1>Welcome to Example.com</h1><p>Normal content here.</p></body></html>'
    expect(detectBlock(html, 200, 'https://example.com')).toBeNull()
  })

  it('does NOT flag generic 403 from non-search domains', () => {
    expect(detectBlock('forbidden', 403, 'https://api.private.example.com')).toBeNull()
  })

  it('detects captcha gates (g-recaptcha)', () => {
    const html = '<form><div class="g-recaptcha" data-sitekey="..."></div></form>'
    expect(detectBlock(html, 200, 'https://anywhere.com')?.reason).toBe('captcha')
  })

  it('detects Datadome / PerimeterX bot interstitials', () => {
    expect(detectBlock('<body>datadome-captcha</body>', 200, 'https://x.com')?.reason).toBe(
      'bot-block',
    )
    expect(detectBlock('<body>imperva incident id: abc</body>', 200, 'https://y.com')?.reason).toBe(
      'bot-block',
    )
  })

  it('only scans the first 4KB (so trailing harmless content does not trigger)', () => {
    const padding = 'x'.repeat(5000)
    const html = `${padding}<body>just a moment...</body>`
    expect(detectBlock(html, 200, 'https://example.com')).toBeNull()
  })
})
