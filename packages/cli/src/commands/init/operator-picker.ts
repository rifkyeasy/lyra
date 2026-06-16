import { existsSync } from 'node:fs'
import { cancel, isCancel, note, password, select, text } from '@clack/prompts'
import {
  KeychainOperatorSigner,
  KeystoreFileOperatorSigner,
  type NebulaNetwork,
  type OperatorSigner,
  type OperatorSourceHint,
  type OperatorSourceKind,
  RawPrivkeyOperatorSigner,
  WalletConnectOperatorSigner,
} from 'nebula-ai-core'

interface PickerOptions {
  network: NebulaNetwork
}

export interface OperatorPickResult {
  signer: OperatorSigner
  hint: OperatorSourceHint
}

/**
 * Prompt the user for their operator wallet source and return both the
 * connected `OperatorSigner` and the metadata needed to reconstruct it
 * later (`OperatorSourceHint`). The hint is saved to `nebula.config.ts` by
 * the wizard so subsequent commands (chat, topup, restore) can re-attach
 * to the same source without re-prompting.
 *
 * Platform-aware: on macOS, all four sources are offered. On Linux/Windows
 * the OS keychain option is hidden because libsecret/Credential-Manager
 * support is post-MVP.
 */
export async function pickOperatorSigner(opts: PickerOptions): Promise<OperatorPickResult | null> {
  const isMac = process.platform === 'darwin'
  const choices: { value: OperatorSourceKind; label: string; hint?: string }[] = [
    {
      value: 'walletconnect',
      label: 'WalletConnect',
      hint: 'scan QR with any WC-compatible mobile wallet',
    },
    ...(isMac
      ? ([
          {
            value: 'keychain',
            label: 'macOS Keychain',
            hint: 'stored in login keychain',
          },
        ] as const)
      : []),
    {
      value: 'keystore-file',
      label: 'Keystore file',
      hint: 'encrypted JSON, geth format',
    },
    {
      value: 'raw-privkey',
      label: 'Raw private key',
      hint: 'stdin prompt, for CI/scripting',
    },
  ]
  const source = (await select({
    message: 'Connect your operator wallet (owns the iNFT)',
    options: choices,
    initialValue: choices[0]!.value,
  })) as OperatorSourceKind | symbol
  if (isCancel(source)) {
    cancel('Aborted.')
    return null
  }

  switch (source) {
    case 'walletconnect':
      return {
        signer: new WalletConnectOperatorSigner({ networks: [opts.network] }),
        hint: { source: 'walletconnect' },
      }
    case 'keychain': {
      const service = await text({
        message: 'Keychain service name',
        placeholder: 'nebula.operator',
        validate: v => {
          if (!v || v.length === 0) return 'Required.'
          if (!/^[a-zA-Z0-9._-]{1,128}$/.test(v))
            return 'Allowed characters: a-z, A-Z, 0-9, dot, underscore, hyphen (max 128).'
          return undefined
        },
      })
      if (isCancel(service)) {
        cancel('Aborted.')
        return null
      }
      const svc = service as string
      return {
        signer: new KeychainOperatorSigner(svc),
        hint: { source: 'keychain', keychainService: svc },
      }
    }
    case 'keystore-file': {
      const path = await text({
        message: 'Path to encrypted JSON keystore',
        placeholder: '~/wallets/operator.json',
        validate: v => {
          if (!v) return 'Required.'
          const expanded = v.replace(/^~/, process.env.HOME ?? '~')
          if (!existsSync(expanded)) return `File not found: ${expanded}`
          return undefined
        },
      })
      if (isCancel(path)) {
        cancel('Aborted.')
        return null
      }
      const expanded = (path as string).replace(/^~/, process.env.HOME ?? '~')
      const pass = await password({
        message: 'Passphrase for the keystore',
        validate: v => (v && v.length > 0 ? undefined : 'Required.'),
      })
      if (isCancel(pass)) {
        cancel('Aborted.')
        return null
      }
      return {
        signer: new KeystoreFileOperatorSigner({ path: expanded, passphrase: pass as string }),
        hint: { source: 'keystore-file', keystorePath: path as string },
      }
    }
    case 'raw-privkey': {
      if (process.env.NEBULA_OPERATOR_PRIVKEY) {
        note('Using NEBULA_OPERATOR_PRIVKEY from env.', 'raw-privkey')
        return {
          signer: new RawPrivkeyOperatorSigner({
            privkey: process.env.NEBULA_OPERATOR_PRIVKEY,
            sourceLabel: 'env:NEBULA_OPERATOR_PRIVKEY',
          }),
          hint: { source: 'raw-privkey' },
        }
      }
      const pk = await password({
        message: 'Operator private key (hex, 0x prefix optional)',
        validate: v => {
          if (!v) return 'Required.'
          const clean = v.trim().replace(/^0x/, '')
          if (!/^[0-9a-fA-F]{64}$/.test(clean)) return 'Must be 32 bytes hex.'
          return undefined
        },
      })
      if (isCancel(pk)) {
        cancel('Aborted.')
        return null
      }
      return {
        signer: new RawPrivkeyOperatorSigner({ privkey: pk as string, sourceLabel: 'stdin' }),
        hint: { source: 'raw-privkey' },
      }
    }
  }
}

/**
 * Reload an `OperatorSigner` from a previously persisted hint in
 * `nebula.config.ts`. Used by chat / topup / restore / resume so the user
 * doesn't re-pick a source every session — they only re-supply per-session
 * secrets (passphrases / QR scans / env vars).
 *
 * Returns null when the hint is missing or unusable; the caller falls back
 * to `pickOperatorSigner` for an interactive choice.
 */
export async function loadOperatorFromHint(
  hint: OperatorSourceHint,
  network: NebulaNetwork,
): Promise<OperatorSigner | null> {
  switch (hint.source) {
    case 'walletconnect':
      return new WalletConnectOperatorSigner({ networks: [network] })
    case 'keychain': {
      if (!hint.keychainService) return null
      return new KeychainOperatorSigner(hint.keychainService)
    }
    case 'keystore-file': {
      if (!hint.keystorePath) return null
      const expanded = hint.keystorePath.replace(/^~/, process.env.HOME ?? '~')
      if (!existsSync(expanded)) {
        note(`Operator keystore not found at ${expanded}; pick a new source.`, 'keystore missing')
        return null
      }
      const pass = await password({
        message: `Passphrase for operator keystore ${expanded}`,
        validate: v => (v && v.length > 0 ? undefined : 'Required.'),
      })
      if (isCancel(pass)) return null
      return new KeystoreFileOperatorSigner({
        path: expanded,
        passphrase: pass as string,
      })
    }
    case 'raw-privkey': {
      if (process.env.NEBULA_OPERATOR_PRIVKEY) {
        return new RawPrivkeyOperatorSigner({
          privkey: process.env.NEBULA_OPERATOR_PRIVKEY,
          sourceLabel: 'env:NEBULA_OPERATOR_PRIVKEY',
        })
      }
      const pk = await password({
        message: 'Operator private key (hex, 0x prefix optional)',
        validate: v => {
          if (!v) return 'Required.'
          const clean = v.trim().replace(/^0x/, '')
          if (!/^[0-9a-fA-F]{64}$/.test(clean)) return 'Must be 32 bytes hex.'
          return undefined
        },
      })
      if (isCancel(pk)) return null
      return new RawPrivkeyOperatorSigner({ privkey: pk as string, sourceLabel: 'stdin' })
    }
  }
}

/**
 * High-level helper: load operator from config hint when available, fall
 * back to interactive picker otherwise. Used by all post-init commands.
 */
export async function loadOrPickOperatorSigner(opts: {
  network: NebulaNetwork
  hint?: OperatorSourceHint | null
}): Promise<OperatorSigner | null> {
  if (opts.hint) {
    const signer = await loadOperatorFromHint(opts.hint, opts.network)
    if (signer) return signer
  }
  const picked = await pickOperatorSigner({ network: opts.network })
  return picked?.signer ?? null
}
