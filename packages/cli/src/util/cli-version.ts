/**
 * Resolve the CLI package's own version. Used by `nebula --version` and to pin
 * the gateway version installed in sandbox containers (mode=npm) so the
 * gateway matches the CLI.
 *
 * Reads package.json via a path relative to this module so it works in every
 * install layout: monorepo workspace (where bare-specifier resolution of
 * `nebula-ai-cli` doesn't include /package.json without an exports entry),
 * `bun add -g` global install, and Bun's per-project content store.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function resolveCliVersion(): Promise<string> {
  const here = fileURLToPath(import.meta.url)
  const pkgPath = resolve(here, '../../../package.json')
  try {
    const raw = await readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: unknown }
    if (typeof pkg.version !== 'string') {
      throw new Error('package.json missing version field')
    }
    return pkg.version
  } catch (e) {
    throw new Error(`cannot read CLI version from ${pkgPath}: ${(e as Error).message}`)
  }
}
