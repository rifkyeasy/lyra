import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cancel, confirm, intro, isCancel, note, outro, select, spinner } from '@clack/prompts'
import {
  NETWORK_CHAIN_ID,
  NETWORK_RPC,
  type NebulaNetwork,
  OPERATOR_BLOB_SCOPES,
  type OperatorSessionKeys,
  agentPaths,
  buildOperatorSession,
  defineConfig,
  generateAgentWallet,
  getGasPriceWithFloor,
  placeholderAgentId,
  precomputeAllScopes,
  saveKeystoreLocally,
  waitForReceiptResilient,
  writeOperatorSession,
} from 'nebula-ai-core'
import { type Address, type Hex, formatEther, hexToBytes, parseEther } from 'viem'
import { writeConfigTs } from '../config/render'
import { withSilencedConsole } from '../util/silence-console'
import { estimateCosts, renderCostSummary } from './init/cost'
import { fundingGate } from './init/funding-gate'
import { pickBrainModel } from './init/model-picker'
import { pickOperatorSigner } from './init/operator-picker'
import { initialWizardState, updateWizardState, writeWizardState } from './init/wizard-state'

export async function runInit(opts?: { cwd?: string; resume?: boolean }): Promise<void> {
  const configPath = agentPaths.config

  intro('nebula init')

  if (existsSync(configPath) && !opts?.resume) {
    const choice = (await select({
      message: `${configPath} exists`,
      options: [
        { value: 'overwrite', label: 'Start fresh (overwrite)' },
        { value: 'cancel', label: 'Cancel' },
      ],
      initialValue: 'cancel',
    })) as 'overwrite' | 'cancel' | symbol
    if (isCancel(choice) || choice === 'cancel') {
      cancel('Aborted.')
      return
    }
  }

  // ─── Phase A: local prompts (no chain, no wallet) ───────────────────────

  const network = (await select({
    message: 'Which Mantle network?',
    options: [
      { value: 'mantle-mainnet' as NebulaNetwork, label: 'Mantle mainnet (5000)' },
      { value: 'mantle-testnet' as NebulaNetwork, label: 'Mantle Sepolia testnet (5003)' },
    ],
    initialValue: 'mantle-mainnet' as NebulaNetwork,
  })) as NebulaNetwork
  if (isCancel(network)) {
    cancel('Aborted.')
    return
  }

  // The agent always runs locally: a harness on this machine, always-on while
  // the CLI (or the local gateway daemon) is open. The remote compute-
  // marketplace deploy target was removed.
  const deployTarget = 'local' as const

  // SANN `.nebula.0g` name service was removed (0G-only); the agent is now
  // local-identity. No subname prompt or on-chain registration.
  const requestedSubname: string | null = null

  const modelPick = await pickBrainModel({ network })
  if (!modelPick) {
    const keepGoing = await confirm({
      message: 'Model catalog unavailable; continue and pick later?',
      initialValue: true,
    })
    if (isCancel(keepGoing) || !keepGoing) {
      cancel('Aborted.')
      return
    }
  }

  // Compute-ledger deposit prompt removed with the decentralized-compute
  // backend. The agent's LLM is an API-key model (OPENAI_API_KEY / NEBULA_LLM_*),
  // so there is no on-chain compute ledger to fund at init time.
  const ledgerSize = 0

  // ─── Phase B: wallet gate ────────────────────────────────────────────────

  const picked = await pickOperatorSigner({ network })
  if (!picked) return
  const { signer: operator, hint: operatorHint } = picked

  const sConnect = spinner()
  sConnect.start(`Connecting via ${operator.source}`)
  let operatorAddress: Address
  try {
    operatorAddress = await operator.address()
    sConnect.stop(`operator: ${operatorAddress}`)
  } catch (e) {
    sConnect.stop(`connection failed: ${(e as Error).message.slice(0, 140)}`)
    await operator.close?.()
    return
  }

  const costs = estimateCosts({
    ledgerSizeOg: ledgerSize,
    withSubname: !!requestedSubname,
    deployTarget,
  })
  note(renderCostSummary(costs), 'cost summary (Mantle ~$0.50)')

  const publicClient = await operator.publicClient(network)
  const operatorBalance = await publicClient.getBalance({ address: operatorAddress })

  let skipLedger = false
  if (operatorBalance < costs.totalOperator) {
    const need = costs.totalOperator - operatorBalance
    note(
      `Operator balance ${formatEther(operatorBalance)} Mantle, need ${formatEther(need)} Mantle more.`,
      'insufficient funds',
    )
    const gate = await fundingGate({
      publicClient,
      operatorAddress,
      requiredOg: costs.totalOperator,
    })
    if (gate.kind === 'cancel') {
      await operator.close?.()
      return
    }
    if (gate.kind === 'skip-ledger') skipLedger = true
  }

  const proceed = await confirm({ message: 'Proceed?', initialValue: true })
  if (isCancel(proceed) || !proceed) {
    cancel('Aborted.')
    await operator.close?.()
    return
  }

  // ─── Phase C: execute with Pattern B state tracking ─────────────────────

  const agent = generateAgentWallet()
  const provisionalAgentId = placeholderAgentId(agent.address)
  const provisional = agentPaths.agent(provisionalAgentId)
  await mkdir(provisional.dir, { recursive: true })

  await writeWizardState(provisional.dir, {
    ...initialWizardState(agent.address, network),
  })

  // Plain-EOA identity: the agent EOA is the identity. No iNFT mint, no
  // on-chain anchoring — just a local encrypted keystore.
  const finalAgentId = provisionalAgentId
  const paths = provisional

  // v0.23.1: derive BOTH operator-scope keys (keystore + profile) in parallel
  // up front, then reuse them everywhere. This is the single "two signatures
  // back to back" moment in the wizard: keystore scope (for the encrypted
  // privkey blob) + profile scope (for the operator-private user-partition
  // memory slot). Folding profile derivation into init removes the v0.23.0
  // need for `nebula profile init` as a follow-up command.
  const sKeys = spinner()
  sKeys.start('Deriving operator scope keys (may prompt twice: keystore + profile)')
  let operatorKeys: OperatorSessionKeys
  let keystoreKeyBuf: Buffer
  try {
    operatorKeys = await precomputeAllScopes(operator, agent.address as Address, [
      OPERATOR_BLOB_SCOPES.PROFILE,
    ])
    keystoreKeyBuf = Buffer.from(hexToBytes(operatorKeys.keystore))
    sKeys.stop('scope keys derived')
  } catch (e) {
    sKeys.stop(`scope key derive failed: ${(e as Error).message.slice(0, 160)}`)
    cancel('Aborted (operator signature required for keystore + profile scopes).')
    await operator.close?.()
    return
  }

  // Pass the already-derived keystoreKey so saveKeystoreLocally skips
  // signing again. Save BEFORE funding the agent EOA per
  // `feedback-init-must-save-keystore-before-funding.md`.
  const sLocal = spinner()
  sLocal.start('Encrypting agent keystore to operator wallet (local insurance)')
  let encryptedBytes: Uint8Array
  try {
    const saved = await saveKeystoreLocally({
      agentAddress: agent.address as Address,
      agentPrivkey: agent.privkeyHex as Hex,
      cachePath: paths.keystore,
      precomputedKey: keystoreKeyBuf,
    })
    encryptedBytes = saved.bytes
    await updateWizardState(paths.dir, draft => {
      draft.steps.keystoreSaved = true
    })
    sLocal.stop(`keystore saved locally at ${paths.keystore}`)
  } catch (e) {
    sLocal.stop(`local keystore save failed: ${(e as Error).message.slice(0, 120)}`)
    cancel('Aborted before funding (keystore encryption failed).')
    await operator.close?.()
    return
  }

  const sFund = spinner()
  const fundingAmount = parseEther('0.1') + parseEther(String(ledgerSize))
  sFund.start(`Funding agent ${agent.address} with ${formatEther(fundingAmount)} Mantle`)
  try {
    const opWc = await operator.walletClient(network)
    const opAccount = opWc.account
    if (!opAccount) throw new Error('walletClient is missing default account')
    const fundGasPrice = await getGasPriceWithFloor(publicClient)
    const fundTx = await withSilencedConsole(() =>
      opWc.sendTransaction({
        to: agent.address as Address,
        value: fundingAmount,
        chain: operator.chain(network),
        account: opAccount,
        maxFeePerGas: fundGasPrice,
        maxPriorityFeePerGas: fundGasPrice,
      }),
    )
    await waitForReceiptResilient(publicClient, fundTx)
    await updateWizardState(paths.dir, draft => {
      draft.steps.agentFundedTx = fundTx
    })
    sFund.stop(`funded (tx ${fundTx})`)
  } catch (e) {
    sFund.stop(`fund failed: ${(e as Error).message}`)
    await operator.close?.()
    return
  }

  // The encrypted keystore is on disk (saved before funding). The operator
  // wallet can always decrypt + recover the agent — no on-chain anchor needed.
  void encryptedBytes

  // v0.23.1: cache the operator scope keys to `.operator-session` so:
  //   - First `nebula` chat does NOT re-prompt Touch ID (`gateway-start` will
  //     find both keystore + profile scopes already cached and skip
  //     re-derivation).
  //   - First sync after init can encrypt + anchor the PROFILE slot
  //     transparently — operator never needs to run `nebula profile init`.
  // requiredScopesForAgent now returns ['keystore', 'nebula-profile-v1']
  // because seedStarterMemoryFiles just wrote user/profile.md.
  try {
    const sess = buildOperatorSession({ agent: agent.address as Address, keys: operatorKeys })
    writeOperatorSession(finalAgentId, sess)
  } catch (e) {
    console.warn(`operator-session write skipped: ${(e as Error).message.slice(0, 160)}`)
  }

  // Compute-ledger prepay step removed with the decentralized-compute backend
  // (Nebula uses an API-key LLM; no per-provider on-chain ledger to fund).

  // SANN `.nebula.0g` registration was removed (0G-only); the agent is
  // local-identity, so there is no on-chain subname to claim.
  const registeredSubname: string | null = null

  // Seed canonical memory starter files. With no SANN subname the seed uses
  // the generic "I am nebula" template.
  await seedStarterMemoryFiles({
    paths,
    network,
    contractAddress: '0x0000000000000000000000000000000000000000' as Address,
    tokenId: 0n,
    agentAddress: agent.address as Address,
    operatorAddress,
    brainProvider: modelPick?.provider ?? null,
    brainModel: modelPick?.model ?? null,
    subname: registeredSubname,
  })

  // v0.24.4: Phase E (Telegram bot setup) MUST run before Phase 11 (sandbox
  // provision) so the sandbox handoff envelope can ship `telegram-secrets`
  // and the listener boots active. Previously Phase E ran AFTER provision and
  // the sandbox booted with `listeners.telegram: disabled`, forcing the
  // operator to `nebula upgrade --in-place` post-init to re-ship secrets.
  let telegramConfigured: { botUsername: string; mode: string } | null = null
  {
    const tgChoice = await confirm({
      message: 'Configure a Telegram bot for this agent now? (recommended)',
      initialValue: true,
    })
    if (!isCancel(tgChoice) && tgChoice === true) {
      try {
        const { runTelegramStep } = await import('./init/telegram-step')
        const tgResult = await runTelegramStep({
          signer: operator,
          agentId: finalAgentId,
          agentAddress: agent.address as Address,
          configPath,
          // Synthetic partial cfg — caller writes the final cfg below. Pass
          // skipConfigWrite=true so telegram-step doesn't touch disk.
          config: { plugins: [], subname: registeredSubname } as never,
          network,
          skipConfigWrite: true,
        })
        if (tgResult.configured && tgResult.botUsername && tgResult.modeUsed) {
          telegramConfigured = {
            botUsername: tgResult.botUsername,
            mode: tgResult.modeUsed,
          }
          // v0.24.3: append TELEGRAM key to `.operator-session` so the gateway
          // daemon auto-spawns on first chat without re-prompting Touch ID.
          if (tgResult.telegramScopeKeyHex) {
            try {
              const sess = buildOperatorSession({
                agent: agent.address as Address,
                keys: {
                  ...operatorKeys,
                  [OPERATOR_BLOB_SCOPES.TELEGRAM]: tgResult.telegramScopeKeyHex,
                },
              })
              writeOperatorSession(finalAgentId, sess)
            } catch (e) {
              note(
                `operator-session rewrite skipped: ${(e as Error).message.slice(0, 160)}\nRun \`nebula telegram setup\` later to re-derive the TG scope key.`,
                'telegram (non-fatal)',
              )
            }
          }
        }
      } catch (e) {
        note(
          `Telegram step failed: ${(e as Error).message.slice(0, 200)}\nIdentity is safe. Re-run \`nebula telegram setup\` later.`,
          'non-fatal',
        )
      }
    }
  }

  // ─── Write final config ─────────────────────────────────────────────────

  const cfg = defineConfig({
    identity: {
      operator: operatorAddress,
      agent: agent.address,
    },
    network,
    storage: { network },
    brain: {
      provider: modelPick?.provider ?? null,
      model: modelPick?.model ?? null,
    },
    plugins: telegramConfigured ? ['onchain', 'system', 'telegram'] : ['onchain', 'system'],
    tools: {},
    imports: { claudeCode: true },
    operator: operatorHint,
  })
  await writeConfigTs(configPath, cfg, {
    header: '// Regenerated by `nebula init`. Edit freely; type-safe.',
  })

  await operator.close?.()

  // ─── Phase D: summary ───────────────────────────────────────────────────

  const lines = [
    '',
    `  agent id   ${finalAgentId}`,
    `  agent EOA  ${agent.address}`,
    `  operator   ${operatorAddress}  (source: ${operatorHint.source})`,
    `  network    ${network} (${NETWORK_RPC[network]})`,
    `  chain id   ${NETWORK_CHAIN_ID[network]}`,
    `  config     ${configPath}`,
    `  keystore   ${paths.keystore} (encrypted to operator wallet)`,
  ]
  if (modelPick) lines.push(`  brain      ${modelPick.model ?? '?'} (${modelPick.provider})`)
  if (!skipLedger) lines.push(`  ledger     ${ledgerSize} Mantle`)
  if (telegramConfigured) {
    lines.push(`  bot        @${telegramConfigured.botUsername} (mode: ${telegramConfigured.mode})`)
  }
  const nextSteps = telegramConfigured
    ? 'Next: `nebula` to chat · DM the bot on Telegram · `nebula status` for health'
    : 'Next: `nebula` to chat · `nebula telegram setup` for the bot · `nebula topup` to add funds'
  lines.push('', nextSteps)
  outro(lines.join('\n'))
}

interface SeedStarterOpts {
  paths: ReturnType<typeof agentPaths.agent>
  network: NebulaNetwork
  contractAddress: Address
  tokenId: bigint
  agentAddress: Address
  operatorAddress: Address
  brainProvider: string | null
  brainModel: string | null
  /**
   * Operator-chosen SANN label (e.g. "chou" for `chou.nebula.0g`). Threaded
   * into identity + persona so the agent introduces itself by name on the
   * very first turn instead of the generic "I am Nebula" template.
   */
  subname: string | null
}

/**
 * Seed `MEMORY.md`, `/agent/identity.md`, `/agent/persona.md`, and
 * `/user/profile.md` immediately after mint so the per-turn sync manager
 * has real content for the identity / persona / memory-index slots on the
 * first chat turn. Without this, those slots stay bootstrap-placeholder
 * forever (gap discovered during the Phase 6.7 stress test).
 */
async function seedStarterMemoryFiles(opts: SeedStarterOpts): Promise<void> {
  const memDir = opts.paths.memoryDir
  const agentMem = `${memDir}/agent`
  const userMem = `${memDir}/user`
  await mkdir(agentMem, { recursive: true })
  await mkdir(userMem, { recursive: true })

  const now = new Date().toISOString().slice(0, 10)
  const displayName = opts.subname ?? 'nebula'
  const fullName = opts.subname ?? null
  const identityTitle = opts.subname
    ? `# ${opts.subname} identity (nebula harness)`
    : '# Nebula identity'
  const subnameLine = fullName ? `- Name: ${fullName}\n` : ''
  const personaIntro = fullName
    ? `I am ${displayName} (${fullName}), a sovereign agent running on the nebula harness on Mantle.`
    : 'I am nebula, a sovereign agent harness on Mantle.'
  const identity = `---\nname: identity\ndescription: Auto-written agent identity facts.\ntype: agent-identity\n---\n${identityTitle}\n\n- Name: ${displayName}\n${subnameLine}- iNFT: #${opts.tokenId.toString()} at ${opts.contractAddress} (${opts.network})\n- Agent EOA: ${opts.agentAddress}\n- Operator: ${opts.operatorAddress}\n- Minted: ${now}\n${opts.brainProvider ? `- Brain provider: ${opts.brainProvider}\n` : ''}${opts.brainModel ? `- Brain model: ${opts.brainModel}\n` : ''}`
  const persona = `---\nname: persona\ndescription: Voice + behavior style.\ntype: agent-persona\n---\n# Persona\n\n${personaIntro} I anchor my state on chain every turn, decrypt my keystore via my operator wallet at session start, and use Mantle Compute (TEE-attested) for reasoning. I am direct, concise, and factual. When asked who I am, I introduce myself as ${displayName}.\n`
  const profile =
    '---\nname: profile\ndescription: User profile (operator-scoped, never anchored on chain).\ntype: user\n---\n# User profile\n\n(empty, fills as we chat)\n'

  await writeFile(join(agentMem, 'identity.md'), identity, 'utf8')
  await writeFile(join(agentMem, 'persona.md'), persona, 'utf8')
  await writeFile(join(userMem, 'profile.md'), profile, 'utf8')

  // Seed an empty MEMORY.md so per-turn sync has something to anchor and the
  // brain's first turn sees a parseable index.
  await writeFile(opts.paths.memoryIndex, '# Nebula Memory Index\n\n', 'utf8')
}
