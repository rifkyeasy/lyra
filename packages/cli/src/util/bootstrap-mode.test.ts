import { describe, expect, it } from 'bun:test'
import { resolveBootstrapMode } from './bootstrap-mode'

describe('resolveBootstrapMode', () => {
  it('defaults to npm when no env is set', () => {
    expect(resolveBootstrapMode({})).toBe('npm')
  })

  it('respects explicit NEBULA_BOOTSTRAP_MODE=git', () => {
    expect(resolveBootstrapMode({ NEBULA_BOOTSTRAP_MODE: 'git' })).toBe('git')
  })

  it('respects explicit NEBULA_BOOTSTRAP_MODE=npm', () => {
    expect(resolveBootstrapMode({ NEBULA_BOOTSTRAP_MODE: 'npm' })).toBe('npm')
  })

  it("auto-implies git when NEBULA_BOOTSTRAP_REF is set without explicit mode (preserves 'deploy main' workflow)", () => {
    expect(resolveBootstrapMode({ NEBULA_BOOTSTRAP_REF: 'main' })).toBe('git')
    expect(resolveBootstrapMode({ NEBULA_BOOTSTRAP_REF: 'abc1234' })).toBe('git')
  })

  it('lets explicit MODE win over REF (e.g. NPM=v0.21.20 alongside REF=ignored)', () => {
    expect(
      resolveBootstrapMode({ NEBULA_BOOTSTRAP_MODE: 'npm', NEBULA_BOOTSTRAP_REF: 'main' }),
    ).toBe('npm')
    expect(
      resolveBootstrapMode({ NEBULA_BOOTSTRAP_MODE: 'git', NEBULA_BOOTSTRAP_REF: 'main' }),
    ).toBe('git')
  })

  it('falls through to npm on garbage NEBULA_BOOTSTRAP_MODE (typos, uppercase, etc.)', () => {
    expect(resolveBootstrapMode({ NEBULA_BOOTSTRAP_MODE: 'GIT' })).toBe('npm')
    expect(resolveBootstrapMode({ NEBULA_BOOTSTRAP_MODE: 'Npm' })).toBe('npm')
    expect(resolveBootstrapMode({ NEBULA_BOOTSTRAP_MODE: 'docker' })).toBe('npm')
  })

  it('treats empty-string NEBULA_BOOTSTRAP_REF as unset (does not flip to git)', () => {
    expect(resolveBootstrapMode({ NEBULA_BOOTSTRAP_REF: '' })).toBe('npm')
  })
})
