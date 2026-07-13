/**
 * Permission-gate bridge between the deterministic policy engine and the
 * harness permission service.
 *
 * The CLI + gateway pre-tool-call hooks build a permission request for every
 * value-moving tool call. On its own the permission service only knows the
 * session MODE (strict/prompt/off) — under YOLO it would let any in-cap spend
 * through silently. This helper runs the SAME `evaluatePolicy` the tool runs and,
 * when the policy flags the action as material-risk (`requiresApproval`), the
 * hook forces an approval prompt beneath the session mode. Fund controls in
 * code, not in the model (CLAUDE.md).
 */

import { isValueMovingTool } from './catalog'
import { type SuiPolicy, type SuiPolicyAction, evaluatePolicy, suiToMist } from './policy'

const SUI_TYPE = '0x2::sui::SUI'

/** Map a tool call (name + raw args) to a best-effort PolicyAction. */
function actionForCall(name: string, a: Record<string, unknown>): SuiPolicyAction | null {
  switch (name) {
    case 'sui.send': {
      const amount = typeof a.amount === 'string' ? a.amount : String(a.amount ?? '')
      return {
        kind: 'transfer',
        coinType: SUI_TYPE,
        amountMist: suiToMist(amount) ?? 0n,
        to: typeof a.to === 'string' ? a.to : undefined,
        protocol: 'transfer',
      }
    }
    default:
      return null
  }
}

/**
 * True when the policy requires human approval for this tool call (the gate
 * should force a prompt regardless of mode). False when no policy is configured
 * or the call is not value-moving.
 *
 * Covers EVERY value-moving tool, not just `sui.send`: when the call maps to a
 * precise PolicyAction (amount/recipient known) we use the exact verdict; for a
 * value-moving tool whose amount we can't extract generically, we escalate
 * conservatively — read-only/confirm always require approval, and an `auto`
 * policy with an auto-ceiling escalates because we can't prove the spend is under
 * it. Only a full-`auto` policy with no ceiling lets such a call through.
 */
export function policyRequiresApprovalForCall(
  name: string,
  args: Record<string, unknown>,
  policy: SuiPolicy | undefined,
): boolean {
  if (!policy) return false
  if (!isValueMovingTool(name)) return false
  const action = actionForCall(name, args)
  if (action) return evaluatePolicy(action, policy).requiresApproval
  // Value-moving but no precise amount mapping → be conservative.
  if (policy.readOnly || policy.autonomy === 'readonly') return true
  if (policy.autonomy === 'confirm') return true
  return policy.autoMaxMistPerTx !== undefined
}
