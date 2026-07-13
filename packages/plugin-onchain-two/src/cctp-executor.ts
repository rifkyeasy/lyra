/**
 * CctpExecutor — the REAL {@link DepositExecutors} implementation over Circle CCTP +
 * the Wormhole SDK. It plugs into the tested orchestration spine (intent → lifecycle
 * → store → driver): the driver reads each deposit's `nextAction` and calls the
 * matching method here.
 *
 * This wraps the flow verified end-to-end on testnet (Base Sepolia burn → Circle
 * attestation → Sui redeem → USDC minted). Notes learned there, encoded below:
 *  - the source-chain BURN is signed by the USER's own wallet (self-custody); the
 *    server only watches for it, then drives attestation + redeem.
 *  - the Sui REDEEM (`receiveMessage`) is permissionless — any funded Sui signer can
 *    submit it; the USDC mints to the recipient encoded in the burn (the agent). So
 *    a dedicated relayer key pays redeem gas.
 *  - build the Sui signer as `new SuiSigner(chain, grpcClient, Ed25519Keypair
 *    .fromSecretKey(key))` — `getSuiSigner` wrongly expects a mnemonic.
 *  - run this under Node, NOT Bun (Bun mis-resolves `@noble/hashes/crypto` on the
 *    Sui-signer path). The bridge poller is a Node process, separate from the gateway.
 *
 * Still required to go live (do NOT claim these verified until tested): a provisioned
 * `Vault<USDC>` for `depositToVault`, a v2 swap route for the long-tail `swapToUsdc`
 * leg, and another end-to-end run THROUGH this spine (not just the raw SDK).
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { CircleTransfer, wormhole } from '@wormhole-foundation/sdk'
import { SuiSigner } from '@wormhole-foundation/sdk-sui'
import evm from '@wormhole-foundation/sdk/evm'
import sui from '@wormhole-foundation/sdk/sui'
import { type CctpNetwork, whChainName } from './cctp-chains'
import type { DepositExecutors } from './deposit-driver'
import type { PendingDeposit } from './deposit-store'

export interface CctpExecutorConfig {
  network: CctpNetwork
  /** suiprivkey… for the redeem gas payer (permissionless — not the recipient). */
  suiRelayerKey: string
  /** How long each attestation poll waits before yielding back to the driver (ms). */
  attestationPollMs?: number
}

/** Build the real CCTP executor. `deposit` handlers reconstruct the transfer from the
 *  user's burn tx and drive it forward. Requires a Node runtime (see file header). */
export function makeCctpExecutor(cfg: CctpExecutorConfig): DepositExecutors {
  const wh = () => wormhole(cfg.network, [evm, sui])
  const pollMs = cfg.attestationPollMs ?? 60_000

  const transferOf = async (d: PendingDeposit) => {
    const w = await wh()
    return CircleTransfer.from(
      w,
      { chain: whChainName(d.sourceChain, cfg.network) as never, txid: d.burnTxHash as string },
      120_000,
    )
  }

  return {
    // The user burns on the source chain themselves; we only advance once their burn
    // tx is known (reported into the deposit) and reconstructs cleanly.
    async awaitSourceBurn(d) {
      if (!d.burnTxHash) return null
      await transferOf(d) // throws if the tx isn't a finalized CCTP burn yet
      return { burnTxHash: d.burnTxHash }
    },

    async awaitAttestation(d) {
      const xfer = await transferOf(d)
      try {
        const ids = await xfer.fetchAttestation(pollMs)
        return { attestation: JSON.stringify(ids) }
      } catch {
        return null // not attested yet — retry next tick
      }
    },

    async submitSuiRedeem(d) {
      const w = await wh()
      const xfer = await transferOf(d)
      await xfer.fetchAttestation(120_000)
      const client = await w.getChain('Sui').getRpc()
      const signer = new SuiSigner(
        'Sui' as never,
        client as never,
        Ed25519Keypair.fromSecretKey(cfg.suiRelayerKey),
      )
      const dstTxs = await xfer.completeTransfer(signer as never)
      return { suiRedeemDigest: String(dstTxs[dstTxs.length - 1] ?? dstTxs[0]) }
    },

    async swapToUsdc(_d): Promise<{ suiSwapDigest: string }> {
      // Long-tail source assets arrive as a wrapped coin and must be swapped to USDC
      // on Sui before the vault. Requires a v2 swap route — not wired yet.
      throw new Error('swapToUsdc not implemented — long-tail deposits pending a v2 swap route')
    },

    async depositToVault(_d): Promise<{ vaultDepositDigest: string }> {
      // Deposit the minted USDC into the owner's Vault<USDC> via lyra::vault::deposit.
      // Requires a provisioned Vault<USDC> for the owner (app currently provisions
      // Vault<SUI> only) — wired once USDC-vault provisioning lands.
      throw new Error('depositToVault not implemented — needs a provisioned Vault<USDC>')
    },
  }
}
