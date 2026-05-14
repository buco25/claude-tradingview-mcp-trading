/**
 * Trading Bot — 4-Portfolio Mode
 *
 * Portfolio 1 — EMA+RSI    → 1H  | SL 2%  / TP 4%
 * Portfolio 2 — MEGA       → 15m | SL 2%  / TP 4%
 * Portfolio 3 — SYNAPSE-7  → 15m | SL 2%  / TP 4%
 * Portfolio 4 — ULTRA      → 1H  | Per-simbol SL/TP (ATR tier) | 50x (BTC 75x) | rizik 1.5% banke po tradeu
 *
 * Risk-based sizing: margin = equity × 1.5% | notional = margin × 50x (BTC 75x)
 *   Tier 1 (BTC/ETH/SOL/LINK/XRP): SL 1.5% / TP 4.0% (RR 1:2.67)
 *   Tier 2 (DOGE/NEAR/ADA/SUI/TAO/HYPE/PEPE/APT/SEI): SL 2.0% / TP 4.5% (RR 1:2.25)
 *   Tier 3 (ENA): SL 2.5% / TP 5.5% (RR 1:2.20)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

// ─── Config ────────────────────────────────────────────────────────────────────

const TIMEFRAME     = "1H";
const LEVERAGE      = 50;     // 50x default → SL 1.5% = 75% margine (više prostora za šum)
const BTC_LEVERAGE  = 75;    // BTC posebno — 75x
const START_CAPITAL = 1000;   // po portfoliju
const RISK_PCT      = 1.5;    // % banke koji rizikaš po tradeu (= veličina uloga/margine)
const SL_PCT        = 1.5;    // fallback SL % (Tier 1) — override per-simbol u symbol_sltp
const TP_PCT        = 4.0;    // fallback TP % (Tier 1) — override per-simbol u symbol_sltp
const MAX_TRADES_PER_DAY = 100;
const MAX_OPEN_PER_PORTFOLIO = 8;  // max otvorenih pozicija po portfoliju (+ BTC bonus slot)

// ─── ULTRA strategija — zaštitni parametri ────────────────────────────────────
const LONG_ONLY      = false;         // SHORT dozvoljeni kada BTC regime BEAR/NEUTRAL
const ADX_MIN        = 30;            // ADX prag — bazni (dinamički raste ako WR pada)
const SL_COOLDOWN_MS = 4 * 60 * 60 * 1000;  // 4h cooldown po simbolu nakon SL-a

// ─── Trailing stop — aktivira se nakon BE-STOP ───────────────────────────────
const TRAIL_ACTIVATE_PCT = 1.5;  // % profita za aktivaciju traila (nakon BE)
const TRAIL_SL_PCT       = 0.8;  // trail SL X% ispod/iznad peak-a

// ─── Ekonomski kalendar ───────────────────────────────────────────────────────
const ECON_BLOCK_MIN = 15;  // blokiraj ±15min oko HIGH impact USD eventa

// In-memory mapa: symbol → timestamp zadnjeg SL-a
const symbolSlCooldown = new Map();

// ─── 1. DINAMIČKI ADX — raste kad je WR loš ──────────────────────────────────
// Čita zadnjih 10 trejdova iz CSV-a i računa trenutni WR.
// WR < 35% → ADX +5 | WR < 25% → ADX +10 + pauza 2h
const DYN_ADX_LOOKBACK  = 10;   // zadnjih N trejdova za WR procjenu
const DYN_ADX_BOOST_1   =  5;   // +5 kad WR < 35%
const DYN_ADX_BOOST_2   = 10;   // +10 kad WR < 25%
const DYN_PAUSE_WR      = 20;   // ispod ovog WR% → 2h pauza
const DYN_PAUSE_MS      = 2 * 60 * 60 * 1000;

let _dynPauseUntil = 0;  // in-memory pauza (reset na restart)

function getDynamicAdx(pid) {
  const f = csvFilePath(pid);
  if (!existsSync(f)) return ADX_MIN;
  try {
    const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
    const lines = readFileSync(f, "utf8").trim().split("\n");
    // Samo današnji trejdovi — svaki dan kreće od nule (nema feedback loopa iz prošlosti)
    const exits = lines.slice(1)
      .filter(l => l.startsWith(today) && (l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT")));
    if (exits.length < 3) return ADX_MIN;  // manje od 3 trejda danas → normalni ADX
    const wins = exits.filter(l => parseFloat(l.split(",")[9] || 0) > 0).length;
    const wr   = (wins / exits.length) * 100;
    if (wr < DYN_PAUSE_WR) {
      if (_dynPauseUntil < Date.now()) {
        _dynPauseUntil = Date.now() + DYN_PAUSE_MS;
        console.log(`  ⚠️  [DYN] WR=${wr.toFixed(0)}% (danas: ${exits.length} trejdova) — 2h pauza aktivirana`);
      }
    }
    if (wr < 25) return ADX_MIN + DYN_ADX_BOOST_2;  // ADX 40
    if (wr < 35) return ADX_MIN + DYN_ADX_BOOST_1;  // ADX 35
    return ADX_MIN;                                   // ADX 30 (normalno)
  } catch { return ADX_MIN; }
}

// ─── 2. SYMBOL BLACKLIST — 3 uzastopna SL → 24h ban ─────────────────────────
const BLACKLIST_LOSSES   = 3;    // uzastopnih SL → blacklist
const BLACKLIST_HOURS    = 24;   // sati bana
const getBlacklistFile   = () => `${DATA_DIR}/symbol_blacklist.json`;

function loadBlacklist() {
  try { return existsSync(getBlacklistFile()) ? JSON.parse(readFileSync(getBlacklistFile(), "utf8")) : {}; }
  catch { return {}; }
}
function saveBlacklist(bl) {
  try { writeFileSync(getBlacklistFile(), JSON.stringify(bl, null, 2)); } catch {}
}

function isBlacklisted(symbol) {
  const bl = loadBlacklist();
  const entry = bl[symbol];
  if (!entry) return false;
  if (Date.now() > entry.until) {
    delete bl[symbol];
    saveBlacklist(bl);
    console.log(`  ✅ [BLACKLIST] ${symbol} — ban istekao, vraćen na listu`);
    return false;
  }
  const remainH = ((entry.until - Date.now()) / 3600000).toFixed(1);
  console.log(`  🚫 [BLACKLIST] ${symbol} — na crnoj listi još ${remainH}h (${entry.reason})`);
  return true;
}

async function recordSymbolSl(pid, symbol) {
  const f = csvFilePath(pid);
  if (!existsSync(f)) return;
  try {
    const lines = readFileSync(f, "utf8").trim().split("\n");
    const symExits = lines.slice(1)
      .filter(l => (l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT")) && l.split(",")[2] === symbol)
      .slice(-BLACKLIST_LOSSES);
    if (symExits.length < BLACKLIST_LOSSES) return;
    const allLoss = symExits.every(l => parseFloat(l.split(",")[9] || 0) < 0);
    if (!allLoss) return;
    const bl    = loadBlacklist();
    const until = Date.now() + BLACKLIST_HOURS * 3600000;
    const reason = `${BLACKLIST_LOSSES} uzastopna SL`;
    bl[symbol]  = { until, reason, bannedAt: new Date().toISOString() };
    saveBlacklist(bl);
    const untilStr = new Date(until).toLocaleTimeString("hr-HR");
    console.log(`  🚫 [BLACKLIST] ${symbol} — ${reason} → ban 24h (do ${untilStr})`);
    await tg(`🚫 <b>BLACKLIST: ${symbol}</b>\n${reason} zaredom → ban 24h\nDo: ${new Date(until).toISOString().slice(11,16)} UTC`);
  } catch(e) { console.log(`  ⚠️  recordSymbolSl error: ${e.message}`); }
}

// ─── 3. MARKET REGIME — BTC 4H trend ─────────────────────────────────────────
// Ako BTC nije u jasnom BULL trendu na 4H → preskačemo sve LONG ulaze
// BULL = 6Sc ≥ 4/6 parova UP + cijena > EMA55
// NEUTRAL/BEAR = čekamo bolji trenutak

let _regimeCache = { regime: "UNKNOWN", ts: 0 };
const REGIME_TTL = 15 * 60 * 1000;  // osvježi svakih 15min

export async function getBtcRegimeExport() { return getBtcRegime(); }

async function getBtcRegime() {
  if (Date.now() - _regimeCache.ts < REGIME_TTL) return _regimeCache.regime;
  try {
    const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=4H&limit=100`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code !== "00000" || !d.data?.length) return "UNKNOWN";

    const candles = d.data.map(k => ({
      close: parseFloat(k[4]), high: parseFloat(k[2]), low: parseFloat(k[3]),
    })).reverse();
    const closes = candles.map(c => c.close);
    const n = closes.length - 1;

    // EMA55
    const k55 = 2/(55+1);
    let e55 = closes.slice(0,55).reduce((a,b)=>a+b,0)/55;
    for (let i=55; i<=n; i++) e55 = closes[i]*k55 + e55*(1-k55);

    // 6-Scale EMA parovi
    const emaPairs = [[3,11],[7,15],[13,21],[19,29],[29,47],[45,55]];
    let upPairs = 0;
    for (const [a,b] of emaPairs) {
      const ka=2/(a+1), kb=2/(b+1);
      let ea=closes.slice(0,a).reduce((s,v)=>s+v,0)/a;
      let eb=closes.slice(0,b).reduce((s,v)=>s+v,0)/b;
      for (let i=Math.max(a,b); i<=n; i++) {
        ea = closes[i]*ka + ea*(1-ka);
        eb = closes[i]*kb + eb*(1-kb);
      }
      if (ea > eb) upPairs++;
    }

    const price = closes[n];
    const regime = (upPairs >= 4 && price > e55) ? "BULL"
                 : (upPairs <= 2 && price < e55) ? "BEAR"
                 : "NEUTRAL";

    _regimeCache = { regime, ts: Date.now() };
    console.log(`  📊 [REGIME] BTC 4H: ${regime} | 6Sc=${upPairs}/6 | Price${price>e55?">":"<"}EMA55`);
    return regime;
  } catch(e) {
    console.log(`  ⚠️  [REGIME] Greška: ${e.message}`);
    return "UNKNOWN";
  }
}

// ─── Funding Rate gate + Trend tracking ──────────────────────────────────────
const _frCache = {};
const FR_TTL   = 15 * 60 * 1000;
const FR_LONG_BLOCK = 0.05;  // % — blokira LONG ako funding > ovo
const FR_WARN       = 0.02;  // % — samo log

// Prati zadnja 3 očitanja funding ratea po simbolu
const _frHistory = new Map();
function recordFundingTrend(symbol, rate) {
  const hist = _frHistory.get(symbol) || [];
  hist.push(rate);
  if (hist.length > 3) hist.shift();
  _frHistory.set(symbol, hist);
  return hist;
}
function isFundingTrendRising(symbol) {
  const hist = _frHistory.get(symbol) || [];
  if (hist.length < 3) return false;
  // Svaka nova vrijednost viša od prethodne I zadnja > 0.02%
  return hist[0] < hist[1] && hist[1] < hist[2] && hist[2] > 0.02;
}

// ─── VWAP (Volume Weighted Average Price) ────────────────────────────────────
export function calcVWAP(candles, periods = 96) {
  const slice = candles.slice(-periods);
  let sumPV = 0, sumV = 0;
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1;
    sumPV += typical * vol;
    sumV  += vol;
  }
  return sumV > 0 ? sumPV / sumV : null;
}

// ─── Open Interest promjena — wrapper koji koristi postojeći getOpenInterest ──
async function getOiChange(symbol) {
  try {
    const r = await getOpenInterest(symbol);
    const changePct = r.oi > 0 && r.prev > 0 ? (r.oi - r.prev) / r.prev * 100 : 0;
    return {
      changePct:  parseFloat(changePct.toFixed(2)),
      rising:     r.trend === 'RASTE',
      falling:    r.trend === 'PADA',
      confirmed:  r.trend !== 'PADA',
    };
  } catch { return { changePct: 0, rising: false, falling: false, confirmed: true }; }
}

// ─── BTC/ETH Divergencija ─────────────────────────────────────────────────────
let _btcEthDivCache = { diverging: false, corr: 1, ts: 0 };
const BTCETH_DIV_TTL = 5 * 60 * 1000;
async function checkBtcEthDivergence() {
  if (Date.now() - _btcEthDivCache.ts < BTCETH_DIV_TTL) return _btcEthDivCache;
  try {
    const [btcC, ethC] = await Promise.all([
      fetchCandles("BTCUSDT", "15m", 25),
      fetchCandles("ETHUSDT", "15m", 25),
    ]);
    const n = Math.min(btcC.length, ethC.length, 20);
    const btcR = [], ethR = [];
    for (let i = 1; i <= n; i++) {
      const bi = btcC.length - n + i - 1, bj = btcC.length - n + i - 2;
      const ei = ethC.length - n + i - 1, ej = ethC.length - n + i - 2;
      if (bj >= 0 && ej >= 0 && btcC[bj].close > 0 && ethC[ej].close > 0) {
        btcR.push((btcC[bi].close - btcC[bj].close) / btcC[bj].close);
        ethR.push((ethC[ei].close - ethC[ej].close) / ethC[ej].close);
      }
    }
    if (btcR.length < 5) return _btcEthDivCache;
    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const mB = mean(btcR), mE = mean(ethR);
    const num = btcR.reduce((s, v, i) => s + (v - mB) * (ethR[i] - mE), 0);
    const den = Math.sqrt(
      btcR.reduce((s, v) => s + (v - mB) ** 2, 0) *
      ethR.reduce((s, v) => s + (v - mE) ** 2, 0)
    );
    const corr = den > 0 ? num / den : 1;
    _btcEthDivCache = { diverging: corr < 0.4, corr: parseFloat(corr.toFixed(2)), ts: Date.now() };
    if (_btcEthDivCache.diverging) console.log(`  ⚡ [DIV] BTC/ETH korelacija: ${corr.toFixed(2)} < 0.4 — tržište divergira`);
    return _btcEthDivCache;
  } catch { return { diverging: false, corr: 1, ts: Date.now() }; }
}

async function getFundingRate(symbol) {
  const cached = _frCache[symbol];
  if (cached && Date.now() - cached.ts < FR_TTL) return cached.rate;
  try {
    const url = `${BITGET.baseUrl}/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=USDT-FUTURES`;
    const r = await fetch(url);
    const d = await r.json();
    const rate = parseFloat(d?.data?.[0]?.fundingRate || 0) * 100;
    _frCache[symbol] = { rate, ts: Date.now() };
    return rate;
  } catch { return 0; }
}

export async function getAllFundingRates(symbols) {
  const result = {};
  await Promise.all(symbols.map(async sym => {
    result[sym] = await getFundingRate(sym);
  }));
  return result;
}

// ─── Volume Anomaly gate ──────────────────────────────────────────────────────
const VOL_LOOKBACK = 20;
const VOL_LOW_MULT = 0.3;
const VOL_HIGH_MULT = 2.0;

function checkVolumeAnomaly(candles) {
  // Koristimo zadnju ZATVORENU svjeću (index -2), ne posljednju koja se još formira!
  // Aktivna svjeća uvijek ima parcijalni volumen → krivo bi zaključivala "nizak volumen"
  if (candles.length < VOL_LOOKBACK + 3) return { ok: true, ratio: 1, label: 'N/A' };
  const vols = candles.slice(-VOL_LOOKBACK - 2, -2).map(c => c.volume);
  if (vols.length < 5) return { ok: true, ratio: 1, label: 'N/A' };
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  const cur = candles[candles.length - 2].volume;  // zadnja zatvorena
  const ratio = avg > 0 ? cur / avg : 1;
  return {
    ok: ratio >= VOL_LOW_MULT,
    high: ratio >= VOL_HIGH_MULT,
    ratio: parseFloat(ratio.toFixed(2)),
    label: ratio < VOL_LOW_MULT ? 'NIZAK' : ratio > VOL_HIGH_MULT ? 'VISOK' : 'NORMALAN',
  };
}

// ─── Deribit Put/Call Ratio ───────────────────────────────────────────────────
// P/C > 1.5 = tržište kupuje zaštitu od pada (strah) = potencijalni bottom
// P/C < 0.5 = previše calls = euforija = potencijalni vrh
let _pcCache = { btc: null, eth: null, ts: 0 };
const PC_TTL = 30 * 60 * 1000;

async function _fetchDeribitPC(currency) {
  const url = `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
  const d = await fetch(url, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
  const opts = d?.result ?? [];
  let callOI = 0, putOI = 0;
  for (const o of opts) {
    if (!o.open_interest) continue;
    if (o.instrument_name.endsWith('-C')) callOI += o.open_interest;
    else if (o.instrument_name.endsWith('-P')) putOI  += o.open_interest;
  }
  const ratio = callOI > 0 ? parseFloat((putOI / callOI).toFixed(3)) : null;
  const sentiment = ratio === null ? 'N/A'
    : ratio > 1.5 ? 'FEAR'       // puno puta = zaštita od pada
    : ratio > 1.0 ? 'BEARISH'
    : ratio > 0.7 ? 'NEUTRAL'
    : ratio > 0.5 ? 'BULLISH'
    : 'GREED';                    // malo puta = euforija
  return { ratio, callOI: Math.round(callOI), putOI: Math.round(putOI), sentiment };
}

export async function getDeribitPutCall() {
  if (_pcCache.btc !== null && Date.now() - _pcCache.ts < PC_TTL) return _pcCache;
  try {
    const [btc, eth] = await Promise.all([_fetchDeribitPC('BTC'), _fetchDeribitPC('ETH')]);
    _pcCache = { btc, eth, ts: Date.now() };
    return _pcCache;
  } catch(e) {
    console.log(`  ⚠️  [DERIBIT P/C] ${e.message}`);
    return _pcCache;
  }
}

// ─── Liquidation Risk Score ───────────────────────────────────────────────────
// Bez vanjskog API — procjena iz funding rate + OI promjene + price action
// Score 0-100: >70 = visok rizik likvidacija (kaskadni padovi mogući)
let _liqCache = { scores: {}, overall: null, ts: 0 };
const LIQ_TTL = 10 * 60 * 1000;

export async function getLiquidationRisk(symbols) {
  if (_liqCache.overall !== null && Date.now() - _liqCache.ts < LIQ_TTL) return _liqCache;
  try {
    const scores = {};
    let totalScore = 0, count = 0;

    await Promise.all(symbols.slice(0, 10).map(async sym => {
      try {
        // Funding rate — visok pozitivan = previše longova = liquidation risk
        const frUrl = `${BITGET.baseUrl}/api/v2/mix/market/current-fund-rate?symbol=${sym}&productType=USDT-FUTURES`;
        const frD   = await fetch(frUrl).then(r => r.json());
        const fr    = parseFloat(frD?.data?.[0]?.fundingRate || 0) * 100;

        // OI — dohvati 2 zadnja perioda da vidiš promjenu
        const oiUrl = `${BITGET.baseUrl}/api/v2/mix/market/open-interest?symbol=${sym}&productType=USDT-FUTURES`;
        const oiD   = await fetch(oiUrl).then(r => r.json());
        const oi    = parseFloat(oiD?.data?.[0]?.openInterestList?.[0]?.size || 0);

        // Liquidation score po simbolu (0-100):
        // FR > 0.05% = +30pts, FR > 0.03% = +15pts
        // FR < -0.02% = -10pts (shorters at risk, ali za LONG strategy manji rizik)
        let score = 50;
        if (fr > 0.05)       score += 30;
        else if (fr > 0.03)  score += 15;
        else if (fr < -0.02) score -= 10;

        scores[sym] = { score: Math.max(0, Math.min(100, Math.round(score))), fr, oi };
        totalScore += scores[sym].score; count++;
      } catch { }
    }));

    const overall = count > 0 ? Math.round(totalScore / count) : null;
    const risk    = overall === null ? 'N/A'
      : overall > 70 ? 'HIGH'
      : overall > 50 ? 'MEDIUM'
      : 'LOW';

    _liqCache = { scores, overall, risk, ts: Date.now() };
    return _liqCache;
  } catch(e) {
    console.log(`  ⚠️  [LIQ RISK] ${e.message}`);
    return _liqCache;
  }
}

// ─── SP500 / Risk-Off gate ────────────────────────────────────────────────────
// Yahoo Finance (ES=F futures) — blokira LONG ako S&P500 padne > 1% u zadnjem 4H
let _sp500Cache = { change4h: null, regime: 'UNKNOWN', ts: 0 };
const SP500_TTL        = 15 * 60 * 1000;  // 15 min cache
const SP500_BLOCK_DROP = -1.0;             // % pada u 4H → RISK_OFF → blokira LONG

export async function getSp500Data() {
  if (_sp500Cache.change4h !== null && Date.now() - _sp500Cache.ts < SP500_TTL) {
    return _sp500Cache;
  }
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/ES=F?interval=4h&range=3d';
    const r   = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d   = await r.json();
    const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const valid  = closes.filter(c => c != null);
    if (valid.length < 2) throw new Error('Nema dovoljno podataka');
    const last = valid[valid.length - 1];
    const prev = valid[valid.length - 2];
    const change4h = parseFloat(((last - prev) / prev * 100).toFixed(3));
    const regime   = change4h < SP500_BLOCK_DROP ? 'RISK_OFF'
                   : change4h >  0.5             ? 'RISK_ON'
                   : 'NEUTRAL';
    _sp500Cache = { change4h, regime, last: parseFloat(last.toFixed(2)), ts: Date.now() };
    return _sp500Cache;
  } catch(e) {
    console.log(`  ⚠️  [SP500] ${e.message}`);
    return { ..._sp500Cache, ts: Date.now() };  // vrati stari cache
  }
}

// ─── Korelacijska matrica ─────────────────────────────────────────────────────
// Pearson korelacija 1H returna između svih simbola
// avgCorr > 0.85 = visoka korelacija = koncentrirani rizik
let _corrCache = { avgCorr: null, matrix: {}, syms: [], ts: 0 };
const CORR_TTL = 20 * 60 * 1000;  // 20 min cache

function _pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const ax = a.slice(-n), bx = b.slice(-n);
  const ma = ax.reduce((s, v) => s + v, 0) / n;
  const mb = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0, da2 = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - ma, db = bx[i] - mb;
    num += da * db; da2 += da * da; db2 += db * db;
  }
  return (da2 && db2) ? num / Math.sqrt(da2 * db2) : 0;
}

export async function calcSymbolCorrelation(symbols) {
  if (_corrCache.avgCorr !== null && Date.now() - _corrCache.ts < CORR_TTL) {
    return _corrCache;
  }
  const returnsMap = {};
  await Promise.all(symbols.map(async sym => {
    try {
      const url = `${BITGET.baseUrl}/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1H&limit=25`;
      const d   = await fetch(url).then(r => r.json());
      if (d.code !== '00000' || !d.data?.length) return;
      const closes  = d.data.map(k => parseFloat(k[4]));
      const returns = [];
      for (let i = 1; i < closes.length; i++) {
        returns.push((closes[i] - closes[i-1]) / closes[i-1]);
      }
      returnsMap[sym] = returns;
    } catch { }
  }));

  const syms = Object.keys(returnsMap);
  if (syms.length < 2) return { avgCorr: null, matrix: {}, syms, ts: Date.now() };

  let total = 0, count = 0;
  const matrix = {};
  for (let i = 0; i < syms.length; i++) {
    matrix[syms[i]] = {};
    for (let j = 0; j < syms.length; j++) {
      if (i === j) { matrix[syms[i]][syms[j]] = 1; continue; }
      const r = parseFloat(_pearson(returnsMap[syms[i]], returnsMap[syms[j]]).toFixed(2));
      matrix[syms[i]][syms[j]] = r;
      if (j > i) { total += r; count++; }
    }
  }
  const avgCorr = count > 0 ? parseFloat((total / count).toFixed(2)) : null;
  _corrCache = { avgCorr, matrix, syms, ts: Date.now() };
  return _corrCache;
}

// ─── Session Filter ───────────────────────────────────────────────────────────
// Crypto dead zone: 01:00–06:00 UTC = azijska mirna sesija, niski volumen, choppy
// NY sesija (13-21 UTC) i London (08-16 UTC) = visoki volumen, bolji trendovi
const SESSION_DEAD_START = 1;   // UTC sat (inclusive)
const SESSION_DEAD_END   = 6;   // UTC sat (exclusive) — 01:00-05:59 UTC blokiran

export function getSessionInfo() {
  const h = new Date().getUTCHours();
  const dead = h >= SESSION_DEAD_START && h < SESSION_DEAD_END;
  const session = h >= 13 && h < 21 ? 'NY'
    : h >= 8  && h < 16 ? 'London'
    : h >= 0  && h < 8  ? 'Asia'
    : 'Post-NY';
  const quality = dead ? 'DEAD' : (h >= 13 && h < 21) ? 'PRIME' : (h >= 8 && h < 16) ? 'GOOD' : 'LOW';
  return { dead, session, quality, utcHour: h };
}

// ─── ATR Trend ────────────────────────────────────────────────────────────────
// Mjeri je li volatilnost RASTE, PADA ili NORMALNA
// Uspoređuje zadnji ATR14 s prosjekom ATR-a u prethodnih 14 perioda
export function calcAtrTrend(candles, atrLen = 14, lookback = 14) {
  if (candles.length < atrLen + lookback + 5) return { trend: 'N/A', ratio: 1, sizeMult: 1 };

  function atrOf(slice) {
    const trs = [];
    for (let i = 1; i < slice.length; i++) {
      const h = slice[i].high, l = slice[i].low, pc = slice[i-1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const vals = trs.slice(-atrLen);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  const currentAtr = atrOf(candles.slice(-(atrLen + 2)));
  const pastAtrs = [];
  for (let i = lookback; i >= 1; i--) {
    const sl = candles.slice(-(atrLen + i + 2), -i);
    if (sl.length >= atrLen + 1) pastAtrs.push(atrOf(sl));
  }
  if (!pastAtrs.length) return { trend: 'N/A', ratio: 1, sizeMult: 1 };

  const avgAtr  = pastAtrs.reduce((a, b) => a + b, 0) / pastAtrs.length;
  const ratio   = avgAtr > 0 ? currentAtr / avgAtr : 1;
  const trend   = ratio > 1.6 ? 'EXPANDING' : ratio < 0.65 ? 'CONTRACTING' : 'NORMAL';
  // Veća volatilnost → manji size (štiti od wide stops)
  const sizeMult = trend === 'EXPANDING' ? 0.7 : 1.0;

  return {
    trend,
    ratio: parseFloat(ratio.toFixed(2)),
    sizeMult,
    currentAtr: parseFloat(currentAtr.toFixed(8)),
    avgAtr: parseFloat(avgAtr.toFixed(8)),
  };
}

// ─── 1H Trend Filter ─────────────────────────────────────────────────────────
// Viši timeframe trend — dozvoljava samo LONG kad je 1H bull, SHORT kad je 1H bear

export async function calcTrend1H(symbol) {
  try {
    const candles = await fetchCandles(symbol, '1H', 30);
    const closes  = candles.map(c => c.close);
    const ema20   = calcEMA(closes, 20);
    const ema50   = calcEMA(closes, 50);
    const last    = closes[closes.length - 1];
    if (!ema20) return { trend: 'UNKNOWN', last, ema20: null, ema50: null };
    const trend = last > ema20 ? 'BULL' : 'BEAR';
    return { trend, last, ema20: parseFloat(ema20.toFixed(6)), ema50: ema50 ? parseFloat(ema50.toFixed(6)) : null };
  } catch {
    return { trend: 'UNKNOWN', last: 0, ema20: null, ema50: null };
  }
}

// ─── Ekonomski kalendar ───────────────────────────────────────────────────────
// Forex Factory tjedni kalendar — blokira ±15min oko HIGH impact USD eventa

let _econCache = null;
let _econCacheTs = 0;

export async function getEconEvents() {
  const now = Date.now();
  if (_econCache && now - _econCacheTs < 60 * 60 * 1000) return _econCache;
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json',
      { headers: { 'User-Agent': 'TradingBot/1.0' }, signal: AbortSignal.timeout(5000) });
    const all = await r.json();
    _econCache = all.filter(e => e.impact === 'High' && e.country === 'USD');
    _econCacheTs = now;
    return _econCache;
  } catch {
    return _econCache || [];
  }
}

export function isEconBlocked(events) {
  if (!events || !events.length) return { blocked: false, event: null };
  const now = Date.now();
  const blockMs = ECON_BLOCK_MIN * 60 * 1000;
  for (const ev of events) {
    const evTime = new Date(ev.date).getTime();
    if (Math.abs(now - evTime) < blockMs) {
      const minLeft = Math.round((evTime - now) / 60000);
      return { blocked: true, event: ev.title, minLeft };
    }
  }
  // Provjeri sljedeći event — upozorenje 30min unaprijed
  const upcoming = events
    .filter(e => new Date(e.date).getTime() > now)
    .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  return { blocked: false, event: null, next: upcoming || null };
}

// ─── Daily P&L Budget ─────────────────────────────────────────────────────────
const DAILY_LOSS_LIMIT_PCT = 3;   // 3% od stvarnog Bitget equityja
const DAILY_LOSS_LIMIT_MIN = 20;  // minimalni floor ($20) ako equity nije dostupan
const DAILY_WARN_PCT       = 80;

function getDailyPnl(pid) {
  const f = csvFilePath(pid);
  if (!existsSync(f)) return 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    return lines.slice(1)
      .filter(l => (l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT")) && l.startsWith(today))
      .reduce((sum, l) => sum + parseFloat(l.split(",")[9] || 0), 0);
  } catch { return 0; }
}

export function getDailyPnlExport(pid) { return getDailyPnl(pid); }

// ─── Long/Short Ratio (Binance Futures — public endpoint, no auth) ────────────
let _lsCache = { data: null, ts: 0 };
const LS_TTL = 5 * 60 * 1000;
export async function getLongShortRatio(symbol = "BTCUSDT") {
  if (Date.now() - _lsCache.ts < LS_TTL && _lsCache.data) return _lsCache.data;
  try {
    // Binance public futures L/S ratio — global accounts, 1h period
    const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=2`;
    const r = await fetch(url);
    const d = await r.json();
    if (!Array.isArray(d) || d.length === 0) return null;
    const latest = d[d.length - 1];
    const prev   = d.length > 1 ? d[d.length - 2] : null;
    const longRatio  = parseFloat(latest.longAccount) * 100;
    const shortRatio = parseFloat(latest.shortAccount) * 100;
    const prevLong   = prev ? parseFloat(prev.longAccount) * 100 : longRatio;
    const trend = longRatio > prevLong + 1 ? "RASTE" : longRatio < prevLong - 1 ? "PADA" : "STABILAN";
    const data = { longRatio: longRatio.toFixed(1), shortRatio: shortRatio.toFixed(1), trend };
    _lsCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    return null;
  }
}

// ─── BTC Perp Basis (Futures premium vs Spot) ────────────────────────────────
let _basisCache = { data: null, ts: 0 };
const BASIS_TTL = 5 * 60 * 1000;
export async function getBtcPerpBasis() {
  if (Date.now() - _basisCache.ts < BASIS_TTL && _basisCache.data) return _basisCache.data;
  try {
    const [spotR, futR] = await Promise.all([
      fetch('https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT').then(r => r.json()),
      fetch('https://api.bitget.com/api/v2/mix/market/tickers?symbol=BTCUSDT&productType=USDT-FUTURES').then(r => r.json()),
    ]);
    const spot = parseFloat(spotR?.data?.[0]?.lastPr || 0);
    const fut  = parseFloat(futR?.data?.[0]?.lastPr || 0);
    if (!spot || !fut) return null;
    const basis    = ((fut - spot) / spot) * 100;
    const annualized = basis * (365 / 1) * (1 / 8); // rough annualized (8h funding cycle proxy)
    const sentiment = basis > 0.05 ? 'CONTANGO' : basis < -0.05 ? 'BACKWARDATION' : 'FLAT';
    const data = { spot: spot.toFixed(2), futures: fut.toFixed(2), basis: basis.toFixed(4), sentiment };
    _basisCache = { data, ts: Date.now() };
    return data;
  } catch { return null; }
}

// ─── Altcoin Season Index (CoinGecko — free, no auth) ─────────────────────────
let _altSeasonCache = { data: null, ts: 0 };
const ALT_SEASON_TTL = 60 * 60 * 1000; // 1h — CoinGecko rate limit
export async function getAltcoinSeason() {
  if (Date.now() - _altSeasonCache.ts < ALT_SEASON_TTL && _altSeasonCache.data) return _altSeasonCache.data;
  try {
    // BTC dominance iz CoinGecko /global — pouzdan, bez rate-limit problema
    // BTC dom < 48% = altcoin sezona, > 58% = BTC sezona
    const g = await fetch('https://api.coingecko.com/api/v3/global', { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    const btcDom = g?.data?.market_cap_percentage?.btc;
    if (btcDom == null) return null;

    // Score: dom 40% → 100, dom 65% → 0 (linearna interpolacija)
    const score = Math.round(Math.max(0, Math.min(100, (65 - btcDom) / 25 * 100)));
    const season = score >= 75 ? 'ALT SEASON' : score >= 50 ? 'ALT FAVORED' : score >= 25 ? 'BTC FAVORED' : 'BTC SEASON';
    const data = { score, season, btcDom: btcDom.toFixed(1) };
    _altSeasonCache = { data, ts: Date.now() };
    return data;
  } catch { return null; }
}

// ─── Stablecoin Inflow (DefiLlama — public, no auth) ─────────────────────────
let _stableCache = { data: null, ts: 0 };
const STABLE_TTL = 30 * 60 * 1000; // 30 min
export async function getStablecoinInflow() {
  if (Date.now() - _stableCache.ts < STABLE_TTL && _stableCache.data) return _stableCache.data;
  try {
    const url = "https://stablecoins.llama.fi/stablecoincharts/all";
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    if (!Array.isArray(d) || d.length < 8) return null;
    const latest = d[d.length - 1];
    const week   = d[d.length - 8];  // ~7 dana
    const today7 = parseFloat(latest?.totalCirculatingUSD?.peggedUSD || 0);
    const prev7  = parseFloat(week?.totalCirculatingUSD?.peggedUSD || 0);
    if (!today7 || !prev7) return null;
    const changePct = ((today7 - prev7) / prev7) * 100;
    const changeAbs = ((today7 - prev7) / 1e9).toFixed(2); // u milijardama
    const direction = changePct > 0.3 ? "INFLOW" : changePct < -0.3 ? "OUTFLOW" : "NEUTRAL";
    const data = {
      totalB: (today7 / 1e9).toFixed(1),   // ukupno u mlrd $
      changePct: changePct.toFixed(2),
      changeAbs,
      direction,
    };
    _stableCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    return null;
  }
}

// ─── Per-Symbol WR tracking ───────────────────────────────────────────────────
const getSymStatsFile = () => `${DATA_DIR}/symbol_stats.json`;

function loadSymStats() {
  try { return existsSync(getSymStatsFile()) ? JSON.parse(readFileSync(getSymStatsFile(), "utf8")) : {}; }
  catch { return {}; }
}
function saveSymStats(st) {
  try { writeFileSync(getSymStatsFile(), JSON.stringify(st, null, 2)); } catch {}
}
function recordSymbolOutcome(symbol, won) {
  const st = loadSymStats();
  if (!st[symbol]) st[symbol] = { wins: 0, total: 0 };
  st[symbol].total++;
  if (won) st[symbol].wins++;
  saveSymStats(st);
}
export function getSymbolStats() { return loadSymStats(); }

// ─── Open Interest trend ──────────────────────────────────────────────────────
const _oiCache = {};
const OI_TTL   = 5 * 60 * 1000;

async function getOpenInterest(symbol) {
  const cached = _oiCache[symbol];
  if (cached && Date.now() - cached.ts < OI_TTL) return cached;
  try {
    const url = `${BITGET.baseUrl}/api/v2/mix/market/open-interest?symbol=${symbol}&productType=USDT-FUTURES`;
    const r = await fetch(url);
    const d = await r.json();
    const oi = parseFloat(d?.data?.openInterestList?.[0]?.size || d?.data?.size || 0);
    const prev = cached?.oi || oi;
    const trend = oi > prev * 1.02 ? 'RASTE' : oi < prev * 0.98 ? 'PADA' : 'FLAT';
    const result = { oi, prev, trend, ts: Date.now() };
    _oiCache[symbol] = { ...result, oi };
    return result;
  } catch { return { oi: 0, trend: 'N/A', ts: Date.now() }; }
}

export async function getOIForSymbols(symbols) {
  const result = {};
  await Promise.all(symbols.map(async sym => { result[sym] = await getOpenInterest(sym); }));
  return result;
}

// ─── Fear & Greed Index ───────────────────────────────────────────────────────
let _fgCache = { value: null, label: '', ts: 0 };
const FG_TTL = 30 * 60 * 1000;

async function getFearGreed() {
  if (Date.now() - _fgCache.ts < FG_TTL && _fgCache.value !== null) return _fgCache;
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1");
    const d = await r.json();
    const v = parseInt(d?.data?.[0]?.value || 50);
    const label = d?.data?.[0]?.value_classification || '';
    _fgCache = { value: v, label, ts: Date.now() };
    return _fgCache;
  } catch { return { value: null, label: 'N/A', ts: Date.now() }; }
}
export { getFearGreed };

// ─── BTC Dominance ────────────────────────────────────────────────────────────
let _domCache = { btc: null, change: null, ts: 0 };
const DOM_TTL = 15 * 60 * 1000;

async function getBtcDominance() {
  if (Date.now() - _domCache.ts < DOM_TTL && _domCache.btc !== null) return _domCache;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/global");
    const d = await r.json();
    const btc = d?.data?.market_cap_percentage?.btc;
    _domCache = { btc: btc ? parseFloat(btc.toFixed(1)) : null, ts: Date.now() };
    return _domCache;
  } catch { return { btc: null, ts: Date.now() }; }
}
export { getBtcDominance };

// ─── DXY Cross-asset korelacija ───────────────────────────────────────────────
let _dxyCache = { change4h: null, direction: '', ts: 0 };
const DXY_TTL = 15 * 60 * 1000;

async function getDxyData() {
  if (Date.now() - _dxyCache.ts < DXY_TTL && _dxyCache.change4h !== null) return _dxyCache;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=4h&range=1d&includePrePost=false`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const d = await r.json();
    const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean) || [];
    if (closes.length < 2) return _dxyCache;
    const first = closes[0], last = closes[closes.length - 1];
    const change4h = parseFloat(((last - first) / first * 100).toFixed(3));
    const direction = change4h > 0.3 ? '↑ jača' : change4h < -0.3 ? '↓ slabi' : '→ flat';
    _dxyCache = { change4h, direction, ts: Date.now() };
    return _dxyCache;
  } catch { return { change4h: null, direction: 'N/A', ts: Date.now() }; }
}
export { getDxyData };

// ─── Consecutive loss counter (za dashboard CB progress bar) ──────────────────
export function getConsecutiveLossCount(pid) {
  const f = csvFilePath(pid);
  if (!existsSync(f)) return 0;
  try {
    const lines = readFileSync(f, "utf8").trim().split("\n");
    const exits = lines.slice(1)
      .filter(l => l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT"))
      .reverse();
    let count = 0;
    for (const l of exits) {
      if (parseFloat(l.split(",")[9] || 0) < 0) count++;
      else break;
    }
    return count;
  } catch { return 0; }
}

// ─── 4. SIGNAL ANALIZA — prati koje signale bilježe pobjedu ──────────────────
// Svaki ulaz bilježi fingerprint aktivnih signala (bitmask)
// Čitamo nakon izlaza koji signal je bio aktivan i označavamo win/loss
// Svaka 10. analiza ispisuje per-signal WR u konzolu

const SIG_NAMES = ["E50⟳","RSI⟳","E55⟳","CHP","CVD⟳","R⟳","MCD","E145","VOL⟳","MCC⟳","RSI↗","SRS","SRB"];
const getSigStatsFile = () => `${DATA_DIR}/signal_stats.json`;

function loadSigStats() {
  try { return existsSync(getSigStatsFile()) ? JSON.parse(readFileSync(getSigStatsFile(),"utf8")) : {}; }
  catch { return {}; }
}
function saveSigStats(st) {
  try { writeFileSync(getSigStatsFile(), JSON.stringify(st, null, 2)); } catch {}
}

function recordSignalOutcome(sigMask, won) {
  const st = loadSigStats();
  for (let i = 0; i < SIG_NAMES.length; i++) {
    if (!((sigMask >> i) & 1)) continue;
    const key = SIG_NAMES[i];
    if (!st[key]) st[key] = { wins: 0, total: 0 };
    st[key].total++;
    if (won) st[key].wins++;
  }
  saveSigStats(st);
}

function printSigStats() {
  const st = loadSigStats();
  const rows = Object.entries(st)
    .filter(([,v]) => v.total >= 3)
    .map(([k,v]) => ({ name: k, wr: v.wins/v.total*100, total: v.total }))
    .sort((a,b) => b.wr - a.wr);
  if (!rows.length) return;
  console.log("  📈 [SIG ANALIZA] Per-signal WR (zadnji trejdovi):");
  for (const r of rows) {
    const bar = "█".repeat(Math.round(r.wr/10));
    const ok  = r.wr >= 40 ? "✓" : r.wr >= 30 ? "~" : "✗";
    console.log(`     ${r.name.padEnd(6)} ${ok} WR=${r.wr.toFixed(0).padStart(3)}% [${bar.padEnd(10)}] N=${r.total}`);
  }
}

const PAPER_TRADING = process.env.PAPER_TRADING !== "false";
const BITGET_DEMO   = process.env.BITGET_DEMO === "true";
const BITGET = {
  apiKey:     (process.env.BITGET_API_KEY     || "").trim(),
  secretKey:  (process.env.BITGET_SECRET_KEY  || "").trim(),
  passphrase: (process.env.BITGET_PASSPHRASE  || "").trim(),
  baseUrl:    (process.env.BITGET_BASE_URL    || "https://api.bitget.com").trim(),
};
// Debug: provjeri jesu li kredencijali učitani
console.log(`🔑 BitGet key: ${BITGET.apiKey.slice(0,8)}... len=${BITGET.apiKey.length} | pass len=${BITGET.passphrase.length} | secret len=${BITGET.secretKey.length}`);

// Startup auth test — provjera potpisa pri startu
async function testBitGetAuth() {
  try {
    const path = "/api/v2/mix/account/accounts?productType=USDT-FUTURES";
    const timestamp = Date.now().toString();
    const sign = crypto.createHmac("sha256", BITGET.secretKey)
      .update(`${timestamp}GET${path}`).digest("base64");
    const res = await fetch(`${BITGET.baseUrl}${path}`, {
      headers: {
        "ACCESS-KEY":        BITGET.apiKey,
        "ACCESS-SIGN":       sign,
        "ACCESS-TIMESTAMP":  timestamp,
        "ACCESS-PASSPHRASE": BITGET.passphrase,
        "Content-Type":      "application/json",
      },
    });
    const data = await res.json();
    if (data.code === "00000") {
      console.log(`✅ BitGet auth OK — accounts: ${JSON.stringify(data.data?.slice(0,1))}`);
    } else {
      console.log(`❌ BitGet auth FAIL — code=${data.code} msg=${data.msg}`);
    }
  } catch (e) {
    console.log(`❌ BitGet auth ERROR: ${e.message}`);
  }
}

// ─── Perzistentni direktorij ───────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : ".");
if (DATA_DIR !== "." && !existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const HEARTBEAT_FILE = `${DATA_DIR}/heartbeat.json`;

// ─── Portfolio definicije ──────────────────────────────────────────────────────

const PORTFOLIO_IDS = ["synapse_t"];  // Aktivni portfolio — samo ULTRA

function buildPortfolios(rules) {
  const tfs = rules.portfolio_timeframes || {};
  return {
    ema_rsi: {
      id:        "ema_rsi",
      name:      "EMA+RSI",
      symbols:   rules.watchlist_ema_rsi    || [],
      strategy:  "ema_rsi",
      params:    rules.strategies.ema_rsi.params,
      timeframe: tfs.ema_rsi      || "1H",
      slPct:     2.0, tpPct: 4.0,
    },
    mega: {
      id:        "mega",
      name:      "MEGA",
      symbols:   rules.watchlist_mega       || [],
      strategy:  "mega",
      params:    rules.strategies.mega.params,
      timeframe: tfs.mega         || "15m",
      slPct:     2.0, tpPct: 4.0,
    },
    synapse7: {
      id:        "synapse7",
      name:      "SYNAPSE-7",
      symbols:   rules.watchlist_synapse7   || [],
      strategy:  "synapse7",
      params:    rules.strategies.synapse7?.params  || {},
      timeframe: tfs.synapse7     || "15m",
      slPct:     2.0, tpPct: 4.0,
    },
    synapse_t: {
      id:           "synapse_t",
      name:         "ULTRA",
      symbols:      rules.watchlist_synapse_t  || [],
      strategy:     "synapse_t",
      params:       rules.strategies.synapse_t?.params || {},
      timeframe:    tfs.synapse_t    || "15m",
      slPct:        1.0, tpPct: 2.0,   // ULTRA: SL 1% / TP 2% | 100x → SL = likvidacija
      live:         true,               // ← LIVE trading
      startCapital: 296.99,            // ← Bitget balans 2026-05-09 (stvarni)
    },
  };
}

// Pokreni portfolio samo kad se zatvori njegova svjeća
function shouldRunNow(tf, utcHour, utcMin) {
  // Prozor od 5 min garantira da svaki 5-min bot run uvijek pogodi svaki TF,
  // bez obzira kad je Railway restartao bot (offset-neovisno).
  // Dokaz: za step=5 i prozor=5, u svakom TF-bloku postoji točno jedan run s min%TF < 5.
  switch (tf) {
    case "1m":  return true;
    case "5m":  return true;                              // svaki run = nova 5m svjeća
    case "15m": return utcMin % 15 < 5;
    case "30m": return utcMin % 30 < 5;
    case "1H":  return utcMin < 5;
    case "2H":  return utcMin < 5 && utcHour % 2 === 0;
    case "4H":  return utcMin < 5 && utcHour % 4 === 0;
    case "1D":  return utcMin < 5 && utcHour === 0;
    default:    return utcMin < 5;
  }
}

// ─── Heartbeat ─────────────────────────────────────────────────────────────────

function writeHeartbeat(status = "ok", extra = {}) {
  writeFileSync(HEARTBEAT_FILE, JSON.stringify({
    ts: new Date().toISOString(), status, version: "3.0", ...extra,
  }));
}

// ─── Telegram ──────────────────────────────────────────────────────────────────

async function tg(msg) {
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

// ─── Market Data ───────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = TIMEFRAME, limit = 250) {
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${interval}&limit=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`BitGet HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(`BitGet: ${json.msg}`);
  return json.data.map(k => ({
    time: parseInt(k[0]), open: parseFloat(k[1]),
    high: parseFloat(k[2]), low: parseFloat(k[3]),
    close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indikatori ────────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / (losses / period));
}

function calcATR(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 3) return null;
  const trs = [], pDMs = [], mDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  let smTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smP  = pDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smM  = mDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  for (let i = period; i < trs.length; i++) {
    smTR = smTR - smTR / period + trs[i];
    smP  = smP  - smP  / period + pDMs[i];
    smM  = smM  - smM  / period + mDMs[i];
    const pdi = smTR > 0 ? 100 * smP / smTR : 0;
    const mdi = smTR > 0 ? 100 * smM / smTR : 0;
    const s   = pdi + mdi;
    dx.push(s > 0 ? 100 * Math.abs(pdi - mdi) / s : 0);
  }
  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return adx;
}

function calcChop(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const sl = candles.slice(-(period + 1));
  let atrSum = 0;
  for (let i = 1; i < sl.length; i++) {
    const h = sl[i].high, l = sl[i].low, pc = sl[i-1].close;
    atrSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const hh = Math.max(...sl.slice(1).map(c => c.high));
  const ll = Math.min(...sl.slice(1).map(c => c.low));
  const range = hh - ll;
  if (!range || !atrSum) return null;
  return 100 * Math.log10(atrSum / range) / Math.log10(period);
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal + 2) return null;
  const diffs = [];
  for (let i = slow; i <= closes.length; i++) {
    const f = calcEMA(closes.slice(0, i), fast);
    const s = calcEMA(closes.slice(0, i), slow);
    if (f !== null && s !== null) diffs.push(f - s);
  }
  const sigLine = calcEMA(diffs, signal);
  if (!sigLine) return null;
  return diffs[diffs.length - 1] - sigLine; // histogram
}

// ─── Strategije ────────────────────────────────────────────────────────────────

function analyzeEmaRsi(candles, cfg) {
  const { ema9Len = 9, ema21Len = 21, ema50Len = 50,
          rsiLen = 14, rsiLongLo = 35, rsiLongHi = 58,
          rsiShortLo = 42, rsiShortHi = 65 } = cfg;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];

  const ema9  = calcEMA(closes, ema9Len);
  const ema21 = calcEMA(closes, ema21Len);
  const ema50 = calcEMA(closes, ema50Len);
  const rsi   = calcRSI(closes, rsiLen);

  if (!ema9 || !ema21 || !ema50 || rsi === null)
    return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka" };

  const prevCloses = closes.slice(0, -1);
  const pEma9  = calcEMA(prevCloses, ema9Len);
  const pEma21 = calcEMA(prevCloses, ema21Len);

  const crossUp   = pEma9 !== null && pEma21 !== null && pEma9 <= pEma21 && ema9 > ema21;
  const crossDown = pEma9 !== null && pEma21 !== null && pEma9 >= pEma21 && ema9 < ema21;

  let signal = "NEUTRAL", reason = "";

  if (price > ema50 && crossUp && rsi >= rsiLongLo && rsi <= rsiLongHi) {
    signal = "LONG";
    reason = `EMA9/21 cross UP | RSI ${rsi.toFixed(1)} | Cijena > EMA50`;
  } else if (price < ema50 && crossDown && rsi >= rsiShortLo && rsi <= rsiShortHi) {
    signal = "SHORT";
    reason = `EMA9/21 cross DOWN | RSI ${rsi.toFixed(1)} | Cijena < EMA50`;
  } else {
    if (!crossUp && !crossDown)           reason = "Nema EMA crossovera";
    else if (crossUp && price <= ema50)   reason = "Cross UP ali cijena ispod EMA50";
    else if (crossDown && price >= ema50) reason = "Cross DOWN ali cijena iznad EMA50";
    else reason = `RSI ${rsi.toFixed(1)} izvan zone`;
  }

  return { price, ema9, ema21, ema50, rsi, signal, reason };
}

function analyzeThreeLayer(candles, cfg) {
  const { ema9Len = 9, ema21Len = 21, ema145Len = 145,
          macdFast = 12, macdSlow = 26, macdSignal = 9 } = cfg;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];

  const ema9   = calcEMA(closes, ema9Len);
  const ema21  = calcEMA(closes, ema21Len);
  const ema145 = calcEMA(closes, ema145Len);
  const hist   = calcMACD(closes, macdFast, macdSlow, macdSignal);

  if (!ema9 || !ema21 || !ema145 || hist === null)
    return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka (EMA/MACD)" };

  const prevCloses = closes.slice(0, -1);
  const pEma9  = calcEMA(prevCloses, ema9Len);
  const pEma21 = calcEMA(prevCloses, ema21Len);

  const crossUp   = pEma9 !== null && pEma21 !== null && pEma9 <= pEma21 && ema9 > ema21;
  const crossDown = pEma9 !== null && pEma21 !== null && pEma9 >= pEma21 && ema9 < ema21;

  let signal = "NEUTRAL", reason = "";

  if (crossUp && hist > 0 && price > ema145) {
    signal = "LONG";
    reason = `EMA9/21 cross UP | MACD hist ${hist.toFixed(6)} > 0 | Cijena > EMA145`;
  } else if (crossDown && hist < 0 && price < ema145) {
    signal = "SHORT";
    reason = `EMA9/21 cross DOWN | MACD hist ${hist.toFixed(6)} < 0 | Cijena < EMA145`;
  } else {
    if (!crossUp && !crossDown)                    reason = "Nema EMA crossovera";
    else if (crossUp && hist <= 0)                 reason = `MACD hist negativan (${hist.toFixed(6)})`;
    else if (crossDown && hist >= 0)               reason = `MACD hist pozitivan (${hist.toFixed(6)})`;
    else if (crossUp && price <= ema145)            reason = "Cijena ispod EMA145 — trend filter";
    else if (crossDown && price >= ema145)          reason = "Cijena iznad EMA145 — trend filter";
    else                                            reason = "Uvjeti nisu ispunjeni";
  }

  return { price, ema9, ema21, ema145, hist, signal, reason };
}

function analyzeMega(candles, cfg) {
  const {
    ema9Len = 9, ema21Len = 21, ema55Len = 55, ema200Len = 200,
    rsiLen = 14, adxLen = 14, adxMin = 18, chopLen = 14, chopMax = 61.8,
    rsiLongLo = 30, rsiLongHi = 60, rsiShortLo = 40, rsiShortHi = 70,
  } = cfg;

  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const ema9   = calcEMA(closes, ema9Len);
  const ema21  = calcEMA(closes, ema21Len);
  const ema55  = calcEMA(closes, ema55Len);
  const ema200 = calcEMA(closes, ema200Len);
  const rsi    = calcRSI(closes, rsiLen);
  const adx    = calcADX(candles, adxLen);
  const chop   = calcChop(candles, chopLen);

  if (!ema9 || !ema21 || !ema55 || rsi === null)
    return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka" };

  const prevCloses  = closes.slice(0, -1);
  const prev2Closes = closes.slice(0, -2);
  const pEma9  = calcEMA(prevCloses, ema9Len);
  const pEma21 = calcEMA(prevCloses, ema21Len);
  const p2Ema9 = calcEMA(prev2Closes, ema9Len);
  const p2Ema21= calcEMA(prev2Closes, ema21Len);
  if (!pEma9 || !pEma21) return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka za cross" };

  const crossUp   = (p2Ema9 <= p2Ema21 && pEma9 > pEma21) || (pEma9 <= pEma21 && ema9 > ema21);
  const crossDown = (p2Ema9 >= p2Ema21 && pEma9 < pEma21) || (pEma9 >= pEma21 && ema9 < ema21);

  const trendUp   = price > ema55 && (!ema200 || price > ema200);
  const trendDown = price < ema55 && (!ema200 || price < ema200);
  const trending  = adx === null || adx > adxMin;
  const notChoppy = chop === null || chop < chopMax;

  let signal = "NEUTRAL", reason = "";

  if (crossUp && trendUp && rsi > rsiLongLo && rsi < rsiLongHi && trending && notChoppy) {
    signal = "LONG";
    reason = `EMA9/21 cross UP | RSI ${rsi.toFixed(1)} | ADX ${adx?.toFixed(1) ?? "n/a"} | Chop ${chop?.toFixed(1) ?? "n/a"}`;
  } else if (crossDown && trendDown && rsi > rsiShortLo && rsi < rsiShortHi && trending && notChoppy) {
    signal = "SHORT";
    reason = `EMA9/21 cross DOWN | RSI ${rsi.toFixed(1)} | ADX ${adx?.toFixed(1) ?? "n/a"} | Chop ${chop?.toFixed(1) ?? "n/a"}`;
  } else {
    const why = [];
    if (!crossUp && !crossDown)                                     why.push("Nema EMA cross");
    if ((crossUp && !trendUp) || (crossDown && !trendDown))        why.push("Trend filter (EMA55/200)");
    if (crossUp   && !(rsi > rsiLongLo && rsi < rsiLongHi))       why.push(`RSI ${rsi.toFixed(1)} van ${rsiLongLo}-${rsiLongHi}`);
    if (crossDown && !(rsi > rsiShortLo && rsi < rsiShortHi))     why.push(`RSI ${rsi.toFixed(1)} van ${rsiShortLo}-${rsiShortHi}`);
    if (!trending)  why.push(`ADX ${adx?.toFixed(1) ?? "n/a"} < ${adxMin}`);
    if (!notChoppy) why.push(`Chop ${chop?.toFixed(1) ?? "n/a"} > ${chopMax}`);
    reason = why.join(" | ") || "Uvjeti nisu ispunjeni";
  }

  return { price, ema9, ema21, ema55, ema200, rsi, adx, chop, signal, reason };
}

// ─── SYNAPSE-7 helpers ─────────────────────────────────────────────────────────

function _emaSeries(arr, p) {
  const k = 2 / (p + 1), r = new Array(arr.length).fill(null);
  if (arr.length < p) return r;
  let v = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  r[p - 1] = v;
  for (let i = p; i < arr.length; i++) { v = arr[i] * k + v * (1 - k); r[i] = v; }
  return r;
}

function _rmaSeries(arr, p) {
  const r = new Array(arr.length).fill(null);
  if (arr.length < p) return r;
  let v = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  r[p - 1] = v;
  for (let i = p; i < arr.length; i++) { v = (v * (p - 1) + arr[i]) / p; r[i] = v; }
  return r;
}

function _rsiSeries(closes, p = 14) {
  const r = new Array(closes.length).fill(null);
  const g = [], l = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g.push(d > 0 ? d : 0); l.push(d < 0 ? -d : 0);
  }
  const ag = _rmaSeries(g, p), al = _rmaSeries(l, p);
  for (let i = 0; i < ag.length; i++) {
    if (ag[i] === null) continue;
    r[i + 1] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
  }
  return r;
}

// AutoTune Ehlers — simplified (uses fixed dominant cycle estimate)
function _autoTuneBP(closes, wlen = 20) {
  // High-pass filter
  const w  = 1.414 * Math.PI / wlen;
  const q  = Math.exp(-w);
  const c1 = 2 * q * Math.cos(w), c2 = q * q;
  const a0 = 0.25 * (1 + c1 + c2);
  const hp = new Array(closes.length).fill(0);
  for (let i = 4; i < closes.length; i++)
    hp[i] = a0*(closes[i]-2*closes[i-1]+closes[i-2]) + c1*hp[i-1] - c2*hp[i-2];

  // Dominant cycle via autocorrelation (last wlen bars)
  const n = closes.length, win = hp.slice(Math.max(0, n - wlen));
  let minCorr = Infinity, minLag = wlen;
  const sx = win.reduce((a,b)=>a+b,0), sxx = win.reduce((a,b)=>a+b*b,0);
  for (let lag = 1; lag <= Math.min(wlen, Math.floor(n / 2)); lag++) {
    const lw = hp.slice(Math.max(0, n-wlen-lag), n-lag);
    if (lw.length < wlen) continue;
    const sy = lw.reduce((a,b)=>a+b,0), syy = lw.reduce((a,b)=>a+b*b,0);
    let sxy = 0;
    for (let j = 0; j < wlen; j++) sxy += (win[j]||0) * (lw[j]||0);
    const cov = wlen*sxy - sx*sy, vx = wlen*sxx-sx*sx, vy = wlen*syy-sy*sy;
    const den = Math.sqrt(vx*vy);
    const corr = den > 0 ? cov/den : 0;
    if (corr < minCorr) { minCorr = corr; minLag = lag; }
  }
  const dc = Math.min(Math.max(minLag * 2, 4), 100);

  // Band-pass at dominant cycle
  const w0 = 2*Math.PI/dc, l1 = Math.cos(w0), g1 = Math.cos(w0*0.25);
  const s1 = 1/g1 - Math.sqrt(1/(g1*g1)-1);
  const bp = new Array(closes.length).fill(0);
  for (let i = 3; i < closes.length; i++)
    bp[i] = 0.5*(1-s1)*(closes[i]-closes[i-2]) + l1*(1+s1)*bp[i-1] - s1*bp[i-2];
  return bp;
}

function analyzeSynapse7(candles, cfg) {
  const { minSig = 3 } = cfg;
  const closes = candles.map(c => c.close);
  const n      = closes.length;
  const price  = closes[n - 1];

  if (n < 80) return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka" };

  // ── 1. AI kNN (simplified: log-return momentum pattern) ──
  const logRet = closes.map((c, i) => i === 0 ? 0 : Math.log(c / closes[i-1]));
  const mom5   = closes.map((c, i) => i < 5 ? 0 : (c - closes[i-5]) / closes[i-5]);
  const rsiArr = _rsiSeries(closes, 14);
  const patLen = 8;
  const kMem   = 15;
  const patterns = [], labels = [];
  let kPred = 0;
  for (let i = 40; i < n - 1; i++) {
    const pat = [];
    for (let j = patLen - 1; j >= 0; j--) {
      const idx = i - j;
      pat.push(logRet[idx]||0, mom5[idx]||0, ((rsiArr[idx]||50)-50)/50);
    }
    if (patterns.length >= kMem) { patterns.shift(); labels.shift(); }
    if (i < n - 1) {
      patterns.push(pat);
      labels.push(Math.log(closes[i+1]/closes[i]) > 0 ? 1 : -1);
    }
  }
  // Predict current bar
  if (patterns.length > 0) {
    const curPat = [];
    for (let j = patLen - 1; j >= 0; j--) {
      const idx = n - 1 - j;
      curPat.push(logRet[idx]||0, mom5[idx]||0, ((rsiArr[idx]||50)-50)/50);
    }
    const dists = patterns.map((p, pi) => {
      let d = 0;
      for (let x = 0; x < curPat.length; x++) d += (curPat[x]-p[x])**2;
      return { d: Math.sqrt(d), label: labels[pi] };
    }).sort((a,b)=>a.d-b.d).slice(0, 5);
    const sumD = dists.reduce((s,x)=>s+x.d,0);
    for (const t of dists) {
      const w = dists.length > 1 ? (sumD > 0 ? 1 - t.d/sumD : 1) : 1;
      kPred += t.label * w;
    }
  }
  // kNN oscillator via EMA smoothing
  const kOscVal = kPred;
  const aiSignal = kOscVal > 0.05 ? 1 : kOscVal < -0.05 ? -1 : 0;

  // ── 2. AutoTune BP ──
  const bp   = _autoTuneBP(closes, 20);
  const atSig = (bp[n-1] > 0 && bp[n-1] > bp[n-2]) ? 1 :
                (bp[n-1] < 0 && bp[n-1] < bp[n-2]) ? -1 : 0;

  // ── 3. 6-Scale EMA Consensus ──
  const pairs = [[3,11],[5,15],[11,21],[17,27],[27,37],[45,55]];
  let upCnt = 0, dnCnt = 0;
  for (const [f, s] of pairs) {
    const ef = _emaSeries(closes, f), es = _emaSeries(closes, s);
    if (ef[n-1] !== null && es[n-1] !== null) {
      if (ef[n-1] > es[n-1]) upCnt++; else dnCnt++;
    }
  }
  const scSig = upCnt >= 3 ? 1 : dnCnt >= 3 ? -1 : 0;

  // ── 4. RSI Recovery (iz oversold/overbought zone) ──
  // BULL: RSI bio ispod 35 u zadnjih 5 bara i sad raste iznad 35 → recovery iz oversold
  // BEAR: RSI bio iznad 65 u zadnjih 5 bara i sad pada ispod 65 → recovery iz overbought
  const rv  = rsiArr[n-1] ?? 50;
  const rv1 = rsiArr[n-2] ?? rv;
  const rv2 = rsiArr[n-3] ?? rv1;
  const rv3 = rsiArr[n-4] ?? rv2;
  const rv4 = rsiArr[n-5] ?? rv3;
  const rsiMin5s = Math.min(rv, rv1, rv2, rv3, rv4);
  const rsiMax5s = Math.max(rv, rv1, rv2, rv3, rv4);
  const rsiRisingS  = rv > rv1 && rv1 > rv2;
  const rsiFallingS = rv < rv1 && rv1 < rv2;
  const rsSig = (rsiMin5s < 35 && rv > 35 && rsiRisingS)  ?  1
              : (rsiMax5s > 65 && rv < 65 && rsiFallingS) ? -1 : 0;

  // ── 5. CVD Delta ──
  const barDelta = candles.map(c => c.volume * Math.sign(c.close - c.open));
  let cvdSum = 0;
  for (let i = Math.max(0, n-20); i < n; i++) cvdSum += barDelta[i];
  const cvdSmArr = _emaSeries(barDelta.map((_, i) => {
    let s=0; for(let j=Math.max(0,i-19);j<=i;j++) s+=barDelta[j]; return s;
  }), 9);
  const cvdV = cvdSmArr[n-1] ?? 0;
  const cvdSig = (cvdSum > 0 && cvdSum > cvdV) ? 1 :
                 (cvdSum < 0 && cvdSum < cvdV) ? -1 : 0;

  // ── Combination ──
  const bullScore = [aiSignal,atSig,scSig,rsSig,cvdSig].filter(v=>v===1).length;
  const bearScore = [aiSignal,atSig,scSig,rsSig,cvdSig].filter(v=>v===-1).length;

  let signal = "NEUTRAL", reason = "";

  if (bullScore >= minSig) {
    signal = "LONG";
    reason = `SYNAPSE-7 LONG | Score ${bullScore}/5 | kNN↑${aiSignal>0?'✓':''} AT↑${atSig>0?'✓':''} SC ${upCnt}/6 RSI${rv.toFixed(0)}↑ CVD↑${cvdSig>0?'✓':''}`;
  } else if (bearScore >= minSig) {
    signal = "SHORT";
    reason = `SYNAPSE-7 SHORT | Score ${bearScore}/5 | kNN↓${aiSignal<0?'✓':''} AT↓${atSig<0?'✓':''} SC ${dnCnt}/6 RSI${rv.toFixed(0)}↓ CVD↓${cvdSig<0?'✓':''}`;
  } else {
    reason = `Score ↑${bullScore}/5 ↓${bearScore}/5 — min ${minSig} potrebno`;
  }

  return { price, aiSignal, atSig, scSig, rsSig, cvdSig, bullScore, bearScore, signal, reason };
}

// ─── SYNAPSE-T: SYNAPSE-7 + obvezan ADX trend filter + minSig 4/5 ─────────────
function analyzeSynapseT(candles, cfg) {
  const { minSig = 4, adxMin = 22 } = cfg;

  // Obvezan pre-filter: ADX mora biti > adxMin (trend, ne konsolidacija)
  const closes = candles.map(c => c.close);
  const n      = closes.length;
  const price  = closes[n - 1];

  if (n < 80) return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka" };

  // ADX kalkulacija (Wilder RMA metoda)
  function _adxVal(cands, p = 14) {
    if (cands.length < p * 3) return null;
    const trs = [], pDMs = [], mDMs = [];
    for (let i = 1; i < cands.length; i++) {
      const h = cands[i].high, l = cands[i].low;
      const ph = cands[i-1].high, pl = cands[i-1].low, pc = cands[i-1].close;
      trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
      const up = h-ph, dn = pl-l;
      pDMs.push(up > dn && up > 0 ? up : 0);
      mDMs.push(dn > up && dn > 0 ? dn : 0);
    }
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

  const adxVal = _adxVal(candles, 14);
  if (adxVal === null || adxVal < adxMin) {
    return { price, signal: "NEUTRAL", reason: `SYNAPSE-T: ADX ${adxVal?.toFixed(1)||"?"} < ${adxMin} — konsolidacija, preskačem` };
  }

  // Proslijedi na SYNAPSE-7 logiku s minSig=4
  const result = analyzeSynapse7(candles, { ...cfg, minSig });

  // Prepiši reason s SYNAPSE-T labelom
  if (result.signal !== "NEUTRAL") {
    result.reason = result.reason.replace("SYNAPSE-7", "SYNAPSE-T") + ` ADX:${adxVal.toFixed(1)}`;
  } else {
    result.reason = `SYNAPSE-T: Score ↑${result.bullScore}/5 ↓${result.bearScore}/5 (min ${minSig}) | ADX:${adxVal.toFixed(1)}`;
  }
  return result;
}

// ─── ULTRA — 13-Signal Combined Strategy ──────────────────────────────────────
// Kombinira signale iz: EMA+RSI, MEGA, SYNAPSE-7, 3-Layer, Fib/PA
// Min 8/13 signala za ulaz + pullback entry -1%/+1%
// SL 1% / TP 2%

function analyzeUltra(candles, cfg) {
  const { minSig = 8, _dynAdx } = cfg;
  const effectiveAdx = _dynAdx ?? ADX_MIN;  // koristi dinamički ADX ako dostupan
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume || 0);
  const n      = closes.length;
  const price  = closes[n - 1];

  if (n < 200) return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka (treba 200 bar)" };

  // ── Indikatori ──
  function ema(p) {
    const k = 2 / (p + 1);
    let v = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < n; i++) v = closes[i] * k + v * (1 - k);
    return v;
  }
  function emaSeries(p) {
    const k = 2 / (p + 1); const r = new Array(n).fill(null);
    let v = closes.slice(0, p).reduce((a, b) => a + b, 0) / p; r[p-1] = v;
    for (let i = p; i < n; i++) { v = closes[i] * k + v * (1 - k); r[i] = v; }
    return r;
  }

  const e9s  = emaSeries(9); const e21s = emaSeries(21);
  const ema9 = e9s[n-1]; const ema21 = e21s[n-1];
  const ema50  = ema(50);  const ema55  = ema(55);
  const ema145 = ema(145); const ema200 = ema(200);

  // RSI series (last 6 bars za detekciju recovery)
  const rsiArr2 = _rsiSeries(closes, 14);
  const rsi  = rsiArr2[n-1] ?? 50;
  const rsi1 = rsiArr2[n-2] ?? rsi;  // prethodna svjeća
  const rsi2 = rsiArr2[n-3] ?? rsi1; // dvije svjeće unazad
  const rsi3 = rsiArr2[n-4] ?? rsi2;
  const rsi4 = rsiArr2[n-5] ?? rsi3;
  const rsiMin5 = Math.min(rsi1, rsi2, rsi3, rsi4, rsi);  // minimum zadnjih 5 bara
  const rsiMax5 = Math.max(rsi1, rsi2, rsi3, rsi4, rsi);  // maximum zadnjih 5 bara
  const rsiRising  = rsi > rsi1 && rsi1 > rsi2;  // RSI raste zadnje 2 svjeće
  const rsiFalling = rsi < rsi1 && rsi1 < rsi2;  // RSI pada zadnje 2 svjeće

  // ADX
  const trs = [], pDMs = [], mDMs = [];
  for (let i = 1; i < n; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    const ph = candles[i-1].high, pl = candles[i-1].low;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    const up = h-ph, dn = pl-l;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  const p14 = 14;
  let smTR = trs.slice(0,p14).reduce((a,b)=>a+b,0);
  let smP  = pDMs.slice(0,p14).reduce((a,b)=>a+b,0);
  let smM  = mDMs.slice(0,p14).reduce((a,b)=>a+b,0);
  const dx = [];
  for (let i = p14; i < trs.length; i++) {
    smTR = smTR - smTR/p14 + trs[i]; smP = smP - smP/p14 + pDMs[i]; smM = smM - smM/p14 + mDMs[i];
    const pdi = smTR > 0 ? 100*smP/smTR : 0, mdi = smTR > 0 ? 100*smM/smTR : 0;
    const s = pdi+mdi; dx.push(s > 0 ? 100*Math.abs(pdi-mdi)/s : 0);
  }
  let adx = dx.slice(0,p14).reduce((a,b)=>a+b,0)/p14;
  for (let i = p14; i < dx.length; i++) adx = (adx*(p14-1)+dx[i])/p14;

  // Choppiness
  const sl14 = candles.slice(-15);
  let trSum = 0;
  for (let i = 1; i < sl14.length; i++) {
    const h=sl14[i].high,l=sl14[i].low,pc=sl14[i-1].close;
    trSum += Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
  }
  const hh14 = Math.max(...sl14.slice(1).map(c=>c.high));
  const ll14 = Math.min(...sl14.slice(1).map(c=>c.low));
  const chop = (hh14-ll14) > 0 ? 100*Math.log10(trSum/(hh14-ll14))/Math.log10(14) : 100;

  // MACD histogram
  function emaSlice(arr, p) {
    if (arr.length < p) return null;
    const k = 2/(p+1); let v = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
    for (let i = p; i < arr.length; i++) v = arr[i]*k + v*(1-k);
    return v;
  }
  const diffs = [];
  for (let i = 26; i <= n; i++) {
    const f = emaSlice(closes.slice(0,i), 12);
    const s = emaSlice(closes.slice(0,i), 26);
    if (f !== null && s !== null) diffs.push(f - s);
  }
  // Signal line series + current histogram
  const histVals = [];
  let macdHist = null;
  if (diffs.length >= 9) {
    const sigK9 = 2 / (9 + 1);
    let sv9 = diffs.slice(0, 9).reduce((a,b)=>a+b,0) / 9;
    for (let j = 9; j < diffs.length; j++) {
      sv9 = diffs[j] * sigK9 + sv9 * (1 - sigK9);
      histVals.push(diffs[j] - sv9);
    }
    if (histVals.length > 0) macdHist = histVals[histVals.length - 1];
  }
  // MACD cross: histogram changed sign in last 3 bars
  let macdCrossUp = false, macdCrossDn = false;
  for (let k = Math.max(1, histVals.length - 3); k < histVals.length; k++) {
    if (histVals[k] > 0 && histVals[k-1] <= 0) macdCrossUp = true;
    if (histVals[k] < 0 && histVals[k-1] >= 0) macdCrossDn = true;
  }
  const macdCross = macdCrossUp ? 1 : macdCrossDn ? -1 : 0;

  // 6-Scale multi-EMA
  const scales = [[3,11],[7,15],[13,21],[19,29],[29,47],[45,55]];
  let scaleUp = 0, scaleDn = 0;
  for (const [f, s] of scales) {
    const ef = emaSlice(closes, f), es = emaSlice(closes, s);
    if (ef && es) { if (ef > es) scaleUp++; else scaleDn++; }
  }

  // CVD
  const opens = candles.map(c => c.open);
  let cvdSum = 0;
  for (let i = n - 20; i < n; i++) {
    const sign = closes[i] > opens[i] ? 1 : closes[i] < opens[i] ? -1 : 0;
    cvdSum += sign * vols[i];
  }

  // ── Support / Resistance (pivot-based, zadnjih 80 bara, pivot N=4) ───────────
  // Pivot high = local max s 4 bara na svakoj strani (potvrđen, ne zadnjih 4)
  // Pivot low  = local min s 4 bara na svakoj strani
  const pivN = 4, srLookback = 80;
  const srStart = Math.max(pivN, n - srLookback);
  const srEnd   = n - pivN - 1;          // potvrđeni pivoti (prošlost, ne zadnji)
  const resistances = [], supports = [];
  for (let i = srStart; i <= srEnd; i++) {
    let ph = true, pl = true;
    for (let j = i - pivN; j <= i + pivN; j++) {
      if (j === i || j < 0 || j >= n) continue;
      if (candles[j].high >= candles[i].high) ph = false;
      if (candles[j].low  <= candles[i].low)  pl = false;
    }
    if (ph) resistances.push(candles[i].high);
    if (pl) supports.push(candles[i].low);
  }
  // Najbliži resistance iznad i support ispod trenutne cijene
  const resAbove = resistances.filter(r => r > price * 1.001).sort((a,b) => a - b);
  const supBelow = supports.filter(s => s < price * 0.999).sort((a,b) => b - a);
  const nearRes  = resAbove[0] ?? null;
  const nearSup  = supBelow[0] ?? null;
  const srZone   = 0.012;   // 1.2% = unutar zone

  // sig17: Bounce/Rejection od S/R razine (cijena reagira na zonu)
  let sig17sr = 0;
  if (nearSup !== null && (price - nearSup) / price < srZone && rsiRising)   sig17sr =  1;
  if (nearRes !== null && (nearRes - price) / price < srZone && rsiFalling)   sig17sr = -1;

  // sig18: Breakout/Breakdown kroz S/R razinu (u zadnja 3 bara)
  let sig18bk = 0;
  for (let k = Math.max(1, n - 3); k < n && sig18bk === 0; k++) {
    const pc = closes[k - 1], cc = closes[k];
    for (const r of resistances) if (pc < r && cc > r) { sig18bk =  1; break; }
    for (const s of supports)    if (pc > s && cc < s) { sig18bk = -1; break; }
  }

  // Volume vs average
  const volAvg20 = vols.slice(-20).reduce((a,b)=>a+b,0) / 20;
  const volLast  = vols[n-1];

  // Recent EMA cross (last 3 bars)
  let hadCrossUp = false, hadCrossDn = false;
  for (let i = Math.max(1, n-3); i < n; i++) {
    if (e9s[i-1] !== null && e21s[i-1] !== null) {
      if (e9s[i-1] <= e21s[i-1] && e9s[i] > e21s[i]) hadCrossUp = true;
      if (e9s[i-1] >= e21s[i-1] && e9s[i] < e21s[i]) hadCrossDn = true;
    }
  }

  // ── 13 signala: +1 = bullish, -1 = bearish, 0 = neutral ──
  // OBAVEZNI GATING (ne broje se u signale): ADX≥dynamic, 6Sc≥4, RSI asimetričan | 5mSR blokira u run()
  // Maknuti: CRS (WR 14%), ADXsn (obavezan), 6Sc (obavezan)
  // REVERSANI (WR<31.5% kada ▲ → logika invertirana):
  //   E50, RSI zona, E55, CVD, VOL, MCC — contrarian/pullback interpretacija
  const sigs = [
    price > ema50 ? -1 : 1,                          //  1. E50  REV: cijena>EMA50 = previsoko = -1, ispod = pullback = +1
    rsi < 45 ? -1 : rsi > 55 ? 1 : 0,               //  2. RSI  REV: RSI>55 = momentum = +1, RSI<45 = slabi = -1
    price > ema55 ? -1 : 1,                          //  3. E55  REV: cijena>EMA55 = previsoko = -1, ispod = pullback = +1
    chop < 61.8 ? 1 : -1,                            //  4. CHP: nije choppy = +1 (normalan)
    cvdSum > 0 ? -1 : 1,                             //  5. CVD  REV: kupni vol = već uđeni = -1, prodajni = potenc. dno = +1
    (rsiMin5 < 35 && rsi > 35 && rsiRising) ? 1
      : (rsiMax5 > 65 && rsi < 65 && rsiFalling) ? -1 : 0, //  6. R⟳: RSI recovery (normalan)
    macdHist !== null ? (macdHist > 0 ? 1 : -1) : 0, //  7. MCD: MACD histogram (normalan)
    price > ema145 ? 1 : -1,                          //  8. E145: dugoročni trend (normalan)
    volLast > volAvg20 ? -1 : 0,                      //  9. VOL  REV: visoki vol = kasni ulaz = -1, low vol = 0 (neutralan)
    macdCrossUp ? -1 : macdCrossDn ? 1 : 0,           // 10. MCC  REV: cross gore = kasno = -1, cross dolje = dno = +1
    rsiRising ? 1 : rsiFalling ? -1 : 0,              // 11. RSI↗: RSI smjer (normalan)
    sig17sr,                                           // 12. SRS: S/R bounce (normalan)
    sig18bk,                                           // 13. SRB: S/R breakout (normalan)
  ];

  const bullCnt = sigs.filter(s => s === 1).length;
  const bearCnt = sigs.filter(s => s === -1).length;

  // ══ 3 OBAVEZNA UVJETA u signalu — sva 3 moraju biti zadovoljena (4. gate: 5mSR blokira u run()) ══

  // 1. ADX ≥ effectiveAdx — tržište mora biti u jasnom trendu (dinamički prag)
  if (adx < effectiveAdx) {
    return { price, signal: "NEUTRAL", bullScore: bullCnt, bearScore: bearCnt,
      reason: `ADX ${adx.toFixed(1)} < ${effectiveAdx} — ranging, nema ulaza` };
  }

  // 2. 6-Scale: min 4/6 multi-EMA parova poravnato u jednom smjeru
  //    Zamjenjuje EMA9/21 smjer — bolji filter, WR 43.6%
  const scaleOkLong  = scaleUp >= 4;   // 4+ bullish EMA parova → LONG smjer
  const scaleOkShort = scaleDn >= 4;   // 4+ bearish EMA parova → SHORT smjer
  if (!scaleOkLong && !scaleOkShort) {
    return { price, signal: "NEUTRAL", bullScore: bullCnt, bearScore: bearCnt,
      reason: `6Sc: ${scaleUp}↑/${scaleDn}↓ — nema jasnog smjera (treba 4/6)` };
  }

  // 3. RSI filter — asimetričan po smjeru
  const rsiLongOk  = rsi < 72;   // LONG: blokiran samo ako je ekstremno overbought
  const rsiShortOk = rsi > 30;   // SHORT: blokiran samo ako je ekstremno oversold

  // ── Min 5/13 potvrđujućih signala ──────────────────────────────────────────
  const MIN_CONFIRM = minSig;  // čita iz rules.json (trenutno 5)

  if (bullCnt >= MIN_CONFIRM && scaleOkLong && rsiLongOk) {
    // Bitmask aktivnih BULL signala za signal analizu
    const sigMask = sigs.reduce((mask, v, i) => v === 1 ? mask | (1 << i) : mask, 0);
    return { price, signal: "LONG",  bullScore: bullCnt, bearScore: bearCnt, sigMask,
      nearSup, nearRes,
      reason: `ULTRA LONG ↑${bullCnt}/13 | ADX:${adx.toFixed(0)}≥${ADX_MIN}✓ 6Sc:${scaleUp}/6✓ RSI:${rsi.toFixed(0)}<72✓ [3ob+${MIN_CONFIRM}]` };
  }
  if (!LONG_ONLY && bearCnt >= MIN_CONFIRM && scaleOkShort && rsiShortOk) {
    return { price, signal: "SHORT", bullScore: bullCnt, bearScore: bearCnt,
      nearSup, nearRes,
      reason: `ULTRA SHORT ↓${bearCnt}/13 | ADX:${adx.toFixed(0)}≥${ADX_MIN}✓ 6Sc:${scaleDn}/6✓ RSI:${rsi.toFixed(0)}>30✓ [3ob+${MIN_CONFIRM}]` };
  }
  if (LONG_ONLY && bearCnt >= MIN_CONFIRM && scaleOkShort && rsiShortOk) {
    return { price, signal: "NEUTRAL", bullScore: bullCnt, bearScore: bearCnt,
      reason: `SHORT↓${bearCnt}/13 blokiran — LONG_ONLY mod aktivan` };
  }

  // Dijagnoza zašto nema signala
  const dirStr = scaleOkLong ? `LONG(${scaleUp}/6)` : scaleOkShort ? `SHORT(${scaleDn}/6)` : `6Sc✗`;
  const whyNot = bullCnt >= bearCnt
    ? `↑${bullCnt}/13 ${dirStr}${!rsiLongOk ? ` RSI${rsi.toFixed(0)}≥72✗` : ""}`
    : `↓${bearCnt}/13 ${dirStr}${!rsiShortOk ? ` RSI${rsi.toFixed(0)}≤30✗` : ""}`;
  return { price, signal: "NEUTRAL", bullScore: bullCnt, bearScore: bearCnt,
    reason: `ULTRA: ${whyNot} (treba 4ob+${MIN_CONFIRM}/13)` };
}

// ─── ULTRA Immediate Entry ─────────────────────────────────────────────────────
// Ulaz odmah na close signal-svjećice — bez čekanja H/L breakouta.
// Signal pali → trade se otvara na trenutnoj cijeni (close zadnje svjećice).

// ── 5m S/R test helper ────────────────────────────────────────────────────────
// Vraća true ako je cijena u zadnjih 10 svjećica na 5m testirala S/R razinu
// i odbila se u smjeru signala (LONG = testirala support, SHORT = testirala resistance)
export async function check5mSRTest(symbol, signalSide) {
  try {
    const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=5m&limit=80`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.code !== "00000" || !json.data?.length) return false;

    const c5 = json.data.map(k => ({
      high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
    }));
    const n5    = c5.length;
    const price = c5[n5 - 1].close;

    // Pivot S/R na 5m (N=3, lookback 60 bara)
    const pivN = 3, srLookback = 60;
    const srStart = Math.max(pivN, n5 - srLookback);
    const srEnd   = n5 - pivN - 1;
    const resistances5 = [], supports5 = [];
    for (let i = srStart; i <= srEnd; i++) {
      let ph = true, pl = true;
      for (let j = i - pivN; j <= i + pivN; j++) {
        if (j === i || j < 0 || j >= n5) continue;
        if (c5[j].high >= c5[i].high) ph = false;
        if (c5[j].low  <= c5[i].low)  pl = false;
      }
      if (ph) resistances5.push(c5[i].high);
      if (pl) supports5.push(c5[i].low);
    }

    const srZone = 0.015; // 1.5% zona oko S/R razine

    // Provjeri zadnjih 10 svjećica: je li cijena bila u S/R zoni?
    const lookback10 = c5.slice(n5 - 10);

    if (signalSide === "LONG") {
      // Tražimo: wick/close dodirnuo support, ali se current close vratio gore
      const supBelow = supports5.filter(s => s < price * 1.01).sort((a, b) => b - a);
      const nearSup  = supBelow[0] ?? null;
      if (!nearSup) return false;
      const touched = lookback10.some(bar => bar.low <= nearSup * (1 + srZone));
      const recovered = price > nearSup * (1 + srZone * 0.3);
      return touched && recovered;
    } else {
      // SHORT: tražimo: wick/close dodirnuo resistance, ali se vratio dolje
      const resAbove = resistances5.filter(r => r > price * 0.99).sort((a, b) => a - b);
      const nearRes  = resAbove[0] ?? null;
      if (!nearRes) return false;
      const touched  = lookback10.some(bar => bar.high >= nearRes * (1 - srZone));
      const rejected = price < nearRes * (1 - srZone * 0.3);
      return touched && rejected;
    }
  } catch (e) {
    console.log(`  ⚠️  [5m SR] ${symbol}: ${e.message}`);
    return false;
  }
}

async function analyzeUltraPullback(symbol, candles, cfg) {
  const last  = candles[candles.length - 1];
  const price = last.close;

  // Očisti stale pending zapise (legacy)
  const pid = "synapse_t";
  let pending = loadPending(pid);
  pending = pending.filter(p => p.symbol !== symbol);
  savePending(pid, pending);

  // Pokreni 15m analizu
  const result = analyzeUltra(candles, cfg);

  if (result.signal === "LONG" || result.signal === "SHORT") {
    // 5m S/R test — informativan, NE blokira ulaz
    const srOk = await check5mSRTest(symbol, result.signal).catch(() => null);
    const srLabel = srOk === true ? "5mSR✓" : srOk === false ? "5mSR✗(info)" : "5mSR?";
    console.log(`  ✅ [ULTRA] ${symbol} ${result.signal} @ ${fmtPrice(price)} — 3 uvjeta OK (${result.bullScore ?? 0}↑/${result.bearScore ?? 0}↓ | ${srLabel})`);
  }

  return result;
}

// ─── SYNAPSE-7 Pullback Entry ──────────────────────────────────────────────────
// Umjesto immediate entry, čeka 1% pullback od signal cijene
// LONG signal → čeka pad -1% → tek onda ulaz
// SHORT signal → čeka rast +1% → tek onda ulaz

const PULLBACK_PCT  = 1.0;   // % pullback koji čekamo
const PULLBACK_TTL  = 4 * 60 * 60 * 1000;  // 4h — cancel ako ne dođe

function pendingFile(pid) { return `${DATA_DIR}/pending_${pid}.json`; }

function loadPending(pid) {
  const f = pendingFile(pid);
  if (!existsSync(f)) return [];
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return []; }
}

function savePending(pid, list) {
  writeFileSync(pendingFile(pid), JSON.stringify(list, null, 2));
}

async function analyzeSynapse7Pullback(symbol, candles, cfg) {
  const last   = candles[candles.length - 1];
  const price  = last.close;
  const pid    = "synapse7";

  // 1) Provjeri postoji li pending za ovaj simbol
  let pending = loadPending(pid);
  const now   = Date.now();

  // Makni stare (TTL istekao)
  pending = pending.filter(p => now - p.ts < PULLBACK_TTL);

  const existing = pending.find(p => p.symbol === symbol);

  if (existing) {
    // Provjeri breakout — koristimo HIGH/LOW trenutne svijeće (ne close)
    const hit = existing.side === "LONG"
      ? last.high > existing.triggerHigh
      : last.low  < existing.triggerLow;

    if (hit) {
      pending = pending.filter(p => p.symbol !== symbol);
      savePending(pid, pending);
      const baseResult = analyzeSynapse7(candles, cfg);
      return {
        ...baseResult,
        signal: existing.side,
        price,
        reason: `[S7 BRK ${existing.side}] Signal @ ${fmtPrice(existing.signalPrice)} | breakout @ ${fmtPrice(price)}`,
      };
    }

    // Cancel ako score pao ili signal flipnuo
    const freshResult = analyzeSynapse7(candles, cfg);
    if (freshResult.signal !== existing.side) {
      pending = pending.filter(p => p.symbol !== symbol);
      savePending(pid, pending);
      console.log(`  🔄 [SYNAPSE-7] ${symbol} — pending ${existing.side} canceliran (${freshResult.signal === "NEUTRAL" ? "score pao" : "flip"})`);
    } else {
      console.log(`  ⏳ [SYNAPSE-7] ${symbol} ${existing.side} čeka breakout | TrigH:${fmtPrice(existing.triggerHigh)} TrigL:${fmtPrice(existing.triggerLow)} | CandH:${fmtPrice(last.high)} CandL:${fmtPrice(last.low)} | Close:${fmtPrice(price)}`);
    }
    return { price, signal: "NEUTRAL", reason: `Čeka S7 breakout H:${fmtPrice(existing.triggerHigh)} L:${fmtPrice(existing.triggerLow)}` };
  }

  // 2) Nema pendinga — pokreni normalnu analizu
  const result = analyzeSynapse7(candles, cfg);

  if (result.signal === "LONG" || result.signal === "SHORT") {
    const sigCandle   = candles[candles.length - 1];
    const triggerHigh = sigCandle.high;
    const triggerLow  = sigCandle.low;

    pending.push({ symbol, side: result.signal, signalPrice: price, triggerHigh, triggerLow, ts: now });
    savePending(pid, pending);
    console.log(`  📌 [SYNAPSE-7] ${symbol} ${result.signal} signal @ ${fmtPrice(price)} → čeka breakout H:${fmtPrice(triggerHigh)} L:${fmtPrice(triggerLow)}`);
    return { price, signal: "NEUTRAL", reason: `S7 signal, čeka breakout H:${fmtPrice(triggerHigh)} L:${fmtPrice(triggerLow)}` };
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

// Cache pricePlace po simbolu (dohvat iz BitGet contracts API)
const _pricePlace = {};

async function loadPricePrecision() {
  try {
    const url = `${BITGET.baseUrl}/api/v2/mix/market/contracts?productType=USDT-FUTURES`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.code === "00000" && Array.isArray(json.data)) {
      for (const c of json.data) {
        if (c.symbol && c.pricePlace !== undefined) {
          _pricePlace[c.symbol] = parseInt(c.pricePlace);
        }
      }
      console.log(`✅ Učitano ${Object.keys(_pricePlace).length} simbola s pricePlace`);
    }
  } catch (e) {
    console.log(`⚠️  loadPricePrecision greška: ${e.message}`);
  }
}

function fmtPrice(p, symbol) {
  if (!p && p !== 0) return "";
  if (symbol && _pricePlace[symbol] !== undefined) {
    return p.toFixed(_pricePlace[symbol]);
  }
  // Fallback ako nema podataka za simbol
  if (p >= 1000)  return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  if (p >= 0.001) return p.toFixed(6);
  return p.toFixed(8);
}

// ─── Portfolio position tracking ───────────────────────────────────────────────

function posFile(pid) { return `${DATA_DIR}/open_positions_${pid}.json`; }

export function loadPositions(pid) {
  const f = posFile(pid);
  if (!existsSync(f)) return [];
  try { return JSON.parse(readFileSync(f, "utf8")); }
  catch { return []; }
}

export function savePositions(pid, positions) {
  writeFileSync(posFile(pid), JSON.stringify(positions, null, 2));
}

function addPosition(pid, entry) {
  const positions = loadPositions(pid);
  positions.push({
    symbol:     entry.symbol,
    side:       entry.signal,
    entryPrice: entry.price,
    quantity:   entry.tradeSize / entry.price,
    totalUSD:   entry.tradeSize,
    margin:     entry.margin,
    sl:         entry.sl,
    tp:         entry.tp,
    slPct:      entry.slPct ?? null,    // za BE-STOP i log
    tpPct:      entry.tpPct ?? null,    // za BE-STOP threshold
    sigMask:    entry.sigMask ?? null,  // za signal analitiku
    orderId:    entry.orderId,
    mode:       entry.mode || (PAPER_TRADING ? "PAPER" : BITGET_DEMO ? "DEMO" : "LIVE"),
    openedAt:   entry.timestamp,
    openTs:     Date.now(),
    portfolio:  pid,
    strategy:   entry.strategy,
    timeframe:  entry.timeframe || "1H",
  });
  savePositions(pid, positions);
}

// ─── Trailing SL/TP ─────────────────────────────────────────────────────────────
// Aktivira se za strategije s trail podrškom (synapse_t).
// Koraci od 0.5%: svaki put kad gain dostigne trigger, SL i TP se pomiču gore.
// Formula:
//   steps = floor((gainPct − TRAIL_TRIGGER) / TRAIL_STEP)   (0, 1, 2, ...)
//   newSlPct = TRAIL_TRIGGER + steps × TRAIL_STEP          (2.5, 3.0, 3.5, ...)
//   newTpPct = origTpPct   + (steps+1) × TRAIL_STEP        (3.5, 4.0, 4.5, ...)

const TRAIL_STRATEGIES = ["synapse_t"];  // koje strategije koriste trail
const TRAIL_TRIGGER    = 2.5;            // % gain koji aktivira trail
const TRAIL_STEP       = 0.5;            // korak pomaka SL i TP (%)

function applyTrail(pos, currentPrice) {
  if (!TRAIL_STRATEGIES.includes(pos.strategy)) return false;

  const entry = pos.entryPrice;
  const gainPct = pos.side === "LONG"
    ? (currentPrice - entry) / entry * 100
    : (entry - currentPrice) / entry * 100;

  if (gainPct < TRAIL_TRIGGER) return false;

  const steps     = Math.floor((gainPct - TRAIL_TRIGGER) / TRAIL_STEP);
  const origTpPct = pos.side === "LONG"
    ? (pos.origTp ?? pos.tp - entry) / entry * 100   // origTp za referentni TP
    : (entry - (pos.origTp ?? pos.tp)) / entry * 100;

  // Izračun novih razina
  const newSlPct = TRAIL_TRIGGER + steps * TRAIL_STEP;
  const newTpPct = (pos.origTpPct ?? origTpPct) + (steps + 1) * TRAIL_STEP;

  let newSl, newTp;
  if (pos.side === "LONG") {
    newSl = entry * (1 + newSlPct / 100);
    newTp = entry * (1 + newTpPct / 100);
    if (newSl <= pos.sl && newTp <= pos.tp) return false;  // ništa novo
    pos.sl = Math.max(pos.sl, newSl);
    pos.tp = Math.max(pos.tp, newTp);
  } else {
    newSl = entry * (1 - newSlPct / 100);
    newTp = entry * (1 - newTpPct / 100);
    if (newSl >= pos.sl && newTp >= pos.tp) return false;
    pos.sl = Math.min(pos.sl, newSl);
    pos.tp = Math.min(pos.tp, newTp);
  }

  // Pohrani originalni TP% za referencu (samo prvi put)
  if (!pos.origTpPct) pos.origTpPct = origTpPct;

  return true;  // pozicija ažurirana
}

// Dohvati sve stvarno otvorene pozicije na Bitgetu (za sve simbole)
export async function fetchBitgetOpenPositions() {
  try {
    const path = "/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT";
    const ts   = Date.now().toString();
    const sign = signBitGet(ts, "GET", path);
    const r    = await fetch(`${BITGET.baseUrl}${path}`, {
      headers: {
        "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET.passphrase,
        "Content-Type": "application/json",
      },
    });
    const d = await r.json();
    if (d.code !== "00000") return null;
    // Vrati set "SYMBOL:holdSide" koji su stvarno otvoreni
    const open = new Set();
    for (const p of (d.data || [])) {
      if (parseFloat(p.total) > 0) {
        open.add(`${p.symbol}:${p.holdSide}`);  // npr. "BTCUSDT:long"
      }
    }
    return open;
  } catch (e) {
    console.log(`  ⚠️  fetchBitgetOpenPositions greška: ${e.message}`);
    return null;
  }
}

// Dohvati stvarni P&L zatvorene pozicije iz Bitget historije
async function fetchBitgetClosedPnl(symbol, pos) {
  try {
    const path = `/api/v2/mix/order/fill-history?symbol=${symbol}&productType=USDT-FUTURES&limit=50`;
    const ts   = Date.now().toString();
    const sign = signBitGet(ts, "GET", path);
    const r    = await fetch(`${BITGET.baseUrl}${path}`, {
      headers: {
        "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET.passphrase,
        "Content-Type": "application/json",
      },
    });
    const d = await r.json();
    if (d.code !== "00000" || !d.data?.fillList?.length) return null;

    // Filtriraj samo CLOSE fillove NAKON otvaranja pozicije
    // openedAt je ISO string ("2026-05-10T12:34:56.789Z"), openTs je ms timestamp
    const openTs = pos?.openTs
      || (pos?.openedAt ? new Date(pos.openedAt).getTime() : 0)
      || (pos?.ts       ? new Date(pos.ts).getTime()       : 0);
    const expectedCloseSide = pos?.side === "LONG" ? "close_long" : "close_short";

    const closeFills = d.data.fillList.filter(f => {
      const fillTs = parseInt(f.cTime || f.uTime || f.time || 0);
      const isAfterOpen = !openTs || fillTs >= openTs - 60_000;  // dopusti 1min toleranciju
      const isClose = f.side === expectedCloseSide
        || f.tradeSide === "close"
        || f.tradeSide === "burst_close"   // likvidacija
        || f.tradeSide === "forced_close"; // prisilno zatvaranje
      return isClose && isAfterOpen;
    });

    if (!closeFills.length) {
      console.log(`  ⚠️  [fetchBitgetClosedPnl] ${symbol} — nema close fillova nakon openTs=${openTs}`);
      return null;
    }

    // Sumej sve close fillove (može biti parcijalno zatvaranje)
    const totalQty     = closeFills.reduce((s, f) => s + parseFloat(f.size  || 0), 0);
    const avgExitPrice = closeFills.reduce((s, f) => s + parseFloat(f.price || 0) * parseFloat(f.size || 0), 0) / (totalQty || 1);
    const totalFee     = closeFills.reduce((s, f) => s + Math.abs(parseFloat(f.fee || 0)), 0);

    // Sanity check: avgExitPrice mora biti >0
    if (!avgExitPrice || avgExitPrice <= 0) {
      console.log(`  ⚠️  [fetchBitgetClosedPnl] ${symbol} — avgExitPrice=${avgExitPrice} je nevažeći`);
      return null;
    }

    // P&L = razlika cijene × količina
    const qty     = pos?.quantity ?? (pos?.totalUSD / pos?.entryPrice) ?? totalQty;
    const entryPx = pos?.entryPrice ?? parseFloat(closeFills[0].price);
    const rawPnl  = pos?.side === "LONG"
      ? (avgExitPrice - entryPx) * qty
      : (entryPx - avgExitPrice) * qty;

    // Sanity cap: P&L ne može biti gori od gubitka cijele margine
    const maxLoss = pos?.margin ? pos.margin * 1.1 : (pos?.totalUSD ?? 999);  // +10% za fees
    const pnlCapped = Math.max(rawPnl, -maxLoss);
    if (pnlCapped !== rawPnl) {
      console.log(`  ⚠️  [fetchBitgetClosedPnl] ${symbol} — P&L capped ${rawPnl.toFixed(2)} → ${pnlCapped.toFixed(2)} (maxLoss=${maxLoss.toFixed(2)})`);
    }

    console.log(`  📊 [fetchBitgetClosedPnl] ${symbol} ${pos?.side} | exit=${avgExitPrice.toFixed(6)} entry=${entryPx.toFixed(6)} qty=${qty.toFixed(4)} fills=${closeFills.length} pnl=${pnlCapped.toFixed(4)}`);

    return {
      exitPrice:    avgExitPrice,
      realizedPnl:  pnlCapped,
      fee:          totalFee,
      side:         expectedCloseSide,
    };
  } catch (e) {
    console.log(`  ⚠️  fetchBitgetClosedPnl greška: ${e.message}`);
    return null;
  }
}

async function checkPortfolioPositions(pid) {
  const positions = loadPositions(pid);
  if (positions.length === 0) return;
  console.log(`  🔍 [${pid}] Provjera ${positions.length} pozicija`);

  // Za LIVE portfolije: dohvati stvarno otvorene pozicije s Bitgeta
  const pDef = buildPortfolios(JSON.parse(readFileSync("rules.json", "utf8")))[pid];
  const isLivePortfolio = pDef?.live === true && !PAPER_TRADING;
  const bitgetOpen = isLivePortfolio ? await fetchBitgetOpenPositions() : null;

  const stillOpen = [];

  for (const pos of positions) {
    try {
      const holdSide = pos.side === "LONG" ? "long" : "short";
      const bitgetKey = `${pos.symbol}:${holdSide}`;

      // ── LIVE: provjeri je li Bitget zatvorio poziciju ─────────────────────
      if (isLivePortfolio && bitgetOpen !== null) {
        if (!bitgetOpen.has(bitgetKey)) {
          // Pozicija zatvorena na Bitgetu (SL/TP/likvidacija) — dohvati stvarni P&L
          const closed = await fetchBitgetClosedPnl(pos.symbol, pos);
          // exitPrice fallback: nikad 0 — koristi sl, pa procijenjeni SL od entry cijene (per-symbol)
          const _closedRules   = JSON.parse(readFileSync("rules.json", "utf8"));
          const _symSltp       = _closedRules.symbol_sltp?.[pos.symbol] || {};
          const _slPctFallback = pos.slPct ?? _symSltp.slPct ?? pDef?.slPct ?? SL_PCT;
          const estimatedSl = pos.side === "LONG"
            ? pos.entryPrice * (1 - _slPctFallback / 100)
            : pos.entryPrice * (1 + _slPctFallback / 100);
          const exitPrice  = (closed?.exitPrice  > 0) ? closed.exitPrice
                           : (pos.sl             > 0) ? pos.sl
                           : estimatedSl;
          const realPnl    = closed?.realizedPnl ?? null;
          const fee        = closed?.fee         ?? 0;

          // Odredi razlog zatvaranja
          let exitReason = "Zatvoreno na Bitgetu";
          if (closed?.side?.includes("close")) {
            const priceDiff = pos.side === "LONG"
              ? exitPrice - pos.entryPrice
              : pos.entryPrice - exitPrice;
            exitReason = priceDiff > 0 ? "TP dostignut" : "SL/Likvidacija";
          }

          // P&L: koristi stvarni Bitget P&L ako dostupan, inače kalkuliraj
          const qty = pos.quantity ?? (pos.totalUSD / pos.entryPrice);
          const rawCalcPnl = pos.side === "LONG"
            ? (exitPrice - pos.entryPrice) * qty
            : (pos.entryPrice - exitPrice) * qty;
          const calcPnl = realPnl !== null ? realPnl : rawCalcPnl;

          // Sanity cap: maksimalni gubitak = margina × 1.1 (uključuje fees/funding)
          const maxLoss = pos.margin ? pos.margin * 1.1 : pos.totalUSD * 0.02;
          const pnl = Math.max(calcPnl, -maxLoss);
          if (pnl !== calcPnl) {
            console.log(`  ⚠️  P&L capped: ${calcPnl.toFixed(4)} → ${pnl.toFixed(4)} (maxLoss=${maxLoss.toFixed(2)}) — mogući problem s fill fetchom`);
          }

          console.log(`  ${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [${pid}] ${pos.symbol} ${pos.side} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} | ${exitReason} | exit@${fmtPrice(exitPrice)}`);
          writeExitCsv(pid, pos, exitPrice, exitReason, pnl);
          await tg(`${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [ULTRA] ${pos.symbol} ${pos.side}\nP&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${exitReason}\nUlaz: ${fmtPrice(pos.entryPrice)} → Izlaz: ${fmtPrice(exitPrice)}`);
          // 4. Signal analiza — bilježi outcome po signalima
          if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, pnl >= 0);
          recordSymbolOutcome(pos.symbol, pnl >= 0);

          if (pnl < 0) {
            // Cooldown 4h — ne ulazi ponovo u ovaj simbol
            symbolSlCooldown.set(pos.symbol, Date.now());
            console.log(`  🕐 [${pid}] ${pos.symbol} — cooldown 4h aktivan (SL hit)`);
            // 2. Blacklist — 3 uzastopna SL → 24h ban
            await recordSymbolSl(pid, pos.symbol);
            await checkAndRemoveSymbol(pid, pos.symbol);
          }
          // Svaki 5. trade ispiši signal statistiku
          { const st = loadSigStats(); const tot = Object.values(st).reduce((s,v)=>s+v.total,0); if(tot>0&&tot%5===0) printSigStats(); }
          continue;  // Ne dodaj u stillOpen
        }
        // Još uvijek otvorena na Bitgetu — prikaz unrealized
        const prices = await fetchLivePrices([pos.symbol]);
        const liveP  = prices[pos.symbol] || pos.entryPrice;
        const qty    = pos.quantity ?? (pos.totalUSD / pos.entryPrice);
        const unrealized = pos.side === "LONG"
          ? (liveP - pos.entryPrice) * qty
          : (pos.entryPrice - liveP) * qty;

        // ── BE-STOP: ako je 50%+ TP dostignut → pomakni SL na entry+buffer ──
        if (!pos.beMoved && isLivePortfolio) {
          const tpPct   = pos.tpPct ?? 4.0;
          const pricePct = pos.side === "LONG"
            ? (liveP - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - liveP) / pos.entryPrice * 100;
          const tpProgress = pricePct / tpPct * 100;

          if (tpProgress >= BE_TRIGGER_PCT) {
            console.log(`  🎯 [BE-STOP] ${pos.symbol} ${pos.side} — ${tpProgress.toFixed(0)}% TP dostignut → pomičem SL na BE`);
            const moved = await moveSLtoBreakEven(pos);
            if (moved) {
              pos.beMoved = true;
              // Spremi ažuriranu poziciju
              const allPos = loadPositions(pid);
              const idx    = allPos.findIndex(p => p.symbol === pos.symbol && p.side === pos.side);
              if (idx >= 0) { allPos[idx].beMoved = true; savePositions(pid, allPos); }
            }
          }
        }

        // ── TRAILING STOP: aktivira se kad je TRAIL_ACTIVATE_PCT% u profitu ──
        if (isLivePortfolio) {
          const pricePct = pos.side === "LONG"
            ? (liveP - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - liveP) / pos.entryPrice * 100;

          if (pricePct >= TRAIL_ACTIVATE_PCT) {
            const peak = pos.side === "LONG"
              ? Math.max(pos.trailPeak || 0, liveP)
              : Math.min(pos.trailPeak || Infinity, liveP);
            const prevPeak = pos.trailPeak;

            if (prevPeak === undefined || prevPeak === null ||
                (pos.side === "LONG" && peak > prevPeak) ||
                (pos.side === "SHORT" && peak < prevPeak)) {
              const newSl = pos.side === "LONG"
                ? peak * (1 - TRAIL_SL_PCT / 100)
                : peak * (1 + TRAIL_SL_PCT / 100);
              const improving = pos.side === "LONG" ? newSl > (pos.sl || 0) : newSl < (pos.sl || Infinity);
              if (improving) {
                const moved = await updateTrailSL(pos, newSl);
                if (moved) {
                  const allPos = loadPositions(pid);
                  const idx    = allPos.findIndex(p => p.symbol === pos.symbol && p.side === pos.side);
                  if (idx >= 0) { allPos[idx].trailPeak = peak; allPos[idx].sl = newSl; savePositions(pid, allPos); }
                  pos.trailPeak = peak; pos.sl = newSl;
                  console.log(`  📈 [TRAIL] ${pos.symbol} ${pos.side} — peak ${fmtPrice(peak)} → trail SL: ${fmtPrice(newSl)}`);
                }
              }
            }
          }
        }

        const trailInfo = pos.trailPeak ? ` | 📈 TRAIL peak ${fmtPrice(pos.trailPeak)}` : "";
        console.log(`  ⏳ [${pid}] ${pos.symbol} ${pos.side} | Ulaz ${fmtPrice(pos.entryPrice)} | Sad ${fmtPrice(liveP)} | P&L ${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(4)}${pos.beMoved ? " | 🔒 BE-STOP aktivan" : ""}${trailInfo}`);
        stillOpen.push(pos);
        continue;
      }

      // ── PAPER: provjera candle-om (stara logika) ──────────────────────────
      const candles = await fetchCandles(pos.symbol, pos.timeframe || "15m", 5);
      const bar     = candles[candles.length - 1];

      let exitPrice = null, exitReason = null;
      if (pos.side === "LONG") {
        if (bar.high >= pos.tp)     { exitPrice = pos.tp; exitReason = "TP dostignut"; }
        else if (bar.low <= pos.sl) { exitPrice = pos.sl; exitReason = "SL dostignut"; }
      } else {
        if (bar.low  <= pos.tp)     { exitPrice = pos.tp; exitReason = "TP dostignut"; }
        else if (bar.high >= pos.sl){ exitPrice = pos.sl; exitReason = "SL dostignut"; }
      }

      if (exitPrice !== null) {
        const qty = pos.quantity ?? (pos.totalUSD / pos.entryPrice);
        const pnl = pos.side === "LONG"
          ? (exitPrice - pos.entryPrice) * qty
          : (pos.entryPrice - exitPrice) * qty;
        console.log(`  ${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [${pid}] ${pos.symbol} ${pos.side} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);
        writeExitCsv(pid, pos, exitPrice, exitReason, pnl);
        await tg(`${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [ULTRA] ${pos.symbol} ${pos.side}\nP&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${exitReason}`);
        if (pnl < 0) await checkAndRemoveSymbol(pid, pos.symbol);
      } else {
        const unrealized = pos.side === "LONG"
          ? (bar.close - pos.entryPrice) * (pos.quantity ?? 0)
          : (pos.entryPrice - bar.close) * (pos.quantity ?? 0);
        console.log(`  ⏳ [${pid}] ${pos.symbol} ${pos.side} | Ulaz ${fmtPrice(pos.entryPrice)} | Sad ${fmtPrice(bar.close)} | P&L ${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(4)}`);
        stillOpen.push(pos);
      }
    } catch (err) {
      console.log(`  ⚠️  [${pid}] ${pos.symbol}: ${err.message}`);
      stillOpen.push(pos);
    }
  }

  savePositions(pid, stillOpen);
}

// ─── Portfolio CSV ──────────────────────────────────────────────────────────────

function csvFilePath(pid) { return `${DATA_DIR}/trades_${pid}.csv`; }

const CSV_HEADERS = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net P&L,SL,TP,Order ID,Mode,Portfolio,Notes";

function initCsv(pid) {
  const f = csvFilePath(pid);
  if (!existsSync(f)) writeFileSync(f, CSV_HEADERS + "\n");
}

function writeEntryCsv(pid, entry) {
  const now  = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const qty  = (entry.tradeSize / entry.price).toFixed(6);
  const fee  = (entry.tradeSize * 0.0006).toFixed(4);  // Bitget taker 0.06%
  const mode = PAPER_TRADING ? "PAPER" : BITGET_DEMO ? "DEMO" : "LIVE";

  const row = [
    date, time, "BitGet", entry.symbol, entry.signal,
    qty, fmtPrice(entry.price), entry.tradeSize.toFixed(2),
    fee, "OPEN",
    fmtPrice(entry.sl), fmtPrice(entry.tp),
    entry.orderId || "", mode, pid,
    `"${entry.strategy} | SL ${entry.slPct??SL_PCT}% TP ${entry.tpPct??TP_PCT}%"`,
  ].join(",");

  appendFileSync(csvFilePath(pid), row + "\n");
}

// ─── Portfolio Equity ────────────────────────────────────────────────────────────
// Stvarna raspoloživa equity = START_CAPITAL + zatvoreni P&L − rizik otvorenih pozicija.
// Svaka otvorena pozicija "zaključava" točno riskAmount = tradeSize × slPct/100.
// Na taj način sljedeći trade se uvijek veliča prema trenutno raspoloživom kapitalu.
function getPortfolioEquity(pid, startCapital = START_CAPITAL) {
  // 1) Baza: startCapital + suma zatvorenih Net P&L iz CSV-a
  let closedEquity = startCapital;
  const f = csvFilePath(pid);
  if (existsSync(f)) {
    try {
      const lines = readFileSync(f, "utf8").trim().split("\n");
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        const netPnlStr = cols[9]?.trim();          // indeks 9 = Net P&L
        if (!netPnlStr || netPnlStr === "OPEN") continue;
        const val = parseFloat(netPnlStr);
        if (isFinite(val)) closedEquity += val;
      }
    } catch { /* nastavi s START_CAPITAL */ }
  }

  // 2) Oduzmi rizik svih trenutno otvorenih pozicija
  //    riskAmount = totalUSD × |entryPrice − sl| / entryPrice
  //    (rekonstruiramo slPct iz stvarnih cijena — slPct nije pohranjen u JSON-u)
  let lockedRisk = 0;
  for (const pos of loadPositions(pid)) {
    if (pos.totalUSD && pos.entryPrice && pos.sl) {
      const slPctReal = Math.abs(pos.entryPrice - pos.sl) / pos.entryPrice;
      lockedRisk += pos.totalUSD * slPctReal;
    }
  }

  return closedEquity - lockedRisk;
}

// ─── Pravi BitGet equity (za live mod drawdown provjeru) ───────────────────────
// Vraća null ako nije live ili ako API poziv padne
let _lastBitgetEquity = null;
let _lastBitgetEquityTs = 0;
const BITGET_EQUITY_TTL = 60_000; // cache 60s

async function fetchBitgetEquity() {
  if (PAPER_TRADING) return null;
  if (Date.now() - _lastBitgetEquityTs < BITGET_EQUITY_TTL && _lastBitgetEquity !== null) {
    return _lastBitgetEquity;
  }
  try {
    const path = "/api/v2/mix/account/accounts?productType=USDT-FUTURES";
    const ts   = Date.now().toString();
    const sign = crypto.createHmac("sha256", BITGET.secretKey)
      .update(`${ts}GET${path}`).digest("base64");
    const res = await fetch(`${BITGET.baseUrl}${path}`, {
      headers: {
        "ACCESS-KEY":        BITGET.apiKey,
        "ACCESS-SIGN":       sign,
        "ACCESS-TIMESTAMP":  ts,
        "ACCESS-PASSPHRASE": BITGET.passphrase,
        "Content-Type":      "application/json",
      },
    });
    const d = await res.json();
    if (d.code !== "00000" || !d.data?.[0]) return null;
    const acc = d.data[0];
    const eq  = parseFloat(acc.usdtEquity || acc.equity || acc.available || 0);
    if (eq > 0) {
      _lastBitgetEquity   = eq;
      _lastBitgetEquityTs = Date.now();
    }
    return eq > 0 ? eq : null;
  } catch (e) {
    console.log(`  ⚠️  fetchBitgetEquity: ${e.message}`);
    return null;
  }
}

export function writeExitCsv(pid, pos, exitPrice, reason, pnl) {
  const now     = new Date();
  const date    = now.toISOString().slice(0, 10);
  const time    = now.toISOString().slice(11, 19);
  const exitSide = pos.side === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT";
  const feeExit  = pos.totalUSD * 0.0006;              // Bitget taker 0.06% — izlaz
  const feeEntry = pos.totalUSD * 0.0006;              // Bitget taker 0.06% — ulaz
  const feeTotal = (feeExit + feeEntry).toFixed(4);    // roundtrip provizija
  const netPnl   = (pnl - feeExit - feeEntry).toFixed(4);
  const icon    = pnl >= 0 ? "WIN" : "LOSS";

  const row = [
    date, time, "BitGet", pos.symbol,
    exitSide,
    pos.quantity.toFixed(6),
    fmtPrice(exitPrice),
    pos.totalUSD.toFixed(2),
    feeTotal, netPnl,
    fmtPrice(pos.sl), fmtPrice(pos.tp),
    pos.orderId || "", pos.mode, pid,
    `"${icon}: ${reason} | Ulaz ${fmtPrice(pos.entryPrice)} → Izlaz ${fmtPrice(exitPrice)}"`,
  ].join(",");

  appendFileSync(csvFilePath(pid), row + "\n");
}

// ─── BitGet Execution ────────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  return crypto.createHmac("sha256", BITGET.secretKey.trim())
    .update(`${timestamp}${method}${path}${body}`).digest("base64");
}

async function bitgetPost(path, body) {
  const timestamp = Date.now().toString();
  const b = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "ACCESS-KEY":        BITGET.apiKey.trim(),
    "ACCESS-SIGN":       signBitGet(timestamp, "POST", path, b),
    "ACCESS-TIMESTAMP":  timestamp,
    "ACCESS-PASSPHRASE": BITGET.passphrase.trim(),
  };
  if (BITGET_DEMO) headers["x-simulated-trading"] = "1";
  const res = await fetch(`${BITGET.baseUrl}${path}`, { method: "POST", headers, body: b });
  const data = await res.json();
  if (data.code !== "00000") {
    console.log(`  ⚠️  bitgetPost ${path} → code=${data.code} msg=${data.msg}`);
  }
  return data;
}

// ─── Live cijene — batch dohvat za listu simbola ──────────────────────────────
async function fetchLivePrices(symbols) {
  const prices = {};
  await Promise.all(symbols.map(async sym => {
    try {
      const url = `${BITGET.baseUrl}/api/v2/mix/market/ticker?symbol=${sym}&productType=USDT-FUTURES`;
      const tj  = await fetch(url).then(r => r.json());
      const raw = tj?.data?.[0]?.lastPr || tj?.data?.[0]?.close || 0;
      prices[sym] = parseFloat(raw) || 0;
    } catch { /* fallback na 0 — caller koristi entryPrice ako 0 */ }
  }));
  return prices;
}

// ─── Break-Even Stop — pomakni SL na entry+buffer kad je 50% TP dostignuto ────
const BE_TRIGGER_PCT = 50;   // % TP-a koji mora biti dostignut
const BE_BUFFER_PCT  = 0.2;  // % iznad/ispod entry za SL (pokrije fees)

async function moveSLtoBreakEven(pos) {
  if (pos.beMoved) return;  // već pomaknuto
  if (PAPER_TRADING) return;

  const { symbol, side, entryPrice, slPct, tpPct } = pos;
  const holdSide = side === "LONG" ? "long" : "short";

  // Novi SL: entry ± buffer
  // LONG:  SL malo IZNAD entry (ako cijena padne nazad na entry → izlaz s malim dobitkom)
  // SHORT: SL malo IZNAD entry (ako cijena poraste nazad na entry → izlaz s malim gubitkom)
  // Za SHORT, SL mora biti IZNAD trenutne cijene koja je ispod entry-ja (jer je u profitu)
  // Dakle i LONG i SHORT: newSL = entry * (1 + buffer%) — IZNAD entry
  // Razlika: za LONG to je dobitak, za SHORT je to minimalni gubitak (bolje od -2%)
  const newSlPrice = entryPrice * (1 + BE_BUFFER_PCT / 100);

  try {
    // Dohvati pending TPSL ordere da pronađemo orderId SL-a
    const ts   = Date.now().toString();
    const path = `/api/v2/mix/order/orders-plan-pending?symbol=${symbol}&productType=USDT-FUTURES&planType=pos_loss`;
    const sign = signBitGet(ts, "GET", path);
    const r    = await fetch(`${BITGET.baseUrl}${path}`, {
      headers: {
        "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET.passphrase,
        "Content-Type": "application/json",
      },
    });
    const d = await r.json();
    const orders = (d.data?.entrustedList || []).filter(o => o.holdSide === holdSide);

    if (orders.length > 0) {
      // Modificiraj postojeći SL order
      const orderId = orders[0].orderId;
      const res = await bitgetPost("/api/v2/mix/order/modify-tpsl-order", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        orderId, triggerPrice: fmtPrice(newSlPrice, symbol),
      });
      if (res.code === "00000") {
        console.log(`  🔒 [BE-STOP] ${symbol} ${side} — SL pomaknut na ${fmtPrice(newSlPrice, symbol)} (+${BE_BUFFER_PCT}% od entry ${fmtPrice(entryPrice)})`);
        await tg(`🔒 <b>BE-STOP [ULTRA]</b> ${symbol} ${side}\nSL pomaknut na entry+${BE_BUFFER_PCT}%: ${fmtPrice(newSlPrice, symbol)}\nProfit zagarantiran pri povratku na entry.`);
      } else {
        // Fallback: postavi novi SL direktno
        await bitgetPost("/api/v2/mix/order/place-tpsl-order", {
          symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
          planType: "pos_loss", triggerPrice: fmtPrice(newSlPrice, symbol),
          triggerType: "mark_price", holdSide,
        });
        console.log(`  🔒 [BE-STOP] ${symbol} ${side} — novi SL na ${fmtPrice(newSlPrice, symbol)} (fallback)`);
      }
    } else {
      // Nema pending SL — postavi novi
      await bitgetPost("/api/v2/mix/order/place-tpsl-order", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        planType: "pos_loss", triggerPrice: fmtPrice(newSlPrice, symbol),
        triggerType: "mark_price", holdSide,
      });
      console.log(`  🔒 [BE-STOP] ${symbol} ${side} — SL postavljen na ${fmtPrice(newSlPrice, symbol)}`);
    }

    return true;
  } catch(e) {
    console.log(`  ⚠️  [BE-STOP] ${symbol} greška: ${e.message}`);
    return false;
  }
}

// ─── BE-STOP Fast Monitor — pozivati svakih 30s iz dashboard.js ───────────────
// Lagana petlja: dohvati live cijene za sve otvorene pozicije i odmah
// pomakni SL na break-even čim pozicija pređe 50% od TP-a.
// Ne čeka 5-min run() ciklus — reagira unutar 30 sekundi.
export async function checkBeStopAll() {
  if (PAPER_TRADING) return;
  for (const pid of PORTFOLIO_IDS) {
    try {
      const pDef = buildPortfolios(JSON.parse(readFileSync("rules.json", "utf8")))[pid];
      if (!pDef?.live) continue;

      const positions = loadPositions(pid);
      const unprotected = positions.filter(p => !p.beMoved);
      if (!unprotected.length) continue;

      const symbols = [...new Set(unprotected.map(p => p.symbol))];
      const prices  = await fetchLivePrices(symbols);

      for (const pos of unprotected) {
        const liveP = prices[pos.symbol];
        if (!liveP) continue;

        const tpPct = pos.tpPct ?? 4.0;
        const pricePct = pos.side === "LONG"
          ? (liveP - pos.entryPrice) / pos.entryPrice * 100
          : (pos.entryPrice - liveP) / pos.entryPrice * 100;
        const tpProgress = pricePct / tpPct * 100;

        if (tpProgress >= BE_TRIGGER_PCT) {
          console.log(`  🎯 [BE-STOP 30s] ${pos.symbol} ${pos.side} — ${tpProgress.toFixed(0)}% TP dostignut → pomičem SL na BE`);
          const moved = await moveSLtoBreakEven(pos);
          if (moved) {
            const allPos = loadPositions(pid);
            const idx    = allPos.findIndex(p => p.symbol === pos.symbol && p.side === pos.side);
            if (idx >= 0) { allPos[idx].beMoved = true; savePositions(pid, allPos); }
          }
        }
      }
    } catch(e) {
      console.log(`  ⚠️  [BE-STOP 30s] ${pid} greška: ${e.message}`);
    }
  }
}

async function setupSymbol(symbol) {
  // 1) Isolated margin mode
  const mm = await bitgetPost("/api/v2/mix/account/set-margin-mode", {
    symbol, productType: "USDT-FUTURES", marginCoin: "USDT", marginMode: "isolated",
  });
  if (mm.code !== "00000") console.log(`  ⚠️  marginMode ${symbol}: ${mm.msg}`);

  // 2) Leverage — BTC dobiva BTC_LEVERAGE (100x), ostali LEVERAGE (50x)
  const targetLev = symbol === "BTCUSDT" ? BTC_LEVERAGE : LEVERAGE;
  let actualLeverage = targetLev;
  for (const holdSide of ["long", "short"]) {
    let set = false;
    for (const lev of [targetLev, 75, 50, 20, 10]) {
      const lv = await bitgetPost("/api/v2/mix/account/set-leverage", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        leverage: String(lev), holdSide,
      });
      if (lv.code === "00000") {
        if (lev !== targetLev) {
          console.log(`  ℹ️  ${symbol} ${holdSide}: max leverage je ${lev}x (ne ${targetLev}x) — sizing prilagođen`);
          if (holdSide === "long") actualLeverage = lev;  // koristi long leverage kao referentni
        }
        set = true;
        break;
      }
    }
    if (!set) console.log(`  ❌  Nije uspjelo postaviti leverage za ${symbol} ${holdSide}`);
  }

  console.log(`  ⚙️  ${symbol}: isolated + ${actualLeverage}x leverage set`);
  return actualLeverage;
}

// ─── Zatvori poziciju na Bitgetu (market order, reduceOnly) ───────────────────
async function closeBitgetPosition(symbol, side, quantity) {
  const holdSide  = side === "LONG" ? "long" : "short";
  const closeSide = side === "LONG" ? "sell" : "buy";
  try {
    // Otkaži sve otvorene SL/TP naloge za ovaj simbol
    await bitgetPost("/api/v2/mix/order/cancel-plan-order", {
      symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
      planType: "profit_loss",
    }).catch(() => {});

    // Market close nalog
    const r = await bitgetPost("/api/v2/mix/order/place-order", {
      symbol, productType: "USDT-FUTURES", marginMode: "isolated", marginCoin: "USDT",
      side: closeSide, tradeSide: "close",
      orderType: "market", size: String(quantity),
    });
    if (r?.code === "00000") {
      console.log(`  🔄 [FLIP] ${symbol} ${side} zatvoreno @ market (qty=${quantity})`);
      return true;
    } else {
      console.log(`  ❌ [FLIP] Close fail: ${r?.code} ${r?.msg}`);
      return false;
    }
  } catch(e) {
    console.log(`  ❌ [FLIP] closeBitgetPosition greška: ${e.message}`);
    return false;
  }
}

async function placeBitGetOrder(symbol, side, sizeUSD, price, sl, tp, slPct, tpPct) {
  // Postavi isolated margin + leverage prije svakog naloga; vrati stvarni leverage
  const actualLeverage = await setupSymbol(symbol);
  const quantity  = (sizeUSD / price).toFixed(4);
  const holdSide  = side === "LONG" ? "long" : "short";

  // Bez preset SL/TP u main orderu — koristimo fill-adjusted tpsl-order (ne duplikat)
  const path      = "/api/v2/mix/order/place-order";
  const orderBody = {
    symbol, productType: "USDT-FUTURES",
    marginMode: "isolated", marginCoin: "USDT",
    side: side === "LONG" ? "buy" : "sell",
    tradeSide: "open", orderType: "market", size: quantity,
  };
  const orderData = await bitgetPost(path, orderBody);
  if (!orderData || orderData.code !== "00000") {
    throw new Error(`place-order fail: ${orderData?.code} ${orderData?.msg}`);
  }
  const orderId = orderData.data?.orderId || orderData.orderId;
  console.log(`  📨 Nalog otvoren: ${orderId} | čekam fill za SL/TP postavljanje...`);

  // Dohvati stvarnu fill cijenu (čekaj malo da se ispuni)
  let fillPrice = price;
  if (orderId) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const detailPath = `/api/v2/mix/order/detail?symbol=${symbol}&productType=USDT-FUTURES&orderId=${orderId}`;
      const ts2   = Date.now().toString();
      const sign2 = signBitGet(ts2, "GET", detailPath);
      const det = await fetch(`${BITGET.baseUrl}${detailPath}`, {
        headers: {
          "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign2,
          "ACCESS-TIMESTAMP": ts2, "ACCESS-PASSPHRASE": BITGET.passphrase,
          "Content-Type": "application/json",
        },
      }).then(r => r.json());
      if (det.code === "00000" && det.data?.priceAvg) {
        fillPrice = parseFloat(det.data.priceAvg);
        console.log(`  ✅ Fill cijena: ${fillPrice} (signal: ${price})`);
      }
    } catch (e) {
      console.log(`  ⚠️  Ne mogu dohvatiti fill cijenu: ${e.message}`);
    }
  }

  // Korigiraj SL/TP na temelju stvarne fill cijene (slPct/tpPct od fill, ne od signal cijene)
  const _slPct = slPct ?? SL_PCT;
  const _tpPct = tpPct ?? TP_PCT;
  const slFromFill = side === "LONG"
    ? fillPrice * (1 - _slPct / 100)
    : fillPrice * (1 + _slPct / 100);
  const tpFromFill = side === "LONG"
    ? fillPrice * (1 + _tpPct / 100)
    : fillPrice * (1 - _tpPct / 100);

  // 1) Hard SL — fiksni stop loss od fill cijene — KRITIČNO: ako fail → zatvori poziciju!
  let slOk = false;
  try {
    const slRes = await bitgetPost("/api/v2/mix/order/place-tpsl-order", {
      symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
      planType: "pos_loss",
      triggerPrice: fmtPrice(slFromFill, symbol),
      triggerType: "mark_price", holdSide,
    });
    if (slRes.code === "00000") {
      slOk = true;
      console.log(`  🛡️  Hard SL @ ${fmtPrice(slFromFill, symbol)} OK`);
    } else {
      console.log(`  🚨 Hard SL FAIL: code=${slRes.code} ${slRes.msg} — zatvaramo poziciju radi sigurnosti!`);
    }
  } catch (e) {
    console.log(`  🚨 Hard SL greška: ${e.message} — zatvaramo poziciju radi sigurnosti!`);
  }

  // Ako SL nije postavljen → zatvori poziciju odmah (ne možemo riskirati bez zaštite)
  if (!slOk) {
    try {
      await bitgetPost("/api/v2/mix/order/place-order", {
        symbol, productType: "USDT-FUTURES", marginMode: "isolated", marginCoin: "USDT",
        side: holdSide === "long" ? "sell" : "buy", tradeSide: "close",
        orderType: "market", size: quantity,
      });
      console.log(`  🔴 Pozicija ${symbol} zatvorena jer SL nije mogao biti postavljen`);
      await tg(`🚨 <b>SL FAIL — ZATVORENO</b> ${symbol}\nNismo mogli postaviti SL → pozicija zatvorena radi sigurnosti!`);
    } catch (e2) {
      console.log(`  ❌ Emergency close fail: ${e2.message}`);
    }
    return { orderId, fillPrice, actualLeverage, slFailed: true };
  }

  // 2) Trailing stop — aktivira se na TP razini, zatim prati cijenu odozgo za SL%
  //    Kada cijena dostigne tpFromFill, trailing stop se aktivira i prati peak - slPct%
  //    Npr: entry $100, TP=$102.5, SL trail=1.5% → ako cijena ide na $105 → stop na $103.46
  try {
    const trailCallbackRatio = String((_slPct / 100).toFixed(4)); // npr "0.0150"
    const trailRes = await bitgetPost("/api/v2/mix/order/place-tpsl-order", {
      symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
      planType: "track_stop",
      triggerPrice: fmtPrice(tpFromFill, symbol),  // aktivira se kad dosegne TP
      callbackRatio: trailCallbackRatio,             // trail za SL% od vrha
      holdSide,
    });
    if (trailRes.code === "00000") {
      console.log(`  🎯 Trailing stop: aktivacija @ ${fmtPrice(tpFromFill, symbol)}, trail ${_slPct}% OK`);
    } else {
      // Fallback: postavi fiksni TP ako trailing nije podržan
      console.log(`  ⚠️  Trailing stop fail (${trailRes.code} ${trailRes.msg}) — fallback na fiksni TP`);
      await bitgetPost("/api/v2/mix/order/place-tpsl-order", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        planType: "pos_profit",
        triggerPrice: fmtPrice(tpFromFill, symbol),
        triggerType: "mark_price", holdSide,
      });
    }
  } catch (e) {
    console.log(`  ⚠️  Trailing stop greška: ${e.message}`);
  }

  return { orderId, fillPrice, actualLeverage };
}

// Zatvori live poziciju na BitGetu — koristi close-positions (flash close) endpoint
export async function closeBitGetOrder(pos) {
  const holdSide = pos.side === "LONG" ? "long" : "short";

  // Pokušaj 1: close-positions endpoint (isti kao "Flash close" u UI, ne treba size)
  const r1 = await bitgetPost("/api/v2/mix/order/close-positions", {
    symbol:      pos.symbol,
    productType: "USDT-FUTURES",
    holdSide,
  });
  console.log(`  📨 BitGet close-positions: code=${r1?.code} msg=${r1?.msg}`);
  if (r1?.code === "00000") return r1.data;

  // Pokušaj 2: fallback — market place-order bez tradeSide/holdSide (one-way mode)
  const quantity  = (pos.quantity ?? (pos.totalUSD / pos.entryPrice)).toFixed(4);
  const closeSide = pos.side === "LONG" ? "sell" : "buy";
  const path = "/api/v2/mix/order/place-order";
  const orderBody = {
    symbol:      pos.symbol,
    productType: "USDT-FUTURES",
    marginMode:  "isolated",
    marginCoin:  "USDT",
    side:        closeSide,
    orderType:   "market",
    size:        quantity,
    reduceOnly:  "YES",
  };
  const timestamp = Date.now().toString();
  const body = JSON.stringify(orderBody);
  const headers = {
    "Content-Type":      "application/json",
    "ACCESS-KEY":        BITGET.apiKey.trim(),
    "ACCESS-SIGN":       signBitGet(timestamp, "POST", path, body),
    "ACCESS-TIMESTAMP":  timestamp,
    "ACCESS-PASSPHRASE": BITGET.passphrase.trim(),
  };
  if (BITGET_DEMO) headers["x-simulated-trading"] = "1";
  const res  = await fetch(`${BITGET.baseUrl}${path}`, { method: "POST", headers, body });
  const data = await res.json();
  console.log(`  📨 BitGet place-order fallback: code=${data.code} msg=${data.msg}`);
  if (data.code !== "00000") throw new Error(`BitGet close: ${data.msg}`);
  return data.data;
}

// Zatvori višak pozicija — ostavlja prvih `target` pozicija, zatvara ostale market orderom
export async function closeBitGetExcess(pid, target = MAX_OPEN_PER_PORTFOLIO) {
  const positions = loadPositions(pid);
  if (positions.length <= target) {
    return { ok: true, msg: `Već ${positions.length} pozicija — nije potrebno zatvarati`, closed: [] };
  }

  // Dohvati live cijene za sortiranje po unrealized P&L
  const symbols = positions.map(p => p.symbol);
  const prices  = {};
  await Promise.all(symbols.map(async sym => {
    try {
      const tj = await fetch(`${BITGET.baseUrl}/api/v2/mix/market/ticker?symbol=${sym}&productType=USDT-FUTURES`).then(r => r.json());
      prices[sym] = parseFloat(tj?.data?.[0]?.lastPr || tj?.data?.[0]?.close || 0);
    } catch { /* koristi entryPrice kao fallback */ }
  }));

  // Izračunaj unrealized P&L za svaku poziciju
  const withPnl = positions.map(pos => {
    const liveP = prices[pos.symbol] || pos.entryPrice;
    const qty   = pos.quantity ?? (pos.totalUSD / pos.entryPrice);
    const pnl   = pos.side === "LONG"
      ? (liveP - pos.entryPrice) * qty
      : (pos.entryPrice - liveP) * qty;
    return { ...pos, _pnl: pnl };
  });

  // Sortiraj: najlošije P&L zatvaraj prve
  withPnl.sort((a, b) => a._pnl - b._pnl);
  const toClose = withPnl.slice(0, positions.length - target);

  const closed = [];
  for (const pos of toClose) {
    const exitPrice = prices[pos.symbol] || pos.entryPrice;
    const qty = pos.quantity ?? (pos.totalUSD / pos.entryPrice);
    const pnl = pos.side === "LONG"
      ? (exitPrice - pos.entryPrice) * qty
      : (pos.entryPrice - exitPrice) * qty;

    try {
      await closeBitGetOrder(pos);
      console.log(`  🔴 MANUAL CLOSE [${pos.symbol}] ${pos.side} P&L: ${pnl.toFixed(4)}`);
    } catch (e) {
      // Pozicija možda već zatvorena na Bitgetu — svejedno ukloni iz trackinga
      console.log(`  ⚠️  MANUAL CLOSE FAIL [${pos.symbol}]: ${e.message} — uklanjam iz trackinga`);
    }
    // Uvijek ukloni iz tracked pozicija i zabilježi u CSV
    const remaining = loadPositions(pid).filter(p => !(p.symbol === pos.symbol && p.side === pos.side));
    savePositions(pid, remaining);
    writeExitCsv(pid, pos, exitPrice, "Ručno zatvoreno (višak pozicija)", pnl);
    closed.push({ symbol: pos.symbol, side: pos.side, pnl: pnl.toFixed(4) });
  }

  return { ok: true, closed, remaining: loadPositions(pid).length, target };
}

// ─── Trailing Stop — ažurira SL na Bitgetu kad cijena doseže novi peak ──────────

async function updateTrailSL(pos, newSlPrice) {
  if (PAPER_TRADING) return false;
  const { symbol, side } = pos;
  const holdSide = side === "LONG" ? "long" : "short";
  const slStr = fmtPrice(newSlPrice, symbol);
  try {
    const ts   = Date.now().toString();
    const path = `/api/v2/mix/order/orders-plan-pending?symbol=${symbol}&productType=USDT-FUTURES&planType=pos_loss`;
    const sign = signBitGet(ts, "GET", path);
    const r    = await fetch(`${BITGET.baseUrl}${path}`, {
      headers: { "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET.passphrase, "Content-Type": "application/json" },
    });
    const d = await r.json();
    const orders = (d.data?.entrustedList || []).filter(o => o.holdSide === holdSide);
    if (orders.length > 0) {
      await bitgetPost("/api/v2/mix/order/modify-tpsl-order", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        orderId: orders[0].orderId, triggerPrice: slStr,
      });
    } else {
      await bitgetPost("/api/v2/mix/order/place-tpsl-order", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        planType: "pos_loss", triggerPrice: slStr, triggerType: "mark_price", holdSide,
      });
    }
    return true;
  } catch (e) {
    console.log(`  ⚠️  [TRAIL] updateTrailSL failed ${symbol}: ${e.message}`);
    return false;
  }
}

// ─── Daily trade counter ────────────────────────────────────────────────────────

const _todayTrades = {};

function checkDailyLimit(pid) {
  const key   = `${pid}_${new Date().toISOString().slice(0, 10)}`;
  const count = _todayTrades[key] || 0;
  if (count >= MAX_TRADES_PER_DAY) return false;
  _todayTrades[key] = count + 1;
  return true;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────────
// Ako portfolio ima 5 uzastopnih gubitaka → pauza 8 sati.
// Stanje se čuva na disku (preživi restart).

const CB_LOSSES   = 7;                     // uzastopnih gubitaka → circuit breaker
const CB_COOLDOWN = 8 * 60 * 60 * 1000;   // 8h pauza

const CB_DRAWDOWN_MIN = 200;      // minimalni equity ($) — ispod = stop trading
const CB_DRAWDOWN_PCT = 25;       // % gubitak od stvarnog BitGet stanja → stop (backup)
const SYM_CONSEC_LOSSES = 5;      // uzastopni gubici po simbolu → suspendiraj sa liste
const CB_FILE      = `${DATA_DIR}/circuit_breaker.json`;

function loadCircuitBreaker() {
  try { return existsSync(CB_FILE) ? JSON.parse(readFileSync(CB_FILE, "utf8")) : {}; }
  catch { return {}; }
}

function saveCircuitBreaker(cb) {
  writeFileSync(CB_FILE, JSON.stringify(cb, null, 2));
}

// Vraća true ako smije tradati, false ako je u cooldownu.
async function checkCircuitBreaker(pid, pName) {
  const cb = loadCircuitBreaker();

  // 1) Provjeri aktivan cooldown
  if (cb[pid]?.until) {
    const remaining = cb[pid].until - Date.now();
    if (remaining > 0) {
      const hrs = (remaining / 3600000).toFixed(1);
      console.log(`  🛑 [${pName}] Circuit breaker aktivan — još ${hrs}h pauze`);
      return false;
    }
  }

  // 2) Provjeri zadnjih N zatvorenih tradova iz CSV-a (samo nakon manualResetAt)
  const f = csvFilePath(pid);
  if (!existsSync(f)) return true;
  try {
    const manualResetAt = cb[pid]?.manualResetAt || 0;
    const lines = readFileSync(f, "utf8").trim().split("\n");
    const exits = lines.slice(1)
      .filter(l => l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT"))
      .filter(l => {
        // Ignoriraj trade-ove prije ručnog reseta
        if (!manualResetAt) return true;
        const cols = l.split(",");
        const ts = new Date(`${cols[0]}T${cols[1]}Z`).getTime();
        return ts > manualResetAt;
      })
      .slice(-CB_LOSSES);

    if (exits.length < CB_LOSSES) return true;  // nema dovoljno podataka

    const allLosses = exits.every(l => {
      const cols = l.split(",");
      return parseFloat(cols[9] || 0) < 0;  // Net P&L < 0
    });

    if (allLosses) {
      const until = Date.now() + CB_COOLDOWN;
      cb[pid] = { until, triggeredAt: new Date().toISOString(), losses: CB_LOSSES };
      saveCircuitBreaker(cb);
      const untilStr = new Date(until).toISOString().slice(11, 16) + " UTC";
      console.log(`  🛑 [${pName}] CIRCUIT BREAKER — ${CB_LOSSES} uzastopnih gubitaka! Pauza do ${untilStr}`);
      await tg(`🛑 <b>CIRCUIT BREAKER [${pName}]</b>\n${CB_LOSSES} uzastopnih gubitaka — trading pauziran 8h\nNastavak: ${untilStr}`);
      return false;
    }
  } catch { /* nastavi */ }

  return true;
}

// ─── Auto-remove simbol pri uzastopnim gubicima ────────────────────────────────
// Čita CSV, gleda zadnjih SYM_CONSEC_LOSSES exitova za taj simbol.
// Ako su svi gubici → makni simbol iz rules.json watchliste.

async function checkAndRemoveSymbol(pid, symbol) {
  const f = csvFilePath(pid);
  if (!existsSync(f)) return;
  try {
    const lines = readFileSync(f, "utf8").trim().split("\n");
    // Filtriraj samo exitove tog simbola
    const symExits = lines.slice(1)
      .filter(l => l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT"))
      .filter(l => l.split(",")[2] === symbol);  // col 2 = symbol

    if (symExits.length < SYM_CONSEC_LOSSES) return;

    const lastN = symExits.slice(-SYM_CONSEC_LOSSES);
    const allLoss = lastN.every(l => parseFloat(l.split(",")[9] || 0) < 0);
    if (!allLoss) return;

    // Makni iz rules.json
    const rules = JSON.parse(readFileSync("rules.json", "utf8"));
    const wl    = rules.watchlist_synapse_t || [];
    if (!wl.includes(symbol)) return;

    rules.watchlist_synapse_t = wl.filter(s => s !== symbol);
    writeFileSync("rules.json", JSON.stringify(rules, null, 2));

    console.log(`  🚫 [SUSPEND] ${symbol} — ${SYM_CONSEC_LOSSES} uzastopnih gubitaka → suspendiran!`);
    await tg(`🚫 <b>SUSPENDIRAN: ${symbol}</b>\n${SYM_CONSEC_LOSSES} uzastopnih gubitaka zaredom.\nSimbol uklonjen s ULTRA watchliste do ručnog dodavanja.`);
  } catch (e) {
    console.log(`  ⚠️  checkAndRemoveSymbol error: ${e.message}`);
  }
}

// ─── Sync otvorenih pozicija s Bitgeta ─────────────────────────────────────────
// Detektira pozicije koje su stvarno otvorene na Bitgetu ali nisu u lokalnom stanju.
// Koristi se pri resetu/resync da dashboard prikaže točno stanje.

export async function syncPositionsFromBitget(pid = "synapse_t") {
  if (PAPER_TRADING) return { synced: 0, message: "PAPER mode — nema sinca" };

  const posPath  = `/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT`;
  const ts       = Date.now().toString();
  const sign     = signBitGet(ts, "GET", posPath);
  const r        = await fetch(`${BITGET.baseUrl}${posPath}`, {
    headers: {
      "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign,
      "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET.passphrase,
      "Content-Type": "application/json",
    },
  });
  const d = await r.json();
  if (d.code !== "00000") throw new Error(`Bitget error: ${d.msg}`);

  const bitgetPos = (d.data || []).filter(p => parseFloat(p.total) > 0);
  const existing  = loadPositions(pid);
  const existingKeys = new Set(existing.map(p => `${p.symbol}:${(p.side||p.signal||"").toUpperCase()}`));

  let synced = 0;
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const pDef  = buildPortfolios(rules)[pid];

  for (const bp of bitgetPos) {
    const side   = bp.holdSide === "long" ? "LONG" : "SHORT";
    const key    = `${bp.symbol}:${side}`;
    if (existingKeys.has(key)) continue;  // već praćena

    // SL/TP — per-symbol > per-portfolio > globalna konstanta
    const symSltpSync = rules.symbol_sltp?.[bp.symbol] || {};
    const slPct = symSltpSync.slPct ?? pDef?.slPct ?? SL_PCT;
    const tpPct = symSltpSync.tpPct ?? pDef?.tpPct ?? TP_PCT;

    const entryPrice = parseFloat(bp.openPriceAvg);
    const size       = parseFloat(bp.total);
    const tradeSize  = entryPrice * size;
    const sl = side === "LONG" ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100);
    const tp = side === "LONG" ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100);

    const entry = {
      symbol: bp.symbol, signal: side, side,
      price: entryPrice, entryPrice,
      sl, tp, slPct, tpPct,
      tradeSize, quantity: size,
      margin: tradeSize / LEVERAGE,
      orderId: `SYNC-${bp.symbol}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      strategy: "synapse_t", timeframe: pDef?.timeframe || "15m",
      mode: "LIVE",
    };

    addPosition(pid, entry);
    initCsv(pid);
    writeEntryCsv(pid, entry);
    synced++;
    console.log(`  🔄 SYNC [${pid}] ${bp.symbol} ${side} @ ${entryPrice} (${size} coins)`);
  }
  return { synced, total: bitgetPos.length, message: `Sinhronizirano ${synced} novih pozicija` };
}

// ─── Main ───────────────────────────────────────────────────────────────────────

export async function run() {
  const rules      = JSON.parse(readFileSync("rules.json", "utf8"));
  const portfolios = buildPortfolios(rules);
  const modLabel   = PAPER_TRADING ? "PAPER" : BITGET_DEMO ? "DEMO" : "LIVE";
  const utcNow     = new Date();
  const utcHour    = utcNow.getUTCHours();
  const utcMin     = utcNow.getUTCMinutes();

  // Init CSVs
  for (const pid of PORTFOLIO_IDS) initCsv(pid);

  // Provjeri BitGet autentikaciju pri svakom startu
  await loadPricePrecision();
  if (!PAPER_TRADING) await testBitGetAuth();

  const totalSymbols = Object.values(portfolios).reduce((s, p) => s + p.symbols.length, 0);
  const nPort = Object.keys(portfolios).length;
  console.log(`[${utcNow.toISOString().slice(0,16)}] ${modLabel} | ${nPort} portfolia | ${totalSymbols} simbola | ${LEVERAGE}x | UTC ${utcHour}:${String(utcMin).padStart(2,"0")}`);

  writeHeartbeat("running", { portfolios: nPort, symbols: totalSymbols, leverage: LEVERAGE });

  // Provjeri otvorene pozicije svih portfolia
  for (const pid of PORTFOLIO_IDS) {
    await checkPortfolioPositions(pid);
  }

  // Skeniraj samo aktivne portfolije (PORTFOLIO_IDS)
  for (const [pid, pDef] of Object.entries(portfolios).filter(([id]) => PORTFOLIO_IDS.includes(id))) {
    // Pokreni entry logiku samo kad se zatvori svjeća ovog TF-a
    if (!shouldRunNow(pDef.timeframe, utcHour, utcMin)) {
      console.log(`  ⏭️  [${pDef.name}] Preskačem skeniranje — TF ${pDef.timeframe} još nije zatvoren`);
      continue;
    }

    // ── Drawdown zaštita ───────────────────────────────────────────────────────
    // U live modu: koristi stvarni BitGet balans (ne CSV izračun)
    // U paper modu: koristi CSV izračun
    const liveEq  = await fetchBitgetEquity();  // null u paper modu
    const csvEq   = getPortfolioEquity(pid, pDef.startCapital || START_CAPITAL);
    const equityNow = liveEq ?? csvEq;
    const equitySrc = liveEq !== null ? "BitGet" : "CSV";

    console.log(`  💰 [${pDef.name}] Equity: $${equityNow.toFixed(2)} (${equitySrc}) | CSV: $${csvEq.toFixed(2)}`);

    if (equityNow < CB_DRAWDOWN_MIN) {
      console.log(`  🛑 [${pDef.name}] DRAWDOWN ZAŠTITA — equity $${equityNow.toFixed(2)} (${equitySrc}) < $${CB_DRAWDOWN_MIN} — trading zablokiran!`);
      const cb = loadCircuitBreaker();
      const lastDdAlert = cb[pid]?.lastDrawdownAlert || 0;
      if (Date.now() - lastDdAlert > 60 * 60 * 1000) {
        await tg(`🛑 <b>DRAWDOWN ZAŠTITA [${pDef.name}]</b>\nEquity: $${equityNow.toFixed(2)} (${equitySrc}) — ispod minimuma $${CB_DRAWDOWN_MIN}\nTrading zablokiran. Resetiraj ručno kad budeš spreman.`);
        cb[pid] = { ...(cb[pid] || {}), lastDrawdownAlert: Date.now() };
        saveCircuitBreaker(cb);
      }
      continue;
    }


    const openPositions = loadPositions(pid);
    const openSymbols   = openPositions.map(p => p.symbol);
    const BTC_EXCEPTION = "BTCUSDT";  // BTC uvijek može otvoriti kao 6. trade

    if (openPositions.length >= MAX_OPEN_PER_PORTFOLIO) {
      // Ako su svi slotovi puni, skeniramo samo BTC (specijalni slot)
      const btcAlreadyOpen = openSymbols.includes(BTC_EXCEPTION);
      if (btcAlreadyOpen || !pDef.symbols.includes(BTC_EXCEPTION)) {
        console.log(`  🔒 [${pDef.name}] Max ${MAX_OPEN_PER_PORTFOLIO} otvorenih pozicija dostignut (${openPositions.length}) — preskačem skeniranje`);
        continue;
      }
      console.log(`  🔒 [${pDef.name}] Max ${MAX_OPEN_PER_PORTFOLIO} dostignut — skeniranje samo BTC (specijalni slot)`);
    }

    // ── Daily P&L Budget gate — 3% od stvarnog equityja ──────────────────
    const DAILY_LOSS_LIMIT = Math.max(equityNow * DAILY_LOSS_LIMIT_PCT / 100, DAILY_LOSS_LIMIT_MIN);
    const dailyPnl = getDailyPnl(pid);
    if (dailyPnl < -DAILY_LOSS_LIMIT) {
      console.log(`  🛑 [${pDef.name}] DNEVNI LIMIT — P&L danas: $${dailyPnl.toFixed(2)} < -$${DAILY_LOSS_LIMIT.toFixed(0)} (3% od $${equityNow.toFixed(0)}) → trading suspendiran`);
      await tg(`🛑 Dnevni gubitak limit: $${dailyPnl.toFixed(2)} (3% od $${equityNow.toFixed(0)}) — trading pauziran do ponoći`);
      continue;
    }
    const dailyWarnActive = dailyPnl < -(DAILY_LOSS_LIMIT * DAILY_WARN_PCT / 100);
    if (dailyWarnActive) console.log(`  ⚠️  [${pDef.name}] Dnevni P&L upozorenje: $${dailyPnl.toFixed(2)} (${(Math.abs(dailyPnl)/DAILY_LOSS_LIMIT*100).toFixed(0)}% od $${DAILY_LOSS_LIMIT.toFixed(0)} limita)`);

    // ── 3. Market Regime: BTC 4H — LONG samo kad BULL, SHORT samo kad BEAR/NEUTRAL ─
    let _btcRegime = "UNKNOWN";
    if (pDef.strategy === "synapse_t") {
      _btcRegime = await getBtcRegime();
      if (_btcRegime === "UNKNOWN") console.log(`  ⚠️  [${pDef.name}] BTC regime: UNKNOWN — nastavljamo oprezno`);
      else console.log(`  📊 [${pDef.name}] BTC regime: ${_btcRegime}`);
    }

    // ── SP500 Risk-Off gate — blokira LONG, ali dozvoljava SHORT ─────────────
    let _sp500Regime = "NEUTRAL";
    if (pDef.strategy === "synapse_t") {
      const sp = await getSp500Data();
      _sp500Regime = sp.regime;
      if (sp.change4h !== null) console.log(`  📈 [SP500] ${sp.change4h}% (4H) — ${sp.regime}`);
    }

    // ── BTC/ETH divergencija — jednom po ciklusu ─────────────────────────────
    let _btcEthDiv = { diverging: false, corr: 1 };
    if (pDef.strategy === "synapse_t") {
      _btcEthDiv = await checkBtcEthDivergence();
    }

    // ── Fear & Greed gate ─────────────────────────────────────────────────────
    let _fearGreed = null;
    if (pDef.strategy === "synapse_t") {
      const fg = await getFearGreed().catch(() => null);
      _fearGreed = fg?.value ?? null;
      if (_fearGreed !== null) console.log(`  😨 [F&G] ${_fearGreed} (${fg.label})`);
    }

    // ── DXY gate — jaki dolar blokira LONG ───────────────────────────────────
    let _dxyChange = null;
    if (pDef.strategy === "synapse_t") {
      const dxy = await getDxyData().catch(() => null);
      _dxyChange = dxy?.change4h ?? null;
    }

    // ── Liquidation Risk gate ─────────────────────────────────────────────────
    let _liqScore = null;
    if (pDef.strategy === "synapse_t") {
      const liq = await getLiquidationRisk(pDef.symbols).catch(() => null);
      _liqScore = liq?.overall ?? null;
      if (_liqScore !== null && _liqScore > 60) console.log(`  💥 [LIQ] Rizik likvidacija: ${_liqScore}/100`);
    }

    // ── Ekonomski kalendar — dohvati jednom po portfoliju ─────────────────────
    let _econEvents = [];
    if (pDef.strategy === "synapse_t") {
      _econEvents = await getEconEvents();
      const econStatus = isEconBlocked(_econEvents);
      if (econStatus.blocked) {
        console.log(`  📅 [ECON] ${econStatus.event} — ${Math.abs(econStatus.minLeft || 0)}min ${econStatus.minLeft > 0 ? "za" : "nazad"} → trading pauziran`);
        continue;
      }
      if (econStatus.next) {
        const inMin = Math.round((new Date(econStatus.next.date).getTime() - Date.now()) / 60000);
        if (inMin > 0 && inMin <= 30) console.log(`  ⏰ [ECON] ${econStatus.next.title} za ${inMin}min — upozorenje`);
      }
    }

    // ── 1. Dinamički ADX + pauza ako WR loš ───────────────────────────────
    if (pDef.strategy === "synapse_t") {
      if (_dynPauseUntil > Date.now()) {
        const remainH = (((_dynPauseUntil - Date.now()) / 3600000)).toFixed(1);
        console.log(`  ⏸️  [${pDef.name}] Dinamička pauza aktivna — WR bio prenizak, još ${remainH}h`);
        continue;
      }
      const dynAdx = getDynamicAdx(pid);
      if (dynAdx > ADX_MIN) {
        console.log(`  📊 [${pDef.name}] Dinamički ADX: ${dynAdx} (WR loš → strožiji filter)`);
      }
      // Spremi u params da analyzeUltra koristi dinamički prag
      pDef.params._dynAdx = dynAdx;
    }

    for (const symbol of pDef.symbols) {
      const existingPos = openPositions.find(p => p.symbol === symbol);
      if (existingPos) {
        // Pozicija već otvorena — preskačemo (flip logika uklonjena, LONG_ONLY mod)
        console.log(`  ⏭️  [${pDef.name}] ${symbol} — pozicija već otvorena (${existingPos.side}), preskačem`);
        continue;
      }

      // Provjeri limit otvorenih pozicija
      const currentOpen = loadPositions(pid).length;
      if (currentOpen >= MAX_OPEN_PER_PORTFOLIO && symbol !== BTC_EXCEPTION) {
        console.log(`  🔒 [${pDef.name}] Max ${MAX_OPEN_PER_PORTFOLIO} dostignut — preskačem ${symbol}`);
        continue;
      }

      // ── 2. Symbol Blacklist ─────────────────────────────────────────────
      if (isBlacklisted(symbol)) continue;

      try {
        // ── Session Filter gate ─────────────────────────────────────────────
        const sess = getSessionInfo();
        if (sess.dead) {
          console.log(`  🌙 [SESSION] ${symbol} — dead zone (${sess.utcHour}:00 UTC, 01-06 UTC blokiran) → preskačem`);
          continue;
        }

        // ── 1H Trend Filter ─────────────────────────────────────────────────
        const trend1h = pDef.strategy === "synapse_t" ? await calcTrend1H(symbol) : { trend: 'UNKNOWN' };

        const candles = await fetchCandles(symbol, pDef.timeframe, 250);
        const price   = candles[candles.length - 1].close;

        // ── ATR Trend — prilagodi size ──────────────────────────────────────
        const atrTrend = calcAtrTrend(candles);
        if (atrTrend.trend === 'EXPANDING') {
          console.log(`  📊 [ATR] ${symbol} — volatilnost RASTE (${atrTrend.ratio}x prosjeka) → size ×${atrTrend.sizeMult}`);
        }

        // ── Volume Anomaly gate ─────────────────────────────────────────────
        const volAnomaly = checkVolumeAnomaly(candles);
        if (!volAnomaly.ok) {
          console.log(`  📉 [VOL] ${symbol} — nizak volumen ${volAnomaly.ratio}x prosjeka → preskačem`);
          continue;
        }
        if (volAnomaly.high) console.log(`  📈 [VOL] ${symbol} — visok volumen ${volAnomaly.ratio}x! (breakout signal)`);

        let result;
        switch (pDef.strategy) {
          case "mega":        result = analyzeMega(candles, pDef.params);                              break;
          case "synapse7":    result = await analyzeSynapse7Pullback(symbol, candles, pDef.params);   break;
          case "synapse_t":   result = await analyzeUltraPullback(symbol, candles, pDef.params);      break;
          default:            result = analyzeEmaRsi(candles, pDef.params);                           break;
        }

        const { signal, reason } = result;

        if (signal === "NEUTRAL") {
          console.log(`  🚫 [${pDef.name}] ${symbol} — ${reason}`);
          continue;
        }

        // ── Regime + SP500 + 1H trend filter — po smjeru signala ─────────────
        if (pDef.strategy === "synapse_t") {
          // BTC BEAR → blokira LONG (NEUTRAL prolazi)
          if (signal === "LONG" && _btcRegime === "BEAR") {
            console.log(`  🌧️  [REGIME] ${symbol} — BTC BEAR → LONG blokiran`);
            continue;
          }
          // BTC BULL → blokira SHORT (trend suprotan shortu)
          if (signal === "SHORT" && _btcRegime === "BULL") {
            console.log(`  ☀️  [REGIME] ${symbol} — BTC BULL → SHORT blokiran`);
            continue;
          }
          // SP500 RISK_OFF → blokira LONG, ali SHORT prolazi
          if (signal === "LONG" && _sp500Regime === "RISK_OFF") {
            console.log(`  🚨 [SP500] ${symbol} — RISK_OFF → LONG blokiran`);
            continue;
          }
          // Fear & Greed: ekstremni strah (≤20) → blokira LONG (panika, ne ulazimo long)
          if (signal === "LONG" && _fearGreed !== null && _fearGreed <= 20) {
            console.log(`  😱 [F&G] ${symbol} — Extreme Fear (${_fearGreed}) → LONG blokiran`);
            continue;
          }
          // Fear & Greed: ekstremna pohlepa (≥80) → blokira SHORT (euforija, ne shortamo)
          if (signal === "SHORT" && _fearGreed !== null && _fearGreed >= 80) {
            console.log(`  🤑 [F&G] ${symbol} — Extreme Greed (${_fearGreed}) → SHORT blokiran`);
            continue;
          }
          // DXY: jaki dolar (>+0.3% na 4H) → blokira LONG na crypto
          if (signal === "LONG" && _dxyChange !== null && _dxyChange > 0.3) {
            console.log(`  💵 [DXY] ${symbol} — DXY +${_dxyChange}% → LONG blokiran (jaki dolar)`);
            continue;
          }
          // Liquidation Risk: visok rizik (>75) → blokira LONG (kaskadni padovi mogući)
          if (signal === "LONG" && _liqScore !== null && _liqScore > 75) {
            console.log(`  💥 [LIQ] ${symbol} — rizik ${_liqScore}/100 → LONG blokiran`);
            continue;
          }
          // 1H trend nepoklapa → filtriraj
          if (signal === "LONG" && trend1h.trend === "BEAR") {
            console.log(`  📉 [1H] ${symbol} — 1H trend BEAR → LONG blokiran (close ${fmtPrice(trend1h.last)} < EMA20 ${fmtPrice(trend1h.ema20)})`);
            continue;
          }
          if (signal === "SHORT" && trend1h.trend === "BULL") {
            console.log(`  📈 [1H] ${symbol} — 1H trend BULL → SHORT blokiran (close ${fmtPrice(trend1h.last)} > EMA20 ${fmtPrice(trend1h.ema20)})`);
            continue;
          }
        }

        // ── Funding rate gate — blokira LONG ako tržište preokomjerno long ──
        if (pDef.strategy === "synapse_t") {
          const fr = await getFundingRate(symbol);
          const frHist = recordFundingTrend(symbol, fr);
          if (signal === "LONG") {
            if (isFundingTrendRising(symbol)) {
              console.log(`  📈 [FR-TREND] ${symbol} — funding RASTE (${frHist.map(v=>v.toFixed(3)).join('→')}%) → LONG blokiran (trap)`);
              continue;
            }
            if (fr > FR_LONG_BLOCK) {
              console.log(`  🚫 [FR] ${symbol} — funding ${fr.toFixed(4)}% > ${FR_LONG_BLOCK}% → LONG blokiran`);
              continue;
            }
            if (fr > FR_WARN) console.log(`  ⚠️  [FR] ${symbol} — funding ${fr.toFixed(4)}% (upozorenje)`);
          }
        }

        // ── VWAP filter — overextended = manji size, ne blokada ─────────────
        let _vwapSizeMult = 1.0;
        if (pDef.strategy === "synapse_t") {
          const vwap = calcVWAP(candles);
          if (vwap) {
            const vwapDistPct = (price - vwap) / vwap * 100;
            if (signal === "LONG" && vwapDistPct > 2.5) {
              _vwapSizeMult = 0.6;
              console.log(`  📊 [VWAP] ${symbol} — +${vwapDistPct.toFixed(1)}% iznad VWAP → size ×0.6 (overextended)`);
            } else if (signal === "SHORT" && vwapDistPct < -2.5) {
              _vwapSizeMult = 0.6;
              console.log(`  📊 [VWAP] ${symbol} — ${vwapDistPct.toFixed(1)}% ispod VWAP → size ×0.6 (overextended)`);
            }
          }
        }

        // ── Open Interest — potvrda signala ────────────────────────────────────
        let _oiSizeMult = 1.0;
        if (pDef.strategy === "synapse_t") {
          const oi = await getOiChange(symbol);
          if (oi.falling && signal === "LONG") {
            console.log(`  📉 [OI] ${symbol} — OI pada ${oi.changePct.toFixed(1)}% → slabi reli, size ×0.7`);
            _oiSizeMult = 0.7;
          } else if (oi.falling && signal === "SHORT") {
            console.log(`  📉 [OI] ${symbol} — OI pada ${oi.changePct.toFixed(1)}% → short covering, size ×0.7`);
            _oiSizeMult = 0.7;
          } else if (oi.rising) {
            console.log(`  📈 [OI] ${symbol} — OI raste ${oi.changePct.toFixed(1)}% → novi novac potvrđuje signal`);
          }
        }

        // ── BTC/ETH divergencija — market uncertainty → traži minSig+1 signala ──
        if (pDef.strategy === "synapse_t" && _btcEthDiv.diverging) {
          const score = signal === "LONG" ? result.bullScore : result.bearScore;
          const divThresh = (cfg?.minSig ?? 6) + 1;
          if (score < divThresh) {
            console.log(`  ⚡ [DIV] ${symbol} — BTC/ETH divergiraju (corr=${_btcEthDiv.corr}), signal ${score}/13 < ${divThresh} → preskačem`);
            continue;
          }
          console.log(`  ⚡ [DIV] ${symbol} — BTC/ETH divergiraju ali signal jak (${score}/13 ≥ ${divThresh}) → nastavljam`);
        }

        // ── Cooldown provjera: 4h pauza po simbolu nakon SL-a ──────────────
        const lastSl = symbolSlCooldown.get(symbol);
        if (lastSl && (Date.now() - lastSl) < SL_COOLDOWN_MS) {
          const remainMin = Math.ceil((SL_COOLDOWN_MS - (Date.now() - lastSl)) / 60000);
          console.log(`  🕐 [${pDef.name}] ${symbol} — cooldown aktivan, još ${remainMin}min (SL bio ${Math.round((Date.now()-lastSl)/60000)}min nazad)`);
          continue;
        }

        // ── 5m S/R Gate — blokira ulaz ako cijena nije kod ključne razine ────
        if (pDef.strategy === "synapse_t") {
          try {
            const srOk = await check5mSRTest(symbol, signal);
            if (srOk === false) {
              console.log(`  🧱 [5mSR] ${symbol} — cijena nije kod S/R razine → ${signal} preskočen`);
              continue;
            }
          } catch { /* ignoriramo grešku, ne blokiramo */ }
        }

        // 🔄 INVERTED MODE — trgujemo suprotno od signala (long→short, short→long)
        const INVERT_SIGNALS = false;
        if (INVERT_SIGNALS && signal !== "NEUTRAL") {
          const orig = signal;
          signal = signal === "LONG" ? "SHORT" : "LONG";
          console.log(`  🔄 INVERT: ${orig} → ${signal} ${symbol}`);
        }

        // SL/TP — S/R-based (zadnji pivot ispod/iznad cijene) + ATR fallback + tier guardrails
        const symSltp = rules.symbol_sltp?.[symbol] || {};
        const tierSlMin = symSltp.slPct ?? 1.0;        // floor: ne smije biti manji od tier SL
        const tierSlMax = (symSltp.slPct ?? SL_PCT) + 1.0;  // cap: ne smije biti veći od tier SL + 1%
        const tierTpMin = symSltp.tpPct ?? 1.5;
        const tierTpMax = (symSltp.tpPct ?? TP_PCT) + 2.0;
        const SR_BUFFER = 0.003;  // 0.3% buffer ispod supporta / iznad resistancea

        let slPct, tpPct, sl, tp;
        let slMethod = "tier";

        if (pDef.strategy === "synapse_t") {
          // 1. Pokušaj S/R-based SL
          const srLevel = signal === "LONG" ? result.nearSup : result.nearRes;
          if (srLevel != null) {
            const srSlPrice = signal === "LONG"
              ? srLevel * (1 - SR_BUFFER)   // malo ispod zadnjeg supporta
              : srLevel * (1 + SR_BUFFER);  // malo iznad zadnjeg resistancea
            const srSlPct = Math.abs(price - srSlPrice) / price * 100;
            if (srSlPct >= tierSlMin && srSlPct <= tierSlMax) {
              // S/R razina je u prihvatljivom tier rangu — koristi je
              slPct = srSlPct;
              tpPct = Math.min(Math.max(slPct * 2.5, tierTpMin), tierTpMax);
              sl = srSlPrice;
              tp = signal === "LONG" ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
              slMethod = "S/R";
              console.log(`  📐 [SR-SL] ${symbol} ${signal}: ${signal === "LONG" ? "Sup" : "Res"} @ ${fmtPrice(srLevel)} → SL ${fmtPrice(sl)} (${slPct.toFixed(2)}%) | TP ${fmtPrice(tp)} (${tpPct.toFixed(2)}%) RR=${( tpPct/slPct).toFixed(1)}x`);
            } else {
              console.log(`  📐 [SR-SL] ${symbol} S/R @ ${fmtPrice(srLevel)} predaleko (${srSlPct.toFixed(2)}% — van range ${tierSlMin}%-${tierSlMax}%) → ATR fallback`);
            }
          }

          // 2. ATR fallback ako S/R nije pronašao prikladan level
          if (slMethod === "tier" && atrTrend?.currentAtr > 0) {
            const rawSlPct = (atrTrend.currentAtr * 1.5 / price) * 100;
            const rawTpPct = (atrTrend.currentAtr * 3.0 / price) * 100;
            slPct = Math.min(Math.max(rawSlPct, tierSlMin), tierSlMax);
            tpPct = Math.min(Math.max(rawTpPct, tierTpMin), tierTpMax);
            sl = signal === "LONG" ? price * (1 - slPct / 100) : price * (1 + slPct / 100);
            tp = signal === "LONG" ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
            slMethod = "ATR";
            console.log(`  📐 [ATR-SL] ${symbol} ATR=${atrTrend.currentAtr.toFixed(4)} → SL ${slPct.toFixed(2)}% TP ${tpPct.toFixed(2)}% (floor: ${tierSlMin}% cap: ${tierSlMax}%)`);
          }
        }

        // 3. Tier fallback (ostale strategije ili ako ATR = 0)
        if (slMethod === "tier") {
          slPct = symSltp.slPct ?? pDef.slPct ?? SL_PCT;
          tpPct = symSltp.tpPct ?? pDef.tpPct ?? TP_PCT;
          sl = signal === "LONG" ? price * (1 - slPct / 100) : price * (1 + slPct / 100);
          tp = signal === "LONG" ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
          console.log(`  📐 [Tier-SL] ${symbol} Tier${symSltp.tier??'?'}: SL ${slPct}% / TP ${tpPct}%`);
        }

        // Risk-based position sizing: SL gubitak = točno RISK_PCT% trenutne equity
        const startCap   = pDef.startCapital ?? START_CAPITAL;
        const equity     = getPortfolioEquity(pid, startCap);

        const riskAmount = equity * (RISK_PCT / 100);
        const tradeSize  = (riskAmount / (slPct / 100)) * (atrTrend?.sizeMult ?? 1) * (_oiSizeMult ?? 1) * (_vwapSizeMult ?? 1);
        const margin     = tradeSize / LEVERAGE;  // preliminarno — ažurira se nakon setupSymbol

        if (!checkDailyLimit(pid)) {
          console.log(`  ❌ [${pDef.name}] Dnevni limit dostignut`);
          continue;
        }

        console.log(`🎯 [${pDef.name}] ${signal} ${symbol} @ ${fmtPrice(price)} | SL ${fmtPrice(sl)} | TP ${fmtPrice(tp)} | $${tradeSize.toFixed(0)}`);

        const isLive    = pDef.live === true && !PAPER_TRADING;  // live samo ako portfolio to zahtijeva I globalni flag nije paper
        const timestamp = new Date().toISOString();
        const orderId   = `${isLive ? "LIVE" : "PAPER"}-${Date.now()}`;
        const mode      = isLive ? (BITGET_DEMO ? "DEMO" : "LIVE") : "PAPER";
        const entry = { symbol, signal, price, sl, tp, tradeSize, margin, orderId, timestamp, strategy: pDef.strategy, timeframe: pDef.timeframe, slPct, tpPct, mode, sigMask: result.sigMask ?? null };

        if (!isLive) {
          addPosition(pid, entry);
          writeEntryCsv(pid, entry);
          await tg(`📋 PAPER [${pDef.name}/${pDef.timeframe}] ${signal === "LONG" ? "📈" : "📉"} <b>${signal} ${symbol}</b>\nUlaz: ${fmtPrice(price)} | SL: ${fmtPrice(sl)} | TP: ${fmtPrice(tp)}\nEquity: $${equity.toFixed(2)} | Risk: $${riskAmount.toFixed(2)} | Notional: $${tradeSize.toFixed(0)} | Margin: $${margin.toFixed(2)} | ${LEVERAGE}x`);
        } else {
          try {
            const order = await placeBitGetOrder(symbol, signal, tradeSize, price, sl, tp, slPct, tpPct);
            const usedLev    = order?.actualLeverage || LEVERAGE;
            const usedMargin = tradeSize / usedLev;
            entry.orderId = order?.orderId || orderId;
            entry.margin  = usedMargin;
            addPosition(pid, entry);
            writeEntryCsv(pid, entry);
            console.log(`  ✅ LIVE NALOG [${pDef.name}] — ${entry.orderId}`);
            await tg(`🔴 LIVE [${pDef.name}/${pDef.timeframe}] ${signal === "LONG" ? "📈" : "📉"} <b>${signal} ${symbol}</b>\nUlaz: ${fmtPrice(price)} | SL: ${fmtPrice(sl)} | TP: ${fmtPrice(tp)}\nEquity: $${equity.toFixed(2)} | Risk: $${riskAmount.toFixed(2)} | Notional: $${tradeSize.toFixed(0)} | Margin: $${usedMargin.toFixed(2)} | ${usedLev}x${usedLev < LEVERAGE ? " ⚠️ max lev" : ""}`);
          } catch (err) {
            console.log(`  ❌ LIVE NALOG PAO — ${err.message}`);
            await tg(`❌ LIVE GREŠKA [${pDef.name}] ${symbol}\n${err.message}`);
          }
        }

      } catch (err) {
        console.log(`  ❌ [${pDef.name}] ${symbol}: ${err.message}`);
      }
    }
  }

  writeHeartbeat("ok", { portfolios: nPort, symbols: totalSymbols, leverage: LEVERAGE });
}

// ─── checkBreakouts — deaktiviran (ulaz je sada immediatan na signal-svjećici) ──
// Ostavljamo export zbog kompatibilnosti s dashboard.js importom.
export async function checkBreakouts() {
  // Očisti eventualni stale pending file
  const pid = "synapse_t";
  const pending = loadPending(pid);
  if (pending.length > 0) {
    savePending(pid, []);
    console.log(`  🧹 [checkBreakouts] Očišćeno ${pending.length} stale pending zapisa`);
  }
}

// ─── Entry point ───────────────────────────────────────────────────────────────

const _botFile = fileURLToPath(import.meta.url);
const _isMain  = process.argv[1] === _botFile
              || process.argv[1]?.endsWith("/bot.js")
              || process.argv[1]?.endsWith("\\bot.js");

if (_isMain) {
  run().catch(async (err) => {
    console.error("Bot greška:", err.message);
    writeHeartbeat("error", { error: err.message });
    await tg(`🚨 <b>BOT GREŠKA</b>\n${err.message}`);
    process.exit(1);
  });
}
