/**
 * Per-action minimum amounts (in MIST). Below these an on-chain call either
 * hard-aborts (Sui native staking requires ≥ 1 SUI) or is economically
 * pointless (dust deposits). We reject BEFORE building/simulating/executing and
 * tell the user the minimum — so a too-small amount returns a clear
 * "amount too small" error instead of a doomed transaction that could otherwise
 * look like it succeeded.
 */
export const MIN_MIST = {
  transfer: 1_000_000n, // 0.001 SUI
  swap: 10_000_000n, // 0.01 SUI
  supply: 10_000_000n, // 0.01 SUI  (lending deposit)
  borrow: 10_000_000n, // 0.01 SUI
  stake: 1_000_000_000n, // 1 SUI    (Sui native staking hard minimum)
} as const

export type MinAction = keyof typeof MIN_MIST

const fmtSui = (mist: bigint): string => {
  const s = (Number(mist) / 1e9).toString()
  return s
}

/**
 * Returns an error string when `amountMist` is below the action's minimum,
 * otherwise null. Callers should early-return the string as `{ ok: false, error }`
 * BEFORE executing anything.
 */
export function checkMinimum(action: MinAction, amountMist: bigint): string | null {
  const min = MIN_MIST[action]
  if (amountMist < min) {
    return `amount too small: ${fmtSui(amountMist)} SUI is below the ${fmtSui(min)} SUI minimum for ${action} — try at least ${fmtSui(min)} SUI`
  }
  return null
}
