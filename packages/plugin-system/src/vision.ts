import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { PathGuard, type ToolDef, type VisionInferFn } from 'lyra-core'
import { z } from 'zod'
import { collectUpToBytes, hostIsPrivate } from './web-fetch'

/**
 * `vision.analyze` accepts EITHER an absolute file path OR an http(s) URL.
 * URL fetches stream + abort at maxBytes (same SSRF guard as web.fetch); a
 * misleading URL pointing at a multi-GB asset cancels the reader instead
 * of pulling the whole thing before the size check.
 */

const KNOWN_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/**
 * Sniff MIME from magic bytes. Falls back to extension for cases the magic
 * doesn't cover. Used because the qwen3-vl provider rejects requests with
 * an incorrect mediaType in the data: URL (its OpenAI-compat checker
 * treats `image/*` strictly).
 */
function sniffMimeFromBytes(bytes: Uint8Array, fallbackExt: string | null): string | null {
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'image/png'
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp'
  }
  if (fallbackExt && KNOWN_MIME_BY_EXT[fallbackExt]) {
    return KNOWN_MIME_BY_EXT[fallbackExt]!
  }
  return null
}

const VisionSchema = z.object({
  image_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Absolute path on disk to the image to analyze. Provide this OR image_url, not both.',
    ),
  image_url: z
    .string()
    .url()
    .optional()
    .describe(
      'http(s) URL pointing to the image. Private/loopback IPs blocked; same guard as web.fetch.',
    ),
  prompt: z
    .string()
    .min(1)
    .describe('Question or instruction for the vision model (e.g. "describe this image").'),
})

type VisionArgs = z.infer<typeof VisionSchema>

const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB raw — base64 ~13.3 MB request body
const FETCH_TIMEOUT_MS = 15_000

export interface VisionAnalyzeDeps {
  /** Null when no vision provider is configured (testnet, opt-out). */
  visionInfer: VisionInferFn | null
  /** Agent state dir; PathGuard refuses image_path reads under it + credential dirs. */
  agentDir: string
}

export function makeVisionAnalyze(deps: VisionAnalyzeDeps): ToolDef<VisionArgs> {
  const guard = new PathGuard({ agentDir: deps.agentDir })
  return {
    name: 'vision.analyze',
    description:
      "Describe / answer questions about an image. Pass image_path (absolute path on disk) OR image_url (http/https). Routes to a multimodal model on Sui Compute (qwen3-vl-30b on mainnet). Refuses paths under credential dirs (.ssh, .aws, .lyra/). ALWAYS call this tool when the operator references an image by path or URL — do NOT pre-check existence with shell.run and do NOT skip the call by replying 'the file doesn't exist'. The tool returns a structured error if the file is missing or invalid; let the tool be the source of truth, never your guess.",
    searchHint: 'vision image analyze describe ocr photo screenshot multimodal',
    schema: VisionSchema,
    handler: async args => {
      if (!deps.visionInfer) {
        return {
          ok: false,
          error:
            'vision provider not configured. Set `vision.provider` in ~/.lyra/config.ts to a Sui Compute multimodal provider, or unset to use the network default.',
        }
      }
      if (Boolean(args.image_path) === Boolean(args.image_url)) {
        return { ok: false, error: 'exactly one of image_path or image_url is required' }
      }
      let bytes: Uint8Array
      let mediaType: string
      try {
        const loaded = await loadImage(args, guard)
        bytes = loaded.bytes
        mediaType = loaded.mediaType
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
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

async function loadImage(
  args: VisionArgs,
  guard: PathGuard,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  if (args.image_path) {
    return loadImageFromPath(args.image_path, guard)
  }
  // image_url path
  return loadImageFromUrl(args.image_url!)
}

/** Expand `~`, require an absolute path, and run it through the path guard. */
function resolveLocalImagePath(rawPath: string, guard: PathGuard): string {
  const expanded = rawPath.startsWith('~') ? rawPath.replace('~', homedir()) : rawPath
  if (!isAbsolute(expanded)) {
    throw new Error(`image_path must be absolute, got: ${rawPath}`)
  }
  const allowed = guard.check(expanded)
  if (!allowed.allowed) {
    throw new Error(allowed.reason ?? 'protected path')
  }
  return expanded
}

async function loadImageFromPath(
  rawPath: string,
  guard: PathGuard,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const expanded = resolveLocalImagePath(rawPath, guard)
  const buffer = await readFile(expanded)
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large: ${buffer.byteLength} bytes (limit ${MAX_IMAGE_BYTES}). Resize and retry.`,
    )
  }
  const ext = (expanded.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase()
  const mediaType = sniffMimeFromBytes(new Uint8Array(buffer), ext || null)
  if (!mediaType) {
    throw new Error(`unrecognized image format at ${expanded}`)
  }
  return { bytes: new Uint8Array(buffer), mediaType }
}

/** Parse + validate a user URL: http(s) only, and reject private/loopback hosts. */
function validateImageUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('invalid image_url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${url.protocol}`)
  }
  if (hostIsPrivate(url.hostname)) {
    throw new Error(`host blocked (private/loopback/metadata): ${url.hostname}`)
  }
  return url
}

/** Enforce the HTTP status + size gate and return the collected image bytes. */
async function readImageBody(res: Response): Promise<Uint8Array> {
  if (!res.ok) {
    throw new Error(`fetch http ${res.status}`)
  }
  const { bytes, truncated } = await collectUpToBytes(res.body, MAX_IMAGE_BYTES + 1)
  if (truncated || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: exceeds ${MAX_IMAGE_BYTES} bytes. Resize and retry.`)
  }
  return bytes
}

/** Resolve the media type from magic bytes, falling back to the response header / URL ext. */
function resolveUrlMediaType(bytes: Uint8Array, res: Response, url: URL): string {
  const headerType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  const extFromUrl = (url.pathname.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase()
  const sniffed = sniffMimeFromBytes(bytes, extFromUrl || null)
  const mediaType =
    sniffed ??
    (headerType?.startsWith('image/') ? headerType : (KNOWN_MIME_BY_EXT[extFromUrl] ?? null))
  if (!mediaType) {
    throw new Error(`unrecognized image format from ${url.hostname}`)
  }
  return mediaType
}

async function loadImageFromUrl(rawUrl: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const url = validateImageUrl(rawUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'lyra/vision.analyze' },
    })
    const bytes = await readImageBody(res)
    const mediaType = resolveUrlMediaType(bytes, res, url)
    return { bytes, mediaType }
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError') throw new Error(`fetch timeout after ${FETCH_TIMEOUT_MS}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export { sniffMimeFromBytes }
