import type { PermissionRequest } from 'lyra-core'
import { shortAddr } from '../util/format'

/**
 * Body line for the approval modal. Friendly text for value-moving onchain
 * kinds; falls back to command/path for shell.run / fs.write / code.execute.
 */
export function summarizeApprovalSubject(req: PermissionRequest): string {
  const amt = req.amount ?? ''
  const tok = req.token ?? ''
  switch (req.kind) {
    case 'chain.send': {
      if (tok.includes('→')) return `${amt} ${tok}`.trim()
      const tokenLabel = tok || 'SUI'
      return `send ${amt} ${tokenLabel} to ${shortAddr(req.recipient)}`
    }
    case 'chain.swap':
      if (!amt && !tok) return 'swap'
      return `swap ${amt} ${tok}`.trim()
    case 'chain.write': {
      const valuePart = amt ? ` (value: ${amt})` : ''
      const onPart = req.recipient ? ` on ${shortAddr(req.recipient)}` : ''
      return `${req.command ?? '?'}${valuePart}${onPart}`
    }
    default:
      return req.command ?? req.path ?? '(unspecified)'
  }
}
