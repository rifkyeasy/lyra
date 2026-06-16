/**
 * `nebula reputation` + `nebula validation` — ERC-8004 Reputation + Validation.
 *
 *   nebula reputation show [<agentId>]
 *   nebula reputation give --agent <id> --score <0-100> [--tag t] [--uri u]
 *   nebula validation show <requestId>
 *   nebula validation request --agent <id> --data <str> [--uri u]
 *   nebula validation respond --id <reqId> --passed <true|false> [--score n] [--uri u]
 */
import { cancel, intro, outro, spinner } from '@clack/prompts'
import {
  NETWORK_RPC,
  agentIdByAddress,
  explorerTxUrl,
  getReputation,
  getValidation,
  giveFeedback,
  requestValidation,
  resolveRegistryAddress,
  resolveReputationRegistry,
  resolveValidationRegistry,
  respondValidation,
} from 'nebula-ai-core'
import { http, type Address, createPublicClient, keccak256, toHex } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { loadOrPickOperatorSigner } from './init/operator-picker'

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export interface TrustArgs {
  kind: 'reputation' | 'validation'
  sub: string
  argv: string[]
}

export function parseTrustArgs(
  kind: 'reputation' | 'validation',
  argv: string[],
): TrustArgs | { error: string } {
  const sub = argv[0] ?? ''
  const valid = kind === 'reputation' ? ['show', 'give'] : ['show', 'request', 'respond']
  if (!valid.includes(sub))
    return { error: `unknown subcommand '${sub || '(none)'}' — try: ${valid.join(' | ')}` }
  return { kind, sub, argv: argv.slice(1) }
}

export async function runTrust(args: TrustArgs): Promise<void> {
  const loaded = await findAndLoadConfig()
  if (!loaded) {
    console.error('No nebula.config.ts found. Run `nebula init` first.')
    process.exit(1)
  }
  const { config } = loaded
  const network = config.network
  const publicClient = createPublicClient({ transport: http(NETWORK_RPC[network]) })
  const repReg = resolveReputationRegistry(network)
  const valReg = resolveValidationRegistry(network)
  const idReg = resolveRegistryAddress(network)

  // ── reads ──
  if (args.kind === 'reputation' && args.sub === 'show') {
    if (!repReg) return fail(`No Reputation Registry for ${network}.`)
    let id = flag(args.argv, '--agent') ?? args.argv.find(a => !a.startsWith('--'))
    if (!id) {
      if (!idReg || !config.identity.agent) return fail('Pass an <agentId>.')
      const resolved = await agentIdByAddress({
        publicClient,
        registry: idReg,
        agentAddress: config.identity.agent as Address,
      })
      if (resolved === 0n)
        return void console.log('this agent is not registered; run `nebula identity register`')
      id = resolved.toString()
    }
    const { count, averageScore } = await getReputation({
      publicClient,
      registry: repReg,
      agentId: BigInt(id),
    })
    console.log(`agent id      ${id}`)
    console.log(`ratings       ${count}`)
    console.log(`avg score     ${averageScore} / 100`)
    return
  }
  if (args.kind === 'validation' && args.sub === 'show') {
    if (!valReg) return fail(`No Validation Registry for ${network}.`)
    const reqId = flag(args.argv, '--id') ?? args.argv.find(a => !a.startsWith('--'))
    if (!reqId) return fail('Pass a <requestId>.')
    const v = await getValidation({ publicClient, registry: valReg, requestId: BigInt(reqId) })
    console.log(`request id    ${reqId}`)
    console.log(`agent id      ${v.agentId.toString()}`)
    console.log(`requester     ${v.requester}`)
    console.log(`status        ${v.responded ? (v.passed ? 'PASSED' : 'FAILED') : 'pending'}`)
    if (v.responded) {
      console.log(`validator     ${v.validator}`)
      console.log(`score         ${v.score} / 100`)
    }
    return
  }

  // ── writes (need the operator wallet) ──
  intro(`nebula ${args.kind} ${args.sub}`)
  const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
  if (!operator) return cancel('No operator wallet available.')
  const walletClient = await operator.walletClient(network)
  const s = spinner()
  try {
    if (args.kind === 'reputation' && args.sub === 'give') {
      if (!repReg) throw new Error(`No Reputation Registry for ${network}.`)
      const agentId = BigInt(
        flag(args.argv, '--agent') ??
          (() => {
            throw new Error('--agent <id> required')
          })(),
      )
      const score = Number(
        flag(args.argv, '--score') ??
          (() => {
            throw new Error('--score <0-100> required')
          })(),
      )
      s.start('Recording reputation feedback on-chain')
      const { txHash } = await giveFeedback({
        walletClient,
        publicClient,
        registry: repReg,
        agentId,
        score,
        tag: flag(args.argv, '--tag') ?? '',
        uri: flag(args.argv, '--uri') ?? '',
      })
      s.stop('feedback recorded')
      outro(`tx ${explorerTxUrl(network, txHash)}`)
    } else if (args.kind === 'validation' && args.sub === 'request') {
      if (!valReg) throw new Error(`No Validation Registry for ${network}.`)
      const agentId = BigInt(
        flag(args.argv, '--agent') ??
          (() => {
            throw new Error('--agent <id> required')
          })(),
      )
      const data =
        flag(args.argv, '--data') ??
        (() => {
          throw new Error('--data <string|0xhash> required')
        })()
      const dataHash = /^0x[0-9a-fA-F]{64}$/.test(data)
        ? (data as `0x${string}`)
        : keccak256(toHex(data))
      s.start('Opening validation request on-chain')
      const { requestId, txHash } = await requestValidation({
        walletClient,
        publicClient,
        registry: valReg,
        agentId,
        dataHash,
        uri: flag(args.argv, '--uri') ?? '',
      })
      s.stop(`request id ${requestId.toString()}`)
      outro(`tx ${explorerTxUrl(network, txHash)}`)
    } else if (args.kind === 'validation' && args.sub === 'respond') {
      if (!valReg) throw new Error(`No Validation Registry for ${network}.`)
      const requestId = BigInt(
        flag(args.argv, '--id') ??
          (() => {
            throw new Error('--id <requestId> required')
          })(),
      )
      const passed = (flag(args.argv, '--passed') ?? 'true') !== 'false'
      s.start('Publishing validation response on-chain')
      const { txHash } = await respondValidation({
        walletClient,
        publicClient,
        registry: valReg,
        requestId,
        passed,
        score: Number(flag(args.argv, '--score') ?? '0'),
        uri: flag(args.argv, '--uri') ?? '',
      })
      s.stop('response published')
      outro(`tx ${explorerTxUrl(network, txHash)}`)
    }
  } catch (e) {
    s.stop(`failed: ${(e as Error).message.slice(0, 200)}`)
  } finally {
    await operator.close?.()
  }
}

function fail(msg: string): void {
  console.error(msg)
  process.exit(1)
}
