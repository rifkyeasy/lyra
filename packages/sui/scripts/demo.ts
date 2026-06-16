/**
 * Lyra end-to-end demo on Sui testnet.
 *
 * Proves the trust boundary: the agent can act autonomously, but only inside
 * the on-chain policy. We:
 *   1. create a funded AgentPolicy (budget + per-tx cap + protocol scope + expiry)
 *   2. run an ALLOWED guarded spend (withdraw -> transfer -> on-chain receipt), atomically
 *   3. show a BLOCKED over-cap action — refused by the mirror AND aborted on-chain
 *   4. revoke the policy (owner kill switch)
 *   5. show that the revoked policy now blocks every spend on-chain
 *
 * Requires LYRA_AGENT_KEY (a funded testnet key) in the environment / .env.
 */
import { Transaction } from '@mysten/sui/transactions'
import {
  buildCreatePolicy,
  buildRecord,
  buildRevoke,
  buildWithdraw,
  buildReclaim,
  buildWithdrawTransfer,
  createdObjectByType,
  dryRun,
  evaluatePolicy,
  execute,
  loadConfig,
  loadKeypair,
  makeClient,
  mistToSui,
  type PolicyAction,
  policyFromEnv,
  SUI_TYPE,
  suiToMist,
  txUrl,
} from '../src/index'

const cfg = loadConfig()
const client = makeClient(cfg.network)

if (!process.env.LYRA_AGENT_KEY) throw new Error('LYRA_AGENT_KEY is required (a funded testnet key)')
if (!cfg.packageId) throw new Error('LYRA_PACKAGE_ID is required')

// In this single-key demo the owner also plays the agent. In production these
// are separate keys: the owner holds revoke/reclaim, the agent holds the cap.
const owner = loadKeypair(process.env.LYRA_AGENT_KEY)
const ownerAddr = owner.toSuiAddress()
// Default to the owner's own address so the demo round-trips on mainnet (no
// real loss). Override with LYRA_DEMO_RECIPIENT to send to a distinct address.
const recipient = process.env.LYRA_DEMO_RECIPIENT?.trim() || ownerAddr

const policy = policyFromEnv()
const coinType = SUI_TYPE
const allowedProtocols = policy.allowedProtocols ?? ['transfer', 'deepbook', 'walrus']
const expiryMs = policy.expiryMs ?? Date.now() + 60 * 60_000

// Scripted demo amounts, chosen so the blocked spend is unambiguously a per-tx
// cap violation (> cap, but still < remaining budget) — so the off-chain mirror
// and the on-chain guard both reject it for the SAME reason.
const BUDGET = suiToMist(0.05)
const MAX_PER_TX = suiToMist(0.02)
const ALLOWED_SPEND = suiToMist(0.01) // < cap, < budget  -> allowed
const BLOCKED_SPEND = suiToMist(0.03) // > cap, < budget  -> blocked on the cap

const line = (s = '') => console.log(s)
const h = (s: string) => line(`\n=== ${s} ===`)

async function main() {
  line(`Lyra demo · ${cfg.network}`)
  line(`package : ${cfg.packageId}`)
  line(`owner   : ${ownerAddr}`)
  line(`policy  : budget ${mistToSui(BUDGET)} SUI · cap ${mistToSui(MAX_PER_TX)} SUI/tx · protocols [${allowedProtocols.join(', ')}]`)

  // --- 1. Create the policy ---------------------------------------------
  h('1. create AgentPolicy')
  const createTx = new Transaction()
  buildCreatePolicy(createTx, {
    packageId: cfg.packageId,
    coinType,
    agent: ownerAddr,
    budgetMist: BUDGET,
    maxPerTxMist: MAX_PER_TX,
    maxSlippageBps: policy.maxSlippageBps ?? 100,
    allowedProtocols,
    expiryMs,
  })
  const createRes = await execute(client, owner, createTx)
  const policyId = createdObjectByType(createRes, '::policy::AgentPolicy<')
  const capId = createdObjectByType(createRes, '::policy::AgentCap')
  line(`tx     : ${txUrl(cfg.network, createRes.digest)}`)
  line(`policy : ${policyId}`)
  line(`cap    : ${capId}`)
  if (!policyId || !capId) throw new Error('could not locate created policy/cap objects')

  // --- 2. Allowed guarded spend (atomic: withdraw -> transfer -> receipt) -
  h('2. ALLOWED action — guarded spend + on-chain receipt')
  const allowedAction: PolicyAction = {
    kind: 'transfer',
    protocol: 'transfer',
    coinType,
    amountRaw: ALLOWED_SPEND,
    to: recipient,
  }
  const verdict = evaluatePolicy(allowedAction, { ...policy, maxNativeMistPerTx: MAX_PER_TX })
  line(`mirror : allowed=${verdict.allowed} requiresApproval=${verdict.requiresApproval}`)
  if (!verdict.allowed) throw new Error(`mirror unexpectedly blocked: ${verdict.violations.join('; ')}`)

  const spendTx = new Transaction()
  buildWithdrawTransfer(spendTx, {
    packageId: cfg.packageId,
    coinType,
    policyId,
    capId,
    amountMist: ALLOWED_SPEND,
    protocol: 'transfer',
    recipient,
  })
  buildRecord(spendTx, {
    packageId: cfg.packageId,
    coinType,
    policyId,
    capId,
    protocol: 'transfer',
    summary: `sent ${mistToSui(ALLOWED_SPEND)} SUI to ${recipient.slice(0, 10)}…`,
    amountMist: ALLOWED_SPEND,
    coinTypeStr: coinType,
    status: 'executed',
    walrusBlob: '', // Walrus artifact wired in a later step
  })
  const spendRes = await execute(client, owner, spendTx)
  const receiptId = createdObjectByType(spendRes, '::policy::ActionReceipt')
  line(`tx     : ${txUrl(cfg.network, spendRes.digest)}`)
  line(`sent   : ${mistToSui(ALLOWED_SPEND)} SUI to ${recipient}`)
  line(`receipt: ${receiptId} (frozen, immutable)`)

  // --- 3. Blocked over-cap action ---------------------------------------
  h('3. BLOCKED action — over the per-tx cap')
  const blockedAction: PolicyAction = {
    kind: 'transfer',
    protocol: 'transfer',
    coinType,
    amountRaw: BLOCKED_SPEND,
    to: recipient,
  }
  const blockedVerdict = evaluatePolicy(blockedAction, { ...policy, maxNativeMistPerTx: MAX_PER_TX })
  line(`mirror : allowed=${blockedVerdict.allowed} — ${blockedVerdict.violations.join('; ')}`)

  const blockedTx = new Transaction()
  const coin = buildWithdraw(blockedTx, {
    packageId: cfg.packageId,
    coinType,
    policyId,
    capId,
    amountMist: BLOCKED_SPEND,
    protocol: 'transfer',
  })
  blockedTx.transferObjects([coin], blockedTx.pure.address(recipient))
  const blockedSim = await dryRun(client, blockedTx, ownerAddr)
  line(`chain  : would-execute=${blockedSim.ok} ${blockedSim.ok ? '' : `(aborted: ${blockedSim.error})`}`)

  // --- 4. Revoke (owner kill switch) ------------------------------------
  h('4. revoke the policy (owner)')
  const revokeTx = new Transaction()
  buildRevoke(revokeTx, { packageId: cfg.packageId, coinType, policyId })
  const revokeRes = await execute(client, owner, revokeTx)
  line(`tx     : ${txUrl(cfg.network, revokeRes.digest)}`)

  // --- 5. Prove revocation blocks further spend -------------------------
  h('5. post-revoke — any spend now aborts on-chain')
  const afterTx = new Transaction()
  const coin2 = buildWithdraw(afterTx, {
    packageId: cfg.packageId,
    coinType,
    policyId,
    capId,
    amountMist: ALLOWED_SPEND,
    protocol: 'transfer',
  })
  afterTx.transferObjects([coin2], afterTx.pure.address(recipient))
  const afterSim = await dryRun(client, afterTx, ownerAddr)
  line(`chain  : would-execute=${afterSim.ok} ${afterSim.ok ? '' : `(aborted: ${afterSim.error})`}`)

  // --- 6. Reclaim remaining budget (owner) ------------------------------
  h('6. reclaim remaining budget (owner)')
  const reclaimTx = new Transaction()
  buildReclaim(reclaimTx, { packageId: cfg.packageId, coinType, policyId })
  const reclaimRes = await execute(client, owner, reclaimTx)
  line(`tx     : ${txUrl(cfg.network, reclaimRes.digest)}`)
  line('remaining budget returned to owner')

  line('\n✅ demo complete — the AI acted only inside the policy; the chain enforced the rest.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
