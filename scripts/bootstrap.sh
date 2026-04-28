#!/usr/bin/env bash
# scripts/bootstrap.sh — Pi-side one-time setup for wanda-desk publishing.
# Creates ~/wanda-desk-publish as a git clone authed for push.
#
# Prereqs on the Pi:
#   - SSH key at ~/.ssh/id_ed25519 added to the GitHub account as a deploy
#     key OR user key with write access to the wanda-desk repo.
#   - jq installed (sudo apt-get install -y jq) — used by publish.sh for
#     the commit message.

set -euo pipefail

REPO_URL="${1:-}"
if [ -z "$REPO_URL" ]; then
  echo "usage: bootstrap.sh git@github.com:<user>/wanda-desk.git"
  exit 2
fi

TARGET="${HOME}/wanda-desk-publish"
if [ -d "$TARGET/.git" ]; then
  echo "already bootstrapped at $TARGET"
else
  git clone "$REPO_URL" "$TARGET"
fi

# make sure we can push
cd "$TARGET"
git remote set-url origin "$REPO_URL"
git config pull.rebase false

# publish.sh uses python3 (already on the Pi) to read NAV from nav.json —
# no external deps required.

echo "bootstrap ok → $TARGET"
