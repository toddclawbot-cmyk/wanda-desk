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

  const $ = (sel) => document.querySelector(sel);

  // ---------- boot screen ----------
  const BOOT_LINES = [
    "WANDA // DESK  v1.0",
    "SYS_BOOT  ......................... OK",
    "LINK  pi@todd-pi  (192.168.1.16)  ... OK",
    "FETCH  nav.json / positions.json  .. OK",
    "STREAM  ledger.jsonl / nav_history  . OK",
    "RENDER  engaged.",
    "",
    "  >  welcome back, todd."
  ];
  function boot() {
    const el = $("#boot-text");
    let i = 0, j = 0, out = "";
    const tick = () => {
      if (i >= BOOT_LINES.length) {
        setTimeout(() => { $("#boot").classList.add("done"); }, 350);
        return;
      }
      const line = BOOT_LINES[i];
      if (j <= line.length) {
        out = BOOT_LINES.slice(0, i).join("\n") + (i ? "\n" : "") + line.slice(0, j) + "▊";
        el.textContent = out;
        j += 2;
        setTimeout(tick, 14);
      } else {
        i++; j = 0; setTimeout(tick, 40);
      }
    };
    tick();
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

    $("#stat-dd").textContent = `${fmtPct(S.nav.dd_pct ?? 0)}`;
    $("#stat-dd").classList.toggle("down", (S.nav.dd_pct ?? 0) < 0);

    const cashPct = S.nav.nav ? (S.nav.cash / S.nav.nav) * 100 : 0;
    $("#stat-cash").textContent = `${fmtUSD(S.nav.cash, 0)} · ${cashPct.toFixed(1)}%`;

    const posCount = (S.positions?.equity?.length || 0) + (S.positions?.crypto?.length || 0) + (S.positions?.options?.length || 0);
    $("#stat-positions").textContent = String(posCount);
    $("#positions-count").textContent = `${posCount} open`;

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
                return d.toUTCString().replace(" GMT", " UTC");
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
    const sumBy = (arr) => (arr || []).reduce((acc, p) => acc + (p.current_price * p.quantity || p.cost_basis || 0), 0);

    const classes = [
      { key: "EQUITY",  val: sumBy(S.positions.equity),  cap: CLASS_CAP * nav },
      { key: "CRYPTO",  val: sumBy(S.positions.crypto),  cap: CLASS_CAP * nav },
      { key: "OPTIONS", val: sumBy(S.positions.options), cap: CLASS_CAP * nav },
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

    // sort by % NAV desc
    rows.sort((a, b) => {
      const av = (a[1].current_price * a[1].quantity) / nav;
      const bv = (b[1].current_price * b[1].quantity) / nav;
      return bv - av;
    });

    for (const [cls, p] of rows) {
      const mv = (p.current_price ?? 0) * (p.quantity ?? 0);
      const navPct = (mv / nav) * 100;
      const pnl = p.unrealized_pnl ?? (mv - (p.cost_basis ?? 0));
      const up = pnl >= 0;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="ticker">${p.ticker}</td>
        <td class="class"><span class="cls-chip cls-${cls}">${cls.toUpperCase()}</span></td>
        <td class="num">${fmtNum(p.quantity, cls === "crypto" ? 5 : 2)}</td>
        <td class="num">${fmtUSD(p.avg_cost)}</td>
        <td class="num">${fmtUSD(p.current_price)}</td>
        <td class="num ${up ? "pnl up" : "pnl down"}">${fmtPct(p.pct_change ?? 0)}</td>
        <td class="num ${up ? "pnl up" : "pnl down"}">${fmtUSD(pnl)}</td>
        <td class="num">${navPct.toFixed(1)}%</td>
      `;
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
    for (const t of items) {
      const ts = t.timestamp || t.ts;
      const act = (t.action || "").toUpperCase();
      const why = t.reason || t.strategy || "";
      const qtyStr = t.quantity != null ? `${fmtNum(t.quantity, 5)} @ ${fmtUSD(t.price ?? t.exit_price ?? 0)}` : "";
      const li = document.createElement("li");
      li.className = "trade";
      li.innerHTML = `
        <span class="act act-${act}">${act}</span>
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
  function tickClock() {
    const d = new Date();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    $("#clock-val").textContent = `${hh}:${mm}:${ss}`;
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

    renderHero();
    renderChart();
    renderAllocations();
    renderPositions();
    renderTrades();
    renderWatchlist();
    renderChrome();
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
