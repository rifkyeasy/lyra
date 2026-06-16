/**
 * `nebula agent` — derive and show the deterministic agent wallet from the
 * operator signature (the SAME wallet the web console derives from this wallet),
 * and optionally set it as the active agent. Setting it writes the derived key
 * to a standard encrypted keystore and points the config at it, so an unchanged
 * `nebula chat` then transacts as the derived wallet.
 */
import { confirm, isCancel, note, spinner } from '@clack/prompts'
import { agentPaths, placeholderAgentId, saveKeystoreLocally } from 'nebula-ai-core'
import { type Address, type Hex, formatEther } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import {
  AGENT_DERIVE_MESSAGE,
  deriveAgentAccountFromSignature,
  deriveAgentKeyFromSignature,
} from '../profile/derive'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export async function runAgentWallet(): Promise<void> {
  const found = await findAndLoadConfig(process.cwd())
  if (!found) {
    console.log('No nebula.config.ts found. Run `nebula init` first.')
    return
  }
  const { config, path: configPath } = found
  const operator = await loadOrPickOperatorSigner({
    network: config.network,
    hint: config.operator,
  })
  if (!operator) {
    console.log('No operator wallet available to sign.')
    return
  }
  const s = spinner()
  s.start('Signing to derive your agent wallet')
  try {
    const account = await operator.account()
    const sig = (await account.signMessage({ message: AGENT_DERIVE_MESSAGE })) as Hex
    const derivedKey = deriveAgentKeyFromSignature(sig)
    const derived = deriveAgentAccountFromSignature(sig)
    const derivedAddress = derived.address as Address

    let balLine = ''
    try {
      const pub = await operator.publicClient(config.network)
      const bal = await pub.getBalance({ address: derivedAddress })
      balLine = `\nbalance: ${formatEther(bal)} MNT`
    } catch {}
    s.stop('derived')

    const isActive = config.identity.agent?.toLowerCase() === derivedAddress.toLowerCase()
    note(
      `${derivedAddress}${balLine}\n\nThis is the same agent wallet the web console derives from this wallet.${
        isActive ? '\n✓ already your active agent.' : ''
      }\nFund it with a little MNT to let the agent transact.`,
      'agent wallet',
    )

    if (isActive) return

    const set = await confirm({
      message: 'Set this as your active agent wallet? (nebula chat will run as it)',
      initialValue: false,
    })
    if (isCancel(set) || !set) return

    const agentId = placeholderAgentId(derivedAddress)
    const paths = agentPaths.agent(agentId)
    const sSet = spinner()
    sSet.start('Saving the derived agent keystore + updating config')
    await saveKeystoreLocally({
      signer: operator,
      agentAddress: derivedAddress,
      agentPrivkey: derivedKey,
      cachePath: paths.keystore,
    })
    await writeConfigTs(
      configPath,
      { ...config, identity: { ...config.identity, agent: derivedAddress } },
      { header: '// Updated by `nebula agent` — active agent set to the derived wallet.' },
    )
    sSet.stop('done')
    note('`nebula chat` now runs as your derived agent wallet (same as the web).', 'agent wallet')
  } catch (e) {
    s.stop(`failed: ${(e as Error).message.slice(0, 140)}`)
  } finally {
    await operator.close?.()
  }
}
