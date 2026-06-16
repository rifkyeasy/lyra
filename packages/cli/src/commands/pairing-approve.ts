import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PairingStore,
  agentPaths,
  placeholderAgentId,
} from 'nebula-ai-core'
import { findAndLoadConfig } from '../config/load'

export interface RunPairingApproveOpts {
  platform: string
  code: string
}

export async function runPairingApprove(opts: RunPairingApproveOpts): Promise<void> {
  const normalized = opts.code.toUpperCase().trim()
  if (normalized.length !== PAIRING_CODE_LENGTH) {
    console.error(
      `Invalid pairing code: expected ${PAIRING_CODE_LENGTH} characters, got ${normalized.length}`,
    )
    process.exit(1)
  }
  for (const ch of normalized) {
    if (!PAIRING_ALPHABET.includes(ch)) {
      console.error(`Invalid pairing code: contains '${ch}' which is not in the pairing alphabet`)
      process.exit(1)
    }
  }

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    console.error('No nebula.config.ts found. Run `nebula init` first.')
    process.exit(1)
  }
  const { config } = loaded
  if (!config.identity.agent) {
    console.error('Config has no agent. Run `nebula init` first.')
    process.exit(1)
  }

  // Operate directly on the host's PairingStore (same path as the daemon
  // process when NEBULA_FORCE_EMBEDDED or local-mode chat.tsx).
  const agentId = placeholderAgentId(config.identity.agent)
  const dir = agentPaths.agent(agentId).pairingDir
  const store = new PairingStore({ dir })

  const result = store.approveCode(opts.platform, normalized)
  if (!result) {
    if (store.isLockedOut(opts.platform)) {
      console.error(
        `Platform '${opts.platform}' is locked out due to repeated bad codes. Wait 1 hour and try again.`,
      )
      process.exit(1)
    }
    console.error(`Code ${normalized} not found in pending list. Maybe it expired (1h TTL).`)
    process.exit(1)
  }

  console.log(
    `✓ Approved on ${opts.platform}: id=${result.userId}${
      result.userName ? ` (@${result.userName})` : ''
    }`,
  )
  console.log('The user can now DM the bot. Their next message will be processed.')
}
