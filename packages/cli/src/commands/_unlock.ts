import { readFile } from 'node:fs/promises'
import { spinner } from '@clack/prompts'
import {
  type NebulaConfig,
  type NebulaNetwork,
  agentPaths,
  decodeKeystoreBytes,
  decryptAgentKey,
  placeholderAgentId,
} from 'nebula-ai-core'
import type { Address, Hex } from 'viem'
import { withSilencedConsole } from '../util/silence-console'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export interface UnlockedAgent {
  agentPrivkey: Hex
  agentAddress: Address
  network: NebulaNetwork
  close: () => Promise<void>
}

/**
 * Shared operator-unlock dance for any command that needs the agent privkey:
 *  1. pick the operator signer (keystore / WC / keychain) per config hint
 *  2. read the local encrypted keystore cache
 *  3. decrypt via operator signature
 *
 * Returns null if the operator picker is cancelled or the keystore can't be
 * decrypted; caller should bail out early on null.
 *
 * Caller MUST call `close()` once done with the privkey, even on success, to
 * release WC sessions / keystore tmpfiles.
 */
export async function unlockAgentSigner(
  config: NebulaConfig,
  spinnerLabel = 'Decrypting agent keystore via operator wallet',
): Promise<UnlockedAgent | null> {
  if (!config.identity.agent) return null
  const network = config.network
  const agentAddress = config.identity.agent as Address
  const agentId = placeholderAgentId(agentAddress)
  const paths = agentPaths.agent(agentId)

  const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
  if (!operator) return null

  const close = async () => {
    await operator.close?.()
  }

  const s = spinner()
  s.start(spinnerLabel)
  try {
    const agentPrivkey = await withSilencedConsole(async (): Promise<Hex> => {
      const raw = await readFile(paths.keystore, 'utf8')
      const keystore = decodeKeystoreBytes(new TextEncoder().encode(raw))
      return (await decryptAgentKey({ signer: operator, agentAddress, keystore })) as Hex
    })
    s.stop('unlocked (keystore source: local)')
    return { agentPrivkey, agentAddress, network, close }
  } catch (e) {
    s.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
    await close()
    return null
  }
}
