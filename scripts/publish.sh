#!/usr/bin/env bash
# scripts/publish.sh — Pi-side: copy safe state files into the wanda-desk
# repo clone and push to GitHub. Invoked after each Wanda heartbeat.
#
# WHITELIST ONLY. Do not add files that could contain credentials, keys,
# or other sensitive agent internals (SOUL.md, config.yaml, .env, etc).
#
# Idempotent: if nothing changed, exits 0 without pushing.

set -euo pipefail

# ---- paths ----
PORTFOLIO="${HOME}/.hermes/portfolio"
REPO="${HOME}/wanda-desk-publish"
LOG="${HOME}/.hermes/logs/wanda-desk-publish.log"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) publish run ===="

if [ ! -d "$REPO/.git" ]; then
  echo "FATAL: $REPO is not a git checkout. Run scripts/bootstrap.sh first." >&2
  exit 1
fi

mkdir -p "$REPO/state"

# ---- whitelisted copies (bail cleanly if source missing) ----
copy_if_present() {
  local src="$1" dst="$2"
  if [ -f "$src" ]; then
    install -m 0644 "$src" "$dst"
  else
    echo "WARN: missing $src"
  fi
}

copy_if_present "$PORTFOLIO/state/nav.json"           "$REPO/state/nav.json"
copy_if_present "$PORTFOLIO/state/positions.json"     "$REPO/state/positions.json"
copy_if_present "$PORTFOLIO/state/nav_history.jsonl"  "$REPO/state/nav_history.jsonl"
copy_if_present "$PORTFOLIO/ledger/ledger.jsonl"      "$REPO/state/ledger.jsonl"
copy_if_present "$PORTFOLIO/signals/watchlist.json"   "$REPO/state/watchlist.json"

# ---- commit + push if changed ----
cd "$REPO"

# belt-and-suspenders: forbid any path outside state/ and a small allowlist
# of repo files from ever being committed by this script.
git add state/

if git diff --cached --quiet; then
  echo "no changes — exit 0"
  exit 0
fi

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NAV="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["nav"])' "$REPO/state/nav.json" 2>/dev/null || echo "?")"
git -c user.name="Wanda" -c user.email="wanda@todd-pi.local" \
    commit -q -m "heartbeat ${STAMP} · NAV ${NAV}"

# retry push up to 3 times for flaky wifi
n=0
until [ $n -ge 3 ]; do
  if git push -q origin main; then
    echo "pushed NAV=${NAV} at ${STAMP}"
    exit 0
  fi
  n=$((n+1))
  echo "push attempt $n failed — retrying in 5s"
  sleep 5
done

echo "push failed after 3 attempts"
exit 1
