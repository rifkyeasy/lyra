/**
 * Truncate an EVM 0x-address to first 6 + last 4 (e.g. 0x1234…abcd) for
 * compact UI rendering. Returns the input unchanged for short or non-0x
 * values (e.g. an `.0g` name, `'?'`, or empty), so callers can pass any
 * identifier without checking type first.
 */
export function shortAddr(addr?: string | null): string {
  if (!addr) return '?'
  if (!addr.startsWith('0x') || addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
