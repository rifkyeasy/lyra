import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxBackend, SandboxSpawnRequest, WrappedSpawn } from 'lyra-core'
import { makeShellRun } from './shell'

describe('shell.run', () => {
  it('captures stdout and exit code on success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lyra-shell-'))
    try {
      const tool = makeShellRun({ cwd: dir })
      const out = await tool.handler({ command: 'echo hello' })
      expect(out.ok).toBe(true)
      const d = out.data as { stdout: string; code: number }
      expect(d.stdout.trim()).toBe('hello')
      expect(d.code).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('reports non-zero exits as ok=false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lyra-shell-'))
    try {
      const tool = makeShellRun({ cwd: dir })
      const out = await tool.handler({ command: 'exit 7' })
      expect(out.ok).toBe(false)
      const d = out.data as { code: number }
      expect(d.code).toBe(7)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('redacts wallet secrets from the spawned environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lyra-shell-'))
    process.env.LYRA_AGENT_PRIVKEY_HEX = '0xdead'
    try {
      const tool = makeShellRun({ cwd: dir })
      const out = await tool.handler({ command: 'echo ${LYRA_AGENT_PRIVKEY_HEX:-MISSING}' })
      expect(out.ok).toBe(true)
      const d = out.data as { stdout: string; redactedEnvVars: string[] }
      expect(d.stdout.trim()).toBe('MISSING')
      expect(d.redactedEnvVars).toContain('LYRA_AGENT_PRIVKEY_HEX')
    } finally {
      process.env.LYRA_AGENT_PRIVKEY_HEX = undefined
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('kills the process on timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lyra-shell-'))
    try {
      const tool = makeShellRun({ cwd: dir })
      const out = await tool.handler({ command: 'sleep 5', timeout_ms: 200 })
      expect(out.ok).toBe(false)
      const d = out.data as { timedOut: boolean }
      expect(d.timedOut).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  // Phase 9.5 integration: shell.run must delegate every spawn through the
  // SandboxBackend so that mode='os' actually wraps the command.
  it('routes every spawn through SandboxBackend.wrapSpawn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lyra-shell-'))
    try {
      const seen: SandboxSpawnRequest[] = []
      const fakeBackend: SandboxBackend = {
        mode: 'none',
        label: 'test',
        async wrapSpawn(req): Promise<WrappedSpawn> {
          seen.push(req)
          return { command: req.command, args: req.args, options: req.options }
        },
      }
      const tool = makeShellRun({ cwd: dir, sandbox: fakeBackend })
      await tool.handler({ command: 'echo backend-was-called' })
      expect(seen.length).toBe(1)
      expect(seen[0]?.command).toBe('/bin/sh')
      expect(seen[0]?.args).toEqual(['-c', 'echo backend-was-called'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
