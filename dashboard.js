/**
 * Trading Bot Dashboard — lokalni HTTP server
 * Pokreni: node dashboard.js
 * Otvori:  http://localhost:3000
 */

import "dotenv/config";
import http from "http";
import { readFileSync, existsSync } from "fs";

const PORT = 3000;

// ─── Parse CSV ────────────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const result = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur); cur = ""; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function parseCsv() {
  if (!existsSync("trades.csv")) return [];
  const lines = readFileSync("trades.csv", "utf8").trim().split("\n");
  const headers = parseCsvLine(lines[0]);
  return lines.slice(2).map(line => {
    const vals = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || "").trim(); });
    return obj;
  }).filter(r => r["Symbol"]);
}

function loadPositions() {
  if (!existsSync("open_positions.json")) return [];
  try { return JSON.parse(readFileSync("open_positions.json", "utf8")); }
  catch { return []; }
}

// ─── Live Prices (BitGet public API) ─────────────────────────────────────────

async function fetchLivePrices(symbols) {
  const results = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1m&limit=2`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.code === "00000" && d.data?.length) {
        // BitGet vraća oldest→newest, zadnji element je najnoviji
        const last = d.data[d.data.length - 1];
        results[sym] = parseFloat(last[4]); // close
      }
    } catch { /* ignore */ }
  }));
  return results;
}

// ─── API handlers ─────────────────────────────────────────────────────────────

function apiTrades() {
  const STARTING_CAPITAL = parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000");
  const rows    = parseCsv();
  const exits   = rows.filter(r => r["Side"] === "CLOSE_LONG" || r["Side"] === "CLOSE_SHORT");
  const entries = rows.filter(r => r["Side"] === "LONG" || r["Side"] === "SHORT");
  const blocked = rows.filter(r => r["Mode"] === "BLOCKED");

  const wins     = exits.filter(r => parseFloat(r["Net P&L"] || 0) >= 0);
  const losses   = exits.filter(r => parseFloat(r["Net P&L"] || 0) < 0);
  const totalPnl = exits.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0);
  const winRate  = exits.length > 0 ? (wins.length / exits.length * 100).toFixed(1) : null;
  const portfolio = STARTING_CAPITAL + totalPnl;

  // P&L over time (za chart)
  const pnlSeries = [];
  let running = 0;
  exits.forEach(r => {
    running += parseFloat(r["Net P&L"] || 0);
    pnlSeries.push({ date: r["Date"] + " " + r["Time (UTC)"], pnl: parseFloat((STARTING_CAPITAL + running).toFixed(4)) });
  });

  // Periodični P&L
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now - 7 * 864e5).toISOString().slice(0, 10);
  const monthStr = now.toISOString().slice(0, 7); // "2026-04"

  function periodPnl(filterFn) {
    const filtered = exits.filter(filterFn);
    const pnl = filtered.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0);
    const w = filtered.filter(r => parseFloat(r["Net P&L"] || 0) >= 0).length;
    const l = filtered.filter(r => parseFloat(r["Net P&L"] || 0) < 0).length;
    return { pnl, wins: w, losses: l, count: filtered.length };
  }

  const daily   = periodPnl(r => r["Date"] === today);
  const weekly  = periodPnl(r => r["Date"] >= weekAgo);
  const monthly = periodPnl(r => (r["Date"] || "").startsWith(monthStr));

  // Greške
  const errors = rows.filter(r => (r["Notes"] || "").toLowerCase().includes("greška") || (r["Notes"] || "").toLowerCase().includes("error"));

  // Zadnjih 20 blokiranih
  const recentBlocked = [...blocked].reverse().slice(0, 20);

  return { rows, exits, entries, blocked, recentBlocked, errors, wins, losses, totalPnl, winRate, pnlSeries, portfolio, STARTING_CAPITAL, daily, weekly, monthly };
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function pnlBadge(pnl) {
  if (pnl === 0) return `<span style="color:#8b949e">$0.00</span>`;
  const col = pnl > 0 ? "#00c48c" : "#ff4d4d";
  return `<span style="color:${col}">${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}</span>`;
}

function renderHtml(data, positions) {
  const { exits, entries, blocked, recentBlocked, errors, wins, losses, totalPnl, winRate, pnlSeries, portfolio, STARTING_CAPITAL, daily, weekly, monthly } = data;
  const pnlColor   = totalPnl >= 0 ? "#00c48c" : "#ff4d4d";
  const portColor  = portfolio >= STARTING_CAPITAL ? "#00c48c" : "#ff4d4d";
  const portPct    = ((portfolio - STARTING_CAPITAL) / STARTING_CAPITAL * 100).toFixed(2);
  const modeLabel  = process.env.PAPER_TRADING !== "false" ? "PAPER" : process.env.BITGET_DEMO === "true" ? "DEMO" : "LIVE";
  const modeBadge  = modeLabel === "PAPER" ? "#888" : modeLabel === "DEMO" ? "#f0a500" : "#ff4d4d";

  const recentExits = [...exits].reverse().slice(0, 15);

  const positionsHtml = positions.length === 0
    ? `<p class="muted">Nema otvorenih pozicija.</p>`
    : positions.map(p => `
      <div class="pos-card" id="pos-${p.symbol}">
        <div class="pos-header">
          <span class="symbol">${p.symbol}</span>
          <span class="badge ${p.side === 'LONG' ? 'long' : 'short'}">${p.side}</span>
          <span class="badge demo">${p.mode}</span>
          <span class="live-price" id="price-${p.symbol}" style="margin-left:auto;font-size:14px;font-weight:700;color:#8b949e">—</span>
        </div>
        <div class="pos-grid">
          <div><label>Ulaz</label><span>${fmtP(p.entryPrice)}</span></div>
          <div><label>SL</label><span class="red">${fmtP(p.sl)}</span></div>
          <div><label>TP</label><span class="green">${fmtP(p.tp)}</span></div>
          <div><label>Notional</label><span>$${p.totalUSD.toFixed(2)}</span></div>
          <div><label>Qty</label><span>${p.quantity.toFixed(4)}</span></div>
          <div><label>Otvoreno</label><span>${p.openedAt.slice(0,16).replace("T"," ")}</span></div>
        </div>
        <div style="margin-top:10px;display:flex;gap:20px;align-items:center">
          <div><label style="font-size:11px;color:#8b949e">Unrealized P&L</label>
            <div id="pnl-${p.symbol}" style="font-size:16px;font-weight:700;color:#8b949e">—</div>
          </div>
          <div style="flex:1">
            <div style="height:4px;background:#21262d;border-radius:2px;overflow:hidden">
              <div id="bar-${p.symbol}" style="height:100%;width:50%;background:#8b949e;transition:width .3s,background .3s"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:3px">
              <small>SL ${fmtP(p.sl)}</small><small>TP ${fmtP(p.tp)}</small>
            </div>
          </div>
        </div>
        <script>
        (function(){
          const sym="${p.symbol}", side="${p.side}";
          const entry=${p.entryPrice}, qty=${p.quantity}, notional=${p.totalUSD};
          const sl=${p.sl}, tp=${p.tp};
          function fmtLive(v){
            if(v>=1000) return "$"+v.toFixed(2);
            if(v>=1)    return "$"+v.toFixed(4);
            if(v>=0.001) return "$"+v.toFixed(6);
            return "$"+v.toFixed(10);
          }
          function update(price){
            document.getElementById("price-"+sym).textContent = fmtLive(price);
            const pnl = side==="LONG" ? (price-entry)*qty : (entry-price)*qty;
            const pct = (pnl/notional*100).toFixed(2);
            const el = document.getElementById("pnl-"+sym);
            el.textContent = (pnl>=0?"+":"")+"$"+pnl.toFixed(4)+" ("+pct+"%)";
            el.style.color = pnl>=0?"#00c48c":"#ff4d4d";
            // Progress bar (SL=0%, TP=100%)
            const range = Math.abs(tp-sl);
            const pos = side==="LONG" ? (price-sl)/range : (sl-price)/range;
            const pct2 = Math.max(0,Math.min(100,pos*100));
            const bar = document.getElementById("bar-"+sym);
            bar.style.width = pct2+"%";
            bar.style.background = pnl>=0?"#00c48c":"#ff4d4d";
          }
          async function poll(){
            try{
              const r = await fetch("/api/live?sym="+sym);
              const d = await r.json();
              if(d.price) update(d.price);
            }catch{}
          }
          poll();
          setInterval(poll, 15000);
        })();
        </script>
      </div>`).join("");

  const tradesHtml = recentExits.map(r => {
    const pnl = parseFloat(r["Net P&L"] || 0);
    const isWin = pnl >= 0;
    return `<tr class="${isWin ? 'win' : 'loss'}">
      <td>${r["Date"]}<br><small>${r["Time (UTC)"]}</small></td>
      <td><strong>${r["Symbol"]}</strong></td>
      <td><span class="badge ${r["Side"].includes("LONG") ? "long" : "short"}">${r["Side"].replace("CLOSE_","")}</span></td>
      <td>${fmtP(parseFloat(r["Price"] || 0))}</td>
      <td class="${isWin ? 'green' : 'red'}">${isWin ? "+" : ""}$${pnl.toFixed(4)}</td>
      <td><span class="badge ${r["Mode"] === 'LIVE' ? 'live' : r['Mode'] === 'DEMO' ? 'demo' : 'paper'}">${r["Mode"]}</span></td>
    </tr>`;
  }).join("");

  const chartData = JSON.stringify(pnlSeries);

  return `<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Trading Bot Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;padding:24px}
  h1{font-size:22px;font-weight:700;color:#fff}
  h2{font-size:15px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
  .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
  .header-left{display:flex;align-items:center;gap:12px}
  .mode-badge{padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;color:#fff;background:${modeBadge}}
  .refresh{font-size:12px;color:#8b949e}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:28px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px}
  .card label{font-size:12px;color:#8b949e;display:block;margin-bottom:6px}
  .card .value{font-size:26px;font-weight:700}
  .card .value.green{color:#00c48c}
  .card .value.red{color:#ff4d4d}
  .card .value.neutral{color:#e6edf3}
  .section{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:20px}
  .pos-card{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:10px}
  .pos-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .symbol{font-weight:700;font-size:16px}
  .pos-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .pos-grid label{font-size:11px;color:#8b949e;display:block}
  .pos-grid span{font-size:13px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 12px;color:#8b949e;border-bottom:1px solid #30363d;font-weight:600;font-size:12px}
  td{padding:10px 12px;border-bottom:1px solid #21262d}
  tr.win td{background:rgba(0,196,140,.04)}
  tr.loss td{background:rgba(255,77,77,.04)}
  tr:last-child td{border-bottom:none}
  .badge{padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700}
  .badge.long{background:rgba(0,196,140,.15);color:#00c48c}
  .badge.short{background:rgba(255,77,77,.15);color:#ff4d4d}
  .badge.demo{background:rgba(240,165,0,.15);color:#f0a500}
  .badge.live{background:rgba(255,77,77,.15);color:#ff4d4d}
  .badge.paper{background:rgba(139,148,158,.15);color:#8b949e}
  .badge.blocked{background:rgba(139,148,158,.1);color:#8b949e}
  .badge.error{background:rgba(255,77,77,.15);color:#ff4d4d}
  .green{color:#00c48c}
  .red{color:#ff4d4d}
  .muted{color:#8b949e;font-size:14px}
  small{color:#8b949e;font-size:11px}
  canvas{max-height:180px}
  .tabs{display:flex;gap:8px;margin-bottom:16px}
  .tab{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid #30363d;background:transparent;color:#8b949e}
  .tab.active{background:#21262d;color:#e6edf3;border-color:#8b949e}
  .tab-content{display:none}.tab-content.active{display:block}
  .block-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid #21262d;font-size:13px}
  .block-row:last-child{border-bottom:none}
  .block-time{color:#8b949e;min-width:140px;font-size:12px}
  .block-reason{color:#8b949e;flex:1}
  .error-row{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #21262d;font-size:13px}
  .error-row:last-child{border-bottom:none}
  .error-msg{color:#ff4d4d;flex:1}
  .portfolio-bar{display:flex;align-items:center;gap:16px;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px 24px;margin-bottom:20px}
  .port-value{font-size:36px;font-weight:800;letter-spacing:-1px}
  .port-meta{font-size:13px;color:#8b949e;margin-top:2px}
  .period-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
  .period-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px}
  .period-card h3{font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
  .period-pnl{font-size:22px;font-weight:700;margin-bottom:4px}
  .period-sub{font-size:12px;color:#8b949e}
  @media(max-width:600px){.period-grid{grid-template-columns:1fr}.portfolio-bar{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1>Trading Bot</h1>
    <span class="mode-badge">${modeLabel}</span>
    <span style="padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;background:#1f3a5f;color:#58a6ff">${process.env.TIMEFRAME || "1H"}</span>
    <span style="font-size:12px;color:#8b949e">Fib Golden Pocket · BitGet Futures</span>
  </div>
  <span class="refresh">Auto-refresh svake minute • ${new Date().toISOString().slice(0,19).replace("T"," ")} UTC</span>
</div>

<!-- Portfolio stanje -->
<div class="portfolio-bar">
  <div>
    <div style="font-size:12px;color:#8b949e;margin-bottom:4px">STANJE PORTFOLIA</div>
    <div class="port-value" style="color:${portColor}">$${portfolio.toFixed(2)}</div>
    <div class="port-meta">Početni kapital: $${STARTING_CAPITAL.toFixed(2)} &nbsp;|&nbsp; Ukupni P&L: <span style="color:${pnlColor}">${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}</span> &nbsp;|&nbsp; <span style="color:${portColor}">${portPct >= 0 ? "+" : ""}${portPct}%</span></div>
  </div>
  <div style="margin-left:auto;text-align:right">
    <div style="font-size:12px;color:#8b949e;margin-bottom:4px">WIN RATE</div>
    <div style="font-size:28px;font-weight:700;color:#e6edf3">${winRate !== null ? winRate + "%" : "—"}</div>
    <div style="font-size:12px;color:#8b949e"><span class="green">${wins.length}W</span> / <span class="red">${losses.length}L</span> &nbsp;|&nbsp; ${exits.length} zatvorenih</div>
  </div>
</div>

<!-- Dnevni / Tjedni / Mjesečni -->
<div class="period-grid">
  <div class="period-card">
    <h3>📅 Danas</h3>
    <div class="period-pnl" style="color:${daily.pnl >= 0 ? '#00c48c' : daily.pnl < 0 ? '#ff4d4d' : '#8b949e'}">${daily.count === 0 ? '—' : (daily.pnl >= 0 ? "+" : "") + "$" + daily.pnl.toFixed(2)}</div>
    <div class="period-sub">${daily.count} tradova &nbsp;·&nbsp; <span class="green">${daily.wins}W</span> <span class="red">${daily.losses}L</span></div>
  </div>
  <div class="period-card">
    <h3>📆 Ovaj tjedan</h3>
    <div class="period-pnl" style="color:${weekly.pnl >= 0 ? '#00c48c' : weekly.pnl < 0 ? '#ff4d4d' : '#8b949e'}">${weekly.count === 0 ? '—' : (weekly.pnl >= 0 ? "+" : "") + "$" + weekly.pnl.toFixed(2)}</div>
    <div class="period-sub">${weekly.count} tradova &nbsp;·&nbsp; <span class="green">${weekly.wins}W</span> <span class="red">${weekly.losses}L</span></div>
  </div>
  <div class="period-card">
    <h3>🗓️ Ovaj mjesec</h3>
    <div class="period-pnl" style="color:${monthly.pnl >= 0 ? '#00c48c' : monthly.pnl < 0 ? '#ff4d4d' : '#8b949e'}">${monthly.count === 0 ? '—' : (monthly.pnl >= 0 ? "+" : "") + "$" + monthly.pnl.toFixed(2)}</div>
    <div class="period-sub">${monthly.count} tradova &nbsp;·&nbsp; <span class="green">${monthly.wins}W</span> <span class="red">${monthly.losses}L</span></div>
  </div>
</div>

<!-- Mini kartice -->
<div class="cards">
  <div class="card">
    <label>Otvorene pozicije</label>
    <div class="value neutral">${positions.length}</div>
  </div>
  <div class="card">
    <label>Blokirani signali</label>
    <div class="value neutral">${blocked.length}</div>
  </div>
  <div class="card">
    <label>Ukupno skeniranja</label>
    <div class="value neutral">${entries.length + blocked.length}</div>
  </div>
</div>

${pnlSeries.length > 1 ? `
<div class="section">
  <h2>Rast portfolia ($)</h2>
  <canvas id="chart"></canvas>
</div>` : ""}

<div class="section">
  <h2>Otvorene pozicije (${positions.length})</h2>
  ${positionsHtml}
</div>

<div class="section">
  <div class="tabs">
    <button class="tab active" onclick="showTab('closed')">Zatvoreni (${exits.length})</button>
    <button class="tab" onclick="showTab('blocked')">Blokirani (${blocked.length})</button>
    <button class="tab" onclick="showTab('errors')" style="${errors.length > 0 ? 'color:#ff4d4d;border-color:#ff4d4d' : ''}">Greške (${errors.length})</button>
  </div>

  <div id="tab-closed" class="tab-content active">
    ${exits.length === 0 ? '<p class="muted">Još nema zatvorenih tradova.</p>' : `
    <table>
      <thead><tr><th>Datum/Vrijeme</th><th>Par</th><th>Smjer</th><th>Cijena</th><th>P&L</th><th>Mod</th></tr></thead>
      <tbody>${tradesHtml}</tbody>
    </table>`}
  </div>

  <div id="tab-blocked" class="tab-content">
    ${recentBlocked.length === 0 ? '<p class="muted">Nema blokiranih signala.</p>' : recentBlocked.map(r => `
      <div class="block-row">
        <span class="block-time">${r["Date"]} ${r["Time (UTC)"]}</span>
        <strong style="min-width:90px">${r["Symbol"]}</strong>
        <span class="block-reason">${r["Notes"] || "—"}</span>
      </div>`).join("")}
  </div>

  <div id="tab-errors" class="tab-content">
    ${errors.length === 0 ? '<p class="muted" style="color:#00c48c">✅ Nema grešaka.</p>' : errors.map(r => `
      <div class="error-row">
        <span class="block-time">${r["Date"]} ${r["Time (UTC)"]}</span>
        <strong style="min-width:90px">${r["Symbol"]}</strong>
        <span class="error-msg">${r["Notes"] || "—"}</span>
      </div>`).join("")}
  </div>
</div>

<script>
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.target.classList.add('active');
}
</script>

${pnlSeries.length > 1 ? `
<script>
const raw = ${chartData};
const ctx = document.getElementById('chart').getContext('2d');
new Chart(ctx, {
  type: 'line',
  data: {
    labels: raw.map(d => d.date),
    datasets: [{
      label: 'Kumulativni P&L ($)',
      data: raw.map(d => d.pnl),
      borderColor: '${pnlColor}',
      backgroundColor: '${pnlColor}22',
      borderWidth: 2,
      fill: true,
      tension: 0.3,
      pointRadius: 4,
      pointBackgroundColor: '${pnlColor}',
    }]
  },
  options: {
    responsive: true,
    plugins: { legend: { labels: { color: '#8b949e' } } },
    scales: {
      x: { ticks: { color: '#8b949e', maxTicksLimit: 8 }, grid: { color: '#21262d' } },
      y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
    }
  }
});
</script>` : ""}

</body></html>`;
}

function fmtP(price) {
  if (!price && price !== 0) return "";
  if (price >= 1000)  return "$" + price.toFixed(2);
  if (price >= 1)     return "$" + price.toFixed(4);
  if (price >= 0.001) return "$" + price.toFixed(6);
  return "$" + price.toFixed(10);
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === "/api/trades") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(apiTrades()));
    return;
  }
  if (url.pathname === "/api/positions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadPositions()));
    return;
  }
  if (url.pathname === "/api/live") {
    const sym = url.searchParams.get("sym") || "BTCUSDT";
    const prices = await fetchLivePrices([sym]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ symbol: sym, price: prices[sym] || null }));
    return;
  }

  const data      = apiTrades();
  const positions = loadPositions();
  const html      = renderHtml(data, positions);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`\n📊 Dashboard: http://localhost:${PORT}`);
  console.log("   Pritisni Ctrl+C za zaustavljanje.\n");
});
