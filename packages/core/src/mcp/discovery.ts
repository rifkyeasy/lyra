import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpDiscoveryResult, McpServerConfig } from './types'

interface RawMcpFile {
  mcpServers?: Record<string, RawMcpServer>
}

interface RawMcpServer {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: 'stdio' | 'http'
  url?: string
  headers?: Record<string, string>
}

export interface McpDiscoveryOptions {
  /** Whether to scan ~/.claude/.mcp.json + ~/.claude/plugins/cache/. Default true. */
  importsClaudeCode?: boolean
  /** Override for ~/.claude/.mcp.json. */
  claudeMcpPath?: string
  /** Override for ~/.claude/plugins/cache/. */
  claudePluginsCacheRoot?: string
  /** Override for ~/.lyra/.mcp.json (lyra-native MCP servers). */
  lyraMcpPath?: string
}

export async function discoverMcpServers(
  opts: McpDiscoveryOptions = {},
): Promise<McpDiscoveryResult> {
  const importsClaudeCode = opts.importsClaudeCode ?? true
  const lyraMcpPath = opts.lyraMcpPath ?? join(homedir(), '.lyra', '.mcp.json')
  const claudeMcpPath = opts.claudeMcpPath ?? join(homedir(), '.claude', '.mcp.json')
  const claudePluginsCacheRoot =
    opts.claudePluginsCacheRoot ?? join(homedir(), '.claude', 'plugins', 'cache')

  const sources: McpDiscoveryResult['sources'] = []
  const collected = new Map<string, McpServerConfig>()
  await loadFromFile(lyraMcpPath, undefined, collected, sources)
  if (importsClaudeCode) {
    await loadFromFile(claudeMcpPath, undefined, collected, sources)
    await loadFromCache(claudePluginsCacheRoot, collected, sources)
  }
  return { servers: [...collected.values()], sources }
}

async function loadFromFile(
  path: string,
  pluginRoot: string | undefined,
  out: Map<string, McpServerConfig>,
  sources: McpDiscoveryResult['sources'],
): Promise<void> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return
  }
  let parsed: RawMcpFile
  try {
    parsed = JSON.parse(raw) as RawMcpFile
  } catch {
    return
  }
  if (!parsed.mcpServers) return
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    const config = normalize(name, server, pluginRoot)
    if (!config) continue
    if (out.has(name)) continue
    out.set(name, config)
    sources.push({ server: name, path })
  }
}

async function loadFromCache(
  cacheRoot: string,
  out: Map<string, McpServerConfig>,
  sources: McpDiscoveryResult['sources'],
): Promise<void> {
  let marketplaces: Dirent[]
  try {
    const s = await stat(cacheRoot)
    if (!s.isDirectory()) return
    marketplaces = (await readdir(cacheRoot, { withFileTypes: true })) as Dirent[]
  } catch {
    return
  }
  for (const market of marketplaces) {
    await loadCacheMarketplace(cacheRoot, market, out, sources)
  }
}

async function loadCacheMarketplace(
  cacheRoot: string,
  market: Dirent,
  out: Map<string, McpServerConfig>,
  sources: McpDiscoveryResult['sources'],
): Promise<void> {
  if (!market.isDirectory()) return
  const marketDir = join(cacheRoot, market.name)
  let plugins: Dirent[]
  try {
    plugins = (await readdir(marketDir, { withFileTypes: true })) as Dirent[]
  } catch {
    return
  }
  for (const plugin of plugins) {
    await loadCachePlugin(marketDir, plugin, out, sources)
  }
}

async function loadCachePlugin(
  marketDir: string,
  plugin: Dirent,
  out: Map<string, McpServerConfig>,
  sources: McpDiscoveryResult['sources'],
): Promise<void> {
  if (!plugin.isDirectory()) return
  const pluginDir = join(marketDir, plugin.name)
  let versions: Dirent[]
  try {
    versions = (await readdir(pluginDir, { withFileTypes: true })) as Dirent[]
  } catch {
    return
  }
  const versionDirs = versions.filter(v => v.isDirectory()).map(v => v.name)
  // Pick the newest version dir (lexicographic, sufficient for semver).
  versionDirs.sort()
  const latest = versionDirs[versionDirs.length - 1]
  if (!latest) return
  const versionDir = join(pluginDir, latest)
  const mcpPath = join(versionDir, '.mcp.json')
  await loadFromFile(mcpPath, versionDir, out, sources)
}

function normalize(
  name: string,
  raw: RawMcpServer,
  pluginRoot: string | undefined,
): McpServerConfig | null {
  if (raw.type === 'http') {
    if (!raw.url) return null
    return { name, type: 'http', url: raw.url, headers: raw.headers }
  }
  if (!raw.command) return null
  return {
    name,
    type: 'stdio',
    command: raw.command,
    args: raw.args?.map(a => substitutePluginRoot(a, pluginRoot)),
    env: raw.env
      ? Object.fromEntries(
          Object.entries(raw.env).map(([k, v]) => [k, substitutePluginRoot(v, pluginRoot)]),
        )
      : undefined,
    pluginRoot,
  }
}

function substitutePluginRoot(s: string, pluginRoot: string | undefined): string {
  if (!pluginRoot) return s
  return s
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('$CLAUDE_PLUGIN_ROOT', pluginRoot)
}
