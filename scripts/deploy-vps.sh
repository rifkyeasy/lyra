#!/usr/bin/env bash
#
# Build + reload the Lyra web console on the VPS. The CALLER pulls latest first
# (the GitHub Actions deploy workflow does `git pull` before invoking this, so a
# changed copy of this script is what runs). Build goes to a temp dir and is
# swapped into .next atomically — a failed build leaves the running version
# untouched (near-zero-downtime).
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"
APP="$HOME/lyra/apps/web"

echo "→ install (workspace)"
cd "$HOME/lyra" && bun install

echo "→ build (to .next-build)"
cd "$APP"
NEXT_DIST_DIR=.next-build NODE_OPTIONS="--max-old-space-size=2048" bun run build

echo "→ swap .next-build → .next"
rm -rf .next.old
[ -d .next ] && mv .next .next.old || true
mv .next-build .next

echo "→ reload pm2 (lyra-web)"
pm2 reload lyra-web --update-env || pm2 start "$HOME/lyra/node_modules/.bin/next" \
  --name lyra-web --interpreter node --cwd "$APP" -- start -p 3220
pm2 save
rm -rf .next.old

echo "✓ deployed: $(git -C "$HOME/lyra" log --oneline -1)"
