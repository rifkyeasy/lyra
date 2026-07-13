/**
 * Deposit intent — validates a `bridge.deposit` request and turns it into a
 * `NewDeposit` the store/driver can run. This is the entry point of the deposit
 * flow (before any chain call), so it's pure + fully testable: it rejects
 * unsupported chains, bad amounts, and malformed owners up front, and classifies
 * the source token to decide the route (native-USDC via CCTP vs. a long-tail asset
 * that arrives wrapped on Sui and needs a swap to USDC → `needsSwap`).
 */

import type { NewDeposit } from './deposit-store'

/**
 * Circle CCTP domain ids. Sui (8) is the DESTINATION; the rest are the source
 * chains a user can deposit from. Values are Circle's canonical domain numbers.
 */
export const CCTP_DOMAINS: Record<string, number> = {
  Ethereum: 0,
  Avalanche: 1,
  Optimism: 2,
  Arbitrum: 3,
  Solana: 5,
  Base: 6,
  Polygon: 7,
}

/** Smallest deposit accepted (human units) — a dust floor; a per-owner max is a
 *  policy concern enforced elsewhere. */
export const MIN_DEPOSIT = 1

export type TokenClass = 'usdc' | 'swap'

/** `usdc` → native CCTP route (no Sui-side swap); anything else → bridged as a
 *  wrapped asset that must be swapped to USDC on Sui before the vault. */
export function classifyToken(symbol: string): TokenClass {
  return symbol.trim().toUpperCase() === 'USDC' ? 'usdc' : 'swap'
}

export function isSupportedSourceChain(chain: string): boolean {
  return Object.hasOwn(CCTP_DOMAINS, chain)
}

/** The canonical, supported source chains (for surfacing in errors / a UI). */
export function supportedSourceChains(): string[] {
  return Object.keys(CCTP_DOMAINS)
}

export interface DepositRequest {
  id: string
  owner: string
  sourceChain: string
  sourceToken: string
  amount: string
}

export type IntentResult = { ok: true; deposit: NewDeposit } | { ok: false; error: string }

/** Validate a deposit request → a `NewDeposit`, or a human error. */
export function validateDepositRequest(req: DepositRequest): IntentResult {
  if (!req.id?.trim()) return { ok: false, error: 'missing deposit id' }
  if (!/^0x[0-9a-f]{64}$/i.test(req.owner ?? '')) {
    return { ok: false, error: `invalid Sui owner address: "${req.owner}"` }
  }
  if (!isSupportedSourceChain(req.sourceChain)) {
    return {
      ok: false,
      error: `unsupported source chain "${req.sourceChain}" (supported: ${supportedSourceChains().join(', ')})`,
    }
  }
  if (!req.sourceToken?.trim()) return { ok: false, error: 'missing source token' }
  const amount = Number(req.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: `invalid amount "${req.amount}"` }
  }
  if (amount < MIN_DEPOSIT) {
    return { ok: false, error: `amount below the ${MIN_DEPOSIT} minimum` }
  }
  return {
    ok: true,
    deposit: {
      id: req.id.trim(),
      owner: req.owner.toLowerCase(),
      sourceChain: req.sourceChain,
      sourceToken: req.sourceToken.trim(),
      amount: req.amount,
      needsSwap: classifyToken(req.sourceToken) === 'swap',
    },
  }
}
