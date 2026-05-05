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
  { id: "ema_rsi",   name: "EMA+RSI",   color: "#388bfd", emoji: "📊" },
  { id: "mega",      name: "MEGA",      color: "#00c48c", emoji: "🚀" },
  { id: "synapse7",  name: "SYNAPSE-7", color: "#f7b731", emoji: "🧠" },
  { id: "synapse_t", name: "SYNAPSE-T", color: "#e85d9a", emoji: "🎯" },
];

// ─── All symbols ───────────────────────────────────────────────────────────────

const ALL_SYMBOLS = [
  "XAUUSDT","DOGEUSDT","NEARUSDT","RIVERUSDT","ADAUSDT",
  "ETHUSDT","SUIUSDT","TAOUSDT",
  "SOLUSDT","XAGUSDT","HYPEUSDT","LINKUSDT","PEPEUSDT","ZECUSDT","BTCUSDT",
  // Uklonjeni (loš WR): ORDIUSDT, WLDUSDT, TRUMPUSDT, XRPUSDT, AVAXUSDT, AAVEUSDT
];

// ─── Scanner indicator helpers ─────────────────────────────────────────────────

function _ema(closes, p) {
  if (closes.length < p) return null;
  const k = 2 / (p + 1);
  let v = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

function _rsi(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / p) / (l / p));
}

function _rma(vals, p) {
  let v = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < vals.length; i++) v = (v * (p - 1) + vals[i]) / p;
  return v;
}

function _adx(candles, p = 14) {
  if (candles.length < p * 3) return null;
  const trs = [], pDMs = [], mDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    const up = h-ph, dn = pl-l;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  const atr = _rma(trs, p), pdm = _rma(pDMs, p), mdm = _rma(mDMs, p);
  const dxs = [];
  for (let i = 0; i < atr.length || false; i++) break; // unused loop — use simple approach below
  let smTR = trs.slice(0,p).reduce((a,b)=>a+b,0);
  let smP  = pDMs.slice(0,p).reduce((a,b)=>a+b,0);
  let smM  = mDMs.slice(0,p).reduce((a,b)=>a+b,0);
  const dx = [];
  for (let i = p; i < trs.length; i++) {
    smTR = smTR - smTR/p + trs[i]; smP = smP - smP/p + pDMs[i]; smM = smM - smM/p + mDMs[i];
    const pdi = smTR > 0 ? 100*smP/smTR : 0, mdi = smTR > 0 ? 100*smM/smTR : 0;
    const s = pdi+mdi; dx.push(s > 0 ? 100*Math.abs(pdi-mdi)/s : 0);
  }
  if (dx.length < p) return null;
  let adx = dx.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i = p; i < dx.length; i++) adx = (adx*(p-1)+dx[i])/p;
  return adx;
}

function _chop(candles, p = 14) {
  if (candles.length < p+1) return null;
  const sl = candles.slice(-(p+1));
  let s = 0;
  for (let i = 1; i < sl.length; i++) {
    const h=sl[i].high,l=sl[i].low,pc=sl[i-1].close;
    s += Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
  }
  const hh = Math.max(...sl.slice(1).map(c=>c.high));
  const ll = Math.min(...sl.slice(1).map(c=>c.low));
  const r = hh-ll;
  return (r && s) ? 100*Math.log10(s/r)/Math.log10(p) : null;
}

function _macdHist(closes, fast=12, slow=26, sig=9) {
  if (closes.length < slow+sig+2) return null;
  const diffs = [];
  for (let i = slow; i <= closes.length; i++) {
    const f = _ema(closes.slice(0,i), fast);
    const s = _ema(closes.slice(0,i), slow);
    if (f!==null && s!==null) diffs.push(f-s);
  }
  const sigLine = _ema(diffs, sig);
  return sigLine ? diffs[diffs.length-1] - sigLine : null;
}

// ─── Scanner — run all 3 strategies on one symbol ──────────────────────────────

// Compute full EMA series — koristi za detekciju crossa u zadnjih N barova
function _emaSeries(closes, p) {
  const k = 2 / (p + 1);
  const r = new Array(closes.length).fill(null);
  if (closes.length < p) return r;
  let v = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
  r[p - 1] = v;
  for (let i = p; i < closes.length; i++) { v = closes[i] * k + v * (1 - k); r[i] = v; }
  return r;
}

// Provjeri je li EMA9/21 cross bio u zadnjih BARS barova
function hadCross(e9, e21, bars = 5) {
  const n = e9.length;
  let up = false, dn = false;
  for (let i = Math.max(1, n - bars); i < n; i++) {
    if (e9[i-1] === null || e21[i-1] === null || e9[i] === null || e21[i] === null) continue;
    if (e9[i-1] <= e21[i-1] && e9[i] > e21[i]) up = true;
    if (e9[i-1] >= e21[i-1] && e9[i] < e21[i]) dn = true;
  }
  return { up, dn };
}

function scanSymbol(candles, emaRsiCfg, megaCfg, synapse7Cfg = {}, synapseTCfg = {}) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const n      = closes.length;

  // Compute full EMA series for cross detection
  const e9Arr  = _emaSeries(closes, 9);
  const e21Arr = _emaSeries(closes, 21);

  // Cross in last 5 bars (scanner window — bot uses 1-2 bar window)
  const SCAN_BARS = 5;
  const { up: crossUp, dn: crossDown } = hadCross(e9Arr, e21Arr, SCAN_BARS);

  // Current values
  const ema9   = e9Arr[n - 1];
  const ema21  = e21Arr[n - 1];
  const ema50  = _ema(closes, 50);
  const ema55  = _ema(closes, 55);
  const ema200 = _ema(closes, 200);
  const rsi    = _rsi(closes, 14);
  const adx    = _adx(candles, 14);
  const chop   = _chop(candles, 14);

  // EMA bias (neovisno o crossu — uvijek vidljivo)
  const emaBias = ema9 && ema21 ? (ema9 > ema21 ? "↑" : "↓") : "—";

  // ── EMA+RSI signal ──
  let emaRsiSig = "—";
  if (ema9 && ema21 && ema50 && rsi !== null) {
    const { rsiLongLo=35, rsiLongHi=58, rsiShortLo=42, rsiShortHi=65 } = emaRsiCfg;
    if (crossUp   && price > ema50 && rsi >= rsiLongLo  && rsi <= rsiLongHi)  emaRsiSig = "LONG";
    if (crossDown && price < ema50 && rsi >= rsiShortLo && rsi <= rsiShortHi) emaRsiSig = "SHORT";
    // Setup (uvjeti OK, ali nema svježeg crossa) — prikaži bias
    if (emaRsiSig === "—") {
      const setupLong  = price > ema50 && rsi >= rsiLongLo  && rsi <= rsiLongHi  && ema9 > ema21;
      const setupShort = price < ema50 && rsi >= rsiShortLo && rsi <= rsiShortHi && ema9 < ema21;
      if (setupLong)  emaRsiSig = "SETUP↑";
      if (setupShort) emaRsiSig = "SETUP↓";
    }
  }

  // ── MEGA signal ──
  let megaSig = "—";
  if (ema9 && ema21 && ema55 && rsi !== null) {
    const { rsiLongLo=30, rsiLongHi=60, rsiShortLo=40, rsiShortHi=70, adxMin=18, chopMax=61.8 } = megaCfg;
    const tUp   = price > ema55 && (!ema200 || price > ema200);
    const tDn   = price < ema55 && (!ema200 || price < ema200);
    const trending  = adx === null || adx > adxMin;
    const notChoppy = chop === null || chop < chopMax;
    if (crossUp   && tUp && rsi > rsiLongLo  && rsi < rsiLongHi  && trending && notChoppy) megaSig = "LONG";
    if (crossDown && tDn && rsi > rsiShortLo && rsi < rsiShortHi && trending && notChoppy) megaSig = "SHORT";
    if (megaSig === "—") {
      const setupLong  = tUp && rsi > rsiLongLo  && rsi < rsiLongHi  && ema9 > ema21 && trending && notChoppy;
      const setupShort = tDn && rsi > rsiShortLo && rsi < rsiShortHi && ema9 < ema21 && trending && notChoppy;
      if (setupLong)  megaSig = "SETUP↑";
      if (setupShort) megaSig = "SETUP↓";
    }
  }

  // Trend label (EMA55/200)
  const trendLabel = ema55
    ? (price > ema55
        ? (ema200 ? (price > ema200 ? "↑↑ Bull" : "↑ Weak") : "↑ Bull")
        : (ema200 ? (price < ema200 ? "↓↓ Bear" : "↓ Weak") : "↓ Bear"))
    : "—";

  // ── SYNAPSE-7 simplified scanner signal ────────────────────────────────────
  // 5 sub-signals: 6-scale EMA | RSI momentum | CVD delta | EMA trend | ADX
  let synapse7Sig = "—";
  {
    const { minSig = 3, rsiLen = 14, rsiMaLen = 14 } = synapse7Cfg;
    // Sub-signal 1: 6-scale EMA consensus (pairs: 3/11, 7/15, 13/21, 19/29, 29/47, 45/55)
    const scales = [[3,11],[7,15],[13,21],[19,29],[29,47],[45,55]];
    let scaleUp = 0, scaleDn = 0;
    for (const [f, s] of scales) {
      const ef = _ema(closes, f), es = _ema(closes, s);
      if (ef && es) { if (ef > es) scaleUp++; else scaleDn++; }
    }
    const scaleSig = scaleUp >= 4 ? 1 : scaleDn >= 4 ? -1 : 0;

    // Sub-signal 2: RSI vs RSI-EMA (Pumori pattern)
    const rsiVal = _rsi(closes, 14);
    let rsiMomSig = 0;
    if (rsiVal !== null) {
      // build RSI series for EMA (simplified: use last value vs mid)
      rsiMomSig = rsiVal > 55 ? 1 : rsiVal < 45 ? -1 : 0;
    }

    // Sub-signal 3: CVD delta (signed volume: sum of last 20 bars sign(close-open)*volume)
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const vols   = candles.map(c => c.volume || 0);
    const opens  = candles.map(c => c.open);
    const cvdLen = Math.min(20, candles.length);
    let cvdSum = 0;
    for (let i = candles.length - cvdLen; i < candles.length; i++) {
      const sign = closes[i] > opens[i] ? 1 : closes[i] < opens[i] ? -1 : 0;
      cvdSum += sign * vols[i];
    }
    const cvdSig = cvdSum > 0 ? 1 : cvdSum < 0 ? -1 : 0;

    // Sub-signal 4: EMA trend (EMA55 + EMA200)
    const trendSig = (ema55 && price > ema55) ? 1 : (ema55 && price < ema55) ? -1 : 0;

    // Sub-signal 5: ADX momentum (trending = bull/bear conf by EMA9/21)
    const adxSig = (adx && adx > 20) ? (ema9 > ema21 ? 1 : -1) : 0;

    const bullCnt = [scaleSig, rsiMomSig, cvdSig, trendSig, adxSig].filter(v => v === 1).length;
    const bearCnt = [scaleSig, rsiMomSig, cvdSig, trendSig, adxSig].filter(v => v === -1).length;

    if      (bullCnt >= minSig) synapse7Sig = "LONG";
    else if (bearCnt >= minSig) synapse7Sig = "SHORT";
    else if (bullCnt === minSig - 1 && scaleUp >= 3) synapse7Sig = "SETUP↑";
    else if (bearCnt === minSig - 1 && scaleDn >= 3) synapse7Sig = "SETUP↓";
  }

  // ── SYNAPSE-T: SYNAPSE-7 + ADX obvezan + minSig 4/5 ──────────────────────
  let synapseTSig = "—";
  {
    const { minSig = 4, adxMin = 22 } = synapseTCfg;
    // ADX pre-filter — ako ADX prenizak, preskačemo (konsolidacija)
    if (adx !== null && adx >= adxMin) {
      const scales = [[3,11],[7,15],[13,21],[19,29],[29,47],[45,55]];
      let scaleUp = 0, scaleDn = 0;
      for (const [f, s] of scales) {
        const ef = _ema(closes, f), es = _ema(closes, s);
        if (ef && es) { if (ef > es) scaleUp++; else scaleDn++; }
      }
      const scaleSig = scaleUp >= 4 ? 1 : scaleDn >= 4 ? -1 : 0;
      const rsiVal   = _rsi(closes, 14);
      const rsiMomSig = rsiVal !== null ? (rsiVal > 55 ? 1 : rsiVal < 45 ? -1 : 0) : 0;
      const opens = candles.map(c => c.open);
      const vols  = candles.map(c => c.volume || 0);
      const cvdLen = Math.min(20, candles.length);
      let cvdSum = 0;
      for (let i = candles.length - cvdLen; i < candles.length; i++) {
        const sign = closes[i] > opens[i] ? 1 : closes[i] < opens[i] ? -1 : 0;
        cvdSum += sign * vols[i];
      }
      const cvdSig   = cvdSum > 0 ? 1 : cvdSum < 0 ? -1 : 0;
      const trendSig = (ema55 && price > ema55) ? 1 : (ema55 && price < ema55) ? -1 : 0;
      const adxSig   = ema9 > ema21 ? 1 : -1;  // ADX already confirmed trending
      const bullCnt  = [scaleSig, rsiMomSig, cvdSig, trendSig, adxSig].filter(v => v === 1).length;
      const bearCnt  = [scaleSig, rsiMomSig, cvdSig, trendSig, adxSig].filter(v => v === -1).length;
      if      (bullCnt >= minSig) synapseTSig = "LONG";
      else if (bearCnt >= minSig) synapseTSig = "SHORT";
      else if (bullCnt === minSig - 1) synapseTSig = "SETUP↑";
      else if (bearCnt === minSig - 1) synapseTSig = "SETUP↓";
    }
  }

  return {
    price, emaBias,
    rsi: rsi?.toFixed(1) ?? "—",
    adx: adx?.toFixed(1) ?? "—",
    chop: chop?.toFixed(1) ?? "—",
    trend: trendLabel,
    emaRsiSig, megaSig, synapse7Sig, synapseTSig,
  };
}

// ─── Scanner cache ─────────────────────────────────────────────────────────────

let _scanCache    = null;
let _scanCacheTs  = 0;
let _scanRunning  = false;

async function runScan(rules) {
  if (_scanRunning) return _scanCache;
  _scanRunning = true;
  const cfg = rules?.strategies || {};
  const emaRsiCfg   = cfg.ema_rsi?.params    || {};
  const megaCfg     = cfg.mega?.params        || {};
  const synapse7Cfg = cfg.synapse7?.params    || {};
  const synapseTCfg = cfg.synapse_t?.params   || {};

  const results = [];
  // Fetch all symbols in parallel (limit concurrency to avoid rate limit)
  const BATCH = 5;
  for (let i = 0; i < ALL_SYMBOLS.length; i += BATCH) {
    const batch = ALL_SYMBOLS.slice(i, i + BATCH);
    await Promise.all(batch.map(async sym => {
      try {
        const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1H&limit=250`;
        const r   = await fetch(url);
        const d   = await r.json();
        if (d.code !== "00000" || !d.data?.length) { results.push({ symbol: sym, error: "no data" }); return; }
        const candles = d.data.map(k => ({
          time: parseInt(k[0]), open: parseFloat(k[1]),
          high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
          volume: parseFloat(k[5] || 0),
        }));
        const s = scanSymbol(candles, emaRsiCfg, megaCfg, synapse7Cfg, synapseTCfg);
        results.push({ symbol: sym, ...s });
      } catch (e) {
        results.push({ symbol: sym, error: e.message });
      }
    }));
    if (i + BATCH < ALL_SYMBOLS.length) await new Promise(r => setTimeout(r, 200));
  }

  _scanCache   = { ts: new Date().toISOString(), results };
  _scanCacheTs = Date.now();
  _scanRunning = false;
  return _scanCache;
}

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

function renderHtml(allStats, allPositions, hb, rules = {}) {
  const tfMap = rules?.portfolio_timeframes || {};
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

  // Chart data — P&L bars + Win/Loss bars
  const chartLabels  = JSON.stringify(PORTFOLIO_DEFS.map(d => d.name));
  const chartPnl     = JSON.stringify(allStats.map(s => parseFloat(s.totalPnl.toFixed(2))));
  const chartPnlColors= JSON.stringify(allStats.map(s => s.totalPnl >= 0 ? "#00c48c" : "#ff4d4d"));
  const chartWins    = JSON.stringify(allStats.map(s => s.wins.length));
  const chartLosses  = JSON.stringify(allStats.map(s => s.losses.length));
  const chartWR      = JSON.stringify(allStats.map(s => s.winRate !== null ? parseFloat(s.winRate) : 0));
  const chartPortColors = JSON.stringify(PORTFOLIO_DEFS.map(d => d.color));

  // Portfolio comparison cards
  const cardsHtml = PORTFOLIO_DEFS.map((def, i) => {
    const s      = allStats[i];
    const pcts   = ((s.equity - START_CAPITAL) / START_CAPITAL * 100);
    const pctStr = (pcts >= 0 ? "+" : "") + pcts.toFixed(2) + "%";
    const eqCol  = s.equity >= START_CAPITAL ? "#00c48c" : "#ff4d4d";
    const openCount = allPositions[i].length;
    const tf = tfMap[def.id] || "1H";
    return `
    <div class="port-card" style="border-top:3px solid ${def.color}">
      <div class="port-header">
        <span style="font-size:22px">${def.emoji}</span>
        <div>
          <div class="port-name" style="color:${def.color}">${def.name}</div>
          <div class="port-subtitle">Portfolio ${i + 1} · ${tf} · SL ${def.id==="synapse_t"?"1.5":"2"}% / TP ${def.id==="synapse_t"?"3":"4"}% · 25x</div>
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
            <div><label>Margin (tvoj $)</label><span style="color:#f7b731;font-weight:700">$${(p.margin ?? p.totalUSD / 25).toFixed(2)}</span></div>
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
  .port-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:32px; }
  @media(max-width:1100px){ .port-grid { grid-template-columns:repeat(2,1fr); } }
  @media(max-width:600px){  .port-grid { grid-template-columns:1fr; } }
  .charts-row { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:32px; }
  @media(max-width:700px){ .charts-row { grid-template-columns:1fr; } }
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

  /* Scanner */
  .scan-card { background:var(--bg-secondary); border-radius:12px; padding:20px; border:1px solid var(--border); margin-bottom:32px; }
  .scan-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
  .scan-btn { background:var(--bg-tertiary); color:var(--text-primary); border:1px solid var(--border); border-radius:8px; padding:6px 16px; font-size:13px; font-weight:600; cursor:pointer; transition:all .2s; }
  .scan-btn:hover { border-color:var(--blue); color:var(--blue); }
  .scan-btn:disabled { opacity:.5; cursor:default; }
  .sig-long  { color:var(--green); font-weight:700; }
  .sig-short { color:var(--red);   font-weight:700; }
  .sig-none  { color:var(--text-muted); }
  .scan-table { width:100%; border-collapse:collapse; font-size:13px; }
  .scan-table th { padding:8px 10px; text-align:left; color:var(--text-muted); font-weight:600; font-size:11px; text-transform:uppercase; border-bottom:2px solid var(--border); white-space:nowrap; }
  .scan-table td { padding:7px 10px; border-bottom:1px solid var(--border); font-size:13px; }
  .scan-table tbody tr:hover td { background:var(--bg-tertiary); }
  .scan-table .any-signal td { background:rgba(56,139,253,0.04); }
  .spin { display:inline-block; animation:spin 1s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }

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
        <div class="subtitle">EMA+RSI(${tfMap.ema_rsi||"1H"}) · MEGA(${tfMap.mega||"15m"}) · 🧠SYNAPSE-7(${tfMap.synapse7||"15m"}) · 🎯SYNAPSE-T(${tfMap.synapse_t||"15m"}) &nbsp;|&nbsp; 25x</div>
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

  <!-- Charts row -->
  <div class="charts-row">
    <div class="chart-card" style="margin-bottom:0">
      <div class="chart-title">💰 P&amp;L po portfoliju</div>
      <div class="chart-wrap" style="height:200px"><canvas id="pnlChart"></canvas></div>
    </div>
    <div class="chart-card" style="margin-bottom:0">
      <div class="chart-title">📊 Wins / Losses / WR%</div>
      <div class="chart-wrap" style="height:200px"><canvas id="wrChart"></canvas></div>
    </div>
  </div>

  <!-- Live Scanner -->
  <div class="scan-card">
    <div class="scan-header">
      <div>
        <div class="chart-title" style="margin-bottom:2px">🔍 Live Scanner — 21 simbola × 4 strategije</div>
        <div style="font-size:12px;color:var(--text-muted)">Signal = EMA9/21 cross + filteri ispunjeni | Cache 90s</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span id="scan-ts" style="font-size:12px;color:var(--text-muted)">—</span>
        <button class="scan-btn" id="scan-btn" onclick="doScan()">🔄 Skeniraj</button>
      </div>
    </div>
    <div class="table-wrap">
      <table class="scan-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Symbol</th>
            <th>Cijena</th>
            <th>EMA</th>
            <th>RSI</th>
            <th>ADX</th>
            <th>Trend</th>
            <th style="color:#388bfd">📊 EMA+RSI</th>
            <th style="color:#00c48c">🚀 MEGA</th>
            <th style="color:#f7b731">🧠 SYNAPSE-7</th>
            <th style="color:#e85d9a">🎯 SYNAPSE-T</th>
          </tr>
        </thead>
        <tbody id="scan-tbody">
          <tr><td colspan="11" style="text-align:center;padding:24px;color:var(--text-muted)">Klikni "Skeniraj" za prikaz live signala</td></tr>
        </tbody>
      </table>
    </div>
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
// ── P&L Bar Chart ──────────────────────────────────────────────────────────────
(function(){
  const labels    = ${chartLabels};
  const pnlData   = ${chartPnl};
  const pnlColors = ${chartPnlColors};
  const portColors= ${chartPortColors};
  new Chart(document.getElementById("pnlChart").getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Net P&L ($)",
        data: pnlData,
        backgroundColor: pnlColors,
        borderColor: pnlColors,
        borderWidth: 1,
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => (ctx.raw >= 0 ? "+" : "") + "$" + ctx.raw.toFixed(2) } }
      },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { display: false } },
        y: {
          ticks: { color: "#8b949e", callback: v => (v >= 0 ? "+" : "") + "$" + v.toFixed(2) },
          grid: { color: "#21262d" },
          border: { dash: [4, 4] }
        }
      }
    }
  });
})();

// ── Win/Loss/WR Chart ──────────────────────────────────────────────────────────
(function(){
  const labels    = ${chartLabels};
  const wins      = ${chartWins};
  const losses    = ${chartLosses};
  const wrData    = ${chartWR};
  const portColors= ${chartPortColors};
  new Chart(document.getElementById("wrChart").getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Wins",   data: wins,   backgroundColor: "#00c48c99", borderColor: "#00c48c", borderWidth:1, borderRadius:4, stack:"trades" },
        { label: "Losses", data: losses, backgroundColor: "#ff4d4d99", borderColor: "#ff4d4d", borderWidth:1, borderRadius:4, stack:"trades" },
        { label: "WR %",   data: wrData, backgroundColor: portColors.map(c => c + "55"), borderColor: portColors, borderWidth:2, borderRadius:4, type:"bar", yAxisID:"y2" }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#8b949e", boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === "WR %") return "WR: " + ctx.raw.toFixed(1) + "%";
              return ctx.dataset.label + ": " + ctx.raw;
            }
          }
        }
      },
      scales: {
        x:  { ticks: { color: "#8b949e" }, grid: { display: false }, stacked: true },
        y:  { ticks: { color: "#8b949e", stepSize: 1 }, grid: { color: "#21262d" }, stacked: true, title: { display: true, text: "Trades", color: "#8b949e", font: { size: 10 } } },
        y2: { position: "right", ticks: { color: "#8b949e", callback: v => v + "%" }, grid: { display: false }, min: 0, max: 100, title: { display: true, text: "WR %", color: "#8b949e", font: { size: 10 } } }
      }
    }
  });
})();

// Live Scanner
function sigHtml(s) {
  if (s === "LONG")    return '<span class="sig-long" title="Cross u zadnjih 5 barova + svi filteri OK">▲ LONG</span>';
  if (s === "SHORT")   return '<span class="sig-short" title="Cross u zadnjih 5 barova + svi filteri OK">▼ SHORT</span>';
  if (s === "SETUP↑")  return '<span style="color:#f0a500;font-weight:600" title="Svi filteri OK, čeka cross">◈ SETUP ↑</span>';
  if (s === "SETUP↓")  return '<span style="color:#f0a500;font-weight:600" title="Svi filteri OK, čeka cross">◈ SETUP ↓</span>';
  return '<span class="sig-none">—</span>';
}

function fmtLive(v) {
  if (!v && v !== 0) return "—";
  if (v >= 1000) return "$" + v.toFixed(2);
  if (v >= 1)    return "$" + v.toFixed(4);
  if (v >= 0.001) return "$" + v.toFixed(6);
  return "$" + v.toFixed(10);
}

async function doScan() {
  const btn = document.getElementById("scan-btn");
  const tbody = document.getElementById("scan-tbody");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⟳</span> Skenira...';
  tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:24px;color:#8b949e"><span class="spin">⟳</span> Fetcham 21 simbola na 1H...</td></tr>';

  try {
    const r = await fetch("/api/scan");
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    document.getElementById("scan-ts").textContent = "Ažurirano: " + (d.ts || "").slice(0,16).replace("T"," ") + " UTC";

    const results = d.results || [];

    // Priority sort: LONG/SHORT first, SETUP second, neutral last
    function priority(s) {
      const hasSignal = s.emaRsiSig==="LONG"||s.emaRsiSig==="SHORT"||s.megaSig==="LONG"||s.megaSig==="SHORT"||s.synapse7Sig==="LONG"||s.synapse7Sig==="SHORT"||s.synapseTSig==="LONG"||s.synapseTSig==="SHORT";
      const hasSetup  = s.emaRsiSig?.startsWith("SETUP")||s.megaSig?.startsWith("SETUP")||s.synapse7Sig?.startsWith("SETUP")||s.synapseTSig?.startsWith("SETUP");
      return hasSignal ? 0 : hasSetup ? 1 : 2;
    }
    results.sort((a, b) => priority(a) - priority(b));

    tbody.innerHTML = results.map((s, i) => {
      if (s.error) return '<tr><td colspan="11" style="color:#ff4d4d">' + s.symbol + ': ' + s.error + '</td></tr>';
      const hasSignal = ["LONG","SHORT"].includes(s.emaRsiSig) || ["LONG","SHORT"].includes(s.megaSig) || ["LONG","SHORT"].includes(s.synapse7Sig) || ["LONG","SHORT"].includes(s.synapseTSig);
      const hasSetup  = (s.emaRsiSig||"").startsWith("SETUP") || (s.megaSig||"").startsWith("SETUP") || (s.synapse7Sig||"").startsWith("SETUP") || (s.synapseTSig||"").startsWith("SETUP");
      const rowCls = hasSignal ? "any-signal" : "";
      const trendCol = s.trend && s.trend.includes("↑") ? "#00c48c" : s.trend && s.trend.includes("↓") ? "#ff4d4d" : "#8b949e";
      const rsiNum = parseFloat(s.rsi);
      const rsiCol = isNaN(rsiNum) ? "#8b949e" : rsiNum > 70 ? "#ff4d4d" : rsiNum < 30 ? "#00c48c" : "#e6edf3";
      const biasCol = s.emaBias === "↑" ? "#00c48c" : s.emaBias === "↓" ? "#ff4d4d" : "#8b949e";
      return '<tr class="' + rowCls + '">' +
        '<td style="color:#8b949e;font-size:11px">' + (i+1) + '</td>' +
        '<td style="font-weight:700">' + s.symbol + '</td>' +
        '<td style="font-weight:600">' + fmtLive(s.price) + '</td>' +
        '<td style="color:' + biasCol + ';font-weight:700;font-size:15px" title="EMA9 vs EMA21">' + (s.emaBias||"—") + '</td>' +
        '<td style="color:' + rsiCol + '">' + (s.rsi || "—") + '</td>' +
        '<td style="color:#8b949e">' + (s.adx || "—") + '</td>' +
        '<td style="color:' + trendCol + ';font-size:12px">' + (s.trend || "—") + '</td>' +
        '<td>' + sigHtml(s.emaRsiSig) + '</td>' +
        '<td>' + sigHtml(s.megaSig) + '</td>' +
        '<td>' + sigHtml(s.synapse7Sig) + '</td>' +
        '<td>' + sigHtml(s.synapseTSig) + '</td>' +
        '</tr>';
    }).join("");

    // Count
    const longs  = results.filter(s => s.emaRsiSig==="LONG"  || s.megaSig==="LONG"  || s.synapse7Sig==="LONG"  || s.synapseTSig==="LONG").length;
    const shorts = results.filter(s => s.emaRsiSig==="SHORT" || s.megaSig==="SHORT" || s.synapse7Sig==="SHORT" || s.synapseTSig==="SHORT").length;
    const setups = results.filter(s => (s.emaRsiSig||"").startsWith("SETUP") || (s.megaSig||"").startsWith("SETUP") || (s.synapse7Sig||"").startsWith("SETUP") || (s.synapseTSig||"").startsWith("SETUP")).length;
    document.getElementById("scan-ts").textContent += " | ▲ " + longs + " LONG · ▼ " + shorts + " SHORT · ◈ " + setups + " SETUP";

  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#ff4d4d">Greška: ' + e.message + '</td></tr>';
  }

  btn.disabled = false;
  btn.innerHTML = "🔄 Skeniraj";
}

// Auto-scan on load after 2s delay
setTimeout(doScan, 2000);
// Re-scan every 5 minutes
setInterval(doScan, 5 * 60 * 1000);
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

  // Scanner API
  if (url.pathname === "/api/scan") {
    // Return cached if < 90s old
    if (_scanCache && (Date.now() - _scanCacheTs) < 90000) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(_scanCache));
      return;
    }
    try {
      const rules = loadRules();
      const data  = await runScan(rules);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data || { ts: new Date().toISOString(), results: [] }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
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
  const dashRules    = loadRules();
  const html         = renderHtml(allStats, allPositions, hb, dashRules);
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
