/**
 * Trading Bot Dashboard — lokalni HTTP server
 * Pokreni: node dashboard.js
 * Otvori:  http://localhost:3000
 */

import "dotenv/config";
import http from "http";
import { readFileSync, existsSync } from "fs";

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : ".");

// ─── Rules / watchlist ────────────────────────────────────────────────────────

function loadRules() {
  try { return JSON.parse(readFileSync("rules.json", "utf8")); }
  catch { return {}; }
}

function loadObPending() {
  const f = `${DATA_DIR}/ob_pending.json`;
  if (!existsSync(f)) return {};
  try {
    const raw = JSON.parse(readFileSync(f, "utf8"));
    // Podržava i array [] i objekt {}
    if (Array.isArray(raw)) {
      const obj = {};
      raw.forEach(s => { if (s.symbol) obj[s.symbol] = s; });
      return obj;
    }
    return raw;
  }
  catch { return {}; }
}

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
  const f = `${DATA_DIR}/trades.csv`;
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").trim().split("\n");
  const headers = parseCsvLine(lines[0]);
  return lines.slice(2).map(line => {
    const vals = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || "").trim(); });
    return obj;
  }).filter(r => r["Symbol"]);
}

function loadPositions() {
  const f = `${DATA_DIR}/open_positions.json`;
  if (!existsSync(f)) return [];
  try { return JSON.parse(readFileSync(f, "utf8")); }
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

// ─── Candle fetch + indikatori (za scanner) ───────────────────────────────────

async function fetchCandlesScan(symbol, interval, limit = 220) {
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${interval}&limit=${limit}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== "00000") return [];
  return json.data.map(k => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
  }));
}

function _ema(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

function _rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / (losses / period));
}

function _adx(candles, period = 14) {
  if (candles.length < period * 3) return null;
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    const up = h-ph, dn = pl-l;
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  let smTR  = trs.slice(0, period).reduce((a, b) => a+b, 0);
  let smPDM = plusDMs.slice(0, period).reduce((a, b) => a+b, 0);
  let smMDM = minusDMs.slice(0, period).reduce((a, b) => a+b, 0);
  const dxArr = [];
  for (let i = period; i < trs.length; i++) {
    smTR  = smTR  - smTR/period  + trs[i];
    smPDM = smPDM - smPDM/period + plusDMs[i];
    smMDM = smMDM - smMDM/period + minusDMs[i];
    const pdi = smTR > 0 ? 100*smPDM/smTR : 0;
    const mdi = smTR > 0 ? 100*smMDM/smTR : 0;
    const dSum = pdi + mdi;
    dxArr.push(dSum > 0 ? 100*Math.abs(pdi-mdi)/dSum : 0);
  }
  if (dxArr.length < period) return null;
  let adx = dxArr.slice(0, period).reduce((a, b) => a+b, 0) / period;
  for (let i = period; i < dxArr.length; i++) adx = (adx*(period-1)+dxArr[i])/period;
  return adx;
}

function _chop(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const sl = candles.slice(-(period + 1));
  let atrSum = 0;
  for (let i = 1; i < sl.length; i++) {
    const h = sl[i].high, l = sl[i].low, pc = sl[i-1].close;
    atrSum += Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
  }
  const hh = Math.max(...sl.slice(1).map(c => c.high));
  const ll = Math.min(...sl.slice(1).map(c => c.low));
  const range = hh - ll;
  if (range === 0 || atrSum === 0) return null;
  return 100 * Math.log10(atrSum / range) / Math.log10(period);
}

async function scanAllSymbols(rules) {
  const mp  = rules.strategies?.mega?.params || {};
  const mTFs = rules.mega_timeframes || {};
  const lists = {
    mega:    rules.watchlist_mega    || [],
    ob:      rules.watchlist_ob      || [],
    "3layer": rules.watchlist_3layer || [],
    ema_rsi: rules.watchlist_ema_rsi || [],
    fib_gp:  rules.watchlist_fib_gp  || [],
  };

  const symTFs = rules.symbol_timeframes || {};
  const tasks = [];
  for (const [stratKey, symbols] of Object.entries(lists)) {
    for (const sym of symbols) {
      const tf = symTFs[sym] || (stratKey === "mega" ? (mTFs[sym] || "1H") : "1H");
      tasks.push({ sym, tf, stratKey });
    }
  }

  const results = [];
  await Promise.all(tasks.map(async ({ sym, tf, stratKey }) => {
    try {
      const candles = await fetchCandlesScan(sym, tf, 220);
      if (candles.length < 30) { results.push({ sym, tf, stratKey, error: "nedovoljno svjeća" }); return; }
      const closes = candles.map(c => c.close);
      const price  = closes[closes.length - 1];
      const ema9   = _ema(closes, 9);
      const ema21  = _ema(closes, 21);
      const ema55  = closes.length >= 55  ? _ema(closes, 55)  : null;
      const ema200 = closes.length >= 200 ? _ema(closes, 200) : null;
      const rsi    = _rsi(closes, 14);
      let adx = null, chop = null, signal = "WAIT";

      if (stratKey === "mega") {
        adx  = _adx(candles, mp.adxLen  || 14);
        chop = _chop(candles, mp.chopLen || 14);
        if (ema9 && ema21 && ema55 && ema200 && closes.length >= 3) {
          const prev9   = _ema(closes.slice(0, -1), 9);
          const prev21  = _ema(closes.slice(0, -1), 21);
          const prev29  = _ema(closes.slice(0, -2), 9);
          const prev221 = _ema(closes.slice(0, -2), 21);
          const crossUp   = (prev29 <= prev221 && prev9 > prev21) || (prev9 <= prev21 && ema9 > ema21);
          const crossDown = (prev29 >= prev221 && prev9 < prev21) || (prev9 >= prev21 && ema9 < ema21);
          const tUp = price > ema55 && price > ema200;
          const tDn = price < ema55 && price < ema200;
          const adxOK  = adx  == null || adx  > (mp.adxMin  || 18);
          const chopOK = chop == null || chop < (mp.chopMax || 61.8);
          const rsiOKL = rsi > (mp.rsiLongLo  || 30) && rsi < (mp.rsiLongHi  || 60);
          const rsiOKS = rsi > (mp.rsiShortLo || 40) && rsi < (mp.rsiShortHi || 70);
          if (crossUp   && tUp && rsiOKL && adxOK && chopOK) signal = "LONG";
          if (crossDown && tDn && rsiOKS && adxOK && chopOK) signal = "SHORT";
        }
      }
      results.push({ sym, tf, stratKey, price, ema9, ema21, ema55, ema200, rsi, adx, chop, signal });
    } catch (e) {
      results.push({ sym, tf, stratKey, error: e.message });
    }
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
  if (pnl === 0) return `<span style="color:var(--text-muted)">$0.00</span>`;
  const col = pnl > 0 ? "var(--green)" : "var(--red)";
  return `<span style="color:${col}">${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}</span>`;
}

function loadHeartbeat() {
  const f = `${DATA_DIR}/heartbeat.json`;
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

function renderHtml(data, positions, rules, obPending, scanData = []) {
  const { exits, entries, blocked, recentBlocked, errors, wins, losses, totalPnl, winRate, pnlSeries, portfolio, STARTING_CAPITAL, daily, weekly, monthly } = data;
  const pnlColor   = totalPnl >= 0 ? "var(--green)" : "var(--red)";
  const portColor  = portfolio >= STARTING_CAPITAL ? "var(--green)" : "var(--red)";
  const portPct    = ((portfolio - STARTING_CAPITAL) / STARTING_CAPITAL * 100).toFixed(2);
  const portGrowth = Math.max(0, Math.min(100, ((portfolio - STARTING_CAPITAL) / STARTING_CAPITAL * 100)));
  const modeLabel  = process.env.PAPER_TRADING !== "false" ? "PAPER" : process.env.BITGET_DEMO === "true" ? "DEMO" : "LIVE";

  // Heartbeat
  const hb = loadHeartbeat();
  const hbAgeSec = hb ? Math.floor((Date.now() - new Date(hb.ts).getTime()) / 1000) : null;
  const hbOk = hbAgeSec !== null && hbAgeSec < 600;
  const hbLabel = hb
    ? (hbAgeSec < 60 ? `${hbAgeSec}s ago` : `${Math.floor(hbAgeSec/60)}m ago`)
    : "never";
  const hbBadge = hbOk
    ? `<span class="badge" style="background:rgba(0,196,140,0.15);color:var(--green);border:1px solid var(--green)">🟢 Bot ${hbLabel}</span>`
    : `<span class="badge" style="background:rgba(255,77,77,0.15);color:var(--red);border:1px solid var(--red)">🔴 Bot ${hb ? hbLabel + ' — STAO!' : 'nikad nije radio'}</span>`;
  const modeBadgeClass = modeLabel === "PAPER" ? "badge paper" : modeLabel === "DEMO" ? "badge demo" : "badge live";

  const recentExits = [...exits].reverse().slice(0, 15);

  const positionsHtml = positions.length === 0
    ? `<p class="muted">No open positions.</p>`
    : positions.map(p => {
        const isLong = p.side === 'LONG';
        return `
      <div class="pos-card ${isLong ? 'pos-long' : 'pos-short'}" id="pos-${p.symbol}">
        <div class="pos-header">
          <span class="symbol">${p.symbol}</span>
          <span class="badge ${isLong ? 'long' : 'short'}">${p.side}</span>
          <span class="badge demo">${p.mode}</span>
          <span class="live-price" id="price-${p.symbol}" style="margin-left:auto;font-size:14px;font-weight:700;color:var(--text-muted)">—</span>
        </div>
        <div class="pos-grid">
          <div><label>Entry</label><span>${fmtP(p.entryPrice)}</span></div>
          <div><label>Stop Loss</label><span class="red">${fmtP(p.sl)}</span></div>
          <div><label>Take Profit</label><span class="green">${fmtP(p.tp)}</span></div>
          <div><label>Notional</label><span>$${p.totalUSD.toFixed(2)}</span></div>
          <div><label>Qty</label><span>${p.quantity.toFixed(4)}</span></div>
          <div><label>Opened</label><span>${p.openedAt.slice(0,16).replace("T"," ")}</span></div>
        </div>
        <div class="pos-pnl-row">
          <div>
            <div class="pos-pnl-label">Unrealized P&amp;L</div>
            <div id="pnl-${p.symbol}" class="pos-pnl-value">—</div>
          </div>
          <div style="flex:1;min-width:0">
            <div class="pos-range-bar">
              <div id="bar-${p.symbol}" class="pos-range-fill"></div>
            </div>
            <div class="pos-range-labels">
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
            el.style.color = pnl>=0?"var(--green, #00c48c)":"var(--red, #ff4d4d)";
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
      </div>`;
      }).join("");

  const tradesHtml = recentExits.map(r => {
    const pnl = parseFloat(r["Net P&L"] || 0);
    const isWin = pnl >= 0;
    return `<tr class="${isWin ? 'win' : 'loss'}">
      <td>${r["Date"]}<br><small>${r["Time (UTC)"]}</small></td>
      <td><strong>${r["Symbol"]}</strong></td>
      <td><span class="badge ${r["Side"].includes("LONG") ? "long" : "short"}">${r["Side"].replace("CLOSE_","")}</span></td>
      <td>${fmtP(parseFloat(r["Price"] || 0))}</td>
      <td class="${isWin ? 'green' : 'red'}" style="font-weight:700">${isWin ? "+" : ""}$${pnl.toFixed(4)}</td>
      <td><span class="badge ${r["Mode"] === 'LIVE' ? 'live' : r['Mode'] === 'DEMO' ? 'demo' : 'paper'}">${r["Mode"]}</span></td>
    </tr>`;
  }).join("");

  const chartData = JSON.stringify(pnlSeries);

  return `<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Trading Bot Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  /* ── CSS Variables ─────────────────────────────────── */
  :root {
    --bg-primary:   #0d1117;
    --bg-secondary: #161b22;
    --bg-tertiary:  #21262d;
    --border:       #30363d;
    --border-subtle:#21262d;
    --text-primary: #e6edf3;
    --text-muted:   #8b949e;
    --green:        #00c48c;
    --red:          #ff4d4d;
    --blue:         #388bfd;
    --gold:         #f0a500;
    --purple:       #bc8cff;
    --orange:       #f78166;
  }

  /* ── Reset & Base ──────────────────────────────────── */
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  * { transition: background 0.2s, color 0.2s, box-shadow 0.2s; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    min-height: 100vh;
    padding: 0;
  }
  a { color: var(--blue); text-decoration: none; }

  /* ── Layout wrapper ────────────────────────────────── */
  .page-wrap { max-width: 1400px; margin: 0 auto; padding: 24px 20px 48px; }

  /* ── Top accent bar ────────────────────────────────── */
  .top-accent {
    height: 3px;
    background: linear-gradient(90deg, var(--green), var(--blue), var(--purple));
  }

  /* ── Header ────────────────────────────────────────── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 28px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .header-left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .logo-icon {
    font-size: 24px;
    filter: drop-shadow(0 0 8px rgba(0,196,140,0.6));
    animation: pulse-glow 3s ease-in-out infinite;
  }
  @keyframes pulse-glow {
    0%,100% { filter: drop-shadow(0 0 6px rgba(0,196,140,0.5)); }
    50%      { filter: drop-shadow(0 0 14px rgba(56,139,253,0.7)); }
  }
  .header-title {
    font-size: 22px;
    font-weight: 800;
    background: linear-gradient(135deg, #e6edf3 0%, var(--green) 60%, var(--blue) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: -0.5px;
  }
  .header-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .clock-badge {
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    padding: 5px 10px;
    border-radius: 20px;
    letter-spacing: 0.04em;
  }
  .refresh-badge {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    padding: 4px 10px;
    border-radius: 20px;
  }

  /* ── Pill Badges ───────────────────────────────────── */
  .badge {
    display: inline-flex; align-items: center;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }
  .badge.long    { background: rgba(0,196,140,.15);   color: var(--green);  border: 1px solid rgba(0,196,140,.25); }
  .badge.short   { background: rgba(255,77,77,.15);   color: var(--red);    border: 1px solid rgba(255,77,77,.25); }
  .badge.demo    { background: rgba(240,165,0,.15);   color: var(--gold);   border: 1px solid rgba(240,165,0,.25); }
  .badge.live    { background: rgba(255,77,77,.15);   color: var(--red);    border: 1px solid rgba(255,77,77,.3); }
  .badge.paper   { background: rgba(139,148,158,.12); color: var(--text-muted); border: 1px solid rgba(139,148,158,.2); }
  .badge.blocked { background: rgba(139,148,158,.08); color: var(--text-muted); }
  .badge.error   { background: rgba(255,77,77,.15);   color: var(--red); }
  .badge.tf      { background: rgba(56,139,253,.12);  color: var(--blue);   border: 1px solid rgba(56,139,253,.2); font-size: 10px; }
  .badge.mode-paper { background: rgba(139,148,158,.15); color: var(--text-muted); border: 1px solid rgba(139,148,158,.3); }
  .badge.mode-demo  { background: rgba(240,165,0,.15);   color: var(--gold);   border: 1px solid rgba(240,165,0,.3); }
  .badge.mode-live  { background: rgba(255,77,77,.15);   color: var(--red);    border: 1px solid rgba(255,77,77,.3); }

  /* ── Glassmorphism ─────────────────────────────────── */
  .glass {
    background: rgba(22,27,34,0.85);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(48,54,61,0.7);
  }

  /* ── Glow effects ──────────────────────────────────── */
  .glow-green { box-shadow: 0 0 24px rgba(0,196,140,0.12), 0 1px 3px rgba(0,0,0,0.4); }
  .glow-red   { box-shadow: 0 0 24px rgba(255,77,77,0.12),  0 1px 3px rgba(0,0,0,0.4); }
  .glow-blue  { box-shadow: 0 0 24px rgba(56,139,253,0.12), 0 1px 3px rgba(0,0,0,0.4); }

  /* ── Generic card / section ────────────────────────── */
  .card, .section {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px;
  }
  .section { margin-bottom: 20px; }
  .card label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: block;
    margin-bottom: 8px;
  }
  .card .value { font-size: 26px; font-weight: 700; }
  .card .value.green  { color: var(--green); }
  .card .value.red    { color: var(--red); }
  .card .value.neutral{ color: var(--text-primary); }

  /* ── Section heading ───────────────────────────────── */
  h2 {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2::before {
    content: '';
    display: inline-block;
    width: 3px;
    height: 14px;
    background: linear-gradient(180deg, var(--green), var(--blue));
    border-radius: 2px;
  }

  /* ── Portfolio Hero Card ───────────────────────────── */
  .portfolio-hero {
    background: linear-gradient(135deg, #0d1f14 0%, #0d1117 40%, #0d1525 100%);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px 32px;
    margin-bottom: 20px;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 24px;
    align-items: center;
    box-shadow: 0 0 40px rgba(0,196,140,0.06), 0 4px 20px rgba(0,0,0,0.3);
  }
  .port-label {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 8px;
  }
  .port-value {
    font-size: 42px;
    font-weight: 800;
    letter-spacing: -2px;
    line-height: 1;
    margin-bottom: 6px;
  }
  .port-value.positive {
    color: var(--green);
    text-shadow: 0 0 30px rgba(0,196,140,0.3);
  }
  .port-value.negative {
    color: var(--red);
    text-shadow: 0 0 30px rgba(255,77,77,0.3);
  }
  .port-meta {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .port-meta .sep { color: var(--border); }
  .port-growth-bar {
    margin-top: 14px;
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }
  .port-growth-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--green), var(--blue));
    border-radius: 3px;
    transition: width 1s ease;
  }
  .winrate-block { text-align: right; }
  .winrate-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 6px; }
  .winrate-value { font-size: 36px; font-weight: 800; color: var(--text-primary); letter-spacing: -1px; }
  .winrate-sub   { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

  /* ── Period Cards ──────────────────────────────────── */
  .period-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin-bottom: 20px;
  }
  .period-card {
    background: rgba(22,27,34,0.85);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(48,54,61,0.7);
    border-radius: 14px;
    padding: 18px 20px;
    position: relative;
    overflow: hidden;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .period-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
  .period-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--green), var(--blue));
    opacity: 0.5;
  }
  .period-card h3 {
    font-size: 10px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 12px;
  }
  .period-pnl {
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .period-arrow { font-size: 16px; }
  .period-sub { font-size: 12px; color: var(--text-muted); }

  /* ── Mini stat cards ───────────────────────────────── */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 14px;
    margin-bottom: 20px;
  }
  .stat-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .stat-card:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,0,0,0.25); }
  .stat-card label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: block;
    margin-bottom: 8px;
  }
  .stat-card .value { font-size: 26px; font-weight: 700; }
  .stat-card .value.green  { color: var(--green); }
  .stat-card .value.red    { color: var(--red); }
  .stat-card .value.neutral{ color: var(--text-primary); }

  /* ── Strategy / Watchlist section ─────────────────── */
  .strat-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-subtle);
    transition: background 0.15s;
  }
  .strat-row:last-child { border-bottom: none; }
  .strat-row:hover { background: rgba(255,255,255,0.02); border-radius: 8px; padding-left: 8px; padding-right: 8px; }
  .strat-label {
    min-width: 130px;
    font-size: 12px;
    font-weight: 700;
    padding-left: 10px;
    border-left: 3px solid;
  }
  .strat-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .sym-chip {
    padding: 4px 11px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    cursor: default;
    transition: background 0.15s, border-color 0.15s, transform 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .sym-chip:hover {
    background: rgba(56,139,253,0.1);
    border-color: rgba(56,139,253,0.4);
    transform: translateY(-1px);
  }

  /* ── Scanner table ─────────────────────────────────── */
  .scanner-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    text-align: left;
    padding: 10px 14px;
    color: var(--text-muted);
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    position: sticky;
    top: 0;
    z-index: 1;
    white-space: nowrap;
  }
  tbody tr { border-bottom: 1px solid var(--border-subtle); }
  tbody tr:nth-child(even) td { background: rgba(255,255,255,0.015); }
  tbody tr:hover td { background: rgba(56,139,253,0.05); }
  tbody tr:last-child { border-bottom: none; }
  td { padding: 10px 14px; }
  tr.win  td { border-left: 2px solid rgba(0,196,140,.4); }
  tr.loss td { border-left: 2px solid rgba(255,77,77,.4); }
  tr.win:first-child td { border-left: none; }
  tr.win td:first-child  { border-left: 3px solid rgba(0,196,140,.5); }
  tr.loss td:first-child { border-left: 3px solid rgba(255,77,77,.5); }

  /* Scanner signal badges */
  .sig-long  {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 10px; border-radius: 20px;
    background: rgba(0,196,140,.15); color: var(--green);
    border: 1px solid rgba(0,196,140,.3);
    font-weight: 700; font-size: 12px;
    box-shadow: 0 0 12px rgba(0,196,140,0.2);
    animation: pulse-sig 2s ease-in-out infinite;
  }
  .sig-short {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 10px; border-radius: 20px;
    background: rgba(255,77,77,.15); color: var(--red);
    border: 1px solid rgba(255,77,77,.3);
    font-weight: 700; font-size: 12px;
    box-shadow: 0 0 12px rgba(255,77,77,0.2);
    animation: pulse-sig 2s ease-in-out infinite;
  }
  .sig-wait { color: var(--text-muted); font-size: 12px; }
  @keyframes pulse-sig {
    0%,100% { opacity: 1; }
    50%      { opacity: 0.7; }
  }

  /* RSI mini bar */
  .rsi-bar-wrap  { display: flex; align-items: center; gap: 6px; }
  .rsi-bar-track { width: 44px; height: 4px; background: var(--bg-tertiary); border-radius: 2px; flex-shrink: 0; }
  .rsi-bar-fill  { height: 100%; border-radius: 2px; }

  /* Scanner skeleton */
  .skeleton {
    background: linear-gradient(90deg, var(--bg-tertiary) 25%, #2a3040 50%, var(--bg-tertiary) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite;
    border-radius: 4px;
    height: 14px;
    display: inline-block;
  }
  @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

  /* ── Position cards ────────────────────────────────── */
  .pos-card {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 12px;
    transition: box-shadow 0.2s, border-color 0.2s;
  }
  .pos-card:hover { border-color: rgba(56,139,253,0.3); }
  .pos-long  { border-left: 3px solid var(--green); }
  .pos-short { border-left: 3px solid var(--red); }
  .pos-header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .symbol { font-weight: 800; font-size: 17px; letter-spacing: -0.3px; }
  .pos-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }
  .pos-grid label {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: block;
    margin-bottom: 3px;
  }
  .pos-grid span { font-size: 13px; font-weight: 600; }
  .pos-pnl-row { display: flex; gap: 20px; align-items: center; }
  .pos-pnl-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .pos-pnl-value { font-size: 17px; font-weight: 700; color: var(--text-muted); }
  .pos-range-bar { height: 5px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
  .pos-range-fill { height: 100%; width: 50%; background: var(--text-muted); border-radius: 3px; transition: width .4s ease, background .3s; }
  .pos-range-labels { display: flex; justify-content: space-between; margin-top: 4px; }

  /* ── Tabs ──────────────────────────────────────────── */
  .tabs { display: flex; gap: 6px; margin-bottom: 18px; flex-wrap: wrap; }
  .tab {
    padding: 7px 16px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    transition: all 0.2s;
  }
  .tab:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .tab.active { background: var(--bg-tertiary); color: var(--text-primary); border-color: rgba(139,148,158,0.5); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* ── Block / Error rows ────────────────────────────── */
  .block-row {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 9px 0; border-bottom: 1px solid var(--border-subtle);
    font-size: 13px;
  }
  .block-row:last-child { border-bottom: none; }
  .block-time  { color: var(--text-muted); min-width: 140px; font-size: 12px; font-family: 'SF Mono', monospace; }
  .block-reason{ color: var(--text-muted); flex: 1; }
  .error-row   { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border-subtle); font-size: 13px; }
  .error-row:last-child { border-bottom: none; }
  .error-msg   { color: var(--red); flex: 1; }

  /* ── Utilities ─────────────────────────────────────── */
  .green  { color: var(--green) !important; }
  .red    { color: var(--red)   !important; }
  .muted  { color: var(--text-muted); font-size: 14px; }
  small   { color: var(--text-muted); font-size: 11px; }
  canvas  { max-height: 200px; }

  /* ── OB Active Setups ──────────────────────────────── */
  .ob-setup-row {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 0; border-bottom: 1px solid var(--border-subtle);
    font-size: 13px;
  }
  .ob-setup-row:last-child { border-bottom: none; }

  /* ── Responsive ────────────────────────────────────── */
  @media (max-width: 768px) {
    .portfolio-hero { grid-template-columns: 1fr; }
    .winrate-block  { text-align: left; }
    .period-grid    { grid-template-columns: 1fr; }
    .pos-grid       { grid-template-columns: repeat(2,1fr); }
  }
  @media (max-width: 480px) {
    .page-wrap { padding: 16px 12px 32px; }
    .port-value { font-size: 32px; }
  }
</style>
</head>
<body>
<div class="top-accent"></div>
<div class="page-wrap">

<!-- ── Header ─────────────────────────────────────────── -->
<div class="header">
  <div class="header-left">
    <span class="logo-icon">⚡</span>
    <span class="header-title">Trading Bot</span>
    <span class="badge ${modeBadgeClass}">${modeLabel}</span>
    <span class="badge tf">${process.env.TIMEFRAME || "1H"}</span>
    <span style="font-size:11px;color:var(--text-muted)">Fib GP · EMA+RSI · 3-Layer · OB · MEGA · BitGet Futures</span>
  </div>
  <div class="header-right">
    ${hbBadge}
    <span class="clock-badge" id="live-clock">00:00:00 CRO</span>
    <span class="refresh-badge">Auto-refresh 15s</span>
  </div>
</div>

<!-- ── Portfolio Hero ──────────────────────────────────── -->
<div class="portfolio-hero">
  <div>
    <div class="port-label">Portfolio Value</div>
    <div class="port-value ${portfolio >= STARTING_CAPITAL ? 'positive' : 'negative'}">$${portfolio.toFixed(2)}</div>
    <div class="port-meta">
      <span>Start: $${STARTING_CAPITAL.toFixed(2)}</span>
      <span class="sep">|</span>
      <span>P&amp;L: <strong style="color:${totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}">${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}</strong></span>
      <span class="sep">|</span>
      <span style="color:${portfolio >= STARTING_CAPITAL ? 'var(--green)' : 'var(--red)'}"><strong>${portPct >= 0 ? "+" : ""}${portPct}%</strong></span>
    </div>
    <div class="port-growth-bar">
      <div class="port-growth-fill" style="width:${Math.min(Math.max(portGrowth, 0), 100)}%"></div>
    </div>
  </div>
  <div class="winrate-block">
    <div class="winrate-label">Win Rate</div>
    <div class="winrate-value">${winRate !== null ? winRate + "%" : "—"}</div>
    <div class="winrate-sub">
      <span class="green">${wins.length}W</span>
      &nbsp;/&nbsp;
      <span class="red">${losses.length}L</span>
      &nbsp;·&nbsp;
      ${exits.length} closed
    </div>
  </div>
</div>

<!-- ── Period Cards ────────────────────────────────────── -->
<div class="period-grid">
  <div class="period-card glass">
    <h3>Today</h3>
    <div class="period-pnl" style="color:${daily.pnl > 0 ? 'var(--green)' : daily.pnl < 0 ? 'var(--red)' : 'var(--text-muted)'}">
      ${daily.count === 0 ? '<span style="color:var(--text-muted)">—</span>' : `
        <span class="period-arrow">${daily.pnl >= 0 ? '↑' : '↓'}</span>
        ${(daily.pnl >= 0 ? "+" : "") + "$" + daily.pnl.toFixed(2)}
      `}
    </div>
    <div class="period-sub">${daily.count} trades &nbsp;·&nbsp; <span class="green">${daily.wins}W</span> <span class="red">${daily.losses}L</span></div>
  </div>
  <div class="period-card glass">
    <h3>This Week</h3>
    <div class="period-pnl" style="color:${weekly.pnl > 0 ? 'var(--green)' : weekly.pnl < 0 ? 'var(--red)' : 'var(--text-muted)'}">
      ${weekly.count === 0 ? '<span style="color:var(--text-muted)">—</span>' : `
        <span class="period-arrow">${weekly.pnl >= 0 ? '↑' : '↓'}</span>
        ${(weekly.pnl >= 0 ? "+" : "") + "$" + weekly.pnl.toFixed(2)}
      `}
    </div>
    <div class="period-sub">${weekly.count} trades &nbsp;·&nbsp; <span class="green">${weekly.wins}W</span> <span class="red">${weekly.losses}L</span></div>
  </div>
  <div class="period-card glass">
    <h3>This Month</h3>
    <div class="period-pnl" style="color:${monthly.pnl > 0 ? 'var(--green)' : monthly.pnl < 0 ? 'var(--red)' : 'var(--text-muted)'}">
      ${monthly.count === 0 ? '<span style="color:var(--text-muted)">—</span>' : `
        <span class="period-arrow">${monthly.pnl >= 0 ? '↑' : '↓'}</span>
        ${(monthly.pnl >= 0 ? "+" : "") + "$" + monthly.pnl.toFixed(2)}
      `}
    </div>
    <div class="period-sub">${monthly.count} trades &nbsp;·&nbsp; <span class="green">${monthly.wins}W</span> <span class="red">${monthly.losses}L</span></div>
  </div>
</div>

<!-- ── Mini Stat Cards ─────────────────────────────────── -->
<div class="cards">
  <div class="stat-card">
    <label>Open Positions</label>
    <div class="value neutral">${positions.length}</div>
  </div>
  <div class="stat-card">
    <label>Blocked Signals</label>
    <div class="value neutral">${blocked.length}</div>
  </div>
  <div class="stat-card">
    <label>Total Scans</label>
    <div class="value neutral">${entries.length + blocked.length}</div>
  </div>
</div>

<!-- ── Strategy / Watchlists ───────────────────────────── -->
${(() => {
  const wFib  = (rules.watchlist_fib_gp  || []);
  const wEma  = (rules.watchlist_ema_rsi || []);
  const w3L   = (rules.watchlist_3layer  || []);
  const wOB   = (rules.watchlist_ob      || []);
  const obEntries = Object.entries(obPending);
  const wMEGA = (rules.watchlist_mega || []);
  const megaTFs = rules.mega_timeframes || {};

  const stratRows = [
    { label: "Fib GP",      icon: "🔵", symbols: wFib,  color: "var(--blue)" },
    { label: "EMA + RSI",   icon: "🟡", symbols: wEma,  color: "var(--gold)" },
    { label: "3-Layer",     icon: "🟣", symbols: w3L,   color: "var(--purple)" },
    { label: "Order Block", icon: "🟠", symbols: wOB,   color: "var(--orange)" },
    { label: "MEGA",        icon: "⚡", symbols: wMEGA, color: "var(--green)", tfs: megaTFs },
  ].map(s => `
    <div class="strat-row">
      <span class="strat-label" style="color:${s.color};border-color:${s.color}">${s.icon} ${s.label}</span>
      <div class="strat-chips">
        ${s.symbols.map(sym => {
          const ob = obPending[sym];
          const hasSetup = !!ob;
          const setupBadge = hasSetup
            ? `<span style="font-size:10px;padding:1px 5px;border-radius:10px;background:rgba(247,129,102,.15);color:var(--orange);margin-left:3px">${ob.trend === 'UP' ? '↑' : '↓'}</span>`
            : "";
          const tfBadge = s.tfs && s.tfs[sym]
            ? `<span class="badge tf" style="font-size:9px;padding:1px 4px;margin-left:2px">${s.tfs[sym]}</span>`
            : "";
          return `<span class="sym-chip">${sym.replace("USDT","")}${tfBadge}${setupBadge}</span>`;
        }).join("")}
      </div>
    </div>`).join("");

  const obSection = obEntries.length === 0 ? "" : `
    <div style="margin-top:16px">
      <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">OB Active Setups</div>
      ${obEntries.map(([sym, ob]) => `
        <div class="ob-setup-row">
          <strong style="min-width:90px">${sym}</strong>
          <span class="badge ${ob.trend === 'UP' ? 'long' : 'short'}">${ob.trend === 'UP' ? 'LONG' : 'SHORT'}</span>
          <span style="color:var(--text-muted)">${ob.session || ""}</span>
          <span>Zone: <span class="green">$${parseFloat(ob.ob?.bodyBot||0).toFixed(2)}</span> – <span class="green">$${parseFloat(ob.ob?.bodyTop||0).toFixed(2)}</span></span>
          <span style="color:var(--text-muted);font-size:12px;font-family:'SF Mono',monospace">Created: ${ob.createdAt ? new Date(ob.createdAt).toLocaleTimeString("hr-HR",{timeZone:"Europe/Zagreb",hour12:false}).slice(0,5) : "?"} CRO</span>
        </div>`).join("")}
    </div>`;

  return `<div class="section" style="margin-bottom:20px">
    <h2>Strategies &amp; Watchlists</h2>
    ${stratRows}
    ${obSection}
  </div>`;
})()}

<!-- ── Live Scanner (server-side rendered) ──────────────── -->
${(() => {
  const ORDER  = ['mega','ob','3layer','ema_rsi','fib_gp'];
  const LABELS = { mega:'⚡ MEGA', ob:'🟠 OB', '3layer':'🟣 3-Layer', ema_rsi:'🟡 EMA+RSI', fib_gp:'🔵 Fib GP' };
  const sorted = [...scanData].sort((a,b) => ORDER.indexOf(a.stratKey) - ORDER.indexOf(b.stratKey));
  const ts = new Date().toLocaleTimeString("hr-HR", { timeZone: "Europe/Zagreb", hour12: false });

  let rows = '';
  for (const row of sorted) {
    if (row.error) {
      rows += `<tr>
        <td style="font-size:11px;color:#8b949e">${LABELS[row.stratKey]||row.stratKey}</td>
        <td><strong>${row.sym.replace('USDT','')}</strong></td>
        <td><span class="badge tf">${row.tf}</span></td>
        <td colspan="7" style="color:#8b949e;font-size:12px">${row.error}</td>
      </tr>`;
      continue;
    }
    const emaCl  = row.ema9 && row.ema21 ? (row.ema9 > row.ema21 ? '#00c48c' : '#ff4d4d') : '#8b949e';
    const emaLbl = row.ema9 && row.ema21 ? (row.ema9 > row.ema21 ? '▲ BULL' : '▼ BEAR') : '—';

    let tLbl = '—', tCl = '#8b949e';
    if (row.ema55 && row.ema200) {
      if (row.price > row.ema55 && row.price > row.ema200)      { tLbl = '▲ UP';   tCl = '#00c48c'; }
      else if (row.price < row.ema55 && row.price < row.ema200) { tLbl = '▼ DOWN'; tCl = '#ff4d4d'; }
      else                                                        { tLbl = '─ NEU';  tCl = '#8b949e'; }
    }

    const rsiVal = row.rsi != null ? row.rsi.toFixed(1) : null;
    const rsiCl  = row.rsi ? (row.rsi < 30 ? '#00c48c' : row.rsi > 70 ? '#ff4d4d' : '#e6edf3') : '#8b949e';
    const rsiPct = row.rsi != null ? Math.min(100, Math.max(0, row.rsi)) : 0;
    const rsiCell = rsiVal
      ? `<div class="rsi-bar-wrap"><span style="color:${rsiCl}">${rsiVal}</span><div class="rsi-bar-track"><div class="rsi-bar-fill" style="width:${rsiPct}%;background:${rsiCl}"></div></div></div>`
      : '<span style="color:#8b949e">—</span>';

    const adxV  = row.adx  != null ? row.adx.toFixed(1)  + (row.adx  > 18   ? ' ✓' : ' ✗') : '—';
    const adxCl = row.adx  != null ? (row.adx  > 18   ? '#00c48c' : '#ff4d4d') : '#8b949e';
    const chopV = row.chop != null ? row.chop.toFixed(1) + (row.chop < 61.8 ? ' ✓' : ' ✗') : '—';
    const chopCl= row.chop != null ? (row.chop < 61.8 ? '#00c48c' : '#ff4d4d') : '#8b949e';

    const sigHtml = row.signal === 'LONG'  ? '<span class="sig-long">🟢 LONG</span>'
                  : row.signal === 'SHORT' ? '<span class="sig-short">🔴 SHORT</span>'
                  :                          '<span class="sig-wait">─ WAIT</span>';

    rows += `<tr>
      <td style="font-size:11px;color:#8b949e">${LABELS[row.stratKey]||row.stratKey}</td>
      <td><strong style="font-size:13px">${row.sym.replace('USDT','')}</strong></td>
      <td><span class="badge tf">${row.tf}</span></td>
      <td style="font-size:12px;font-family:monospace">${fmtP(row.price||0)}</td>
      <td style="color:${emaCl};font-weight:700">${emaLbl}</td>
      <td style="color:${tCl};font-weight:700">${tLbl}</td>
      <td>${rsiCell}</td>
      <td style="color:${adxCl};font-size:12px">${adxV}</td>
      <td style="color:${chopCl};font-size:12px">${chopV}</td>
      <td>${sigHtml}</td>
    </tr>`;
  }

  return `<div class="section" style="margin-bottom:20px">
    <h2>Live Scanner &nbsp;<span style="font-size:11px;color:#8b949e;font-weight:400;text-transform:none;letter-spacing:0">${ts} CRO</span></h2>
    <div class="scanner-wrap">
      <table style="min-width:700px">
        <thead><tr>
          <th>Strategija</th><th>Par</th><th>TF</th><th>Cijena</th>
          <th>EMA 9/21</th><th>Trend 55/200</th><th>RSI</th><th>ADX</th><th>Chop</th><th>Signal</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
})()}

${pnlSeries.length > 1 ? `
<!-- ── Portfolio Chart ──────────────────────────────────── -->
<div class="section">
  <h2>Portfolio Growth ($)</h2>
  <canvas id="chart"></canvas>
</div>` : ""}

<!-- ── Open Positions ──────────────────────────────────── -->
<div class="section">
  <h2>Open Positions <span style="font-weight:400;color:var(--text-muted);font-size:11px;letter-spacing:0;text-transform:none">(${positions.length})</span></h2>
  ${positionsHtml}
</div>

<!-- ── Trades / Blocked / Errors ───────────────────────── -->
<div class="section">
  <div class="tabs">
    <button class="tab active" onclick="showTab('closed')">Closed (${exits.length})</button>
    <button class="tab" onclick="showTab('blocked')">Blocked (${blocked.length})</button>
    <button class="tab" onclick="showTab('errors')" style="${errors.length > 0 ? 'color:var(--red);border-color:var(--red)' : ''}">Errors (${errors.length})</button>
  </div>

  <div id="tab-closed" class="tab-content active">
    ${exits.length === 0 ? '<p class="muted">No closed trades yet.</p>' : `
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Date / Time</th><th>Pair</th><th>Side</th><th>Price</th><th>P&amp;L</th><th>Mode</th></tr></thead>
      <tbody>${tradesHtml}</tbody>
    </table>
    </div>`}
  </div>

  <div id="tab-blocked" class="tab-content">
    ${recentBlocked.length === 0 ? '<p class="muted">No blocked signals.</p>' : recentBlocked.map(r => `
      <div class="block-row">
        <span class="block-time">${r["Date"]} ${r["Time (UTC)"]}</span>
        <strong style="min-width:90px">${r["Symbol"]}</strong>
        <span class="block-reason">${r["Notes"] || "—"}</span>
      </div>`).join("")}
  </div>

  <div id="tab-errors" class="tab-content">
    ${errors.length === 0 ? '<p class="muted" style="color:var(--green)">✅ No errors.</p>' : errors.map(r => `
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

// Live clock — Zagreb time (Europe/Zagreb, CEST=UTC+2)
function updateClock() {
  const now = new Date();
  const cro = now.toLocaleTimeString("hr-HR", { timeZone: "Europe/Zagreb", hour12: false });
  const el = document.getElementById('live-clock');
  if (el) el.textContent = cro + ' CRO';
}
setInterval(updateClock, 1000);
updateClock();
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
      label: 'Cumulative P&L ($)',
      data: raw.map(d => d.pnl),
      borderColor: '${totalPnl >= 0 ? '#00c48c' : '#ff4d4d'}',
      backgroundColor: '${totalPnl >= 0 ? '#00c48c' : '#ff4d4d'}18',
      borderWidth: 2,
      fill: true,
      tension: 0.35,
      pointRadius: 3,
      pointHoverRadius: 6,
      pointBackgroundColor: '${totalPnl >= 0 ? '#00c48c' : '#ff4d4d'}',
    }]
  },
  options: {
    responsive: true,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { labels: { color: '#8b949e', font: { size: 12 } } },
      tooltip: {
        backgroundColor: '#161b22',
        borderColor: '#30363d',
        borderWidth: 1,
        titleColor: '#e6edf3',
        bodyColor: '#8b949e',
      }
    },
    scales: {
      x: { ticks: { color: '#8b949e', maxTicksLimit: 8, font: { size: 11 } }, grid: { color: '#21262d' } },
      y: { ticks: { color: '#8b949e', font: { size: 11 } }, grid: { color: '#21262d' } }
    }
  }
});
</script>` : ""}

</div>
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
  if (url.pathname === "/api/scan") {
    try {
      const r = loadRules();
      const scan = await scanAllSymbols(r);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ts: new Date().toISOString(), data: scan }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/live") {
    const sym = url.searchParams.get("sym") || "BTCUSDT";
    const prices = await fetchLivePrices([sym]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ symbol: sym, price: prices[sym] || null }));
    return;
  }
  if (url.pathname === "/health") {
    const hbFile = `${DATA_DIR}/heartbeat.json`;
    const hb = existsSync(hbFile) ? JSON.parse(readFileSync(hbFile, "utf8")) : null;
    const ageSec = hb ? Math.floor((Date.now() - new Date(hb.ts).getTime()) / 1000) : null;
    const botOk  = ageSec !== null && ageSec < 600; // < 10 min
    res.writeHead(botOk ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: botOk ? "ok" : "stale", bot: hb, ageSec, dashboard: "ok" }));
    return;
  }

  const data      = apiTrades();
  const positions = loadPositions();
  const rules     = loadRules();
  const obPending = loadObPending();
  const scanData  = await scanAllSymbols(rules);
  const html      = renderHtml(data, positions, rules, obPending, scanData);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`\n📊 Dashboard: http://localhost:${PORT}`);
  console.log("   Pritisni Ctrl+C za zaustavljanje.\n");
});
