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
  { id: "ema_rsi",   name: "EMA+RSI",   color: "#388bfd", emoji: "📊", startCapital: 1000, live: false },
  { id: "mega",      name: "MEGA",      color: "#00c48c", emoji: "🚀", startCapital: 1000, live: false },
  { id: "synapse7",  name: "SYNAPSE-7", color: "#f7b731", emoji: "🧠", startCapital: 1000, live: false },
  { id: "synapse_t", name: "ULTRA",     color: "#e85d9a", emoji: "🎯", startCapital:  356.80, live: false  },
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

// RSI full series (RMA metoda — identična bot.js)
function _rsiFullSeries(closes, p = 14) {
  const n = closes.length;
  const r = new Array(n).fill(null);
  if (n < p + 1) return r;
  const gains = [], losses = [];
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i-1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  let ag = gains.slice(0,p).reduce((a,b)=>a+b,0)/p;
  let al = losses.slice(0,p).reduce((a,b)=>a+b,0)/p;
  r[p] = al === 0 ? 100 : 100 - 100/(1+ag/al);
  for (let i = p; i < gains.length; i++) {
    ag = (ag*(p-1)+gains[i])/p;
    al = (al*(p-1)+losses[i])/p;
    r[i+1] = al === 0 ? 100 : 100 - 100/(1+ag/al);
  }
  return r;
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

function scanSymbol(candles, emaRsiCfg, megaCfg, synapse7Cfg = {}, ultraCfg = {}) {
  const closes = candles.map(c => c.close);
  const opens  = candles.map(c => c.open);
  const vols   = candles.map(c => c.volume || 0);
  const price  = closes[closes.length - 1];
  const n      = closes.length;

  // ── EMA series ──
  const e9Arr  = _emaSeries(closes, 9);
  const e21Arr = _emaSeries(closes, 21);
  const SCAN_BARS = 5;
  const { up: crossUp, dn: crossDown } = hadCross(e9Arr, e21Arr, SCAN_BARS);
  const { up: crossUp3, dn: crossDown3 } = hadCross(e9Arr, e21Arr, 3);

  const ema9   = e9Arr[n - 1];
  const ema21  = e21Arr[n - 1];
  const ema50  = _ema(closes, 50);
  const ema55  = _ema(closes, 55);
  const ema145 = _ema(closes, 145);
  const ema200 = _ema(closes, 200);
  const rsi    = _rsi(closes, 14);
  const adx    = _adx(candles, 14);
  const chop   = _chop(candles, 14);
  const macdH  = _macdHist(closes);
  const emaBias = ema9 && ema21 ? (ema9 > ema21 ? "↑" : "↓") : "—";

  // ── RSI series (za recovery detekciju) ──
  const rsiSeries = _rsiFullSeries(closes, 14);
  const rv  = rsiSeries[n-1] ?? (rsi ?? 50);
  const rv1 = rsiSeries[n-2] ?? rv;
  const rv2 = rsiSeries[n-3] ?? rv1;
  const rv3 = rsiSeries[n-4] ?? rv2;
  const rv4 = rsiSeries[n-5] ?? rv3;
  const rsiMin5    = Math.min(rv, rv1, rv2, rv3, rv4);
  const rsiMax5    = Math.max(rv, rv1, rv2, rv3, rv4);
  const rsiRising  = rv > rv1 && rv1 > rv2;
  const rsiFalling = rv < rv1 && rv1 < rv2;
  // RSI recovery signals (identično bot.js)
  const rsiRecovBull = rsiMin5 < 35 && rv > 35 && rsiRising;    // iz oversold
  const rsiRecovBear = rsiMax5 > 65 && rv < 65 && rsiFalling;   // iz overbought

  // ── CVD i volume (shared) ──
  const cvdLen = Math.min(20, n);
  let cvdSum = 0;
  for (let i = n - cvdLen; i < n; i++) {
    const sign = closes[i] > opens[i] ? 1 : closes[i] < opens[i] ? -1 : 0;
    cvdSum += sign * vols[i];
  }
  const volAvg20 = vols.slice(-20).reduce((a,b)=>a+b,0) / 20;

  // ── 6-Scale EMA (shared) ──
  const scales = [[3,11],[7,15],[13,21],[19,29],[29,47],[45,55]];
  let scaleUp = 0, scaleDn = 0;
  for (const [f, s] of scales) {
    const ef = _ema(closes, f), es = _ema(closes, s);
    if (ef && es) { if (ef > es) scaleUp++; else scaleDn++; }
  }

  // ── EMA+RSI signal ──
  let emaRsiSig = "—";
  if (ema9 && ema21 && ema50 && rsi !== null) {
    const { rsiLongLo=35, rsiLongHi=58, rsiShortLo=42, rsiShortHi=65 } = emaRsiCfg;
    if (crossUp   && price > ema50 && rsi >= rsiLongLo  && rsi <= rsiLongHi)  emaRsiSig = "LONG";
    if (crossDown && price < ema50 && rsi >= rsiShortLo && rsi <= rsiShortHi) emaRsiSig = "SHORT";
    if (emaRsiSig === "—") {
      if (price > ema50 && rsi >= rsiLongLo  && rsi <= rsiLongHi  && ema9 > ema21) emaRsiSig = "SETUP↑";
      if (price < ema50 && rsi >= rsiShortLo && rsi <= rsiShortHi && ema9 < ema21) emaRsiSig = "SETUP↓";
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
      if (tUp && rsi > rsiLongLo  && rsi < rsiLongHi  && ema9 > ema21 && trending && notChoppy) megaSig = "SETUP↑";
      if (tDn && rsi > rsiShortLo && rsi < rsiShortHi && ema9 < ema21 && trending && notChoppy) megaSig = "SETUP↓";
    }
  }

  // Trend label
  const trendLabel = ema55
    ? (price > ema55
        ? (ema200 ? (price > ema200 ? "↑↑ Bull" : "↑ Weak") : "↑ Bull")
        : (ema200 ? (price < ema200 ? "↓↓ Bear" : "↓ Weak") : "↓ Bear"))
    : "—";

  // ── SYNAPSE-7 — 5 sub-signals (s novim RSI recovery signalom) ──
  let synapse7Sig = "—";
  let synapse7Bull = 0, synapse7Bear = 0;
  let synapse7Subs = { scale: 0, rsi: 0, cvd: 0, trend: 0, ema: 0 };
  {
    const { minSig = 3 } = synapse7Cfg;
    const scaleSig = scaleUp >= 4 ? 1 : scaleDn >= 4 ? -1 : 0;
    // RSI recovery signal (isto kao bot.js)
    const rsiRecSig = rsiRecovBull ? 1 : rsiRecovBear ? -1 : 0;
    const cvdSig    = cvdSum > 0 ? 1 : cvdSum < 0 ? -1 : 0;
    const trendSig  = (ema55 && price > ema55) ? 1 : (ema55 && price < ema55) ? -1 : 0;
    const adxSig    = (adx && adx > 20) ? (ema9 > ema21 ? 1 : -1) : 0;

    const subs = [scaleSig, rsiRecSig, cvdSig, trendSig, adxSig];
    synapse7Bull = subs.filter(v => v === 1).length;
    synapse7Bear = subs.filter(v => v === -1).length;
    synapse7Subs = { scale: scaleSig, rsi: rsiRecSig, cvd: cvdSig, trend: trendSig, ema: adxSig };

    if      (synapse7Bull >= minSig) synapse7Sig = "LONG";
    else if (synapse7Bear >= minSig) synapse7Sig = "SHORT";
    else if (synapse7Bull === minSig - 1 && scaleUp >= 3) synapse7Sig = "SETUP↑";
    else if (synapse7Bear === minSig - 1 && scaleDn >= 3) synapse7Sig = "SETUP↓";
  }

  // ── ULTRA — 13 signala (identično bot.js analyzeUltra) ──
  let ultraSig = "—";
  let ultraBull = 0, ultraBear = 0;
  let ultraSigs13 = new Array(13).fill(0);
  {
    const { minSig = 8 } = ultraCfg;
    if (n >= 200 && ema9 && ema21) {
      const rsiV  = rsi ?? 50;
      const adxV  = adx ?? 0;
      const chopV = chop ?? 100;

      ultraSigs13 = [
        ema9 > ema21 ? 1 : -1,                                          // 1. EMA9/21 smjer
        crossUp3 ? 1 : crossDown3 ? -1 : 0,                             // 2. Svježi cross (3 bara)
        ema50 ? (price > ema50 ? 1 : -1) : 0,                           // 3. Cijena vs EMA50
        (rsiV < 50 && rsiV > 30) ? 1 : (rsiV > 50 && rsiV < 70) ? -1 : 0, // 4. RSI zona
        ema55 ? (price > ema55 ? 1 : -1) : 0,                           // 5. Cijena vs EMA55
        adxV > 18 ? 1 : 0,                                               // 6. ADX > 18
        chopV < 61.8 ? 1 : -1,                                           // 7. Nije choppy
        (scaleUp >= 4 ? 1 : scaleDn >= 4 ? -1 : 0),                     // 8. 6-Scale EMA
        cvdSum > 0 ? 1 : -1,                                             // 9. CVD volumen
        rsiRecovBull ? 1 : rsiRecovBear ? -1 : 0,                        // 10. RSI recovery
        macdH !== null ? (macdH > 0 ? 1 : -1) : 0,                      // 11. MACD histogram
        ema145 ? (price > ema145 ? 1 : -1) : 0,                         // 12. EMA145 trend
        vols[n-1] > volAvg20 ? 1 : 0,                                    // 13. Volumen iznad prosjeka
      ];

      ultraBull = ultraSigs13.filter(s => s === 1).length;
      ultraBear = ultraSigs13.filter(s => s === -1).length;

      if      (ultraBull >= minSig) ultraSig = "LONG";
      else if (ultraBear >= minSig) ultraSig = "SHORT";
      else if (ultraBull === minSig - 1) ultraSig = "SETUP↑";
      else if (ultraBear === minSig - 1) ultraSig = "SETUP↓";
    }
  }

  return {
    price, emaBias,
    rsi: rsi?.toFixed(1) ?? "—",
    adx: adx?.toFixed(1) ?? "—",
    chop: chop?.toFixed(1) ?? "—",
    trend: trendLabel,
    emaRsiSig, megaSig,
    synapse7Sig, synapse7Bull, synapse7Bear, synapse7Subs,
    ultraSig, ultraBull, ultraBear, ultraSigs13,
    // backward compat (doScan JS koristi synapseTSig)
    synapseTSig: ultraSig,
  };
}

// ─── Scanner cache ─────────────────────────────────────────────────────────────

let _scanCache    = null;
let _scanCacheTs  = 0;
let _scanRunning  = false;

async function runScan(rules) {
  if (_scanRunning) return _scanCache;
  _scanRunning = true;
  const cfg     = rules?.strategies || {};
  const ultraCfg = cfg.synapse_t?.params || {};

  // Učitaj pending pullback podatke
  const pendingFile = `${DATA_DIR}/pending_synapse_t.json`;
  let pendingList = [];
  try {
    if (existsSync(pendingFile)) {
      pendingList = JSON.parse(readFileSync(pendingFile, "utf8"));
      // Makni istekle (TTL 4h)
      const now = Date.now();
      pendingList = pendingList.filter(p => now - p.ts < 4 * 60 * 60 * 1000);
    }
  } catch { /* ignoriraj */ }

  const results = [];
  const BATCH = 5;
  for (let i = 0; i < ALL_SYMBOLS.length; i += BATCH) {
    const batch = ALL_SYMBOLS.slice(i, i + BATCH);
    await Promise.all(batch.map(async sym => {
      try {
        const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=15m&limit=250`;
        const r   = await fetch(url);
        const d   = await r.json();
        if (d.code !== "00000" || !d.data?.length) { results.push({ symbol: sym, error: "no data" }); return; }
        const candles = d.data.map(k => ({
          time: parseInt(k[0]), open: parseFloat(k[1]),
          high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
          volume: parseFloat(k[5] || 0),
        }));
        const s       = scanSymbol(candles, {}, {}, {}, ultraCfg);
        const pending = pendingList.find(p => p.symbol === sym) || null;
        results.push({ symbol: sym, ...s, pending });
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
  const def   = PORTFOLIO_DEFS.find(d => d.id === pid) || {};
  const startCap = def.startCapital ?? START_CAPITAL;

  const rows  = parseCsvFile(pid);
  const exits = rows.filter(r => r["Side"] === "CLOSE_LONG" || r["Side"] === "CLOSE_SHORT");
  const entries= rows.filter(r => r["Side"] === "LONG" || r["Side"] === "SHORT");

  const wins     = exits.filter(r => parseFloat(r["Net P&L"] || 0) >= 0);
  const losses   = exits.filter(r => parseFloat(r["Net P&L"] || 0) < 0);
  const totalPnl = exits.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0);
  const winRate  = exits.length > 0 ? (wins.length / exits.length * 100).toFixed(1) : null;
  const equity   = startCap + totalPnl;

  // P&L curve
  const pnlCurve = [];
  let running = startCap;
  exits.forEach(r => {
    running += parseFloat(r["Net P&L"] || 0);
    pnlCurve.push({ ts: r["Date"] + " " + r["Time (UTC)"], equity: parseFloat(running.toFixed(4)) });
  });
  if (pnlCurve.length === 0) pnlCurve.push({ ts: "start", equity: startCap });

  // Recent 20 closed trades
  const recentExits = [...exits].reverse().slice(0, 20);

  return { pid, startCap, rows, exits, entries, wins, losses, totalPnl, winRate, equity, pnlCurve, recentExits };
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
    const pcts   = ((s.equity - def.startCapital) / def.startCapital * 100);
    const pctStr = (pcts >= 0 ? "+" : "") + pcts.toFixed(2) + "%";
    const eqCol  = s.equity >= def.startCapital ? "#00c48c" : "#ff4d4d";
    const openCount = allPositions[i].length;
    const tf = tfMap[def.id] || "1H";
    const modeBadge = def.live
      ? `<span class="badge" style="background:rgba(255,77,77,0.15);color:#ff4d4d;border:1px solid #ff4d4d;font-size:10px;padding:2px 7px">🔴 LIVE</span>`
      : `<span class="badge badge-paper" style="font-size:10px;padding:2px 7px">PAPER</span>`;
    return `
    <div class="port-card" style="border-top:3px solid ${def.color}">
      <div class="port-header">
        <span style="font-size:22px">${def.emoji}</span>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="port-name" style="color:${def.color}">${def.name}</div>
            ${modeBadge}
          </div>
          <div class="port-subtitle">Portfolio ${i + 1} · ${tf} · SL ${def.id==="synapse_t"?"1":"2"}% / TP ${def.id==="synapse_t"?"2":"4"}% · 30x</div>
        </div>
      </div>
      <div class="port-equity" style="color:${eqCol}">$${s.equity.toFixed(2)}</div>
      <div class="port-return" style="color:${eqCol}">${pctStr}</div>
      <div class="port-row"><span class="muted">Start</span><span>$${def.startCapital.toFixed(0)}</span></div>
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
        <div class="subtitle">EMA+RSI(${tfMap.ema_rsi||"1H"}) · MEGA(${tfMap.mega||"15m"}) · 🧠SYNAPSE-7(${tfMap.synapse7||"15m"}) · 🎯ULTRA(${tfMap.synapse_t||"15m"}) &nbsp;|&nbsp; 30x</div>
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

  <!-- Live Scanner ULTRA -->
  <div class="scan-card">
    <div class="scan-header">
      <div>
        <div class="chart-title" style="margin-bottom:2px">🎯 ULTRA Scanner — ${ALL_SYMBOLS.length} simbola | 13 signala | min 8/13 | pullback 1%</div>
        <div style="font-size:12px;color:var(--text-muted)">
          <span style="color:#00c48c">▲</span> EMA dir &nbsp;
          <span style="color:#e85d9a">✦</span> Cross &nbsp;
          <span style="color:#388bfd">E50</span> &nbsp;
          <span style="color:#f7b731">RSI</span> &nbsp;
          <span style="color:#388bfd">E55</span> &nbsp;
          ADX &nbsp; CHP &nbsp;
          <span style="color:#f7b731">6Sc</span> &nbsp;
          CVD &nbsp;
          <span style="color:#00c48c">R⟳</span> &nbsp;
          MACD &nbsp;
          <span style="color:#bc8cff">E145</span> &nbsp;
          VOL
          &nbsp;|&nbsp; 🟡 Čeka pullback &nbsp; 🟢 Signal &nbsp; Cache 90s
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span id="scan-ts" style="font-size:12px;color:var(--text-muted)">—</span>
        <button class="scan-btn" id="scan-btn" onclick="doScan()">🔄 Skeniraj</button>
        <button class="scan-btn" style="border-color:#f85149;color:#f85149" onclick="resetAll()">🗑️ Reset SVE</button>
        <button class="scan-btn" style="border-color:#e85d9a;color:#e85d9a" onclick="resetOne('synapse_t')">🎯 Reset ULTRA</button>
      </div>
    </div>
    <div class="table-wrap">
      <table class="scan-table" id="scan-table">
        <thead>
          <tr>
            <th style="width:28px">#</th>
            <th>Symbol</th>
            <th>Cijena</th>
            <th style="color:#8b949e">RSI</th>
            <th style="color:#8b949e">ADX</th>
            <th style="color:#e85d9a;text-align:center">13 Signala &nbsp;<span style="font-weight:400;font-size:10px;color:#666">EMA · CRS · E50 · RSI · E55 · ADX · CHP · 6Sc · CVD · R⟳ · MCD · E145 · VOL</span></th>
            <th style="color:#e85d9a;text-align:center">Score</th>
            <th style="min-width:260px">Status / Pullback</th>
          </tr>
        </thead>
        <tbody id="scan-tbody">
          <tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">Klikni "Skeniraj" za prikaz ULTRA signala</td></tr>
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

// SYNAPSE-7: prikaz 5 sub-signala sa score-om
function synapse7Html(s) {
  const bull = s.synapse7Bull || 0;
  const bear = s.synapse7Bear || 0;
  const subs = s.synapse7Subs || {};
  const sig  = s.synapse7Sig || "—";

  const names5 = ['6Sc','RSI⟳','CVD','Tr','ADX'];
  const vals5  = [subs.scale, subs.rsi, subs.cvd, subs.trend, subs.ema];
  const tooltipText = names5.map((l,i) => l+':'+(vals5[i]===1?'↑':vals5[i]===-1?'↓':'·')).join(' | ');

  const dots5 = vals5.map((v,i) => {
    const col = v===1?'#00c48c':v===-1?'#ff4d4d':'#444';
    return '<span title="'+names5[i]+'" style="color:'+col+';font-size:10px">'+(v===1?'▲':v===-1?'▼':'·')+'</span>';
  }).join('');

  const scoreStr = bull > bear
    ? '<span style="color:#00c48c;font-weight:700">↑'+bull+'/5</span>'
    : bear > bull
    ? '<span style="color:#ff4d4d;font-weight:700">↓'+bear+'/5</span>'
    : '<span style="color:#8b949e">'+Math.max(bull,bear)+'/5</span>';

  const sigPart = sig==="LONG"   ? ' <span class="sig-long">▲</span>'
                : sig==="SHORT"  ? ' <span class="sig-short">▼</span>'
                : sig==="SETUP↑" ? ' <span style="color:#f0a500">◈↑</span>'
                : sig==="SETUP↓" ? ' <span style="color:#f0a500">◈↓</span>' : '';

  return '<span title="'+tooltipText+'" style="font-size:12px">'+scoreStr+sigPart+'<br>'+dots5+'</span>';
}

// ULTRA: prikaz svih 13 signala
function ultraHtml(s) {
  const bull  = s.ultraBull ?? 0;
  const bear  = s.ultraBear ?? 0;
  const sig13 = s.ultraSigs13 || new Array(13).fill(0);
  const sig   = s.ultraSig || "—";

  if (!s.ultraSigs13) return '<span style="color:#555;font-size:11px">—</span>';

  const names13 = ['EMA dir','Cross','P>E50','RSI zona','P>E55','ADX>18','Chop','6Sc','CVD','RSI⟳','MACD','E145','Vol'];
  const tooltipText = names13.map((l,i)=>l+':'+(sig13[i]===1?'↑':sig13[i]===-1?'↓':'·')).join(' | ');

  const dots = sig13.map((v, i) => {
    const col = v===1?'#00c48c':v===-1?'#ff4d4d':'#444';
    return '<span title="'+names13[i]+'" style="color:'+col+';font-size:9px">'+(v===1?'▲':v===-1?'▼':'·')+'</span>';
  }).join('');

  const scoreStr = bull > bear
    ? '<span style="color:#00c48c;font-weight:700">↑'+bull+'/13</span>'
    : bear > bull
    ? '<span style="color:#ff4d4d;font-weight:700">↓'+bear+'/13</span>'
    : '<span style="color:#8b949e">'+Math.max(bull,bear)+'/13</span>';

  const sigPart = sig==="LONG"   ? ' <span class="sig-long">▲ LONG</span>'
                : sig==="SHORT"  ? ' <span class="sig-short">▼ SHORT</span>'
                : sig==="SETUP↑" ? ' <span style="color:#f0a500;font-weight:600">◈↑</span>'
                : sig==="SETUP↓" ? ' <span style="color:#f0a500;font-weight:600">◈↓</span>' : '';

  return '<span title="'+tooltipText+'" style="font-size:12px">'+scoreStr+sigPart+'<br><span style="letter-spacing:1px">'+dots+'</span></span>';
}

function fmtLive(v) {
  if (!v && v !== 0) return "—";
  if (v >= 1000) return "$" + v.toFixed(2);
  if (v >= 1)    return "$" + v.toFixed(4);
  if (v >= 0.001) return "$" + v.toFixed(6);
  return "$" + v.toFixed(10);
}

async function resetAll() {
  if (!confirm("Resetirati SVE portfolije? Briše se cijela povijest i otvorene pozicije.")) return;
  const r = await fetch("/api/reset-full", { method: "POST", headers: {"Content-Type":"application/json"}, body: "{}" });
  const d = await r.json();
  alert(d.message || "Reset done");
  location.reload();
}

async function resetOne(pid) {
  if (!confirm("Resetirati " + pid + "? Briše se povijest i pozicije za taj portfolio.")) return;
  const r = await fetch("/api/reset-full", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({pid}) });
  const d = await r.json();
  alert(d.message || "Reset done");
  location.reload();
}

// ── Signal label boxes (13 signals) ──────────────────────────────────────────
const SIG_NAMES = ['EMA','CRS','E50','RSI','E55','ADX','CHP','6Sc','CVD','R⟳','MCD','E145','VOL'];

function sigBoxes(sig13) {
  if (!sig13 || sig13.length === 0) return '<span style="color:#444">—</span>';
  return sig13.map((v, i) => {
    const bg  = v === 1 ? '#0d3d26' : v === -1 ? '#3d0d0d' : '#1c2128';
    const col = v === 1 ? '#00c48c' : v === -1 ? '#ff4d4d' : '#444';
    const bdr = v === 1 ? '1px solid #00c48c44' : v === -1 ? '1px solid #ff4d4d44' : '1px solid #30363d';
    const icon = v === 1 ? '▲' : v === -1 ? '▼' : '·';
    return '<span title="' + SIG_NAMES[i] + '" style="display:inline-block;background:' + bg + ';color:' + col + ';border:' + bdr + ';padding:2px 5px;font-size:10px;font-weight:700;border-radius:3px;margin:1px;min-width:32px;text-align:center">' + SIG_NAMES[i] + '<br><span style="font-size:9px">' + icon + '</span></span>';
  }).join('');
}

function scoreBox(bull, bear, sig) {
  const total = 13;
  if (sig === "LONG")   return '<div style="background:rgba(0,196,140,0.15);border:1px solid #00c48c;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#00c48c;font-weight:800;font-size:16px">↑' + bull + '</span><span style="color:#555;font-size:11px">/' + total + '</span><br><span class="sig-long" style="font-size:11px">▲ LONG</span></div>';
  if (sig === "SHORT")  return '<div style="background:rgba(255,77,77,0.15);border:1px solid #ff4d4d;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#ff4d4d;font-weight:800;font-size:16px">↓' + bear + '</span><span style="color:#555;font-size:11px">/' + total + '</span><br><span class="sig-short" style="font-size:11px">▼ SHORT</span></div>';
  if (sig === "SETUP↑") return '<div style="background:rgba(240,165,0,0.1);border:1px solid #f0a50066;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#f0a500;font-weight:800;font-size:16px">↑' + bull + '</span><span style="color:#555;font-size:11px">/' + total + '</span><br><span style="color:#f0a500;font-size:11px">◈ SETUP↑</span></div>';
  if (sig === "SETUP↓") return '<div style="background:rgba(240,165,0,0.1);border:1px solid #f0a50066;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#f0a500;font-weight:800;font-size:16px">↓' + bear + '</span><span style="color:#555;font-size:11px">/' + total + '</span><br><span style="color:#f0a500;font-size:11px">◈ SETUP↓</span></div>';
  const top = Math.max(bull, bear);
  const col = bull > bear ? '#00c48c55' : bear > bull ? '#ff4d4d55' : '#555';
  return '<div style="text-align:center"><span style="color:' + col + ';font-size:14px">' + top + '</span><span style="color:#444;font-size:11px">/' + total + '</span></div>';
}

function statusBox(s) {
  const p   = s.pending;
  const sig = s.ultraSig;

  // Pending pullback — čekamo ulaz
  if (p) {
    const ageMs  = Date.now() - p.ts;
    const ageMin = Math.floor(ageMs / 60000);
    const ageStr = ageMin < 60 ? ageMin + 'm' : Math.floor(ageMin/60) + 'h ' + (ageMin%60) + 'm';
    const pct = p.side === "LONG"
      ? ((s.price - p.targetPrice) / p.targetPrice * 100).toFixed(2)
      : ((p.targetPrice - s.price) / p.targetPrice * 100).toFixed(2);
    const pctNum = parseFloat(pct);
    const pctCol = pctNum < 0.3 ? '#ff4d4d' : pctNum < 0.6 ? '#f7b731' : '#8b949e';
    const sigCol = p.side === "LONG" ? '#00c48c' : '#ff4d4d';
    const sigIco = p.side === "LONG" ? '▲' : '▼';
    return '<div style="background:rgba(247,183,49,0.08);border:1px solid #f7b73166;border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#f7b731;font-weight:700;margin-bottom:4px">⏳ ČEKA PULLBACK</div>' +
      '<div style="font-size:12px"><span style="color:' + sigCol + ';font-weight:700">' + sigIco + ' ' + p.side + '</span> signal @ <b>' + fmtLive(p.signalPrice) + '</b></div>' +
      '<div style="font-size:12px;margin-top:2px">Target: <span style="color:#e85d9a;font-weight:700">' + fmtLive(p.targetPrice) + '</span> &nbsp;|&nbsp; Sad: ' + fmtLive(s.price) + '</div>' +
      '<div style="font-size:11px;margin-top:3px;color:#8b949e">Čeka: <b style="color:#e6edf3">' + ageStr + '</b> &nbsp;|&nbsp; Još: <b style="color:' + pctCol + '">' + pct + '%</b></div>' +
      '</div>';
  }

  // Aktivan signal — spreman za ulaz (bot će ga pohraniti u pending)
  if (sig === "LONG") {
    return '<div style="background:rgba(0,196,140,0.1);border:1px solid #00c48c;border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#00c48c;font-weight:700;margin-bottom:4px">✅ SIGNAL AKTIVIRAN</div>' +
      '<div style="font-size:13px;font-weight:700;color:#00c48c">▲ LONG</div>' +
      '<div style="font-size:11px;color:#8b949e;margin-top:3px">Signal @ ' + fmtLive(s.price) + '</div>' +
      '<div style="font-size:11px;color:#8b949e">Pullback target: ' + fmtLive(s.price * 0.99) + ' (-1%)</div>' +
      '</div>';
  }
  if (sig === "SHORT") {
    return '<div style="background:rgba(255,77,77,0.1);border:1px solid #ff4d4d;border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#ff4d4d;font-weight:700;margin-bottom:4px">✅ SIGNAL AKTIVIRAN</div>' +
      '<div style="font-size:13px;font-weight:700;color:#ff4d4d">▼ SHORT</div>' +
      '<div style="font-size:11px;color:#8b949e;margin-top:3px">Signal @ ' + fmtLive(s.price) + '</div>' +
      '<div style="font-size:11px;color:#8b949e">Pullback target: ' + fmtLive(s.price * 1.01) + ' (+1%)</div>' +
      '</div>';
  }
  if (sig === "SETUP↑") return '<span style="color:#f0a500;font-size:12px">◈ SETUP ↑ &nbsp;<span style="color:#555;font-size:11px">(' + (s.ultraBull||0) + '/13)</span></span>';
  if (sig === "SETUP↓") return '<span style="color:#f0a500;font-size:12px">◈ SETUP ↓ &nbsp;<span style="color:#555;font-size:11px">(' + (s.ultraBear||0) + '/13)</span></span>';
  return '<span style="color:#444;font-size:12px">—</span>';
}

async function doScan() {
  const btn   = document.getElementById("scan-btn");
  const tbody = document.getElementById("scan-tbody");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⟳</span> Skenira...';
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:#8b949e"><span class="spin" style="font-size:20px">⟳</span><br>Fetcham ${ALL_SYMBOLS.length} simbola na 15m TF...</td></tr>';

  try {
    const r = await fetch("/api/scan");
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    const ts = (d.ts || "").slice(0,16).replace("T"," ");
    const results = d.results || [];

    // Sort: pending first, then signal, then setup, then score desc, then neutral
    results.sort((a, b) => {
      function rank(s) {
        if (s.pending) return 0;
        if (s.ultraSig === "LONG" || s.ultraSig === "SHORT") return 1;
        if ((s.ultraSig||"").startsWith("SETUP")) return 2;
        return 3 + (13 - Math.max(s.ultraBull||0, s.ultraBear||0));
      }
      return rank(a) - rank(b);
    });

    const longs   = results.filter(s => s.ultraSig === "LONG").length;
    const shorts  = results.filter(s => s.ultraSig === "SHORT").length;
    const pending = results.filter(s => s.pending).length;
    const setups  = results.filter(s => (s.ultraSig||"").startsWith("SETUP")).length;
    document.getElementById("scan-ts").textContent = ts + " UTC | ▲ " + longs + " LONG · ▼ " + shorts + " SHORT · ⏳ " + pending + " čeka · ◈ " + setups + " setup";

    tbody.innerHTML = results.map((s, i) => {
      if (s.error) return '<tr><td colspan="8" style="color:#ff4d4d;padding:6px 10px">' + s.symbol + ': ' + s.error + '</td></tr>';

      const rsiNum = parseFloat(s.rsi);
      const rsiCol = isNaN(rsiNum) ? "#8b949e" : rsiNum > 70 ? "#ff4d4d" : rsiNum < 30 ? "#00c48c" : rsiNum > 60 ? "#ff8c42" : rsiNum < 40 ? "#42c8ff" : "#e6edf3";
      const adxNum = parseFloat(s.adx);
      const adxCol = isNaN(adxNum) ? "#555" : adxNum > 25 ? "#00c48c" : adxNum > 18 ? "#f7b731" : "#555";

      const hasPending = !!s.pending;
      const hasSignal  = s.ultraSig === "LONG" || s.ultraSig === "SHORT";
      const rowBg = hasPending ? "background:rgba(247,183,49,0.04)" : hasSignal ? "background:rgba(0,196,140,0.04)" : "";

      return '<tr style="' + rowBg + '">' +
        '<td style="color:#555;font-size:11px;text-align:center">' + (i+1) + '</td>' +
        '<td style="font-weight:800;font-size:14px;white-space:nowrap">' + s.symbol.replace("USDT","") + '<span style="color:#555;font-size:10px;font-weight:400">USDT</span></td>' +
        '<td style="font-weight:600;white-space:nowrap">' + fmtLive(s.price) + '</td>' +
        '<td style="color:' + rsiCol + ';font-weight:700">' + (s.rsi || "—") + '</td>' +
        '<td style="color:' + adxCol + '">' + (s.adx || "—") + '</td>' +
        '<td style="padding:4px 6px">' + sigBoxes(s.ultraSigs13) + '</td>' +
        '<td style="padding:4px 8px">' + scoreBox(s.ultraBull||0, s.ultraBear||0, s.ultraSig) + '</td>' +
        '<td style="padding:4px 8px">' + statusBox(s) + '</td>' +
        '</tr>';
    }).join("");

  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#ff4d4d;padding:24px">Greška: ' + e.message + '</td></tr>';
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

  // Reset positions (samo otvorene)
  if (url.pathname === "/api/reset-positions" && req.method === "POST") {
    for (const def of PORTFOLIO_DEFS) {
      writeFileSync(`${DATA_DIR}/open_positions_${def.id}.json`, "[]");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: `${PORTFOLIO_DEFS.length} portfolia resetirana (samo open)`, timestamp: new Date().toISOString() }));
    return;
  }

  // Full reset — briše i CSV povijest i open pozicije za sve ili jedan portfolio
  if (url.pathname === "/api/reset-full" && req.method === "POST") {
    const CSV_HEADERS = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net P&L,SL,TP,Order ID,Mode,Portfolio,Notes";
    const body = await new Promise(r => { let d=""; req.on("data",c=>d+=c); req.on("end",()=>r(d)); });
    let pid = null;
    try { pid = JSON.parse(body).pid; } catch {}
    const targets = pid ? PORTFOLIO_DEFS.filter(d => d.id === pid) : PORTFOLIO_DEFS;
    for (const def of targets) {
      writeFileSync(`${DATA_DIR}/open_positions_${def.id}.json`, "[]");
      writeFileSync(`${DATA_DIR}/trades_${def.id}.csv`, CSV_HEADERS + "\n");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: `Full reset — ${targets.map(d=>d.id).join(", ")}`, timestamp: new Date().toISOString() }));
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
