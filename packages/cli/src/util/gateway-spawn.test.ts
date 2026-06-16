/**
 * Bundle B unit tests: spawnGatewayDaemon path. Uses a tiny shell-stub bin
 * that "binds" the socket by simply touching the path then sleeping. We
 * avoid spinning up the real `bun packages/gateway/bin/nebula-gateway-local`
 * because that pulls in keystore + viem + Mantle SDKs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnGatewayDaemon } from './gateway-spawn'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'nebula-spawn-test-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('spawnGatewayDaemon', () => {
  it('reports pre-existing when sock already present', async () => {
    const sock = join(workDir, 'gateway.sock')
    writeFileSync(sock, '')
    const r = await spawnGatewayDaemon({
      agentId: 'a1',
      configPath: 'cfg',
      socketPath: sock,
      binPath: join(workDir, 'unused-bin'),
      timeoutMs: 100,
    })
    expect(r.ready).toBe(false)
    expect(r.reason).toBe('pre-existing')
  })

  it('reports timeout when bin does not bind the sock', async () => {
    const sock = join(workDir, 'gateway.sock')
    const stub = join(workDir, 'noop.ts')
    writeFileSync(stub, 'setTimeout(() => process.exit(0), 50)\n')
    const r = await spawnGatewayDaemon({
      agentId: 'a3',
      configPath: 'cfg',
      socketPath: sock,
      binPath: stub,
      timeoutMs: 600,
      stdio: 'ignore',
    })
    expect(r.ready).toBe(false)
    expect(r.reason).toBe('timeout')
    expect(existsSync(sock)).toBe(false)
  })

  it('returns ready=true when bin binds the sock + passes env', async () => {
    const sock = join(workDir, 'gateway.sock')
    const envOut = join(workDir, 'env.out')
    const stub = join(workDir, 'env-stub.ts')
    writeFileSync(
      stub,
      `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(envOut)}, JSON.stringify({
  agent: process.env.NEBULA_AGENT_ID,
  config: process.env.NEBULA_CONFIG,
}))
writeFileSync(${JSON.stringify(sock)}, '')
setTimeout(() => process.exit(0), 200)
`,
    )
    const r = await spawnGatewayDaemon({
      agentId: 'agent-EXPECTED',
      configPath: '/path/to/cfg.ts',
      socketPath: sock,
      binPath: stub,
      timeoutMs: 8_000,
      stdio: 'ignore',
    })
    expect(r.ready).toBe(true)
    expect(r.pid).toBeNumber()
    const { readFileSync } = await import('node:fs')
    const captured = JSON.parse(readFileSync(envOut, 'utf8'))
    expect(captured.agent).toBe('agent-EXPECTED')
    expect(captured.config).toBe('/path/to/cfg.ts')
  })
})
