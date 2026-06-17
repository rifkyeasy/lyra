import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSkillsList, makeSkillsView } from './skills'

let scratch: string | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'lyra-skills-'))
})

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

function roots(scratchDir: string): { lyraSkillsRoot: string; claudeSkillsRoot: string } {
  return {
    lyraSkillsRoot: join(scratchDir, '.lyra', 'skills'),
    claudeSkillsRoot: join(scratchDir, '.claude', 'skills'),
  }
}

async function plant(
  scratchDir: string,
  sub: 'lyra' | 'claude',
  name: string,
  fm: string,
): Promise<string> {
  const skillsRoot =
    sub === 'lyra'
      ? join(scratchDir, '.lyra', 'skills', name)
      : join(scratchDir, '.claude', 'skills', name)
  await mkdir(skillsRoot, { recursive: true })
  const file = join(skillsRoot, 'SKILL.md')
  await writeFile(file, `${fm}\n\n# Skill body for ${name}\n`)
  return file
}

describe('skills.list', () => {
  it('discovers skills from lyra and claude paths when claudeCode imports enabled', async () => {
    expect(scratch).toBeDefined()
    await plant(
      scratch!,
      'lyra',
      'dogfood',
      '---\nname: dogfood\ndescription: lyra skill body\n---',
    )
    await plant(
      scratch!,
      'claude',
      'commit',
      '---\nname: commit\ndescription: claude skill body\n---',
    )
    const tool = makeSkillsList({ importsClaudeCode: true, ...roots(scratch!) })
    const out = await tool.handler({})
    expect(out.ok).toBe(true)
    const skills = (out.data as { skills: { id: string; source: string }[] }).skills
    expect(skills.find(s => s.id === 'lyra:dogfood')).toBeDefined()
    expect(skills.find(s => s.id === 'claude-code:commit')).toBeDefined()
  })
  it('filters by source', async () => {
    expect(scratch).toBeDefined()
    await plant(scratch!, 'lyra', 'a', '---\nname: a\ndescription: x\n---')
    await plant(scratch!, 'claude', 'b', '---\nname: b\ndescription: y\n---')
    const tool = makeSkillsList({ importsClaudeCode: true, ...roots(scratch!) })
    const out = await tool.handler({ source: 'lyra' })
    const skills = (out.data as { skills: { id: string }[] }).skills
    expect(skills).toHaveLength(1)
    expect(skills[0]!.id).toBe('lyra:a')
  })
  it('skips claude paths when imports disabled', async () => {
    expect(scratch).toBeDefined()
    await plant(scratch!, 'claude', 'foo', '---\nname: foo\ndescription: x\n---')
    const tool = makeSkillsList({ importsClaudeCode: false, ...roots(scratch!) })
    const out = await tool.handler({})
    const skills = (out.data as { skills: unknown[] }).skills
    expect(skills).toHaveLength(0)
  })
})

describe('skills.view', () => {
  it('reads body for a known skill, returns text + bytes', async () => {
    expect(scratch).toBeDefined()
    await plant(scratch!, 'lyra', 'plan', '---\nname: plan\ndescription: x\n---')
    const tool = makeSkillsView({ importsClaudeCode: false, ...roots(scratch!) })
    const out = await tool.handler({ id: 'lyra:plan' })
    expect(out.ok).toBe(true)
    expect((out.data as { text: string }).text).toContain('Skill body for plan')
  })
  it('errors on unknown skill id', async () => {
    const tool = makeSkillsView({ importsClaudeCode: false, ...roots(scratch!) })
    const out = await tool.handler({ id: 'lyra:nonexistent' })
    expect(out.ok).toBe(false)
  })
})
