import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFsPatch, makeFsRead, makeFsSearch, makeFsWrite } from './fs'

async function tmp(): Promise<{
  workspace: string
  agentDir: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'lyra-fs-test-'))
  const workspace = join(root, 'workspace')
  const agentDir = join(root, '.lyra', 'agents', 'fake')
  await mkdir(workspace, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  return {
    workspace,
    agentDir,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('fs.read', () => {
  it('reads workspace files; truncates at max_bytes', async () => {
    const { workspace, agentDir, cleanup } = await tmp()
    try {
      const file = join(workspace, 'hello.txt')
      await writeFile(file, 'hello world\n')
      const tool = makeFsRead({ workspaceRoot: workspace, agentDir })
      const out = await tool.handler({ path: file })
      expect(out.ok).toBe(true)
      const data = out.data as { text: string; truncated: boolean }
      expect(data.text).toBe('hello world\n')
      expect(data.truncated).toBe(false)

      const small = await tool.handler({ path: file, max_bytes: 3 })
      expect((small.data as { text: string; truncated: boolean }).truncated).toBe(true)
    } finally {
      await cleanup()
    }
  })
  it('refuses to read files inside the agent state tree', async () => {
    const { workspace, agentDir, cleanup } = await tmp()
    try {
      const inside = join(agentDir, 'memory', 'foo.md')
      await mkdir(join(agentDir, 'memory'), { recursive: true })
      await writeFile(inside, 'secret')
      const tool = makeFsRead({ workspaceRoot: workspace, agentDir })
      const out = await tool.handler({ path: inside })
      expect(out.ok).toBe(false)
      expect(out.error).toContain('protected path')
    } finally {
      await cleanup()
    }
  })
})

describe('fs.write', () => {
  it('writes a file under workspace; refuses dotenv-like names', async () => {
    const { workspace, agentDir, cleanup } = await tmp()
    try {
      const tool = makeFsWrite({ workspaceRoot: workspace, agentDir })
      const ok = await tool.handler({ path: join(workspace, 'note.md'), text: 'hi' })
      expect(ok.ok).toBe(true)
      expect(await readFile(join(workspace, 'note.md'), 'utf8')).toBe('hi')
      const denied = await tool.handler({
        path: join(workspace, '.env.local'),
        text: 'KEY=v',
      })
      expect(denied.ok).toBe(false)
    } finally {
      await cleanup()
    }
  })
  it('refuses to write inside agent state tree even relative', async () => {
    const { workspace, agentDir, cleanup } = await tmp()
    try {
      const tool = makeFsWrite({ workspaceRoot: workspace, agentDir })
      const out = await tool.handler({ path: join(agentDir, 'config.ts'), text: 'x' })
      expect(out.ok).toBe(false)
    } finally {
      await cleanup()
    }
  })
})

describe('fs.patch', () => {
  it('rejects when find substring is missing or non-unique', async () => {
    const { workspace, agentDir, cleanup } = await tmp()
    try {
      const file = join(workspace, 'a.txt')
      await writeFile(file, 'one two two')
      const tool = makeFsPatch({ workspaceRoot: workspace, agentDir })
      const missing = await tool.handler({ path: file, find: 'three', replace: 'X' })
      expect(missing.ok).toBe(false)
      const dup = await tool.handler({ path: file, find: 'two', replace: 'X' })
      expect(dup.ok).toBe(false)
      expect(dup.error).toContain('appears 2 times')
      const ok = await tool.handler({ path: file, find: 'one', replace: 'three' })
      expect(ok.ok).toBe(true)
      expect(await readFile(file, 'utf8')).toBe('three two two')
    } finally {
      await cleanup()
    }
  })
})

describe('fs.search', () => {
  it('greps under workspace; skips node_modules and dotdirs', async () => {
    const { workspace, agentDir, cleanup } = await tmp()
    try {
      await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(join(workspace, 'node_modules', 'pkg', 'a.txt'), 'TARGET ignore me')
      await mkdir(join(workspace, 'src'), { recursive: true })
      await writeFile(join(workspace, 'src', 'a.ts'), 'console.log("TARGET hit")')
      await writeFile(join(workspace, 'src', 'b.ts'), 'no match here')
      const tool = makeFsSearch({ workspaceRoot: workspace, agentDir })
      const out = await tool.handler({ pattern: 'TARGET' })
      expect(out.ok).toBe(true)
      const data = out.data as { matches: { file: string }[] }
      expect(data.matches.length).toBe(1)
      expect(data.matches[0]!.file).toContain('a.ts')
    } finally {
      await cleanup()
    }
  })
})
