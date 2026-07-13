import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentPaths } from '../paths'
import type { SkillFrontmatter, SkillRef, SkillSource } from './types'

/**
 * Scan the canonical skill locations and return parsed SkillRefs. Skips paths
 * that don't exist or aren't directories so callers can register all sources
 * eagerly without needing to probe individually.
 */
export interface SkillScannerOptions {
  /** Whether to scan ~/.claude/skills/ + ~/.claude/plugins/cache/. Default true. */
  importsClaudeCode?: boolean
  /** Override for ~/.lyra/skills/ (test seam). Defaults to agentPaths.skills. */
  lyraSkillsRoot?: string
  /** Override for ~/.lyra/plugins/ (test seam). Defaults to agentPaths.plugins. */
  lyraPluginsRoot?: string
  /** Override for ~/.claude/skills/ (test seam). Defaults to ~/.claude/skills. */
  claudeSkillsRoot?: string
  /** Override for ~/.claude/plugins/cache/ (test seam). Defaults to ~/.claude/plugins/cache. */
  claudePluginsCacheRoot?: string
}

export async function scanSkills(opts: SkillScannerOptions = {}): Promise<SkillRef[]> {
  const importsClaudeCode = opts.importsClaudeCode ?? true
  const lyraSkillsRoot = opts.lyraSkillsRoot ?? agentPaths.skills
  const lyraPluginsRoot = opts.lyraPluginsRoot ?? agentPaths.plugins
  const claudeSkillsRoot = opts.claudeSkillsRoot ?? join(homedir(), '.claude', 'skills')
  const claudePluginsCacheRoot =
    opts.claudePluginsCacheRoot ?? join(homedir(), '.claude', 'plugins', 'cache')

  const refs: SkillRef[] = []
  await collectSimple(lyraSkillsRoot, 'lyra', refs)
  await collectLyraPluginSkills(lyraPluginsRoot, refs)
  if (importsClaudeCode) {
    await collectSimple(claudeSkillsRoot, 'claude-code', refs)
    await collectClaudePluginCacheSkills(claudePluginsCacheRoot, refs)
  }
  return refs
}

async function dirEntries(path: string): Promise<Dirent[] | null> {
  try {
    const s = await stat(path)
    if (!s.isDirectory()) return null
  } catch {
    return null
  }
  try {
    return (await readdir(path, { withFileTypes: true })) as Dirent[]
  } catch {
    return null
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

async function collectSimple(
  root: string,
  source: Extract<SkillSource, 'lyra' | 'claude-code'>,
  out: SkillRef[],
): Promise<void> {
  const entries = await dirEntries(root)
  if (!entries) return
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillPath = join(root, entry.name, 'SKILL.md')
    if (!(await fileExists(skillPath))) continue
    const ref = await loadSkill(skillPath, entry.name, source)
    if (ref) out.push(ref)
  }
}

async function collectLyraPluginSkills(pluginsRoot: string, out: SkillRef[]): Promise<void> {
  const plugins = await dirEntries(pluginsRoot)
  if (!plugins) return
  for (const plugin of plugins) {
    if (plugin.isDirectory()) {
      await collectLyraPluginSkillDir(pluginsRoot, plugin.name, out)
    }
  }
}

async function collectLyraPluginSkillDir(
  pluginsRoot: string,
  pluginName: string,
  out: SkillRef[],
): Promise<void> {
  const skillsRoot = join(pluginsRoot, pluginName, 'skills')
  const skills = await dirEntries(skillsRoot)
  if (!skills) return
  for (const skill of skills) {
    if (!skill.isDirectory()) continue
    const skillPath = join(skillsRoot, skill.name, 'SKILL.md')
    if (!(await fileExists(skillPath))) continue
    const ref = await loadSkill(skillPath, `${pluginName}:${skill.name}`, 'lyra-plugin')
    if (ref) out.push(ref)
  }
}

async function collectClaudePluginCacheSkills(cacheRoot: string, out: SkillRef[]): Promise<void> {
  const marketplaces = await dirEntries(cacheRoot)
  if (!marketplaces) return
  for (const marketplace of marketplaces) {
    if (marketplace.isDirectory()) {
      await collectClaudeMarketplaceSkills(cacheRoot, marketplace.name, out)
    }
  }
}

async function collectClaudeMarketplaceSkills(
  cacheRoot: string,
  marketplace: string,
  out: SkillRef[],
): Promise<void> {
  const marketDir = join(cacheRoot, marketplace)
  const plugins = await dirEntries(marketDir)
  if (!plugins) return
  for (const plugin of plugins) {
    if (plugin.isDirectory()) {
      await collectClaudePluginSkills(marketDir, marketplace, plugin.name, out)
    }
  }
}

async function collectClaudePluginSkills(
  marketDir: string,
  marketplace: string,
  plugin: string,
  out: SkillRef[],
): Promise<void> {
  // Layer 1: <market>/<plugin>/<version>/skills/<skill>/SKILL.md
  // Layer 2: <market>/<plugin>/skills/<skill>/SKILL.md (no version dir)
  // Try the version layer first; fall back to direct.
  const versions = await dirEntries(join(marketDir, plugin))
  if (!versions) return
  for (const versionEntry of versions) {
    if (!versionEntry.isDirectory()) continue
    const versionDir = join(marketDir, plugin, versionEntry.name)
    // Two valid shapes; both checked.
    await collectClaudeSkillsFromVersion(versionDir, marketplace, plugin, versionEntry.name, out)
  }
}

async function collectClaudeSkillsFromVersion(
  versionDir: string,
  marketplace: string,
  plugin: string,
  version: string,
  out: SkillRef[],
): Promise<void> {
  const skillsDir = join(versionDir, 'skills')
  const direct = await fileExists(join(versionDir, 'SKILL.md'))
  if (direct) {
    const ref = await loadSkill(
      join(versionDir, 'SKILL.md'),
      `${marketplace}:${plugin}`,
      'claude-plugin',
    )
    if (ref) {
      ref.pluginCoord = { marketplace, plugin, version }
      out.push(ref)
    }
  }
  const skills = await dirEntries(skillsDir)
  if (!skills) return
  for (const skill of skills) {
    if (!skill.isDirectory()) continue
    const skillPath = join(skillsDir, skill.name, 'SKILL.md')
    if (!(await fileExists(skillPath))) continue
    const id = `${marketplace}:${plugin}:${skill.name}`
    const ref = await loadSkill(skillPath, id, 'claude-plugin')
    if (ref) {
      ref.pluginCoord = { marketplace, plugin, version }
      out.push(ref)
    }
  }
}

async function loadSkill(
  path: string,
  fallbackId: string,
  source: SkillSource,
): Promise<SkillRef | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const fm = parseFrontmatter(raw)
  // Skills without YAML frontmatter are still surfaced; we derive name from
  // the directory and description from the first heading or paragraph so the
  // brain can find them via `skills.list`.
  const name = fm.name ?? fallbackId
  const description = fm.description ?? deriveDescription(raw)
  return {
    id: `${source}:${fallbackId}`,
    name,
    description,
    path,
    source,
    frontmatter: { name, description, ...fm },
  }
}

function deriveDescription(raw: string): string {
  const body = raw.startsWith('---') ? raw.slice(raw.indexOf('\n---', 4) + 4) : raw
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    return trimmed.slice(0, 200)
  }
  return ''
}

const KEY_RE = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/

/**
 * Minimal YAML frontmatter parser (top-level + one nested level for `metadata:`).
 * We avoid pulling in a full YAML lib because skills only need a tiny subset and
 * scan time runs on every chat boot.
 */
export function parseFrontmatter(raw: string): Partial<SkillFrontmatter> {
  if (!raw.startsWith('---')) return {}
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return {}
  const block = raw.slice(4, end)
  const out: Partial<SkillFrontmatter> = {}
  let inMetadata = false
  for (const rawLine of block.split('\n')) {
    if (rawLine.trim() === '') {
      inMetadata = false
      continue
    }
    const indented = rawLine.startsWith('  ') || rawLine.startsWith('\t')
    const trimmed = rawLine.trim()
    if (!indented) {
      inMetadata = applyTopLevelLine(trimmed, out)
      continue
    }
    if (!inMetadata) continue
    applyMetadataLine(trimmed, out)
  }
  return out
}

/**
 * Parse one top-level frontmatter line into `out`. Returns whether the line
 * opened a `metadata:` block (i.e. the new `inMetadata` state).
 */
function applyTopLevelLine(trimmed: string, out: Partial<SkillFrontmatter>): boolean {
  const m = trimmed.match(KEY_RE)
  if (!m?.[1]) return false
  const key = m[1]
  const value = unquote(m[2] ?? '')
  if (key === 'name') out.name = value
  else if (key === 'description') out.description = value
  else if (key === 'version') out.version = value
  else if (key === 'license') out.license = value
  else if (key === 'argument-hint' || key === 'argumentHint') out.argumentHint = value
  else if (key === 'metadata') return true
  return false
}

/** Parse one indented `metadata:` child line into `out`. */
function applyMetadataLine(trimmed: string, out: Partial<SkillFrontmatter>): void {
  const m = trimmed.match(KEY_RE)
  if (!m?.[1]) return
  const key = m[1]
  const value = unquote(m[2] ?? '')
  if (key === 'filePattern') out.filePattern = value
  else if (key === 'bashPattern') out.bashPattern = value
}

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}
