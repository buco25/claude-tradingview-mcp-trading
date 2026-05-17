/**
 * Trading Bot Dashboard — 3-Portfolio Mode
 * EMA+RSI | 3-Layer | MEGA — svaki portfolio $1000 start
 */

import "dotenv/config";
import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { run as botRun, checkBreakouts, syncPositionsFromBitget, check5mSRTest, checkBeStopAll,
  getAllFundingRates, getDailyPnlExport, getSymbolStats, getOIForSymbols,
  getFearGreed, getBtcDominance, getDxyData, getConsecutiveLossCount,
  getSessionInfo, calcAtrTrend, getSp500Data, calcSymbolCorrelation,
  getDeribitPutCall, getLiquidationRisk, getEconEvents, isEconBlocked, calcVWAP,
  getLongShortRatio, getStablecoinInflow, getBtcPerpBasis, getAltcoinSeason } from "./bot.js";

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

  // ── ULTRA — 13 signala (identično bot.js analyzeUltra) ──
  // OBAVEZNI GATING: ADX≥30, 6Sc≥4, RSI asimetričan (5mSR informativan, ne blokira)
  // Maknuti iz signala: CRS (WR 14%), ADXsn (obavezan), 6Sc (obavezan), EMA smjer (nije obavezan)
  let ultraSig = "—";
  let ultraBull = 0, ultraBear = 0;
  let ultraSigs16 = new Array(13).fill(0);
  let ultraMinSig = 5;  // default, ažurira se ispod
  {
    const { minSig = 5 } = ultraCfg;
    ultraMinSig = minSig;
    if (n >= 200 && ema9 && ema21) {
      const rsiV  = rsi ?? 50;
      const adxV  = adx ?? 0;
      const chopV = chop ?? 100;

      // REVERSANI signali (WR<31.5% kada ▲ → logika invertirana, contrarian/pullback):
      // E50, RSI zona, E55, CVD, VOL, MCC
      ultraSigs16 = [
        ema50 ? (price > ema50 ? -1 : 1) : 0,                           //  1. E50  REV: >EMA50=previsoko=-1, ispod=pullback=+1
        rsiV < 45 ? -1 : rsiV > 55 ? 1 : 0,                             //  2. RSI  REV: >55=momentum=+1, <45=slabi=-1
        ema55 ? (price > ema55 ? -1 : 1) : 0,                           //  3. E55  REV: >EMA55=previsoko=-1, ispod=pullback=+1
        chopV < 61.8 ? 1 : -1,                                           //  4. CHP: nije choppy=+1 (normalan)
        cvdSum > 0 ? -1 : 1,                                             //  5. CVD  REV: kupni vol=već uđeni=-1, prodajni=+1
        rsiRecovBull ? 1 : rsiRecovBear ? -1 : 0,                        //  6. R⟳: RSI recovery (normalan)
        macdH !== null ? (macdH > 0 ? 1 : -1) : 0,                      //  7. MCD: MACD histogram (normalan)
        ema145 ? (price > ema145 ? 1 : -1) : 0,                         //  8. E145: dugoročni trend (normalan)
        vols[n-1] > volAvg20 ? -1 : 0,                                   //  9. VOL  REV: visoki vol=kasni ulaz=-1, low=0
        macdCrossV > 0 ? -1 : macdCrossV < 0 ? 1 : 0,                   // 10. MCC  REV: cross gore=kasno=-1, cross dolje=dno=+1
        rsiRising ? 1 : rsiFalling ? -1 : 0,                             // 11. RSI↗: RSI smjer (normalan)
        srsBounce,                                                        // 12. SRS: S/R bounce (normalan)
        srbBreak,                                                         // 13. SRB: S/R breakout (normalan)
      ];

      ultraBull = ultraSigs16.filter(s => s === 1).length;
      ultraBear = ultraSigs16.filter(s => s === -1).length;

      // 3 obavezna gating uvjeta: ADX≥30, 6Sc≥4, RSI asimetričan (5mSR informativan)
      const adxOk       = adxV >= 30;
      const scaleOkLong  = scaleUp >= 4;
      const scaleOkShort = scaleDn >= 4;
      const rsiLongOk   = rsiV < 72;
      const rsiShortOk  = rsiV > 30;

      // Pullback signali (reversed logika)
      if      (adxOk && scaleOkLong  && rsiLongOk  && ultraBull >= minSig) ultraSig = "LONG";
      else if (adxOk && scaleOkShort && rsiShortOk && ultraBear >= minSig) ultraSig = "SHORT";
      else if (adxOk && scaleOkLong  && rsiLongOk  && ultraBull === minSig - 1) ultraSig = "SETUP↑";
      else if (adxOk && scaleOkShort && rsiShortOk && ultraBear === minSig - 1) ultraSig = "SETUP↓";

      // Momentum signali (non-reversed, hibrid fallback) — viši prag 10/13
      if (ultraSig === "—") {
        var momSigsD = [
          ema50  ? (price > ema50  ?  1 : -1) : 0,       //  1. E50  MOM: >EMA50=+1
          rsiV > 55 ? 1 : rsiV < 45 ? -1 : 0,            //  2. RSI  MOM: >55=+1
          ema55  ? (price > ema55  ?  1 : -1) : 0,       //  3. E55  MOM: >EMA55=+1
          chopV < 61.8 ? 1 : -1,                          //  4. CHP: isti
          cvdSum > 0 ?  1 : -1,                           //  5. CVD  MOM: kupni vol=+1
          ultraSigs16[5],                                  //  6. R⟳: isti
          macdH !== null ? (macdH > 0 ? 1 : -1) : 0,    //  7. MCD: isti
          ema145 ? (price > ema145 ?  1 : -1) : 0,       //  8. E145: isti
          vols[n-1] > volAvg20 ?  1 : 0,                 //  9. VOL  MOM: visoki vol=+1
          macdCrossV > 0 ? 1 : macdCrossV < 0 ? -1 : 0, // 10. MCC  MOM: cross gore=+1
          ultraSigs16[10],                                 // 11. RSI↗: isti
          ultraSigs16[11],                                 // 12. SRS: isti
          ultraSigs16[12],                                 // 13. SRB: isti
        ];
        var momBullD = momSigsD.filter(function(s){return s===1;}).length;
        var momBearD = momSigsD.filter(function(s){return s===-1;}).length;
        // Momentum: bez 6SC gate, ADX >= 20, prag 9/13
        var momAdxOk = adxV >= 20;
        if (momAdxOk && rsiLongOk  && momBullD >= 9) { ultraSig = "MOM↑"; ultraBull = momBullD; }
        else if (momAdxOk && rsiShortOk && momBearD >= 9) { ultraSig = "MOM↓"; ultraBear = momBearD; }
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
        const s       = scanSymbol(candles, {}, {}, {}, ultraCfg);
        const pending = pendingList.find(p => p.symbol === sym) || null;
        const symSltp = rules.symbol_sltp?.[sym] || {};
        const slPct   = symSltp.slPct ?? 1.5;
        const tpPct   = symSltp.tpPct ?? 2.5;

        // Volume anomaly check (isti algoritam kao bot.js)
        let volRatio = 1, volLow = false;
        if (candles.length >= 22) {
          const vols = candles.slice(-22, -2).map(c => c.volume);
          const avg  = vols.reduce((a, b) => a + b, 0) / vols.length;
          volRatio   = avg > 0 ? candles[candles.length - 2].volume / avg : 1;
          volLow     = volRatio < 0.3;
        }

        // 5m S/R test — samo za simbole koji imaju aktivan LONG/SHORT signal
        let srOk = null;  // null = nije primjenjivo / nije provjeravano
        const activeSig = s.ultraSig === "LONG" || s.ultraSig === "SHORT"
                       || (s.ultraSig || "").startsWith("SETUP");
        if (activeSig) {
          const side = s.ultraSig === "SHORT" || s.ultraSig === "SETUP↓" ? "SHORT" : "LONG";
          srOk = await check5mSRTest(sym, side).catch(() => null);
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
        results.push({ symbol: sym, ...s, pending, slPct, tpPct, srOk, trend1h, vwap: vwap ? parseFloat(vwap.toFixed(6)) : null, vwapDistPct, volRatio: parseFloat(volRatio.toFixed(2)), volLow });
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

  // ── WR by entry mode (PBK / MOM — parsira iz Notes) ─────────────────────────
  const modeStats = { PBK: { wins: 0, losses: 0 }, MOM: { wins: 0, losses: 0 }, UNK: { wins: 0, losses: 0 } };
  for (const r of exits) {
    const notes = r["Notes"] || "";
    const m = notes.includes("| MOM |") ? "MOM" : notes.includes("| PBK |") ? "PBK" : "UNK";
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

    const posHtml = positions.map(p => {
      const isLong = p.side === "LONG";
      return `
        <div class="pos-card ${isLong ? "pos-long" : "pos-short"}" id="pos-${def.id}-${p.symbol}">
          <div class="pos-header">
            <span class="symbol">${p.symbol}</span>
            <span class="badge ${isLong ? "badge-long" : "badge-short"}">${p.side}</span>
            ${p.entryMode === "MOM"
              ? '<span style="background:rgba(251,146,60,0.15);border:1px solid #f97316;border-radius:20px;padding:2px 8px;font-size:10px;color:#f97316;font-weight:700">⚡ MOM</span>'
              : '<span style="background:rgba(96,165,250,0.15);border:1px solid #60a5fa;border-radius:20px;padding:2px 8px;font-size:10px;color:#60a5fa;font-weight:700">↩ PBK</span>'}
            <span class="badge badge-paper">${p.mode}</span>
            <span id="lp-${def.id}-${p.symbol}" style="margin-left:auto;font-size:13px;font-weight:700;color:var(--text-muted)">—</span>
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
            <div id="pnl-${def.id}-${p.symbol}" style="font-size:14px;font-weight:700;color:#9ca3af">—</div>
            <div style="flex:1;min-width:0">
              <div class="range-bar"><div id="bar-${def.id}-${p.symbol}" class="range-fill"></div></div>
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
              el.style.color=pnl>=0?"#059669":"#dc2626";
              const range=Math.abs(tp-sl);
              const pos2=side==="LONG"?(price-sl)/range:(sl-price)/range;
              const pct2=Math.max(0,Math.min(100,pos2*100));
              const bar=document.getElementById("bar-"+pid+"-"+sym);
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
<title>🎯 ULTRA Trading Bot</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  :root {
    --bg-primary:   #111827;
    --bg-secondary: #1f2937;
    --bg-tertiary:  #2d3748;
    --bg-card:      #1f2937;
    --border:       #374151;
    --border-light: #4b5563;
    --text-primary: #f9fafb;
    --text-muted:   #9ca3af;
    --text-dim:     #6b7280;
    --green:        #10b981;
    --green-dim:    rgba(16,185,129,0.12);
    --red:          #ef4444;
    --red-dim:      rgba(239,68,68,0.12);
    --blue:         #60a5fa;
    --blue-dim:     rgba(96,165,250,0.12);
    --purple:       #a78bfa;
    --yellow:       #fbbf24;
    --shadow-sm:    0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3);
    --shadow-md:    0 4px 6px rgba(0,0,0,0.4), 0 2px 4px rgba(0,0,0,0.3);
    --radius-sm:    8px;
    --radius-md:    12px;
    --radius-lg:    16px;
  }
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg-primary); color:var(--text-primary); min-height:100vh; line-height:1.5; }
  a { color:var(--blue); text-decoration:none; }
  .top-bar { height:3px; background:linear-gradient(90deg,#3b82f6,#8b5cf6,#10b981); }
  .page-wrap { max-width:1440px; margin:0 auto; padding:28px 24px 80px; }
  .header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:32px; }
  .header-left { display:flex; align-items:center; gap:14px; }
  .logo { font-size:24px; filter:drop-shadow(0 0 10px rgba(16,185,129,0.5)); }
  .title { font-size:20px; font-weight:700; letter-spacing:-.02em; }
  .subtitle { font-size:12px; color:var(--text-muted); margin-top:3px; letter-spacing:.01em; }
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
  .stat-card { background:var(--bg-card); border-radius:var(--radius-md); padding:16px 18px; border:1px solid var(--border); box-shadow:var(--shadow-sm); transition:transform .15s,box-shadow .15s; }
  .stat-card:hover { transform:translateY(-1px); box-shadow:var(--shadow-md); }
  .stat-label { font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; font-weight:600; }
  .stat-value { font-size:24px; font-weight:800; letter-spacing:-.03em; }
  .stat-sub   { font-size:11px; color:var(--text-muted); margin-top:3px; }

  /* Chart */
  .chart-card { background:var(--bg-card); border-radius:var(--radius-md); padding:22px; border:1px solid var(--border); box-shadow:var(--shadow-sm); margin-bottom:28px; }
  .chart-title { font-size:13px; font-weight:700; margin-bottom:16px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.06em; }
  .chart-wrap { position:relative; height:220px; }

  /* Positions */
  .section-label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.09em; margin:32px 0 14px; padding-bottom:10px; border-bottom:2px solid var(--border); color:var(--text-muted); }
  .pos-grid-wrap { display:grid; grid-template-columns:repeat(auto-fill,minmax(370px,1fr)); gap:16px; margin-bottom:8px; }
  .pos-card { background:var(--bg-card); border-radius:var(--radius-md); padding:18px; border:1px solid var(--border); box-shadow:var(--shadow-sm); transition:box-shadow .2s; }
  .pos-card:hover { box-shadow:var(--shadow-md); }
  .pos-long  { border-left:4px solid var(--green); }
  .pos-short { border-left:4px solid var(--red); }
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
  .trade-table td { padding:10px 14px; border-bottom:1px solid var(--border); }
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
      <div class="logo">🎯</div>
      <div>
        <div class="title">ULTRA Trading Bot</div>
        <div class="subtitle">Pullback: ADX≥30·6Sc·RSI·SR min 6/13 (1H) · Momentum: ADX≥20·RSI min 9/13 (15m) · LONG+SHORT · BTC regime · 50x · rizik 1.5%</div>
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
      <div class="stat-label">Start kapital</div>
      <div class="stat-value" style="color:#9ca3af">$${def.startCapital.toFixed(2)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Net P&amp;L</div>
      <div class="stat-value" style="color:${pnlCol}">${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl.toFixed(2)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Win Rate</div>
      <div class="stat-value" style="color:${s.winRate !== null && parseFloat(s.winRate) >= 50 ? "#059669" : "#dc2626"}">${s.winRate !== null ? s.winRate + "%" : "—"}</div>
      <div class="stat-sub">${s.wins.length}W / ${s.losses.length}L</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Zatvoreni tradovi</div>
      <div class="stat-value">${s.exits.length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Otvoreno</div>
      <div class="stat-value" style="color:#d97706">${positions.length}</div>
      <div class="stat-sub">pozicija</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Strategija</div>
      <div class="stat-value" style="font-size:14px;color:#db2777">ULTRA · 50/75x</div>
      <div class="stat-sub">SL 1.5–2.5% / TP 2.5–3.5% · per-simbol · rizik 1%</div>
    </div>
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

    // Učitaj recent WR (zadnjih 10 trejdova) za dinamički ADX
    const csvPath = `${DATA_DIR}/trades_synapse_t.csv`;
    let dynAdxVal = 30, recentWr = null, recentN = 0;
    if (existsSync(csvPath)) {
      try {
        const lines = readFileSync(csvPath,"utf8").trim().split("\n");
        const exits = lines.slice(1)
          .filter(l => l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT"))
          .slice(-10);
        if (exits.length >= 5) {
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

      <!-- Dinamički ADX -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">📊 Dinamički ADX</div>
        <div style="font-size:22px;font-weight:800;color:${adxCol}">${dynAdxVal}</div>
        <div style="font-size:11px;color:${adxCol};margin-top:2px">${adxLbl}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">
          ${recentWr !== null ? `Zadnjih ${recentN}: WR <b style="color:${wrCol}">${recentWr}%</b>` : "Premalo podataka"}
        </div>
      </div>

      <!-- Market Regime -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px" id="regime-card">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">🌍 BTC 4H Regime</div>
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
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">📊 BTC Regime (4H)</div>
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

      <!-- BTC Dominance -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">₿ BTC Dominance</div>
        <div style="font-size:22px;font-weight:800;color:#d97706" id="dom-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px" id="dom-sub">Raste = altovi slabe</div>
      </div>

      <!-- DXY -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">💵 DXY (4H promjena)</div>
        <div style="font-size:22px;font-weight:800" id="dxy-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px" id="dxy-sub">&gt;+0.3% = LONG risk</div>
      </div>

      <!-- Session Filter -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">🕐 Trading Sesija</div>
        <div style="font-size:16px;font-weight:800" id="session-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="session-sub">01-06 UTC = dead zone blokiran</div>
      </div>

      <!-- ATR Trend -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">📊 ATR Volatilnost (BTC 1H)</div>
        <div style="font-size:16px;font-weight:800" id="atr-trend-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="atr-trend-sub">EXPANDING = size ×0.7</div>
      </div>

      <!-- SP500 -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">📉 S&P500 (4H)</div>
        <div style="font-size:18px;font-weight:800" id="sp500-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="sp500-sub">&lt;-1% = RISK OFF → blokira LONG</div>
      </div>

      <!-- Korelacijska matrica -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px;grid-column:span 2">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="font-size:10px;color:#9ca3af;text-transform:uppercase">🔗 Korelacijska matrica (1H)</div>
          <button onclick="document.getElementById('corr-heatmap').style.display=document.getElementById('corr-heatmap').style.display==='none'?'block':'none'" style="background:none;border:1px solid #cbd5e1;color:#9ca3af;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer">toggle</button>
        </div>
        <div style="font-size:18px;font-weight:800" id="corr-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="corr-sub">&gt;0.85 = visok zajednički rizik</div>
        <div id="corr-heatmap" style="display:none;margin-top:10px;overflow-x:auto"></div>
      </div>

      <!-- Deribit Put/Call -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">🎯 Put/Call Ratio (Deribit)</div>
        <div style="font-size:16px;font-weight:800" id="pc-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="pc-sub">&gt;1.5=Fear · &lt;0.5=Greed</div>
      </div>

      <!-- Long/Short Ratio -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">⚖️ Long/Short Ratio (BTC)</div>
        <div style="font-size:18px;font-weight:800" id="ls-val">…</div>
        <div style="background:#374151;border-radius:4px;height:6px;margin:6px 0;overflow:hidden">
          <div id="ls-bar" style="height:100%;border-radius:4px;background:#3b82f6;transition:width .5s;width:50%"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af" id="ls-sub">&gt;70% long = contrarian SHORT signal</div>
      </div>

      <!-- Market Breadth -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">🌊 Market Breadth</div>
        <div style="font-size:22px;font-weight:800" id="breadth-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="breadth-sub">simbola s ADX≥30 u trendu</div>
      </div>

      <!-- Liquidation Risk + OI trend -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">💥 Liquidation Risk + OI</div>
        <div style="font-size:16px;font-weight:800" id="liq-val">…</div>
        <div style="background:#374151;border-radius:4px;height:6px;margin:6px 0;overflow:hidden">
          <div id="liq-bar" style="height:100%;border-radius:4px;background:#00c48c;transition:width .5s,background .5s;width:0%"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af" id="liq-sub">Funding + OI analiza</div>
        <div style="font-size:11px;margin-top:6px" id="oi-trend-val"></div>
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

      <!-- Stablecoin Inflow -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">💵 Stablecoin Inflow (7d)</div>
        <div style="font-size:20px;font-weight:800" id="stable-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="stable-sub">DefiLlama · USDT+USDC supply</div>
        <div style="font-size:11px;margin-top:4px" id="stable-change"></div>
      </div>

      <!-- BTC Perp Basis -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">📐 BTC Perp Basis</div>
        <div style="font-size:20px;font-weight:800" id="basis-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="basis-sub">Futures premium vs Spot</div>
        <div style="font-size:11px;margin-top:4px" id="basis-detail"></div>
      </div>

      <!-- Altcoin Season Index -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">🌊 Altcoin Season Index</div>
        <div style="font-size:20px;font-weight:800" id="altseason-val">…</div>
        <div style="background:#374151;border-radius:4px;height:6px;margin:6px 0;overflow:hidden">
          <div id="altseason-bar" style="height:100%;border-radius:4px;background:#3b82f6;transition:width .5s;width:0%"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af" id="altseason-sub">BTC dominance · CoinGecko global</div>
      </div>

      <!-- Countdown do sljedećeg eventa -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">⏱️ Sljedeći Econ Event</div>
        <div style="font-size:20px;font-weight:800;font-variant-numeric:tabular-nums" id="countdown-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="countdown-event">učitavam…</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px" id="countdown-time"></div>
      </div>

      <!-- Ekonomski kalendar -->
      <div style="background:#2d3748;border:1px solid #374151;border-radius:8px;padding:12px;grid-column:span 2">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase">📅 Ekonomski kalendar (HIGH impact USD)</div>
        <div style="font-size:16px;font-weight:800" id="econ-val">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px" id="econ-sub">FOMC · CPI · NFP · ±15min blokada</div>
        <div id="econ-list" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px"></div>
      </div>
    </div>

    <!-- Per-Symbol WR Table -->
    <div style="margin-top:16px">
      <div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-bottom:8px">📊 Per-Simbol Win Rate</div>
      <div id="sym-wr-table" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px"></div>
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
        <div class="chart-title" style="margin-bottom:2px">🎯 ULTRA Scanner — ${ALL_SYMBOLS.length} simbola | 4ob + 13sig | min ${rules.strategies?.synapse_t?.params?.minSig ?? 6}/13 | ulaz odmah</div>
        <div style="font-size:12px;color:var(--text-muted)">
          E50 · RSI · E55 · CHP · CVD · R⟳ · MCD · E145 · VOL · MCC · RSI↗ · SRS · SRB
          &nbsp;|&nbsp; 🟡 Čeka breakout &nbsp; 🟢 Signal &nbsp; Cache 90s &nbsp;|&nbsp;
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
            <th style="color:#d97706;text-align:center">4OB <span style="font-weight:400;font-size:10px;color:#94a3b8">ADX·6Sc·RSI·SR</span></th>
            <th style="color:#db2777;text-align:center">13 Signala</th>
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
      <div class="chart-title" style="margin-bottom:12px">📖 Opis signala — ULTRA (4 obavezna gating + 13 neovisnih signala, min 5/13 za ulaz)</div>
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
          '<div style="background:#2d3748;border:1px solid #374151;border-radius:6px;padding:8px 10px">' +
          '<span style="font-weight:800;color:#db2777;font-size:11px;display:inline-block;min-width:36px">' + k + '</span>' +
          '<span style="color:#9ca3af">' + v + '</span></div>'
        ).join('')}
      </div>
      <div style="margin-top:10px;font-size:11px;color:#94a3b8">
        🟢 Zeleno = bullish signal aktiviran &nbsp;|&nbsp; 🔴 Crveno = bearish &nbsp;|&nbsp; ⬛ Sivo = neutral/nema signala &nbsp;|&nbsp;
        Min <b style="color:#db2777">5/13</b> neovisnih signala + 4 obavezna gating (ADX≥25·6Sc·RSI·5mSR) · SL <b style="color:#d97706">1.5–2.5%</b> / TP <b style="color:#d97706">2.5–3.5%</b> po simbolu · <b>50x</b> leverage · rizik <b>1%</b> banke po tradeu
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
  const sig16  = s.ultraSigs16 || new Array(13).fill(0);
  const sig    = s.ultraSig || "—";

  if (!s.ultraSigs16) return '<span style="color:#94a3b8;font-size:11px">—</span>';

  // 13 genuinnih signala — CRS, ADXsn, 6Sc maknuti (obavezni gates ili WR 14%)
  const names16 = ['E50','RSI zona','E55','Chop','CVD','RSI⟳','MACD hist','E145','Vol','MACD cross','RSI smjer','SRS','SRB'];
  const tooltipText = names16.map((l,i)=>l+':'+(sig16[i]===1?'↑':sig16[i]===-1?'↓':'·')).join(' | ');

  const dots = sig16.slice(0, 13).map((v, i) => {
    const col = v===1?'#059669':v===-1?'#dc2626':'#94a3b8';
    return '<span title="'+names16[i]+'" style="color:'+col+';font-size:9px">'+(v===1?'▲':v===-1?'▼':'·')+'</span>';
  }).join('');

  const scoreStr = bull > bear
    ? '<span style="color:#059669;font-weight:700">↑'+bull+'/13</span>'
    : bear > bull
    ? '<span style="color:#dc2626;font-weight:700">↓'+bear+'/13</span>'
    : '<span style="color:#9ca3af">'+Math.max(bull,bear)+'/13</span>';

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

// ── Signal label boxes (13 genuinnih signala) ──
// Maknuti: CRS (WR 14%), ADXsn (obavezan gate), 6Sc (obavezan gate), EMA smjer (nije obavezan)
const SIG_NAMES = ['E50','RSI','E55','CHP','CVD','R⟳','MCD','E145','VOL','MCC','RSI↗','SRS','SRB'];

// Uvjeti za tooltip — objasni zašto je signal zelen/crven
// 13 genuinnih signala — 6 REVERSANO (WR<31.5% kad ▲, logika invertirana)
// REV = contrarian/pullback: signal +1 kad je cijena NIŽE / momentum SLAB (potencijalni bounce)
const SIG_COND_BULL = [
  '[REV] Cijena < EMA50 — pullback u trendu, potencijalni bounce',      //  1. E50 REV
  '[REV] RSI > 55 — jak momentum, nastavljanje trenda',                 //  2. RSI REV
  '[REV] Cijena < EMA55 — pullback, dobra zona za ulaz',               //  3. E55 REV
  'Chop < 61.8 — tržište trenira, nije bočno',                         //  4. CHP
  '[REV] CVD prodajni — potencijalno dno, reversal gore',              //  5. CVD REV
  'RSI izašao iz oversold (<35) i raste — recovery potvrđen',          //  6. R⟳
  'MACD histogram > 0 — bullish momentum potvrđen',                    //  7. MCD
  'Cijena > EMA145 — dugoročni trend gore',                            //  8. E145
  '[REV] Volumen ispod prosjeka — nema gomilanja, nema kasnog ulaza',  //  9. VOL REV
  '[REV] MACD cross dolje — potencijalno dno, reversal gore',          // 10. MCC REV
  'RSI raste 2+ uzastopna bara — momentum gore',                       // 11. RSI↗
  'Bounce od S/R supporta + RSI raste — reakcija na podršku',          // 12. SRS
  'Proboj S/R resistance gore zadnja 3 bara',                          // 13. SRB
];
const SIG_COND_BEAR = [
  '[REV] Cijena > EMA50 — previsoko, iscrpljen move',                  //  1. E50 REV
  '[REV] RSI < 45 — slab momentum, potencijalni nastavak pada',        //  2. RSI REV
  '[REV] Cijena > EMA55 — previsoko, iscrpljen move',                  //  3. E55 REV
  'Chop > 61.8 — bočno tržište, nema trenda',                         //  4. CHP
  '[REV] CVD kupovni — svi već unutra, potencijalni vrh',              //  5. CVD REV
  'RSI izašao iz overbought (>65) i pada — pad potvrđen',             //  6. R⟳
  'MACD histogram < 0 — bearish momentum potvrđen',                   //  7. MCD
  'Cijena < EMA145 — dugoročni trend dolje',                           //  8. E145
  '[REV] Visoki volumen — kasni ulaz, svi već uđeni',                  //  9. VOL REV
  '[REV] MACD cross gore — kasni ulaz na vrhu',                        // 10. MCC REV
  'RSI pada 2+ uzastopna bara — momentum dolje',                       // 11. RSI↗
  'Bounce od S/R resistancea + RSI pada — reakcija na otpor',          // 12. SRS
  'Proboj S/R supporta dolje zadnja 3 bara',                           // 13. SRB
];
const SIG_COND_NEUT = [
  'EMA50 nedostupan',                                    //  1. E50
  'RSI 45–55 — neutralna zona (REV: ni jak ni slab)',   //  2. RSI
  'EMA55 nedostupan',                                    //  3. E55
  '—',                                                   //  4. CHP
  'CVD = 0 — nema dominacije',                          //  5. CVD
  'RSI nije u recovery zoni',                            //  6. R⟳
  'MACD nedostupan',                                     //  7. MCD
  'EMA145 nedostupan',                                   //  8. E145
  'Volumen ispod prosjeka — neutralan (REV: neutralan)', //  9. VOL
  'Nema MACD crossa u zadnja 3 bara',                   // 10. MCC
  'RSI ne raste ni pada konzistentno',                  // 11. RSI↗
  'Cijena nije blizu S/R razine',                       // 12. SRS
  'Nema S/R proboja u zadnja 3 bara',                   // 13. SRB
];

function mandatoryBoxes(s) {
  const rsiNum  = parseFloat(s.rsi) || 50;
  const adxNum  = parseFloat(s.adx) || 0;
  const sig     = s.ultraSig;
  const sigs13  = s.ultraSigs16 || [];

  // 1. ADX ≥ 30 dynamic — jak trend (obavezan). Dashboard prikazuje ≥30 (bot koristi 30/35/40 ovisno o WR)
  const adxOk  = adxNum >= 30;
  const adxCol = adxOk ? '#059669' : '#dc2626';
  const adxBg  = adxOk ? '#0d3d26' : '#3d0d0d';
  const adxTip = 'ADX ' + adxNum.toFixed(1) + (adxOk ? ' ≥ 30 ✓ — jak trend' : ' < 30 ✗ — slab trend, nema ulaza');

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
  const rsiLongOk  = rsiNum < 72;
  const rsiShortOk = rsiNum > 30;
  const rsiOk  = sig === "SHORT" || sig === "SETUP↓" ? rsiShortOk : rsiLongOk;
  const rsiCol = rsiOk ? '#059669' : '#dc2626';
  const rsiBg  = rsiOk ? '#0d3d26' : '#3d0d0d';
  const rsiTip = 'RSI ' + rsiNum.toFixed(1) + (sig === "SHORT" || sig === "SETUP↓"
    ? (rsiShortOk ? ' > 30 ✓ (nije oversold)' : ' ≤ 30 ✗ — oversold, blokiran SHORT')
    : (rsiLongOk  ? ' < 72 ✓ (nije overbought)' : ' ≥ 72 ✗ — overbought, blokiran LONG'));

  // 4. 5m S/R test — informativan, NE blokira ulaz
  const srOk  = s.srOk;
  const srCol = srOk === true ? '#059669' : srOk === false ? '#d97706' : '#94a3b8';
  const srBg  = srOk === true ? '#0d3d26' : srOk === false ? '#3d2a00' : '#1c2128';
  const srTip = srOk === true  ? '5m S/R test ✓ — cijena testirala S/R zonu (informativno, ne blokira)' :
                srOk === false ? '5m S/R test — nema S/R potvrde (informativno, ulaz i dalje moguć)' :
                                 '5m S/R test: provjerava se samo za LONG/SHORT signale (informativno)';
  const srLbl = srOk === true ? '5mSR✓' : srOk === false ? '5mSR·' : '5mSR';

  function badge(label, col, bg, tip) {
    return '<span title="' + tip + '" style="display:inline-flex;flex-direction:column;align-items:center;background:' + bg +
      ';color:' + col + ';border:1px solid ' + col + '44;padding:2px 5px;font-size:10px;font-weight:700;border-radius:3px;margin:1px;min-width:36px;text-align:center">' +
      label + '</span>';
  }

  return badge('ADX', adxCol, adxBg, adxTip) +
         badge('6Sc', scaleCol, scaleBg, scaleTip) +
         badge('RSI', rsiCol, rsiBg, rsiTip) +
         badge(srLbl, srCol, srBg, srTip);
}

function sigBoxes(sigs) {
  if (!sigs || sigs.length === 0) return '<span style="color:#444">—</span>';
  return sigs.map((v, i) => {
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
  const total = 13;
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

  // Nizak volumen — bot bi preskočio ovaj signal
  const volWarning = s.volLow
    ? '<div style="font-size:10px;color:#f59e0b;margin-top:3px">⚠️ VOL nizak ' + s.volRatio + 'x · bot preskoči</div>'
    : '';

  // Aktivan signal — bot ulazi odmah na close svjećice
  if (sig === "LONG") {
    return '<div style="background:rgba(5,150,105,0.1);border:1px solid ' + (s.volLow ? '#f59e0b' : '#059669') + ';border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#059669;font-weight:700;margin-bottom:4px">' + (s.volLow ? '⚠️ SIGNAL (vol nizak)' : '✅ SIGNAL AKTIVIRAN') + '</div>' +
      '<div style="font-size:13px;font-weight:700;color:#059669">▲ LONG</div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:3px">Ulaz odmah @ <b style="color:#f9fafb">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBull||0) + '/13</b></div>' +
      volWarning +
      '</div>';
  }
  if (sig === "SHORT") {
    return '<div style="background:rgba(220,38,38,0.1);border:1px solid ' + (s.volLow ? '#f59e0b' : '#dc2626') + ';border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#dc2626;font-weight:700;margin-bottom:4px">' + (s.volLow ? '⚠️ SIGNAL (vol nizak)' : '✅ SIGNAL AKTIVIRAN') + '</div>' +
      '<div style="font-size:13px;font-weight:700;color:#dc2626">▼ SHORT</div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:3px">Ulaz odmah @ <b style="color:#f9fafb">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBear||0) + '/13</b></div>' +
      volWarning +
      '</div>';
  }
  if (sig === "SETUP↑") return '<span style="color:#d97706;font-size:12px">◈ SETUP ↑ &nbsp;<span style="color:#94a3b8;font-size:11px">(' + (s.ultraBull||0) + '/13)</span></span>' + (s.volLow ? '<br><span style="color:#f59e0b;font-size:10px">⚠️ VOL ' + s.volRatio + 'x</span>' : '');
  if (sig === "SETUP↓") return '<span style="color:#d97706;font-size:12px">◈ SETUP ↓ &nbsp;<span style="color:#94a3b8;font-size:11px">(' + (s.ultraBear||0) + '/13)</span></span>' + (s.volLow ? '<br><span style="color:#f59e0b;font-size:10px">⚠️ VOL ' + s.volRatio + 'x</span>' : '');
  if (sig === "MOM↑") {
    return '<div style="background:rgba(59,130,246,0.1);border:1px solid #3b82f6;border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#3b82f6;font-weight:700;margin-bottom:4px">🚀 MOMENTUM LONG</div>' +
      '<div style="font-size:13px;font-weight:700;color:#3b82f6">▲ LONG</div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:3px">Breakout ulaz @ <b style="color:#f9fafb">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBull||0) + '/13</b></div>' +
      '</div>';
  }
  if (sig === "MOM↓") {
    return '<div style="background:rgba(139,92,246,0.1);border:1px solid #8b5cf6;border-radius:8px;padding:8px 10px">' +
      '<div style="font-size:11px;color:#8b5cf6;font-weight:700;margin-bottom:4px">🚀 MOMENTUM SHORT</div>' +
      '<div style="font-size:13px;font-weight:700;color:#8b5cf6">▼ SHORT</div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:3px">Breakdown ulaz @ <b style="color:#f9fafb">' + fmtLive(s.price) + '</b> · Score: <b>' + (s.ultraBear||0) + '/13</b></div>' +
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

      const rsiAdxInfo = '<div style="font-size:10px;color:#6b7280;margin-top:2px">RSI <span style="color:' + rsiCol + '">' + (s.rsi||'—') + '</span> · ADX <span style="color:' + adxCol + '">' + (s.adx||'—') + '</span></div>';
      return '<tr style="' + rowBg + '">' +
        '<td style="color:#94a3b8;font-size:11px;text-align:center;padding:6px 4px">' + (i+1) + '</td>' +
        '<td style="font-weight:800;font-size:13px;white-space:nowrap;padding:6px 8px">' + s.symbol.replace("USDT","") + '<span style="color:#94a3b8;font-size:10px;font-weight:400">USDT</span>' +
          '<div style="font-size:9px;color:' + slTpCol + ';font-weight:500;margin-top:1px">' + slTp + '</div>' + rsiAdxInfo + '</td>' +
        '<td style="font-weight:600;white-space:nowrap;font-size:12px;padding:6px 8px">' + fmtLive(s.price) + '</td>' +
        '<td style="text-align:center;font-weight:800;color:' + t1hCol + ';font-size:13px;padding:6px 4px" title="1H EMA20: ' + t1h + '">' + t1hIcon + '</td>' +
        '<td style="padding:4px 6px;border-right:1px solid #d9770633">' + mandatoryBoxes(s) + '</td>' +
        '<td style="padding:4px 4px">' + sigBoxes(s.ultraSigs16) + '</td>' +
        '<td style="padding:4px 6px;text-align:center">' + scoreBox(s.ultraBull||0, s.ultraBear||0, s.ultraSig, s.ultraMinSig) + '</td>' +
        '<td style="padding:4px 6px">' + statusBox(s) + '</td>' +
        '</tr>';
    }).join("");

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

    // ── Stablecoin Inflow ─────────────────────────────────────────────────
    if (d.stableInflow) {
      var si = d.stableInflow;
      var siDir  = si.direction;
      var siCol  = siDir === 'INFLOW' ? '#059669' : siDir === 'OUTFLOW' ? '#dc2626' : '#9ca3af';
      var siIcon = siDir === 'INFLOW' ? '📈 INFLOW' : siDir === 'OUTFLOW' ? '📉 OUTFLOW' : '➡️ NEUTRAL';
      var siChg  = (si.changePct > 0 ? '+' : '') + si.changePct + '% · ' + (si.changeAbs > 0 ? '+' : '') + si.changeAbs + 'B $';
      var siNote = siDir === 'INFLOW' ? '🟢 Bullish — novac ulazi' : siDir === 'OUTFLOW' ? '🔴 Bearish — novac izlazi' : '⚪ Stabilan supply';
      document.getElementById('stable-val').textContent = siIcon;
      document.getElementById('stable-val').style.color = siCol;
      document.getElementById('stable-sub').textContent = 'Ukupno: $' + si.totalB + 'B · 7d promjena';
      document.getElementById('stable-change').textContent = siChg + ' · ' + siNote;
      document.getElementById('stable-change').style.color = siCol;
    }

    // ── BTC Perp Basis ────────────────────────────────────────────────────
    if (d.perpBasis) {
      var pb = d.perpBasis;
      var pbVal = parseFloat(pb.basis);
      var pbCol = pbVal > 0.05 ? '#059669' : pbVal < -0.05 ? '#dc2626' : '#9ca3af';
      var pbIcon = pb.sentiment === 'CONTANGO' ? '📈 CONTANGO' : pb.sentiment === 'BACKWARDATION' ? '📉 BACKWARDATION' : '➡️ FLAT';
      var pbNote = pb.sentiment === 'CONTANGO' ? 'Bullish — tržište očekuje rast' : pb.sentiment === 'BACKWARDATION' ? 'Bearish — tržište očekuje pad' : 'Neutralno';
      document.getElementById('basis-val').textContent = (pbVal > 0 ? '+' : '') + pbVal.toFixed(4) + '%';
      document.getElementById('basis-val').style.color = pbCol;
      document.getElementById('basis-sub').textContent = pbIcon + ' · ' + pbNote;
      document.getElementById('basis-detail').textContent = 'Spot: $' + pb.spot + ' · Futures: $' + pb.futures;
      document.getElementById('basis-detail').style.color = '#6b7280';
    }

    // ── Altcoin Season Index ──────────────────────────────────────────────
    if (d.altSeason) {
      var as = d.altSeason;
      var asCol = as.score >= 75 ? '#f59e0b' : as.score >= 50 ? '#10b981' : as.score >= 25 ? '#3b82f6' : '#f97316';
      var asBar = document.getElementById('altseason-bar');
      document.getElementById('altseason-val').textContent = as.score + '/100 · ' + as.season;
      document.getElementById('altseason-val').style.color = asCol;
      if (asBar) { asBar.style.width = as.score + '%'; asBar.style.background = asCol; }
      document.getElementById('altseason-sub').textContent = 'BTC dominance: ' + as.btcDom + '% · score ' + as.score + '/100';
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

    // Korelacijska matrica
    if (d.corr && d.corr.avgCorr !== null) {
      const c = d.corr;
      const corrColor = c.avgCorr > 0.85 ? '#dc2626' : c.avgCorr > 0.65 ? '#d97706' : '#059669';
      const corrIcon  = c.avgCorr > 0.85 ? '⚠️' : c.avgCorr > 0.65 ? '🟡' : '🟢';
      document.getElementById('corr-val').textContent = corrIcon + ' avg ' + c.avgCorr;
      document.getElementById('corr-val').style.color = corrColor;
      document.getElementById('corr-sub').textContent =
        c.avgCorr > 0.85 ? '🚨 Visoka korelacija — sve pozicije kreću zajedno!' :
        c.avgCorr > 0.65 ? 'Srednja korelacija — pazi na koncentraciju' :
        'Niska korelacija — dobra diversifikacija (' + (c.syms ? c.syms.length : 0) + ' simbola)';

      // Heatmap grid
      const hm = document.getElementById('corr-heatmap');
      if (hm && c.matrix && c.syms) {
        const syms = c.syms.map(function(s){ return s.replace('USDT',''); });
        const n = syms.length;
        const cell = 28;
        function corrColor2(v) {
          if (v >= 0.9)  return '#dc2626';
          if (v >= 0.75) return '#f7913a';
          if (v >= 0.5)  return '#d97706';
          if (v >= 0.25) return '#94a3b8';
          if (v >= 0)    return '#21262d';
          return '#388bfd';
        }
        let html = '<div style="display:inline-block;font-size:9px">';
        // Header row
        html += '<div style="display:flex;margin-left:' + (cell+2) + 'px">';
        for (var j=0; j<n; j++) {
          html += '<div style="width:' + cell + 'px;text-align:center;color:#9ca3af;overflow:hidden;white-space:nowrap;font-size:8px">' + syms[j] + '</div>';
        }
        html += '</div>';
        // Data rows
        for (var i=0; i<n; i++) {
          html += '<div style="display:flex;align-items:center">';
          html += '<div style="width:' + cell + 'px;text-align:right;padding-right:4px;color:#9ca3af;font-size:8px;white-space:nowrap">' + syms[i] + '</div>';
          for (var j2=0; j2<n; j2++) {
            var v = c.matrix[i] ? (c.matrix[i][j2] !== undefined ? c.matrix[i][j2] : 0) : 0;
            var bg = corrColor2(v);
            var txt = i===j2 ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);
            var txtColor = (v > 0.5 || v < 0) ? '#fff' : '#94a3b8';
            html += '<div title="' + syms[i] + '/' + syms[j2] + ': ' + v.toFixed(3) + '" style="width:' + cell + 'px;height:' + cell + 'px;background:' + bg + ';display:flex;align-items:center;justify-content:center;color:' + txtColor + ';font-size:7px;border:1px solid #0d1117;border-radius:2px">' + txt + '</div>';
          }
          html += '</div>';
        }
        // Legend
        html += '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:9px;color:#9ca3af">';
        html += '<span>Korelacija:</span>';
        var legend = [['#388bfd','<0'],['#21262d','0–0.25'],['#94a3b8','0.25–0.5'],['#d97706','0.5–0.75'],['#f7913a','0.75–0.9'],['#dc2626','>0.9']];
        for (var l=0; l<legend.length; l++) {
          html += '<span style="display:inline-flex;align-items:center;gap:2px"><span style="display:inline-block;width:10px;height:10px;background:' + legend[l][0] + ';border-radius:2px"></span>' + legend[l][1] + '</span>';
        }
        html += '</div></div>';
        hm.innerHTML = html;
        // Ostaje zatvoren — korisnik otvara toggle gumbom
      }
    }

    // Deribit Put/Call Ratio
    if (d.pc && d.pc.btc) {
      const btc = d.pc.btc;
      const pcColor = btc.sentiment === 'FEAR'    ? '#388bfd'
                    : btc.sentiment === 'BEARISH'  ? '#94a3b8'
                    : btc.sentiment === 'BULLISH'  ? '#d97706'
                    : btc.sentiment === 'GREED'    ? '#dc2626'
                    : '#94a3b8';
      const pcIcon  = btc.sentiment === 'FEAR'  ? '😰'
                    : btc.sentiment === 'GREED' ? '🤑' : '😐';
      const pcEl = document.getElementById('pc-val');
      if (pcEl) {
        pcEl.textContent = 'BTC: ' + (btc.ratio ?? '—') + '  ETH: ' + (d.pc.eth?.ratio ?? '—');
        pcEl.style.color = pcColor;
        document.getElementById('pc-sub').textContent =
          pcIcon + ' BTC ' + (btc.sentiment || '') +
          (btc.sentiment === 'FEAR'  ? ' — institucije kupuju puts (zaštita)' :
           btc.sentiment === 'GREED' ? ' — previše calls, euforija' :
           ' · >1.5=Fear · <0.5=Greed');
      }
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

    // Per-Symbol WR
    const symStats = d.symStats || {};
    const symEntries = Object.entries(symStats)
      .filter(([,v]) => v.total >= 2)
      .map(([k,v]) => ({ sym: k, wr: v.wins/v.total*100, total: v.total }))
      .sort((a, b) => b.total - a.total);

    if (symEntries.length > 0) {
      document.getElementById('sym-wr-table').innerHTML = symEntries.map(function(e) {
        const color = e.wr >= 50 ? '#059669' : e.wr >= 35 ? '#d97706' : '#dc2626';
        const bar = Math.round(e.wr);
        return '<div style="background:#2d3748;border-radius:6px;padding:8px 10px">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
          '<span style="font-size:12px;font-weight:700">' + e.sym.replace('USDT','') + '</span>' +
          '<span style="font-size:12px;color:' + color + ';font-weight:700">' + e.wr.toFixed(0) + '%</span>' +
          '</div>' +
          '<div style="background:#30363d;border-radius:2px;height:4px;overflow:hidden">' +
          '<div style="width:' + bar + '%;height:100%;background:' + color + ';border-radius:2px"></div>' +
          '</div>' +
          '<div style="font-size:10px;color:#9ca3af;margin-top:3px">N=' + e.total + '</div>' +
          '</div>';
      }).join('');
    } else {
      document.getElementById('sym-wr-table').innerHTML = '<div style="font-size:12px;color:#9ca3af">Nema dovoljno podataka (treba 2+ tradova po simbolu)</div>';
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
</script>

<!-- ═══════════════════════════ SQUEEZE WATCHLIST PANEL ═══════════════════ -->
<div style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:20px;margin:20px 0" id="squeeze-panel">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#a78bfa">
      🧨 Short Squeeze Watchlist
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="font-size:10px;color:#6b7280" id="squeeze-ts">Učitavam…</div>
      <button onclick="squeezeForceRefresh()" title="Osvježi sve dionice"
        style="background:#1f2937;border:1px solid #374151;border-radius:4px;color:#9ca3af;font-size:10px;padding:2px 7px;cursor:pointer">↻</button>
    </div>
  </div>

  <!-- Tab header -->
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px" id="squeeze-tabs">
    <button onclick="squeezeShowTab('AMC')" id="squeeze-tab-AMC"
      style="background:#db2777;border:none;border-radius:6px;color:#fff;font-size:11px;font-weight:700;padding:5px 12px;cursor:pointer">🍿 AMC</button>
    <button onclick="squeezeShowTab('GME')" id="squeeze-tab-GME"
      style="background:#374151;border:none;border-radius:6px;color:#9ca3af;font-size:11px;font-weight:700;padding:5px 12px;cursor:pointer">🎮 GME</button>
    <button onclick="squeezeShowTab('KOSS')" id="squeeze-tab-KOSS"
      style="background:#374151;border:none;border-radius:6px;color:#9ca3af;font-size:11px;font-weight:700;padding:5px 12px;cursor:pointer">🎧 KOSS</button>
    <button onclick="squeezeShowTab('BYND')" id="squeeze-tab-BYND"
      style="background:#374151;border:none;border-radius:6px;color:#9ca3af;font-size:11px;font-weight:700;padding:5px 12px;cursor:pointer">🌱 BYND</button>
    <button onclick="squeezeShowTab('UPST')" id="squeeze-tab-UPST"
      style="background:#374151;border:none;border-radius:6px;color:#9ca3af;font-size:11px;font-weight:700;padding:5px 12px;cursor:pointer">🤖 UPST</button>
    <button onclick="squeezeShowTab('BBAI')" id="squeeze-tab-BBAI"
      style="background:#374151;border:none;border-radius:6px;color:#9ca3af;font-size:11px;font-weight:700;padding:5px 12px;cursor:pointer">🐻 BBAI</button>
    <button onclick="squeezeShowTab('SMCI')" id="squeeze-tab-SMCI"
      style="background:#374151;border:none;border-radius:6px;color:#9ca3af;font-size:11px;font-weight:700;padding:5px 12px;cursor:pointer">🖥️ SMCI</button>
  </div>

  <!-- Compact grid: sve dionice odjednom -->
  <div id="squeeze-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px"></div>

  <!-- Detail panel za odabranu dionicu -->
  <div id="squeeze-detail" style="display:none;background:#111827;border:1px solid #374151;border-radius:10px;padding:16px">
    <div style="font-size:11px;color:#9ca3af;margin-bottom:12px" id="squeeze-detail-title">—</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px" id="squeeze-detail-metrics"></div>
    <!-- Squeeze score + faktori -->
    <div style="background:linear-gradient(135deg,#1e1b4b,#111827);border:1px solid #4f46e5;border-radius:10px;padding:14px">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
        <div style="position:relative;width:64px;height:64px;flex-shrink:0">
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="26" fill="none" stroke="#374151" stroke-width="5"/>
            <circle cx="32" cy="32" r="26" fill="none" stroke="#4f46e5" stroke-width="5"
              stroke-dasharray="163.4" id="sq-detail-arc"
              stroke-dashoffset="163.4" stroke-linecap="round"
              transform="rotate(-90 32 32)" style="transition:stroke-dashoffset 1s,stroke 1s"/>
          </svg>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
            <div style="font-size:17px;font-weight:900;color:#fff" id="sq-detail-score">—</div>
          </div>
        </div>
        <div>
          <div style="font-size:18px;font-weight:800;color:#e5e7eb" id="sq-detail-label">…</div>
          <div style="font-size:10px;color:#9ca3af;margin-top:3px">Skor 0–100 · Short Squeeze Potencijal</div>
        </div>
      </div>
      <div id="sq-detail-factors" style="display:grid;gap:5px"></div>
    </div>
  </div>
</div>

<script>
// ── Squeeze panel — flat global functions (no IIFE, no closure issues) ──────
var _sqData   = {};
var _sqActive = null;
var _sqTickers = ['AMC','GME','KOSS','BYND','UPST','BBAI','SMCI'];
var _sqEmojis  = { AMC:'🍿', GME:'🎮', KOSS:'🎧', BYND:'🌱', UPST:'🤖', BBAI:'🐻', SMCI:'🖥️' };

function _sqScoreColor(s) { return s>=75?'#ef4444':s>=55?'#f97316':s>=35?'#eab308':'#22c55e'; }
function _sqFmt(v)  { return v != null ? v : '—'; }
function _sqFmtQ(q) { return q>=1e6?(q/1e6).toFixed(2)+'M':q>=1e3?(q/1e3).toFixed(0)+'K':String(q); }
// Legacy aliases kept in case referenced elsewhere — remove if unused
function scoreColor(s) { return _sqScoreColor(s); }
function fmt(v)        { return _sqFmt(v); }
function fmtQty(q)     { return _sqFmtQ(q); }

function sqRenderGrid() {
  var grid = document.getElementById('squeeze-grid');
  if (!grid) return;
  var html = '';
  for (var ti=0; ti<_sqTickers.length; ti++) {
    var t = _sqTickers[ti];
    var d = _sqData[t];
    var em = _sqEmojis[t] || '';
    if (!d || d.loading) {
      html += '<div onclick="squeezeShowTab(\'' + t + '\')" style="background:#1f2937;border:1px solid #374151;border-radius:8px;padding:12px;cursor:pointer;text-align:center">'
            + '<div style="font-size:11px;color:#9ca3af;font-weight:700">' + em + ' ' + t + '</div>'
            + '<div style="font-size:11px;color:#6b7280;margin-top:6px">Učitavam…</div>'
            + '</div>';
      continue;
    }
    var sq = d.squeeze || {};
    var sqScore = sq.score != null ? sq.score : 0;
    var sqColor = _sqScoreColor(sqScore);
    var priceStr = d.price != null ? '$' + d.price.toFixed(2) : '—';
    var chgStr = d.changePct ? String(d.changePct) : '';
    var chgUp = chgStr && chgStr.charAt(0) !== '-';
    var siStr  = _sqFmt(d.shortPctFloat);
    var dtcStr = _sqFmt(d.shortRatio);
    var ctbStr = d.borrowFee && d.borrowFee.fee != null ? d.borrowFee.fee.toFixed(1)+'%' : '—';
    var sqLbl  = sq.label ? sq.label.split(' ').slice(0,2).join(' ') : '—';
    html += '<div onclick="squeezeShowTab(\'' + t + '\')" style="background:#1f2937;border:1px solid #374151;border-radius:8px;padding:12px;cursor:pointer" onmouseenter="this.style.borderColor=\'#6366f1\'" onmouseleave="this.style.borderColor=\'#374151\'">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
          +   '<div style="font-size:11px;color:#9ca3af;font-weight:700">' + em + ' ' + t + '</div>'
          +   '<div style="font-size:14px;font-weight:900;color:' + sqColor + '">' + sqScore + '</div>'
          + '</div>'
          + '<div style="font-size:18px;font-weight:800;color:#f3f4f6">' + priceStr + '</div>'
          + (chgStr ? '<div style="font-size:11px;color:' + (chgUp?'#34d399':'#ef4444') + '">' + (chgUp?'▲':'▼') + ' ' + chgStr + '</div>' : '')
          + '<div style="margin-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:3px;font-size:10px;color:#9ca3af">'
          +   '<span>SI: <b style="color:#fff">' + siStr + '</b></span>'
          +   '<span>DTC: <b style="color:#fff">' + dtcStr + 'd</b></span>'
          +   '<span>CTB: <b style="color:#fff">' + ctbStr + '</b></span>'
          +   '<span><b style="color:' + sqColor + '">' + sqLbl + '</b></span>'
          + '</div>'
          + '</div>';
  }
  grid.innerHTML = html;
}

function sqRenderDetail(ticker) {
  var d = _sqData[ticker];
  var panel = document.getElementById('squeeze-detail');
  if (!panel) return;
  if (!d || d.error) {
    panel.style.display = 'block';
    panel.innerHTML = '<div style="text-align:center;padding:32px;color:#dc2626">'
      + '<div style="font-size:28px">❌</div>'
      + '<div style="margin-top:8px">' + (d && d.error ? 'Greška: ' + d.error : 'Nema podataka') + '</div>'
      + '</div>';
    return;
  }
  if (d.loading) {
    panel.style.display = 'block';
    panel.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#9ca3af">'
      + '<div style="font-size:28px;margin-bottom:12px">⏳</div>'
      + '<div style="font-size:14px;font-weight:600;color:#e5e7eb">Učitavam ' + ticker + '…</div>'
      + '<div style="font-size:11px;margin-top:8px">Finviz · može trajati 10–20s</div>'
      + '</div>';
    return;
  }
  panel.style.display = 'block';

  var sq = d.squeeze || {};
  var sqScore = sq.score != null ? sq.score : 0;
  var sqCol = _sqScoreColor(sqScore);
  var ctbFee = d.borrowFee && d.borrowFee.fee != null ? d.borrowFee.fee : null;
  var ctbColor = ctbFee!=null ? (ctbFee>=5?'#f87171':ctbFee>=1?'#fbbf24':'#4b5563') : '#4b5563';

  var items = [
    { label:'💵 Cijena',         val: d.price!=null?'$'+d.price.toFixed(2):'—',                 color:'#f3f4f6' },
    { label:'📉 Short Float',    val: _sqFmt(d.shortPctFloat),                                   color:'#ef4444' },
    { label:'⏱ Short Ratio',    val: _sqFmt(d.shortRatio)+'d',                                  color:'#f59e0b' },
    { label:'💸 Cost to Borrow', val: ctbFee!=null?ctbFee.toFixed(2)+'%':'N/A',                 color:ctbColor  },
    { label:'🚨 FTD',            val: d.ftd?_sqFmtQ(d.ftd.qty)+' ('+d.ftd.date+')':'N/A',      color:'#f87171' },
    { label:'📊 Market Cap',     val: _sqFmt(d.marketCap),                                       color:'#e5e7eb' },
    { label:'🏛 Inst Own',       val: _sqFmt(d.instOwn),                                         color:'#60a5fa' },
    { label:'📈 52W High',       val: _sqFmt(d.high52w),                                         color:'#9ca3af' },
  ];
  var mHtml = '';
  for (var i=0; i<items.length; i++) {
    var it = items[i];
    mHtml += '<div style="background:#1f2937;border:1px solid #374151;border-radius:6px;padding:9px">'
           + '<div style="font-size:9px;color:#9ca3af;text-transform:uppercase;margin-bottom:3px">' + it.label + '</div>'
           + '<div style="font-size:16px;font-weight:700;color:' + it.color + '">' + it.val + '</div>'
           + '</div>';
  }

  var factors = d.squeezeFactors || (sq.factors) || [];
  var fHtml = '';
  for (var fi=0; fi<factors.length; fi++) {
    var f = factors[fi];
    if (f.score === null) {
      fHtml += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:4px 0;border-bottom:1px solid #1f2937">'
             + '<span style="color:#9ca3af">' + f.name + '</span><span style="color:#4b5563">' + f.val + ' · N/A</span></div>';
    } else {
      var pct = Math.round(f.score / f.max * 100);
      var fCol = pct>=75?'#ef4444':pct>=50?'#f97316':pct>=25?'#eab308':'#374151';
      fHtml += '<div style="margin-bottom:5px">'
             + '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">'
             +   '<span style="color:#9ca3af">' + f.name + '</span>'
             +   '<span style="color:#e5e7eb;font-weight:600">' + f.val + ' <span style="color:' + fCol + '">(' + f.score + '/' + f.max + ')</span></span>'
             + '</div>'
             + '<div style="background:#374151;border-radius:3px;height:4px">'
             +   '<div style="background:' + fCol + ';height:4px;border-radius:3px;width:' + pct + '%;transition:width 1s"></div>'
             + '</div></div>';
    }
  }

  var dashArc = 163.4 * (1 - sqScore / 100);
  panel.innerHTML =
      '<div style="font-size:11px;color:#9ca3af;margin-bottom:12px">'
    +   (_sqEmojis[ticker]||'') + ' <b style="color:#e5e7eb">' + (d.name||ticker) + '</b> (NYSE/NASDAQ: ' + ticker + ')'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px">'
    + mHtml + '</div>'
    + '<div style="background:linear-gradient(135deg,#1e1b4b,#111827);border:1px solid #4f46e5;border-radius:10px;padding:14px">'
    +   '<div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">'
    +     '<div style="position:relative;width:64px;height:64px;flex-shrink:0">'
    +       '<svg width="64" height="64" viewBox="0 0 64 64">'
    +         '<circle cx="32" cy="32" r="26" fill="none" stroke="#374151" stroke-width="5"/>'
    +         '<circle cx="32" cy="32" r="26" fill="none" stroke="' + sqCol + '" stroke-width="5"'
    +           ' stroke-dasharray="163.4" stroke-dashoffset="' + dashArc + '"'
    +           ' stroke-linecap="round" transform="rotate(-90 32 32)"/>'
    +       '</svg>'
    +       '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">'
    +         '<div style="font-size:17px;font-weight:900;color:' + sqCol + '">' + sqScore + '</div>'
    +       '</div>'
    +     '</div>'
    +     '<div>'
    +       '<div style="font-size:18px;font-weight:800;color:#e5e7eb">' + (sq.label||'—') + '</div>'
    +       '<div style="font-size:10px;color:#9ca3af;margin-top:3px">Skor 0–100 · Short Squeeze Potencijal</div>'
    +     '</div>'
    +   '</div>'
    +   '<div style="display:grid;gap:5px">' + fHtml + '</div>'
    + '</div>';
}

// ── squeezeShowTab — GLOBAL (not window.x inside IIFE) ───────────────────────
function squeezeShowTab(ticker) {
  _sqActive = ticker;
  sessionStorage.setItem('sqActiveTab', ticker);

  // 1. Tab highlight
  for (var i=0; i<_sqTickers.length; i++) {
    var btn = document.getElementById('squeeze-tab-'+_sqTickers[i]);
    if (!btn) continue;
    btn.style.background = (_sqTickers[i]===ticker) ? '#6366f1' : '#374151';
    btn.style.color      = (_sqTickers[i]===ticker) ? '#fff'     : '#9ca3af';
  }

  // 2. Always hide AMC panel first (re-shown below if AMC tab)
  var amcPanel = document.getElementById('amc-panel');
  if (amcPanel) amcPanel.style.display = 'none';

  if (ticker === 'AMC') {
    // Show AMC panel, hide squeeze-detail
    if (amcPanel) amcPanel.style.display = 'block';
    var sqDet = document.getElementById('squeeze-detail');
    if (sqDet) sqDet.style.display = 'none';
    setTimeout(function() {
      var ap = document.getElementById('amc-panel');
      if (ap) ap.scrollIntoView({ behavior:'smooth', block:'start' });
    }, 80);
    return;
  }

  // 3. Non-AMC: show squeeze-detail (spinner or data)
  var panel = document.getElementById('squeeze-detail');
  if (panel) panel.style.display = 'block';

  var existing = _sqData[ticker];
  if (existing && !existing.loading && !existing.error) {
    sqRenderDetail(ticker);
  } else {
    // Show spinner immediately
    if (panel) {
      panel.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#9ca3af">'
        + '<div style="font-size:28px;margin-bottom:12px">⏳</div>'
        + '<div style="font-size:14px;font-weight:600;color:#e5e7eb">Učitavam ' + ticker + '…</div>'
        + '<div style="font-size:11px;margin-top:8px">Finviz · može trajati 10–20s</div>'
        + '</div>';
    }
    // Fetch from server (blocking ~15s)
    fetch('/api/squeeze?ticker='+ticker)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        _sqData[ticker] = data;
        sqRenderGrid();
        if (_sqActive === ticker) sqRenderDetail(ticker);
      })
      .catch(function(e) {
        if (_sqActive === ticker) {
          var p = document.getElementById('squeeze-detail');
          if (p) p.innerHTML = '<div style="text-align:center;padding:40px;color:#dc2626">'
            + '<div style="font-size:28px">❌</div>'
            + '<div style="margin-top:8px">Mreža: ' + (e.message||'Greška') + '</div></div>';
        }
      });
  }

  // 4. Scroll to squeeze-detail
  setTimeout(function() {
    var det = document.getElementById('squeeze-detail');
    if (det) det.scrollIntoView({ behavior:'smooth', block:'start' });
  }, 80);
}

function squeezeForceRefresh() {
  var tsEl = document.getElementById('squeeze-ts');
  if (tsEl) tsEl.textContent = 'Osvježavam sve dionice…';
  fetch('/api/amc?force=1').then(function(r){return r.json();}).then(function(d){
    _sqData['AMC'] = Object.assign({}, d, { squeezeFactors: d.squeeze && d.squeeze.factors });
    if (_sqActive === 'AMC') sqRenderDetail('AMC');
  }).catch(function(){});
  fetch('/api/squeeze').then(function(r){return r.json();}).then(function(arr){
    for (var i=0; i<arr.length; i++) { if (arr[i] && arr[i].ticker) _sqData[arr[i].ticker] = arr[i]; }
    sqRenderGrid();
    if (_sqActive && _sqData[_sqActive]) sqRenderDetail(_sqActive);
    var ts = document.getElementById('squeeze-ts');
    if (ts) ts.textContent = new Date().toLocaleTimeString('hr-HR',{hour:'2-digit',minute:'2-digit'}) + ' · osvježeno';
  }).catch(function(){});
}

function _sqLoad() {
  fetch('/api/amc').then(function(r){return r.json();}).then(function(amc){
    if (amc && !amc.error) _sqData['AMC'] = Object.assign({}, amc, { squeezeFactors: amc.squeeze && amc.squeeze.factors });
  }).catch(function(){});
  fetch('/api/squeeze').then(function(r){return r.json();}).then(function(arr){
    for (var i=0; i<arr.length; i++) { if (arr[i] && arr[i].ticker) _sqData[arr[i].ticker] = arr[i]; }
    sqRenderGrid();
    var ts = document.getElementById('squeeze-ts');
    if (ts) ts.textContent = new Date().toLocaleTimeString('hr-HR',{hour:'2-digit',minute:'2-digit'}) + ' · cache';
  }).catch(function(e){
    var ts = document.getElementById('squeeze-ts');
    if (ts) ts.textContent = 'Greška: ' + e.message;
  });
}

// ── sessionStorage — čuva aktivan tab kroz page reload (meta refresh) ──────
var _sqSavedTab = sessionStorage.getItem('sqActiveTab');

// Init
_sqLoad();
setInterval(_sqLoad, 60 * 60 * 1000);

// Restore active tab after reload
if (_sqSavedTab) {
  sessionStorage.removeItem('sqActiveTab');
  setTimeout(function() { squeezeShowTab(_sqSavedTab); }, 200);
}
</script>

<!-- ═══════════════════════════════════════════════════════════ AMC PANEL ═══ -->
<div style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:20px;margin:20px 0" id="amc-panel">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#f59e0b">
      🍿 AMC Entertainment Holdings (NYSE: AMC)
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="font-size:10px;color:#6b7280" id="amc-ts">Učitavam…</div>
      <button onclick="amcForceRefresh()" title="Forsiraj osvježavanje podataka (ignoriraj cache)"
        style="background:#1f2937;border:1px solid #374151;border-radius:4px;color:#9ca3af;font-size:10px;padding:2px 7px;cursor:pointer">↻</button>
    </div>
  </div>

  <!-- Gornji red: cijene + kratki interes -->
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px">

    <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px">
      <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">💵 Cijena</div>
      <div style="font-size:24px;font-weight:800;color:#f3f4f6" id="amc-price">…</div>
      <div style="font-size:12px;margin-top:2px" id="amc-change">…</div>
      <div style="font-size:10px;color:#6b7280;margin-top:2px" id="amc-vol-sub">…</div>
    </div>

    <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px">
      <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">📉 Short Float</div>
      <div style="font-size:24px;font-weight:800;color:#ef4444" id="amc-si">…</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px" id="amc-si-sub">dionica short</div>
    </div>

    <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px">
      <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">⏱️ Short Ratio</div>
      <div style="font-size:24px;font-weight:800;color:#f59e0b" id="amc-dtc">…</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px" id="amc-si-total">dana za pokriće</div>
    </div>

    <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px">
      <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">🏛️ Inst Own</div>
      <div style="font-size:24px;font-weight:800;color:#60a5fa" id="amc-inst">…</div>
      <div style="font-size:11px;margin-top:2px" id="amc-inst-trans">kvartal promjena</div>
    </div>

    <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px">
      <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">👤 Insider Own</div>
      <div style="font-size:24px;font-weight:800;color:#34d399" id="amc-insider">…</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px" id="amc-insider-sub">% vlasništva</div>
    </div>

    <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px">
      <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">📊 Market Cap</div>
      <div style="font-size:18px;font-weight:800;color:#e5e7eb" id="amc-cap">…</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px" id="amc-float">float / outstanding</div>
    </div>

    <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px">
      <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">🚨 Failure to Deliver</div>
      <div style="font-size:22px;font-weight:800;color:#f87171" id="amc-ftd">…</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px" id="amc-ftd-sub">dionica</div>
      <div style="font-size:10px;margin-top:2px" id="amc-ftd-chg"></div>
    </div>

    <div style="background:#111827;border:1px solid #374151;border-radius:8px;padding:12px">
      <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">💸 Cost to Borrow</div>
      <div style="font-size:24px;font-weight:800;color:#fbbf24" id="amc-ctb">…</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px" id="amc-ctb-sub">godišnja stopa</div>
    </div>

  </div>

  <!-- Short Squeeze Score -->
  <div style="background:linear-gradient(135deg,#1e1b4b,#111827);border:1px solid #4f46e5;border-radius:10px;padding:16px;margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-size:12px;color:#a5b4fc;font-weight:700;text-transform:uppercase;letter-spacing:1px">🧨 Short Squeeze Potencijal</div>
      <div style="font-size:11px;color:#6b7280" id="amc-squeeze-updated"></div>
    </div>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:14px">
      <!-- Score krug -->
      <div style="position:relative;width:72px;height:72px;flex-shrink:0">
        <svg width="72" height="72" viewBox="0 0 72 72">
          <circle cx="36" cy="36" r="30" fill="none" stroke="#374151" stroke-width="6"/>
          <circle cx="36" cy="36" r="30" fill="none" stroke="#4f46e5" stroke-width="6"
            stroke-dasharray="188.5" id="amc-squeeze-arc"
            stroke-dashoffset="188.5" stroke-linecap="round"
            transform="rotate(-90 36 36)" style="transition:stroke-dashoffset 1s,stroke 1s"/>
        </svg>
        <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
          <div style="font-size:20px;font-weight:900;color:#fff" id="amc-squeeze-score">—</div>
        </div>
      </div>
      <div>
        <div style="font-size:22px;font-weight:800;color:#e5e7eb" id="amc-squeeze-label">…</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">Skor 0–100 · Finviz + companiesmarketcap</div>
      </div>
    </div>
    <!-- Faktori -->
    <div id="amc-squeeze-factors" style="display:grid;gap:6px"></div>
  </div>

  <!-- Institucionalni vlasnici -->
  <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;font-weight:700;letter-spacing:1px;margin-bottom:8px">
    🏦 Top institucionalni vlasnici (Finviz 13F)
  </div>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="border-bottom:1px solid #374151">
          <th style="text-align:left;padding:6px 8px;color:#6b7280;font-weight:600">#</th>
          <th style="text-align:left;padding:6px 8px;color:#6b7280;font-weight:600">Institucija</th>
          <th style="text-align:right;padding:6px 8px;color:#6b7280;font-weight:600">% vlasništva</th>
        </tr>
      </thead>
      <tbody id="amc-inst-body">
        <tr><td colspan="3" style="text-align:center;padding:16px;color:#6b7280">Učitavam…</td></tr>
      </tbody>
    </table>
  </div>
</div>

<script>
(function amcPanel() {
  async function loadAmc() {
    try {
      const d = await fetch('/api/amc').then(r => r.json());
      if (d.error) { document.getElementById('amc-ts').textContent = 'Greška: ' + d.error; return; }
      if (d.loading) {
        document.getElementById('amc-ts').textContent = 'Podaci se učitavaju… (osvježavam za 30s)';
        setTimeout(loadAmc, 30000);
        return;
      }

      const f = v => v != null ? v : '—';
      const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

      // Cijena + promjena
      if (d.price != null) {
        document.getElementById('amc-price').textContent = '$' + d.price.toFixed(2);
      }
      if (d.changePct != null) {
        const up = !String(d.changePct).startsWith('-');
        const el = document.getElementById('amc-change');
        el.textContent = (up ? '▲ ' : '▼ ') + d.changePct;
        el.style.color = up ? '#34d399' : '#ef4444';
      }
      document.getElementById('amc-vol-sub').textContent =
        'Vol: ' + f(d.volume) + ' · Avg: ' + f(d.avgVolume);

      // Short Interest
      document.getElementById('amc-si').textContent = f(d.shortPctFloat);
      document.getElementById('amc-si-sub').textContent = f(d.shortInterest) + ' dionica short';
      document.getElementById('amc-dtc').textContent = f(d.shortRatio);
      document.getElementById('amc-si-total').textContent = 'dana za pokriće';

      // Institucije
      document.getElementById('amc-inst').textContent = f(d.instOwn);
      const trans = d.instTrans;
      const transEl = document.getElementById('amc-inst-trans');
      if (trans) {
        const transUp = !trans.startsWith('-');
        transEl.textContent = (transUp ? '▲ ' : '▼ ') + trans + ' zadnji kvartal';
        transEl.style.color = transUp ? '#34d399' : '#ef4444';
      } else {
        transEl.textContent = 'kvartal promjena';
        transEl.style.color = '#9ca3af';
      }

      // Insider
      document.getElementById('amc-insider').textContent = f(d.insiderOwn);
      const ia = d.insiderActivity;
      document.getElementById('amc-insider-sub').textContent = ia
        ? 'Buy: $' + (ia.totalBuy/1e6).toFixed(1) + 'M · Sell: $' + (ia.totalSell/1e6).toFixed(1) + 'M'
        : '% vlasništva';

      // FTD
      if (d.ftd) {
        const fmtQty = q => q >= 1e6 ? (q/1e6).toFixed(2)+'M'
                          : q >= 1e3 ? (q/1e3).toFixed(0)+'K'
                          : String(q);
        setEl('amc-ftd', fmtQty(d.ftd.qty));
        setEl('amc-ftd-sub', d.ftd.date + (d.ftd.price != null ? ' · $' + d.ftd.price.toFixed(2) : ' · companiesmarketcap'));
        // Prikaži promjenu od prethodnog dana
        const chgEl = document.getElementById('amc-ftd-chg');
        if (chgEl) {
          if (d.ftd.change != null) {
            const chg = d.ftd.change;
            chgEl.textContent = (chg >= 0 ? '▲ +' : '▼ ') + fmtQty(Math.abs(chg)) + ' vs preth.';
            chgEl.style.color = chg > 0 ? '#f87171' : chg < 0 ? '#4ade80' : '#9ca3af';
          } else { chgEl.textContent = ''; }
        }
      } else {
        setEl('amc-ftd', 'N/A');
        setEl('amc-ftd-sub', 'nema dostupnih podataka');
        setEl('amc-ftd-chg', '');
      }

      // Market Cap + Float
      document.getElementById('amc-cap').textContent = f(d.marketCap);
      const outstandStr = d.sharesOutstandCMC != null
        ? (d.sharesOutstandCMC / 1e6).toFixed(2) + 'M'
        : f(d.sharesOutstand);
      document.getElementById('amc-float').textContent =
        f(d.sharesFloat) + ' / ' + outstandStr;

      // Cost to Borrow
      const ctbEl = document.getElementById('amc-ctb');
      const ctbSub = document.getElementById('amc-ctb-sub');
      if (d.borrowFee && d.borrowFee.fee != null) {
        ctbEl.textContent = d.borrowFee.fee.toFixed(2) + '%';
        // Boja prema visini CTB-a
        ctbEl.style.color = d.borrowFee.fee >= 20 ? '#f87171' : d.borrowFee.fee >= 5 ? '#fb923c' : d.borrowFee.fee >= 1 ? '#fbbf24' : '#4ade80';
        const avail = d.borrowFee.available;
        if (avail != null) {
          const availStr = avail >= 1e6 ? (avail/1e6).toFixed(1)+'M' : avail >= 1e3 ? (avail/1e3).toFixed(0)+'K' : String(avail);
          ctbSub.textContent = 'Dostupno za borrow: ' + availStr + ' dionica';
        } else {
          ctbSub.textContent = 'companiesmarketcap.com';
        }
      } else {
        ctbEl.textContent = 'N/A';
        ctbEl.style.color = '#4b5563';
        ctbSub.textContent = 'podaci nedostupni';
      }

      // Short Squeeze Score
      if (d.squeeze) {
        const sq = d.squeeze;
        document.getElementById('amc-squeeze-score').textContent = sq.score;
        document.getElementById('amc-squeeze-label').textContent = sq.label;
        document.getElementById('amc-squeeze-updated').textContent = new Date(d.ts).toLocaleTimeString('hr-HR', {hour:'2-digit',minute:'2-digit'});

        // Animirani krug — stroke-dashoffset od 188.5 (0%) do 0 (100%)
        const arc = document.getElementById('amc-squeeze-arc');
        const offset = 188.5 * (1 - sq.score / 100);
        arc.style.strokeDashoffset = offset;
        // Boja luka
        const arcCol = sq.score >= 75 ? '#ef4444' : sq.score >= 55 ? '#f97316' : sq.score >= 35 ? '#eab308' : '#22c55e';
        arc.style.stroke = arcCol;
        document.getElementById('amc-squeeze-score').style.color = arcCol;

        // Faktori — progress bar za svaki
        const fDiv = document.getElementById('amc-squeeze-factors');
        fDiv.innerHTML = sq.factors.map(f => {
          if (f.score === null) {
            // Nedostupan faktor — prikaži sivo
            return '<div style="display:grid;grid-template-columns:110px 1fr 50px 30px;align-items:center;gap:8px;opacity:0.4">' +
              '<div style="font-size:11px;color:#9ca3af">' + f.name + '</div>' +
              '<div style="background:#1f2937;border-radius:3px;height:6px;border:1px dashed #374151"></div>' +
              '<div style="font-size:11px;color:#6b7280;text-align:right">N/A</div>' +
              '<div style="font-size:10px;color:#4b5563;text-align:right">?/' + f.max + '</div>' +
              '</div>';
          }
          const pct = Math.round(f.score / f.max * 100);
          const barCol = pct >= 70 ? '#ef4444' : pct >= 40 ? '#f97316' : '#60a5fa';
          return '<div style="display:grid;grid-template-columns:110px 1fr 50px 30px;align-items:center;gap:8px">' +
            '<div style="font-size:11px;color:#9ca3af">' + f.name + '</div>' +
            '<div style="background:#374151;border-radius:3px;height:6px"><div style="background:' + barCol + ';height:100%;border-radius:3px;width:' + pct + '%;transition:width 1s"></div></div>' +
            '<div style="font-size:11px;color:#e5e7eb;text-align:right">' + f.val + '</div>' +
            '<div style="font-size:10px;color:#6b7280;text-align:right">' + f.score + '/' + f.max + '</div>' +
            '</div>';
        }).join('') + (sq.partial ? '<div style="font-size:10px;color:#4b5563;margin-top:6px">⚠️ Score baziran na 3/5 faktora · CTB i Shares nedostupni (Finviz only)</div>' : '');
      }

      // Institucionalni vlasnici — tablica
      const tbody = document.getElementById('amc-inst-body');
      if (d.institutions && d.institutions.length > 0) {
        tbody.innerHTML = d.institutions.map((inst, i) => {
          const pct = parseFloat(inst.pctOwn);
          const bar = !isNaN(pct) ? '<div style="background:#374151;border-radius:2px;height:4px;margin-top:4px"><div style="background:#60a5fa;height:100%;border-radius:2px;width:' + Math.min(pct * 10, 100) + '%"></div></div>' : '';
          return '<tr style="border-bottom:1px solid #1f2937">' +
            '<td style="padding:6px 8px;color:#6b7280;font-size:11px">' + (i+1) + '</td>' +
            '<td style="padding:6px 8px;color:#f3f4f6">' + inst.name + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:#60a5fa">' + inst.pctOwn + bar + '</td>' +
            '</tr>';
        }).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:16px;color:#6b7280">Nema podataka</td></tr>';
      }

      // Timestamp + cache info
      const cacheStr = d.cached ? ' · cache ' + d.cacheAge : ' · svježe';
      document.getElementById('amc-ts').textContent =
        new Date(d.ts).toLocaleString('hr-HR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) + cacheStr;

    } catch(e) {
      document.getElementById('amc-ts').textContent = 'Greška: ' + e.message;
    }
  }

  window.amcForceRefresh = async function() {
    document.getElementById('amc-ts').textContent = 'Osvježavam… (može trajati 15-20s)';
    try {
      const d = await fetch('/api/amc?force=1').then(r => r.json());
      await renderAmc(d);
    } catch(e) {
      document.getElementById('amc-ts').textContent = 'Greška: ' + e.message;
    }
  };

  async function renderAmc(d) {
    // isti kod kao u loadAmc — premještamo u zajednički helper
    if (d.error) { document.getElementById('amc-ts').textContent = 'Greška: ' + d.error; return; }
    loadAmc._lastData = d;
    // Pozovi loadAmc koji će automatski koristiti cache s novim podacima
    await loadAmc();
  }

  loadAmc();
  // Server cachira 4h — nema smisla češće. Refresh svakih 4h ili na F5.
  setInterval(loadAmc, 4 * 60 * 60 * 1000);
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

  // BTC Regime — bez auth, za debug
  if (url.pathname === "/api/regime") {
    try {
      const rUrl = "https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=4H&limit=60";
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

  // ── AMC Stock Data endpoint — instant iz cache-a (fetchAmcData radi u backgroundu) ──
  if (url.pathname === "/api/amc") {
    const forceRefresh = url.searchParams?.get("force") === "1";
    if (forceRefresh) {
      // Pokreni background refetch ali odmah vrati trenutni cache (ili čekaj ako nema cache)
      if (_amcCache.data) {
        fetchAmcData(); // fire-and-forget
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ..._amcCache.data, refreshing: true, cacheAge: Math.round((Date.now()-_amcCache.ts)/60000)+"min" }));
      } else {
        // Nema cache — blokiraj i čekaj (samo prvi put)
        const d = await fetchAmcData();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(d || { error: "Fetch nije uspio" }));
      }
    } else if (_amcCache.data) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ..._amcCache.data, cached: true, cacheAge: Math.round((Date.now()-_amcCache.ts)/60000)+"min" }));
    } else {
      // Cache prazan — trigger background, vrati loading
      fetchAmcData(); // fire-and-forget
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ loading: true, ts: new Date().toISOString() }));
    }
    return;
  }

  // ── Squeeze Stocks endpoint — svih 6 dionicama (GME, KOSS, BYND, UPST, BBAI, SMCI) ──
  if (url.pathname === "/api/squeeze") {
    const ticker = url.searchParams?.get("ticker");
    if (ticker) {
      // Jedna dionica — BLOCKING: čeka na podatke ako cache prazan (do 25s)
      const cfg = SQUEEZE_STOCKS.find(s => s.ticker === ticker.toUpperCase());
      if (!cfg) { res.writeHead(404); res.end(JSON.stringify({ error: "Ticker not found" })); return; }
      const cache = _squeezeCache[cfg.ticker];
      const forceRefresh = url.searchParams?.get("force") === "1";
      if (cache?.data && !forceRefresh) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...cache.data, cached: true, cacheAge: Math.round((Date.now()-cache.ts)/60000)+"min" }));
      } else {
        // Blokiraj i čekaj na podatke (max 25s) — ovo radi pri prvom kliku na tab
        const data = await fetchSqueezeStock(cfg);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data || { ticker: cfg.ticker, error: "Fetch nije uspio" }));
      }
    } else {
      // Sve dionice — vrati što imamo u cache-u, trigger fetch za prazan
      const result = SQUEEZE_STOCKS.map(cfg => {
        const cache = _squeezeCache[cfg.ticker];
        if (cache?.data) return { ...cache.data, cached: true, cacheAge: Math.round((Date.now()-cache.ts)/60000)+"min" };
        fetchSqueezeStock(cfg); // fire-and-forget za prazan cache
        return { ticker: cfg.ticker, name: cfg.name, emoji: cfg.emoji, loading: true };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
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

// ─── fetchAmcData() — Finviz + companiesmarketcap.com ─────────────────────────
// ChartExchange blokiran na Railway → Finviz (SI%, DTC, price) + CMC (CTB, FTD, Shares).
// Score se normalizira na dostupne faktore.
let _amcFetchRunning = false;
async function fetchAmcData() {
  if (_amcFetchRunning) return;
  _amcFetchRunning = true;
  try {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
    const FH = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://finviz.com/" };

    // ── 1. Finviz — jedini pouzdani izvor sa Railway ────────────────────────
    const fvHtml = await fetch("https://finviz.com/quote?t=AMC&p=d", { headers: FH, signal: AbortSignal.timeout(15000) }).then(r => r.text());
    const snap = {};
    const snapRe = /snapshot-td-label\"[^>]*>(?:<[^>]+>)*([^<]+?)(?:<\/[^>]+>)*<\/div><\/td>\s*<td[^>]*snapshot-td2[^>]*>[^<]*<div[^>]*snapshot-td-content[^>]*>(?:<[^>]+>)*([^<]+)/g;
    let sm;
    while ((sm = snapRe.exec(fvHtml)) !== null) snap[sm[1].trim()] = sm[2].trim();

    let institutions = [];
    try {
      const instMatch = fvHtml.match(/institutional-ownership-init-data-0"[^>]*type="application\/json">(\{[^<]+\})/);
      if (instMatch) {
        const instJ = JSON.parse(instMatch[1]);
        institutions = (instJ.managersOwnership ?? []).slice(0, 12).map(m => ({
          name: m.name, pctOwn: m.percOwnership != null ? m.percOwnership.toFixed(2) + "%" : "?",
        }));
      }
    } catch {}

    let insiderActivity = null;
    try {
      const insMatch = fvHtml.match(/insider-init-data-0"[^>]*type="application\/json">\[([^\]]+)\]/);
      if (insMatch) {
        const insArr = JSON.parse("[" + insMatch[1] + "]");
        const recent = insArr.filter(d => d.buyAggregated > 0 || d.saleAggregated > 0).slice(-6);
        insiderActivity = {
          totalBuy:  recent.reduce((s, d) => s + (d.buyAggregated  || 0), 0),
          totalSell: recent.reduce((s, d) => s + (d.saleAggregated || 0), 0),
          periods: recent.length
        };
      }
    } catch {}

    // ── 2. Cost to Borrow — companiesmarketcap.com ───────────────────────────
    // data=[{d:unixTs, v:rawVal}] gdje rawVal/100 = CTB%
    // Npr: v=123.25 → CTB=1.2325%
    let ctbPct = null;
    let ctbAvail = null;
    try {
      const cmcHtml = await fetch(
        "https://companiesmarketcap.com/amc-entertainment/cost-to-borrow/",
        { headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://companiesmarketcap.com/" },
          signal: AbortSignal.timeout(12000) }
      ).then(r => r.text());

      // Izvuci sve v-vrijednosti iz chart podataka (array data=[{d:ts,v:val}...])
      const vVals = [...cmcHtml.matchAll(/"v":([0-9.]+)/g)].map(m => parseFloat(m[1]));
      if (vVals.length > 0) {
        // Zadnja vrijednost = najnoviji CTB (v/100 = %)
        ctbPct = vVals[vVals.length - 1] / 100;
      }
      // data3 = shares available to borrow — format: "v":"4000000" (quoted string)
      // Ovo je intraday high-freq niz, zadnja non-zero vrijednost = trenutno dostupno
      const data3M = cmcHtml.match(/\bdata3\s*=\s*\[([^\]]*)\]/);
      if (data3M) {
        const d3Vals = [...data3M[1].matchAll(/"v":"([0-9]+)"/g)].map(m => parseInt(m[1]));
        const nonZeroAvail = d3Vals.filter(v => v > 0);
        if (nonZeroAvail.length > 0) ctbAvail = nonZeroAvail[nonZeroAvail.length - 1];
      }
      console.log("AMC CTB: " + (ctbPct !== null ? ctbPct.toFixed(4)+"%" : "N/A") + " avail: " + (ctbAvail != null ? (ctbAvail/1e6).toFixed(2)+"M" : "N/A"));
    } catch(e) { console.error("AMC CTB fetch greška:", e.message); }

    // ── 3. FTD — companiesmarketcap.com ──────────────────────────────────────
    // data=[{d:unixTs, v:ftdShares}] — raw share count, direktno (bez dijeljenja)
    let ftdData = null;
    let ftdHistory = [];
    try {
      const ftdHtml = await fetch(
        "https://companiesmarketcap.com/amc-entertainment/failure-to-deliver/",
        { headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://companiesmarketcap.com/" },
          signal: AbortSignal.timeout(12000) }
      ).then(r => r.text());
      const ftdPairs = [...ftdHtml.matchAll(/"d":(\d+),"v":([0-9.]+)/g)]
        .map(m => ({ d: parseInt(m[1]), v: parseFloat(m[2]) }));
      if (ftdPairs.length > 0) {
        const nonZero = ftdPairs.filter(p => p.v > 0);
        if (nonZero.length > 0) {
          const latest = nonZero[nonZero.length - 1];
          const prev   = nonZero.length > 1 ? nonZero[nonZero.length - 2] : null;
          ftdData = {
            qty:    Math.round(latest.v),
            date:   new Date(latest.d * 1000).toISOString().slice(0, 10),
            change: prev ? Math.round(latest.v - prev.v) : null,
            price:  null
          };
          ftdHistory = nonZero.slice(-10).map(p => ({
            date: new Date(p.d * 1000).toISOString().slice(0, 10),
            qty:  Math.round(p.v)
          }));
        }
      }
      console.log("AMC FTD: " + (ftdData ? ftdData.qty.toLocaleString() + " @ " + ftdData.date : "N/A"));
    } catch(e) { console.error("AMC FTD fetch greška:", e.message); }

    // ── 4. Shares Outstanding — companiesmarketcap.com ───────────────────────
    // data=[{d:unixTs, v:sharesCount}] — raw broj dionica
    let sharesOutstandCMC = null;
    try {
      const sharesHtml = await fetch(
        "https://companiesmarketcap.com/amc-entertainment/shares-outstanding/",
        { headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://companiesmarketcap.com/" },
          signal: AbortSignal.timeout(12000) }
      ).then(r => r.text());
      const sPairs = [...sharesHtml.matchAll(/"d":(\d+),"v":([0-9.]+)/g)]
        .map(m => ({ d: parseInt(m[1]), v: parseFloat(m[2]) }));
      if (sPairs.length > 0) {
        sharesOutstandCMC = Math.round(sPairs[sPairs.length - 1].v);
      }
      console.log("AMC Shares (CMC): " + (sharesOutstandCMC ? (sharesOutstandCMC/1e6).toFixed(2)+"M" : "N/A"));
    } catch(e) { console.error("AMC Shares fetch greška:", e.message); }

    // ── 5. Squeeze Score — Finviz + companiesmarketcap ───────────────────────
    const g = k => snap[k] ?? null;
    const parseVol = s => {
      if (!s) return 0; s = String(s).replace(/,/g,"");
      return s.endsWith("M")?parseFloat(s)*1e6 : s.endsWith("B")?parseFloat(s)*1e9 : s.endsWith("K")?parseFloat(s)*1e3 : parseFloat(s)||0;
    };
    const siPct  = parseFloat(snap["Short Float"]  ?? "0");
    const dtc    = parseFloat(snap["Short Ratio"]  ?? "0");
    const relVol = (() => { const v=parseVol(snap["Volume"]), a=parseVol(snap["Avg Volume"]); return a>0?v/a:1; })();

    const siScore    = siPct>=25?35:siPct>=20?28:siPct>=15?20:siPct>=10?12:siPct>=5?6:0;
    const dtcScore   = dtc>=7?25:dtc>=5?20:dtc>=3?14:dtc>=2?8:dtc>=1?4:0;
    const ctb        = ctbPct ?? 0;
    const avail      = ctbAvail ?? Infinity;
    const ctbScore   = ctb>=50?20:ctb>=20?15:ctb>=5?10:ctb>=2?6:ctb>=1?3:0;
    const availScore = avail<100000?12:avail<500000?9:avail<2000000?6:avail<5000000?3:0;
    const volScore   = relVol>=3?8:relVol>=2?5:relVol>=1.5?3:relVol>=1?1:0;

    const hasCTB    = ctbPct !== null;
    const hasAvail  = ctbAvail !== null;
    const rawScore  = siScore + dtcScore + ctbScore + availScore + volScore;
    const maxScore  = 35 + 25 + (hasCTB?20:0) + (hasAvail?12:0) + 8;
    // Normalizacija: ako nedostaju podaci, skaliraj na dostupni max
    const squeezeScore = maxScore >= 100
      ? Math.min(100, rawScore)
      : Math.min(100, Math.round(rawScore / maxScore * (maxScore < 68 ? 76 : 100)));
    const squeezeLabel = squeezeScore>=75?"🔴 Eksplozivan":squeezeScore>=55?"🟠 Visok":squeezeScore>=35?"🟡 Umjeren":"🟢 Nizak";
    const squeezeFactors = [
      { name:"Short Interest",   val:siPct.toFixed(1)+"%",                                                                    score:siScore,              max:35 },
      { name:"Days to Cover",    val:dtc.toFixed(1)+"d",                                                                      score:dtcScore,             max:25 },
      { name:"Cost to Borrow",   val:hasCTB  ? ctb.toFixed(2)+"%" : "N/A",                                                   score:hasCTB  ?ctbScore:null,  max:20 },
      { name:"Shares Available", val:hasAvail? (avail>=1e6?(avail/1e6).toFixed(1)+"M":(avail/1e3).toFixed(0)+"K") : "N/A",   score:hasAvail?availScore:null, max:12 },
      { name:"Rel. Volume",      val:relVol.toFixed(2)+"x",                                                                   score:volScore,             max:8  },
    ];
    const partial = !hasCTB || !hasAvail;

    const payload = {
      price: parseFloat(g("Price")??"0")||null, changePct:g("Change"), volume:g("Volume"), avgVolume:g("Avg Volume"), marketCap:g("Market Cap"),
      shortPctFloat:g("Short Float"), shortRatio:g("Short Ratio"), shortInterest:g("Short Interest"),
      sharesFloat:g("Shs Float"), sharesOutstand:g("Shs Outstand"),
      instOwn:g("Inst Own"), instTrans:g("Inst Trans"), insiderOwn:g("Insider Own"),
      pe:g("P/E"), epsNextY:g("EPS next Y"), high52w:g("52W High"), low52w:g("52W Low"),
      institutions, insiderActivity,
      ftd: ftdData, ftdHistory,
      sharesOutstandCMC,
      borrowFee: hasCTB ? { fee: ctbPct, available: ctbAvail ?? null } : null,
      shortInterestCE: null,
      squeeze: { score:squeezeScore, label:squeezeLabel, factors:squeezeFactors, partial },
      source: "finviz.com + companiesmarketcap.com",
      ts: new Date().toISOString()
    };
    _amcCache.data = payload;
    _amcCache.ts   = Date.now();
    console.log("AMC data osvježen — squeeze=" + squeezeScore + " si=" + siPct + "% ctb=" + (ctbPct?.toFixed(4)||"N/A") + "% dtc=" + dtc);
    return payload;
  } catch(e) {
    console.error("fetchAmcData greška:", e.message);
    return null;
  } finally {
    _amcFetchRunning = false;
  }
}

// ─── Squeeze Stocks config ─────────────────────────────────────────────────────
// AMC je i dalje praćen posebno (fetchAmcData). Ovi su za generički fetchSqueezeStock.
const SQUEEZE_STOCKS = [
  { ticker: "GME",  name: "GameStop Corp.",        cmcSlug: "gamestop",             emoji: "🎮" },
  { ticker: "KOSS", name: "Koss Corporation",       cmcSlug: "koss",                 emoji: "🎧" },
  { ticker: "BYND", name: "Beyond Meat Inc.",       cmcSlug: "beyond-meat",          emoji: "🌱" },
  { ticker: "UPST", name: "Upstart Holdings",       cmcSlug: "upstart",              emoji: "🤖" },
  { ticker: "BBAI", name: "BigBear.ai Holdings",    cmcSlug: "bigbear-ai",           emoji: "🐻" },
  { ticker: "SMCI", name: "Super Micro Computer",   cmcSlug: "super-micro-computer", emoji: "🖥️" },
];

const _squeezeCache = {};          // keyed by ticker → { data, ts }
const _squeezeFetchRunning = {};   // keyed by ticker → boolean

/**
 * Generički fetch za squeeze stock podatke (isti kao fetchAmcData, ali parametriziran).
 * @param {{ ticker: string, name: string, cmcSlug: string, emoji: string }} cfg
 */
async function fetchSqueezeStock(cfg) {
  const { ticker, cmcSlug } = cfg;
  // Ako je već u toku — čekaj do 25s na završetak umjesto da vratiš undefined
  if (_squeezeFetchRunning[ticker]) {
    for (let w = 0; w < 25; w++) {
      await new Promise(r => setTimeout(r, 1000));
      if (!_squeezeFetchRunning[ticker]) return _squeezeCache[ticker]?.data || null;
    }
    return _squeezeCache[ticker]?.data || null;
  }
  _squeezeFetchRunning[ticker] = true;
  try {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
    const FH = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://finviz.com/" };

    // 1. Finviz
    const fvHtml = await fetch(`https://finviz.com/quote?t=${ticker}&p=d`, { headers: FH, signal: AbortSignal.timeout(15000) }).then(r => r.text());
    const snap = {};
    const snapRe = /snapshot-td-label\"[^>]*>(?:<[^>]+>)*([^<]+?)(?:<\/[^>]+>)*<\/div><\/td>\s*<td[^>]*snapshot-td2[^>]*>[^<]*<div[^>]*snapshot-td-content[^>]*>(?:<[^>]+>)*([^<]+)/g;
    let sm;
    while ((sm = snapRe.exec(fvHtml)) !== null) snap[sm[1].trim()] = sm[2].trim();

    // 2. Cost to Borrow — companiesmarketcap.com
    let ctbPct = null, ctbAvail = null;
    try {
      const cmcHtml = await fetch(
        `https://companiesmarketcap.com/${cmcSlug}/cost-to-borrow/`,
        { headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://companiesmarketcap.com/" }, signal: AbortSignal.timeout(12000) }
      ).then(r => r.text());
      const vVals = [...cmcHtml.matchAll(/"v":([0-9.]+)/g)].map(m => parseFloat(m[1]));
      if (vVals.length > 0) ctbPct = vVals[vVals.length - 1] / 100;
      const data3M = cmcHtml.match(/\bdata3\s*=\s*\[([^\]]*)\]/);
      if (data3M) {
        const d3Vals = [...data3M[1].matchAll(/"v":"([0-9]+)"/g)].map(m => parseInt(m[1]));
        const nonZeroAvail = d3Vals.filter(v => v > 0);
        if (nonZeroAvail.length > 0) ctbAvail = nonZeroAvail[nonZeroAvail.length - 1];
      }
    } catch(e) { console.error(`${ticker} CTB fetch greška:`, e.message); }

    // 3. FTD — companiesmarketcap.com
    let ftdData = null;
    try {
      const ftdHtml = await fetch(
        `https://companiesmarketcap.com/${cmcSlug}/failure-to-deliver/`,
        { headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://companiesmarketcap.com/" }, signal: AbortSignal.timeout(12000) }
      ).then(r => r.text());
      const ftdPairs = [...ftdHtml.matchAll(/"d":(\d+),"v":([0-9.]+)/g)].map(m => ({ d: parseInt(m[1]), v: parseFloat(m[2]) }));
      if (ftdPairs.length > 0) {
        const nonZero = ftdPairs.filter(p => p.v > 0);
        if (nonZero.length > 0) {
          const latest = nonZero[nonZero.length - 1];
          const prev   = nonZero.length > 1 ? nonZero[nonZero.length - 2] : null;
          ftdData = { qty: Math.round(latest.v), date: new Date(latest.d * 1000).toISOString().slice(0, 10), change: prev ? Math.round(latest.v - prev.v) : null };
        }
      }
    } catch(e) { console.error(`${ticker} FTD fetch greška:`, e.message); }

    // 4. Squeeze Score
    const g = k => snap[k] ?? null;
    const parseVol = s => { if (!s) return 0; s = String(s).replace(/,/g,""); return s.endsWith("M")?parseFloat(s)*1e6:s.endsWith("B")?parseFloat(s)*1e9:s.endsWith("K")?parseFloat(s)*1e3:parseFloat(s)||0; };
    const siPct  = parseFloat(snap["Short Float"] ?? "0");
    const dtc    = parseFloat(snap["Short Ratio"] ?? "0");
    const relVol = (() => { const v=parseVol(snap["Volume"]), a=parseVol(snap["Avg Volume"]); return a>0?v/a:1; })();
    const siScore  = siPct>=25?35:siPct>=20?28:siPct>=15?20:siPct>=10?12:siPct>=5?6:0;
    const dtcScore = dtc>=7?25:dtc>=5?20:dtc>=3?14:dtc>=2?8:dtc>=1?4:0;
    const ctb      = ctbPct ?? 0;
    const avail    = ctbAvail ?? Infinity;
    const ctbScore = ctb>=50?20:ctb>=20?15:ctb>=5?10:ctb>=2?6:ctb>=1?3:0;
    const availScore = avail<100000?12:avail<500000?9:avail<2000000?6:avail<5000000?3:0;
    const volScore = relVol>=3?8:relVol>=2?5:relVol>=1.5?3:relVol>=1?1:0;
    const hasCTB   = ctbPct !== null;
    const hasAvail = ctbAvail !== null;
    const rawScore = siScore + dtcScore + ctbScore + availScore + volScore;
    const maxScore = 35 + 25 + (hasCTB?20:0) + (hasAvail?12:0) + 8;
    const squeezeScore = maxScore >= 100 ? Math.min(100, rawScore) : Math.min(100, Math.round(rawScore / maxScore * (maxScore < 68 ? 76 : 100)));
    const squeezeLabel = squeezeScore>=75?"🔴 Eksplozivan":squeezeScore>=55?"🟠 Visok":squeezeScore>=35?"🟡 Umjeren":"🟢 Nizak";

    const payload = {
      ticker, name: cfg.name, emoji: cfg.emoji,
      price: parseFloat(g("Price")??"0")||null, changePct: g("Change"),
      volume: g("Volume"), avgVolume: g("Avg Volume"), marketCap: g("Market Cap"),
      shortPctFloat: g("Short Float"), shortRatio: g("Short Ratio"), shortInterest: g("Short Interest"),
      sharesFloat: g("Shs Float"), sharesOutstand: g("Shs Outstand"),
      instOwn: g("Inst Own"), insiderOwn: g("Insider Own"),
      pe: g("P/E"), high52w: g("52W High"), low52w: g("52W Low"),
      ftd: ftdData,
      borrowFee: hasCTB ? { fee: ctbPct, available: ctbAvail ?? null } : null,
      squeeze: { score: squeezeScore, label: squeezeLabel, partial: !hasCTB || !hasAvail },
      squeezeFactors: [
        { name:"Short Interest",   val:siPct.toFixed(1)+"%",     score:siScore,                 max:35 },
        { name:"Days to Cover",    val:dtc.toFixed(1)+"d",       score:dtcScore,                max:25 },
        { name:"Cost to Borrow",   val:hasCTB?ctb.toFixed(2)+"%":"N/A",  score:hasCTB?ctbScore:null,  max:20 },
        { name:"Shares Available", val:hasAvail?(avail>=1e6?(avail/1e6).toFixed(1)+"M":(avail/1e3).toFixed(0)+"K"):"N/A", score:hasAvail?availScore:null, max:12 },
        { name:"Rel. Volume",      val:relVol.toFixed(2)+"x",    score:volScore,                max:8  },
      ],
      source: "finviz.com + companiesmarketcap.com",
      ts: new Date().toISOString()
    };
    if (!_squeezeCache[ticker]) _squeezeCache[ticker] = { data: null, ts: 0 };
    _squeezeCache[ticker].data = payload;
    _squeezeCache[ticker].ts   = Date.now();
    console.log(`${ticker} squeeze=${squeezeScore} si=${siPct}% ctb=${ctbPct?.toFixed(2)||"N/A"}% dtc=${dtc}`);
    return payload;
  } catch(e) {
    console.error(`fetchSqueezeStock(${ticker}) greška:`, e.message);
    return null;
  } finally {
    _squeezeFetchRunning[ticker] = false;
  }
}

// ─── Telegram helper (dashboard) ──────────────────────────────────────────────
async function tgDash(msg) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
    });
  } catch { /* tiho */ }
}

// ─── Short Squeeze preporuka — logika ─────────────────────────────────────────
function squeezeRecommendation(sq, borrow, si) {
  const score   = sq.score;
  const ctb     = borrow?.fee ?? 0;
  const dtc     = si?.daysToCover ?? 0;
  const avail   = borrow?.available ?? Infinity;
  const siPct   = si?.pct ?? 0;

  // Procjena hitnosti (koliko brzo može doći do squeeze-a)
  const urgency = (dtc >= 5 ? 2 : dtc >= 3 ? 1 : 0)
                + (ctb >= 10 ? 2 : ctb >= 3 ? 1 : 0)
                + (avail < 500000 ? 2 : avail < 2000000 ? 1 : 0)
                + (siPct >= 25 ? 1 : 0);
  // urgency: 0-7 → 0-2 low, 3-4 medium, 5-7 high

  let action = "", shares = "", options = "", risk = "";

  if (score >= 75) {
    // Eksplozivan
    if (urgency >= 5) {
      // Hitno — shorts teško pokriti, borrow skup
      action  = "⚡ AGRESIVAN ULAZ — setup je zreo";
      shares  = "60% u dionice (sigurna osnova, nema vremenskog ograničenja)";
      options = "40% u call opcije — ATM ili blago OTM, expiry 2–4 tjedna\n"
              + "   Npr. STRIKE najbliži tržišnoj cijeni, DTE 14-21 dana";
      risk    = "⚠️ Opcije mogu isteći bezvrijedne ako squeeze ne dođe u tom roku.\n"
              + "   Postavi stop na dionicama na -15% od ulaza.";
    } else {
      action  = "🔥 SNAŽAN SETUP — squeeze moguć uskoro";
      shares  = "70% u dionice";
      options = "30% u call opcije — malo OTM, expiry 3–6 tjedana";
      risk    = "⚠️ Zaštiti se stop-lossom na dionicama (-12%). Opcije = lottery ticket.";
    }
  } else if (score >= 55) {
    // Visok
    if (urgency >= 4) {
      action  = "📈 DOBAR SETUP — vrijedi pozicionirati se";
      shares  = "80% u dionice (primarni vozilo)";
      options = "20% u call opcije — ITM ili ATM, duži expiry 4–8 tjedana\n"
              + "   ITM opcije skuplje ali manje gube na vremenu (theta)";
      risk    = "⚠️ Squeeze može kasniti tjednima. Dionice = patiently hold.\n"
              + "   Opcije ne čekaj do zadnjeg tjedna — izađi na -50%.";
    } else {
      action  = "👀 PRATI SITUACIJU — ne ulaziš još, ali kupi dionice";
      shares  = "100% dionice ako ulazis — bez opcija dok se CTB ili DTC ne poboljša";
      options = "Opcije NISU preporučene na ovom nivou urgencije (theta te ubija u čekanju)";
      risk    = "⚠️ Postavi alert ako score poraste iznad 75 ili CTB skoči na 5%+.";
    }
  } else {
    action  = "🟡 SETUP NIJE SPREMAN — bez akcije";
    shares  = "Ne ulaziti u poziciju";
    options = "Opcije definitivno NE — prerano, skupo čekanje";
    risk    = "Prati daljnje promjene. Javi se kad score prijeđe 55.";
  }

  // Usporedba dionica vs opcija generalno
  const compare = score >= 55
    ? "\n\n<b>📊 Dionice vs Opcije:</b>\n"
    + "• <b>Dionice</b> — sporiji rast, ali bez expiry. Squeeze od 50% = +50%.\n"
    + "• <b>Call opcije</b> — leverage 5–10x, ali gube vrijednost svaki dan (theta).\n"
    + "  Squeeze od 50% = opcije mogu dati +300–500%, ali i 0 ako zakasni.\n"
    + "• <b>Kombinacija</b> (preporučena) — dionice kao baza, opcije kao katalizator."
    : "";

  return { action, shares, options, risk, compare };
}

// ─── AMC Squeeze Monitor — svakih 30 min (koristi fetchAmcData()) ─────────────
const _amcAlertState = { lastScore: 0, lastAlertTs: 0, lastLevel: "" };

async function amcSqueezeMonitor() {
  try {
    // Refetchaj svježe podatke (ili koristi cache ako je mlađi od 25 min)
    const cacheAge = Date.now() - _amcCache.ts;
    const d = (cacheAge < 25 * 60 * 1000 && _amcCache.data) ? _amcCache.data : await fetchAmcData();
    if (!d || !d.squeeze) return;

    const score  = d.squeeze.score;
    const level  = score >= 75 ? "explosive" : score >= 55 ? "high" : score >= 35 ? "moderate" : "low";
    const now    = Date.now();
    const cooldownMs = (level === "explosive" ? 3 : 6) * 3600 * 1000;
    const levelRaised = (level === "explosive" && _amcAlertState.lastLevel !== "explosive")
                     || (level === "high"      && ["moderate","low",""].includes(_amcAlertState.lastLevel));
    const cooldownExpired = (now - _amcAlertState.lastAlertTs) >= cooldownMs;

    if (score >= 55 && (levelRaised || cooldownExpired)) {
      const borrow = d.borrowFee;
      const si     = d.shortInterestCE;
      const sq     = { score, label: d.squeeze.label, factors: [] };
      const rec    = squeezeRecommendation(sq, borrow, si);
      const avail  = borrow?.available ?? Infinity;
      const availStr = avail===Infinity ? "N/A" : avail>=1e6 ? (avail/1e6).toFixed(1)+"M" : (avail/1e3).toFixed(0)+"K";
      const siPct  = si?.pct ?? parseFloat(d.shortPctFloat ?? "0");
      const dtc    = si?.daysToCover ?? parseFloat(d.shortRatio ?? "0");
      const ctb    = borrow?.fee ?? 0;
      const relVol = (() => {
        const pv = s => { if(!s)return 0; s=String(s).replace(/,/g,""); return s.endsWith("M")?parseFloat(s)*1e6:s.endsWith("B")?parseFloat(s)*1e9:s.endsWith("K")?parseFloat(s)*1e3:parseFloat(s)||0; };
        const v=pv(d.volume), a=pv(d.avgVolume); return a>0?v/a:1;
      })();

      const msg = "🧨 <b>AMC Short Squeeze Alert</b>\n"
        + "━━━━━━━━━━━━━━━━━━━━\n"
        + "<b>Score: " + score + "/100 — " + sq.label + "</b>\n\n"
        + "📊 <b>Ključni podaci:</b>\n"
        + "• Short Interest: " + siPct.toFixed(1) + "% float (" + ((si?.shares??0)/1e6).toFixed(1) + "M dionica)\n"
        + "• Days to Cover: " + dtc.toFixed(1) + " dana\n"
        + "• Cost to Borrow: " + ctb.toFixed(2) + "% godišnje\n"
        + "• Dostupno za short: " + availStr + " dionica\n"
        + "• Rel. Volume: " + relVol.toFixed(2) + "x prosjeka\n\n"
        + "🎯 <b>Akcija: " + rec.action + "</b>\n\n"
        + "🏦 <b>Dionice:</b>\n" + rec.shares + "\n\n"
        + "📈 <b>Opcije:</b>\n" + rec.options + "\n"
        + rec.compare
        + "\n\n⚠️ <b>Rizik:</b>\n" + rec.risk + "\n\n"
        + "⏰ " + new Date().toLocaleString("hr-HR", { timeZone: "Europe/Zagreb" }) + "\n"
        + "📡 Izvor: ChartExchange + Finviz";

      await tgDash(msg);
      _amcAlertState.lastScore   = score;
      _amcAlertState.lastAlertTs = now;
      _amcAlertState.lastLevel   = level;
      console.log("🧨 AMC Squeeze alert poslan — score " + score + ", level " + level);
    } else {
      console.log("📊 AMC Squeeze check: score=" + score + " level=" + level + " (bez alerta)");
    }
  } catch (e) {
    console.error("AMC Squeeze monitor greška:", e.message);
  }
}

// ─── Bot scheduler (svakih 5 min) ─────────────────────────────────────────────

let botRunning = false;
const _amcCache = { data: null, ts: 0 }; // server-side cache za AMC podatke (TTL 4h)
async function scheduledRun() {
  if (botRunning) return;
  botRunning = true;
  try { await botRun(); }
  catch (e) { console.error("Bot scheduler greška:", e.message); }
  finally { botRunning = false; }
}

server.listen(PORT, () => {
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`⚙️  Bot scheduler aktivan (svake 1 min)`);
  scheduledRun();
  setInterval(scheduledRun, 5 * 60 * 1000);

  // Fast breakout checker — svake minute provjerava live cijenu vs. trigger
  setInterval(async () => {
    try { await checkBreakouts(); }
    catch (e) { console.error("Breakout checker greška:", e.message); }
  }, 60 * 1000);

  // ─── BE-STOP fast monitor — svake 30 sekundi ──────────────────────────────
  // Reagira brzo na pozicije koje dođu na 50% TP-a i pomiče SL na break-even.
  // Ne čeka 5-min run() ciklus — PEPE situacija se više ne smije ponoviti.
  setInterval(async () => {
    try { await checkBeStopAll(); }
    catch (e) { console.error("BE-STOP monitor greška:", e.message); }
  }, 30 * 1000);

  // ─── AMC background fetch — odmah pri startu, pa svakih 30 min ─────────────
  // fetchAmcData() puni _amcCache; amcSqueezeMonitor() šalje Telegram ako treba
  setTimeout(async () => {
    await fetchAmcData();          // prvi fetch — popuni cache (~20-30s)
    await amcSqueezeMonitor();     // provjeri squeeze odmah
    setInterval(async () => {
      await fetchAmcData();
      await amcSqueezeMonitor();
    }, 30 * 60 * 1000);           // svakih 30 min
  }, 90 * 1000); // pričekaj 90s da se server stabilizira pri startu

  // ─── Squeeze Stocks background fetch — svakih 60 min (GME, KOSS, BYND, UPST, BBAI, SMCI) ──
  setTimeout(async () => {
    // Sekvencijalno da ne preopteretimo Finviz/CMC (svaki ~10s)
    for (const cfg of SQUEEZE_STOCKS) {
      try { await fetchSqueezeStock(cfg); } catch {}
      await new Promise(r => setTimeout(r, 10000));
    }
    setInterval(async () => {
      for (const cfg of SQUEEZE_STOCKS) {
        try { await fetchSqueezeStock(cfg); } catch {}
        await new Promise(r => setTimeout(r, 10000));
      }
    }, 60 * 60 * 1000); // svakih 60 min
  }, 45 * 1000); // pričekaj 45s (nakon AMC fetcha)

});
