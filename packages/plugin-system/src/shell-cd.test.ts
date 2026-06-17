import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkingDirState } from './cwd-state'
import { makeShellRun } from './shell'
import { makeShellCd } from './shell-cd'

describe('shell.cd', () => {
  it('updates the shared cwd state to a valid absolute path', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'lyra-cd-a-'))
    const dir2 = await mkdtemp(join(tmpdir(), 'lyra-cd-b-'))
    try {
      const cwd = new WorkingDirState(dir1)
      const cd = makeShellCd({ cwd, agentDir: '/tmp/fake-agent-dir' })
      const out = await cd.handler({ path: dir2 })
      const expected = await realpath(dir2)
      expect(out.ok).toBe(true)
      expect((out.data as { cwd: string }).cwd).toBe(expected)
      expect(cwd.get()).toBe(expected)
    } finally {
      await rm(dir1, { recursive: true, force: true })
      await rm(dir2, { recursive: true, force: true })
    }
  })

  it('resolves relative paths against the current cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lyra-cd-rel-'))
    const sub = join(root, 'sub')
    await mkdir(sub, { recursive: true })
    await Bun.write(join(sub, '.gitkeep'), '')
    try {
      const cwd = new WorkingDirState(root)
      const cd = makeShellCd({ cwd, agentDir: '/tmp/fake-agent-dir' })
      const out = await cd.handler({ path: 'sub' })
      const expected = await realpath(sub)
      expect(out.ok).toBe(true)
      expect((out.data as { cwd: string }).cwd).toBe(expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses paths outside permitted scope (~/.ssh)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lyra-cd-ssh-'))
    try {
      const cwd = new WorkingDirState(root)
      const cd = makeShellCd({ cwd, agentDir: '/tmp/fake-agent-dir' })
      const out = await cd.handler({ path: join(homedir(), '.ssh') })
      expect(out.ok).toBe(false)
      expect(out.error).toContain('protected path')
      expect(cwd.get()).toBe(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses paths under the agent state tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lyra-cd-agentdir-'))
    const fakeAgentDir = join(root, 'agent-state')
    await Bun.write(join(fakeAgentDir, 'memory.md'), 'x')
    try {
      const cwd = new WorkingDirState(root)
      const cd = makeShellCd({ cwd, agentDir: fakeAgentDir })
      const out = await cd.handler({ path: fakeAgentDir })
      expect(out.ok).toBe(false)
      expect(out.error).toContain('protected path')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses non-existent paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lyra-cd-nx-'))
    try {
      const cwd = new WorkingDirState(root)
      const cd = makeShellCd({ cwd, agentDir: '/tmp/fake-agent-dir' })
      const out = await cd.handler({ path: join(root, 'does-not-exist') })
      expect(out.ok).toBe(false)
      expect(out.error).toContain('stat failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses paths that point to a regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lyra-cd-file-'))
    const filePath = join(root, 'README.md')
    await Bun.write(filePath, 'hello')
    try {
      const cwd = new WorkingDirState(root)
      const cd = makeShellCd({ cwd, agentDir: '/tmp/fake-agent-dir' })
      const out = await cd.handler({ path: filePath })
      expect(out.ok).toBe(false)
      expect(out.error).toContain('not a directory')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('shell.run sees the new cwd after shell.cd', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'lyra-cd-shr-a-'))
    const dir2 = await mkdtemp(join(tmpdir(), 'lyra-cd-shr-b-'))
    const dir2Real = await realpath(dir2)
    try {
      const cwd = new WorkingDirState(dir1)
      const cd = makeShellCd({ cwd, agentDir: '/tmp/fake-agent-dir' })
      const run = makeShellRun({ cwd })
      // Before cd: pwd reports dir1.
      const before = await run.handler({ command: 'pwd' })
      expect((before.data as { stdout: string; cwd: string }).cwd).toBe(dir1)
      // shell.cd to dir2.
      const cdRes = await cd.handler({ path: dir2 })
      expect(cdRes.ok).toBe(true)
      // After cd: pwd reports dir2 (canonicalised).
      const after = await run.handler({ command: 'pwd' })
      expect((after.data as { cwd: string }).cwd).toBe(dir2Real)
      expect((after.data as { stdout: string }).stdout.trim()).toBe(dir2Real)
    } finally {
      await rm(dir1, { recursive: true, force: true })
      await rm(dir2, { recursive: true, force: true })
    }
  })
})
