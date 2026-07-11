import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ALLOWED_COINS,
  DEFAULT_ALLOWED_PROTOCOLS,
  DEFAULT_AUTO_MAX_SUI,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  DEFAULT_MAX_PER_TX_SUI,
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_NETWORK,
  DEFAULT_PACKAGE_ID,
  defaultPolicyEnv,
  hasNoPolicyEnv,
  resolveLlmBaseUrl,
  resolveLlmModel,
  resolveNetwork,
  resolvePackageId,
  resolvePolicyEnv,
} from './defaults'

describe('config defaults (zero-env-var)', () => {
  test('exported constant values match the shared contract', () => {
    expect(DEFAULT_PACKAGE_ID).toBe(
      '0x1925bced9aeb16ca8159be0a10d39a0778fe618404443a4b6149116ad9997617',
    )
    expect(DEFAULT_NETWORK).toBe('mainnet')
    expect(DEFAULT_LLM_BASE_URL).toBe('https://api.openai.com/v1')
    expect(DEFAULT_LLM_MODEL).toBe('gpt-4o-mini')
    expect(DEFAULT_MAX_PER_TX_SUI).toBe(1)
    expect(DEFAULT_AUTO_MAX_SUI).toBe(0.1)
    expect(DEFAULT_MAX_SLIPPAGE_BPS).toBe(100)
    expect(DEFAULT_ALLOWED_COINS).toEqual(['0x2::sui::SUI'])
    expect(DEFAULT_ALLOWED_PROTOCOLS).toEqual([
      'transfer',
      'swap',
      'stake',
      'borrow',
      'deepbook',
      'scallop',
      'navi',
      'suilend',
      'walrus',
    ])
  })

  test('resolvePackageId: default when env unset, env wins when set', () => {
    expect(resolvePackageId({})).toBe(DEFAULT_PACKAGE_ID)
    expect(resolvePackageId({ LYRA_PACKAGE_ID: '0xabc' })).toBe('0xabc')
    // Blank/whitespace env falls back to the default.
    expect(resolvePackageId({ LYRA_PACKAGE_ID: '   ' })).toBe(DEFAULT_PACKAGE_ID)
  })

  test('resolveNetwork: default mainnet, env override, ignores garbage', () => {
    expect(resolveNetwork({})).toBe('mainnet')
    expect(resolveNetwork({ LYRA_NETWORK: 'testnet' })).toBe('testnet')
    expect(resolveNetwork({ LYRA_NETWORK: 'devnet' })).toBe('mainnet')
  })

  test('resolveLlmBaseUrl / resolveLlmModel: default then env override', () => {
    expect(resolveLlmBaseUrl({})).toBe(DEFAULT_LLM_BASE_URL)
    expect(resolveLlmBaseUrl({ LYRA_LLM_BASE_URL: 'https://gw' })).toBe('https://gw')
    expect(resolveLlmModel({})).toBe(DEFAULT_LLM_MODEL)
    expect(resolveLlmModel({ LYRA_LLM_MODEL: 'gpt-4o' })).toBe('gpt-4o')
  })

  test('defaultPolicyEnv produces a bounded LYRA_POLICY_* record', () => {
    const env = defaultPolicyEnv()
    expect(env.LYRA_POLICY_MAX_PER_TX_SUI).toBe('1')
    expect(env.LYRA_POLICY_AUTO_MAX_SUI).toBe('0.1')
    expect(env.LYRA_POLICY_MAX_SLIPPAGE_BPS).toBe('100')
    expect(env.LYRA_POLICY_ALLOWED_COINS).toBe('0x2::sui::SUI')
    expect(env.LYRA_POLICY_ALLOWED_PROTOCOLS).toBe(
      'transfer,swap,stake,borrow,deepbook,scallop,navi,suilend,walrus',
    )
  })

  test('hasNoPolicyEnv: true with no policy vars, false when any set', () => {
    expect(hasNoPolicyEnv({})).toBe(true)
    expect(hasNoPolicyEnv({ OPENAI_API_KEY: 'x' })).toBe(true)
    expect(hasNoPolicyEnv({ LYRA_POLICY_MAX_PER_TX_SUI: '5' })).toBe(false)
  })

  test('resolvePolicyEnv: seeds defaults only when no policy var is set', () => {
    // No policy env → defaults applied.
    const seeded = resolvePolicyEnv({})
    expect(seeded.LYRA_POLICY_MAX_PER_TX_SUI).toBe('1')
    expect(seeded.LYRA_POLICY_ALLOWED_PROTOCOLS).toContain('deepbook')

    // Any policy env present → caller's env passed through untouched (no merge).
    const userEnv = { LYRA_POLICY_MAX_PER_TX_SUI: '5' }
    const passed = resolvePolicyEnv(userEnv)
    expect(passed.LYRA_POLICY_MAX_PER_TX_SUI).toBe('5')
    expect(passed.LYRA_POLICY_ALLOWED_PROTOCOLS).toBeUndefined()
  })
})
