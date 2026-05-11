/**
 * Trading Bot Dashboard — 3-Portfolio Mode
 * EMA+RSI | 3-Layer | MEGA — svaki portfolio $1000 start
 */

import "dotenv/config";
import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { run as botRun, checkBreakouts, syncPositionsFromBitget } from "./bot.js";

const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : ".");
const START_CAPITAL = 1000;

const PORTFOLIO_DEFS = [
  { id: "synapse_t", name: "ULTRA", color: "#e85d9a", emoji: "🎯", startCapital: 296.99, live: true },
];

// ─── All symbols — čita iz rules.json (lazily, nakon što loadRules bude definiran) ─
// Placeholder — pravi ALL_SYMBOLS se postavlja na dnu, nakon definicije loadRules
let ALL_SYMBOLS = [];

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

// Returns last `tail` histogram values efficiently (O(n) EMA series)
function _macdHistTail(closes, tail=3, fast=12, slow=26, sig=9) {
  const n = closes.length;
  if (n < slow+sig+tail) return new Array(tail).fill(null);
  // Fast EMA series
  const fk = 2/(fast+1);
  let fv = closes.slice(0, fast).reduce((a,b)=>a+b,0)/fast;
  const fArr = new Array(n).fill(null); fArr[fast-1] = fv;
  for (let i = fast; i < n; i++) { fv = closes[i]*fk + fv*(1-fk); fArr[i] = fv; }
  // Slow EMA series
  const sk = 2/(slow+1);
  let sv = closes.slice(0, slow).reduce((a,b)=>a+b,0)/slow;
  const sArr = new Array(n).fill(null); sArr[slow-1] = sv;
  for (let i = slow; i < n; i++) { sv = closes[i]*sk + sv*(1-sk); sArr[i] = sv; }
  // MACD line
  const diffs = [];
  for (let i = slow-1; i < n; i++) {
    if (fArr[i] !== null && sArr[i] !== null) diffs.push(fArr[i] - sArr[i]);
  }
  // Signal line series
  if (diffs.length < sig) return new Array(tail).fill(null);
  const sigK = 2/(sig+1);
  let sgv = diffs.slice(0, sig).reduce((a,b)=>a+b,0)/sig;
  const histArr = [];
  for (let j = sig; j < diffs.length; j++) {
    sgv = diffs[j]*sigK + sgv*(1-sigK);
    histArr.push(diffs[j] - sgv);
  }
  // Return last `tail` values
  return histArr.slice(-tail);
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
  // MACD cross: histogram changed sign in last 3 bars
  const macdTail = _macdHistTail(closes, 4);  // last 4 histogram values
  let macdCrossUp = false, macdCrossDn = false;
  for (let _k = 1; _k < macdTail.length; _k++) {
    const hc = macdTail[_k], hp = macdTail[_k-1];
    if (hc !== null && hp !== null) {
      if (hc > 0 && hp <= 0) macdCrossUp = true;
      if (hc < 0 && hp >= 0) macdCrossDn = true;
    }
  }
  const macdCrossV = macdCrossUp ? 1 : macdCrossDn ? -1 : 0;
  const emaBias = ema9 && ema21 ? (ema9 > ema21 ? "↑" : "↓") : "—";

  // ── Support / Resistance (pivot-based, 80 bara, pivotN=4) ──────────────────
  const _pivN = 4, _srLB = 80;
  const _srS  = Math.max(_pivN, n - _srLB);
  const _srE  = n - _pivN - 1;
  const _ress = [], _sups = [];
  for (let i = _srS; i <= _srE; i++) {
    let ph = true, pl = true;
    for (let j = i - _pivN; j <= i + _pivN; j++) {
      if (j === i || j < 0 || j >= n) continue;
      if (candles[j].high >= candles[i].high) ph = false;
      if (candles[j].low  <= candles[i].low)  pl = false;
    }
    if (ph) _ress.push(candles[i].high);
    if (pl) _sups.push(candles[i].low);
  }
  const _price   = closes[n - 1];
  const _nearRes = _ress.filter(r => r > _price * 1.001).sort((a,b) => a-b)[0] ?? null;
  const _nearSup = _sups.filter(s => s < _price * 0.999).sort((a,b) => b-a)[0] ?? null;
  const _srZone  = 0.012;
  // rsiRising/rsiFalling potrebni za sig17
  const _rsiArr  = [_rsi(closes, 14), _rsi(closes.slice(0,-1), 14), _rsi(closes.slice(0,-2), 14)];
  const _rsiR    = _rsiArr[0] !== null && _rsiArr[1] !== null && _rsiArr[0] > _rsiArr[1] && _rsiArr[1] > _rsiArr[2];
  const _rsiF    = _rsiArr[0] !== null && _rsiArr[1] !== null && _rsiArr[0] < _rsiArr[1] && _rsiArr[1] < _rsiArr[2];
  let srsBounce  = 0;
  if (_nearSup !== null && (_price - _nearSup) / _price < _srZone && _rsiR) srsBounce =  1;
  if (_nearRes !== null && (_nearRes - _price) / _price < _srZone && _rsiF) srsBounce = -1;
  let srbBreak   = 0;
  for (let k = Math.max(1, n - 3); k < n && srbBreak === 0; k++) {
    for (const r of _ress) if (closes[k-1] < r && closes[k] > r) { srbBreak =  1; break; }
    for (const s of _sups) if (closes[k-1] > s && closes[k] < s) { srbBreak = -1; break; }
  }

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

  // ── ULTRA — 16 signala (identično bot.js analyzeUltra) ──
  let ultraSig = "—";
  let ultraBull = 0, ultraBear = 0;
  let ultraSigs16 = new Array(18).fill(0);
  {
    const { minSig = 9 } = ultraCfg;
    if (n >= 200 && ema9 && ema21) {
      const rsiV  = rsi ?? 50;
      const adxV  = adx ?? 0;
      const chopV = chop ?? 100;

      ultraSigs16 = [
        ema9 > ema21 ? 1 : -1,                                          //  1. EMA9/21 smjer
        crossUp3 ? 1 : crossDown3 ? -1 : 0,                             //  2. Svježi cross (3 bara)
        ema50 ? (price > ema50 ? 1 : -1) : 0,                           //  3. Cijena vs EMA50
        rsiV < 45 ? 1 : rsiV > 55 ? -1 : 0,                                //  4. RSI zona (<45=oversold→+1, >55=overbought→-1)
        ema55 ? (price > ema55 ? 1 : -1) : 0,                           //  5. Cijena vs EMA55
        adxV > 18 ? (ema9 > ema21 ? 1 : -1) : 0,                        //  6. ADX > 18 + EMA smjer
        chopV < 61.8 ? 1 : -1,                                           //  7. Nije choppy
        (scaleUp >= 4 ? 1 : scaleDn >= 4 ? -1 : 0),                     //  8. 6-Scale EMA
        cvdSum > 0 ? 1 : -1,                                             //  9. CVD volumen
        rsiRecovBull ? 1 : rsiRecovBear ? -1 : 0,                        // 10. RSI recovery
        macdH !== null ? (macdH > 0 ? 1 : -1) : 0,                      // 11. MACD histogram
        ema145 ? (price > ema145 ? 1 : -1) : 0,                         // 12. EMA145 trend
        vols[n-1] > volAvg20 ? 1 : 0,                                    // 13. Volumen iznad prosjeka
        macdCrossV,                                                       // 14. MACD cross
        rsiRising ? 1 : rsiFalling ? -1 : 0,                             // 15. RSI smjer
        adxV > 25 ? (ema9 > ema21 ? 1 : -1) : 0,                        // 16. ADX jak >25
        srsBounce,                                                        // 17. S/R bounce
        srbBreak,                                                         // 18. S/R breakout
      ];

      ultraBull = ultraSigs16.filter(s => s === 1).length;
      ultraBear = ultraSigs16.filter(s => s === -1).length;

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
    ultraSig, ultraBull, ultraBear, ultraSigs16,
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
      pendingList = pendingList.filter(p => now - p.ts < 15 * 60 * 1000);  // 1 svjećica (15m)
    }
  } catch { /* ignoriraj */ }

  const results = [];
  const BATCH = 5;
  for (let i = 0; i < ALL_SYMBOLS.length; i += BATCH) {
    const batch = ALL_SYMBOLS.slice(i, i + BATCH);
    await Promise.all(batch.map(async sym => {
      try {
        const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1m&limit=250`;
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
        const symSltp = rules.symbol_sltp?.[sym] || {};
        const slPct   = symSltp.slPct ?? 1.5;
        const tpPct   = symSltp.tpPct ?? 2.5;
        results.push({ symbol: sym, ...s, pending, slPct, tpPct });
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

// Popuni ALL_SYMBOLS iz rules.json
ALL_SYMBOLS.push(...(loadRules().watchlist_synapse_t || []));

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

  // Period P&L (dnevni, tjedni, mjesečni, godišnji)
  const now   = new Date();
  const todayStr  = now.toISOString().slice(0, 10);  // "2026-05-10"
  const weekAgo   = new Date(now - 7  * 86400000);
  const monthAgo  = new Date(now - 30 * 86400000);
  const yearAgo   = new Date(now - 365* 86400000);

  function periodPnl(from) {
    return exits
      .filter(r => new Date(`${r["Date"]}T${r["Time (UTC)"] || "00:00:00"}Z`) >= from)
      .reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0);
  }
  function periodTrades(from) {
    return exits.filter(r => new Date(`${r["Date"]}T${r["Time (UTC)"] || "00:00:00"}Z`) >= from).length;
  }

  const pnlDay   = periodPnl(new Date(todayStr + "T00:00:00Z"));
  const pnlWeek  = periodPnl(weekAgo);
  const pnlMonth = periodPnl(monthAgo);
  const pnlYear  = periodPnl(yearAgo);
  const tradesDay   = periodTrades(new Date(todayStr + "T00:00:00Z"));
  const tradesWeek  = periodTrades(weekAgo);
  const tradesMonth = periodTrades(monthAgo);
  const tradesYear  = periodTrades(yearAgo);

  // Per-symbol statistika
  const symbolStats = {};
  for (const r of exits) {
    const sym = r["Symbol"] || "?";
    if (!symbolStats[sym]) symbolStats[sym] = { wins: 0, losses: 0, pnl: 0 };
    const pnl = parseFloat(r["Net P&L"] || 0);
    if (pnl >= 0) symbolStats[sym].wins++;
    else          symbolStats[sym].losses++;
    symbolStats[sym].pnl += pnl;
  }
  // Sortiraj po ukupnom broju tradova
  const symbolStatsArr = Object.entries(symbolStats)
    .map(([sym, s]) => ({ sym, ...s, total: s.wins + s.losses }))
    .sort((a, b) => b.total - a.total);

  return { pid, startCap, rows, exits, entries, wins, losses, totalPnl, winRate, equity, pnlCurve, recentExits, symbolStatsArr,
    pnlDay, pnlWeek, pnlMonth, pnlYear, tradesDay, tradesWeek, tradesMonth, tradesYear };
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

  // ULTRA — jedini portfolio
  const def   = PORTFOLIO_DEFS[0];
  const s     = allStats[0];
  const positions = allPositions[0];
  const tf    = tfMap[def.id] || "15m";

  const pcts   = ((s.equity - def.startCapital) / def.startCapital * 100);
  const pctStr = (pcts >= 0 ? "+" : "") + pcts.toFixed(2) + "%";
  const eqCol  = s.equity >= def.startCapital ? "#00c48c" : "#ff4d4d";
  const pnlCol = s.totalPnl >= 0 ? "#00c48c" : "#ff4d4d";

  // Equity curve chart data
  const curveLabels = JSON.stringify(s.pnlCurve.map(p => p.ts.slice(0,10)));
  const curveData   = JSON.stringify(s.pnlCurve.map(p => p.equity));

  // Open positions (ULTRA only)
  const positionsSections = (() => {
    if (positions.length === 0)
      return `<div class="section-label" style="color:${def.color}">🎯 ULTRA — nema otvorenih pozicija</div>`;

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
            <div><label>Ulog (margin)</label><span style="color:#f7b731;font-weight:700">$${(p.margin ?? p.totalUSD / 40).toFixed(2)}</span></div>
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
      <div class="section-label" style="color:${def.color}">🎯 ULTRA — Otvorene pozicije (${positions.length})</div>
      <div class="pos-grid-wrap">${posHtml}</div>`;
  })();

  // Closed trades (ULTRA only)
  const tradesSections = (() => {
    if (s.recentExits.length === 0)
      return `<div class="section-label" style="color:${def.color}">🎯 ULTRA — nema zatvorenih tradova</div>`;

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

    // Per-symbol statistika
    const symRows = s.symbolStatsArr.map(sym => {
      const wr = sym.total > 0 ? (sym.wins / sym.total * 100).toFixed(0) : 0;
      const wrCol = wr >= 50 ? "#00c48c" : "#ff4d4d";
      const pnlCol = sym.pnl >= 0 ? "#00c48c" : "#ff4d4d";
      const bar = `<div style="display:inline-block;width:${Math.round(wr)}%;max-width:100%;height:4px;background:${wrCol};border-radius:2px;vertical-align:middle"></div>`;
      return `<tr>
        <td style="font-weight:700;color:#e6edf3">${sym.sym.replace("USDT","")}</td>
        <td style="color:#00c48c;font-weight:700">${sym.wins}W</td>
        <td style="color:#ff4d4d;font-weight:700">${sym.losses}L</td>
        <td style="color:${wrCol};font-weight:700">${wr}%</td>
        <td style="width:80px">${bar}</td>
        <td style="color:${pnlCol};font-weight:600">${sym.pnl >= 0 ? "+" : ""}$${sym.pnl.toFixed(2)}</td>
      </tr>`;
    }).join("");

    return `
      <div class="section-label" style="color:${def.color}">🎯 ULTRA — Zadnjih ${s.recentExits.length} tradova</div>
      <div class="table-wrap">
        <table class="trade-table">
          <thead><tr><th>Datum</th><th>Symbol</th><th>Side</th><th>Cijena</th><th>P&amp;L</th><th>Info</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="section-label" style="color:${def.color};margin-top:18px">📊 Win/Loss po coinu</div>
      <div class="table-wrap">
        <table class="trade-table">
          <thead><tr><th>Coin</th><th>Dobitni</th><th>Gubitni</th><th>WR</th><th></th><th>P&amp;L</th><th>Status</th></tr></thead>
          <tbody>${symRows}</tbody>
        </table>
      </div>
      ${(() => {
        const allSyms = rules.all_symbols || [];
        const watchlist = rules.watchlist_synapse_t || [];
        const suspended = allSyms.filter(s => !watchlist.includes(s) &&
          !["ORDIUSDT","WLDUSDT","TRUMPUSDT","AVAXUSDT","AAVEUSDT"].includes(s));
        if (!suspended.length) return "";
        return `<div class="section-label" style="color:#ff4d4d;margin-top:14px">🚫 Suspendirani coinovi (5+ uzastopnih gubitaka)</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
            ${suspended.map(s => `<span style="background:#2d1b1b;border:1px solid #ff4d4d33;color:#ff4d4d;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600">${s.replace("USDT","")}</span>`).join("")}
          </div>`;
      })()}`;
  })();

  return `<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>🎯 ULTRA Trading Bot</title>
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

  /* Stats bar */
  .stats-bar { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; margin-bottom:24px; }
  .stat-card { background:var(--bg-secondary); border-radius:10px; padding:14px 16px; border:1px solid var(--border); }
  .stat-label { font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px; }
  .stat-value { font-size:22px; font-weight:800; }
  .stat-sub   { font-size:11px; color:var(--text-muted); margin-top:2px; }

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
      <div class="logo">🎯</div>
      <div>
        <div class="title">ULTRA Trading Bot</div>
        <div class="subtitle">18 signala · min 9/18 · ulaz odmah · ${tf} · SL 1.5–2.5% / TP 2.5–3.5% per-simbol · 50x · rizik 1%</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      ${hbBadge}
      <span class="badge badge-paper">${modeLbl}</span>
    </div>
  </div>

  <!-- Stats bar -->
  <div class="stats-bar">
    <div class="stat-card" style="border-top:3px solid #e85d9a">
      <div class="stat-label">Equity <span style="font-size:10px;color:#8b949e">(CSV)</span></div>
      <div class="stat-value" style="color:${eqCol}">$${s.equity.toFixed(2)}</div>
      <div class="stat-sub" style="color:${eqCol}">${pctStr}</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #f7b731">
      <div class="stat-label">Bitget balans <span style="font-size:10px;color:#8b949e">(live)</span></div>
      <div class="stat-value" id="bitget-bal" style="color:#f7b731">…</div>
      <div class="stat-sub" id="bitget-unr" style="color:#8b949e"></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Start kapital</div>
      <div class="stat-value" style="color:#8b949e">$${def.startCapital.toFixed(2)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Net P&amp;L</div>
      <div class="stat-value" style="color:${pnlCol}">${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl.toFixed(2)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Win Rate</div>
      <div class="stat-value" style="color:${s.winRate !== null && parseFloat(s.winRate) >= 50 ? "#00c48c" : "#ff4d4d"}">${s.winRate !== null ? s.winRate + "%" : "—"}</div>
      <div class="stat-sub">${s.wins.length}W / ${s.losses.length}L</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Zatvoreni tradovi</div>
      <div class="stat-value">${s.exits.length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Otvoreno</div>
      <div class="stat-value" style="color:#f7b731">${positions.length}</div>
      <div class="stat-sub">pozicija</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Strategija</div>
      <div class="stat-value" style="font-size:14px;color:#e85d9a">ULTRA · 50/75x</div>
      <div class="stat-sub">SL 1.5–2.5% / TP 2.5–3.5% · per-simbol · rizik 1%</div>
    </div>
  </div>

  <!-- Period P&L -->
  ${(() => {
    const periods = [
      { label: "Danas",    pnl: s.pnlDay,   trades: s.tradesDay },
      { label: "7 dana",   pnl: s.pnlWeek,  trades: s.tradesWeek },
      { label: "30 dana",  pnl: s.pnlMonth, trades: s.tradesMonth },
      { label: "Godina",   pnl: s.pnlYear,  trades: s.tradesYear },
    ];
    return `
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
    ${periods.map(p => {
      const col = p.pnl > 0 ? "#00c48c" : p.pnl < 0 ? "#ff4d4d" : "#8b949e";
      const icon = p.pnl > 0 ? "▲" : p.pnl < 0 ? "▼" : "—";
      const pct = def.startCapital > 0 ? (p.pnl / def.startCapital * 100).toFixed(2) : "0.00";
      return `<div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 18px">
        <div style="font-size:11px;color:#8b949e;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">${p.label}</div>
        <div style="font-size:22px;font-weight:800;color:${col}">${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}</div>
        <div style="font-size:12px;color:${col};margin-top:2px">${icon} ${p.pnl >= 0 ? "+" : ""}${pct}%</div>
        <div style="font-size:11px;color:#8b949e;margin-top:4px">${p.trades} zatvorenih</div>
      </div>`;
    }).join("")}
  </div>`;
  })()}

  <!-- Equity curve -->
  <div class="chart-card">
    <div class="chart-title">📈 Equity krivulja — ULTRA</div>
    <div class="chart-wrap" style="height:180px"><canvas id="eqChart"></canvas></div>
  </div>

  <!-- Live Scanner ULTRA -->
  <div class="scan-card">
    <div class="scan-header">
      <div>
        <div class="chart-title" style="margin-bottom:2px">🎯 ULTRA Scanner — ${ALL_SYMBOLS.length} simbola | 18 signala | min 9/18 | H/L breakout</div>
        <div style="font-size:12px;color:var(--text-muted)">
          EMA · CRS · E50 · RSI · E55 · ADX · CHP · 6Sc · CVD · R⟳ · MCD · E145 · VOL · MCC · R↗ · ADX+
          &nbsp;|&nbsp; 🟡 Čeka breakout &nbsp; 🟢 Signal &nbsp; Cache 90s &nbsp;|&nbsp;
          <button onclick="toggleLegend()" style="background:none;border:1px solid #30363d;border-radius:4px;color:#8b949e;font-size:11px;cursor:pointer;padding:2px 8px">📖 Legenda signala</button>
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
            <th style="color:#e85d9a;text-align:center">18 Signala &nbsp;<span style="font-weight:400;font-size:10px;color:#666">EMA · CRS · E50 · RSI · E55 · ADX · CHP · 6Sc · CVD · R⟳ · MCD · E145 · VOL · MCC · R↗ · ADX+ · SRS · SRB</span></th>
            <th style="color:#e85d9a;text-align:center">Score</th>
            <th style="min-width:260px">Status / Breakout</th>
          </tr>
        </thead>
        <tbody id="scan-tbody">
          <tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">Klikni "Skeniraj" za prikaz ULTRA signala</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Signal legend (collapsible) -->
  <div id="sig-legend" style="display:none;margin-top:12px">
    <div class="chart-card" style="padding:16px 20px">
      <div class="chart-title" style="margin-bottom:12px">📖 Opis signala — ULTRA (18 signala, min 9/18 za ulaz)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:8px;font-size:12px">
        ${[
          ['EMA', '▲ EMA9 > EMA21 → kratkoročni bull trend  |  ▼ EMA9 < EMA21 → bear'],
          ['CRS', '▲ EMA9/21 cross gore zadnja 3 bara  |  ▼ cross dolje  |  · nema crossa'],
          ['E50', '▲ Cijena > EMA50 → srednji trend gore  |  ▼ ispod EMA50'],
          ['RSI', '▲ RSI < 45 → oversold, potencijalni bounce  |  ▼ RSI > 55 → overbought, opasnost  |  · RSI 45–55 neutralan'],
          ['E55', '▲ Cijena > EMA55 → širi trend gore  |  ▼ ispod EMA55'],
          ['ADX', '▲ ADX > 18 + EMA9 > EMA21 → trend potvrđen (bull)  |  ▼ trend potvrđen (bear)  |  · ADX ≤ 18 → nema trenda'],
          ['CHP', '▲ Chop < 61.8 → tržište trenira  |  ▼ Chop > 61.8 → bočno kretanje'],
          ['6Sc', '▲ 4+ od 6 EMA-para bull (3,11 / 7,15 / 13,21 / 19,29 / 29,47 / 45,55)  |  ▼ 4+ bear  |  · mješovito'],
          ['CVD', '▲ CVD > 0 → kupci dominiraju volumenom (zadnjih 20 bara)  |  ▼ CVD < 0 → prodavači'],
          ['R⟳', '▲ RSI bio < 35, sad > 35 i raste → izlaz iz oversold (bounce signal)  |  ▼ RSI bio > 65, sad < 65 i pada → exit overbought  |  · bez recovery'],
          ['MCD', '▲ MACD histogram > 0 → momentum gore  |  ▼ histogram < 0 → momentum dolje'],
          ['E145','▲ Cijena > EMA145 → dugoročni bull trend  |  ▼ ispod EMA145 → bear'],
          ['VOL', '▲ Volumen > 20-bar prosjek → aktivnost potvrđena  |  · nizak volumen (ne daje -1, samo 0)'],
          ['MCC', '▲ MACD histogram prošao 0 liniju (neg→poz) zadnja 3 bara  |  ▼ (poz→neg)  |  · bez crossa'],
          ['R↗',  '▲ RSI raste 2+ uzastopna bara → momentum gore  |  ▼ RSI pada → momentum dolje  |  · neutralan'],
          ['ADX+','▲ ADX > 25 + EMA9 > EMA21 → jak trend gore  |  ▼ jak trend dolje  |  · ADX ≤ 25'],
          ['SRS', '▲ Bounce od S/R supporta (unutar 1.2%) + RSI raste  |  ▼ bounce od resistancea + RSI pada  |  · daleko od S/R'],
          ['SRB', '▲ Proboj S/R resistancea gore (zadnja 3 bara)  |  ▼ proboj supporta dolje  |  · bez proboja'],
        ].map(([k,v]) =>
          '<div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 10px">' +
          '<span style="font-weight:800;color:#e85d9a;font-size:11px;display:inline-block;min-width:36px">' + k + '</span>' +
          '<span style="color:#8b949e">' + v + '</span></div>'
        ).join('')}
      </div>
      <div style="margin-top:10px;font-size:11px;color:#555">
        🟢 Zeleno = bullish signal aktiviran &nbsp;|&nbsp; 🔴 Crveno = bearish &nbsp;|&nbsp; ⬛ Sivo = neutral/nema signala &nbsp;|&nbsp;
        Min <b style="color:#e85d9a">9/18</b> signala za ulaz · H/L breakout entry · SL <b style="color:#f7b731">1.5–2.5%</b> / TP <b style="color:#f7b731">2.5–3.5%</b> po simbolu · <b>50x</b> leverage · rizik <b>1%</b> banke po tradeu
      </div>
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
// ── Equity krivulja ────────────────────────────────────────────────────────────
(function(){
  const labels = ${curveLabels};
  const data   = ${curveData};
  new Chart(document.getElementById("eqChart").getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Equity ($)",
        data,
        borderColor: "#e85d9a",
        backgroundColor: "rgba(232,93,154,0.08)",
        borderWidth: 2,
        pointRadius: data.length > 50 ? 0 : 3,
        pointBackgroundColor: "#e85d9a",
        tension: 0.3,
        fill: true,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => "$" + ctx.raw.toFixed(2) }
        }
      },
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 8 }, grid: { display: false } },
        y: {
          ticks: { color: "#8b949e", callback: v => "$" + v.toFixed(0) },
          grid: { color: "#21262d" },
          border: { dash: [4,4] }
        }
      }
    }
  });
})();

// ── Legend toggle ─────────────────────────────────────────────────────────────
function toggleLegend() {
  const el = document.getElementById('sig-legend');
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

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

// ULTRA: prikaz svih 16 signala
function ultraHtml(s) {
  const bull   = s.ultraBull ?? 0;
  const bear   = s.ultraBear ?? 0;
  const sig16  = s.ultraSigs16 || new Array(16).fill(0);
  const sig    = s.ultraSig || "—";

  if (!s.ultraSigs16) return '<span style="color:#555;font-size:11px">—</span>';

  const names16 = ['EMA dir','Cross','P>E50','RSI zona','P>E55','ADX>18','Chop','6Sc','CVD','RSI⟳','MACD hist','E145','Vol','MACD cross','RSI smjer','ADX>25'];
  const tooltipText = names16.map((l,i)=>l+':'+(sig16[i]===1?'↑':sig16[i]===-1?'↓':'·')).join(' | ');

  const dots = sig16.map((v, i) => {
    const col = v===1?'#00c48c':v===-1?'#ff4d4d':'#444';
    return '<span title="'+names16[i]+'" style="color:'+col+';font-size:9px">'+(v===1?'▲':v===-1?'▼':'·')+'</span>';
  }).join('');

  const scoreStr = bull > bear
    ? '<span style="color:#00c48c;font-weight:700">↑'+bull+'/18</span>'
    : bear > bull
    ? '<span style="color:#ff4d4d;font-weight:700">↓'+bear+'/18</span>'
    : '<span style="color:#8b949e">'+Math.max(bull,bear)+'/18</span>';

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

// ── Signal label boxes (18 signals) ──────────────────────────────────────────
const SIG_NAMES = ['EMA','CRS','E50','RSI','E55','ADX','CHP','6Sc','CVD','R⟳','MCD','E145','VOL','MCC','R↗','ADX+','SRS','SRB'];

// Uvjeti za tooltip — objasni zašto je signal zelen/crven
const SIG_COND_BULL = [
  'EMA9 > EMA21 — kratkoročni trend gore',
  'EMA9/21 cross gore zadnja 3 bara',
  'Cijena > EMA50 — srednji trend gore',
  'RSI < 45 — oversold zona, potencijalni bounce',
  'Cijena > EMA55 — srednji/dugi trend gore',
  'ADX > 18 + EMA9 > EMA21 — trend potvrđen',
  'Chop < 61.8 — tržište trenira, nije bočno',
  '4+ od 6 EMA-para bullish (multi-timeframe)',
  'CVD > 0 — kupci dominiraju volumenom',
  'RSI izašao iz oversold (<35) i raste — recovery',
  'MACD histogram > 0 — bullish momentum',
  'Cijena > EMA145 — dugoročni trend gore',
  'Volumen > 20-bar prosjek — povećana aktivnost',
  'MACD histogram prešao iz neg→poz (zadnja 3 bara)',
  'RSI raste 2+ uzastopna bara — momentum gore',
  'ADX > 25 + EMA9 > EMA21 — jak trend gore',
  'Bounce od S/R supporta + RSI raste — reakcija na podršku',
  'Proboj S/R resistance gore zadnja 3 bara',
];
const SIG_COND_BEAR = [
  'EMA9 < EMA21 — kratkoročni trend dolje',
  'EMA9/21 cross dolje zadnja 3 bara',
  'Cijena < EMA50 — srednji trend dolje',
  'RSI > 55 — overbought zona, potencijalni pad',
  'Cijena < EMA55 — srednji/dugi trend dolje',
  'ADX > 18 + EMA9 < EMA21 — bearish trend potvrđen',
  'Chop > 61.8 — bočno tržište, nema trenda',
  '4+ od 6 EMA-para bearish (multi-timeframe)',
  'CVD < 0 — prodavači dominiraju volumenom',
  'RSI izašao iz overbought (>65) i pada — pad potvrđen',
  'MACD histogram < 0 — bearish momentum',
  'Cijena < EMA145 — dugoročni trend dolje',
  '— (niski volumen = neutralan)',
  'MACD histogram prešao iz poz→neg (zadnja 3 bara)',
  'RSI pada 2+ uzastopna bara — momentum dolje',
  'ADX > 25 + EMA9 < EMA21 — jak bearish trend',
  'Bounce od S/R resistancea + RSI pada — reakcija na otpor',
  'Proboj S/R supporta dolje zadnja 3 bara',
];
const SIG_COND_NEUT = [
  'EMA9 ≈ EMA21 — bez jasnog smjera',
  'Nema svježeg crossa (neutralno)',
  'EMA50 nedostupan',
  'RSI 45–55 — neutralna zona',
  'EMA55 nedostupan',
  'ADX ≤ 18 — tržište ne trenira dovoljno',
  '—',
  'Manje od 4 EMA-para poravnano',
  'CVD = 0',
  'RSI nije u recovery zoni',
  'MACD nedostupan',
  'EMA145 nedostupan',
  'Volumen ≤ prosjeku — neutralan',
  'Nema MACD crossa u zadnja 3 bara',
  'RSI ne raste ni pada konzistentno',
  'ADX ≤ 25 — trend nije dovoljno jak',
  'Cijena nije blizu S/R razine',
  'Nema S/R proboja u zadnja 3 bara',
];

function sigBoxes(sigs) {
  if (!sigs || sigs.length === 0) return '<span style="color:#444">—</span>';
  return sigs.map((v, i) => {
    const bg   = v === 1 ? '#0d3d26' : v === -1 ? '#3d0d0d' : '#1c2128';
    const col  = v === 1 ? '#00c48c' : v === -1 ? '#ff4d4d' : '#444';
    const bdr  = v === 1 ? '1px solid #00c48c44' : v === -1 ? '1px solid #ff4d4d44' : '1px solid #30363d';
    const icon = v === 1 ? '▲' : v === -1 ? '▼' : '·';
    const lbl  = SIG_NAMES[i] || i;
    const tip  = (i + 1) + '. ' + lbl + ': ' + (v === 1 ? SIG_COND_BULL[i] : v === -1 ? SIG_COND_BEAR[i] : SIG_COND_NEUT[i]);
    return '<span title="' + tip + '" style="display:inline-block;background:' + bg + ';color:' + col + ';border:' + bdr + ';padding:2px 5px;font-size:10px;font-weight:700;border-radius:3px;margin:1px;min-width:32px;text-align:center">' + lbl + '<br><span style="font-size:9px">' + icon + '</span></span>';
  }).join('');
}

function scoreBox(bull, bear, sig) {
  const total = 18;
  if (sig === "LONG")   return '<div style="background:rgba(0,196,140,0.15);border:1px solid #00c48c;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#00c48c;font-weight:800;font-size:16px">↑' + bull + '</span><span style="color:#555;font-size:11px">/' + total + '</span><br><span class="sig-long" style="font-size:11px">▲ LONG</span></div>';
  if (sig === "SHORT")  return '<div style="background:rgba(255,77,77,0.15);border:1px solid #ff4d4d;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#ff4d4d;font-weight:800;font-size:16px">↓' + bear + '</span><span style="color:#555;font-size:11px">/' + total + '</span><br><span class="sig-short" style="font-size:11px">▼ SHORT</span></div>';
  if (sig === "SETUP↑") return '<div style="background:rgba(240,165,0,0.1);border:1px solid #f0a50066;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#f0a500;font-weight:800;font-size:16px">↑' + bull + '</span><span style="color:#555;font-size:11px">/' + total + '</span><br><span style="color:#f0a500;font-size:11px">◈ SETUP↑</span></div>';
  if (sig === "SETUP↓") return '<div style="background:rgba(240,165,0,0.1);border:1px solid #f0a50066;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#f0a500;font-weight:800;font-size:16px">↓' + bear + '</span><span style="color:#555;font-size:11px">/' + total + '</span><br><span style="color:#f0a500;font-size:11px">◈ SETUP↓</span></div>';
  const top = Math.max(bull, bear);
  const col = bull > bear ? '#00c48c55' : bear > bull ? '#ff4d4d55' : '#555';
  return '<div style="text-align:center"><span style="color:' + col + ';font-size:14px">' + top + '</span><span style="color:#444;font-size:11px">/' + total + '</span></div>';
}

function statusBox(s) {
  const sig = s.ultraSig;

  // Aktivan signal — bot ulazi odmah na close svjećice
  if (sig === "LONG") {
    return '<div style="background:rgba(0,196,140,0.1);border:1px solid #00c48c;border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#00c48c;font-weight:700;margin-bottom:4px">✅ SIGNAL AKTIVIRAN</div>' +
      '<div style="font-size:13px;font-weight:700;color:#00c48c">▲ LONG</div>' +
      '<div style="font-size:11px;color:#8b949e;margin-top:3px">Ulaz odmah @ <b style="color:#e6edf3">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBull||0) + '/18</b></div>' +
      '</div>';
  }
  if (sig === "SHORT") {
    return '<div style="background:rgba(255,77,77,0.1);border:1px solid #ff4d4d;border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#ff4d4d;font-weight:700;margin-bottom:4px">✅ SIGNAL AKTIVIRAN</div>' +
      '<div style="font-size:13px;font-weight:700;color:#ff4d4d">▼ SHORT</div>' +
      '<div style="font-size:11px;color:#8b949e;margin-top:3px">Ulaz odmah @ <b style="color:#e6edf3">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBear||0) + '/18</b></div>' +
      '</div>';
  }
  if (sig === "SETUP↑") return '<span style="color:#f0a500;font-size:12px">◈ SETUP ↑ &nbsp;<span style="color:#555;font-size:11px">(' + (s.ultraBull||0) + '/18)</span></span>';
  if (sig === "SETUP↓") return '<span style="color:#f0a500;font-size:12px">◈ SETUP ↓ &nbsp;<span style="color:#555;font-size:11px">(' + (s.ultraBear||0) + '/18)</span></span>';

  // ── RSI + ADX Watch alert — oba moraju biti overextended ──────────────────
  const rsiNum = parseFloat(s.rsi);
  const adxNum = parseFloat(s.adx) || 0;
  if (!isNaN(rsiNum) && adxNum > 60) {
    // WATCH SHORT — RSI > 70 + ADX > 50: overbought + ekstremni trend
    if (rsiNum > 70) {
      return '<div style="background:rgba(255,77,77,0.06);border:1px solid #ff4d4d55;border-radius:8px;padding:6px 10px">' +
        '<div style="font-size:11px;color:#ff4d4d;font-weight:700">⚠️ WATCH SHORT</div>' +
        '<div style="font-size:11px;color:#8b949e;margin-top:2px">RSI <b style="color:#ff4d4d">' + s.rsi + '</b> + ADX <b style="color:#ff4d4d">' + s.adx + '</b> — overextended, moguć vrh</div>' +
        '<div style="font-size:10px;color:#555;margin-top:2px">Bull: ' + (s.ultraBull||0) + ' · Bear: ' + (s.ultraBear||0) + ' · Treba 12+ za SHORT</div>' +
        '</div>';
    }
    // WATCH LONG — RSI < 30 + ADX > 50: oversold + ekstremni downtrend
    if (rsiNum < 30) {
      return '<div style="background:rgba(0,196,140,0.06);border:1px solid #00c48c55;border-radius:8px;padding:6px 10px">' +
        '<div style="font-size:11px;color:#00c48c;font-weight:700">⚠️ WATCH LONG</div>' +
        '<div style="font-size:11px;color:#8b949e;margin-top:2px">RSI <b style="color:#00c48c">' + s.rsi + '</b> + ADX <b style="color:#00c48c">' + s.adx + '</b> — overextended, moguć bounce</div>' +
        '<div style="font-size:10px;color:#555;margin-top:2px">Bull: ' + (s.ultraBull||0) + ' · Bear: ' + (s.ultraBear||0) + ' · Treba 12+ za LONG</div>' +
        '</div>';
    }
  }

  return '<span style="color:#444;font-size:12px">—</span>';
}

async function doScan() {
  const btn   = document.getElementById("scan-btn");
  const tbody = document.getElementById("scan-tbody");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⟳</span> Skenira...';
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:#8b949e"><span class="spin" style="font-size:20px">⟳</span><br>Fetcham ${ALL_SYMBOLS.length} simbola na 1m TF...</td></tr>';

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
        return 3 + (16 - Math.max(s.ultraBull||0, s.ultraBear||0));
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

      // Per-symbol SL/TP tier boja
      const slTp    = s.slPct && s.tpPct ? 'SL ' + s.slPct + '% / TP ' + s.tpPct + '%' : 'SL 1.5% / TP 2.5%';
      const slTpCol = (s.slPct >= 2.5) ? '#f7b731' : (s.slPct >= 2.0) ? '#ff8c42' : '#8b949e';

      return '<tr style="' + rowBg + '">' +
        '<td style="color:#555;font-size:11px;text-align:center">' + (i+1) + '</td>' +
        '<td style="font-weight:800;font-size:14px;white-space:nowrap">' + s.symbol.replace("USDT","") + '<span style="color:#555;font-size:10px;font-weight:400">USDT</span>' +
          '<div style="font-size:10px;color:' + slTpCol + ';font-weight:500;margin-top:1px">' + slTp + '</div></td>' +
        '<td style="font-weight:600;white-space:nowrap">' + fmtLive(s.price) + '</td>' +
        '<td style="color:' + rsiCol + ';font-weight:700">' + (s.rsi || "—") + '</td>' +
        '<td style="color:' + adxCol + '">' + (s.adx || "—") + '</td>' +
        '<td style="padding:4px 6px">' + sigBoxes(s.ultraSigs16) + '</td>' +
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

// Bitget live balance
async function loadBitgetBalance() {
  try {
    const r = await fetch('/api/bitget-balance');
    const d = await r.json();
    const el  = document.getElementById('bitget-bal');
    const unr = document.getElementById('bitget-unr');
    if (!el) return;
    if (d.ok && d.balance) {
      const eq = parseFloat(d.balance.equity);
      el.textContent = '$' + eq.toFixed(2);
      const unrPnl = parseFloat(d.balance.unrealizedPnl);
      unr.textContent = 'Unrealized: ' + (unrPnl >= 0 ? '+' : '') + '$' + unrPnl.toFixed(2);
      unr.style.color = unrPnl >= 0 ? '#00c48c' : '#ff4d4d';
    } else {
      el.textContent = 'N/A';
    }
  } catch(e) {
    const el = document.getElementById('bitget-bal');
    if (el) el.textContent = 'err';
  }
}
loadBitgetBalance();
setInterval(loadBitgetBalance, 30000);

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

  // Bitget live balance — bez auth
  if (url.pathname === "/api/bitget-balance") {
    try {
      const BITGET_KEY    = (process.env.BITGET_API_KEY    || "").trim();
      const BITGET_SECRET = (process.env.BITGET_SECRET_KEY || "").trim();
      const BITGET_PASS   = (process.env.BITGET_PASSPHRASE || "").trim();
      const BITGET_BASE   = (process.env.BITGET_BASE_URL   || "https://api.bitget.com").trim();
      const path = "/api/v2/mix/account/accounts?productType=USDT-FUTURES";
      const ts   = Date.now().toString();
      const { createHmac } = await import("crypto");
      const sign = createHmac("sha256", BITGET_SECRET).update(`${ts}GET${path}`).digest("base64");
      const r = await fetch(`${BITGET_BASE}${path}`, {
        headers: {
          "ACCESS-KEY": BITGET_KEY, "ACCESS-SIGN": sign,
          "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET_PASS,
          "Content-Type": "application/json",
        },
      });
      const d = await r.json();
      const acc = d?.data?.[0];
      const balance = acc ? {
        available: parseFloat(acc.available || 0).toFixed(2),
        equity:    parseFloat(acc.usdtEquity || acc.equity || acc.available || 0).toFixed(2),
        unrealizedPnl: parseFloat(acc.unrealizedPL || 0).toFixed(2),
        marginUsed: parseFloat(acc.locked || acc.frozen || 0).toFixed(2),
      } : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: d.code === "00000", balance, raw: acc }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
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

  // Sync pozicija s Bitgeta
  if (url.pathname === "/api/sync-positions" && req.method === "POST") {
    try {
      const result = await syncPositionsFromBitget("synapse_t");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: e.message }));
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

  // Zatvori višak pozicija — POST /api/close-excess?target=15
  if (url.pathname === "/api/close-excess" && req.method === "POST") {
    const target = parseInt(url.searchParams?.get?.("target") || new URL(req.url, "http://x").searchParams.get("target") || "15");
    try {
      const { closeBitGetExcess } = await import("./bot.js");
      const result = await closeBitGetExcess("synapse_t", target);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Circuit breaker — GET = status, POST = reset
  if (url.pathname === "/api/circuit-breaker") {
    const cbFile = `${DATA_DIR}/circuit_breaker.json`;
    if (req.method === "POST") {
      // Učitaj postojeći CB, postavi manualResetAt za svaki portfolio i obriši until
      const existing = existsSync(cbFile) ? JSON.parse(readFileSync(cbFile, "utf8")) : {};
      const now = Date.now();
      const fresh = {};
      for (const pid of ["synapse_t", "ema_rsi", "mega", "synapse7"]) {
        fresh[pid] = { manualResetAt: now };  // ignoriraj CSV trade-ove prije ovog trenutka
      }
      writeFileSync(cbFile, JSON.stringify(fresh, null, 2));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, msg: "Circuit breaker resetiran", manualResetAt: new Date(now).toISOString() }));
    } else {
      const cb = existsSync(cbFile) ? JSON.parse(readFileSync(cbFile, "utf8")) : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cb, now: new Date().toISOString() }));
    }
    return;
  }

  // Fix CSV — DELETE loš red (POST /api/fix-csv)
  // Body: { pid, symbol, date, action: "delete"|"fix", pnl?, exitPrice? }
  if (url.pathname === "/api/fix-csv" && req.method === "POST") {
    let body = "";
    req.on("data", d => { body += d; });
    req.on("end", () => {
      try {
        const { pid = "synapse_t", symbol, date, action = "delete", pnl, exitPrice } = JSON.parse(body || "{}");
        const f = `${DATA_DIR}/trades_${pid}.csv`;
        if (!existsSync(f)) { res.writeHead(404); res.end(JSON.stringify({ error: "CSV not found" })); return; }
        const lines = readFileSync(f, "utf8").split("\n");
        const header = lines[0];
        let affected = 0;
        const newLines = [header];
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) { newLines.push(l); continue; }
          const cols = l.split(",");
          const rowDate   = cols[0] || "";
          const rowSymbol = cols[3] || "";
          const rowSide   = cols[4] || "";
          const isClosed  = rowSide === "CLOSE_LONG" || rowSide === "CLOSE_SHORT";
          // Provjeri je li ovo krivi red
          const match = isClosed
            && (!symbol || rowSymbol === symbol)
            && (!date   || rowDate === date);
          if (!match) { newLines.push(l); continue; }
          affected++;
          if (action === "delete") {
            console.log(`🗑️  fix-csv: obrisano — ${rowDate} ${rowSymbol} ${rowSide}`);
            // ne dodajem u newLines = brisanje
          } else if (action === "fix") {
            // Ispravi Net P&L (col 9) i Price (col 6)
            if (pnl    !== undefined) cols[9] = String(pnl);
            if (exitPrice !== undefined) cols[6] = String(exitPrice);
            newLines.push(cols.join(","));
            console.log(`✏️  fix-csv: ispravljeno — ${rowDate} ${rowSymbol} P&L=${cols[9]} Price=${cols[6]}`);
          } else {
            newLines.push(l);
          }
        }
        writeFileSync(f, newLines.join("\n"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, affected, action, symbol, date }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // CSV download — GET /api/csv?pid=synapse_t
  if (url.pathname === "/api/csv") {
    const pid = url.searchParams.get("pid") || "synapse_t";
    const f = `${DATA_DIR}/trades_${pid}.csv`;
    if (!existsSync(f)) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="trades_${pid}.csv"` });
    res.end(readFileSync(f, "utf8"));
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

  // Fast breakout checker — svake minute provjerava live cijenu vs. trigger
  setInterval(async () => {
    try { await checkBreakouts(); }
    catch (e) { console.error("Breakout checker greška:", e.message); }
  }, 60 * 1000);

});
