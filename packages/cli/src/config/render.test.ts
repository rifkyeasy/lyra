import { describe, expect, test } from 'bun:test'
import type { NebulaConfig } from 'nebula-ai-core'
import { renderConfigTs } from './render'

const baseConfig: NebulaConfig = {
  identity: { operator: null, agent: null },
  network: 'mantle-mainnet',
  storage: { network: 'mantle-mainnet' },
  brain: { provider: null, model: null },
  plugins: ['system'],
  tools: {},
  imports: { claudeCode: true },
}

describe('renderConfigTs sandbox block', () => {
  test('fresh config (no sandbox set) emits default + commented examples for each tier', () => {
    const out = renderConfigTs(baseConfig)
    // Active default
    expect(out).toContain(`sandbox: { mode: 'none' }`)
    // Commented OPTION 2 (os)
    expect(out).toContain('OPTION 2: os')
    expect(out).toContain(`//  sandbox: { mode: 'os' }`)
    // Commented OPTION 3 (docker)
    expect(out).toContain('OPTION 3: docker')
    expect(out).toContain(`//    mode: 'docker'`)
    expect(out).toContain(`//    dockerImage: 'nikolaik/python-nodejs:python3.11-nodejs20'`)
    expect(out).toContain('//    dockerMountWorkspace: false')
    // NEBULA_SANDBOX_MODE override hint
    expect(out).toContain('NEBULA_SANDBOX_MODE')
  })

  test('config with sandbox.mode="os" already set emits the chosen value, not the template', () => {
    const out = renderConfigTs({ ...baseConfig, sandbox: { mode: 'os' } })
    expect(out).toContain(`"mode": "os"`)
    // No verbose template when operator already chose
    expect(out).not.toContain('OPTION 2: os')
    expect(out).not.toContain('OPTION 3: docker')
  })

  test('config with sandbox.mode="docker" + image emits the full chosen object', () => {
    const out = renderConfigTs({
      ...baseConfig,
      sandbox: {
        mode: 'docker',
        dockerImage: 'custom/img:tag',
        dockerMountWorkspace: true,
      },
    })
    expect(out).toContain(`"mode": "docker"`)
    expect(out).toContain(`"dockerImage": "custom/img:tag"`)
    expect(out).toContain(`"dockerMountWorkspace": true`)
    expect(out).not.toContain('OPTION')
  })

  test('annotated template documents resource caps with hermes default values', () => {
    const out = renderConfigTs(baseConfig)
    expect(out).toContain('// dockerCpu: 1')
    expect(out).toContain('// dockerMemoryMb: 5120')
    expect(out).toContain('// dockerDiskMb: 51200')
    expect(out).toContain('// dockerNoNetwork: true')
  })

  test('config with sandbox docker + resource caps emits chosen numeric values', () => {
    const out = renderConfigTs({
      ...baseConfig,
      sandbox: {
        mode: 'docker',
        dockerCpu: 2,
        dockerMemoryMb: 4096,
        dockerNoNetwork: true,
      },
    })
    expect(out).toContain(`"dockerCpu": 2`)
    expect(out).toContain(`"dockerMemoryMb": 4096`)
    expect(out).toContain(`"dockerNoNetwork": true`)
    expect(out).not.toContain('OPTION')
  })

  test('output is valid TypeScript (parses as a default-export module)', async () => {
    const out = renderConfigTs(baseConfig)
    const { writeFile, rm, mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'nebula-render-test-'))
    const path = join(dir, 'config.ts')
    try {
      await writeFile(path, out, 'utf8')
      const mod = await import(path)
      expect(mod.default).toBeDefined()
      expect(mod.default.sandbox).toEqual({ mode: 'none' })
      expect(mod.default.network).toBe('mantle-mainnet')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
