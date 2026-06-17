import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

// Dedupe @tanstack/react-query to a single physical copy. In the bun workspace
// both apps/web and the hoisted root have their own copy; @mysten/dapp-kit's
// hooks would otherwise read a different QueryClientContext instance than the
// app's <QueryClientProvider>, throwing "No QueryClient set" during SSR.
const require = createRequire(`${import.meta.url}/`)
const DEDUPE = ['@tanstack/react-query', '@tanstack/query-core'] as const
const dedupeAlias: Record<string, string> = {}
for (const pkg of DEDUPE) {
  try {
    dedupeAlias[pkg] = path.dirname(require.resolve(`${pkg}/package.json`))
  } catch {
    // package not present — skip
  }
}

const config: NextConfig = {
  reactStrictMode: true,
  // Dev + build both run on webpack (the dev script drops --turbopack): turbopack
  // does not resolve this bun workspace's root-hoisted node_modules, and webpack
  // also applies the react-query dedupe alias below.
  webpack: webpackConfig => {
    webpackConfig.resolve.alias = { ...webpackConfig.resolve.alias, ...dedupeAlias }
    return webpackConfig
  },
  // Pin file-tracing root to this app so Next doesn't warn about the bun
  // workspace root vs the app-local lockfile created on the deploy host.
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  // Build to an overridable dir so the deploy can build into a temp dir and
  // atomically swap it into `.next` — avoids serving a half-rewritten build
  // (ChunkLoadError) during the ~20s `next build` window. `next start` keeps
  // the default `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  images: {
    formats: ['image/avif', 'image/webp'],
    qualities: [70, 75, 85, 95],
  },
  async rewrites() {
    return [
      { source: '/llms.txt', destination: '/llms' },
      { source: '/llms-full.txt', destination: '/llms/full' },
      { source: '/docs/:slug.md', destination: '/llms/docs/:slug' },
    ]
  },
}

export default config
