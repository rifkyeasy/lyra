/**
 * Hermes-aligned Telegram setup wizard step. Shared by `nebula telegram setup`
 * (standalone) and the optional Phase E in `nebula init` (right after Phase D
 * summary, reusing the in-flight operator wallet so we don't prompt Touch ID
 * twice).
 *
 * Flow (matches `~/.hermes/hermes-agent/hermes_cli/{setup.py:1720, gateway.py:1939}`):
 *   1. Bot token (password input + `getMe` probe).
 *   2. Auth-mode select: pair (default) or allowlist.
 *   3. Allowlist branch: text prompt for IDs + @userinfobot hint.
 *   4. Encrypt + save secrets to `~/.nebula/agents/<id>/telegram-secrets.encrypted`.
 *   5. Merge `'telegram'` into config.plugins; rewrite `~/.nebula/config.ts`.
 *
 * Caller frames its own intro/outro. This helper is content-only.
 */
import { cancel, confirm, isCancel, note, password, select, spinner, text } from '@clack/prompts'
import {
  type NebulaConfig,
  type NebulaNetwork,
  type NebulaPlugin,
  OPERATOR_BLOB_SCOPES,
  type OperatorSigner,
  agentPaths,
  deriveBlobKey,
} from 'nebula-ai-core'
import { type Address, type Hex, bytesToHex } from 'viem'
import { writeConfigTs } from '../../config/render'
import {
  fetchBotInfo,
  looksLikeBotToken,
  parseAllowedUserIds,
  saveTelegramSecrets,
  telegramSecretsExist,
} from '../../util/telegram-secrets'

/**
 * Resolve the runtime plugin list when telegram is configured. Auto-includes
 * `'telegram'` so the listener is registered; otherwise `build-runtime.ts`
 * would gate it on `pluginNames.includes('telegram')` and skip registration.
 * Default base: `['system', 'comms', 'onchain']`. Idempotent.
 */
export function resolveHandoffPlugins(
  caller: NebulaPlugin[] | undefined,
  shipsTelegramSecrets: boolean,
): NebulaPlugin[] {
  const base = caller ?? (['system', 'comms', 'onchain'] satisfies NebulaPlugin[])
  if (!shipsTelegramSecrets) return base
  if (base.includes('telegram')) return base
  return [...base, 'telegram']
}

export type TelegramAuthMode = 'pair' | 'allowlist'

export interface TelegramStepOpts {
  /** Already-unlocked operator wallet. Caller is responsible for closing it. */
  signer: OperatorSigner
  agentId: string
  agentAddress: Address
  configPath: string
  config: NebulaConfig
  network: NebulaNetwork
  /**
   * If true, the helper is allowed to ask whether to overwrite an existing
   * blob via `confirm`. Default true. Set false for fully non-interactive
   * test paths.
   */
  allowOverwrite?: boolean
  /**
   * v0.24.4: when true, do NOT write the config file from inside this step —
   * caller (init.ts) builds the final cfg with `'telegram'` in plugins and
   * writes once. Avoids the partial-write hazard where Phase E runs before
   * the init's main config build and the intermediate write has incomplete
   * identity/sandbox fields. Standalone `nebula telegram setup` keeps the
   * default false so it still rewrites the config.
   */
  skipConfigWrite?: boolean
}

export interface TelegramStepResult {
  configured: boolean
  /** Set when `configured: true`. */
  botUsername?: string
  modeUsed?: TelegramAuthMode
  allowedUserIds?: number[]
  /** Set when configured aborted by user (cancel / no-overwrite). */
  cancelled?: boolean
  /**
   * v0.24.3: derived TELEGRAM scope key as 0x-prefixed hex. Caller stashes
   * this in `.operator-session` so the daemon auto-spawns without re-prompting
   * Touch ID. Hex (not Buffer) to match `OperatorSessionKeys`' on-disk shape.
   */
  telegramScopeKeyHex?: Hex
}

const PAIR_OPTION_LABEL =
  'Pair (recommended) — unknown DM users get an 8-char code; you approve via CLI'
const ALLOW_OPTION_LABEL =
  'Allowlist — only listed numeric Telegram IDs can DM the bot (find yours via @userinfobot)'

export async function runTelegramStep(opts: TelegramStepOpts): Promise<TelegramStepResult> {
  if (telegramSecretsExist(opts.agentId)) {
    if (opts.allowOverwrite === false) {
      return { configured: false, cancelled: true }
    }
    const overwrite = await confirm({
      message:
        'Encrypted telegram-secrets blob already exists for this agent. Overwrite with new settings?',
      initialValue: false,
    })
    if (isCancel(overwrite) || overwrite !== true) {
      return { configured: false, cancelled: true }
    }
  }

  const tokenRaw = (await password({
    message: 'Bot token from @BotFather',
    validate: v => {
      if (!v) return 'Required.'
      if (!looksLikeBotToken(v))
        return 'Looks malformed. Expected `<id>:<secret>` from @BotFather, e.g. 1234567890:AABBCC...'
      return undefined
    },
  })) as string | symbol
  if (isCancel(tokenRaw)) {
    return { configured: false, cancelled: true }
  }
  const botToken = (tokenRaw as string).trim()

  const sValidate = spinner()
  sValidate.start('Validating token via api.telegram.org/getMe')
  let botInfo: Awaited<ReturnType<typeof fetchBotInfo>>
  try {
    botInfo = await fetchBotInfo(botToken)
    sValidate.stop(`bot ok: @${botInfo.username} (id ${botInfo.id})`)
  } catch (e) {
    sValidate.stop(`token rejected: ${(e as Error).message.slice(0, 200)}`)
    cancel('Bad token. Re-issue via /token in @BotFather and re-run setup.')
    return { configured: false, cancelled: true }
  }

  const modeChoice = await select({
    message: 'How should unauthorized DMs to the bot be handled?',
    options: [
      { value: 'pair' as TelegramAuthMode, label: PAIR_OPTION_LABEL },
      { value: 'allowlist' as TelegramAuthMode, label: ALLOW_OPTION_LABEL },
    ],
    initialValue: 'pair' as TelegramAuthMode,
  })
  if (isCancel(modeChoice)) {
    return { configured: false, cancelled: true }
  }
  const mode = modeChoice as TelegramAuthMode

  let allowedUserIds: number[] = []
  if (mode === 'allowlist') {
    const allowedRaw = (await text({
      message: 'Allowed Telegram user IDs (comma-separated)',
      placeholder: '123456789, 987654321',
      defaultValue: '',
      validate: v => {
        if (!v) return 'At least one numeric id required (or pick Pair mode instead).'
        const parsed = parseAllowedUserIds(v)
        if (!parsed.ok) return parsed.reason
        if (parsed.ids.length === 0) return 'At least one numeric id required.'
        return undefined
      },
    })) as string | symbol
    if (isCancel(allowedRaw)) {
      return { configured: false, cancelled: true }
    }
    const parsed = parseAllowedUserIds(typeof allowedRaw === 'string' ? allowedRaw : '')
    if (!parsed.ok || parsed.ids.length === 0) {
      cancel(`bad allowed list: ${parsed.ok ? 'empty' : parsed.reason}`)
      return { configured: false, cancelled: true }
    }
    allowedUserIds = parsed.ids
    note(
      `Approved on day one: ${allowedUserIds.join(', ')}\nThese users can DM @${botInfo.username} immediately. Anyone else still falls into pairing.`,
      'allowlist',
    )
  } else {
    note(
      `Default-deny is on: any unknown user who DMs @${botInfo.username}\nwill receive a one-time pairing code. Approve them out-of-band:\n  nebula pairing approve telegram <CODE>\nTo skip pairing for yourself, re-run setup, pick Allowlist, and paste your numeric id\n(get it from @userinfobot).`,
      'pairing mode',
    )
  }

  // v0.24.3: derive TELEGRAM key explicitly so we can both pass it as
  // `precomputedKey` (skip the redundant sign inside encryptOperatorBlob)
  // AND return it to init.ts to stash in `.operator-session`.
  const sDerive = spinner()
  sDerive.start('Deriving TELEGRAM scope key')
  let telegramScopeKey: Buffer
  try {
    telegramScopeKey = await deriveBlobKey(
      opts.signer,
      opts.agentAddress,
      OPERATOR_BLOB_SCOPES.TELEGRAM,
    )
    sDerive.stop('TELEGRAM scope key derived')
  } catch (e) {
    sDerive.stop(`TELEGRAM scope derive failed: ${(e as Error).message.slice(0, 200)}`)
    return { configured: false, cancelled: true }
  }

  const sSave = spinner()
  sSave.start('Encrypting + saving telegram secrets locally')
  try {
    await saveTelegramSecrets({
      signer: opts.signer,
      agentAddress: opts.agentAddress,
      agentId: opts.agentId,
      plaintext: {
        botToken,
        botUsername: botInfo.username,
        botId: botInfo.id,
        allowedUserIds,
      },
      precomputedKey: telegramScopeKey,
    })
    sSave.stop(`saved → ${agentPaths.agent(opts.agentId).dir}/telegram-secrets.encrypted`)
  } catch (e) {
    sSave.stop(`save failed: ${(e as Error).message.slice(0, 200)}`)
    return { configured: false, cancelled: true }
  }

  // v0.24.4: when caller asks (init.ts), skip the config rewrite — caller will
  // build the final cfg with `'telegram'` in plugins and write once. Avoids the
  // partial-write hazard where Phase E runs before init's main config build.
  if (!opts.skipConfigWrite) {
    const plugins = resolveHandoffPlugins(opts.config.plugins, true)
    if (plugins.length !== (opts.config.plugins ?? []).length) {
      const updated = { ...opts.config, plugins }
      await writeConfigTs(opts.configPath, updated)
    }
  }

  return {
    configured: true,
    botUsername: botInfo.username,
    modeUsed: mode,
    allowedUserIds,
    telegramScopeKeyHex: bytesToHex(telegramScopeKey),
  }
}
