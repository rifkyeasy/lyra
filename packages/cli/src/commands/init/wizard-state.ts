import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Pattern B resumable-init state file (Apr 24 2026 session design).
 *
 * Lives at `<agentDir>/.nebula-init-state.json` and tracks which steps in
 * Phase C of the wizard completed. Written incrementally. If init crashes
 * or the user aborts mid-flow, a subsequent `nebula init` (or `--resume`)
 * can pick up from the first incomplete step instead of re-minting.
 */
export interface WizardState {
  version: 1
  agentAddress: `0x${string}`
  network: 'mantle-mainnet' | 'mantle-testnet'
  steps: {
    keystoreSaved: boolean
    mintedTokenId: string | null
    mintedContract: string | null
    mintTx: string | null
    agentFundedTx: string | null
    keystorePersistedTx: string | null
    keystoreRootHash: string | null
    ledgerOpenedTx: boolean // broker.addLedger returns void
    subnameClaimedTx: string | null
    textRecordsSetTx: string | null
    /** Phase 11: Mantle Sandbox lifecycle. Set during sandbox-deploy branch. */
    sandboxId: string | null
    sandboxEndpoint: string | null
  }
  lastError: string | null
  updatedAt: string
}

export const WIZARD_STATE_FILENAME = '.nebula-init-state.json'

export function wizardStatePath(agentDir: string): string {
  return join(agentDir, WIZARD_STATE_FILENAME)
}

export function initialWizardState(
  agentAddress: `0x${string}`,
  network: 'mantle-mainnet' | 'mantle-testnet',
): WizardState {
  return {
    version: 1,
    agentAddress,
    network,
    steps: {
      keystoreSaved: false,
      mintedTokenId: null,
      mintedContract: null,
      mintTx: null,
      agentFundedTx: null,
      keystorePersistedTx: null,
      keystoreRootHash: null,
      ledgerOpenedTx: false,
      subnameClaimedTx: null,
      textRecordsSetTx: null,
      sandboxId: null,
      sandboxEndpoint: null,
    },
    lastError: null,
    updatedAt: new Date().toISOString(),
  }
}

export async function readWizardState(agentDir: string): Promise<WizardState | null> {
  const path = wizardStatePath(agentDir)
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as WizardState
  } catch {
    return null
  }
}

export async function writeWizardState(agentDir: string, state: WizardState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  await writeFile(wizardStatePath(agentDir), JSON.stringify(state, null, 2), 'utf8')
}

export async function updateWizardState(
  agentDir: string,
  patch: (draft: WizardState) => void,
): Promise<WizardState> {
  const current = (await readWizardState(agentDir)) ?? null
  if (!current) throw new Error(`updateWizardState: no state at ${agentDir}`)
  patch(current)
  await writeWizardState(agentDir, current)
  return current
}
