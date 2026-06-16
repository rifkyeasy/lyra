/**
 * Run `fn` with `console.log/info/warn/error/debug` swapped for no-ops so they
 * cannot interleave with clack's in-place spinner re-render. Originals are
 * restored even if `fn` throws.
 *
 * Why: Mantle Storage SDK and Mantle Compute broker SDK both `console.log` directly
 * during their work (selected nodes, upload progress, broker tx hashes, etc).
 * When a clack spinner is running, every leaked log line pushes the spinner
 * down and the next animation frame draws a new spinner row, creating the
 * "100x stacked spinner" visual we saw on the WC init test. Suppressing these
 * during the spinner-active phases keeps the wizard output clean.
 *
 * Note: `chat.tsx` does its own process-lifetime console redirect to a chat
 * log file. That cannot use this helper because its lifetime is the whole
 * session, not a scoped wrap. Keep the two pathways separate.
 */
export async function withSilencedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }
  const noop = (() => {}) as (...args: unknown[]) => void
  console.log = noop as typeof console.log
  console.info = noop as typeof console.info
  console.warn = noop as typeof console.warn
  console.error = noop as typeof console.error
  console.debug = noop as typeof console.debug
  try {
    return await fn()
  } finally {
    console.log = orig.log
    console.info = orig.info
    console.warn = orig.warn
    console.error = orig.error
    console.debug = orig.debug
  }
}
