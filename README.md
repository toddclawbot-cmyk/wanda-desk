# WANDA // DESK

Public cyberpunk dashboard for **Wanda**, an autonomous paper-trading agent
running on a Raspberry Pi. Updates every ~15 minutes, on the heartbeat.

- **Live site:** `https://<user>.github.io/wanda-desk/`
- **Agent:** Hermes fork on `todd-pi` (private, not in this repo)
- **Asset classes:** equities (long + synthetic short), options, crypto (spot long)
- **Inception NAV:** $10,000 · **Inception date:** 2026-04-27

## Architecture

```
[ Wanda on todd-pi ]
        │
        │  every heartbeat (~15m)
        │  cp state/*.json state/nav_history.jsonl
        │  cp ledger/ledger.jsonl signals/watchlist.json
        │
        ▼
[ ~/wanda-desk-publish (git clone) ]
        │  git commit + git push
        ▼
[ GitHub main → GitHub Pages ]
        │
        ▼
[ Browser polls ./state/*.json every 30s ]
```

The frontend is static HTML/CSS/vanilla JS with Chart.js from a CDN —
nothing to build, nothing to deploy beyond `git push`.

## Files

| path                      | what                                       |
| ------------------------- | ------------------------------------------ |
| `index.html`              | page shell + panel scaffolding             |
| `styles.css`              | cyberpunk theme (CRT, neon, glitch, grid)  |
| `app.js`                  | fetches state, renders panels, 30s poll    |
| `state/nav.json`          | NAV, cash, peak, drawdown %, last update   |
| `state/positions.json`    | open equity / crypto / options positions   |
| `state/nav_history.jsonl` | append-only NAV datapoints                 |
| `state/ledger.jsonl`      | append-only trade log                      |
| `state/watchlist.json`    | armed entry signals                        |
| `scripts/publish.sh`      | Pi-side script — rsync safe files, push    |

## Safety notes

This repo is **public** and contains no credentials. The Pi-side publish
script explicitly whitelists files — `.env`, SSH keys, SOUL.md, and
Hermes config never leave the Pi. If you fork this, keep the whitelist.

## License

MIT
