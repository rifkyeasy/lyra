// Bun's `Error.captureStackTrace` throws "First argument must be an Error object"
// for some calls `follow-redirects` makes at module-init time (it builds error
// subclasses via `new BaseError()` whose constructor calls captureStackTrace).
// follow-redirects is pulled in by axios → navi-sdk, so importing the on-chain
// plugin (lending tools) used to crash `lyra` chat on startup.
//
// Guard captureStackTrace so such calls are a harmless no-op instead of throwing
// — the affected error objects simply won't carry a V8-captured stack. This MUST
// be imported before anything that transitively loads navi-sdk/axios.
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
