/**
 * Trading Bot Dashboard — 3-Portfolio Mode
 * EMA+RSI | 3-Layer | MEGA — svaki portfolio $1000 start
 */

import "dotenv/config";
import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { run as botRun } from "./bot.js";

const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : ".");
const START_CAPITAL = 1000;

const PORTFOLIO_DEFS = [
  { id: "ema_rsi",     name: "EMA+RSI",  color: "#388bfd", emoji: "📊" },
  { id: "three_layer", name: "3-Layer",  color: "#bc8cff", emoji: "🔷" },
  { id: "mega",        name: "MEGA",     color: "#00c48c", emoji: "🚀" },
];

// ─── Auth ──────────────────────────────────────────────────────────────────────

const DASH_USER = process.env.DASH_USER || "buco25";
const DASH_PASS = process.env.DASH_PASS || "Din@mo2026";

function checkAuth(req, res) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Basic ")) {
    const [user, pass] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    if (user === DASH_USER && pass === DASH_PASS) return true;
  }
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Trading Bot Dashboard"', "Content-Type": "text/plain" });
  res.end("401 Unauthorized");
  return false;
}

// ─── Data loaders ──────────────────────────────────────────────────────────────

function loadRules() {
  try { return JSON.parse(readFileSync("rules.json", "utf8")); }
  catch { return {}; }
}

function loadPositions(pid) {
  const f = `${DATA_DIR}/open_positions_${pid}.json`;
  if (!existsSync(f)) return [];
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return []; }
}

function parseCsvFile(pid) {
  const f = `${DATA_DIR}/trades_${pid}.csv`;
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur); cur = ""; }
      else cur += ch;
    }
    vals.push(cur);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || "").trim(); });
    return obj;
  }).filter(r => r["Symbol"]);
}

function buildPortfolioStats(pid) {
  const rows  = parseCsvFile(pid);
  const exits = rows.filter(r => r["Side"] === "CLOSE_LONG" || r["Side"] === "CLOSE_SHORT");
  const entries= rows.filter(r => r["Side"] === "LONG" || r["Side"] === "SHORT");

  const wins     = exits.filter(r => parseFloat(r["Net P&L"] || 0) >= 0);
  const losses   = exits.filter(r => parseFloat(r["Net P&L"] || 0) < 0);
  const totalPnl = exits.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0);
  const winRate  = exits.length > 0 ? (wins.length / exits.length * 100).toFixed(1) : null;
  const equity   = START_CAPITAL + totalPnl;

  // P&L curve
  const pnlCurve = [];
  let running = START_CAPITAL;
  exits.forEach(r => {
    running += parseFloat(r["Net P&L"] || 0);
    pnlCurve.push({ ts: r["Date"] + " " + r["Time (UTC)"], equity: parseFloat(running.toFixed(4)) });
  });
  // Add start point
  if (pnlCurve.length === 0) pnlCurve.push({ ts: "start", equity: START_CAPITAL });

  // Recent 20 closed trades
  const recentExits = [...exits].reverse().slice(0, 20);

  return { pid, rows, exits, entries, wins, losses, totalPnl, winRate, equity, pnlCurve, recentExits };
}

async function fetchLivePrices(symbols) {
  const results = {};
  await Promise.all(symbols.map(async sym => {
    try {
      const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1m&limit=2`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.code === "00000" && d.data?.length) {
        const last = d.data[d.data.length - 1];
        results[sym] = parseFloat(last[4]);
      }
    } catch { /* ignore */ }
  }));
  return results;
}

// ─── HTML helpers ──────────────────────────────────────────────────────────────

function fmtP(v) {
  if (!v && v !== 0) return "—";
  if (v >= 1000) return "$" + v.toFixed(2);
  if (v >= 1)    return "$" + v.toFixed(4);
  if (v >= 0.001) return "$" + v.toFixed(6);
  return "$" + v.toFixed(10);
}

function pnlHtml(pnl) {
  const col = pnl > 0 ? "#00c48c" : pnl < 0 ? "#ff4d4d" : "#8b949e";
  return `<span style="color:${col}">${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}</span>`;
}

function renderHtml(allStats, allPositions, hb) {
  const hbAgeSec = hb ? Math.floor((Date.now() - new Date(hb.ts).getTime()) / 1000) : null;
  const hbOk     = hbAgeSec !== null && hbAgeSec < 600;
  const hbLabel  = hb ? (hbAgeSec < 60 ? `${hbAgeSec}s ago` : `${Math.floor(hbAgeSec/60)}m ago`) : "never";
  const hbBadge  = hbOk
    ? `<span class="badge green-badge">🟢 Bot ${hbLabel}</span>`
    : `<span class="badge red-badge">🔴 Bot ${hb ? hbLabel + " — STAO!" : "nikad nije radio"}</span>`;
  const modeLbl  = process.env.PAPER_TRADING !== "false" ? "PAPER" : process.env.BITGET_DEMO === "true" ? "DEMO" : "LIVE";

  // Collect all symbols for live price polling
  const allSymbols = new Set();
  allPositions.forEach(posList => posList.forEach(p => allSymbols.add(p.symbol)));

  // Equity chart data
  const chartColors = { ema_rsi: "#388bfd", three_layer: "#bc8cff", mega: "#00c48c" };
  const chartDatasets = allStats.map(s => {
    const def = PORTFOLIO_DEFS.find(d => d.id === s.pid);
    return JSON.stringify({
      label: def.name,
      data: s.pnlCurve.map((p, i) => ({ x: i, y: p.equity })),
      borderColor: def.color,
      backgroundColor: def.color + "22",
      fill: false,
      tension: 0.3,
      pointRadius: 2,
    });
  });

  // Portfolio comparison cards
  const cardsHtml = PORTFOLIO_DEFS.map((def, i) => {
    const s      = allStats[i];
    const pcts   = ((s.equity - START_CAPITAL) / START_CAPITAL * 100);
    const pctStr = (pcts >= 0 ? "+" : "") + pcts.toFixed(2) + "%";
    const eqCol  = s.equity >= START_CAPITAL ? "#00c48c" : "#ff4d4d";
    const openCount = allPositions[i].length;
    return `
    <div class="port-card" style="border-top:3px solid ${def.color}">
      <div class="port-header">
        <span style="font-size:22px">${def.emoji}</span>
        <div>
          <div class="port-name" style="color:${def.color}">${def.name}</div>
          <div class="port-subtitle">Portfolio ${i + 1} · 1H · SL 2% / TP 4%</div>
        </div>
      </div>
      <div class="port-equity" style="color:${eqCol}">$${s.equity.toFixed(2)}</div>
      <div class="port-return" style="color:${eqCol}">${pctStr}</div>
      <div class="port-row"><span class="muted">Start</span><span>$${START_CAPITAL.toFixed(0)}</span></div>
      <div class="port-row"><span class="muted">P&amp;L</span><span>${pnlHtml(s.totalPnl)}</span></div>
      <div class="port-row"><span class="muted">Trades</span><span>${s.exits.length}</span></div>
      <div class="port-row"><span class="muted">Win Rate</span><span>${s.winRate !== null ? s.winRate + "%" : "—"}</span></div>
      <div class="port-row"><span class="muted">Otvoreno</span><span>${openCount} pozicija</span></div>
    </div>`;
  }).join("");

  // Open positions per portfolio
  const positionsSections = PORTFOLIO_DEFS.map((def, i) => {
    const positions = allPositions[i];
    if (positions.length === 0)
      return `<div class="section-label" style="color:${def.color}">${def.name} — nema otvorenih pozicija</div>`;

    const posHtml = positions.map(p => {
      const isLong = p.side === "LONG";
      return `
        <div class="pos-card ${isLong ? "pos-long" : "pos-short"}" id="pos-${def.id}-${p.symbol}">
          <div class="pos-header">
            <span class="symbol">${p.symbol}</span>
            <span class="badge ${isLong ? "badge-long" : "badge-short"}">${p.side}</span>
            <span class="badge badge-paper">${p.mode}</span>
            <span id="lp-${def.id}-${p.symbol}" style="margin-left:auto;font-size:13px;font-weight:700;color:var(--text-muted)">—</span>
          </div>
          <div class="pos-grid">
            <div><label>Entry</label><span>${fmtP(p.entryPrice)}</span></div>
            <div><label>SL</label><span class="red">${fmtP(p.sl)}</span></div>
            <div><label>TP</label><span class="green">${fmtP(p.tp)}</span></div>
            <div><label>Notional</label><span>$${p.totalUSD.toFixed(2)}</span></div>
            <div><label>Qty</label><span>${p.quantity.toFixed(4)}</span></div>
            <div><label>Otvoreno</label><span>${(p.openedAt || "").slice(0,16).replace("T"," ")}</span></div>
          </div>
          <div class="pos-pnl-row">
            <div id="pnl-${def.id}-${p.symbol}" style="font-size:14px;font-weight:700;color:#8b949e">—</div>
            <div style="flex:1;min-width:0">
              <div class="range-bar"><div id="bar-${def.id}-${p.symbol}" class="range-fill"></div></div>
              <div class="range-labels"><small>SL ${fmtP(p.sl)}</small><small>TP ${fmtP(p.tp)}</small></div>
            </div>
          </div>
          <script>
          (function(){
            const sym="${p.symbol}", side="${p.side}", pid="${def.id}";
            const entry=${p.entryPrice}, qty=${p.quantity}, notional=${p.totalUSD};
            const sl=${p.sl}, tp=${p.tp};
            function fmtLive(v){if(v>=1000)return "$"+v.toFixed(2);if(v>=1)return "$"+v.toFixed(4);if(v>=0.001)return "$"+v.toFixed(6);return "$"+v.toFixed(10);}
            function update(price){
              document.getElementById("lp-"+pid+"-"+sym).textContent=fmtLive(price);
              const pnl=side==="LONG"?(price-entry)*qty:(entry-price)*qty;
              const pct=(pnl/notional*100).toFixed(2);
              const el=document.getElementById("pnl-"+pid+"-"+sym);
              el.textContent=(pnl>=0?"+":"")+"$"+pnl.toFixed(4)+" ("+pct+"%)";
              el.style.color=pnl>=0?"#00c48c":"#ff4d4d";
              const range=Math.abs(tp-sl);
              const pos2=side==="LONG"?(price-sl)/range:(sl-price)/range;
              const pct2=Math.max(0,Math.min(100,pos2*100));
              const bar=document.getElementById("bar-"+pid+"-"+sym);
              bar.style.width=pct2+"%";bar.style.background=pnl>=0?"#00c48c":"#ff4d4d";
            }
            async function poll(){try{const r=await fetch("/api/live?sym="+sym);const d=await r.json();if(d.price)update(d.price);}catch{}}
            poll(); setInterval(poll,15000);
          })();
          </script>
        </div>`;
    }).join("");

    return `
      <div class="section-label" style="color:${def.color}">${def.emoji} ${def.name} — Otvorene pozicije (${positions.length})</div>
      <div class="pos-grid-wrap">${posHtml}</div>`;
  }).join("\n");

  // Closed trades tables per portfolio
  const tradesSections = PORTFOLIO_DEFS.map((def, i) => {
    const s = allStats[i];
    if (s.recentExits.length === 0)
      return `<div class="section-label" style="color:${def.color}">${def.name} — nema zatvorenih tradova</div>`;

    const rows = s.recentExits.map(r => {
      const pnl = parseFloat(r["Net P&L"] || 0);
      const win = pnl >= 0;
      return `<tr class="${win ? "win-row" : "loss-row"}">
        <td>${r["Date"] || ""}</td>
        <td style="font-weight:700">${r["Symbol"] || ""}</td>
        <td><span class="badge ${r["Side"].includes("LONG") ? "badge-long" : "badge-short"}">${r["Side"]?.replace("CLOSE_","") || ""}</span></td>
        <td>${r["Price"] || ""}</td>
        <td style="color:${win?"#00c48c":"#ff4d4d"};font-weight:700">${win?"+":""}$${pnl.toFixed(4)}</td>
        <td>${r["Notes"]?.replace(/"/g,"").split("|")[0].trim() || ""}</td>
      </tr>`;
    }).join("");

    return `
      <div class="section-label" style="color:${def.color}">${def.emoji} ${def.name} — Zadnjih ${s.recentExits.length} tradova</div>
      <div class="table-wrap">
        <table class="trade-table">
          <thead><tr><th>Datum</th><th>Symbol</th><th>Side</th><th>Cijena</th><th>P&amp;L</th><th>Info</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Trading Bot — 3 Portfolia</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg-primary:   #0d1117;
    --bg-secondary: #161b22;
    --bg-tertiary:  #21262d;
    --border:       #30363d;
    --text-primary: #e6edf3;
    --text-muted:   #8b949e;
    --green:        #00c48c;
    --red:          #ff4d4d;
    --blue:         #388bfd;
    --purple:       #bc8cff;
  }
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:var(--bg-primary); color:var(--text-primary); min-height:100vh; }
  a { color:var(--blue); text-decoration:none; }
  .top-bar { height:3px; background:linear-gradient(90deg,var(--blue),var(--purple),var(--green)); }
  .page-wrap { max-width:1400px; margin:0 auto; padding:24px 20px 60px; }
  .header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:28px; }
  .header-left { display:flex; align-items:center; gap:12px; }
  .logo { font-size:22px; filter:drop-shadow(0 0 8px rgba(0,196,140,0.6)); }
  .title { font-size:20px; font-weight:700; }
  .subtitle { font-size:13px; color:var(--text-muted); margin-top:2px; }
  .badge { display:inline-flex; align-items:center; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:600; white-space:nowrap; }
  .green-badge { background:rgba(0,196,140,0.15); color:var(--green); border:1px solid var(--green); }
  .red-badge   { background:rgba(255,77,77,0.15);  color:var(--red);   border:1px solid var(--red); }
  .badge-paper { background:rgba(56,139,253,0.15); color:var(--blue);  border:1px solid var(--blue); font-size:11px; padding:2px 8px; }
  .badge-long  { background:rgba(0,196,140,0.2);   color:var(--green); border:1px solid var(--green); font-size:11px; padding:2px 8px; }
  .badge-short { background:rgba(255,77,77,0.2);   color:var(--red);   border:1px solid var(--red);  font-size:11px; padding:2px 8px; }
  .muted { color:var(--text-muted); }
  .red   { color:var(--red); }
  .green { color:var(--green); }

  /* Portfolio cards */
  .port-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:32px; }
  @media(max-width:900px){ .port-grid { grid-template-columns:1fr; } }
  .port-card { background:var(--bg-secondary); border-radius:12px; padding:20px; border:1px solid var(--border); }
  .port-header { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
  .port-name { font-size:16px; font-weight:700; }
  .port-subtitle { font-size:11px; color:var(--text-muted); }
  .port-equity { font-size:28px; font-weight:800; margin-bottom:4px; }
  .port-return { font-size:14px; font-weight:600; margin-bottom:16px; }
  .port-row { display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid var(--border); font-size:13px; }
  .port-row:last-child { border:none; }

  /* Chart */
  .chart-card { background:var(--bg-secondary); border-radius:12px; padding:20px; border:1px solid var(--border); margin-bottom:32px; }
  .chart-title { font-size:14px; font-weight:700; margin-bottom:16px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; }
  .chart-wrap { position:relative; height:220px; }

  /* Positions */
  .section-label { font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; margin:28px 0 12px; padding-bottom:8px; border-bottom:1px solid var(--border); }
  .pos-grid-wrap { display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:14px; margin-bottom:8px; }
  .pos-card { background:var(--bg-secondary); border-radius:10px; padding:16px; border:1px solid var(--border); }
  .pos-long  { border-left:3px solid var(--green); }
  .pos-short { border-left:3px solid var(--red); }
  .pos-header { display:flex; align-items:center; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
  .symbol { font-size:15px; font-weight:700; }
  .pos-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:12px; }
  .pos-grid label { display:block; font-size:10px; color:var(--text-muted); text-transform:uppercase; margin-bottom:2px; }
  .pos-grid span { font-size:12px; font-weight:600; }
  .pos-pnl-row { display:flex; align-items:center; gap:12px; }
  .range-bar { height:4px; background:var(--bg-tertiary); border-radius:2px; overflow:hidden; margin-bottom:4px; }
  .range-fill { height:100%; width:0%; border-radius:2px; transition:width .3s,background .3s; }
  .range-labels { display:flex; justify-content:space-between; font-size:10px; color:var(--text-muted); }

  /* Trades table */
  .table-wrap { overflow-x:auto; margin-bottom:8px; }
  .trade-table { width:100%; border-collapse:collapse; font-size:13px; }
  .trade-table th { padding:8px 12px; text-align:left; color:var(--text-muted); font-weight:600; font-size:11px; text-transform:uppercase; border-bottom:2px solid var(--border); }
  .trade-table td { padding:8px 12px; border-bottom:1px solid var(--border); }
  .win-row td  { background:rgba(0,196,140,0.03); }
  .loss-row td { background:rgba(255,77,77,0.03); }
  .trade-table tbody tr:hover td { background:var(--bg-tertiary); }

  /* Footer */
  .footer { text-align:center; padding:24px; color:var(--text-muted); font-size:12px; border-top:1px solid var(--border); margin-top:40px; }
</style>
</head>
<body>
<div class="top-bar"></div>
<div class="page-wrap">

  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <div class="logo">🤖</div>
      <div>
        <div class="title">Trading Bot — 3 Portfolia</div>
        <div class="subtitle">EMA+RSI · 3-Layer · MEGA &nbsp;|&nbsp; 1H · SL 2% / TP 4% · 15x</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      ${hbBadge}
      <span class="badge badge-paper">${modeLbl}</span>
    </div>
  </div>

  <!-- Portfolio comparison cards -->
  <div class="port-grid">
    ${cardsHtml}
  </div>

  <!-- Equity chart -->
  <div class="chart-card">
    <div class="chart-title">Equity krivulja — usporedba portfolia</div>
    <div class="chart-wrap"><canvas id="equityChart"></canvas></div>
  </div>

  <!-- Open positions -->
  ${positionsSections}

  <!-- Closed trades -->
  <div style="margin-top:40px">
    ${tradesSections}
  </div>

</div>

<div class="footer">
  Auto-refresh svakih 30s &nbsp;|&nbsp; ${new Date().toISOString().slice(0,16).replace("T"," ")} UTC
</div>

<script>
// Equity chart
(function(){
  const ctx = document.getElementById("equityChart").getContext("2d");
  const datasets = [${chartDatasets.join(",")}];
  new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#e6edf3", boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ": $" + ctx.raw.y.toFixed(2)
          }
        }
      },
      scales: {
        x: { display: false },
        y: {
          ticks: { color: "#8b949e", callback: v => "$" + v.toFixed(0) },
          grid:  { color: "#21262d" }
        }
      }
    }
  });
})();
</script>

</body>
</html>`;
}

// ─── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Health — bez auth
  if (url.pathname === "/health") {
    const hbFile = `${DATA_DIR}/heartbeat.json`;
    const hb     = existsSync(hbFile) ? JSON.parse(readFileSync(hbFile, "utf8")) : null;
    const ageSec = hb ? Math.floor((Date.now() - new Date(hb.ts).getTime()) / 1000) : null;
    const ok     = ageSec !== null && ageSec < 600;
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: ok ? "ok" : "stale", bot: hb, ageSec, dashboard: "ok" }));
    return;
  }

  // Live price — bez auth
  if (url.pathname === "/api/live") {
    const sym    = url.searchParams.get("sym") || "BTCUSDT";
    const prices = await fetchLivePrices([sym]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ symbol: sym, price: prices[sym] || null }));
    return;
  }

  // Sve ostalo — auth
  if (!checkAuth(req, res)) return;

  // Reset positions
  if (url.pathname === "/api/reset-positions" && req.method === "POST") {
    for (const def of PORTFOLIO_DEFS) {
      writeFileSync(`${DATA_DIR}/open_positions_${def.id}.json`, "[]");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "Sve 3 portfolia resetirana", timestamp: new Date().toISOString() }));
    return;
  }

  // Positions API
  if (url.pathname === "/api/positions") {
    const pid = url.searchParams.get("pid");
    if (pid) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(loadPositions(pid)));
    } else {
      const all = {};
      PORTFOLIO_DEFS.forEach(d => { all[d.id] = loadPositions(d.id); });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(all));
    }
    return;
  }

  // Portfolio stats API
  if (url.pathname === "/api/portfolios") {
    const stats = PORTFOLIO_DEFS.map(d => buildPortfolioStats(d.id));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
    return;
  }

  // Debug
  if (url.pathname === "/api/debug") {
    const info = PORTFOLIO_DEFS.map(d => {
      const f = `${DATA_DIR}/open_positions_${d.id}.json`;
      const c = `${DATA_DIR}/trades_${d.id}.csv`;
      return {
        portfolio: d.id,
        posFile: f,
        posExists: existsSync(f),
        openPositions: existsSync(f) ? JSON.parse(readFileSync(f,"utf8")).length : 0,
        csvExists: existsSync(c),
        csvLines: existsSync(c) ? readFileSync(c,"utf8").trim().split("\n").length : 0,
      };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ DATA_DIR, info }));
    return;
  }

  // Dashboard HTML
  const allStats     = PORTFOLIO_DEFS.map(d => buildPortfolioStats(d.id));
  const allPositions = PORTFOLIO_DEFS.map(d => loadPositions(d.id));
  const hbFile       = `${DATA_DIR}/heartbeat.json`;
  const hb           = existsSync(hbFile) ? JSON.parse(readFileSync(hbFile, "utf8")) : null;
  const html         = renderHtml(allStats, allPositions, hb);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

// ─── Bot scheduler (svakih 5 min) ─────────────────────────────────────────────

let botRunning = false;
async function scheduledRun() {
  if (botRunning) return;
  botRunning = true;
  try { await botRun(); }
  catch (e) { console.error("Bot scheduler greška:", e.message); }
  finally { botRunning = false; }
}

server.listen(PORT, () => {
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`⚙️  Bot scheduler aktivan (svake 5 min)`);
  scheduledRun();
  setInterval(scheduledRun, 5 * 60 * 1000);
});
