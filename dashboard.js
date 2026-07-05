/**
 * Trading Bot Dashboard — 3-Portfolio Mode
 * EMA+RSI | 3-Layer | MEGA — svaki portfolio $1000 start
 */

import "dotenv/config";
import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { run as botRun, checkBreakouts, syncPositionsFromBitget, checkBeStopAll, softExitMonitor,
  getAllFundingRates, getDailyPnlExport, getSymbolStats, getOIForSymbols,
  getFearGreed, getBtcDominance, getDxyData, getConsecutiveLossCount,
  getSessionInfo, calcAtrTrend, getSp500Data, calcSymbolCorrelation,
  getDeribitPutCall, getLiquidationRisk, getEconEvents, isEconBlocked, calcVWAP,
  getLongShortRatio, getStablecoinInflow, getBtcPerpBasis, getAltcoinSeason,
  generateDailyReport, autoFixCsvFromBitget, SYMBOL_COMBOS } from "./bot.js";

const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : ".");
const START_CAPITAL = 1000;

// ─── Timezone offset — UTC+2 (CEST) ───────────────────────────────────────────
const TZ_OFFSET_H = 2;  // sati ispred UTC

/** Pretvara UTC ISO string ili Date u lokalni prikaz "YYYY-MM-DD HH:MM" */
function fmtLocalTs(iso) {
  if (!iso) return "—";
  const d = new Date(typeof iso === "string" ? iso : iso);
  if (isNaN(d)) return String(iso).slice(0, 16).replace("T", " ");
  d.setHours(d.getHours() + TZ_OFFSET_H);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/** Vraća trenutno lokalno vrijeme kao string */
function nowLocal() {
  return fmtLocalTs(new Date().toISOString());
}

const PORTFOLIO_DEFS = [
  { id: "synapse_t", name: "ULTRA", color: "#db2777", emoji: "🎯", startCapital: 376.83, live: true },
];

// ─── All symbols — čita iz rules.json (lazily, nakon što loadRules bude definiran) ─
// Placeholder — pravi ALL_SYMBOLS se postavlja na dnu, nakon definicije loadRules
let ALL_SYMBOLS = [];

// ─── VOL_EXH tiered threshold (mora biti identično bot.js VOL_EXH_TIERS) ─────
// Izvor: MM/Algo analiza 23.05.2026 — docs/MM_Algo_Analysis.xlsx
const VOL_EXH_TIERS_D = {
  "BTCUSDT":  5.0,
  "ETHUSDT":  4.0, "SOLUSDT":  4.0, "XRPUSDT":  4.0,
  "ADAUSDT":  3.5, "LINKUSDT": 3.5, "DOGEUSDT": 3.5,
  "NEARUSDT": 3.0, "SUIUSDT":  3.0, "APTUSDT":  3.0, "SEIUSDT":  3.0, "INJUSDT":  3.0,
  "TAOUSDT":  2.5, "HYPEUSDT": 2.5, "JUPUSDT":  2.5, "ENAUSDT":  2.5,
};
const VOL_EXH_DEFAULT_D = 3.0;

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

// ─── Liquidity Hunt zone + Daily EMA fetch (za DEMA/LHUNT signale u scanneru) ──
// Cache 10 min po simbolu — 3 fetcha po simbolu inače preskupo na svakom scanu
const _lhZonesCache = {};
async function fetchLhZones(sym) {
  const now = Date.now();
  const c = _lhZonesCache[sym];
  if (c && now - c.ts < 10 * 60 * 1000) return c.zones;
  const zones = {};
  try {
    const [wd, dd, md] = await Promise.all([
      fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1W&limit=2`).then(r=>r.json()),
      fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1Dutc&limit=90`).then(r=>r.json()),
      fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1Mutc&limit=13`).then(r=>r.json())
    ]);
    if (wd.code === "00000" && wd.data?.length >= 1)
      zones.weeklyOpen = parseFloat(wd.data[wd.data.length - 1][1]);  // ascending — zadnji = tekući
    if (dd.code === "00000" && dd.data?.length >= 21) {
      const dC = dd.data.map(k => ({ ts:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4] }));
      const dCl = dC.map(x => x.close);
      const dema = (p) => {
        const k = 2/(p+1); let v = dCl.slice(0,p).reduce((a,b)=>a+b,0)/p;
        for (let i=p; i<dCl.length; i++) v = dCl[i]*k + v*(1-k);
        return v;
      };
      zones.dailyEma10 = dema(10);
      zones.dailyEma20 = dema(20);
      const nowD = new Date();
      const mS = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), 1);
      const mC = dC.filter(x => x.ts >= mS);
      if (mC.length > 0) {
        zones.monthlyOpen = mC[0].open;
        zones.monthlyHigh = Math.max(...mC.map(x => x.high));
        zones.monthlyLow  = Math.min(...mC.map(x => x.low));
      }
    }
    if (md.code === "00000" && md.data?.length >= 1) {
      const yS = Date.UTC(new Date().getUTCFullYear(), 0, 1);
      const jan = md.data.find(k => +k[0] >= yS);
      if (jan) zones.yearlyOpen = parseFloat(jan[1]);
    }
  } catch {}
  _lhZonesCache[sym] = { zones, ts: now };
  return zones;
}

function scanSymbol(symbol, candles, emaRsiCfg, megaCfg, synapse7Cfg = {}, ultraCfg = {}, _pwh = null, _pwl = null, _zones = null) {
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

  // ── RSI series (za recovery detekciju i divergenciju) ──
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

  // ── RSI divergencija (identično bot.js sigRsiDiv) ──
  let sigRsiDivD = 0;
  {
    const DIV_LB = 40, DIV_WING = 3, DIV_MRSI = 2.0, DIV_MP = 0.005;
    const dStart = Math.max(DIV_WING, n - DIV_LB), dEnd = n - DIV_WING - 1;
    const dHighs = [], dLows = [];
    for (let i = dStart; i <= dEnd; i++) {
      const hi = candles[i].high, lo = candles[i].low;
      let isH = true, isL = true;
      for (let j = i - DIV_WING; j <= i + DIV_WING; j++) {
        if (j === i) continue;
        if (candles[j].high >= hi) isH = false;
        if (candles[j].low  <= lo) isL = false;
      }
      if (isH && rsiSeries[i] !== null) dHighs.push({ i, price: hi, rsi: rsiSeries[i] });
      if (isL && rsiSeries[i] !== null) dLows.push({  i, price: lo, rsi: rsiSeries[i] });
    }
    if (dHighs.length >= 2) {
      const h1 = dHighs[dHighs.length-2], h2 = dHighs[dHighs.length-1];
      if ((h2.price - h1.price) / h1.price > DIV_MP && (h1.rsi - h2.rsi) > DIV_MRSI) sigRsiDivD = -1;
    }
    if (dLows.length >= 2 && sigRsiDivD === 0) {
      const l1 = dLows[dLows.length-2], l2 = dLows[dLows.length-1];
      if ((l1.price - l2.price) / l1.price > DIV_MP && (l2.rsi - l1.rsi) > DIV_MRSI) sigRsiDivD = 1;
    }
  }

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

  // ── ULTRA v3 — 8 signala + 3 gateva (identično bot.js analyzeUltra) ──
  // Signali: E50↑, CVD↑, MACD, E145, PWHL, RDIV, MSTR, FVG
  // Gatevi (obvezni, ne broje se u score): ADX≥22, VOL_EXH, VWAP

  // PWHL signal (Previous Weekly High/Low)
  let sigPWHLD = 0;
  {
    const PWHL_ZONE = 0.015;
    if (_pwl !== null && (price - _pwl) / price < PWHL_ZONE && price > _pwl && rsiRising)  sigPWHLD =  1;
    if (_pwh !== null && (_pwh - price) / price < PWHL_ZONE && price < _pwh && rsiFalling) sigPWHLD = -1;
  }

  // MSTR signal (Market Structure HH/HL vs LL/LH)
  let sigMktStrD = 0;
  {
    const MS_LOOKBACK = 60, MS_WING = 3;
    const msHighs = [], msLows = [];
    const mStart = Math.max(MS_WING, n - MS_LOOKBACK);
    const mEnd   = n - MS_WING - 1;
    for (let i = mStart; i <= mEnd; i++) {
      let isH = true, isL = true;
      for (let j = i - MS_WING; j <= i + MS_WING; j++) {
        if (j === i) continue;
        if (candles[j].high >= candles[i].high) isH = false;
        if (candles[j].low  <= candles[i].low)  isL = false;
      }
      if (isH) msHighs.push(candles[i].high);
      if (isL) msLows.push(candles[i].low);
    }
    if (msHighs.length >= 2 && msLows.length >= 2) {
      const lastH = msHighs[msHighs.length-1], prevH = msHighs[msHighs.length-2];
      const lastL = msLows[msLows.length-1],   prevL = msLows[msLows.length-2];
      if (lastH > prevH && lastL > prevL) sigMktStrD =  1;
      if (lastH < prevH && lastL < prevL) sigMktStrD = -1;
    }
  }

  // FVG signal (Fair Value Gap)
  let sigFVGD = 0;
  {
    const FVG_LOOKBACK = 30, FVG_MIN_PCT = 0.003;
    for (let i = Math.max(2, n - FVG_LOOKBACK); i < n - 1 && sigFVGD === 0; i++) {
      const c0h = candles[i-2].high, c0l = candles[i-2].low;
      const c2h = candles[i].high,   c2l = candles[i].low;
      if (c2l > c0h && (c2l - c0h) / c0h >= FVG_MIN_PCT && price >= c0h * 0.999 && price <= c2l * 1.005) sigFVGD =  1;
      if (c0l > c2h && (c0l - c2h) / c2h >= FVG_MIN_PCT && price <= c0l * 1.001 && price >= c2h * 0.995) sigFVGD = -1;
    }
  }

  let ultraSig = "—";
  let ultraBull = 0, ultraBear = 0;
  let ultraSigs16 = new Array(11).fill(0);
  let ultraMinSig = 4;  // default
  {
    const _symCombo = SYMBOL_COMBOS[symbol];  // jedan izvor istine — bot.js
    const _comboIdxD = _symCombo?.sigIdx ?? [0,2,3,4,5,6,9,10];
    const { minSig = 4 } = _symCombo ?? {};
    ultraMinSig = minSig;
    if (n >= 200 && ema9 && ema21) {
      const rsiV  = rsi ?? 50;
      const adxV  = adx ?? 0;

      // OB Order Block signal
      let sigOBD = 0;
      {
        const OB_LOOKBACK = 50, OB_CANDLES = 3, OB_MOVE_PCT = 1.5, OB_BUFFER = 0.003;
        const obsStart = Math.max(1, n - OB_LOOKBACK);
        for (let i = obsStart; i < n - OB_CANDLES - 1 && sigOBD === 0; i++) {
          if (candles[i].close < candles[i].open) {
            let allGreen = true;
            for (let j = i+1; j <= i+OB_CANDLES; j++) { if (candles[j].close <= candles[j].open) allGreen=false; }
            const move = (candles[i+OB_CANDLES].close - candles[i].close) / candles[i].close * 100;
            if (allGreen && move >= OB_MOVE_PCT) {
              const inZone = price >= candles[i].low*(1-OB_BUFFER) && price <= candles[i].high*(1+OB_BUFFER);
              if (inZone) sigOBD = 1;
            }
          }
          if (candles[i].close > candles[i].open && sigOBD === 0) {
            let allRed = true;
            for (let j = i+1; j <= i+OB_CANDLES; j++) { if (candles[j].close >= candles[j].open) allRed=false; }
            const move = (candles[i].close - candles[i+OB_CANDLES].close) / candles[i].close * 100;
            if (allRed && move >= OB_MOVE_PCT) {
              const inZone = price >= candles[i].low*(1-OB_BUFFER) && price <= candles[i].high*(1+OB_BUFFER);
              if (inZone) sigOBD = -1;
            }
          }
        }
      }

      // DEMA — Daily EMA10 retest (Smart Hub)
      let sigDEMAD = 0;
      if (_zones?.dailyEma10 != null) {
        const nearE10  = Math.abs(price - _zones.dailyEma10) / price < 0.015;
        const aboveE10 = price > _zones.dailyEma10;
        if      (aboveE10 && nearE10 && rsiRising)   sigDEMAD =  1;
        else if (aboveE10)                            sigDEMAD =  1;
        else if (!aboveE10 && nearE10 && rsiFalling)  sigDEMAD = -1;
        else                                          sigDEMAD = -1;
      }

      // LHUNT — Liquidity Hunt zone sweep (TraderaEdge)
      let sigLHUNTD = 0;
      {
        const lvls = [_zones?.monthlyOpen, _zones?.weeklyOpen, _zones?.yearlyOpen,
                      _zones?.monthlyHigh, _zones?.monthlyLow, _pwh, _pwl]
                     .filter(v => v != null && v > 0);
        if (lvls.length > 0) {
          const rLows  = candles.slice(-8).map(c => c.low);
          const rHighs = candles.slice(-8).map(c => c.high);
          let swB = 0, swS = 0;
          for (const lvl of lvls) {
            const near = Math.abs(price - lvl) / price < 0.015;
            if (rLows.some(l => l < lvl*0.999)  && price > lvl && near && rsiRising)  swB++;
            if (rHighs.some(h => h > lvl*1.001) && price < lvl && near && rsiFalling) swS++;
          }
          if (swB > swS && swB > 0)      sigLHUNTD =  1;
          else if (swS > swB && swS > 0) sigLHUNTD = -1;
          else {
            const bc = lvls.filter(l => price > l*1.001).length;
            const sc = lvls.filter(l => price < l*0.999).length;
            if (bc > sc) sigLHUNTD = 1; else if (sc > bc) sigLHUNTD = -1;
          }
        }
      }

      // 11 signala: E50, CVD, MACD, E145, PWHL, RDIV, MSTR, FVG, OB, DEMA, LHUNT
      ultraSigs16 = [
        ema50 ? (price > ema50 ? 1 : -1) : 0,             //  1. E50  TREND
        cvdSum > 0 ? 1 : -1,                              //  2. CVD  TREND
        macdH !== null ? (macdH > 0 ? 1 : -1) : 0,       //  3. MACD
        ema145 ? (price > ema145 ? 1 : -1) : 0,          //  4. E145
        sigPWHLD,                                          //  5. PWHL Weekly
        sigRsiDivD,                                        //  6. RDIV
        sigMktStrD,                                        //  7. MSTR
        sigFVGD,                                           //  8. FVG
        sigOBD,                                            //  9. OB Order Block
        sigDEMAD,                                          // 10. DEMA Smart Hub
        sigLHUNTD,                                         // 11. LHUNT Liquidity Hunt
      ];

      const _activeSigsD = _comboIdxD.map(i => ultraSigs16[i]);
      ultraBull = _activeSigsD.filter(s => s === 1).length;
      ultraBear = _activeSigsD.filter(s => s === -1).length;

      const adxOk = adxV >= 22;

      // Pullback signali — bez RSI gate (uklonjen iz bota)
      if      (adxOk && ultraBull >= minSig)          ultraSig = "LONG";
      else if (adxOk && ultraBear >= minSig)          ultraSig = "SHORT";
      else if (adxOk && ultraBull === minSig - 1)     ultraSig = "SETUP↑";
      else if (adxOk && ultraBear === minSig - 1)     ultraSig = "SETUP↓";

      // Momentum fallback
      if (ultraSig === "—") {
        const momSigsD = [
          ema50  ? (price > ema50  ?  1 : -1) : 0,
          cvdSum > 0 ?  1 : -1,
          macdH !== null ? (macdH > 0 ? 1 : -1) : 0,
          ema145 ? (price > ema145 ?  1 : -1) : 0,
          sigPWHLD,
          sigRsiDivD,
          sigMktStrD,
          sigFVGD,
          sigOBD,
          sigDEMAD,
          sigLHUNTD,
        ];
        const _momActiveSigsD = _comboIdxD.map(i => momSigsD[i]);
        const momBullD = _momActiveSigsD.filter(s => s === 1).length;
        const momBearD = _momActiveSigsD.filter(s => s === -1).length;
        const momAdxOk = adxV >= 18;
        if (momAdxOk && momBullD >= minSig)      { ultraSig = "MOM↑"; ultraBull = momBullD; }
        else if (momAdxOk && momBearD >= minSig) { ultraSig = "MOM↓"; ultraBear = momBearD; }
      }
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
    ultraSig, ultraBull, ultraBear, ultraSigs16, ultraMinSig,
    synapseTSig: ultraSig,
    scaleUp, scaleDn,   // direktni 6Sc rezultati za badge display
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
        const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1H&limit=250`;
        const r   = await fetch(url);
        const d   = await r.json();
        if (d.code !== "00000" || !d.data?.length) { results.push({ symbol: sym, error: "no data" }); return; }
        const candles = d.data.map(k => ({
          time: parseInt(k[0]), open: parseFloat(k[1]),
          high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
          volume: parseFloat(k[5] || 0),
        }));
        // Fetch weekly candles za PWHL signal
        let _pwh = null, _pwl = null;
        try {
          const wUrl = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1W&limit=3`;
          const wd   = await fetch(wUrl).then(r2 => r2.json());
          if (wd.code === "00000" && wd.data?.length >= 2) {
            const prevWeek = wd.data[wd.data.length - 2];  // ascending: predzadnji = prethodni tjedan
            _pwh = parseFloat(prevWeek[2]);
            _pwl = parseFloat(prevWeek[3]);
          }
        } catch(e) { /* ignoriraj — PWHL ostaje 0 */ }
        const _zones  = await fetchLhZones(sym);
        const s       = scanSymbol(sym, candles, {}, {}, {}, ultraCfg, _pwh, _pwl, _zones);
        const pending = pendingList.find(p => p.symbol === sym) || null;
        const symSltp = rules.symbol_sltp?.[sym] || {};
        const slPct   = symSltp.slPct ?? 1.5;
        const tpPct   = symSltp.tpPct ?? 2.5;

        // Volume anomaly check (isti algoritam kao bot.js)
        let volRatio = 1, volLow = false, volHigh = false, volExhThreshold = VOL_EXH_DEFAULT_D;
        if (candles.length >= 22) {
          const vols = candles.slice(-22, -2).map(c => c.volume);
          const avg  = vols.reduce((a, b) => a + b, 0) / vols.length;
          volRatio         = avg > 0 ? candles[candles.length - 2].volume / avg : 1;
          volLow           = volRatio < 0.3;
          volExhThreshold  = VOL_EXH_TIERS_D[sym] ?? VOL_EXH_DEFAULT_D;
          volHigh          = volRatio >= volExhThreshold; // VOL_EXH bi blokirao ulaz
        }


        // 1H trend (EMA20)
        let trend1h = 'UNKNOWN';
        try {
          const url1h = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1H&limit=25`;
          const r1h   = await fetch(url1h);
          const d1h   = await r1h.json();
          if (d1h.code === "00000" && d1h.data?.length >= 21) {
            const closes1h = d1h.data.map(k => parseFloat(k[4]));
            const mult = 2 / 21;
            let ema = closes1h.slice(0, 20).reduce((a,b) => a+b, 0) / 20;
            for (let j = 20; j < closes1h.length; j++) ema = closes1h[j] * mult + ema * (1 - mult);
            trend1h = closes1h[closes1h.length - 1] > ema ? 'BULL' : 'BEAR';
          }
        } catch { /* ignoriraj */ }

        const vwap = calcVWAP(candles);
        const vwapDistPct = vwap ? parseFloat(((candles[candles.length-1].close - vwap) / vwap * 100).toFixed(2)) : null;

        // ── MM/Algo filter detekcija (preview — identična logika bot.js) ──────
        const mmFilters = [];
        const nC = candles.length;
        const curPrice = candles[nC - 1].close;
        if (nC >= 5) {
          // Filter 1: Manipulation Candle (wick >60% ranga, body <25%)
          const lc = candles[nC - 2];
          const lcRange = lc.high - lc.low;
          if (lcRange > 0) {
            const lcBody   = Math.abs(lc.close - lc.open);
            const upperWck = lc.high - Math.max(lc.close, lc.open);
            const lowerWck = Math.min(lc.close, lc.open) - lc.low;
            const isManip  = lcBody < lcRange * 0.25;
            if (isManip && upperWck > lcRange * 0.60) mmFilters.push({ code: 'MANIP↑', label: '🪝 MANIP↑', tip: 'Gornja wick manipulacija — LONG blokiran' });
            if (isManip && lowerWck > lcRange * 0.60) mmFilters.push({ code: 'MANIP↓', label: '🪝 MANIP↓', tip: 'Donja wick manipulacija — SHORT blokiran' });
          }
          // Filter 2: Round Number Proximity (±0.25%)
          const RN_PROX = 0.0025;
          const mag = Math.pow(10, Math.floor(Math.log10(curPrice)));
          for (const mult of [1, 2, 5, 10]) {
            const rnStep = mag * mult / 10;
            const nearest = Math.round(curPrice / rnStep) * rnStep;
            if (nearest > 0 && Math.abs(curPrice - nearest) / curPrice < RN_PROX) {
              mmFilters.push({ code: 'RNDUP', label: '🎯 RNDUP', tip: `Blizu round numbera ${nearest.toFixed(nearest >= 100 ? 0 : nearest >= 1 ? 2 : 4)} — blokiran` });
              break;
            }
          }
          // Filter 3: Volume Divergence — identično bot.js (nizak vol + smjer cijene)
          if (nC >= 12) {
            const recentVols = candles.slice(-12, -2).map(c => c.volume);
            const avgVol10 = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
            const lastVol  = candles[nC - 2].volume;
            const volDecline = avgVol10 > 0 && lastVol < avgVol10 * 0.6;
            if (volDecline) {
              const p3 = candles.slice(-4, -1).map(c => c.close);
              const priceRise3 = p3[2] > p3[0];
              const priceFall3 = p3[2] < p3[0];
              if (priceRise3)  mmFilters.push({ code: 'VOLDIV↑', label: '📉 VOLDIV↑', tip: 'Lažni pump — cijena raste + slab vol → LONG blokiran' });
              if (priceFall3)  mmFilters.push({ code: 'VOLDIV↓', label: '📉 VOLDIV↓', tip: 'Lažni dump — cijena pada + slab vol → SHORT blokiran' });
            }
          }
        }

        results.push({ symbol: sym, ...s, pending, slPct, tpPct, trend1h, vwap: vwap ? parseFloat(vwap.toFixed(6)) : null, vwapDistPct, volRatio: parseFloat(volRatio.toFixed(2)), volLow, volHigh, volExhThreshold, mmFilters });
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

  // ── Phase 2 stats (od 2026-05-15 = stabilna strategija) ─────────────────────
  const phase2Start   = new Date("2026-05-15T00:00:00Z");
  const phase2Exits   = exits.filter(r => new Date(`${r["Date"]}T${r["Time (UTC)"] || "00:00:00"}Z`) >= phase2Start);
  const phase2Wins    = phase2Exits.filter(r => parseFloat(r["Net P&L"] || 0) >= 0);
  const phase2Losses  = phase2Exits.filter(r => parseFloat(r["Net P&L"] || 0) < 0);
  const phase2Pnl     = phase2Exits.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0);
  const phase2WR      = phase2Exits.length > 0 ? (phase2Wins.length / phase2Exits.length * 100).toFixed(1) : null;
  const phase2GrossW  = phase2Wins.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0);
  const phase2GrossL  = Math.abs(phase2Losses.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0));
  const phase2PF      = phase2GrossL > 0 ? (phase2GrossW / phase2GrossL).toFixed(2) : null;

  // ── Drawdown (peak-to-trough) ─────────────────────────────────────────────────
  let ddPeak = startCap, maxDrawdownPct = 0;
  let ddRunning = startCap;
  for (const r of exits) {
    ddRunning += parseFloat(r["Net P&L"] || 0);
    if (ddRunning > ddPeak) ddPeak = ddRunning;
    const dd = ddPeak > 0 ? (ddPeak - ddRunning) / ddPeak * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }
  const currentDrawdownPct = ddPeak > 0 ? (ddPeak - equity) / ddPeak * 100 : 0;

  // ── WR by entry mode (PBK / MOM) ─────────────────────────────────────────────
  // Traži MOM/PBK u exit Notes-u (novi format) ili u entry Notes-u istog simbola (stari format)
  const modeStats = { PBK: { wins: 0, losses: 0 }, MOM: { wins: 0, losses: 0 }, UNK: { wins: 0, losses: 0 } };
  // Build lookup: symbol → entryMode iz entry redova (za stari CSV bez entryMode u exit Notes)
  const entryModeBySymbol = {};
  for (const r of entries) {
    const notes = r["Notes"] || "";
    if (notes.includes("| MOM |")) entryModeBySymbol[r["Symbol"]] = "MOM";
    else if (notes.includes("| PBK |")) entryModeBySymbol[r["Symbol"]] = "PBK";
  }
  for (const r of exits) {
    const notes = r["Notes"] || "";
    // Novo: entryMode je u exit Notes-u direktno
    let m = notes.includes("| MOM |") ? "MOM" : notes.includes("| PBK |") ? "PBK" : null;
    // Fallback: lookup iz entry reda za isti simbol (stari CSV)
    if (!m) m = entryModeBySymbol[r["Symbol"]] || "UNK";
    const pnl = parseFloat(r["Net P&L"] || 0);
    if (pnl >= 0) modeStats[m].wins++;
    else          modeStats[m].losses++;
  }

  // ── Profit Factor (sve closed trades) ────────────────────────────────────────
  const grossWins   = wins.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0);
  const grossLosses = Math.abs(losses.reduce((s, r) => s + parseFloat(r["Net P&L"] || 0), 0));
  const profitFactor = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : null;

  // ── Avg trade duration (matchiraj OPEN → CLOSE po simbolu) ───────────────────
  const _openTs = {};
  let totalDurMs = 0, durCount = 0;
  for (const r of rows) {
    const side = r["Side"] || "";
    const sym  = r["Symbol"] || "";
    const ts   = new Date(`${r["Date"]}T${r["Time (UTC)"] || "00:00:00"}Z`).getTime();
    if (side === "LONG" || side === "SHORT") {
      _openTs[sym] = ts;
    } else if ((side === "CLOSE_LONG" || side === "CLOSE_SHORT") && _openTs[sym]) {
      totalDurMs += ts - _openTs[sym];
      durCount++;
      delete _openTs[sym];
    }
  }
  const avgDurationMin = durCount > 0 ? Math.round(totalDurMs / durCount / 60000) : null;

  return { pid, startCap, rows, exits, entries, wins, losses, totalPnl, winRate, equity, pnlCurve, recentExits, symbolStatsArr,
    pnlDay, pnlWeek, pnlMonth, pnlYear, tradesDay, tradesWeek, tradesMonth, tradesYear,
    phase2Exits, phase2Wins, phase2Losses, phase2Pnl, phase2WR, phase2PF,
    maxDrawdownPct, currentDrawdownPct,
    modeStats, profitFactor, avgDurationMin };
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
  if (v >= 1)      return "$" + v.toFixed(2);
  if (v >= 0.01)   return "$" + v.toFixed(4);
  if (v >= 0.0001) return "$" + v.toFixed(6);
  return "$" + v.toFixed(8);
}

function pnlHtml(pnl) {
  const col = pnl > 0 ? "#059669" : pnl < 0 ? "#dc2626" : "#94a3b8";
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
  const eqCol  = s.equity >= def.startCapital ? "#059669" : "#dc2626";
  const pnlCol = s.totalPnl >= 0 ? "#059669" : "#dc2626";

  // Equity curve chart data
  const curveLabels = JSON.stringify(s.pnlCurve.map(p => p.ts.slice(0,10)));
  const curveData   = JSON.stringify(s.pnlCurve.map(p => p.equity));

  // Open positions (ULTRA only)
  const positionsSections = (() => {
    if (positions.length === 0)
      return `<div class="section-label" style="color:${def.color}">🎯 ULTRA — nema otvorenih pozicija</div>`;

    const posHtml = positions.map((p, idx) => {
      const isLong = p.side === "LONG";
      const posUid = `${def.id}-${p.symbol}-${idx}`;  // jedinstven ID čak i za pyramid
      return `
        <div class="pos-card ${isLong ? "pos-long" : "pos-short"}" id="pos-${posUid}">
          <div class="pos-header">
            <span class="symbol">${p.symbol}</span>
            <span class="badge ${isLong ? "badge-long" : "badge-short"}">${p.side}</span>
            ${p.entryMode === "MOM"
              ? '<span style="background:rgba(251,146,60,0.15);border:1px solid #f97316;border-radius:20px;padding:2px 8px;font-size:10px;color:#f97316;font-weight:700">⚡ MOM</span>'
              : '<span style="background:rgba(96,165,250,0.15);border:1px solid #60a5fa;border-radius:20px;padding:2px 8px;font-size:10px;color:#60a5fa;font-weight:700">↩ PBK</span>'}
            <span class="badge badge-paper">${p.mode}</span>
            <span id="lp-${posUid}" style="margin-left:auto;font-size:13px;font-weight:700;color:var(--text-muted)">—</span>
          </div>
          <div class="pos-grid">
            <div><label>Entry</label><span>${fmtP(p.entryPrice)}</span></div>
            <div><label>SL</label><span class="red">${fmtP(p.sl)}</span>${p.slPct ? `<span style="font-size:10px;color:#ff6b6b;margin-left:4px">${parseFloat(p.slPct).toFixed(2)}%</span>` : p.entryPrice && p.sl ? `<span style="font-size:10px;color:#ff6b6b;margin-left:4px">${(Math.abs(p.entryPrice - p.sl) / p.entryPrice * 100).toFixed(2)}%</span>` : ''}</div>
            <div><label>TP</label><span class="green">${fmtP(p.tp)}</span>${p.tpPct ? `<span style="font-size:10px;color:#059669;margin-left:4px">${parseFloat(p.tpPct).toFixed(2)}%</span>` : p.entryPrice && p.tp ? `<span style="font-size:10px;color:#059669;margin-left:4px">${(Math.abs(p.tp - p.entryPrice) / p.entryPrice * 100).toFixed(2)}%</span>` : ''}</div>
            <div><label>Notional</label><span>$${p.totalUSD.toFixed(2)}</span></div>
            <div><label>Ulog (margin)</label><span style="color:#d97706;font-weight:700">$${(p.margin ?? p.totalUSD / 40).toFixed(2)}</span></div>
            <div><label>Qty</label><span>${p.quantity.toFixed(4)}</span></div>
            <div><label>Otvoreno</label><span>${fmtLocalTs(p.openedAt)}</span></div>
          </div>
          <div class="pos-pnl-row">
            <div style="display:flex;flex-direction:column;gap:2px">
              <div id="pnl-${posUid}" style="font-size:14px;font-weight:700;color:#9ca3af">—</div>
              <div id="roe-${posUid}" style="font-size:18px;font-weight:800;color:#9ca3af;letter-spacing:-0.5px">ROE —</div>
            </div>
            <div style="flex:1;min-width:0">
              <div class="range-bar"><div id="bar-${posUid}" class="range-fill"></div></div>
              <div class="range-labels">
                <small>SL ${fmtP(p.sl)}${p.slPct ? ' ('+parseFloat(p.slPct).toFixed(2)+'%)' : ''}</small>
                <small>TP ${fmtP(p.tp)}${p.tpPct ? ' ('+parseFloat(p.tpPct).toFixed(2)+'%)' : ''}</small>
              </div>
            </div>
          </div>
          <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${p.beMoved ? '<span style="background:rgba(5,150,105,0.12);border:1px solid #059669;border-radius:20px;padding:2px 8px;font-size:10px;color:#059669;font-weight:600">🔒 BE-STOP</span>' : ''}
              ${p.trailPeak ? '<span style="background:rgba(217,119,6,0.12);border:1px solid #d97706;border-radius:20px;padding:2px 8px;font-size:10px;color:#d97706;font-weight:600">📈 TRAIL ' + fmtP(p.trailPeak) + '</span>' : ''}
            </div>
            <button onclick="closePosition('${def.id}','${p.symbol}',this)" style="background:#ef4444;color:#fff;border:none;border-radius:6px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:.02em">✕ Zatvori</button>
          </div>
          <script>
          (function(){
            const uid="${posUid}", sym="${p.symbol}", side="${p.side}";
            const entry=${p.entryPrice}, qty=${p.quantity}, notional=${p.totalUSD};
            const margin=${(p.margin ?? p.totalUSD / 40).toFixed(4)};
            const sl=${p.sl}, tp=${p.tp};
            function fmtLive(v){if(v>=1000)return "$"+v.toFixed(2);if(v>=1)return "$"+v.toFixed(4);if(v>=0.001)return "$"+v.toFixed(6);return "$"+v.toFixed(10);}
            function update(price){
              document.getElementById("lp-"+uid).textContent=fmtLive(price);
              const pnl=side==="LONG"?(price-entry)*qty:(entry-price)*qty;
              const pct=(pnl/notional*100).toFixed(2);
              const roe=margin>0?(pnl/margin*100).toFixed(2):null;
              const el=document.getElementById("pnl-"+uid);
              el.textContent=(pnl>=0?"+":"")+"$"+pnl.toFixed(4)+" ("+pct+"%)";
              el.style.color=pnl>=0?"#059669":"#dc2626";
              const roeEl=document.getElementById("roe-"+uid);
              if(roeEl&&roe!==null){roeEl.textContent="ROE "+(pnl>=0?"+":"")+roe+"%";roeEl.style.color=pnl>=0?"#059669":"#dc2626";}
              const range=Math.abs(tp-sl);
              const pos2=side==="LONG"?(price-sl)/range:(sl-price)/range;
              const pct2=Math.max(0,Math.min(100,pos2*100));
              const bar=document.getElementById("bar-"+uid);
              bar.style.width=pct2+"%";bar.style.background=pnl>=0?"#059669":"#dc2626";
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
        <td style="color:${win?"#059669":"#dc2626"};font-weight:700">${win?"+":""}$${pnl.toFixed(4)}</td>
        <td>${r["Notes"]?.replace(/"/g,"").split("|")[0].trim() || ""}</td>
      </tr>`;
    }).join("");

    // Per-symbol statistika
    const symRows = s.symbolStatsArr.map(sym => {
      const wr = sym.total > 0 ? (sym.wins / sym.total * 100).toFixed(0) : 0;
      const wrCol = wr >= 50 ? "#059669" : "#dc2626";
      const pnlCol = sym.pnl >= 0 ? "#059669" : "#dc2626";
      const bar = `<div style="display:inline-block;width:${Math.round(wr)}%;max-width:100%;height:4px;background:${wrCol};border-radius:2px;vertical-align:middle"></div>`;
      return `<tr>
        <td style="font-weight:700;color:#f9fafb">${sym.sym.replace("USDT","")}</td>
        <td style="color:#059669;font-weight:700">${sym.wins}W</td>
        <td style="color:#dc2626;font-weight:700">${sym.losses}L</td>
        <td style="color:${wrCol};font-weight:700">${wr}%</td>
        <td style="width:80px">${bar}</td>
        <td style="color:${pnlCol};font-weight:600">${sym.pnl >= 0 ? "+" : ""}$${sym.pnl.toFixed(2)}</td>
      </tr>`;
    }).join("");

    return `
      <div id="collhdr-wl" onclick="colToggle('wl')"
        style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;padding:8px 0;margin-bottom:4px">
        <span class="section-label" style="color:${def.color};margin:0">📊 Win/Loss po coinu (${s.symbolStatsArr.length})</span>
        <span id="collcaret-wl" style="color:#9ca3af;font-size:11px">▶</span>
      </div>
      <div id="collbody-wl" style="display:none">
        <div class="table-wrap">
          <table class="trade-table">
            <thead><tr><th>Coin</th><th>W</th><th>L</th><th>WR</th><th></th><th>P&amp;L</th></tr></thead>
            <tbody>${symRows}</tbody>
          </table>
        </div>
      </div>

      <div id="collhdr-t20" onclick="colToggle('t20')"
        style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;padding:8px 0;margin-top:10px;margin-bottom:4px">
        <span class="section-label" style="color:${def.color};margin:0">🎯 ULTRA — Zadnjih ${s.recentExits.length} tradova</span>
        <span id="collcaret-t20" style="color:#9ca3af;font-size:11px">▶</span>
      </div>
      <div id="collbody-t20" style="display:none">
        <div class="table-wrap">
          <table class="trade-table">
            <thead><tr><th>Datum</th><th>Symbol</th><th>Side</th><th>Cijena</th><th>P&amp;L</th><th>Info</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
      <script>
        function colToggle(key) {
          var body = document.getElementById('collbody-' + key);
          var caret = document.getElementById('collcaret-' + key);
          var open = body.style.display === 'none';
          body.style.display = open ? 'block' : 'none';
          caret.textContent = open ? '▼' : '▶';
          try { sessionStorage.setItem('coll_' + key, open ? '1' : '0'); } catch(e) {}
        }
        (function restoreCollState() {
          ['wl','t20'].forEach(function(key) {
            try {
              if (sessionStorage.getItem('coll_' + key) === '1') {
                var body = document.getElementById('collbody-' + key);
                var caret = document.getElementById('collcaret-' + key);
                if (body) { body.style.display = 'block'; caret.textContent = '▼'; }
              }
            } catch(e) {}
          });
        })();
      </script>
      ${(() => {
        const allSyms = rules.all_symbols || [];
        const watchlist = rules.watchlist_synapse_t || [];
        const suspended = allSyms.filter(s => !watchlist.includes(s));
        if (!suspended.length) return "";
        return `<div class="section-label" style="color:#dc2626;margin-top:14px">🚫 Suspendirani coinovi (5+ uzastopnih gubitaka)</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
            ${suspended.map(s => `<span style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#ef4444;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600">${s.replace("USDT","")}</span>`).join("")}
          </div>`;
      })()}`;
  })();

  return `<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>⚡ ULTRA · Future Bot</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap');
  :root {
    --bg-primary:   #0a0e1a;
    --bg-secondary: #131a2b;
    --bg-tertiary:  #1c2537;
    --bg-card:      linear-gradient(160deg, #141c30 0%, #101626 100%);
    --border:       #232e45;
    --border-light: #34415e;
    --text-primary: #f2f5fa;
    --text-muted:   #8b96ab;
    --text-dim:     #5c6880;
    --green:        #34d399;
    --green-dim:    rgba(52,211,153,0.10);
    --red:          #f87171;
    --red-dim:      rgba(248,113,113,0.10);
    --blue:         #7dd3fc;
    --blue-dim:     rgba(125,211,252,0.10);
    --purple:       #c4b5fd;
    --yellow:       #fcd34d;
    --accent:       #6366f1;
    --mono:         'JetBrains Mono', ui-monospace, monospace;
    --shadow-sm:    0 1px 3px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02) inset;
    --shadow-md:    0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset;
    --radius-sm:    10px;
    --radius-md:    14px;
    --radius-lg:    18px;
  }
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:var(--text-primary); min-height:100vh; line-height:1.5;
         background: #0a0e1a;
         background-image: radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.13), transparent),
                           radial-gradient(ellipse 60% 40% at 90% 10%, rgba(52,211,153,0.06), transparent); }
  a { color:var(--blue); text-decoration:none; }
  .top-bar { height:3px; background:linear-gradient(90deg,#6366f1,#8b5cf6,#06b6d4,#34d399); background-size:300% 100%; animation:topbarFlow 12s linear infinite; }
  @keyframes topbarFlow { 0%{background-position:0% 0} 100%{background-position:300% 0} }
  .page-wrap { max-width:1440px; margin:0 auto; padding:28px 24px 80px; }
  .header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:32px; }
  .header-left { display:flex; align-items:center; gap:14px; }
  .logo { font-size:26px; filter:drop-shadow(0 0 12px rgba(99,102,241,0.6)); }
  .title { font-size:21px; font-weight:800; letter-spacing:-.02em;
           background:linear-gradient(90deg,#f2f5fa 30%,#a5b4fc 70%,#67e8f9);
           -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
  .subtitle { font-size:12px; color:var(--text-muted); margin-top:3px; letter-spacing:.01em; }
  .live-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--green); margin-right:6px;
              box-shadow:0 0 0 0 rgba(52,211,153,0.6); animation:livePulse 2s ease-out infinite; }
  @keyframes livePulse { 0%{box-shadow:0 0 0 0 rgba(52,211,153,0.55)} 70%{box-shadow:0 0 0 7px rgba(52,211,153,0)} 100%{box-shadow:0 0 0 0 rgba(52,211,153,0)} }
  .badge { display:inline-flex; align-items:center; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:600; white-space:nowrap; }
  .green-badge { background:var(--green-dim); color:var(--green); border:1px solid rgba(16,185,129,0.3); }
  .red-badge   { background:var(--red-dim);   color:var(--red);   border:1px solid rgba(239,68,68,0.3); }
  .badge-paper { background:var(--blue-dim);  color:var(--blue);  border:1px solid rgba(96,165,250,0.3); font-size:11px; padding:2px 8px; }
  .badge-long  { background:var(--green-dim); color:var(--green); border:1px solid rgba(16,185,129,0.3); font-size:11px; padding:2px 8px; }
  .badge-short { background:var(--red-dim);   color:var(--red);   border:1px solid rgba(239,68,68,0.3); font-size:11px; padding:2px 8px; }
  .muted { color:var(--text-muted); }
  .red   { color:var(--red); }
  .green { color:var(--green); }

  /* Stats bar */
  .stats-bar { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:14px; margin-bottom:28px; }
  .stat-card { background:var(--bg-card); border-radius:var(--radius-md); padding:16px 18px; border:1px solid var(--border); box-shadow:var(--shadow-sm); transition:transform .18s,box-shadow .18s,border-color .18s; }
  .stat-card:hover { transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--border-light); }
  .stat-label { font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; font-weight:600; }
  .stat-value { font-size:24px; font-weight:800; letter-spacing:-.03em; font-family:var(--mono); font-variant-numeric:tabular-nums; }
  .stat-sub   { font-size:11px; color:var(--text-muted); margin-top:3px; }

  /* Chart */
  .chart-card { background:var(--bg-card); border-radius:var(--radius-md); padding:22px; border:1px solid var(--border); box-shadow:var(--shadow-sm); margin-bottom:28px; }
  .chart-title { font-size:13px; font-weight:700; margin-bottom:16px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.06em; }
  .chart-wrap { position:relative; height:220px; }

  /* Positions */
  .section-label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.09em; margin:32px 0 14px; padding-bottom:10px; border-bottom:1px solid var(--border); color:var(--text-muted); position:relative; }
  .section-label::after { content:''; position:absolute; left:0; bottom:-1px; width:56px; height:2px; background:linear-gradient(90deg,var(--accent),transparent); border-radius:2px; }
  .pos-grid-wrap { display:grid; grid-template-columns:repeat(auto-fill,minmax(370px,1fr)); gap:16px; margin-bottom:8px; }
  .pos-card { background:var(--bg-card); border-radius:var(--radius-md); padding:18px; border:1px solid var(--border); box-shadow:var(--shadow-sm); transition:box-shadow .2s; }
  .pos-card:hover { box-shadow:var(--shadow-md); }
  .pos-long  { border-left:3px solid var(--green); box-shadow:var(--shadow-sm), -6px 0 18px -8px rgba(52,211,153,0.35); }
  .pos-short { border-left:3px solid var(--red);   box-shadow:var(--shadow-sm), -6px 0 18px -8px rgba(248,113,113,0.35); }
  .pos-header { display:flex; align-items:center; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
  .symbol { font-size:15px; font-weight:700; letter-spacing:-.01em; }
  .pos-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; }
  .pos-grid label { display:block; font-size:9px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.06em; margin-bottom:3px; font-weight:600; }
  .pos-grid span { font-size:13px; font-weight:600; }
  .pos-pnl-row { display:flex; align-items:center; gap:14px; }
  .range-bar { height:5px; background:var(--bg-tertiary); border-radius:3px; overflow:hidden; margin-bottom:5px; }
  .range-fill { height:100%; width:0%; border-radius:3px; transition:width .3s,background .3s; }
  .range-labels { display:flex; justify-content:space-between; font-size:10px; color:var(--text-dim); }

  /* Trades table */
  .table-wrap { overflow-x:auto; margin-bottom:8px; }
  .trade-table { width:100%; border-collapse:collapse; font-size:13px; }
  .trade-table th { padding:10px 14px; text-align:left; color:var(--text-muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; border-bottom:2px solid var(--border); background:var(--bg-secondary); }
  .trade-table td { padding:10px 14px; border-bottom:1px solid var(--border); font-variant-numeric:tabular-nums; }
  .win-row td  { background:rgba(5,150,105,0.04); }
  .loss-row td { background:rgba(220,38,38,0.04); }
  .trade-table tbody tr:hover td { background:var(--bg-secondary); }

  /* Scanner */
  .scan-card { background:var(--bg-card); border-radius:var(--radius-md); padding:22px; border:1px solid var(--border); box-shadow:var(--shadow-sm); margin-bottom:28px; }
  .scan-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
  .scan-btn { background:var(--bg-secondary); color:var(--text-primary); border:1px solid var(--border); border-radius:var(--radius-sm); padding:7px 16px; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; font-family:inherit; }
  .scan-btn:hover { border-color:var(--blue); color:var(--blue); background:var(--blue-dim); }
  .scan-btn:disabled { opacity:.4; cursor:default; }
  .sig-long  { color:var(--green); font-weight:700; }
  .sig-short { color:var(--red);   font-weight:700; }
  .sig-none  { color:var(--text-muted); }
  .scan-table { width:100%; border-collapse:collapse; font-size:13px; }
  .scan-table th { padding:9px 12px; text-align:left; color:var(--text-muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; border-bottom:2px solid var(--border); white-space:nowrap; background:var(--bg-secondary); }
  .scan-table td { padding:8px 12px; border-bottom:1px solid var(--border); font-size:13px; }
  .scan-table tbody tr:hover td { background:var(--bg-secondary); }
  .scan-table .any-signal td { background:rgba(37,99,235,0.04); }
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
      <div class="logo">⚡</div>
      <div>
        <div class="title">ULTRA · Future Bot</div>
        <div class="subtitle"><span class="live-dot"></span>${ALL_SYMBOLS.length} simbola (kripto + dionice) · rizik 1–2% dinamički · combo 5/8 signala · RR 1:2 (JAKO 1:3) · break-even @ +1R · max 6 kripto + 3 dionice</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      ${hbBadge}
      <span class="badge badge-paper">${modeLbl}</span>
    </div>
  </div>

  <!-- Stats bar -->
  <div class="stats-bar">
    <div class="stat-card" style="border-top:3px solid #db2777">
      <div class="stat-label">Equity <span style="font-size:10px;color:#9ca3af">(CSV)</span></div>
      <div class="stat-value" style="color:${eqCol}">$${s.equity.toFixed(2)}</div>
      <div class="stat-sub" style="color:${eqCol}">${pctStr}</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #d97706">
      <div class="stat-label">Bitget balans <span style="font-size:10px;color:#9ca3af">(live)</span></div>
      <div class="stat-value" id="bitget-bal" style="color:#d97706">…</div>
      <div class="stat-sub" id="bitget-unr" style="color:#9ca3af"></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Net P&amp;L</div>
      <div class="stat-value" style="color:${pnlCol}">${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl.toFixed(2)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Win Rate <span style="font-size:10px;color:#9ca3af">(CSV)</span></div>
      <div class="stat-value" style="color:${s.winRate !== null && parseFloat(s.winRate) >= 50 ? "#059669" : "#dc2626"}">${s.winRate !== null ? s.winRate + "%" : "—"}</div>
      <div class="stat-sub">${s.wins.length}W / ${s.losses.length}L</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #8b5cf6">
      <div class="stat-label">Win Rate <span style="font-size:10px;color:#9ca3af">(Bitget live)</span></div>
      <div class="stat-value" id="bitget-wr" style="color:#8b5cf6">…</div>
      <div class="stat-sub" id="bitget-wr-sub" style="color:#9ca3af"></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Otvoreno</div>
      <div class="stat-value" style="color:#d97706">${positions.length}<span style="font-size:14px;color:#6b7280">/9</span></div>
      <div class="stat-sub">max 6 kripto + 3 dionice</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Strategija</div>
      <div class="stat-value" style="font-size:14px;color:#db2777">Future · 15m</div>
      <div class="stat-sub">SR-based SL · dinamički leverage · rizik 1–2%</div>
    </div>
  </div>

  <!-- ── BTC Status Card ────────────────────────────────────────────────── -->
  <div style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:16px 20px;margin-bottom:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#f59e0b">₿ BTC Status</div>
      <span id="btc-status-ts" style="font-size:10px;color:#4b5563">učitavam…</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Dnevni Rang</div>
        <div style="font-size:22px;font-weight:800" id="btc-dayrange-val">—</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:2px" id="btc-dayrange-sub">% od dnevnog H/L</div>
        <div style="background:#374151;border-radius:3px;height:5px;margin-top:6px;overflow:hidden">
          <div id="btc-dayrange-bar" style="height:100%;width:0%;background:#d97706;border-radius:3px;transition:width .5s"></div>
        </div>
      </div>
      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Signal Score</div>
        <div style="font-size:22px;font-weight:800" id="btc-score-val">—</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:2px" id="btc-score-sub">bull / bear signala</div>
      </div>
      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Režim EMA50</div>
        <div style="font-size:22px;font-weight:800" id="btc-regime-val">—</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:2px" id="btc-regime-sub">BTC 4H trend</div>
      </div>
      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Pyramid Slot</div>
        <div style="font-size:22px;font-weight:800" id="btc-pyramid-val">—</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:2px" id="btc-pyramid-sub">dodatni ulaz</div>
      </div>
      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">L/S Ratio</div>
        <div style="font-size:22px;font-weight:800" id="btc-lsr-val">—</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:2px" id="btc-lsr-sub">retail long % · trend</div>
      </div>
    </div>
  </div>
<script>
(function btcStatusCard() {
  async function load() {
    try {
      const d = await fetch('/api/btc-status').then(r => r.json());
      document.getElementById('btc-status-ts').textContent = 'osvježeno ' + new Date().toLocaleTimeString('hr-HR');

      // Day range
      const dr = d.dayRange;
      const drEl = document.getElementById('btc-dayrange-val');
      const drBar = document.getElementById('btc-dayrange-bar');
      if (dr && dr.pct !== null) {
        const pct = dr.pct;
        drEl.textContent = pct.toFixed(1) + '%';
        drEl.style.color = pct > 65 ? '#dc2626' : pct < 35 ? '#dc2626' : '#059669';
        document.getElementById('btc-dayrange-sub').textContent =
          'H: $' + dr.high.toLocaleString() + ' · L: $' + dr.low.toLocaleString();
        drBar.style.width = pct + '%';
        drBar.style.background = pct > 75 ? '#dc2626' : pct > 55 ? '#d97706' : pct < 25 ? '#dc2626' : '#059669';
      }

      // Signal score
      const sc = d.lastScore;
      const scEl = document.getElementById('btc-score-val');
      if (sc) {
        scEl.textContent = sc.score + '/8';
        scEl.style.color = sc.score >= 5 ? '#059669' : sc.score >= 4 ? '#d97706' : '#9ca3af';
        const sigText = sc.signal ? (sc.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT') : '⚪ nema';
        document.getElementById('btc-score-sub').textContent =
          sigText + (sc.flipReady ? ' · 🔄 Flip ready' : '') + (sc.ts ? ' · ' + sc.ts.slice(11,16) : '');
      }

      // Regime
      const rg = d.regime;
      const rgEl = document.getElementById('btc-regime-val');
      if (rg) {
        rgEl.textContent = rg === 'BULL' ? '🐂 BULL' : rg === 'BEAR' ? '🐻 BEAR' : '⚖️ NEUTRAL';
        rgEl.style.color = rg === 'BULL' ? '#059669' : rg === 'BEAR' ? '#dc2626' : '#9ca3af';
        document.getElementById('btc-regime-sub').textContent = 'EMA50 4H · cijena ' + (rg === 'BULL' ? 'iznad' : rg === 'BEAR' ? 'ispod' : 'na') + ' EMA';
      }

      // Pyramid
      const py = d.pyramid;
      const pyEl = document.getElementById('btc-pyramid-val');
      if (py !== undefined) {
        pyEl.textContent = py === 0 ? '✅ Slobodan' : py >= 1 ? '🔒 Zauzet' : '—';
        pyEl.style.color = py === 0 ? '#059669' : '#d97706';
        document.getElementById('btc-pyramid-sub').textContent = py === 0 ? 'max 1 pyramid ulaz' : py + '/1 pyramid pozicija';
      }

      // L/S Ratio
      const lsr = d.lsr;
      const lsrEl = document.getElementById('btc-lsr-val');
      if (lsr && lsr.longRatio) {
        const lr = parseFloat(lsr.longRatio);
        const squeeze = lr < 40;
        const trap    = lr > 62;
        lsrEl.textContent = lr.toFixed(1) + '%';
        lsrEl.style.color = squeeze ? '#059669' : trap ? '#dc2626' : '#d97706';
        const label = squeeze ? '🔥 Squeeze setup' : trap ? '⚠️ Long trap' : '⚖️ Neutral';
        document.getElementById('btc-lsr-sub').textContent = label + ' · ' + (lsr.trend || '');
      }
    } catch(e) {
      document.getElementById('btc-status-ts').textContent = 'Greška: ' + e.message;
    }
  }
  load();
  setInterval(load, 60 * 1000);
})();
</script>

  <!-- ── Liquidity Hunt Zones Card ───────────────────────────────────────── -->
  <div style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:16px 20px;margin-bottom:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#8b5cf6">🎯 Liquidity Hunt Zones</div>
      <span id="lhz-ts" style="font-size:10px;color:#4b5563">učitavam…</span>
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px" id="lhz-table">
        <thead>
          <tr style="color:#6b7280;text-transform:uppercase;font-size:10px">
            <th style="text-align:left;padding:4px 8px;font-weight:600">Zona</th>
            <th style="text-align:right;padding:4px 8px;font-weight:600">Razina</th>
            <th style="text-align:right;padding:4px 8px;font-weight:600">Dist. %</th>
            <th style="text-align:left;padding:4px 8px;font-weight:600">Status</th>
          </tr>
        </thead>
        <tbody id="lhz-body">
          <tr><td colspan="4" style="text-align:center;color:#4b5563;padding:12px">Učitavam…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
<script>
(function lhzCard() {
  function zoneRow(icon, name, val, price) {
    var dist = (val - price) / price * 100;
    var absDist = Math.abs(dist);
    var above = dist > 0;
    var near  = absDist < 1.5;
    var distColor   = near ? '#f59e0b' : above ? '#059669' : '#dc2626';
    var distStr     = (dist > 0 ? '+' : '') + dist.toFixed(2) + '%';
    var statusLabel = near ? '⚡ NEAR' : above ? '↑ Resistance' : '↓ Support';
    var statusColor = near ? '#f59e0b' : above ? '#059669' : '#dc2626';
    return '<tr style="border-top:1px solid #374151">' +
      '<td style="padding:5px 8px;color:#e5e7eb">' + icon + ' ' + name + '</td>' +
      '<td style="padding:5px 8px;text-align:right;font-family:monospace;color:#f3f4f6;font-weight:600">$' + Math.round(val).toLocaleString() + '</td>' +
      '<td style="padding:5px 8px;text-align:right;font-family:monospace;color:' + distColor + ';font-weight:700">' + distStr + '</td>' +
      '<td style="padding:5px 8px;color:' + statusColor + ';font-size:11px">' + statusLabel + '</td>' +
      '</tr>';
  }
  async function load() {
    try {
      var d = await fetch('/api/btc-status').then(function(r){return r.json();});
      document.getElementById('lhz-ts').textContent = 'osvježeno ' + new Date().toLocaleTimeString('hr-HR');
      var lhz = d.lhz, price = d.dayRange && d.dayRange.close;
      if (!lhz || !price) { document.getElementById('lhz-body').innerHTML = '<tr><td colspan="4" style="text-align:center;color:#4b5563;padding:8px">Nema podataka</td></tr>'; return; }
      var zones = [
        { icon: '📅', name: 'Yearly Open',    val: lhz.yearlyOpen  },
        { icon: '🗓️', name: 'Monthly Open',   val: lhz.monthlyOpen },
        { icon: '🔺', name: 'Monthly High',   val: lhz.monthlyHigh },
        { icon: '🔻', name: 'Monthly Low',    val: lhz.monthlyLow  },
        { icon: '📆', name: 'Weekly Open',    val: lhz.weeklyOpen  },
        { icon: '⬆️', name: 'Prev Week High', val: lhz.pwh         },
        { icon: '⬇️', name: 'Prev Week Low',  val: lhz.pwl         },
      ].filter(function(z){ return z.val; });
      zones.sort(function(a,b){ return Math.abs(a.val-price)-Math.abs(b.val-price); });
      var rows = zones.map(function(z){ return zoneRow(z.icon, z.name, z.val, price); }).join('');
      document.getElementById('lhz-body').innerHTML = rows || '<tr><td colspan="4" style="text-align:center;color:#4b5563;padding:8px">—</td></tr>';
    } catch(e) {
      document.getElementById('lhz-ts').textContent = 'Greška';
    }
  }
  load();
  setInterval(load, 60000);
})();
</script>

  <!-- ── SWEEP + MSS Card ────────────────────────────────────────────────── -->
  <div id="sweep-card" style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:16px 20px;margin-bottom:16px;transition:border-color .3s,box-shadow .3s">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#f59e0b">⚡ BTC Sweep Detektor + MSS</div>
      <div style="display:flex;align-items:center;gap:10px">
        <span id="sweep-status" style="font-size:12px;font-weight:700;color:#9ca3af">učitavam…</span>
        <span style="font-size:10px;color:#4b5563">BTC 15m · 90min</span>
      </div>
    </div>
    <!-- Vol progress bar -->
    <div style="background:#111827;border-radius:4px;height:6px;margin-bottom:8px;overflow:hidden">
      <div id="sweep-bar" style="height:100%;width:0%;background:#059669;border-radius:4px;transition:width .4s,background .4s"></div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <!-- 6 svjećica mini prikaz -->
      <div id="sweep-liq-row" style="display:flex;align-items:flex-end;gap:6px;min-height:28px"></div>
      <div id="sweep-sub" style="font-size:10px;color:#9ca3af;text-align:right"></div>
    </div>
    <!-- MSS per-simbol -->
    <div style="border-top:1px solid #374151;margin-top:12px;padding-top:10px">
      <div style="font-size:10px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">MSS — Market Structure Shift po simbolu</div>
      <div id="mss-row" style="display:flex;gap:6px;flex-wrap:wrap"></div>
    </div>
  </div>

  <!-- ── Liquidity Sweep Risk Card ──────────────────────────────────────── -->
  <div id="liq-risk-card" style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:16px 20px;margin-bottom:16px;transition:border-color .3s,box-shadow .3s">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#a78bfa">🎯 MM Likvidacijske Zone &amp; Sweep Risk</div>
      <div style="display:flex;align-items:center;gap:10px">
        <span id="liq-risk-ts" style="font-size:10px;color:#4b5563">učitavam…</span>
        <button onclick="loadLiqRisk()" style="background:#374151;border:none;color:#9ca3af;font-size:10px;padding:3px 8px;border-radius:4px;cursor:pointer">↻</button>
      </div>
    </div>
    <div id="liq-risk-body" style="font-size:12px;color:#9ca3af">Dohvaćam podatke…</div>
  </div>

  <!-- Open positions — na vrhu za brzi pregled -->
  ${positionsSections}

  <!-- ── Phase 2 Stats Panel (od 15.5 = stabilna strategija) ──────────────── -->
  ${(() => {
    const p2 = s;  // koristimo iste stats objekt, jer je phase2* već izračunat unutar buildPortfolioStats
    const p2wr   = p2.phase2WR !== null ? parseFloat(p2.phase2WR) : null;
    const p2col  = p2wr === null ? "#9ca3af" : p2wr >= 50 ? "#059669" : p2wr >= 35 ? "#d97706" : "#dc2626";
    const pfVal  = p2.phase2PF;
    const pfCol  = pfVal === null ? "#9ca3af" : parseFloat(pfVal) >= 1.5 ? "#059669" : parseFloat(pfVal) >= 1 ? "#d97706" : "#dc2626";
    const ddCur  = p2.currentDrawdownPct.toFixed(1);
    const ddMax  = p2.maxDrawdownPct.toFixed(1);
    const ddCol  = parseFloat(ddCur) < 5 ? "#059669" : parseFloat(ddCur) < 15 ? "#d97706" : "#dc2626";
    const pf     = p2.profitFactor;
    const pfAllCol = pf === null ? "#9ca3af" : parseFloat(pf) >= 1.5 ? "#059669" : parseFloat(pf) >= 1 ? "#d97706" : "#dc2626";
    const dur    = p2.avgDurationMin;
    const durStr = dur === null ? "—" : dur >= 60 ? `${(dur/60).toFixed(1)}h` : `${dur}min`;
    const pbkT   = p2.modeStats.PBK.wins + p2.modeStats.PBK.losses;
    const momT   = p2.modeStats.MOM.wins + p2.modeStats.MOM.losses;
    const pbkWR  = pbkT > 0 ? Math.round(p2.modeStats.PBK.wins / pbkT * 100) : null;
    const momWR  = momT > 0 ? Math.round(p2.modeStats.MOM.wins / momT * 100) : null;
    const pbkCol = pbkWR === null ? "#9ca3af" : pbkWR >= 50 ? "#059669" : pbkWR >= 35 ? "#d97706" : "#dc2626";
    const momCol = momWR === null ? "#9ca3af" : momWR >= 50 ? "#059669" : momWR >= 35 ? "#d97706" : "#dc2626";

    return `
  <div style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:16px 20px;margin-bottom:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:11px;color:#a78bfa;font-weight:700;text-transform:uppercase;letter-spacing:1px">🚀 Phase 2 Statistike (od 15.5.2026 — stabilna strategija)</div>
      <div style="font-size:11px;color:#6b7280">${p2.phase2Exits.length} zatvorenih tradova</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">

      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Win Rate</div>
        <div style="font-size:24px;font-weight:800;color:${p2col}">${p2wr !== null ? p2wr + "%" : "—"}</div>
        <div style="font-size:11px;color:#9ca3af">${p2.phase2Wins.length}W / ${p2.phase2Losses.length}L</div>
      </div>

      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Net P&amp;L</div>
        <div style="font-size:24px;font-weight:800;color:${p2.phase2Pnl >= 0 ? "#059669" : "#dc2626"}">${p2.phase2Pnl >= 0 ? "+" : ""}$${p2.phase2Pnl.toFixed(2)}</div>
        <div style="font-size:11px;color:#9ca3af">Phase 2 ukupno</div>
      </div>

      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Profit Factor</div>
        <div style="font-size:24px;font-weight:800;color:${pfCol}">${pfVal ?? "—"}</div>
        <div style="font-size:11px;color:#9ca3af">Phase 2 gross W/L</div>
      </div>

      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">All-time PF</div>
        <div style="font-size:24px;font-weight:800;color:${pfAllCol}">${pf ?? "—"}</div>
        <div style="font-size:11px;color:#9ca3af">svi zatvoreni tradovi</div>
      </div>

      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Drawdown</div>
        <div style="font-size:22px;font-weight:800;color:${ddCol}">-${ddCur}%</div>
        <div style="font-size:11px;color:#9ca3af">Max: -${ddMax}%</div>
      </div>

      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Avg Trajanje</div>
        <div style="font-size:22px;font-weight:800;color:#60a5fa">${durStr}</div>
        <div style="font-size:11px;color:#9ca3af">po tradu</div>
      </div>

      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Pullback WR</div>
        <div style="font-size:22px;font-weight:800;color:${pbkCol}">${pbkWR !== null ? pbkWR+"%" : "—"}</div>
        <div style="font-size:11px;color:#9ca3af">1H PBK · ${pbkT} tradova</div>
      </div>

      <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Momentum WR</div>
        <div style="font-size:22px;font-weight:800;color:${momCol}">${momWR !== null ? momWR+"%" : "—"}</div>
        <div style="font-size:11px;color:#9ca3af">15m MOM · ${momT} tradova</div>
      </div>

    </div>
  </div>`;
  })()}

  <!-- Adaptive Status Panel -->
  ${(() => {
    // Učitaj blacklist
    const blPath = `${DATA_DIR}/symbol_blacklist.json`;
    const bl = existsSync(blPath) ? (() => { try { return JSON.parse(readFileSync(blPath,"utf8")); } catch { return {}; } })() : {};
    const blActive = Object.entries(bl).filter(([,v]) => Date.now() < v.until);

    // Učitaj signal stats
    const ssPath = `${DATA_DIR}/signal_stats.json`;
    const ss = existsSync(ssPath) ? (() => { try { return JSON.parse(readFileSync(ssPath,"utf8")); } catch { return {}; } })() : {};
    const ssRows = Object.entries(ss)
      .filter(([,v]) => v.total >= 3)
      .map(([k,v]) => ({ name: k, wr: (v.wins/v.total*100).toFixed(0), total: v.total }))
      .sort((a,b) => b.wr - a.wr);

    // Učitaj recent WR (zadnjih 10 trejdova DANAS) za dinamički ADX
    // VAŽNO: samo današnji trejdovi — usklađeno s bot.js getDynamicAdx()
    const csvPath = `${DATA_DIR}/trades_synapse_t.csv`;
    let dynAdxVal = 30, recentWr = null, recentN = 0;
    if (existsSync(csvPath)) {
      try {
        const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
        const lines = readFileSync(csvPath,"utf8").trim().split("\n");
        const exits = lines.slice(1)
          .filter(l => l.startsWith(today) && (l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT")));
        if (exits.length >= 3) {
          const wins = exits.filter(l => parseFloat(l.split(",")[9]||0) > 0).length;
          recentWr = Math.round(wins/exits.length*100);
          recentN  = exits.length;
          if (recentWr < 25) dynAdxVal = 40;
          else if (recentWr < 35) dynAdxVal = 35;
        }
      } catch {}
    }
    const adxCol  = dynAdxVal === 30 ? "#059669" : dynAdxVal === 35 ? "#d97706" : "#dc2626";
    const adxLbl  = dynAdxVal === 30 ? "normalno" : dynAdxVal === 35 ? "WR loš" : "WR kritičan";
    const wrCol   = recentWr === null ? "#94a3b8" : recentWr >= 40 ? "#059669" : recentWr >= 30 ? "#d97706" : "#dc2626";

    return `
  <div style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:16px 20px;margin-bottom:20px">
    <div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">⚙️ Adaptivni Status</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">

      <!-- Market Regime -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px" id="regime-card">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">🌍 BTC 1H Regime</div>
        <div style="font-size:22px;font-weight:800;color:#9ca3af" id="regime-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px" id="regime-sub">učitavam…</div>
      </div>

      <!-- Blacklist -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">🚫 Symbol Blacklist</div>
        ${blActive.length === 0
          ? `<div style="font-size:13px;color:#059669">Svi simboli aktivni</div>`
          : blActive.map(([sym,v]) => {
              const remainH = ((v.until - Date.now())/3600000).toFixed(1);
              return `<div style="font-size:12px;color:#dc2626;margin-bottom:3px">
                <b>${sym}</b> — još ${remainH}h
                <span style="color:#9ca3af;font-size:10px">(${v.reason})</span>
              </div>`;
            }).join("")
        }
        <div style="font-size:10px;color:#9ca3af;margin-top:6px">Trigger: 3 uzastopna SL → 24h ban</div>
      </div>

      <!-- Signal Analiza -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">📈 Signal WR (top 6)</div>
        ${ssRows.length === 0
          ? `<div style="font-size:12px;color:#9ca3af">Nema dovoljno podataka (treba 3+ trejdova)</div>`
          : ssRows.slice(0,6).map(r => {
              const col = r.wr >= 40 ? "#059669" : r.wr >= 30 ? "#d97706" : "#dc2626";
              const bar = Math.round(r.wr/10);
              return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:11px">
                <span style="color:#9ca3af;width:38px;font-family:monospace">${r.name}</span>
                <div style="flex:1;background:#374151;border-radius:2px;height:6px">
                  <div style="width:${r.wr}%;background:${col};height:6px;border-radius:2px"></div>
                </div>
                <span style="color:${col};width:30px;text-align:right">${r.wr}%</span>
                <span style="color:#444;font-size:10px">${r.total}</span>
              </div>`;
            }).join("")
        }
      </div>

    </div>
  </div>`;
  })()}

  <!-- Market Intelligence Panel -->
  <div style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:16px 20px;margin-bottom:20px" id="market-intel-panel">
    <div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">🧠 Market Intelligence</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px" id="intel-grid">

      <!-- Trade Readiness Score -->
      <div style="background:#2d3748;border:2px solid #374151;border-radius:8px;padding:12px" id="readiness-card">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">🎯 Trade Readiness</div>
        <div style="font-size:28px;font-weight:800" id="readiness-val">…</div>
        <div style="background:#374151;border-radius:4px;height:6px;margin:6px 0;overflow:hidden">
          <div id="readiness-bar" style="height:100%;border-radius:4px;background:#059669;transition:width .5s,background .5s;width:0%"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af" id="readiness-sub">Učitavam…</div>
      </div>

      <!-- BTC Regime -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">📊 BTC Regime (1H)</div>
        <div style="font-size:22px;font-weight:800" id="mi-regime-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="mi-regime-sub">BULL=LONG ok · BEAR=LONG blokiran</div>
      </div>

      <!-- Active Gates -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px;grid-column:span 2">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:8px;text-transform:uppercase">🚦 Aktivni Gateovi</div>
        <div id="gates-grid" style="display:flex;flex-wrap:wrap;gap:6px">…</div>
      </div>

      <!-- Circuit Breaker -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">🛑 Circuit Breaker</div>
        <div style="font-size:18px;font-weight:800;color:#d97706" id="cb-count">…/7</div>
        <div style="background:#374151;border-radius:4px;height:6px;margin:6px 0;overflow:hidden">
          <div id="cb-bar" style="height:100%;border-radius:4px;background:#00c48c;transition:width .5s,background .5s;width:0%"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af" id="cb-sub">učitavam…</div>
      </div>


      <!-- Daily P&L Budget -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">💰 Dnevni P&L Budget</div>
        <div style="font-size:18px;font-weight:800" id="daily-pnl-val">…</div>
        <div style="background:#374151;border-radius:4px;height:6px;margin:6px 0;overflow:hidden">
          <div id="daily-pnl-bar" style="height:100%;border-radius:4px;background:#00c48c;transition:width .5s,background .5s;width:0%"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af" id="daily-pnl-sub">Iskorišteno: 0% limita</div>
      </div>

      <!-- Funding Rate + 24h trend -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">💸 Funding Rate + Trend</div>
        <div style="font-size:14px;font-weight:700" id="fr-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="fr-sub">&gt;0.05% = LONG blokiran</div>
        <div style="font-size:11px;margin-top:5px" id="fr-trend-val"></div>
      </div>

      <!-- Fear & Greed -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">😱 Fear & Greed</div>
        <div style="font-size:22px;font-weight:800" id="fg-val">…</div>
        <div style="font-size:11px;margin-top:2px" id="fg-label">…</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:4px">&lt;20=Extreme Fear, &gt;80=Greed</div>
      </div>


      <!-- Session Filter -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">🕐 Trading Sesija</div>
        <div style="font-size:16px;font-weight:800" id="session-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="session-sub">01-06 UTC = dead zone blokiran</div>
      </div>


      <!-- VWAP Status -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">📊 VWAP Status</div>
        <div style="font-size:16px;font-weight:800" id="vwap-val">…</div>
        <div style="background:#374151;border-radius:4px;height:6px;margin:6px 0;overflow:hidden">
          <div id="vwap-bar" style="height:100%;border-radius:4px;background:#00c48c;transition:width .5s,background .5s;width:0%"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af" id="vwap-sub">Simboli unutar ±2.5% VWAP</div>
        <div id="vwap-list" style="margin-top:6px;font-size:10px;color:#ef4444"></div>
      </div>

      <!-- Countdown do sljedećeg eventa -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">⏱️ Sljedeći Econ Event</div>
        <div style="font-size:20px;font-weight:800;font-variant-numeric:tabular-nums" id="countdown-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="countdown-event">učitavam…</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px" id="countdown-time"></div>
      </div>

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
      const col = p.pnl > 0 ? "#059669" : p.pnl < 0 ? "#dc2626" : "#94a3b8";
      const icon = p.pnl > 0 ? "▲" : p.pnl < 0 ? "▼" : "—";
      const pct = def.startCapital > 0 ? (p.pnl / def.startCapital * 100).toFixed(2) : "0.00";
      return `<div style="background:#2d3748;border:1px solid #374151;border-radius:10px;padding:14px 18px">
        <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">${p.label}</div>
        <div style="font-size:22px;font-weight:800;color:${col}">${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}</div>
        <div style="font-size:12px;color:${col};margin-top:2px">${icon} ${p.pnl >= 0 ? "+" : ""}${pct}%</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">${p.trades} zatvorenih</div>
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
        <div class="chart-title" style="margin-bottom:2px">⚡ Scanner — ${ALL_SYMBOLS.length} simbola | Future combo, min 5/8 signala | ulaz na close 15m svijeće</div>
        <div style="font-size:12px;color:var(--text-muted)">
          Svi simboli (Future): E50+MACD+E145+PWHL+RDIV+MSTR+DEMA+LHUNT · min 5/8 (TAO/AAVE 4/8)
          &nbsp;|&nbsp; 🟡 SETUP &nbsp; 🟢 Signal &nbsp; 🚀 Momentum &nbsp; Cache 90s &nbsp;|&nbsp;
          <button onclick="toggleLegend()" style="background:none;border:1px solid #30363d;border-radius:4px;color:#9ca3af;font-size:11px;cursor:pointer;padding:2px 8px">📖 Legenda signala</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span id="scan-ts" style="font-size:12px;color:var(--text-muted)">—</span>
        <button class="scan-btn" id="scan-btn" onclick="doScan()">🔄 Skeniraj</button>
        <button class="scan-btn" style="border-color:#f85149;color:#f85149" onclick="resetAll()">🗑️ Reset SVE</button>
        <button class="scan-btn" style="border-color:#db2777;color:#db2777" onclick="resetOne('synapse_t')">🎯 Reset ULTRA</button>
      </div>
    </div>
    <div class="table-wrap">
      <table class="scan-table" id="scan-table">
        <thead>
          <tr>
            <th style="width:24px">#</th>
            <th>Symbol</th>
            <th>Cijena</th>
            <th style="color:#d97706;text-align:center">1H</th>
            <th style="color:#d97706;text-align:center">4OB <span style="font-weight:400;font-size:10px;color:#94a3b8">ADX·6Sc·RSI·VWAP</span></th>
            <th style="color:#db2777;text-align:center">6 Signala</th>
            <th style="color:#db2777;text-align:center;width:60px">↑↓</th>
            <th style="min-width:160px">Status</th>
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
      <div class="chart-title" style="margin-bottom:12px">📖 Opis signala — Future combo · gate-ovi (ADX/VOL) + 8 signala · min 5/8 za ulaz (TAO/AAVE 4/8)</div>
      <div style="margin-bottom:10px;font-size:11px;color:#f59e0b;background:#2d2000;border:1px solid #d97706;border-radius:6px;padding:8px 12px">
        ⚙️ <b>GATEVI (obvezni — blokiraju neovisno o score-u):</b>
        &nbsp; ADX ≥ 22 (trend jačina) &nbsp;·&nbsp; VOL_EXH (volumen ispod threshold-a) &nbsp;·&nbsp; VWAP cross/rejection (cijena na ispravnoj strani)
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:8px;font-size:12px">
        ${[
          ['E50↑',  '▲ Cijena > EMA50 → trend bullish  |  ▼ Cijena < EMA50 → trend bearish'],
          ['CVD↑',  '▲ CVD > 0 → kupci dominiraju volumenom (zadnjih 20 bara)  |  ▼ prodavači dominiraju'],
          ['MACD',  '▲ MACD histogram > 0 → momentum gore  |  ▼ histogram < 0 → momentum dolje'],
          ['E145',  '▲ Cijena > EMA145 → dugoročni bull trend  |  ▼ ispod EMA145 → bear'],
          ['PWHL',  '▲ Sweep ispod prošlotjednog Low + zatvorena svjeća natrag iznad → LONG  |  ▼ Sweep iznad PWH + zatvorena ispod → SHORT  |  · van zone'],
          ['RDIV',  '▲ RSI bullish divergencija (cijena LL, RSI HL) → iscrpljeni selleri  |  ▼ bearish div (cijena HH, RSI LH) → iscrpljeni buyeri'],
          ['MSTR',  '▲ HH + HL = uptrend struktura (zadnjih 60 bara)  |  ▼ LL + LH = downtrend  |  · nejasna struktura'],
          ['FVG',   '▲ Bullish Fair Value Gap — cijena u nezapunjenoj gap zoni  |  ▼ Bearish FVG — gap resistance  |  · nema FVG'],
        ].map(([k,v]) =>
          '<div style="background:#2d3748;border:1px solid #374151;border-radius:6px;padding:8px 10px">' +
          '<span style="font-weight:800;color:#db2777;font-size:11px;display:inline-block;min-width:44px">' + k + '</span>' +
          '<span style="color:#9ca3af">' + v + '</span></div>'
        ).join('')}
      </div>
      <div style="margin-top:10px;font-size:11px;color:#94a3b8">
        🟢 Zeleno = bullish signal aktiviran &nbsp;|&nbsp; 🔴 Crveno = bearish &nbsp;|&nbsp; ⬛ Sivo = neutral/nema signala &nbsp;|&nbsp;
        Min <b style="color:#db2777">6/8</b> signala · SL <b style="color:#d97706">1.5–3%</b> / TP <b style="color:#d97706">2.25–4.5%</b> po simbolu · rizik <b>1.5%</b> po tradeu
      </div>
    </div>
  </div>

  <!-- Closed trades -->
  <div style="margin-top:40px">
    ${tradesSections}
  </div>

</div>

<div class="footer">
  Auto-refresh svakih 60s &nbsp;|&nbsp; ${nowLocal()} (UTC+2)
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
        borderColor: "#db2777",
        backgroundColor: "rgba(232,93,154,0.08)",
        borderWidth: 2,
        pointRadius: data.length > 50 ? 0 : 3,
        pointBackgroundColor: "#db2777",
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
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 8 }, grid: { display: false } },
        y: {
          ticks: { color: "#94a3b8", callback: v => "$" + v.toFixed(0) },
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
  if (s === "SETUP↑")  return '<span style="color:#d97706;font-weight:600" title="Svi filteri OK, čeka cross">◈ SETUP ↑</span>';
  if (s === "SETUP↓")  return '<span style="color:#d97706;font-weight:600" title="Svi filteri OK, čeka cross">◈ SETUP ↓</span>';
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
    const col = v===1?'#059669':v===-1?'#dc2626':'#94a3b8';
    return '<span title="'+names5[i]+'" style="color:'+col+';font-size:10px">'+(v===1?'▲':v===-1?'▼':'·')+'</span>';
  }).join('');

  const scoreStr = bull > bear
    ? '<span style="color:#059669;font-weight:700">↑'+bull+'/5</span>'
    : bear > bull
    ? '<span style="color:#dc2626;font-weight:700">↓'+bear+'/5</span>'
    : '<span style="color:#9ca3af">'+Math.max(bull,bear)+'/5</span>';

  const sigPart = sig==="LONG"   ? ' <span class="sig-long">▲</span>'
                : sig==="SHORT"  ? ' <span class="sig-short">▼</span>'
                : sig==="SETUP↑" ? ' <span style="color:#d97706">◈↑</span>'
                : sig==="SETUP↓" ? ' <span style="color:#d97706">◈↓</span>' : '';

  return '<span title="'+tooltipText+'" style="font-size:12px">'+scoreStr+sigPart+'<br>'+dots5+'</span>';
}

// ULTRA: prikaz svih 16 signala
function ultraHtml(s) {
  const bull   = s.ultraBull ?? 0;
  const bear   = s.ultraBear ?? 0;
  const sig16  = s.ultraSigs16 || new Array(7).fill(0);
  const sig    = s.ultraSig || "—";

  if (!s.ultraSigs16) return '<span style="color:#94a3b8;font-size:11px">—</span>';

  // 8 signala v3 (bez SRB) + SMC: E50rev, CVDrev, MACD, E145, PWHL, RDIV, MSTR, FVG
  const names16 = ['E50↑','CVD↑','MACD','E145','PWHL','RDIV','MSTR','FVG'];
  const COMBOS_BADGE = {
    "BTCUSDT":[0,1,2,3,7],"ETHUSDT":[0,1,2,3,7],"AAVEUSDT":[0,1,2,3,7],
    "SOLUSDT":[0,1,3,5,6],"TAOUSDT":[0,1,3,5,6],
  };
  const _activeIdx = COMBOS_BADGE[s.symbol] ?? [0,1,2,3,4,5,6,7];
  const tooltipText = _activeIdx.map(i=>names16[i]+':'+(sig16[i]===1?'↑':sig16[i]===-1?'↓':'·')).join(' | ');

  const dots = _activeIdx.map(i => {
    const v = sig16[i];
    const col = v===1?'#059669':v===-1?'#dc2626':'#94a3b8';
    return '<span title="'+names16[i]+'" style="color:'+col+';font-size:9px">'+(v===1?'▲':v===-1?'▼':'·')+'</span>';
  }).join('');

  const scoreStr = bull > bear
    ? '<span style="color:#059669;font-weight:700">↑'+bull+'/5</span>'
    : bear > bull
    ? '<span style="color:#dc2626;font-weight:700">↓'+bear+'/5</span>'
    : '<span style="color:#9ca3af">'+Math.max(bull,bear)+'/5</span>';

  const sigPart = sig==="LONG"   ? ' <span class="sig-long">▲ LONG</span>'
                : sig==="SHORT"  ? ' <span class="sig-short">▼ SHORT</span>'
                : sig==="SETUP↑" ? ' <span style="color:#d97706;font-weight:600">◈↑</span>'
                : sig==="SETUP↓" ? ' <span style="color:#d97706;font-weight:600">◈↓</span>' : '';

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

async function closePosition(pid, symbol, btn) {
  if (!btn) return;
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "⚠️ POTVRDI?";
    btn.style.background = "#d97706";
    btn.style.color = "#000";
    setTimeout(function() {
      if (btn.dataset.confirm === "1") {
        btn.dataset.confirm = "";
        btn.textContent = "✕ Zatvori";
        btn.style.background = "#dc2626";
        btn.style.color = "#fff";
      }
    }, 4000);
    return;
  }
  btn.dataset.confirm = "";
  btn.textContent = "⏳ Šaljem...";
  btn.disabled = true;
  try {
    const r = await fetch("/api/close-position", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: pid, symbol: symbol })
    });
    const d = await r.json();
    if (d.ok) {
      btn.textContent = "✅ Zatvoreno";
      btn.style.background = "#059669";
      setTimeout(function() { location.reload(); }, 1500);
    } else {
      btn.textContent = "❌ " + d.error;
      btn.style.background = "#dc2626";
      btn.style.color = "#fff";
      btn.disabled = false;
    }
  } catch(e) {
    btn.textContent = "❌ Greska";
    btn.disabled = false;
  }
}

async function resetOne(pid) {
  if (!confirm("Resetirati " + pid + "? Briše se povijest i pozicije za taj portfolio.")) return;
  const r = await fetch("/api/reset-full", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({pid}) });
  const d = await r.json();
  alert(d.message || "Reset done");
  location.reload();
}

// ── Signal label boxes (7 signala — Option C) ──
// Maknuti: CRS (WR 14%), ADXsn (obavezan gate), 6Sc (obavezan gate), EMA smjer (nije obavezan)
// Maknuti 2025-05: E55⟳ (duplikat E50), VOL⟳ (asimetričan — nikad +1 za LONG)
// Maknuti Option C: RSI (redundantan s RSI gate-om), CHP (redundantan s ADX gate-om)
// ULTRA v4 — TraderaEdge: E50, MACD, E145, PWHL, RDIV, MSTR, DEMA, LHUNT (CVD/FVG/OB više nisu u combu)
const SIG_NAMES = ['E50','CVD','MACD','E145','PWHL','RDIV','MSTR','FVG','OB','DEMA','LHUNT'];

const SIG_COND_BULL = [
  'Cijena > EMA50 — bullish trend potvrđen',                             //  1. E50 TREND
  'CVD > 0 — kupci dominiraju volumenom',                                //  2. CVD TREND
  'MACD histogram > 0 — bullish momentum potvrđen',                      //  3. MACD
  'Cijena > EMA145 — dugoročni bull trend',                              //  4. E145
  'Cijena blizu prošlotjednog Low-a + RSI raste — tjedni support zone',  //  5. PWHL
  'RSI divergencija — niža cijena, viši RSI (bullish div)',              //  6. RDIV
  'HH + HL — market structure uptrend potvrđen',                         //  7. MSTR
  'Bullish FVG — cijena u nezapunjenoj gap zoni (imbalance support)',    //  8. FVG
  'Bullish OB — cijena se vratila u zonu zadnje crvene svjećice prije 3+ uzlaznih (institucijska potpora)', //  9. OB
  'Cijena iznad Daily EMA10 — dnevni bull momentum (Smart Hub)', // 10. DEMA
  'Sweep ključne zone (MOpen/WOpen/YOpen/PWL) + recovery iznad — Liquidity Hunt LONG', // 11. LHUNT
];
const SIG_COND_BEAR = [
  'Cijena < EMA50 — bearish trend potvrđen',                             //  1. E50 TREND
  'CVD < 0 — prodavači dominiraju volumenom',                            //  2. CVD TREND
  'MACD histogram < 0 — bearish momentum potvrđen',                     //  3. MACD
  'Cijena < EMA145 — dugoročni bear trend',                             //  4. E145
  'Cijena blizu prošlotjednog High-a + RSI pada — tjedni resistance',   //  5. PWHL
  'RSI divergencija — viša cijena, niži RSI (bearish div)',             //  6. RDIV
  'LL + LH — market structure downtrend potvrđen',                       //  7. MSTR
  'Bearish FVG — cijena u nezapunjenoj gap resistance zoni',            //  8. FVG
  'Bearish OB — cijena se vratila u zonu zadnje zelene svjećice prije 3+ silaznih (institucijska rezistencija)', //  9. OB
  'Cijena ispod Daily EMA10 — dnevni bear momentum (Smart Hub)',  // 10. DEMA
  'Fake breakout iznad ključne zone + pad ispod — Liquidity Hunt SHORT',      // 11. LHUNT
];
const SIG_COND_NEUT = [
  'Cijena na EMA50 — nema jasnog pullbacka',              //  1. E50
  'CVD ≈ 0 — nema dominacije kupaca/prodavača',           //  2. CVD
  'MACD nedostupan ili histogram = 0',                    //  3. MACD
  'EMA145 nedostupan',                                    //  4. E145
  'Cijena nije blizu prošlotjedne razine (van zone 1.5%)',//  5. PWHL
  'Nema RSI divergencije',                                //  6. RDIV
  'Nejasna market structure (nema dovoljno swingova)',    //  7. MSTR
  'Nema aktivnog Fair Value Gapa u blizini',              //  8. FVG
  'Cijena nije u Order Block zoni',                       //  9. OB
  'Daily EMA podaci nedostupni',                          // 10. DEMA
  'Nema likvidnosnih zona u blizini',                     // 11. LHUNT
];

function mandatoryBoxes(s) {
  const rsiNum  = parseFloat(s.rsi) || 50;
  const adxNum  = parseFloat(s.adx) || 0;
  const sig     = s.ultraSig;
  const sigs13  = s.ultraSigs16 || [];  // ultraSigs16 sada ima 9 elemenata

  // 1. ADX ≥ 22 — jak trend (obavezan). Bot koristi 22/27/32 ovisno o WR
  const adxOk  = adxNum >= 22;
  const adxCol = adxOk ? '#059669' : '#dc2626';
  const adxBg  = adxOk ? '#0d3d26' : '#3d0d0d';
  const adxTip = 'ADX ' + adxNum.toFixed(1) + (adxOk ? ' ≥ 22 ✓ — jak trend' : ' < 22 ✗ — slab trend, nema ulaza');

  // 2. 6Sc: 4/6 multi-EMA parova poravnato (obavezan, WR potvrđen 43.6%)
  //    Direktno iz scaleUp/scaleDn koji se sada vraćaju iz scanSymbol()
  const scUp = s.scaleUp ?? 0;
  const scDn = s.scaleDn ?? 0;
  const scaleOkLong  = scUp >= 4;
  const scaleOkShort = scDn >= 4;
  // Zeleno=LONG smjer, narančasto=SHORT smjer, crveno=nema jasnog smjera
  const scaleCol = scaleOkLong ? '#059669' : scaleOkShort ? '#d97706' : '#dc2626';
  const scaleBg  = scaleOkLong ? '#0d3d26' : scaleOkShort ? '#3d2200' : '#3d0d0d';
  const scaleDir = scaleOkLong ? scUp + '/6↑' : scaleOkShort ? scDn + '/6↓' : scUp + '/6';
  const scaleTip = '6-Scale: ' + scUp + '↑ / ' + scDn + '↓ od 6 EMA parova (treba ≥4)' +
    (scaleOkLong ? ' — LONG smjer ✓' : scaleOkShort ? ' — SHORT smjer ✓' : ' ✗ — nedovoljan smjer');

  // 3. RSI asimetričan — LONG: RSI<72, SHORT: RSI>30
  const isLongSig  = sig === "LONG"  || sig === "SETUP↑" || sig === "MOM↑";
  const isShortSig = sig === "SHORT" || sig === "SETUP↓" || sig === "MOM↓";

  const rsiLongOk  = rsiNum < 72;
  const rsiShortOk = rsiNum > 30;
  const rsiOk  = isShortSig ? rsiShortOk : rsiLongOk;
  const rsiCol = rsiOk ? '#059669' : '#dc2626';
  const rsiBg  = rsiOk ? '#0d3d26' : '#3d0d0d';
  const rsiTip = 'RSI ' + rsiNum.toFixed(1) + (isShortSig
    ? (rsiShortOk ? ' > 30 ✓ (nije oversold)' : ' ≤ 30 ✗ — oversold')
    : (rsiLongOk  ? ' < 72 ✓ (nije overbought)' : ' ≥ 72 ✗ — overbought'));

  // 4. VWAP gate — LONG iznad VWAP, SHORT ispod VWAP
  const vwapDist = s.vwapDistPct ?? null;
  const vwapLongOk  = vwapDist === null || vwapDist >= 0;   // cijena iznad VWAP
  const vwapShortOk = vwapDist === null || vwapDist <= 0;   // cijena ispod VWAP
  const vwapOk = isShortSig ? vwapShortOk : vwapLongOk;
  const vwapCol = vwapDist === null ? '#94a3b8' : vwapOk ? '#059669' : '#dc2626';
  const vwapBg  = vwapDist === null ? '#1c2128' : vwapOk ? '#0d3d26' : '#3d0d0d';
  const vwapDistStr = vwapDist !== null ? (vwapDist >= 0 ? '+' : '') + vwapDist.toFixed(1) + '%' : '?';
  const vwapTip = 'VWAP gate: cijena ' + vwapDistStr + ' od VWAP' +
    (vwapOk ? ' ✓ — ispravna strana' : ' ✗ — pogrešna strana, BLOKIRAN');

  function badge(label, col, bg, tip) {
    return '<span title="' + tip + '" style="display:inline-flex;flex-direction:column;align-items:center;background:' + bg +
      ';color:' + col + ';border:1px solid ' + col + '44;padding:2px 5px;font-size:10px;font-weight:700;border-radius:3px;margin:1px;min-width:36px;text-align:center">' +
      label + '</span>';
  }

  return badge('ADX', adxCol, adxBg, adxTip) +
         badge('6Sc', scaleCol, scaleBg, scaleTip) +
         badge('RSI', rsiCol, rsiBg, rsiTip) +
         badge('VWAP', vwapCol, vwapBg, vwapTip);
}

function sigBoxes(sigs, symbol) {
  if (!sigs || sigs.length === 0) return '<span style="color:#444">—</span>';
  const _combos = ${JSON.stringify(Object.fromEntries(Object.entries(SYMBOL_COMBOS).map(([k,v]) => [k, v.sigIdx])))};  // injektirano iz bot.js
  const activeIdx = _combos[symbol] ?? [0,2,3,4,5,6,9,10];
  return activeIdx.map(i => {
    const v    = sigs[i] ?? 0;
    const bg   = v === 1 ? '#0d3d26' : v === -1 ? '#3d0d0d' : '#1c2128';
    const col  = v === 1 ? '#059669' : v === -1 ? '#dc2626' : '#94a3b8';
    const bdr  = v === 1 ? '1px solid #00c48c44' : v === -1 ? '1px solid #ff4d4d44' : '1px solid #30363d';
    const icon = v === 1 ? '▲' : v === -1 ? '▼' : '·';
    const lbl  = SIG_NAMES[i] || i;
    const tip  = (i + 1) + '. ' + lbl + ': ' + (v === 1 ? SIG_COND_BULL[i] : v === -1 ? SIG_COND_BEAR[i] : SIG_COND_NEUT[i]);
    return '<span title="' + tip + '" style="display:inline-block;background:' + bg + ';color:' + col + ';border:' + bdr + ';padding:2px 5px;font-size:10px;font-weight:700;border-radius:3px;margin:1px;min-width:32px;text-align:center">' + lbl + '<br><span style="font-size:9px">' + icon + '</span></span>';
  }).join('');
}

function scoreBox(bull, bear, sig, minSig) {
  const total = 8;  // Future combo — 8 signala
  const minLabel = minSig ? '<br><span style="color:#444;font-size:9px">min:' + minSig + '</span>' : '';
  if (sig === "LONG")   return '<div style="background:rgba(5,150,105,0.15);border:1px solid #059669;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#059669;font-weight:800;font-size:16px">↑' + bull + '</span><span style="color:#94a3b8;font-size:11px">/' + total + '</span><br><span class="sig-long" style="font-size:11px">▲ LONG</span></div>';
  if (sig === "SHORT")  return '<div style="background:rgba(220,38,38,0.15);border:1px solid #dc2626;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#dc2626;font-weight:800;font-size:16px">↓' + bear + '</span><span style="color:#94a3b8;font-size:11px">/' + total + '</span><br><span class="sig-short" style="font-size:11px">▼ SHORT</span></div>';
  if (sig === "SETUP↑") return '<div style="background:rgba(240,165,0,0.1);border:1px solid #d9770644;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#d97706;font-weight:800;font-size:16px">↑' + bull + '</span><span style="color:#94a3b8;font-size:11px">/' + total + '</span><br><span style="color:#d97706;font-size:11px">◈ SETUP↑</span></div>';
  if (sig === "SETUP↓") return '<div style="background:rgba(240,165,0,0.1);border:1px solid #d9770644;border-radius:6px;padding:4px 8px;text-align:center"><span style="color:#d97706;font-weight:800;font-size:16px">↓' + bear + '</span><span style="color:#94a3b8;font-size:11px">/' + total + '</span><br><span style="color:#d97706;font-size:11px">◈ SETUP↓</span></div>';
  const top = Math.max(bull, bear);
  // Ako je bull blizu minSig — prikaži žuto upozorenje (1 signal nedostaje)
  const nearMiss = minSig && bull === minSig - 1;
  const col = nearMiss ? '#d97706' : bull > bear ? '#05966950' : bear > bull ? '#dc262650' : '#555';
  const bg  = nearMiss ? 'rgba(247,183,49,0.06)' : 'transparent';
  const brd = nearMiss ? 'border:1px solid #d9770633;border-radius:6px;' : '';
  return '<div style="text-align:center;padding:2px;' + brd + 'background:' + bg + '" title="Bull: ' + bull + ' / Bear: ' + bear + ' / Minimum: ' + (minSig||'?') + '">' +
    '<span style="color:' + col + ';font-size:14px;font-weight:700">' + top + '</span>' +
    '<span style="color:#444;font-size:11px">/' + total + '</span>' +
    (minSig ? '<br><span style="color:' + (nearMiss ? '#d97706' : '#333') + ';font-size:9px">min:' + minSig + (nearMiss ? ' ⚠' : '') + '</span>' : '') +
    '</div>';
}

function statusBox(s) {
  const sig = s.ultraSig;

  // Volume upozorenja — nizak vol (slabi signal) ili visok vol (VOL_EXH blocker)
  const volWarning = s.volHigh
    ? '<div style="font-size:10px;color:#ef4444;margin-top:3px">🚫 VOL_EXH: ' + s.volRatio + 'x ≥ ' + (s.volExhThreshold||1.5) + '× — bot blokiran</div>'
    : s.volLow
      ? '<div style="font-size:10px;color:#f59e0b;margin-top:3px">⚠️ VOL nizak ' + s.volRatio + 'x · slabi signal</div>'
      : '';

  // Aktivan signal — bot ulazi odmah na close svjećice
  if (sig === "LONG") {
    return '<div style="background:rgba(5,150,105,0.1);border:1px solid ' + (s.volLow ? '#f59e0b' : '#059669') + ';border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#059669;font-weight:700;margin-bottom:4px">' + (s.volLow ? '⚠️ SIGNAL (vol nizak)' : '✅ SIGNAL AKTIVIRAN') + '</div>' +
      '<div style="font-size:13px;font-weight:700;color:#059669">▲ LONG</div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:3px">Ulaz odmah @ <b style="color:#f9fafb">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBull||0) + '/8</b></div>' +
      volWarning +
      '</div>';
  }
  if (sig === "SHORT") {
    return '<div style="background:rgba(220,38,38,0.1);border:1px solid ' + (s.volLow ? '#f59e0b' : '#dc2626') + ';border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#dc2626;font-weight:700;margin-bottom:4px">' + (s.volLow ? '⚠️ SIGNAL (vol nizak)' : '✅ SIGNAL AKTIVIRAN') + '</div>' +
      '<div style="font-size:13px;font-weight:700;color:#dc2626">▼ SHORT</div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:3px">Ulaz odmah @ <b style="color:#f9fafb">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBear||0) + '/8</b></div>' +
      volWarning +
      '</div>';
  }
  if (sig === "SETUP↑") return '<span style="color:#d97706;font-size:12px">◈ SETUP ↑ &nbsp;<span style="color:#94a3b8;font-size:11px">(' + (s.ultraBull||0) + '/5)</span></span>' + (s.volLow ? '<br><span style="color:#f59e0b;font-size:10px">⚠️ VOL ' + s.volRatio + 'x</span>' : '');
  if (sig === "SETUP↓") return '<span style="color:#d97706;font-size:12px">◈ SETUP ↓ &nbsp;<span style="color:#94a3b8;font-size:11px">(' + (s.ultraBear||0) + '/5)</span></span>' + (s.volLow ? '<br><span style="color:#f59e0b;font-size:10px">⚠️ VOL ' + s.volRatio + 'x</span>' : '');
  if (sig === "MOM↑") {
    return '<div style="background:rgba(59,130,246,0.1);border:1px solid #3b82f6;border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#3b82f6;font-weight:700;margin-bottom:4px">🚀 MOMENTUM LONG</div>' +
      '<div style="font-size:13px;font-weight:700;color:#3b82f6">▲ LONG</div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:3px">Breakout ulaz @ <b style="color:#f9fafb">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBull||0) + '/8</b></div>' +
      '</div>';
  }
  if (sig === "MOM↓") {
    return '<div style="background:rgba(139,92,246,0.1);border:1px solid #8b5cf6;border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#8b5cf6;font-weight:700;margin-bottom:4px">🚀 MOMENTUM SHORT</div>' +
      '<div style="font-size:13px;font-weight:700;color:#8b5cf6">▼ SHORT</div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:3px">Breakdown ulaz @ <b style="color:#f9fafb">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBear||0) + '/8</b></div>' +
      '</div>';
  }

  // ── RSI + ADX Watch alert — oba moraju biti overextended ──────────────────
  const rsiNum = parseFloat(s.rsi);
  const adxNum = parseFloat(s.adx) || 0;
  if (!isNaN(rsiNum) && adxNum > 60) {
    // WATCH SHORT — RSI > 70 + ADX > 50: overbought + ekstremni trend
    if (rsiNum > 70) {
      return '<div style="background:rgba(220,38,38,0.06);border:1px solid #dc262650;border-radius:8px;padding:6px 10px">' +
        '<div style="font-size:11px;color:#dc2626;font-weight:700">⚠️ WATCH SHORT</div>' +
        '<div style="font-size:11px;color:#9ca3af;margin-top:2px">RSI <b style="color:#dc2626">' + s.rsi + '</b> + ADX <b style="color:#dc2626">' + s.adx + '</b> — overextended, moguć vrh</div>' +
        '<div style="font-size:10px;color:#94a3b8;margin-top:2px">Bull: ' + (s.ultraBull||0) + ' · Bear: ' + (s.ultraBear||0) + ' · Treba 12+ za SHORT</div>' +
        '</div>';
    }
    // WATCH LONG — RSI < 30 + ADX > 50: oversold + ekstremni downtrend
    if (rsiNum < 30) {
      return '<div style="background:rgba(5,150,105,0.06);border:1px solid #05966950;border-radius:8px;padding:6px 10px">' +
        '<div style="font-size:11px;color:#059669;font-weight:700">⚠️ WATCH LONG</div>' +
        '<div style="font-size:11px;color:#9ca3af;margin-top:2px">RSI <b style="color:#059669">' + s.rsi + '</b> + ADX <b style="color:#059669">' + s.adx + '</b> — overextended, moguć bounce</div>' +
        '<div style="font-size:10px;color:#94a3b8;margin-top:2px">Bull: ' + (s.ultraBull||0) + ' · Bear: ' + (s.ultraBear||0) + ' · Treba 12+ za LONG</div>' +
        '</div>';
    }
  }

  return '<span style="color:#444;font-size:12px">—</span>';
}

// ── Market Regime — via /api/regime endpoint (server-side, no CORS issues) ────
function applyRegime(regime) {
  var col  = regime === "BULL" ? "#059669" : regime === "BEAR" ? "#dc2626" : "#d97706";
  var icon = regime === "BULL" ? "📈" : regime === "BEAR" ? "📉" : "➡️";
  var sub  = regime === "BULL" ? "LONG ulazi aktivni" : regime === "BEAR" ? "LONG suspendiran" : "Čekamo trend";
  // Adaptivni Status section
  var el1 = document.getElementById("regime-val");
  var sb1 = document.getElementById("regime-sub");
  if (el1) { el1.textContent = icon + " " + regime; el1.style.color = col; }
  if (sb1) { sb1.textContent = sub; sb1.style.color = col; }
  // Market Intelligence section
  var el2 = document.getElementById("mi-regime-val");
  var sb2 = document.getElementById("mi-regime-sub");
  if (el2) { el2.textContent = icon + " " + regime; el2.style.color = col; }
  if (sb2) { sb2.textContent = sub; sb2.style.color = col; }
}

function loadBtcRegime() {
  fetch('/api/regime').then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.regime) applyRegime(d.regime);
  }).catch(function(e) { console.warn('regime fetch err:', e); });
}

// Učitaj regime na startu i svako 5 min
loadBtcRegime();
setInterval(loadBtcRegime, 5 * 60 * 1000);

// ── Lokalni timestamp helper (UTC+2) — klijentska strana ──────────────────────
function fmtLocalTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 16).replace("T", " ");
  d.setHours(d.getHours() + 2);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

async function doScan() {
  const btn   = document.getElementById("scan-btn");
  const tbody = document.getElementById("scan-tbody");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⟳</span> Skenira...';
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:32px;color:#9ca3af"><span class="spin" style="font-size:20px">⟳</span><br>Fetcham ${ALL_SYMBOLS.length} simbola na 15m+1H TF...</td></tr>';

  try {
    const r = await fetch("/api/scan");
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    const ts = fmtLocalTs(d.ts || "");
    const results = d.results || [];

    // Sort: pending first, then signal, then setup, then score desc, then neutral
    results.sort((a, b) => {
      function rank(s) {
        if (s.pending) return 0;
        if (s.ultraSig === "LONG" || s.ultraSig === "SHORT") return 1;
        if (s.ultraSig === "MOM↑" || s.ultraSig === "MOM↓") return 1;
        if ((s.ultraSig||"").startsWith("SETUP")) return 2;
        return 3 + (16 - Math.max(s.ultraBull||0, s.ultraBear||0));
      }
      return rank(a) - rank(b);
    });

    const longs   = results.filter(s => s.ultraSig === "LONG").length;
    const shorts  = results.filter(s => s.ultraSig === "SHORT").length;
    const pending = results.filter(s => s.pending).length;
    const setups  = results.filter(s => (s.ultraSig||"").startsWith("SETUP")).length;
    document.getElementById("scan-ts").textContent = ts + " (UTC+2) | ▲ " + longs + " LONG · ▼ " + shorts + " SHORT · ⏳ " + pending + " čeka · ◈ " + setups + " setup";

    // ── Market Breadth — iz scan rezultata ───────────────────────────────
    const total     = results.filter(s => !s.error).length;
    const bullish   = results.filter(s => !s.error && parseFloat(s.adx||0) >= 30 && (s.ultraBull||0) > (s.ultraBear||0)).length;
    const bearish   = results.filter(s => !s.error && parseFloat(s.adx||0) >= 30 && (s.ultraBear||0) > (s.ultraBull||0)).length;
    const breadthEl = document.getElementById('breadth-val');
    const breadthSb = document.getElementById('breadth-sub');
    if (breadthEl) {
      const bCol = bullish > bearish ? '#059669' : bearish > bullish ? '#dc2626' : '#9ca3af';
      breadthEl.textContent = '▲' + bullish + ' / ▼' + bearish + ' / —' + (total - bullish - bearish);
      breadthEl.style.color = bCol;
      breadthSb.textContent = 'od ' + total + ' simbola s ADX≥30 u trendu';
    }

    tbody.innerHTML = results.map((s, i) => {
      if (s.error) return '<tr><td colspan="8" style="color:#dc2626;padding:6px 10px">' + s.symbol + ': ' + s.error + '</td></tr>';

      const rsiNum = parseFloat(s.rsi);
      const rsiCol = isNaN(rsiNum) ? "#94a3b8" : rsiNum > 70 ? "#dc2626" : rsiNum < 30 ? "#059669" : rsiNum > 60 ? "#ea580c" : rsiNum < 40 ? "#0284c7" : "#475569";
      const adxNum = parseFloat(s.adx);
      const adxCol = isNaN(adxNum) ? "#94a3b8" : adxNum > 25 ? "#059669" : adxNum > 18 ? "#d97706" : "#94a3b8";

      const hasPending = !!s.pending;
      const hasSignal  = s.ultraSig === "LONG" || s.ultraSig === "SHORT";
      const rowBg = hasPending ? "background:rgba(247,183,49,0.04)" : hasSignal ? "background:rgba(5,150,105,0.04)" : "";

      // SL/TP — ATR-based u tradeu, prikazujemo tier kao referencu
      const slTpCol = (s.slPct >= 2.5) ? '#d97706' : (s.slPct >= 2.0) ? '#ff8c42' : '#94a3b8';
      const slTpTier = s.slPct && s.tpPct ? '(tier ' + s.slPct + '/' + s.tpPct + '%)' : '';
      const slTp = 'ATR-based <span style="font-size:9px;color:#6b7280">' + slTpTier + '</span>';

      // VWAP distanca
      const vwapDist = s.vwapDistPct;
      const vwapAbove25 = vwapDist !== null && Math.abs(vwapDist) > 2.5;

      const t1h = s.trend1h || 'UNKNOWN';
      const t1hCol  = t1h === 'BULL' ? '#10b981' : t1h === 'BEAR' ? '#ef4444' : '#6b7280';
      const t1hIcon = t1h === 'BULL' ? '▲' : t1h === 'BEAR' ? '▼' : '·';

      const volR = s.volRatio ?? null;
      const volThr = s.volExhThreshold ?? 1.5;
      const volCol = volR === null ? '#6b7280' : s.volHigh ? '#ef4444' : s.volLow ? '#f59e0b' : volR >= 1.2 ? '#10b981' : '#6b7280';
      const volIcon = volR === null ? '' : s.volHigh ? ' 🚫' : s.volLow ? ' ⚠️' : '';
      const volStr  = volR !== null ? volR.toFixed(2) + '×' + volIcon : '—';
      const rsiAdxInfo = '<div style="font-size:10px;color:#6b7280;margin-top:2px">RSI <span style="color:' + rsiCol + '">' + (s.rsi||'—') + '</span> · ADX <span style="color:' + adxCol + '">' + (s.adx||'—') + '</span> · Vol <span style="color:' + volCol + '" title="Vol/Avg20: ' + volStr + ' | VOL_EXH threshold: ' + volThr + '×">' + volStr + '</span></div>';

      // Procjena ulaza — SL i TP razine na temelju trenutne cijene
      const _sig7 = s.synapse7Sig || '';
      const _sigDir = _sig7 === 'LONG' ? 'LONG' : _sig7 === 'SHORT' ? 'SHORT' : null;
      const _p = s.price || 0;
      const _sl = s.slPct || 2.0;
      const _tp = s.tpPct || 3.0;
      let entryInfo = '';
      if (_sigDir && _p > 0) {
        const slPrice = _sigDir === 'LONG' ? _p * (1 - _sl/100) : _p * (1 + _sl/100);
        const tpPrice = _sigDir === 'LONG' ? _p * (1 + _tp/100) : _p * (1 - _tp/100);
        const fmt4 = v => v >= 1000 ? v.toFixed(1) : v >= 100 ? v.toFixed(2) : v >= 10 ? v.toFixed(3) : v >= 1 ? v.toFixed(4) : v.toFixed(5);
        const entryCol = _sigDir === 'LONG' ? '#10b981' : '#ef4444';
        const arrow = _sigDir === 'LONG' ? '▲' : '▼';
        entryInfo = '<div style="font-size:9px;margin-top:3px;line-height:1.6">'
          + '<span style="color:' + entryCol + ';font-weight:700">' + arrow + ' ' + fmt4(_p) + '</span>'
          + '<span style="color:#6b7280"> → </span>'
          + '<span style="color:#ef4444" title="Stop Loss">SL ' + fmt4(slPrice) + '</span>'
          + '<span style="color:#6b7280"> | </span>'
          + '<span style="color:#10b981" title="Take Profit">TP ' + fmt4(tpPrice) + '</span>'
          + '</div>';
      }


      return '<tr style="' + rowBg + '">' +
        '<td style="color:#94a3b8;font-size:11px;text-align:center;padding:6px 4px">' + (i+1) + '</td>' +
        '<td style="font-weight:800;font-size:13px;white-space:nowrap;padding:6px 8px">' + s.symbol.replace("USDT","") + '<span style="color:#94a3b8;font-size:10px;font-weight:400">USDT</span>' +
          '<div style="font-size:9px;color:' + slTpCol + ';font-weight:500;margin-top:1px">' + slTp + '</div>' + rsiAdxInfo + '</td>' +
        '<td style="font-weight:600;white-space:nowrap;font-size:12px;padding:6px 8px">' + fmtLive(s.price) + entryInfo + '</td>' +
        '<td style="text-align:center;font-weight:800;color:' + t1hCol + ';font-size:13px;padding:6px 4px" title="1H EMA20: ' + t1h + '">' + t1hIcon + '</td>' +
        '<td style="padding:4px 6px;border-right:1px solid #d9770633">' + mandatoryBoxes(s) + '</td>' +
        '<td style="padding:4px 4px">' + sigBoxes(s.ultraSigs16, s.symbol) + '</td>' +
        '<td style="padding:4px 6px;text-align:center">' + scoreBox(s.ultraBull||0, s.ultraBear||0, s.ultraSig, s.ultraMinSig) + '</td>' +
        '<td style="padding:4px 6px">' + statusBox(s) + '</td>' +
        '</tr>';
    }).join("");

    // ── Ažuriraj MM Filteri karticu ─────────────────────────────────────────
    const mmGrid = document.getElementById('mm-filters-grid');
    if (mmGrid) {
      const mmSymbols = results.filter(s => s.mmFilters && s.mmFilters.length > 0);
      if (mmSymbols.length === 0) {
        mmGrid.innerHTML = '<span style="color:#059669;font-size:12px">✓ Nema aktivnih MM blokatora na watchlisti</span>';
      } else {
        mmGrid.innerHTML = mmSymbols.map(s => {
          const sym = s.symbol.replace('USDT','');
          const badges = s.mmFilters.map(f =>
            '<span title="' + f.tip + '" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);border-radius:3px;padding:1px 5px;font-size:10px;color:#fca5a5;font-weight:600">' + f.label + '</span>'
          ).join(' ');
          return '<div style="background:#374151;border-radius:6px;padding:6px 10px;font-size:11px">' +
            '<span style="color:#f9fafb;font-weight:700;margin-right:6px">' + sym + '</span>' + badges + '</div>';
        }).join('');
      }
    }

    // ── Ažuriraj VWAP karticu ────────────────────────────────────────────────
    const withVwap = results.filter(s => s.vwapDistPct !== null && s.vwapDistPct !== undefined);
    if (withVwap.length > 0) {
      const inRange   = withVwap.filter(s => Math.abs(s.vwapDistPct) <= 2.5).length;
      const overextended = withVwap.filter(s => Math.abs(s.vwapDistPct) > 2.5);
      const pct = Math.round(inRange / withVwap.length * 100);
      const vwapCol = pct >= 70 ? '#10b981' : pct >= 50 ? '#d97706' : '#ef4444';
      const vEl = document.getElementById('vwap-val');
      const vBar = document.getElementById('vwap-bar');
      const vSub = document.getElementById('vwap-sub');
      const vList = document.getElementById('vwap-list');
      if (vEl)  { vEl.textContent = inRange + '/' + withVwap.length + ' unutar ranga'; vEl.style.color = vwapCol; }
      if (vBar) { vBar.style.width = pct + '%'; vBar.style.background = vwapCol; }
      if (vSub) vSub.textContent = 'Simboli unutar ±2.5% od VWAP-a';
      if (vList && overextended.length > 0) {
        vList.innerHTML = overextended.map(s => {
          const d = s.vwapDistPct > 0 ? '+' + s.vwapDistPct : s.vwapDistPct;
          const col = s.vwapDistPct > 0 ? '#f59e0b' : '#60a5fa';
          return '<span style="color:' + col + ';margin-right:8px">' + s.symbol.replace('USDT','') + ' ' + d + '%</span>';
        }).join('');
      } else if (vList) {
        vList.innerHTML = '<span style="color:#10b981">Svi unutar ranga ✓</span>';
      }
    }

  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#dc2626;padding:24px">Greška: ' + e.message + '</td></tr>';
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
      unr.style.color = unrPnl >= 0 ? '#059669' : '#dc2626';
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

// Bitget live Win Rate (zadnjih 100 zatvorenih pozicija)
async function loadBitgetWR() {
  const el  = document.getElementById('bitget-wr');
  const sub = document.getElementById('bitget-wr-sub');
  if (!el) return;
  try {
    const r = await fetch('/api/bitget-wr');
    const d = await r.json();
    if (d.ok && d.total > 0) {
      const col = d.wr >= 50 ? '#059669' : d.wr >= 35 ? '#d97706' : '#dc2626';
      el.textContent = d.wr.toFixed(1) + '%';
      el.style.color = col;
      sub.textContent = d.wins + 'W / ' + d.losses + 'L (' + d.total + ' trejdova)';
    } else {
      el.textContent = 'N/A';
      sub.textContent = d.error || 'nema podataka';
    }
  } catch(e) {
    el.textContent = 'err';
  }
}
loadBitgetWR();
setInterval(loadBitgetWR, 60000);

// Auto-scan on load after 2s delay
setTimeout(doScan, 2000);

// Adaptivni auto-scan:
//  :55–:05 (5 min oko zatvaranja svjećice) → svake 30s  — bot uskoro skenira
//  ostalo                                  → svakih 5min — svjećica se polako gradi
function scheduleNextScan() {
  var min = new Date().getMinutes();
  var nearClose = min >= 55 || min < 5;
  var delay = nearClose ? 30 * 1000 : 5 * 60 * 1000;
  setTimeout(function() { doScan(); scheduleNextScan(); }, delay);
}
scheduleNextScan();

async function loadMarketContext() {
  try {
    const r = await fetch('/api/market-context');
    const d = await r.json();

    // ── Trade Readiness Score ─────────────────────────────────────────────
    if (d.readiness) {
      const sc  = d.readiness.score || 0;
      const col = sc >= 70 ? '#059669' : sc >= 45 ? '#d97706' : '#dc2626';
      const lbl = sc >= 70 ? '🟢 Spreman za trading' : sc >= 45 ? '🟡 Djelomično blokiran' : '🔴 Većina uvjeta blokirana';
      document.getElementById('readiness-val').textContent = sc + '%';
      document.getElementById('readiness-val').style.color = col;
      document.getElementById('readiness-bar').style.width = sc + '%';
      document.getElementById('readiness-bar').style.background = col;
      document.getElementById('readiness-sub').textContent = lbl;
      document.getElementById('readiness-card').style.borderColor = col;
    }

    // ── BTC Regime — loadBtcRegime() handles this via /api/regime ────────

    // ── Active Gates ──────────────────────────────────────────────────────
    if (d.readiness?.gates) {
      const html = d.readiness.gates.map(g => {
        const bg  = g.ok ? 'rgba(5,150,105,0.15)' : 'rgba(220,38,38,0.15)';
        const col = g.ok ? '#059669' : '#dc2626';
        const ic  = g.ok ? '✓' : '✗';
        return '<span style="background:' + bg + ';color:' + col + ';border:1px solid ' + col + '50;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:600">' + ic + ' ' + g.name + '</span>';
      }).join('');
      document.getElementById('gates-grid').innerHTML = html;
    }

    // ── Long/Short Ratio ──────────────────────────────────────────────────
    if (d.ls) {
      const lr = parseFloat(d.ls.longRatio);
      const lsCol = lr > 70 ? '#dc2626' : lr < 40 ? '#059669' : '#9ca3af';
      const lsWarn = lr > 70 ? ' ⚠️ Contrarian SHORT' : lr < 40 ? ' 💡 Contrarian LONG' : '';
      document.getElementById('ls-val').textContent = '⬆ ' + d.ls.longRatio + '% / ⬇ ' + d.ls.shortRatio + '%';
      document.getElementById('ls-val').style.color = lsCol;
      document.getElementById('ls-bar').style.width = d.ls.longRatio + '%';
      document.getElementById('ls-bar').style.background = lr > 70 ? '#dc2626' : lr < 40 ? '#059669' : '#3b82f6';
      document.getElementById('ls-sub').textContent = 'Trend: ' + (d.ls.trend || '—') + lsWarn;
    }

    // ── Countdown — spremi econ evente za timer ───────────────────────────
    if (d.econ && d.econ.events) { window._econEventsForCountdown = d.econ.events; }

    // Circuit Breaker
    const cbCount = d.consecLosses || 0;
    const cbMax = d.cbLosses || 7;
    const cbPct = Math.min(cbCount / cbMax * 100, 100);
    const cbColor = cbPct >= 85 ? '#dc2626' : cbPct >= 57 ? '#d97706' : '#059669';
    document.getElementById('cb-count').textContent = cbCount + '/' + cbMax + ' gubitaka';
    document.getElementById('cb-count').style.color = cbColor;
    document.getElementById('cb-bar').style.width = cbPct + '%';
    document.getElementById('cb-bar').style.background = cbColor;
    document.getElementById('cb-sub').textContent = cbPct >= 85 ? '🚨 OPASNO! Blizu pauze' : cbCount === 0 ? 'Sve OK' : 'Još ' + (cbMax - cbCount) + ' do pauze';

    // Daily P&L Budget
    const dp = d.dailyPnl || 0;
    const dlim = d.dailyLimit || 20;
    const dpPct = Math.min(Math.abs(dp) / dlim * 100, 100);
    const dpColor = dpPct >= 80 ? '#dc2626' : dpPct >= 60 ? '#d97706' : '#059669';
    document.getElementById('daily-pnl-val').textContent = (dp >= 0 ? '+' : '') + '$' + dp.toFixed(2);
    document.getElementById('daily-pnl-val').style.color = dp < 0 ? '#dc2626' : '#059669';
    document.getElementById('daily-pnl-bar').style.width = dpPct + '%';
    document.getElementById('daily-pnl-bar').style.background = dpColor;
    document.getElementById('daily-pnl-sub').textContent = 'Iskorišteno: ' + dpPct.toFixed(0) + '% limita ($' + dlim.toFixed(0) + ' = 3% equityja)';

    // Funding Rates + trend
    if (d.fr && Object.keys(d.fr).length > 0) {
      const sorted = Object.entries(d.fr).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4);
      const frHtml = sorted.map(([sym, rate]) => {
        const color = rate > 0.05 ? '#dc2626' : rate > 0.02 ? '#d97706' : '#059669';
        const blocked = rate > 0.05 ? ' 🚫' : '';
        return '<span style="color:' + color + ';font-size:12px">' + sym.replace('USDT','') + ': ' + rate.toFixed(3) + '%' + blocked + '</span>';
      }).join('<br>');
      document.getElementById('fr-val').innerHTML = frHtml;

      // Trend: koliko simbola ima pozitivan (bullish perp premium) vs negativan funding
      const rates = Object.values(d.fr);
      const highFr  = rates.filter(r => r > 0.05).length;
      const midFr   = rates.filter(r => r > 0.02 && r <= 0.05).length;
      const okFr    = rates.filter(r => r <= 0.02).length;
      const frTrendEl = document.getElementById('fr-trend-val');
      if (frTrendEl) {
        const trendColor = highFr > 2 ? '#dc2626' : midFr > 3 ? '#d97706' : '#059669';
        const trendText  = highFr > 2 ? ('⚠️ ' + highFr + ' simbola s visokim FR — overheated') :
                           midFr  > 3 ? ('🟡 ' + midFr + ' simbola s povišenim FR') :
                           ('✅ ' + okFr + '/' + rates.length + ' simbola s normalnim FR');
        frTrendEl.textContent = trendText;
        frTrendEl.style.color = trendColor;
      }
    }

    // Fear & Greed
    if (d.fg && d.fg.value !== null) {
      const fgV = d.fg.value;
      const fgColor = fgV < 25 ? '#388bfd' : fgV < 45 ? '#059669' : fgV < 55 ? '#94a3b8' : fgV < 75 ? '#d97706' : '#dc2626';
      document.getElementById('fg-val').textContent = fgV;
      document.getElementById('fg-val').style.color = fgColor;
      document.getElementById('fg-label').textContent = d.fg.label || '';
      document.getElementById('fg-label').style.color = fgColor;
    }

    // BTC Dominance
    if (d.dom && d.dom.btc !== null) {
      document.getElementById('dom-val').textContent = d.dom.btc + '%';
    }

    // DXY
    if (d.dxy) {
      const dxyV = d.dxy.change4h;
      const dxyEl = document.getElementById('dxy-val');
      const dxySubEl = document.getElementById('dxy-sub');
      if (dxyV !== null && dxyV !== undefined) {
        const dxyColor = dxyV > 0.3 ? '#dc2626' : dxyV < -0.3 ? '#059669' : '#94a3b8';
        dxyEl.textContent = (dxyV > 0 ? '+' : '') + dxyV + '%';
        dxyEl.style.color = dxyColor;
        dxySubEl.textContent = d.dxy.direction + ' | >+0.3% = LONG risk';
      } else {
        dxyEl.textContent = 'N/A';
        dxyEl.style.color = '#6b7280';
        dxySubEl.textContent = '>+0.3% = LONG risk · API nedostupan';
      }
    }

    // Session Info
    if (d.session) {
      const s = d.session;
      const sessColor = s.dead ? '#dc2626' : s.quality === 'PRIME' ? '#059669' : s.quality === 'GOOD' ? '#d97706' : '#94a3b8';
      const sessIcon  = s.dead ? '🌙' : s.quality === 'PRIME' ? '🟢' : s.quality === 'GOOD' ? '🟡' : '🔵';
      const sessEl = document.getElementById('session-val');
      if (sessEl) {
        sessEl.textContent = sessIcon + ' ' + s.session + ' sesija';
        sessEl.style.color = sessColor;
        document.getElementById('session-sub').textContent =
          s.dead ? '01-06 UTC blokiran — nizak volumen' :
          s.quality === 'PRIME' ? '13-21 UTC — NY, vrhunska likvidnost' :
          s.quality === 'GOOD'  ? '08-16 UTC — London, dobra likvidnost' :
          'Srednja likvidnost';
      }
    }

    // ATR Trend
    if (d.atrTrend) {
      const at = d.atrTrend;
      const atColor = at.trend === 'EXPANDING' ? '#dc2626' : at.trend === 'CONTRACTING' ? '#388bfd' : '#059669';
      const atIcon  = at.trend === 'EXPANDING' ? '📈' : at.trend === 'CONTRACTING' ? '📉' : '➡️';
      const atEl = document.getElementById('atr-trend-val');
      if (atEl) {
        atEl.textContent = atIcon + ' ' + at.trend;
        atEl.style.color = atColor;
        document.getElementById('atr-trend-sub').textContent =
          'Volatilnost ' + at.ratio + 'x prosjeka' +
          (at.trend === 'EXPANDING' ? ' — size ×0.7 (zaštita)' :
           at.trend === 'CONTRACTING' ? ' — čekaj breakout' : ' — normalno');
      }
    }

    // SP500
    if (d.sp500 && d.sp500.change4h !== null) {
      const sp = d.sp500;
      const spColor = sp.regime === 'RISK_OFF' ? '#dc2626' : sp.regime === 'RISK_ON' ? '#059669' : '#94a3b8';
      const spIcon  = sp.regime === 'RISK_OFF' ? '🚨' : sp.regime === 'RISK_ON' ? '🟢' : '➡️';
      document.getElementById('sp500-val').textContent = (sp.change4h > 0 ? '+' : '') + sp.change4h + '%';
      document.getElementById('sp500-val').style.color = spColor;
      document.getElementById('sp500-sub').textContent =
        spIcon + ' ' + sp.regime + (sp.regime === 'RISK_OFF' ? ' — LONG ulazi blokirani!' : ' | ES=F @ ' + (sp.last || ''));
    }

    // Liquidation Risk + OI trend
    if (d.liq && d.liq.overall !== null) {
      const liq = d.liq;
      const liqColor = liq.risk === 'HIGH'   ? '#dc2626'
                     : liq.risk === 'MEDIUM' ? '#d97706' : '#059669';
      const liqIcon  = liq.risk === 'HIGH' ? '🚨' : liq.risk === 'MEDIUM' ? '⚠️' : '✅';
      const liqEl = document.getElementById('liq-val');
      if (liqEl) {
        liqEl.textContent = liqIcon + ' ' + liq.risk + '  (' + liq.overall + '/100)';
        liqEl.style.color = liqColor;
        document.getElementById('liq-bar').style.width = liq.overall + '%';
        document.getElementById('liq-bar').style.background = liqColor;
        document.getElementById('liq-sub').textContent =
          liq.risk === 'HIGH'   ? 'Visok funding — previše longova, kaskadni pad moguć' :
          liq.risk === 'MEDIUM' ? 'Srednji rizik — prati funding rate' :
          'Nizak rizik — balansiran leverage u tržištu';
      }
      // OI trend iz liq podataka
      const oiEl = document.getElementById('oi-trend-val');
      if (oiEl && d.liq.oiTrend) {
        const rising  = d.liq.oiTrend.filter(x => x.trend === 'RASTE').length;
        const falling = d.liq.oiTrend.filter(x => x.trend === 'PADA').length;
        const oiCol   = rising > falling ? '#059669' : falling > rising ? '#dc2626' : '#9ca3af';
        oiEl.textContent = 'OI: ▲' + rising + ' raste · ▼' + falling + ' pada';
        oiEl.style.color = oiCol;
      } else if (oiEl) {
        // Fallback: iz liq score procijeni
        const oiMsg = liq.overall > 60 ? '📈 OI visok — overlevered' : liq.overall < 30 ? '📉 OI nizak — malo leveragea' : '➡️ OI neutralan';
        oiEl.textContent = oiMsg;
        oiEl.style.color = liqColor;
      }
    }

    // Ekonomski kalendar
    if (d.econ) {
      const econ = d.econ;
      const status = econ.status || {};
      const events = econ.events || [];
      const econEl = document.getElementById('econ-val');
      const econSub = document.getElementById('econ-sub');
      const econList = document.getElementById('econ-list');
      if (econEl) {
        if (status.blocked) {
          econEl.textContent = "BLOKIRANO — " + status.event;
          econEl.style.color = "#ef4444";
          if (econSub) econSub.textContent = "Trading pauziran +-15min oko HIGH impact eventa";
        } else if (status.next) {
          const inMin = Math.round((new Date(status.next.date).getTime() - Date.now()) / 60000);
          econEl.textContent = inMin > 0 ? ("Sljedeci: " + status.next.title + " za " + inMin + "min") : "Slobodno";
          econEl.style.color = inMin > 0 && inMin <= 30 ? "#fbbf24" : "#10b981";
          if (econSub) econSub.textContent = inMin > 0 && inMin <= 30 ? "Upozorenje: HIGH impact event blizu" : "Nema HIGH impact eventa u narednih 30min";
        } else {
          econEl.textContent = "Slobodno";
          econEl.style.color = "#10b981";
          if (econSub) econSub.textContent = events.length + " HIGH impact USD eventa ovaj tjedan";
        }
      }
      if (econList && events.length) {
        const now2 = Date.now();
        econList.innerHTML = events.slice(0, 8).map(function(ev) {
          const evTime = new Date(ev.date).getTime();
          const diff   = evTime - now2;
          const past   = diff < 0;
          const diffMin = Math.floor(Math.abs(diff) / 60000);
          const diffH   = Math.floor(diffMin / 60);
          const label   = past ? (diffMin < 60 ? diffMin + "min nazad" : diffH + "h nazad")
                                : (diffMin < 60 ? "za " + diffMin + "min" : "za " + diffH + "h");
          const near = !past && diff < 30 * 60000;
          const bg   = past ? "#374151" : near ? "rgba(251,191,36,0.15)" : "rgba(96,165,250,0.1)";
          const brd  = past ? "#4b5563" : near ? "#fbbf24" : "#60a5fa";
          const col  = past ? "#6b7280" : near ? "#fbbf24" : "#f9fafb";
          return '<div style="background:' + bg + ';border:1px solid ' + brd + ';border-radius:6px;padding:5px 10px;font-size:11px;color:' + col + ';white-space:nowrap">' +
                 '<b>' + ev.title + '</b> <span style="opacity:.7">' + label + '</span></div>';
        }).join('');
      }
    }

  } catch(e) { console.error('market-context error:', e); }
}

loadMarketContext();
setInterval(loadMarketContext, 2 * 60 * 1000);

// ── Countdown timer do sljedećeg HIGH impact econ eventa ─────────────────────
window._econEventsForCountdown = [];
function updateCountdown() {
  var events = window._econEventsForCountdown || [];
  var now = Date.now();
  var upcoming = events
    .map(function(e) { return { title: e.title || e.name || '?', ts: new Date(e.date).getTime() }; })
    .filter(function(e) { return e.ts > now; })
    .sort(function(a, b) { return a.ts - b.ts; });

  var valEl   = document.getElementById('countdown-val');
  var evtEl   = document.getElementById('countdown-event');
  var timeEl  = document.getElementById('countdown-time');
  if (!valEl) return;

  if (upcoming.length === 0) {
    valEl.textContent  = 'Nema';
    evtEl.textContent  = 'Nema nadolazećih eventa ovaj tjedan';
    if (timeEl) timeEl.textContent = '';
    return;
  }

  var next = upcoming[0];
  var diff = next.ts - now;
  var h = Math.floor(diff / 3600000);
  var m = Math.floor((diff % 3600000) / 60000);
  var s = Math.floor((diff % 60000) / 1000);
  var col = h < 1 ? '#dc2626' : h < 4 ? '#d97706' : '#9ca3af';

  valEl.textContent = (h > 0 ? h + 'h ' : '') + m + 'm ' + s + 's';
  valEl.style.color = col;
  evtEl.textContent = next.title;
  evtEl.style.color = col;
  if (timeEl) {
    var d = new Date(next.ts);
    timeEl.textContent = d.toLocaleString('hr-HR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
  }
}
updateCountdown();
setInterval(updateCountdown, 1000);

// ── MM Sweep Detektor — live Coinglass liquidation data ───────────────────────
async function loadSweepStatus() {
  try {
    const r = await fetch("/api/sweep");
    const d = await r.json();
    const statusEl  = document.getElementById('sweep-status');
    const barEl     = document.getElementById('sweep-bar');
    const subEl     = document.getElementById('sweep-sub');
    const liqRowEl  = document.getElementById('sweep-liq-row');
    const cardEl    = document.getElementById('sweep-card');
    if (!statusEl) return;

    // ── Pauza aktivna (sweep detektiran) ──────────────────────────────────────
    if (d.paused) {
      const remH = (d.remainMs / 3600000).toFixed(1);
      const liqM = d.sweepState.liquidationUsd ? (d.sweepState.liquidationUsd/1e6).toFixed(0) : '?';
      statusEl.textContent = '🛑 SWEEP PAUZA';
      statusEl.style.color = '#dc2626';
      barEl.style.width    = '100%';
      barEl.style.background = '#dc2626';
      cardEl.style.borderColor = '#dc2626';
      cardEl.style.boxShadow = '0 0 12px rgba(220,38,38,0.4)';
      subEl.textContent = '⏸ Novi ulazi blokirani još ' + remH + 'h · $' + liqM + 'M likvida';
      subEl.style.color = '#dc2626';
    }
    // ── Normalno — prikaz BTC vol ratio zadnjih 90min ────────────────────────
    else {
      cardEl.style.borderColor = '#374151';
      cardEl.style.boxShadow = '';
      if (d.btcVol) {
        const maxR = d.btcVol.maxVolRat;
        // Boja: zelena < 1.5×, narančasta 1.5-3×, crvena ≥ 3×
        const pct = Math.min(maxR / 3.0 * 100, 100);
        const col = maxR >= 3.0 ? '#dc2626' : maxR >= 1.5 ? '#d97706' : '#059669';
        statusEl.textContent = 'Max vol: ' + maxR + '× avg';
        statusEl.style.color = col;
        barEl.style.width    = pct + '%';
        barEl.style.background = col;
        subEl.textContent = 'BTC 15m zadnjih 90min · Sweep prag: 3× vol + 50% wick';
        subEl.style.color = '#9ca3af';

        // Mini prikaz zadnjih 6 svjećica
        if (d.btcVol.recent && liqRowEl) {
          liqRowEl.innerHTML = d.btcVol.recent.map((c, i) => {
            const cv = c.volRat >= 3.0 ? '#dc2626' : c.volRat >= 1.5 ? '#d97706' : '#6b7280';
            const sweep = c.volRat >= 3.0 && c.wickPct >= 50 ? ' ⚠️' : '';
            const label = i === 5 ? 'Sad' : '-' + (5-i) + 'c';
            return '<span style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:1px">'
              + '<span style="color:' + cv + ';font-weight:700;font-size:11px">' + c.volRat + '×' + sweep + '</span>'
              + '<span style="color:#4b5563;font-size:9px">' + label + '</span>'
              + '</span>';
          }).join('<span style="color:#374151;padding:0 2px">│</span>');
        }
      } else {
        statusEl.textContent = 'N/A';
        statusEl.style.color = '#6b7280';
        barEl.style.width = '0%';
        subEl.textContent = 'Bitget nedostupan';
      }
    }
    // MSS per-simbol
    const mssRow = document.getElementById('mss-row');
    if (mssRow && d.mss) {
      const SYM_SHORT = { BTCUSDT:'BTC' };
      mssRow.innerHTML = Object.entries(d.mss).map(([sym, v]) => {
        const label = SYM_SHORT[sym] || sym;
        const bg  = v ===  1 ? '#0d3d26' : v === -1 ? '#3d0d0d' : '#111827';
        const col = v ===  1 ? '#059669' : v === -1 ? '#dc2626' : '#4b5563';
        const bdr = v ===  1 ? '1px solid #00c48c44' : v === -1 ? '1px solid #ff4d4d44' : '1px solid #374151';
        const icon = v === 1 ? '▲ HH+HL' : v === -1 ? '▼ LH+LL' : '· NEUT';
        return '<span title="' + label + ' MSS: ' + icon + '" style="display:inline-flex;flex-direction:column;align-items:center;background:' + bg + ';border:' + bdr + ';border-radius:6px;padding:4px 10px;gap:2px">'
          + '<span style="font-size:11px;font-weight:700;color:#9ca3af">' + label + '</span>'
          + '<span style="font-size:11px;font-weight:800;color:' + col + '">' + icon + '</span>'
          + '</span>';
      }).join('');
    }
  } catch(e) {
    const el = document.getElementById('sweep-sub');
    if (el) el.textContent = 'Greška: ' + e.message;
  }
}
loadSweepStatus();
setInterval(loadSweepStatus, 60 * 1000);  // osvježi svaku minutu

// ── Liquidity Sweep Risk ──────────────────────────────────────────────────────
async function loadLiqRisk() {
  const bodyEl = document.getElementById('liq-risk-body');
  const tsEl   = document.getElementById('liq-risk-ts');
  const cardEl = document.getElementById('liq-risk-card');
  if (!bodyEl) return;
  try {
    const r = await fetch('/api/sweepRisk');
    const d = await r.json();
    if (tsEl) tsEl.textContent = new Date(d.ts).toLocaleTimeString('hr-HR', {hour:'2-digit',minute:'2-digit'});

    let anyDanger = false, anyCaution = false;
    let html = '';

    for (const sym of d.results || []) {
      if (sym.error) continue;
      const name = sym.sym.replace('USDT','');
      const price = sym.price;

      // Bojanje po riziku pozicija
      let symRisk = 'CLEAR';
      if (sym.myPositions?.some(p => p.risk === 'DANGER'))   { symRisk = 'DANGER';  anyDanger  = true; }
      else if (sym.myPositions?.some(p => p.risk === 'CAUTION')) { symRisk = 'CAUTION'; anyCaution = true; }

      const riskColor  = symRisk === 'DANGER' ? '#dc2626' : symRisk === 'CAUTION' ? '#d97706' : '#059669';
      const riskIcon   = symRisk === 'DANGER' ? '🔴' : symRisk === 'CAUTION' ? '🟡' : '🟢';
      const borderCol  = symRisk === 'DANGER' ? '#dc2626' : symRisk === 'CAUTION' ? '#d97706' : '#374151';

      html += '<div style="background:#111827;border:1px solid ' + borderCol + ';border-radius:8px;padding:12px;margin-bottom:10px">';
      html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
      html += '<span style="font-weight:700;font-size:13px;color:#f3f4f6">' + riskIcon + ' ' + name + '</span>';
      html += '<span style="font-size:11px;color:#9ca3af">Cijena: <b style="color:#f3f4f6">' + price.toLocaleString() + '</b></span>';
      html += '</div>';

      // Moje otvorene pozicije
      if (sym.myPositions?.length) {
        for (const pos of sym.myPositions) {
          const pRiskCol = pos.risk === 'DANGER' ? '#dc2626' : pos.risk === 'CAUTION' ? '#d97706' : '#059669';
          const slPct = (pos.slDistPct >= 0 ? '+' : '') + pos.slDistPct + '%';
          const tpPct = (pos.tpDistPct >= 0 ? '+' : '') + pos.tpDistPct + '%';
          html += '<div style="background:#1f2937;border-radius:6px;padding:8px 10px;margin-bottom:6px;border-left:3px solid ' + pRiskCol + '">';
          html += '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px">';
          html += '<span style="color:' + (pos.side==='LONG'?'#059669':'#dc2626') + ';font-weight:700">' + pos.side + '</span>';
          html += '<span style="color:#9ca3af">SL: <b style="color:#f3f4f6">' + (pos.sl||0).toLocaleString() + '</b> (' + slPct + ')</span>';
          html += '<span style="color:#9ca3af">TP: <b style="color:#f3f4f6">' + (pos.tp||0).toLocaleString() + '</b> (' + tpPct + ')</span>';
          if (pos.nearestDangerZone) {
            html += '<span style="color:' + pRiskCol + ';font-weight:600">⚠ Najbliža zona: ' + pos.nearestDangerZone.price.toLocaleString() + ' (' + Math.abs(pos.nearestDangerZone.distPct) + '%)</span>';
          }
          html += '</div>';
          if (pos.slNearZone) {
            html += '<div style="margin-top:4px;font-size:11px;color:#f59e0b">⚡ OPASNO: tvoj SL (' + (pos.sl||0).toLocaleString() + ') je blizu likvidacijske zone ' + pos.slNearZone.src + ' @ ' + pos.slNearZone.price.toLocaleString() + ' — MM može pokupiti!</div>';
          }
          if (pos.zonesBetweenPriceAndSL?.length) {
            const zones = pos.zonesBetweenPriceAndSL.map(z => z.price.toLocaleString() + ' (' + z.src + ')').join(', ');
            html += '<div style="margin-top:4px;font-size:10px;color:#9ca3af">Zona između cijene i SL: ' + zones + '</div>';
          }
          html += '</div>';
        }
      } else {
        html += '<div style="font-size:11px;color:#4b5563;font-style:italic">Nema otvorene pozicije</div>';
      }

      // Zbirni prikaz zona gore/dole
      html += '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">';
      // Gore — SHORT SL clusteri
      const above = sym.zonesAbove?.slice(0,3) || [];
      if (above.length) {
        html += '<div style="flex:1;min-width:140px">';
        html += '<div style="font-size:9px;color:#6b7280;text-transform:uppercase;margin-bottom:3px">▲ Likvidnost GORE (SHORT SL)</div>';
        above.forEach(z => {
          const col = z.distPct < 1.5 ? '#f59e0b' : '#4b5563';
          html += '<div style="font-size:10px;color:' + col + '">' + z.price.toLocaleString() + ' <span style="color:#6b7280">+' + z.distPct + '% ' + z.src + '</span></div>';
        });
        html += '</div>';
      }
      // Dole — LONG SL clusteri
      const below = sym.zonesBelow?.slice(0,3) || [];
      if (below.length) {
        html += '<div style="flex:1;min-width:140px">';
        html += '<div style="font-size:9px;color:#6b7280;text-transform:uppercase;margin-bottom:3px">▼ Likvidnost DOLE (LONG SL)</div>';
        below.forEach(z => {
          const col = Math.abs(z.distPct) < 1.5 ? '#f59e0b' : '#4b5563';
          html += '<div style="font-size:10px;color:' + col + '">' + z.price.toLocaleString() + ' <span style="color:#6b7280">' + z.distPct + '% ' + z.src + '</span></div>';
        });
        html += '</div>';
      }
      html += '</div>';  // flex gore/dole

      // PDH/PDL
      if (sym.pdh || sym.pdl) {
        html += '<div style="margin-top:6px;font-size:10px;color:#6b7280">PDH: <span style="color:#9ca3af">' + (sym.pdh||'–').toLocaleString() + '</span> &nbsp;|&nbsp; PDL: <span style="color:#9ca3af">' + (sym.pdl||'–').toLocaleString() + '</span></div>';
      }

      html += '</div>';  // card za simbol
    }

    bodyEl.innerHTML = html || '<div style="color:#6b7280">Nema podataka</div>';

    // Boja ruba kartice
    if (cardEl) {
      if (anyDanger)   { cardEl.style.borderColor = '#dc2626'; cardEl.style.boxShadow = '0 0 12px rgba(220,38,38,.25)'; }
      else if (anyCaution) { cardEl.style.borderColor = '#d97706'; cardEl.style.boxShadow = 'none'; }
      else             { cardEl.style.borderColor = '#374151'; cardEl.style.boxShadow = 'none'; }
    }
  } catch(e) {
    if (bodyEl) bodyEl.textContent = 'Greška: ' + e.message;
  }
}
loadLiqRisk();
setInterval(loadLiqRisk, 5 * 60 * 1000);  // osvježi svakih 5 min
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

  // Reset dinamički ADX — briše SL cooldown i blacklist
  if (url.pathname === "/api/reset-dyn") {
    try {
      const slFile = `${DATA_DIR}/sl_cooldown.json`;
      const blFile = `${DATA_DIR}/symbol_blacklist.json`;
      if (existsSync(slFile)) writeFileSync(slFile, "{}");
      if (existsSync(blFile)) writeFileSync(blFile, "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, msg: "SL cooldown i blacklist resetirani" }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // BTC Regime — bez auth, za debug
  if (url.pathname === "/api/regime") {
    try {
      const rUrl = "https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=60";
      const rD   = await fetch(rUrl).then(r => r.json());
      let regime = "UNKNOWN";
      if (rD.code === "00000" && rD.data?.length >= 20) {
        const closes = rD.data.map(k => parseFloat(k[4]));
        const price  = closes[closes.length - 1];
        let e55 = closes.slice(0, Math.min(55, closes.length)).reduce((a,b)=>a+b,0) / Math.min(55, closes.length);
        const m = 2/56;
        for (let i = 55; i < closes.length; i++) e55 = closes[i]*m + e55*(1-m);
        const e9  = closes.slice(-9).reduce((a,b)=>a+b,0)/9;
        const e21 = closes.slice(-21).reduce((a,b)=>a+b,0)/21;
        let up = 0;
        if (e9 > e21) up++;
        if (price > e9) up++;
        if (price > e21) up++;
        if (price > e55) up++;
        regime = up >= 3 ? "BULL" : up <= 1 ? "BEAR" : "NEUTRAL";
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ regime, raw: rD.code }));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ regime: "ERROR", error: e.message }));
    }
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

  // Bitget Win Rate iz zatvorenih pozicija (zadnjih 100)
  if (url.pathname === "/api/bitget-wr") {
    try {
      const BITGET_KEY    = (process.env.BITGET_API_KEY    || "").trim();
      const BITGET_SECRET = (process.env.BITGET_SECRET_KEY || "").trim();
      const BITGET_PASS   = (process.env.BITGET_PASSPHRASE || "").trim();
      const BITGET_BASE   = (process.env.BITGET_BASE_URL   || "https://api.bitget.com").trim();
      const path = "/api/v2/mix/order/history?productType=USDT-FUTURES&limit=100";
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
      const orders = d?.data?.entrustedList || d?.data?.orderList || d?.data || [];
      const filled = Array.isArray(orders) ? orders.filter(o => o.state === "filled" || o.status === "filled") : [];
      const wins   = filled.filter(o => parseFloat(o.pnl || o.realizedPl || 0) > 0).length;
      const losses = filled.filter(o => parseFloat(o.pnl || o.realizedPl || 0) < 0).length;
      const total  = wins + losses;
      const wr     = total > 0 ? wins / total * 100 : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: d.code === "00000", wins, losses, total, wr }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message, wins:0, losses:0, total:0, wr:0 }));
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

  // Ručno ukloni jednu poziciju iz trackinga — POST /api/remove-position
  // Body: { pid, symbol }  — samo briše iz JSON, ne šalje nalog na Bitget
  if (url.pathname === "/api/remove-position" && req.method === "POST") {
    try {
      const body = await new Promise(r => { let d=""; req.on("data",c=>d+=c); req.on("end",()=>r(d)); });
      const { pid, symbol } = JSON.parse(body);
      if (!pid || !symbol) throw new Error("pid i symbol su obavezni");
      const f = `${DATA_DIR}/open_positions_${pid}.json`;
      const positions = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
      const before = positions.length;
      const filtered = positions.filter(p => p.symbol !== symbol);
      writeFileSync(f, JSON.stringify(filtered, null, 2));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, removed: before - filtered.length, remaining: filtered.length }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Ručno zatvori jednu poziciju — POST /api/close-position
  // Body: { pid, symbol }  — šalje market close nalog na Bitget + uklanja iz trackinga
  if (url.pathname === "/api/close-position" && req.method === "POST") {
    try {
      const body = await new Promise(r => { let d=""; req.on("data",c=>d+=c); req.on("end",()=>r(d)); });
      const { pid, symbol } = JSON.parse(body);
      if (!pid || !symbol) throw new Error("pid i symbol su obavezni");
      const { closeBitGetOrder, loadPositions, savePositions, writeExitCsv, fetchBitgetOpenPositions } = await import("./bot.js");
      const positions = loadPositions(pid);
      const pos = positions.find(p => p.symbol === symbol);
      if (!pos) throw new Error(`Pozicija ${symbol} nije pronađena u trackingu`);

      // Dohvati live cijenu
      let exitPrice = pos.entryPrice;
      try {
        const tj = await fetch(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`).then(r => r.json());
        exitPrice = parseFloat(tj?.data?.[0]?.lastPr || tj?.data?.[0]?.close || pos.entryPrice);
      } catch {}

      const qty = pos.quantity ?? (pos.totalUSD / pos.entryPrice);
      const pnl = pos.side === "LONG"
        ? (exitPrice - pos.entryPrice) * qty
        : (pos.entryPrice - exitPrice) * qty;

      // Pokušaj zatvoriti na Bitgetu
      let bitgetNote = "Ručno zatvoreno (dashboard)";
      try {
        await closeBitGetOrder(pos);
      } catch (bitgetErr) {
        const msg = bitgetErr.message || "";
        const msgL = msg.toLowerCase();
        const looksLikeNoPos = msgL.includes("no position") || msgL.includes("position does not exist")
          || msgL.includes("order not exist") || msg.includes("43025") || msg.includes("43012")
          || msg.includes("45110") || msg.includes("40788");

        if (looksLikeNoPos) {
          // Provjeri je li pozicija stvarno zatvorena na Bitgetu
          const holdSide = pos.side === "LONG" ? "long" : "short";
          const openSet  = await fetchBitgetOpenPositions().catch(() => null);
          const stillOpen = openSet && openSet.has(`${symbol}:${holdSide}`);
          if (stillOpen) {
            // Pozicija JOŠ POSTOJI na Bitgetu — close je zaista pao
            throw new Error(`Close nije uspio (${msg}). Pozicija još otvorena na Bitgetu — zatvori ručno!`);
          }
          // Pozicija više ne postoji na Bitgetu → već zatvorena (SL/TP)
          bitgetNote = "Zatvoreno na Bitgetu (SL/TP) — cleanup trackinga";
          console.log(`  ℹ️  [CLOSE] ${symbol} — Bitget: "${msg}" → potvrđeno zatvoreno, cleanup`);
        } else {
          throw bitgetErr;  // pravi API error — propagiraj
        }
      }

      // Uvijek ukloni iz trackinga i zabilježi u CSV
      const remaining = loadPositions(pid).filter(p => !(p.symbol === pos.symbol && p.side === pos.side));
      savePositions(pid, remaining);
      writeExitCsv(pid, pos, exitPrice, bitgetNote, pnl);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, symbol, side: pos.side, exitPrice, pnl: pnl.toFixed(4), note: bitgetNote }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
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

  // Auto-fix P&L iz Bitget fill historije — POST /api/admin/fix-pnl
  // Pronalazi sve trades gdje exit = SL (bug), dohvaća stvarni P&L s Bitgeta i ispravlja CSV
  if (url.pathname === "/api/admin/fix-pnl" && req.method === "POST") {
    let body = "";
    req.on("data", d => { body += d; });
    req.on("end", () => {
      const { pid = "synapse_t" } = JSON.parse(body || "{}");
      console.log(`🔧 [admin/fix-pnl] Pokretanje auto-fixa za pid=${pid} (background)...`);
      // Odmah vrati 202 — fix radi u backgroundu (može trajati nekoliko minuta)
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ started: true, pid, msg: "Auto-fix pokrenut u backgroundu. Provjeri logove ili /api/csv za rezultate." }));
      // Pokreni async u backgroundu bez čekanja
      autoFixCsvFromBitget(pid)
        .then(r => console.log(`✅ [admin/fix-pnl] Završeno: ${r.fixed} ispravljeno od ${r.checked} provjerenih`))
        .catch(e => console.error(`❌ [admin/fix-pnl] Greška: ${e.message}`));
    });
    return;
  }

  // Fix CSV — DELETE loš red (POST /api/fix-csv)
  // Body: { pid, symbol, date, action: "delete"|"fix", pnl?, exitPrice? }
  if (url.pathname === "/api/fix-csv" && req.method === "POST") {
    let body = "";
    req.on("data", d => { body += d; });
    req.on("end", () => {
      try {
        const { pid = "synapse_t", symbol, date, action = "delete", pnl, exitPrice, orderId, time } = JSON.parse(body || "{}");
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
          const rowDate    = cols[0] || "";
          const rowTime    = cols[1] || "";
          const rowSymbol  = cols[3] || "";
          const rowSide    = cols[4] || "";
          const rowOrderId = cols[12] || "";
          const isClosed  = rowSide === "CLOSE_LONG" || rowSide === "CLOSE_SHORT";
          // Provjeri je li ovo krivi red — podržava orderId i time filter
          const match = isClosed
            && (!symbol  || rowSymbol  === symbol)
            && (!date    || rowDate    === date)
            && (!orderId || rowOrderId === orderId)
            && (!time    || rowTime.startsWith(time));
          if (!match) { newLines.push(l); continue; }
          affected++;
          if (action === "delete") {
            console.log(`🗑️  fix-csv: obrisano — ${rowDate} ${rowSymbol} ${rowSide}`);
            // ne dodajem u newLines = brisanje
          } else if (action === "fix") {
            // Ispravi Net P&L (col 9), Price (col 6), i Notes (zadnji col)
            if (pnl       !== undefined) cols[9] = String(pnl);
            if (exitPrice !== undefined) cols[6] = String(exitPrice);
            // Automatski ispravi WIN/LOSS u Notes koloni na temelju novog P&L
            const notesIdx = cols.length - 1;
            if (cols[notesIdx]) {
              const newPnl = parseFloat(cols[9]);
              cols[notesIdx] = cols[notesIdx]
                .replace(/^"?LOSS:/, newPnl >= 0 ? '"WIN:' : '"LOSS:')
                .replace(/^"?WIN:/,  newPnl >= 0 ? '"WIN:' : '"LOSS:');
              // Ispravi i exitPrice u tekstu bilješke ako piše "Izlaz X.XX"
              if (exitPrice !== undefined) {
                cols[notesIdx] = cols[notesIdx].replace(/Izlaz [0-9.]+/, `Izlaz ${exitPrice}`);
              }
            }
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

  // Market context — agregira sve market intelligence podatke
  if (url.pathname === "/api/market-context") {
    try {
      const pid = "synapse_t";
      const rules = JSON.parse(readFileSync("rules.json","utf8"));
      const symbols = rules.watchlist_synapse_t || [];

      const [fg, dom, dxy, fr, dailyPnl, consecLosses, symStats, sp500, corr, pc, liq, econRaw, ls, stableInflow, perpBasis, altSeason] = await Promise.all([
        getFearGreed(),
        getBtcDominance(),
        getDxyData(),
        getAllFundingRates(symbols.slice(0, 8)),
        Promise.resolve(getDailyPnlExport(pid)),
        Promise.resolve(getConsecutiveLossCount(pid)),
        Promise.resolve(getSymbolStats()),
        getSp500Data(),
        calcSymbolCorrelation(symbols.slice(0, 12)),
        getDeribitPutCall(),
        getLiquidationRisk(symbols),
        getEconEvents(),
        getLongShortRatio("BTCUSDT"),
        getStablecoinInflow(),
        getBtcPerpBasis(),
        getAltcoinSeason(),
      ]);

      // BTC Regime — direktni fetch (4H candles)
      let regime = "UNKNOWN";
      try {
        const rUrl = "https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=4H&limit=60";
        const rD   = await fetch(rUrl).then(r => r.json());
        if (rD.code === "00000" && rD.data?.length >= 56) {
          const closes = rD.data.map(k => parseFloat(k[4]));
          const highs  = rD.data.map(k => parseFloat(k[2]));
          const lows   = rD.data.map(k => parseFloat(k[3]));
          // EMA55
          let e55 = closes.slice(0, 55).reduce((a,b) => a+b,0) / 55;
          const m = 2/56;
          for (let i = 55; i < closes.length; i++) e55 = closes[i]*m + e55*(1-m);
          const price = closes[closes.length-1];
          // 6-Scale: 6 parova EMA
          const pairs = [[9,21],[21,55],[55,200]].filter(([f,s]) => closes.length > s);
          let upPairs = 0;
          for (const [fast,slow] of [[9,21],[21,55]]) {
            const eFast = closes.slice(-fast).reduce((a,b)=>a+b,0)/fast;
            const eSlow = closes.slice(-slow).reduce((a,b)=>a+b,0)/slow;
            if (eFast > eSlow) upPairs++;
            if (price > eFast) upPairs++;
            if (price > eSlow) upPairs++;
          }
          regime = (upPairs >= 4 && price > e55) ? "BULL" : (upPairs <= 2 && price < e55) ? "BEAR" : "NEUTRAL";
        }
      } catch(e) { /* ostaje UNKNOWN */ }
      const econ = { events: econRaw, status: isEconBlocked(econRaw) };

      // Session info — sinhrono, ne zahtijeva fetch
      const session = getSessionInfo();

      // ATR trend — dohvati BTC 1H svjećice kao proxy za tržišnu volatilnost
      let atrTrend = { trend: 'N/A', ratio: 1, sizeMult: 1 };
      try {
        const btcUrl = `https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=100`;
        const btcD   = await fetch(btcUrl).then(r => r.json());
        if (btcD.code === "00000" && btcD.data?.length) {
          const btcCandles = btcD.data.map(k => ({
            time: parseInt(k[0]), open: parseFloat(k[1]),
            high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
          }));
          atrTrend = calcAtrTrend(btcCandles);
        }
      } catch { /* ignoriraj */ }

      // Dinamički daily limit: 3% od Bitget equityja (min $20)
      let dailyLimit = 20;
      try {
        const balR = await fetch(`http://localhost:${PORT}/api/bitget-balance`).then(r => r.json());
        const eq   = parseFloat(balR?.balance?.equity || 0);
        if (eq > 0) dailyLimit = Math.max(eq * 0.03, 20);
      } catch { /* fallback na $20 */ }

      // ── Trade Readiness Score (0–100%) ─────────────────────────────────────
      // Svaki uvjet donosi bodove; agregat = readiness
      const fgNum   = typeof fg === "number" ? fg : 50;
      const dxyNum  = dxy?.change4h ?? 0;
      const liqNum  = liq?.score ?? 0;
      const cbCount = consecLosses ?? 0;
      const gates = [
        { name: "BTC Regime",   ok: regime === "BULL" || regime === "NEUTRAL", weight: 20 },
        { name: "F&G",          ok: fgNum > 20 && fgNum < 80,                  weight: 15 },
        { name: "DXY",          ok: dxyNum <= 0.3,                             weight: 10 },
        { name: "Liq Risk",     ok: liqNum <= 75,                              weight: 15 },
        { name: "Circuit Bkr",  ok: cbCount < 7,                               weight: 15 },
        { name: "SP500",        ok: (sp500?.change4h ?? 0) > -1,               weight: 10 },
        { name: "Sesija",       ok: session?.active !== false,                 weight: 10 },
        { name: "Econ Event",   ok: !econ?.status?.blocked,                   weight: 5  },
      ];
      const readinessScore = gates.reduce((sum, g) => sum + (g.ok ? g.weight : 0), 0);
      const readiness = { score: readinessScore, gates };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fg, dom, dxy, fr, dailyPnl, consecLosses, symStats, dailyLimit, cbLosses: 7, session, atrTrend, sp500, corr, pc, liq, econ, regime, ls, stableInflow, perpBasis, altSeason, readiness }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // CSV import — POST /api/import-csv  (body: { pid, rows: [{...}] } ili raw CSV string)
  // Dodaje redove u postojeći CSV, preskače duplikate po Order ID
  if (url.pathname === "/api/import-csv" && req.method === "POST") {
    let body = "";
    req.on("data", d => { body += d; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const pid = payload.pid || "synapse_t";
        const f = `${DATA_DIR}/trades_${pid}.csv`;
        const CSV_HEADERS = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net P&L,SL,TP,Order ID,Mode,Portfolio,Notes";
        if (!existsSync(f)) writeFileSync(f, CSV_HEADERS + "\n");

        const existing = readFileSync(f, "utf8");
        const existingIds = new Set(
          existing.split("\n").slice(1)
            .map(l => { const c = l.split(","); return c[12]?.trim(); })
            .filter(Boolean)
        );

        const newRows = (payload.rows || []);
        let added = 0;
        const toAppend = [];
        for (const r of newRows) {
          const orderId = r["Order ID"] || r.orderId || "";
          if (existingIds.has(orderId)) continue; // duplikat, preskoči
          const cols = [
            r["Date"]||"", r["Time (UTC)"]||"", r["Exchange"]||"BitGet",
            r["Symbol"]||"", r["Side"]||"", r["Quantity"]||"", r["Price"]||"",
            r["Total USD"]||"", r["Fee (est.)"]||"", r["Net P&L"]||"",
            r["SL"]||"", r["TP"]||"", orderId, r["Mode"]||"LIVE",
            r["Portfolio"]||pid, '"' + (r["Notes"]||"").replace(/"/g,"") + '"'
          ];
          toAppend.push(cols.join(","));
          added++;
        }
        if (toAppend.length > 0) {
          const append = (existing.endsWith("\n") ? "" : "\n") + toAppend.join("\n") + "\n";
          writeFileSync(f, existing + append);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, added, skipped: newRows.length - added }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // CSV replace — POST /api/replace-csv  (body: { pid, csv: "header\nrow1\nrow2..." })
  // Potpuno zamjenjuje CSV fajl s novim sadržajem. NE dira open_positions JSON.
  if (url.pathname === "/api/replace-csv" && req.method === "POST") {
    let body = "";
    req.on("data", d => { body += d; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const pid = payload.pid || "synapse_t";
        const csvContent = payload.csv || "";
        if (!csvContent) throw new Error("csv field je obavezan");
        const f = `${DATA_DIR}/trades_${pid}.csv`;
        writeFileSync(f, csvContent);
        // Count rows
        const lines = csvContent.trim().split("\n");
        const dataLines = lines.slice(1).filter(l => l.trim());
        const closed = dataLines.filter(l => l.includes("CLOSE_")).length;
        const opened = dataLines.filter(l => !l.includes("CLOSE_")).length;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, total: dataLines.length, openRows: opened, closeRows: closed, file: f }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Daily report — GET /api/report?date=YYYY-MM-DD (ili latest)
  if (url.pathname === "/api/report") {
    const date = url.searchParams.get("date") || "latest";
    const reportDir = `${DATA_DIR}/daily_reports`;
    const f = date === "latest"
      ? `${reportDir}/latest.md`
      : `${reportDir}/${date}.md`;
    if (!existsSync(f)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Report not found", path: f, hint: "Report se generira u 07:00 UTC" }));
      return;
    }
    const md = readFileSync(f, "utf8");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(md);
    return;
  }

  // Scan log — GET /api/scan-log?hours=24
  if (url.pathname === "/api/scan-log") {
    const hours = parseInt(url.searchParams.get("hours") || "24");
    const f = `${DATA_DIR}/scan_log.csv`;
    if (!existsSync(f)) { res.writeHead(404); res.end("Scan log not found"); return; }
    const cutoffTs = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
    const lines = readFileSync(f, "utf8").split("\n");
    const header = lines[0];
    const filtered = lines.slice(1).filter(l => l && l >= cutoffTs);
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    res.end(header + "\n" + filtered.join("\n"));
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

  // Sweep status — GET /api/sweep
  // Čita sweep_pause_synapse_t.json koji bot piše kada detektira BTC sweep candle
  if (url.pathname === "/api/sweep") {
    const pid = "synapse_t";
    const sweepFile = `${DATA_DIR}/sweep_pause_${pid}.json`;
    const sweepState = existsSync(sweepFile) ? JSON.parse(readFileSync(sweepFile, "utf8")) : {};
    const paused   = !!(sweepState.until && Date.now() < sweepState.until);
    const remainMs = paused ? sweepState.until - Date.now() : 0;

    // Dohvati BTC 15m klines za live vol ratio prikaz (bez eksternog API-ja)
    let btcVol = null;
    try {
      const kResp = await fetch(
        "https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=15m&limit=26",
        { signal: AbortSignal.timeout(5000) }
      );
      if (kResp.ok) {
        const kJson = await kResp.json();
        const klines = kJson?.data ?? [];
        if (klines.length >= 22) {
          const vols  = klines.map(c => parseFloat(c[5]));
          const avg20 = vols.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
          // Zadnjih 6 svjećica = ~90min
          const recent = klines.slice(-6).map(c => {
            const [, o, h, l, cl, v] = c.map(Number);
            const range   = h - l || 1;
            const body    = Math.abs(cl - o);
            const wick    = range - body;
            return {
              volRat:  +(v / avg20).toFixed(2),
              wickPct: +((wick / range) * 100).toFixed(0),
              dir:     cl < o ? "bearish" : "bullish",
            };
          });
          const maxVolRat = Math.max(...recent.map(r => r.volRat));
          const sweepCandle = recent.find(r => r.volRat >= 3.0 && r.wickPct >= 50);
          btcVol = { avg20: +avg20.toFixed(2), recent, maxVolRat: +maxVolRat.toFixed(2), sweepCandle: sweepCandle || null };
        }
      }
    } catch (_) { /* Bitget timeout — ok */ }

    // MSS per-simbol — swing high/low struktura iz 1H klines
    const MSS_SYMBOLS = ["BTCUSDT"];
    const mssResults = {};
    await Promise.all(MSS_SYMBOLS.map(async sym => {
      try {
        const mResp = await fetch(
          `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1H&limit=80`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (!mResp.ok) return;
        const mJson = await mResp.json();
        const klines = mJson?.data ?? [];
        if (klines.length < 20) return;
        const candles = klines.map(c => ({ high: +c[2], low: +c[3], close: +c[4] }));
        const n = candles.length;
        const MS_LOOKBACK = 60, MS_WING = 3;
        const msStart = Math.max(MS_WING, n - MS_LOOKBACK);
        const msEnd   = n - MS_WING - 1;
        const msHighs = [], msLows = [];
        for (let i = msStart; i <= msEnd; i++) {
          let isH = true, isL = true;
          for (let j = i - MS_WING; j <= i + MS_WING; j++) {
            if (j === i) continue;
            if (candles[j].high >= candles[i].high) isH = false;
            if (candles[j].low  <= candles[i].low)  isL = false;
          }
          if (isH) msHighs.push(candles[i].high);
          if (isL) msLows.push(candles[i].low);
        }
        let mss = 0;
        if (msHighs.length >= 2 && msLows.length >= 2) {
          const lastH = msHighs[msHighs.length-1], prevH = msHighs[msHighs.length-2];
          const lastL = msLows[msLows.length-1],   prevL = msLows[msLows.length-2];
          if (lastH > prevH && lastL > prevL) mss =  1;
          if (lastH < prevH && lastL < prevL) mss = -1;
        }
        mssResults[sym] = mss;
      } catch (_) {}
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ paused, remainMs, sweepState, btcVol, mss: mssResults }));
    return;
  }

  // Sweep Risk — GET /api/sweepRisk
  // Za svaki simbol: swing pivoti iz 4H, round numbers, PDH/PDL
  // Uspoređuje s otvorenim pozicijama bota → flag DANGER/CAUTION/CLEAR
  if (url.pathname === "/api/sweepRisk") {
    const WATCH = ["BTCUSDT"];
    const PIVOT_WING = 5;  // koliko bara lijevo/desno za pivot
    const ZONE_BUFFER = 0.004;  // ±0.4% — zona oko pivota = likvidacijski magnet

    // Dohvati otvorene pozicije bota
    let openPos = [];
    try {
      const posFile = `${DATA_DIR}/open_positions_synapse_t.json`;
      if (existsSync(posFile)) openPos = JSON.parse(readFileSync(posFile, "utf8"));
    } catch(_) {}

    const symResults = await Promise.all(WATCH.map(async sym => {
      try {
        // 4H candles — 120 bara = 20 dana
        const r4 = await fetch(
          `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=4H&limit=120`,
          { signal: AbortSignal.timeout(7000) }
        );
        if (!r4.ok) return { sym, error: "HTTP " + r4.status };
        const j4 = await r4.json();
        const c4 = (j4?.data ?? []).map(c => ({ t:+c[0], o:+c[1], h:+c[2], l:+c[3], cl:+c[4] }));
        if (c4.length < PIVOT_WING * 2 + 2) return { sym, error: "premalo bara" };

        const price = c4[c4.length - 1].cl;
        // Swing pivoti
        const pivotH = [], pivotL = [];
        for (let i = PIVOT_WING; i < c4.length - PIVOT_WING; i++) {
          let isH = true, isL = true;
          for (let j = i - PIVOT_WING; j <= i + PIVOT_WING; j++) {
            if (j === i) continue;
            if (c4[j].h >= c4[i].h) isH = false;
            if (c4[j].l <= c4[i].l) isL = false;
          }
          if (isH) pivotH.push({ price: c4[i].h, t: c4[i].t });
          if (isL) pivotL.push({ price: c4[i].l, t: c4[i].t });
        }

        // PDH/PDL (prethodni dan — zadnji zatvoreni 1D)
        let pdh = null, pdl = null;
        try {
          const r1d = await fetch(
            `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1D&limit=3`,
            { signal: AbortSignal.timeout(5000) }
          );
          const j1d = await r1d.json();
          const d1 = (j1d?.data ?? []);
          if (d1.length >= 2) { pdh = +d1[1][2]; pdl = +d1[1][3]; }
        } catch(_) {}

        // Round numbers — ovisno o cijeni
        const magnitude = Math.pow(10, Math.floor(Math.log10(price)) - 1);
        const roundLevels = [];
        for (let k = -8; k <= 8; k++) {
          const rl = Math.round(price / magnitude + k) * magnitude;
          if (Math.abs(rl - price) / price < 0.08) roundLevels.push(rl);
        }

        // Sve zone — above i below price
        const zonesAbove = [], zonesBelow = [];
        const addZone = (p, type, src) => {
          if (!p || p <= 0) return;
          const distPct = (p - price) / price * 100;
          const zone = { price: +p.toFixed(4), distPct: +distPct.toFixed(2), type, src };
          if (distPct > 0.1) zonesAbove.push(zone);
          else if (distPct < -0.1) zonesBelow.push(zone);
        };

        // SHORT SL clusteri — iznad swing highova (iznad cijene)
        pivotH.filter(p => p.price > price).forEach(p => addZone(p.price, "SHORT_SL", "SwingH"));
        // LONG SL clusteri — ispod swing lowova
        pivotL.filter(p => p.price < price).forEach(p => addZone(p.price, "LONG_SL", "SwingL"));
        // PDH/PDL
        if (pdh && pdh > price) addZone(pdh, "SHORT_SL", "PDH");
        if (pdl && pdl < price) addZone(pdl, "LONG_SL", "PDL");
        // Round numbers
        roundLevels.filter(r => r > price * 1.001).forEach(r => addZone(r, "ROUND", "Round"));
        roundLevels.filter(r => r < price * 0.999).forEach(r => addZone(r, "ROUND", "Round"));

        // Sortiraj po udaljenosti (najbliže prvo)
        zonesAbove.sort((a, b) => a.distPct - b.distPct);
        zonesBelow.sort((a, b) => b.distPct - a.distPct);

        // Provjeri otvorene pozicije za ovaj simbol
        const myPositions = openPos.filter(p => (p.symbol || "").replace("/", "") === sym);
        const posRisk = myPositions.map(pos => {
          const side = pos.side;
          const sl = pos.sl;
          const tp = pos.tp;
          const entry = pos.entryPrice;
          const slDistPct = side === "LONG"
            ? (sl - price) / price * 100
            : (price - sl) / price * 100;
          const tpDistPct = side === "LONG"
            ? (tp - price) / price * 100
            : (price - tp) / price * 100;

          // Je li SL blizu neke zone (±ZONE_BUFFER)?
          const allZones = [...zonesAbove, ...zonesBelow];
          const slNearZone = allZones.find(z =>
            Math.abs(z.price - sl) / sl <= ZONE_BUFFER
          );
          // Je li između trenutne cijene i SL-a neka opasna zona?
          const zonesBetweenPriceAndSL = allZones.filter(z => {
            if (side === "LONG") return z.price < price && z.price > sl;
            return z.price > price && z.price < sl;
          });
          // Je li cijena već "u putu" prema likvidacijskoj zoni?
          const nearestDangerZone = side === "LONG"
            ? zonesBelow[0]  // ispod za LONG — tamo idu po SL
            : zonesAbove[0]; // iznad za SHORT

          const distToNearest = nearestDangerZone ? Math.abs(nearestDangerZone.distPct) : 99;
          const risk = distToNearest < 0.8 ? "DANGER"
                     : distToNearest < 2.0 ? "CAUTION"
                     : "CLEAR";

          return {
            side, entry, sl, tp, slDistPct: +slDistPct.toFixed(2), tpDistPct: +tpDistPct.toFixed(2),
            slNearZone: slNearZone || null, zonesBetweenPriceAndSL,
            nearestDangerZone, distToNearest: +distToNearest.toFixed(2), risk,
          };
        });

        return {
          sym, price, pdh, pdl,
          zonesAbove: zonesAbove.slice(0, 5),
          zonesBelow: zonesBelow.slice(0, 5),
          myPositions: posRisk,
        };
      } catch(e) { return { sym, error: e.message }; }
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: symResults, ts: new Date().toISOString() }));
    return;
  }

  // Liq Zones — GET /api/liqzones (svi simboli paralelno)
  if (url.pathname === "/api/liqzones") {
    const SYMBOLS  = ["BTCUSDT"];
    const PIVOT_LEN = 8, N_PIVOTS = 4, RANGE_PCT = 12.0, LEVS = [10,20,25,50,100];

    function calcSymLiq(klines) {
      if (!klines || klines.length < PIVOT_LEN * 2 + 5) return null;
      const cp = klines[klines.length - 1].c;
      const phArr = [], plArr = [];
      for (let i = PIVOT_LEN; i < klines.length - PIVOT_LEN; i++) {
        const hi = klines[i].h, lo = klines[i].l;
        let isPH = true, isPL = true;
        for (let j = i - PIVOT_LEN; j <= i + PIVOT_LEN; j++) {
          if (j === i) continue;
          if (klines[j].h >= hi) isPH = false;
          if (klines[j].l <= lo) isPL = false;
        }
        if (isPH && phArr.length < N_PIVOTS) phArr.push(hi);
        if (isPL && plArr.length < N_PIVOTS) plArr.push(lo);
      }
      const zones = [];
      phArr.forEach((entry, rank) => LEVS.forEach(lev => {
        const liqP = entry * (1 - 1/lev), dist = Math.abs(liqP - cp) / cp * 100;
        if (dist <= RANGE_PCT) zones.push({ type:"LONG", price:+liqP.toFixed(2), lev, rank, dist:+dist.toFixed(2) });
      }));
      plArr.forEach((entry, rank) => LEVS.forEach(lev => {
        const liqP = entry * (1 + 1/lev), dist = Math.abs(liqP - cp) / cp * 100;
        if (dist <= RANGE_PCT) zones.push({ type:"SHORT", price:+liqP.toFixed(2), lev, rank, dist:+dist.toFixed(2) });
      }));
      zones.sort((a,b) => a.dist - b.dist);
      const cL = zones.find(z => z.type === "LONG");
      const cS = zones.find(z => z.type === "SHORT");
      const minDist = Math.min(cL?.dist ?? 99, cS?.dist ?? 99);
      return { price: cp, minDist: +minDist.toFixed(2), danger: minDist < 1.0 ? "DANGER" : minDist < 2.5 ? "CAUTION" : "CLEAR", closestLong: cL, closestShort: cS };
    }

    const results = await Promise.all(SYMBOLS.map(async sym => {
      try {
        const r = await fetch(
          `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1H&limit=150`,
          { signal: AbortSignal.timeout(7000) }
        );
        if (!r.ok) return { symbol: sym, error: "HTTP " + r.status };
        const j = await r.json();
        const klines = (j?.data ?? []).map(c => ({ h:+c[2], l:+c[3], c:+c[4] }));
        const liq = calcSymLiq(klines);
        return liq ? { symbol: sym, ...liq } : { symbol: sym, danger: "CLEAR", minDist: 99 };
      } catch(e) { return { symbol: sym, error: e.message, danger: "CLEAR", minDist: 99 }; }
    }));

    const grouped = {
      DANGER:  results.filter(r => r.danger === "DANGER").sort((a,b) => a.minDist - b.minDist),
      CAUTION: results.filter(r => r.danger === "CAUTION").sort((a,b) => a.minDist - b.minDist),
      CLEAR:   results.filter(r => r.danger === "CLEAR").sort((a,b) => a.minDist - b.minDist),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results, grouped, ts: new Date().toISOString() }));
    return;
  }

  // BTC Status — GET /api/btc-status
  if (url.pathname === "/api/btc-status") {
    try {
      const result = {};

      // Day Range: fetch daily candle for BTC
      try {
        const dr = await fetch("https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1Dutc&limit=2").then(r=>r.json());
        if (dr.code === "00000" && dr.data?.length) {
          const c = dr.data[dr.data.length - 1]; // Bitget ascending — zadnji = današnja svijeća
          const high = parseFloat(c[2]), low = parseFloat(c[3]), close = parseFloat(c[4]);
          const pct = (close - low) / (high - low) * 100;
          result.dayRange = { high, low, close, pct: isNaN(pct) ? null : Math.round(pct * 10) / 10 };
        }
      } catch {}

      // Last BTC scan from scan_log.csv
      try {
        const f = `${DATA_DIR}/scan_log.csv`;
        if (existsSync(f)) {
          const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
          // Find last BTC entry (most recent is last)
          for (let i = lines.length - 1; i >= 1; i--) {
            const cols = lines[i].split(",");
            if (cols[1]?.trim() === "BTCUSDT") {
              const score = parseInt(cols[3]) || 0;
              const signal = cols[2]?.trim() || null;
              const ts = cols[0]?.trim() || null;
              result.lastScore = { score, signal: signal === "NEUTRAL" ? null : signal, flipReady: score >= 5, ts };
              break;
            }
          }
        }
      } catch {}

      // BTC Regime: price vs EMA50 from 4H candles
      try {
        const r4 = await fetch("https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=4H&limit=60").then(r=>r.json());
        if (r4.code === "00000" && r4.data?.length >= 55) {
          const closes = r4.data.map(c => parseFloat(c[4]));  // ascending
          const k = 2 / 51;
          let ema = closes[0];
          for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
          const price = closes[closes.length - 1];
          result.regime = price > ema * 1.002 ? "BULL" : price < ema * 0.998 ? "BEAR" : "NEUTRAL";
        }
      } catch {}

      // Pyramid: count BTC positions in open_positions file
      try {
        const pos = loadPositions("synapse_t");
        const btcPos = pos.filter(p => p.symbol === "BTCUSDT");
        result.pyramid = btcPos.length;
      } catch {}

      // L/S Ratio (Binance global account ratio)
      try {
        result.lsr = await getLongShortRatio("BTCUSDT");
      } catch {}

      // Liquidity Hunt zones — Bitget vraća ascending (najstarija prva)
      try {
        const [wdR, ddR, mdR] = await Promise.all([
          fetch("https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1W&limit=3").then(r=>r.json()),
          fetch("https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1Dutc&limit=90").then(r=>r.json()),
          fetch("https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1Mutc&limit=13").then(r=>r.json())
        ]);
        const lhz = {};
        if (wdR.code === "00000" && wdR.data?.length >= 2) {
          const wLast = wdR.data.length - 1;
          lhz.weeklyOpen = parseFloat(wdR.data[wLast][1]);      // tekući tjedan
          lhz.pwh        = parseFloat(wdR.data[wLast - 1][2]);  // prethodni tjedan
          lhz.pwl        = parseFloat(wdR.data[wLast - 1][3]);
        }
        if (ddR.code === "00000" && ddR.data?.length >= 2) {
          const dC = ddR.data.map(k => ({
            ts: parseInt(k[0]), open: parseFloat(k[1]),
            high: parseFloat(k[2]), low: parseFloat(k[3])
          }));
          const now = new Date();
          const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
          const monthC = dC.filter(c => c.ts >= monthStart);
          if (monthC.length > 0) {
            lhz.monthlyOpen = monthC[0].open;
            lhz.monthlyHigh = Math.max(...monthC.map(c => c.high));
            lhz.monthlyLow  = Math.min(...monthC.map(c => c.low));
          }
        }
        if (mdR.code === "00000" && mdR.data?.length >= 1) {
          const yearStart = Date.UTC(new Date().getUTCFullYear(), 0, 1);
          const janCandle = mdR.data.find(k => parseInt(k[0]) >= yearStart);
          if (janCandle) lhz.yearlyOpen = parseFloat(janCandle[1]);
        }
        if (Object.keys(lhz).length > 0) result.lhz = lhz;
      } catch {}

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
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

  // Reset signal stats — POST /api/reset-signal-stats
  if (url.pathname === "/api/reset-signal-stats" && req.method === "POST") {
    const f = `${DATA_DIR}/signal_stats.json`;
    try {
      writeFileSync(f, JSON.stringify({}));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, msg: "signal_stats.json resetiran" }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Signal stats — GET /api/signal-stats
  if (url.pathname === "/api/signal-stats") {
    const f = `${DATA_DIR}/signal_stats.json`;
    if (!existsSync(f)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "signal_stats.json not found", DATA_DIR }));
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(raw));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
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

server.listen(PORT, async () => {
  console.log(`Dashboard pokrenut na portu ${PORT}`);

  // ─── Pokreni bot scan loop ─────────────────────────────────────────────────
  async function scheduledRun() {
    try { await botRun(); }
    catch (e) { console.error("Bot scheduler greška:", e.message, "\n", e.stack); }
  }
  // Prvo skeniranje odmah (s malim odmakom da se server stabilizira)
  setTimeout(scheduledRun, 5000);
  // Ponavljaj svakih 5 minuta
  setInterval(scheduledRun, 5 * 60 * 1000);

  // Startup reconciliation — provjeri postoje li otvorene pozicije koje treba pratiti
  setTimeout(async () => { await softExitMonitor(); }, 3000);

  // ─── Soft Exit Monitor — svake 5 sekundi ──────────────────────────────────
  setInterval(async () => {
    try { await softExitMonitor(); }
    catch (e) { console.error("Soft exit monitor greška:", e.message); }
  }, 5 * 1000);

  // ─── BE-STOP fast monitor — svake 30 sekundi ──────────────────────────────
  setInterval(async () => {
    try { await checkBeStopAll(); }
    catch (e) { console.error("BE-STOP monitor greška:", e.message); }
  }, 30 * 1000);

  // Fast breakout checker — svake minute provjerava live cijenu vs. trigger
  setInterval(async () => {
    try { await checkBreakouts(); }
    catch (e) { console.error("Breakout checker greška:", e.message); }
  }, 60 * 1000);
});
