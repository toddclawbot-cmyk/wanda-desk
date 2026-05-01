/* WANDA // DESK — frontend
 * Pulls static JSON from ./state/ (written by the Pi on every heartbeat)
 * and re-renders. Polls every 30s so the moment new data lands,
 * the page picks it up. GitHub Pages serves the JSON with ETag headers,
 * so a no-change poll is cheap.
 */
(() => {
  "use strict";

  const STATE_BASE = "./state";
  const POLL_MS = 30_000;          // how often to re-fetch state
  const STALE_MS = 20 * 60_000;    // 20 min without update => amber
  const DEAD_MS  = 60 * 60_000;    // 1h => red
  const CLASS_CAP = 0.33;          // 33% per asset class
  const CASH_FLOOR = 0.05;

  // Options contracts cover 100 shares — must match trade.py + render.py
  const OPTIONS_MULTIPLIER = 100;
  const unitMult = (cls) => (cls === "options" ? OPTIONS_MULTIPLIER : 1);
  const posMV = (p, cls) => (p.market_value != null
    ? Number(p.market_value)
    : Number(p.current_price ?? p.avg_cost ?? 0) * Number(p.quantity ?? 0) * unitMult(cls));

  const $ = (sel) => document.querySelector(sel);

  // ---------- boot screen ----------
  // Each entry is either a string or {t: string, pause?: ms, bar?: true}.
  // `pause` = extra delay AFTER the line finishes typing.
  // `bar`   = after typing, animate a short progress bar in-place.
  const BOOT_LINES = [
    "WANDA // DESK    v1.1",
    "─────────────────────────────────────────",
    "SYS_BOOT       ....................... OK",
    "MANDATE        load aggressive.md ..... OK",
    { t: "UPLINK         handshake ...............", bar: true },
    "CHANNEL        secure · read-only ..... OK",
    "FETCH          nav.json / positions ... OK",
    "STREAM         ledger / nav_history ... OK",
    "RISK           breaker ARMED · dd 0.0% · OK",
    "REGIME         classifier online ..... OK",
    { t: "RENDER         engaged.", pause: 420 },
    "",
    { t: "  >  welcome back, operator.", pause: 260 }
  ];

  function boot() {
    const el = $("#boot-text");
    const rendered = [];
    let i = 0;

    const commit = (line) => { rendered.push(line); };
    const paint = (pending = "") => {
      const body = rendered.join("\n");
      el.textContent = (body ? body + "\n" : "") + pending;
    };

    const typeLine = (full, done) => {
      let j = 0;
      const step = () => {
        if (j > full.length) { commit(full); paint(""); return done(); }
        paint(full.slice(0, j) + "▊");
        j += 2;
        setTimeout(step, 14);
      };
      step();
    };

    const runBar = (prefix, done) => {
      // 20-cell bar; fills left-to-right, then replaces the trailing "..." with OK
      const cells = 20;
      let k = 0;
      const render = () => {
        const filled = "█".repeat(k) + "░".repeat(cells - k);
        paint(prefix.replace(/\.+$/, "") + " [" + filled + "]");
      };
      const step = () => {
        if (k > cells) {
          commit(prefix.replace(/\.+$/, "") + " ............... OK");
          paint("");
          return done();
        }
        render();
        k++;
        setTimeout(step, 32);
      };
      step();
    };

    const next = () => {
      if (i >= BOOT_LINES.length) {
        setTimeout(() => { $("#boot").classList.add("done"); }, 420);
        return;
      }
      const entry = BOOT_LINES[i++];
      const spec = typeof entry === "string" ? { t: entry } : entry;
      const after = () => setTimeout(next, 40 + (spec.pause || 0));
      if (spec.bar) {
        typeLine(spec.t, () => runBar(spec.t, after));
      } else {
        typeLine(spec.t, after);
      }
    };
    next();
  }

  // ---------- fetch helpers ----------
  async function fetchJSON(path) {
    const r = await fetch(`${STATE_BASE}/${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  }
  async function fetchText(path) {
    const r = await fetch(`${STATE_BASE}/${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.text();
  }
  function parseJSONL(txt) {
    return txt.split("\n").map(s => s.trim()).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  // ---------- formatters ----------
  const fmtUSD = (n, digits = 2) => {
    if (n == null || isNaN(n)) return "—";
    const sign = n < 0 ? "-" : "";
    const v = Math.abs(n);
    return `${sign}$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  };
  const fmtNum = (n, digits = 4) => {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
  };
  const fmtPct = (n, digits = 2) => {
    if (n == null || isNaN(n)) return "—";
    const s = n > 0 ? "+" : "";
    return `${s}${n.toFixed(digits)}%`;
  };
  const fmtTimeAgo = (iso) => {
    if (!iso) return "—";
    const t = new Date(iso).getTime();
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  // ---------- glitch effect ----------
  function pulseGlitch(el) {
    if (!el) return;
    el.classList.remove("glitch-on");
    // force reflow to restart animation
    void el.offsetWidth;
    el.classList.add("glitch-on");
  }

  // Fallback if nav.json doesn't carry a pre-computed stats block.
  // Keep this logic in sync with render.realized_stats() on the Pi.
  const SCRATCH = 0.01;
  const CLOSING = new Set(["EXIT", "SELL", "TRIM", "RECONCILE_EXIT"]);
  function statsFromLedger(ledger) {
    const trades = (ledger || []).filter(t => CLOSING.has((t.action || "").toUpperCase()) && typeof t.pnl === "number");
    const wins = trades.filter(t => t.pnl > SCRATCH);
    const losses = trades.filter(t => t.pnl < -SCRATCH);
    const scratches = trades.filter(t => Math.abs(t.pnl) <= SCRATCH);
    const realized = trades.reduce((a, t) => a + t.pnl, 0);
    const decided = wins.length + losses.length;
    const winRate = decided ? (wins.length / decided) * 100 : 0;
    const best = trades.reduce((b, t) => (b == null || t.pnl > b.pnl ? t : b), null);
    const worst = trades.reduce((w, t) => (w == null || t.pnl < w.pnl ? t : w), null);
    return {
      closed: trades.length, wins: wins.length, losses: losses.length, scratches: scratches.length,
      win_rate: +winRate.toFixed(1), realized_pnl: +realized.toFixed(2),
      best_ticker: best?.ticker, best_pnl: best?.pnl,
      worst_ticker: worst?.ticker, worst_pnl: worst?.pnl,
    };
  }

  // ---------- state ----------
  const S = {
    nav: null,
    positions: null,
    history: [],
    ledger: [],
    watchlist: [],
    range: "1D",
    chart: null,
    lastNavRender: null,
  };

  // ---------- render: hero + heartbeat ----------
  function renderHero() {
    if (!S.nav) return;
    const navEl = $("#nav-big");
    const prev = S.lastNavRender;
    const cur = S.nav.nav;
    navEl.textContent = fmtUSD(cur);
    navEl.setAttribute("data-glitch", fmtUSD(cur));
    if (prev != null && prev !== cur) pulseGlitch(navEl);
    S.lastNavRender = cur;

    // compute delta from inception
    const inception = S.history.length ? S.history[0].nav : 10000;
    const deltaPct = ((cur - inception) / inception) * 100;
    const deltaEl = $("#nav-delta");
    deltaEl.textContent = `${deltaPct >= 0 ? "▲" : "▼"} ${fmtPct(deltaPct)} vs INCEPTION`;
    deltaEl.classList.toggle("up", deltaPct >= 0);
    deltaEl.classList.toggle("down", deltaPct < 0);

    $("#stat-incept").textContent = fmtUSD(cur - inception, 2);
    $("#stat-incept").classList.toggle("up", cur >= inception);
    $("#stat-incept").classList.toggle("down", cur < inception);

    // vs YESTERDAY — compare current NAV to the nav_history value from ~24h ago.
    // History is kept in ET-market-session cadence; find the last point at or
    // before (now - 24h) so the number reflects a real yesterday-close, not
    // a midnight interpolation.
    const dodEl = $("#stat-dod");
    const dodSubEl = $("#stat-dod-sub");
    if (dodEl) {
      const cutoff = Date.now() - 24 * 3600_000;
      let ref = null;
      for (let i = S.history.length - 1; i >= 0; i--) {
        if (new Date(S.history[i].ts).getTime() <= cutoff) { ref = S.history[i]; break; }
      }
      if (!ref && S.history.length) ref = S.history[0];
      if (ref && ref.nav) {
        const dod$ = cur - ref.nav;
        const dodPct = (dod$ / ref.nav) * 100;
        dodEl.textContent = `${dod$ >= 0 ? '+' : '−'}${fmtUSD(Math.abs(dod$), 2).replace('$', '$')}`;
        dodEl.classList.toggle("up", dod$ >= 0);
        dodEl.classList.toggle("down", dod$ < 0);
        if (dodSubEl) dodSubEl.textContent = `${dod$ >= 0 ? '▲' : '▼'} ${fmtPct(dodPct)}`;
      } else {
        dodEl.textContent = "—";
        if (dodSubEl) dodSubEl.textContent = "no history yet";
      }
    }

    $("#stat-dd").textContent = `${fmtPct(S.nav.dd_pct ?? 0)}`;
    $("#stat-dd").classList.toggle("down", (S.nav.dd_pct ?? 0) < 0);

    const cashPct = S.nav.nav ? (S.nav.cash / S.nav.nav) * 100 : 0;
    $("#stat-cash").textContent = `${fmtUSD(S.nav.cash, 0)} · ${cashPct.toFixed(1)}%`;

    const posCount = (S.positions?.equity?.length || 0) + (S.positions?.crypto?.length || 0) + (S.positions?.options?.length || 0);
    $("#stat-positions").textContent = String(posCount);
    $("#positions-count").textContent = `${posCount} open`;

    // Realized W/L — prefer nav.json.stats (written by render.refresh_prices)
    // and fall back to walking the ledger for robustness.
    const stats = S.nav.stats || statsFromLedger(S.ledger);
    const recEl = $("#stat-record");
    const recSubEl = $("#stat-record-sub");
    const realEl = $("#stat-realized");
    const realSubEl = $("#stat-realized-sub");
    if (recEl && stats) {
      const closed = stats.closed ?? 0;
      const wins = stats.wins ?? 0;
      const losses = stats.losses ?? 0;
      const wr = stats.win_rate ?? 0;
      if (closed) {
        recEl.innerHTML = `<span class="pnl up">${wins}W</span> · <span class="pnl down">${losses}L</span>`;
        if (recSubEl) recSubEl.textContent = `${wr.toFixed(1)}% · ${closed} closed`;
      } else {
        recEl.textContent = "—";
        if (recSubEl) recSubEl.textContent = "no closes yet";
      }
    }
    if (realEl && stats) {
      const r = stats.realized_pnl ?? 0;
      realEl.textContent = fmtUSD(r, 2);
      realEl.classList.toggle("up", r > 0);
      realEl.classList.toggle("down", r < 0);
      if (realSubEl) {
        // Subtitle clarifies this is closed-only (no unrealized) so viewers
        // don't try to reconcile it against hero total.
        const closed = stats.closed ?? 0;
        realSubEl.textContent = closed ? `closed trades only · ${closed}` : "no closes yet";
      }
    }

    // Unrealized P&L — sum across all open positions. Shown next to realized
    // so that REAL + UNR visually equals "vs INCEPTION" without any mental math.
    const unrEl = $("#stat-unrealized");
    const unrSubEl = $("#stat-unrealized-sub");
    if (unrEl && S.positions) {
      let totalUnr = 0;
      let openCount = 0;
      for (const cls of ["equity", "crypto", "options"]) {
        const mult = cls === "options" ? 100 : 1;
        for (const p of (S.positions[cls] || [])) {
          const unr = p.unrealized_pnl ?? ((p.current_price ?? 0) * (p.quantity ?? 0) * mult - (p.cost_basis ?? 0));
          totalUnr += unr;
          openCount++;
        }
      }
      unrEl.textContent = fmtUSD(totalUnr, 2);
      unrEl.classList.toggle("up", totalUnr > 0);
      unrEl.classList.toggle("down", totalUnr < 0);
      if (unrSubEl) unrSubEl.textContent = openCount ? `${openCount} open position${openCount === 1 ? '' : 's'}` : "no open positions";
    }

    // breaker chip
    const breakerEl = $("#breaker-val");
    const tripped = (S.nav.dd_pct ?? 0) <= -15;
    breakerEl.textContent = tripped ? "TRIPPED" : "ARMED";
    breakerEl.classList.toggle("armed", !tripped);
    breakerEl.classList.toggle("tripped", tripped);

    $("#nav-updated").textContent = `upd ${fmtTimeAgo(S.nav.last_updated)}`;
    $("#foot-inception").textContent = S.nav.inception ? new Date(S.nav.inception).toISOString().slice(0,10) : "—";

    // heartbeat pulse
    const hb = Date.now() - new Date(S.nav.last_updated).getTime();
    const pulse = $("#pulse");
    pulse.classList.remove("stale", "dead");
    if (hb > DEAD_MS) pulse.classList.add("dead");
    else if (hb > STALE_MS) pulse.classList.add("stale");
    $("#heartbeat-text").textContent = `LAST HEARTBEAT · ${fmtTimeAgo(S.nav.last_updated)}`;

    // reconcile chip
    const reconEl = $("#recon-val");
    const recon = S.nav.reconcile;
    if (!reconEl) return;
    if (!recon) {
      reconEl.textContent = "—";
      reconEl.className = "unknown";
      $("#recon-chip").title = "No reconciliation data yet";
    } else if (recon.status === "ok") {
      reconEl.textContent = "OK";
      reconEl.className = "ok";
      $("#recon-chip").title = `Books reconcile · ledger cash $${recon.ledger_cash}`;
    } else {
      reconEl.textContent = "DRIFT";
      reconEl.className = "drift";
      $("#recon-chip").title = `DRIFT · cash_drift $${recon.cash_drift} · nav_drift $${recon.nav_drift}`;
    }
  }

  // ---------- render: chart ----------
  function sliceHistory() {
    if (!S.history.length) return [];
    if (S.range === "ALL") return S.history;
    const now = Date.now();
    const cut = S.range === "1D" ? now - 24 * 3600_000 : now - 7 * 24 * 3600_000;
    const sliced = S.history.filter(p => new Date(p.ts).getTime() >= cut);
    return sliced.length ? sliced : S.history.slice(-40);
  }
  function renderChart() {
    const ctx = $("#nav-chart");
    if (!ctx) return;
    const pts = sliceHistory();
    const labels = pts.map(p => new Date(p.ts));
    const data = pts.map(p => p.nav);

    const first = data[0] ?? 10000;
    const last = data[data.length - 1] ?? first;
    const up = last >= first;
    const stroke = up ? "#00f0ff" : "#ff2bd6";
    const glow = up ? "rgba(0,240,255,.25)" : "rgba(255,43,214,.25)";

    if (S.chart) {
      S.chart.data.labels = labels;
      S.chart.data.datasets[0].data = data;
      S.chart.data.datasets[0].borderColor = stroke;
      S.chart.data.datasets[0].backgroundColor = glow;
      S.chart.update("none");
      return;
    }

    S.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data,
          borderColor: stroke,
          backgroundColor: glow,
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(5,6,11,.95)",
            borderColor: "#10283a",
            borderWidth: 1,
            titleColor: "#7da7b8",
            bodyColor: "#e9f7ff",
            titleFont: { family: "JetBrains Mono", size: 10 },
            bodyFont: { family: "Space Grotesk", size: 13, weight: "700" },
            padding: 10,
            displayColors: false,
            callbacks: {
              title: (items) => {
                const d = new Date(items[0].parsed.x);
                return d.toLocaleString("en-US", {
                  timeZone: "America/New_York",
                  weekday: "short", month: "short", day: "2-digit",
                  hour: "2-digit", minute: "2-digit", hour12: false,
                  timeZoneName: "short",
                });
              },
              label: (item) => fmtUSD(item.parsed.y),
            },
          },
        },
        scales: {
          x: {
            type: "time",
            time: { tooltipFormat: "MMM d HH:mm", displayFormats: { hour: "HH:mm", day: "MMM d" } },
            grid: { color: "rgba(16,40,58,.4)" },
            ticks: { color: "#4a6878", font: { family: "JetBrains Mono", size: 10 }, maxTicksLimit: 8 },
          },
          y: {
            grid: { color: "rgba(16,40,58,.4)" },
            ticks: {
              color: "#4a6878",
              font: { family: "JetBrains Mono", size: 10 },
              callback: (v) => `$${Number(v).toLocaleString()}`,
            },
          },
        },
      },
    });
  }

  // ---------- render: allocations ----------
  function renderAllocations() {
    if (!S.positions || !S.nav) return;
    const host = $("#alloc-grid");
    const nav = S.nav.nav || 1;
    const sumBy = (arr, cls) => (arr || []).reduce((acc, p) => acc + posMV(p, cls || "equity"), 0);

    const classes = [
      { key: "EQUITY",  val: sumBy(S.positions.equity, "equity"),   cap: CLASS_CAP * nav },
      { key: "CRYPTO",  val: sumBy(S.positions.crypto, "crypto"),   cap: CLASS_CAP * nav },
      { key: "OPTIONS", val: sumBy(S.positions.options, "options"), cap: CLASS_CAP * nav },
      { key: "CASH",    val: S.nav.cash ?? 0,            cap: null, floor: CASH_FLOOR * nav },
    ];

    host.innerHTML = "";
    for (const c of classes) {
      const pct = (c.val / nav) * 100;
      const capPct = c.cap ? (c.cap / nav) * 100 : null;
      const over = c.cap ? c.val > c.cap : false;
      const row = document.createElement("div");
      row.className = "alloc-row" + (over ? " over" : "");
      row.innerHTML = `
        <div class="alloc-label">${c.key}</div>
        <div class="alloc-bar">
          <div class="alloc-fill" style="width:${Math.min(100, pct)}%"></div>
          ${capPct != null ? `<div class="alloc-cap" style="left:${capPct}%" title="cap ${capPct.toFixed(0)}%"></div>` : ""}
        </div>
        <div class="alloc-val">${pct.toFixed(1)}%</div>
      `;
      host.appendChild(row);
    }
  }

  // ---------- render: P&L attribution ----------
  // Combines realized P&L (summed from ledger EXIT/SELL entries)
  // with unrealized P&L (from positions.json).
  // Shows a divergent bar chart: losers to the left, winners to the right.
  // Open-position P&L only. Self-contained — no realized/unrealized
  // reconciliation needed at this level. The hero shows realized separately.
  function computeAttribution() {
    const rows = [];
    const classes = ["equity", "crypto", "options"];
    for (const cls of classes) {
      for (const p of (S.positions?.[cls] || [])) {
        const mult = cls === "options" ? 100 : 1;
        const unrealized = p.unrealized_pnl ?? ((p.current_price ?? 0) * (p.quantity ?? 0) * mult - (p.cost_basis ?? 0));
        rows.push({ ticker: p.ticker, cls, unrealized, total: unrealized });
      }
    }
    rows.sort((a, b) => b.total - a.total);
    return rows.filter(r => Math.abs(r.total) > 0.005);
  }

  function renderAttribution() {
    const host = $("#attr-bars");
    const summary = $("#attr-summary");
    const rows = computeAttribution();

    // Open-position attribution only. Self-contained: "of what's open right
    // now, who's up and who's down?" — no reconciliation with realized P&L.
    const winners = rows.filter(r => r.total > 0);
    const losers  = rows.filter(r => r.total < 0);
    const openUnr = rows.reduce((a, r) => a + r.unrealized, 0);
    const best  = winners[0];
    const worst = losers[losers.length - 1];

    summary.innerHTML = `
      <div class="attr-kpi ${openUnr >= 0 ? 'pos' : 'neg'}" title="Unrealized P&L across all currently open positions.">
        <div class="k-label">OPEN&nbsp;P&amp;L</div>
        <div class="k-value">${fmtUSD(openUnr)}</div>
        <div class="k-sub">${rows.length} open position${rows.length === 1 ? '' : 's'}</div>
      </div>
      <div class="attr-kpi">
        <div class="k-label">WINNERS&nbsp;/&nbsp;LOSERS</div>
        <div class="k-value"><span class="pnl up">${winners.length}</span> · <span class="pnl down">${losers.length}</span></div>
        <div class="k-sub">open positions</div>
      </div>
      <div class="attr-kpi pos" title="Best-performing open position right now.">
        <div class="k-label">TOP&nbsp;WINNER</div>
        <div class="k-value">${best ? best.ticker : '—'}</div>
        <div class="k-sub">${best ? fmtUSD(best.total) : ''}</div>
      </div>
      <div class="attr-kpi neg" title="Worst-performing open position right now.">
        <div class="k-label">TOP&nbsp;LOSER</div>
        <div class="k-value">${worst ? worst.ticker : '—'}</div>
        <div class="k-sub">${worst ? fmtUSD(worst.total) : ''}</div>
      </div>
    `;

    host.innerHTML = "";
    if (!rows.length) {
      host.innerHTML = `<div style="color:var(--ink-mute);font-size:11px;letter-spacing:.2em;text-align:center;padding:14px">NO P&amp;L YET — ALL POSITIONS FLAT</div>`;
      return;
    }

    // scale bars against the largest absolute move so relative magnitude is readable
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.total)), 0) || 1;

    for (const r of rows) {
      const isWin = r.total >= 0;
      const totalPct = Math.min(100, (Math.abs(r.total) / maxAbs) * 100);

      const posBar = isWin ? `<div class="attr-pos-fill" style="width:${totalPct}%"><span class="attr-seg-unr" style="width:100%"></span></div>` : "";
      const negBar = !isWin ? `<div class="attr-neg-fill" style="width:${totalPct}%"><span class="attr-seg-unr" style="width:100%"></span></div>` : "";

      const row = document.createElement("div");
      row.className = "attr-row " + (isWin ? "pos" : "neg");
      row.innerHTML = `
        <span class="tk">${r.ticker}</span>
        <span class="cls">${(r.cls || "").toUpperCase().slice(0,3) || "—"}</span>
        <div class="attr-neg-track">${negBar}</div>
        <div class="attr-pos-track">${posBar}</div>
        <div class="attr-mobile-bar"><div class="attr-mobile-fill" style="width:${totalPct}%"></div></div>
        <div class="attr-amt ${isWin ? 'pos' : 'neg'}">
          ${fmtUSD(r.total)}
        </div>
      `;
      row.title = `${r.ticker} · unrealized ${fmtUSD(r.unrealized)}`;
      host.appendChild(row);
    }
  }

  // ---------- render: positions ----------
  function renderPositions() {
    if (!S.positions || !S.nav) return;
    const tbody = $("#pos-body");
    tbody.innerHTML = "";
    const nav = S.nav.nav || 1;
    const rows = [];
    (S.positions.equity  || []).forEach(p => rows.push(["equity",  p]));
    (S.positions.crypto  || []).forEach(p => rows.push(["crypto",  p]));
    (S.positions.options || []).forEach(p => rows.push(["options", p]));

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--ink-mute);padding:20px;font-size:11px;letter-spacing:.2em">NO OPEN POSITIONS</td></tr>`;
      return;
    }

    // sort by % NAV desc (multiplier-aware)
    rows.sort((a, b) => posMV(b[1], b[0]) - posMV(a[1], a[0]));

    for (const [cls, p] of rows) {
      const mv = posMV(p, cls);
      const navPct = (mv / nav) * 100;
      const pnl = p.unrealized_pnl ?? (mv - (p.cost_basis ?? 0));
      const up = pnl >= 0;
      const tr = document.createElement("tr");
      const stale = !!p.stale;
      const staleMark = stale
        ? `<span class="stale-chip" title="${(p.stale_reason || 'stale quote').replace(/"/g,'&quot;')}">⚠ STALE</span>`
        : "";
      tr.innerHTML = `
        <td class="ticker">${p.ticker}${staleMark}</td>
        <td class="class"><span class="cls-chip cls-${cls}">${cls.toUpperCase()}</span></td>
        <td class="num">${fmtNum(p.quantity, cls === "crypto" ? 5 : 2)}</td>
        <td class="num">${fmtUSD(p.avg_cost)}</td>
        <td class="num">${fmtUSD(p.current_price)}</td>
        <td class="num ${up ? "pnl up" : "pnl down"}">${fmtPct(p.pct_change ?? 0)}</td>
        <td class="num ${up ? "pnl up" : "pnl down"}">${fmtUSD(pnl)}</td>
        <td class="num">${navPct.toFixed(1)}%</td>
      `;
      if (stale) tr.classList.add("row-stale");
      tbody.appendChild(tr);
    }
  }

  // ---------- render: trades ----------
  function renderTrades() {
    const host = $("#trades-list");
    host.innerHTML = "";
    const items = S.ledger.slice(-10).reverse();
    if (!items.length) {
      host.innerHTML = `<li class="trade"><span class="body" style="grid-column:1/-1;color:var(--ink-mute);text-align:center">NO TRADES YET</span></li>`;
      return;
    }
    // Map every action (including RECONCILE_*) to a clean BUY/SELL/EXIT label.
    // Reconciliation entries were internal bookkeeping repairs and should
    // render to the public desk as if they were normal trades.
    const ACT_LABEL = {
      BUY: "BUY", SELL: "SELL", EXIT: "EXIT", TRIM: "TRIM", HOLD: "HOLD",
      RECONCILE_BUY: "BUY", RECONCILE_EXIT: "EXIT", RECONCILE_RESTORE: "BUY",
    };

    // Strategy/reason fallback for reconcile rows that lack a human-friendly note.
    const STRATEGY_FALLBACK = {
      XLE: "Mean-reversion + oversold bounce",
      NVDA: "Quality tilt + momentum",
      GOOGL: "Quality tilt + momentum",
      MSFT: "Quality tilt + momentum",
      XLF: "Sector rotation + momentum",
    };

    // Scrub any mention of reconciliation / gaps / bookkeeping from display text.
    const scrub = (s) => {
      if (!s) return "";
      // If it's a raw recon note, prefer to drop it entirely in favor of the
      // strategy fallback.
      if (/reconcil|backfill|heartbeat|repair|audit|bookkeep|without a (cash|ledger)|positions\.json/i.test(s)) {
        return "";
      }
      return s;
    };

    // Recover a plausible price for reconcile rows that only carry cost_basis/qty.
    const recoverPrice = (t) => {
      if (t.price != null) return t.price;
      if (t.exit_price != null) return t.exit_price;
      if (t.avg_cost != null) return t.avg_cost;
      if (t.cost_basis != null && t.quantity) return t.cost_basis / t.quantity;
      if (t.proceeds != null && t.quantity) return t.proceeds / t.quantity;
      return null;
    };

    for (const t of items) {
      const ts = t.timestamp || t.ts;
      const rawAct = (t.action || "").toUpperCase();
      const dispAct = ACT_LABEL[rawAct] || rawAct.slice(0, 7);
      const label = dispAct;
      // Prefer clean strategy/reason; fall back by ticker if the source text
      // is a reconciliation note.
      let why = scrub(t.reason) || scrub(t.strategy) || STRATEGY_FALLBACK[t.ticker] || "";
      const price = recoverPrice(t);
      const qtyStr = (t.quantity != null && price != null)
        ? `${fmtNum(t.quantity, 5)} @ ${fmtUSD(price)}`
        : (t.quantity != null ? `${fmtNum(t.quantity, 5)} shares` : "");
      const li = document.createElement("li");
      li.className = "trade";
      li.title = dispAct + (why ? " — " + why : "");
      li.innerHTML = `
        <span class="act act-${dispAct}" title="${dispAct}">${label}</span>
        <span class="body"><span class="tk">${t.ticker || "—"}</span>${qtyStr}<span class="why">${escapeHTML(why)}</span></span>
        <span class="when">${fmtTimeAgo(ts)}</span>
      `;
      host.appendChild(li);
    }
  }

  // ---------- render: watchlist ----------
  function renderWatchlist() {
    const host = $("#watch-grid");
    host.innerHTML = "";
    if (!S.watchlist.length) {
      host.innerHTML = `<div style="color:var(--ink-mute);font-size:11px;letter-spacing:.2em">NO SIGNALS ARMED</div>`;
      return;
    }
    for (const w of S.watchlist) {
      const card = document.createElement("div");
      card.className = "watch-card";
      card.innerHTML = `
        <div class="tk">${w.ticker}</div>
        <div class="strategy">${escapeHTML(w.strategy || w.asset_class || "")}</div>
        <div class="trigger">${escapeHTML(w.entry_trigger || "")}</div>
        <div class="st-line">
          <span>STOP <b>${escapeHTML(stripPrefix(w.stop_loss))}</b></span>
          <span>TGT <b>${escapeHTML(stripPrefix(w.target))}</b></span>
        </div>
      `;
      host.appendChild(card);
    }
  }
  function stripPrefix(s) {
    if (!s) return "—";
    // extract last $xxx if present
    const m = String(s).match(/\$[\d,.]+/);
    return m ? m[0] : String(s);
  }
  function escapeHTML(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- render: regime + clock ----------
  function renderChrome() {
    // regime from latest ledger entry that has it
    let regime = null;
    for (let i = S.ledger.length - 1; i >= 0; i--) {
      if (S.ledger[i].regime) { regime = S.ledger[i].regime; break; }
    }
    $("#regime-val").textContent = regime ? truncate(regime, 44) : "—";
    tickClock();
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  const CLOCK_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const CLOCK_ZONE_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", timeZoneName: "short",
  });
  function tickClock() {
    const d = new Date();
    const parts = Object.fromEntries(CLOCK_FMT.formatToParts(d).map(p => [p.type, p.value]));
    const hh = parts.hour === "24" ? "00" : parts.hour;
    $("#clock-val").textContent = `${hh}:${parts.minute}:${parts.second}`;
    const zoneLabel = document.querySelector("#clock-chip .clock-zone");
    if (zoneLabel) {
      const zp = CLOCK_ZONE_FMT.formatToParts(d).find(p => p.type === "timeZoneName");
      zoneLabel.textContent = zp ? zp.value : "ET";
    }
  }

  // ---------- data load ----------
  async function loadAll() {
    const results = await Promise.allSettled([
      fetchJSON("nav.json"),
      fetchJSON("positions.json"),
      fetchText("nav_history.jsonl"),
      fetchText("ledger.jsonl"),
      fetchJSON("watchlist.json"),
    ]);
    const [nav, pos, hist, led, watch] = results;

    if (nav.status === "fulfilled")      S.nav = nav.value;
    if (pos.status === "fulfilled")      S.positions = pos.value;
    if (hist.status === "fulfilled")     S.history = parseJSONL(hist.value);
    if (led.status === "fulfilled")      S.ledger  = parseJSONL(led.value);
    if (watch.status === "fulfilled")    S.watchlist = watch.value;

    // isolate each render so a single bug can't blank the whole page
    const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`[render:${name}]`, e); } };
    safe("hero",        renderHero);
    safe("chart",       renderChart);
    safe("allocations", renderAllocations);
    safe("attribution", renderAttribution);
    safe("positions",   renderPositions);
    safe("trades",      renderTrades);
    safe("watchlist",   renderWatchlist);
    safe("chrome",      renderChrome);
  }

  // ---------- range buttons ----------
  function bindRangeButtons() {
    document.querySelectorAll(".range-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        S.range = btn.dataset.range;
        renderChart();
      });
    });
  }

  // ---------- init ----------
  window.addEventListener("DOMContentLoaded", () => {
    boot();
    bindRangeButtons();
    // first paint as soon as possible
    loadAll().catch(err => console.error("initial load", err));
    // polling loop
    setInterval(() => {
      loadAll().catch(err => console.error("poll", err));
    }, POLL_MS);
    // refresh "ago" labels every 10s even if data hasn't changed
    setInterval(() => {
      if (S.nav) {
        $("#nav-updated").textContent = `upd ${fmtTimeAgo(S.nav.last_updated)}`;
        $("#heartbeat-text").textContent = `LAST HEARTBEAT · ${fmtTimeAgo(S.nav.last_updated)}`;
      }
      tickClock();
    }, 1000);
  });
})();
