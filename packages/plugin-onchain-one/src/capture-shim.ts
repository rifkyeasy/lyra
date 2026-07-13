// Bun's `Error.captureStackTrace` throws "First argument must be an Error object"
// for some calls `follow-redirects` makes at module-init time. follow-redirects is
// pulled in by axios → navi-sdk (imported statically by ./tools/navi), so loading
// this plugin under Bun used to crash the host (e.g. `lyra` chat, the gateway).
//
// Guard captureStackTrace so such calls are a harmless no-op instead of throwing —
// the affected error objects just won't carry a V8-captured stack. MUST be the
// first import in this package's entry, before anything pulls in navi-sdk.
const original = Error.captureStackTrace
if (typeof original === 'function') {
  Error.captureStackTrace = ((target: object, ctor?: unknown) => {
    try {
      ;(original as (t: object, c?: unknown) => void).call(Error, target, ctor)
    } catch {
      // Bun rejects some non-Error targets here — ignore.
    }
  }) as typeof Error.captureStackTrace
}

export {}
