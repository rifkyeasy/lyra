import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter, scanSkills } from './scanner'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'lyra-skills-scanner-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function plant(absDir: string, fm: string, body = '# body\n'): Promise<void> {
  await mkdir(absDir, { recursive: true })
  await writeFile(join(absDir, 'SKILL.md'), `${fm}\n\n${body}`)
}

describe('parseFrontmatter', () => {
  it('parses top-level fields', () => {
    const fm = parseFrontmatter('---\nname: foo\ndescription: hi\nversion: 1.0.0\n---\n\nbody')
    expect(fm.name).toBe('foo')
    expect(fm.description).toBe('hi')
    expect(fm.version).toBe('1.0.0')
  })

  it('parses metadata.filePattern + metadata.bashPattern', () => {
    const raw =
      '---\nname: dogfood\ndescription: tests\nmetadata:\n  filePattern: "*.test.ts,*.spec.ts"\n  bashPattern: "playwright|jest"\n---\n\nbody'
    const fm = parseFrontmatter(raw)
    expect(fm.filePattern).toBe('*.test.ts,*.spec.ts')
    expect(fm.bashPattern).toBe('playwright|jest')
  })

  it('parses argument-hint as argumentHint', () => {
    const fm = parseFrontmatter('---\nname: c\nargument-hint: <message>\n---\n\nbody')
    expect(fm.argumentHint).toBe('<message>')
  })

  it('returns empty object for non-frontmatter content', () => {
    expect(parseFrontmatter('# just a heading\nblah')).toEqual({})
  })
})

describe('scanSkills', () => {
  it('finds lyra + claude-code skills + claude plugin cache layouts', async () => {
    const lyraSkillsRoot = join(scratch, '.lyra', 'skills')
    const claudeSkillsRoot = join(scratch, '.claude', 'skills')
    const claudePluginsCacheRoot = join(scratch, '.claude', 'plugins', 'cache')

    await plant(join(lyraSkillsRoot, 'dogfood'), '---\nname: dogfood\ndescription: lyra skill\n---')
    await plant(
      join(claudeSkillsRoot, 'commit'),
      '---\nname: commit\ndescription: claude skill\n---',
    )
    await plant(
      join(claudePluginsCacheRoot, 'awesome', 'pdf', '1.0.0', 'skills', 'extract'),
      '---\nname: extract\ndescription: pdf skill\n---',
    )
    // Plugin with direct SKILL.md (no skills/ subdir)
    await plant(
      join(claudePluginsCacheRoot, 'awesome', 'docx', '1.0.0'),
      '---\nname: docx\ndescription: docx skill\n---',
    )

    const skills = await scanSkills({
      lyraSkillsRoot,
      lyraPluginsRoot: join(scratch, '.lyra', 'plugins'),
      claudeSkillsRoot,
      claudePluginsCacheRoot,
      importsClaudeCode: true,
    })
    const ids = skills.map(s => s.id).sort()
    expect(ids).toContain('lyra:dogfood')
    expect(ids).toContain('claude-code:commit')
    expect(ids).toContain('claude-plugin:awesome:pdf:extract')
    expect(ids).toContain('claude-plugin:awesome:docx')
    const pdf = skills.find(s => s.id === 'claude-plugin:awesome:pdf:extract')
    expect(pdf?.pluginCoord?.marketplace).toBe('awesome')
    expect(pdf?.pluginCoord?.plugin).toBe('pdf')
    expect(pdf?.pluginCoord?.version).toBe('1.0.0')
  })

  it('skips claude paths when imports.claudeCode is false', async () => {
    const claudeSkillsRoot = join(scratch, '.claude', 'skills')
    await plant(join(claudeSkillsRoot, 'foo'), '---\nname: foo\ndescription: x\n---')
    const skills = await scanSkills({
      lyraSkillsRoot: join(scratch, 'doesnotexist'),
      lyraPluginsRoot: join(scratch, 'doesnotexist'),
      claudeSkillsRoot,
      claudePluginsCacheRoot: join(scratch, 'doesnotexist'),
      importsClaudeCode: false,
    })
    expect(skills).toEqual([])
  })

  it('discovers lyra-plugin skills', async () => {
    const lyraPluginsRoot = join(scratch, '.lyra', 'plugins')
    await plant(
      join(lyraPluginsRoot, 'system', 'skills', 'sweep'),
      '---\nname: sweep\ndescription: plugin-sourced skill\n---',
    )
    const skills = await scanSkills({
      lyraSkillsRoot: join(scratch, 'doesnotexist'),
      lyraPluginsRoot,
      claudeSkillsRoot: join(scratch, 'doesnotexist'),
      claudePluginsCacheRoot: join(scratch, 'doesnotexist'),
      importsClaudeCode: false,
    })
    expect(skills.map(s => s.id)).toEqual(['lyra-plugin:system:sweep'])
  })
})

describe('skills without YAML frontmatter', () => {
  it('still surfaces skills whose SKILL.md has no frontmatter (fallback to dir name + first body line)', async () => {
    const lyraSkillsRoot = join(scratch, '.lyra', 'skills')
    await mkdir(join(lyraSkillsRoot, 'no-fm'), { recursive: true })
    await writeFile(
      join(lyraSkillsRoot, 'no-fm', 'SKILL.md'),
      '# no-fm skill\n\nA skill without yaml frontmatter that should still be discoverable.\n',
    )
    const skills = await scanSkills({
      lyraSkillsRoot,
      lyraPluginsRoot: join(scratch, 'doesnotexist'),
      claudeSkillsRoot: join(scratch, 'doesnotexist'),
      claudePluginsCacheRoot: join(scratch, 'doesnotexist'),
      importsClaudeCode: false,
    })
    const found = skills.find(s => s.id === 'lyra:no-fm')
    expect(found).toBeDefined()
    expect(found!.name).toBe('no-fm')
    expect(found!.description).toContain('A skill without yaml frontmatter')
  })
})
