#!/usr/bin/env bash
#
# Publish the Lyra packages to npm in dependency order.
#
# Use `bun publish` (NOT `npm publish`): it resolves the `workspace:*` deps to the
# real published version. Each package prompts for a one-time 2FA code (OTP) from
# your authenticator app — never use the recovery codes here.
#
# Prereqs:
#   1. Be logged in:            npm whoami    (else: npm login)
#   2. 2FA enabled on npm. If you ever pasted your recovery codes anywhere,
#      regenerate them first (npmjs.com → Account → Two-Factor Authentication).
#   3. Run from the repo root:  bash scripts/publish-npm.sh
#
# Consumers then install with bun (the CLI is bun-native — TS source + a bun
# shebang):  bun install -g lyra-ai-agent   &&   lyra
set -euo pipefail

# Dependency order: a package must be on npm before anything that depends on it.
PACKAGES=(core plugin-onchain plugin-system plugin-telegram gateway cli)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Publishing Lyra @ $(grep -m1 '"version"' packages/cli/package.json | sed 's/[^0-9.]//g')"
echo "Logged in as: $(npm whoami 2>/dev/null || echo 'NOT LOGGED IN — run: npm login')"
echo

for p in "${PACKAGES[@]}"; do
  name="$(grep -m1 '"name"' "packages/$p/package.json" | sed -E 's/.*"name": *"([^"]+)".*/\1/')"
  echo "──> publishing ${name}  (packages/$p)"
  ( cd "packages/$p" && bun publish )
  echo "    done: ${name}"
  echo
done

echo "✓ All packages published. Try it:  bun install -g lyra-ai-agent  &&  lyra"
