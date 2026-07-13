import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeAgent, ClaudeCommand, ClaudeExtrasDiscoveryResult } from './types'

export interface ClaudeExtrasOptions {
  importsClaudeCode?: boolean
  /** Override for ~/.claude/plugins/cache/. */
  claudePluginsCacheRoot?: string
}

export async function discoverClaudeExtras(
  opts: ClaudeExtrasOptions = {},
): Promise<ClaudeExtrasDiscoveryResult> {
  const importsClaudeCode = opts.importsClaudeCode ?? true
  if (!importsClaudeCode) return { commands: [], agents: [] }
  const cacheRoot = opts.claudePluginsCacheRoot ?? join(homedir(), '.claude', 'plugins', 'cache')
  const commands: ClaudeCommand[] = []
  const agents: ClaudeAgent[] = []

  let marketplaces: Dirent[]
  try {
    const s = await stat(cacheRoot)
    if (!s.isDirectory()) return { commands, agents }
    marketplaces = (await readdir(cacheRoot, { withFileTypes: true })) as Dirent[]
  } catch {
    return { commands, agents }
  }

  for (const market of marketplaces) {
    await collectFromMarketplace(cacheRoot, market, commands, agents)
  }
  return { commands, agents }
}

async function collectFromMarketplace(
  cacheRoot: string,
  market: Dirent,
  commands: ClaudeCommand[],
  agents: ClaudeAgent[],
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
    await collectFromPluginVersions(marketDir, market.name, plugin, commands, agents)
  }
}

async function collectFromPluginVersions(
  marketDir: string,
  marketName: string,
  plugin: Dirent,
  commands: ClaudeCommand[],
  agents: ClaudeAgent[],
): Promise<void> {
  if (!plugin.isDirectory()) return
  const pluginDir = join(marketDir, plugin.name)
  let versions: Dirent[]
  try {
    versions = (await readdir(pluginDir, { withFileTypes: true })) as Dirent[]
  } catch {
    return
  }
  const versionDirs = versions
    .filter(v => v.isDirectory())
    .map(v => v.name)
    .sort()
  const latest = versionDirs[versionDirs.length - 1]
  if (!latest) return
  const versionDir = join(pluginDir, latest)
  const source = { marketplace: marketName, plugin: plugin.name, version: latest }
  await collectFromDir(join(versionDir, 'commands'), source, 'command', commands, agents)
  await collectFromDir(join(versionDir, 'agents'), source, 'agent', commands, agents)
}

async function collectFromDir(
  dir: string,
  source: { marketplace: string; plugin: string; version: string },
  kind: 'command' | 'agent',
  commands: ClaudeCommand[],
  agents: ClaudeAgent[],
): Promise<void> {
  let entries: Dirent[]
  try {
    const s = await stat(dir)
    if (!s.isDirectory()) return
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch {
    return
  }
  for (const entry of entries) {
    await collectEntry(entry, dir, source, kind, commands, agents)
  }
}

async function collectEntry(
  entry: Dirent,
  dir: string,
  source: { marketplace: string; plugin: string; version: string },
  kind: 'command' | 'agent',
  commands: ClaudeCommand[],
  agents: ClaudeAgent[],
): Promise<void> {
  if (!(entry.isFile() && entry.name.endsWith('.md'))) return
  const filePath = join(dir, entry.name)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return
  }
  const parsed = parseFile(raw)
  if (!parsed) return
  const id = `${source.plugin}:${parsed.name ?? entry.name.replace(/\.md$/, '')}`
  const name = parsed.name ?? entry.name.replace(/\.md$/, '')
  if (kind === 'command') {
    commands.push({
      id,
      name,
      description: parsed.description ?? '',
      argumentHint: parsed.argumentHint,
      path: filePath,
      body: parsed.body,
      source,
    })
  } else {
    agents.push({
      id,
      name,
      description: parsed.description ?? '',
      model: parsed.model,
      path: filePath,
      body: parsed.body,
      source,
    })
  }
}

interface ParsedFile {
  name?: string
  description?: string
  argumentHint?: string
  model?: string
  body: string
}

function parseFile(raw: string): ParsedFile | null {
  if (!raw.startsWith('---')) {
    return { body: raw }
  }
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return { body: raw }
  const block = raw.slice(4, end)
  const body = raw.slice(end + 4).replace(/^\n/, '')
  const out: ParsedFile = { body }
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!m?.[1]) continue
    const key = m[1]
    const value = unquote(m[2] ?? '')
    if (key === 'name') out.name = value
    else if (key === 'description') out.description = value
    else if (key === 'argument-hint' || key === 'argumentHint') out.argumentHint = value
    else if (key === 'model') out.model = value
  }
  return out
}

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}
