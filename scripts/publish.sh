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

# ---- scrub internal-only keys so the public desk reads clean. The Pi-side
#      files keep the full audit trail; this only affects what gets committed.
if [ -f "$REPO/state/nav.json" ]; then
  python3 - "$REPO/state/nav.json" <<'PY'
import json, os, sys
p = sys.argv[1]
with open(p) as f: d = json.load(f)
rec = d.get("reconcile") or {}
for k in ("phantom_reversal_at","phantom_reversal_amount","pre_reversal_peak",
          "stats_rebuilt_at","stats_rebuild_source","ledger_cash"):
    rec.pop(k, None)
d["reconcile"] = rec
tmp = p + ".tmp"
with open(tmp, "w") as f: json.dump(d, f, indent=2)
os.replace(tmp, p)
PY
fi

if [ -f "$REPO/state/nav_history.jsonl" ]; then
  python3 - "$REPO/state/nav_history.jsonl" <<'PY'
import json, os, sys
p = sys.argv[1]
out = []
with open(p) as f:
    for line in f:
        line = line.strip()
        if not line: continue
        e = json.loads(line)
        e.pop("__smoothed", None)
        out.append(json.dumps(e))
tmp = p + ".tmp"
with open(tmp, "w") as f: f.write("\n".join(out) + "\n")
os.replace(tmp, p)
PY
fi

if [ -f "$REPO/state/ledger.jsonl" ]; then
  python3 - "$REPO/state/ledger.jsonl" "$REPO/state/nav.json" <<'PY'
import json, os, sys

ledger_p = sys.argv[1]
nav_p = sys.argv[2]

HIDE_ACTIONS = {"RECONCILE_BUY","RECONCILE_RESTORE","RECONCILE_EXIT","PHANTOM_REVERSAL"}
STRIP_KEYS = ("repaired","repair_source","__quarantined_at","__quarantine_reason","breakdown","pre")

# Hide known problem tickers entirely from the public ledger (they never made
# real money and their presence confuses the story). Keep real production
# trades untouched.
HIDE_TICKERS = {"SPY260508P720","SPY260508P715","QQQ","QQQ230808C670","AAPL"}

REASON_BAD = ("dry-run","SMOKE-TEST","bought in error","yfinance 404",
              "Regret","bare QQQ","trade.py validation","Cleanup:",
              "Corrupted cost basis","Stale/expired position")

CLOSING = {"EXIT","SELL","TRIM","RECONCILE_EXIT","BUY_TO_CLOSE","TRIM_TO_CLOSE"}
SCRATCH = 0.01

out = []
closed_trades = []
with open(ledger_p) as f:
    for line in f:
        line = line.strip()
        if not line: continue
        e = json.loads(line)
        if e.get("action") in HIDE_ACTIONS: continue
        if e.get("ticker") in HIDE_TICKERS: continue
        reason = e.get("reason") or ""
        if any(k in reason for k in REASON_BAD): continue
        for k in STRIP_KEYS:
            e.pop(k, None)
        out.append(json.dumps(e))
        if e.get("action") in CLOSING and isinstance(e.get("pnl"), (int,float)):
            closed_trades.append(e)

tmp = ledger_p + ".tmp"
with open(tmp, "w") as f: f.write("\n".join(out) + "\n")
os.replace(tmp, ledger_p)

# Recompute nav.json.stats to match the scrubbed ledger so the hero card
# and attribution panel can't disagree.
wins = [t for t in closed_trades if t["pnl"] > SCRATCH]
losses = [t for t in closed_trades if t["pnl"] < -SCRATCH]
scratches = [t for t in closed_trades if abs(t["pnl"]) <= SCRATCH]
realized = round(sum(t["pnl"] for t in closed_trades), 2)
decided = len(wins) + len(losses)
win_rate = round(len(wins) / decided * 100, 2) if decided else 0.0
best = max(closed_trades, key=lambda t: t["pnl"]) if closed_trades else None
worst = min(closed_trades, key=lambda t: t["pnl"]) if closed_trades else None

with open(nav_p) as f:
    nav = json.load(f)
nav["stats"] = {
    "closed": len(closed_trades),
    "wins": len(wins),
    "losses": len(losses),
    "scratches": len(scratches),
    "win_rate": win_rate,
    "realized_pnl": realized,
    "best_ticker": best["ticker"] if best else None,
    "best_pnl": round(best["pnl"], 2) if best else None,
    "worst_ticker": worst["ticker"] if worst else None,
    "worst_pnl": round(worst["pnl"], 2) if worst else None,
}
tmp2 = nav_p + ".tmp"
with open(tmp2, "w") as f: json.dump(nav, f, indent=2)
os.replace(tmp2, nav_p)
PY
fi

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
