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

function parseCsv() {
  if (!existsSync("trades.csv")) return [];
  const lines = readFileSync("trades.csv", "utf8").trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(2).map(line => {
    const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) || [];
    const obj = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (vals[i] || "").replace(/^"|"$/g, "").trim();
    });
    return obj;
  }).filter(r => r["Symbol"]);
}

function loadPositions() {
  if (!existsSync("open_positions.json")) return [];
  try { return JSON.parse(readFileSync("open_positions.json", "utf8")); }
  catch { return []; }
}

// ─── API handlers ─────────────────────────────────────────────────────────────

function apiTrades() {
  const rows = parseCsv();
  const exits  = rows.filter(r => r["Side"] === "CLOSE_LONG" || r["Side"] === "CLOSE_SHORT");
  const entries = rows.filter(r => r["Side"] === "LONG" || r["Side"] === "SHORT");
  const blocked = rows.filter(r => r["Mode"] === "BLOCKED");

  const wins   = exits.filter(r => (r["Notes"] || "").includes("WIN"));
  const losses = exits.filter(r => (r["Notes"] || "").includes("LOSS"));
  const totalPnl = exits.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0);
  const winRate  = exits.length > 0 ? (wins.length / exits.length * 100).toFixed(1) : null;

  // P&L over time
  const pnlSeries = [];
  let running = 0;
  exits.forEach(r => {
    running += parseFloat(r["Net P&L"] || 0);
    pnlSeries.push({ date: r["Date"] + " " + r["Time (UTC)"], pnl: parseFloat(running.toFixed(4)) });
  });

  return { rows, exits, entries, blocked, wins, losses, totalPnl, winRate, pnlSeries };
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function renderHtml(data, positions) {
  const { exits, entries, blocked, wins, losses, totalPnl, winRate, pnlSeries } = data;
  const pnlColor = totalPnl >= 0 ? "#00c48c" : "#ff4d4d";
  const modeLabel = process.env.PAPER_TRADING !== "false" ? "PAPER" : process.env.BITGET_DEMO === "true" ? "DEMO" : "LIVE";
  const modeBadge = modeLabel === "PAPER" ? "#888" : modeLabel === "DEMO" ? "#f0a500" : "#ff4d4d";

  const recentExits = [...exits].reverse().slice(0, 15);

  const positionsHtml = positions.length === 0
    ? `<p class="muted">Nema otvorenih pozicija.</p>`
    : positions.map(p => `
      <div class="pos-card">
        <div class="pos-header">
          <span class="symbol">${p.symbol}</span>
          <span class="badge ${p.side === 'LONG' ? 'long' : 'short'}">${p.side}</span>
          <span class="badge demo">${p.mode}</span>
        </div>
        <div class="pos-grid">
          <div><label>Ulaz</label><span>${fmtP(p.entryPrice)}</span></div>
          <div><label>SL</label><span class="red">${fmtP(p.sl)}</span></div>
          <div><label>TP</label><span class="green">${fmtP(p.tp)}</span></div>
          <div><label>Notional</label><span>$${p.totalUSD.toFixed(2)}</span></div>
          <div><label>Qty</label><span>${p.quantity.toFixed(4)}</span></div>
          <div><label>Otvoreno</label><span>${p.openedAt.slice(0,16).replace("T"," ")}</span></div>
        </div>
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
  .green{color:#00c48c}
  .red{color:#ff4d4d}
  .muted{color:#8b949e;font-size:14px}
  small{color:#8b949e;font-size:11px}
  canvas{max-height:180px}
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1>Trading Bot</h1>
    <span class="mode-badge">${modeLabel}</span>
  </div>
  <span class="refresh">Auto-refresh svake minute • ${new Date().toISOString().slice(0,19).replace("T"," ")} UTC</span>
</div>

<div class="cards">
  <div class="card">
    <label>Ukupni P&L</label>
    <div class="value" style="color:${pnlColor}">${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(4)}</div>
  </div>
  <div class="card">
    <label>Win Rate</label>
    <div class="value neutral">${winRate !== null ? winRate + "%" : "—"}</div>
  </div>
  <div class="card">
    <label>Zatvoreni tradovi</label>
    <div class="value neutral">${exits.length}</div>
  </div>
  <div class="card">
    <label>✅ Win / ❌ Loss</label>
    <div class="value neutral"><span class="green">${wins.length}</span> / <span class="red">${losses.length}</span></div>
  </div>
  <div class="card">
    <label>Otvorene pozicije</label>
    <div class="value neutral">${positions.length}</div>
  </div>
  <div class="card">
    <label>Blokirani signali</label>
    <div class="value neutral">${blocked.length}</div>
  </div>
</div>

${pnlSeries.length > 1 ? `
<div class="section">
  <h2>P&L Krivulja</h2>
  <canvas id="chart"></canvas>
</div>` : ""}

<div class="section">
  <h2>Otvorene pozicije (${positions.length})</h2>
  ${positionsHtml}
</div>

<div class="section">
  <h2>Zadnjih 15 zatvorenih tradova</h2>
  ${exits.length === 0 ? '<p class="muted">Još nema zatvorenih tradova.</p>' : `
  <table>
    <thead><tr><th>Datum/Vrijeme</th><th>Par</th><th>Smjer</th><th>Cijena</th><th>P&L</th><th>Mod</th></tr></thead>
    <tbody>${tradesHtml}</tbody>
  </table>`}
</div>

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

const server = http.createServer((req, res) => {
  if (req.url === "/api/trades") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(apiTrades()));
    return;
  }
  if (req.url === "/api/positions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadPositions()));
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
