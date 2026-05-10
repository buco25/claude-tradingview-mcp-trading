/**
 * Trading Bot — 4-Portfolio Mode
 *
 * Portfolio 1 — EMA+RSI    → 1H  | SL 2%  / TP 4%
 * Portfolio 2 — MEGA       → 15m | SL 2%  / TP 4%
 * Portfolio 3 — SYNAPSE-7  → 15m | SL 2%  / TP 4%
 * Portfolio 4 — ULTRA      → 15m | SL 1% / TP 2% | 100x | rizik 1% banke po tradeu
 *
 * Risk-based sizing: margin = equity × 1% | notional = margin × 100x
 *   → SL 1% × 100x = 100% margine = likvidacija (gubiš samo ulog)
 *   → TP 2% × 100x = 200% margine = +2% banke po dobitnom tradeu
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
const RISK_PCT      = 1.0;    // % banke koji rizikaš po tradeu (= veličina uloga/margine)
const SL_PCT        = 1.5;    // fiksni SL % | SL 1.5% × 50x = 75% margine
const TP_PCT        = 2.5;    // fiksni TP % | RR 1:1.67
const MAX_TRADES_PER_DAY = 100;
const MAX_OPEN_PER_PORTFOLIO = 15; // max otvorenih pozicija po portfoliju

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
  const { minSig = 8 } = cfg;
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

  // ── 18 signala: +1 = bullish, -1 = bearish, 0 = neutral ──
  const sigs = [
    ema9 > ema21 ? 1 : -1,                          //  1. EMA9/21 smjer
    hadCrossUp ? 1 : hadCrossDn ? -1 : 0,           //  2. Svježi cross (3 bara)
    price > ema50 ? 1 : -1,                          //  3. Cijena vs EMA50
    (rsi < 50 && rsi > 30) ? 1 : (rsi > 50 && rsi < 70) ? -1 : 0, // 4. RSI zona
    price > ema55 ? 1 : -1,                          //  5. Cijena vs EMA55
    adx > 18 ? (ema9 > ema21 ? 1 : -1) : 0,          //  6. ADX > 18 + smjer
    chop < 61.8 ? 1 : -1,                            //  7. Nije choppy
    (scaleUp >= 4 ? 1 : scaleDn >= 4 ? -1 : 0),     //  8. 6-Scale multi-EMA
    cvdSum > 0 ? 1 : -1,                             //  9. CVD volumen
    (rsiMin5 < 35 && rsi > 35 && rsiRising) ? 1
      : (rsiMax5 > 65 && rsi < 65 && rsiFalling) ? -1 : 0, // 10. RSI recovery
    macdHist !== null ? (macdHist > 0 ? 1 : -1) : 0, // 11. MACD histogram
    price > ema145 ? 1 : -1,                          // 12. EMA145 dugoročni trend
    volLast > volAvg20 ? 1 : 0,                       // 13. Volumen iznad prosjeka
    macdCross,                                         // 14. MACD cross (zadnja 3 bara)
    rsiRising ? 1 : rsiFalling ? -1 : 0,              // 15. RSI smjer
    adx > 25 ? (ema9 > ema21 ? 1 : -1) : 0,          // 16. ADX jak >25 + smjer
    sig17sr,                                           // 17. S/R bounce (bounce od supporta/resistancea)
    sig18bk,                                           // 18. S/R breakout (proboj razine u zadnja 3 bara)
  ];

  const bullCnt = sigs.filter(s => s === 1).length;
  const bearCnt = sigs.filter(s => s === -1).length;

  if (bullCnt >= minSig) {
    return { price, signal: "LONG",  bullScore: bullCnt, bearScore: bearCnt,
      reason: `ULTRA LONG ↑${bullCnt}/18 | RSI:${rsi.toFixed(0)} ADX:${adx.toFixed(0)} SR:${sig17sr}/${sig18bk} 6Sc:${scaleUp}/6` };
  }
  if (bearCnt >= minSig) {
    return { price, signal: "SHORT", bullScore: bullCnt, bearScore: bearCnt,
      reason: `ULTRA SHORT ↓${bearCnt}/18 | RSI:${rsi.toFixed(0)} ADX:${adx.toFixed(0)} SR:${sig17sr}/${sig18bk} 6Sc:${scaleDn}/6` };
  }
  return { price, signal: "NEUTRAL", bullScore: bullCnt, bearScore: bearCnt,
    reason: `ULTRA: ↑${bullCnt} ↓${bearCnt} /18 (min ${minSig})` };
}

// ─── ULTRA Candle H/L Breakout Entry ──────────────────────────────────────────
// Signal fires on candle N → spremi H/L te svijeće
// LONG: ulaz kad price > triggerHigh (breakout iznad higa signal-svijeće)
// SHORT: ulaz kad price < triggerLow  (breakdown ispod lowa signal-svijeće)

async function analyzeUltraPullback(symbol, candles, cfg) {
  const last  = candles[candles.length - 1];
  const price = last.close;
  const pid   = "synapse_t";
  const TTL   = 15 * 60 * 1000;  // 1 svjećica (15m) — signal vrijedi samo do sljedeće svjećice

  let pending = loadPending(pid);
  const now   = Date.now();
  pending = pending.filter(p => now - p.ts < TTL);

  const existing = pending.find(p => p.symbol === symbol);

  if (existing) {
    // Provjeri breakout — koristimo HIGH/LOW trenutne svijeće (ne close)
    // SHORT: aktivira čim wick/close padne ispod lowa signal-svijeće
    // LONG:  aktivira čim wick/close poraste iznad higa signal-svijeće
    const hit = existing.side === "LONG"
      ? last.high > existing.triggerHigh    // hig trenutne svijeće prešao iznad trigera
      : last.low  < existing.triggerLow;    // low trenutne svijeće pao ispod trigera

    if (hit) {
      pending = pending.filter(p => p.symbol !== symbol);
      savePending(pid, pending);
      const baseResult = analyzeUltra(candles, cfg);
      return {
        ...baseResult,
        signal: existing.side,
        price,
        reason: `[ULTRA BRK ${existing.side}] Signal @ ${fmtPrice(existing.signalPrice)} | breakout @ ${fmtPrice(price)}`,
      };
    }

    // Cancel ako score pao ili signal flipnuo
    const freshResult = analyzeUltra(candles, cfg);
    if (freshResult.signal !== existing.side) {
      pending = pending.filter(p => p.symbol !== symbol);
      savePending(pid, pending);
      console.log(`  🔄 [ULTRA] ${symbol} — pending ${existing.side} canceliran (${freshResult.signal === "NEUTRAL" ? "score pao" : "flip"})`);
    } else {
      console.log(`  ⏳ [ULTRA] ${symbol} ${existing.side} čeka breakout | TrigH:${fmtPrice(existing.triggerHigh)} TrigL:${fmtPrice(existing.triggerLow)} | CandH:${fmtPrice(last.high)} CandL:${fmtPrice(last.low)} | Close:${fmtPrice(price)}`);
    }
    return { price, signal: "NEUTRAL", reason: `Čeka ULTRA breakout H:${fmtPrice(existing.triggerHigh)} L:${fmtPrice(existing.triggerLow)}` };
  }

  // Nema pendinga — pokreni normalnu analizu
  const result = analyzeUltra(candles, cfg);

  if (result.signal === "LONG" || result.signal === "SHORT") {
    // Spremi H/L signal-svijeće kao breakout trigger
    const sigCandle = candles[candles.length - 1];
    const triggerHigh = sigCandle.high;
    const triggerLow  = sigCandle.low;

    pending.push({ symbol, side: result.signal, signalPrice: price, triggerHigh, triggerLow, ts: now });
    savePending(pid, pending);
    console.log(`  📌 [ULTRA] ${symbol} ${result.signal} signal @ ${fmtPrice(price)} → čeka breakout iznad ${fmtPrice(triggerHigh)} / ispod ${fmtPrice(triggerLow)}`);
    return { price, signal: "NEUTRAL", reason: `ULTRA signal, čeka breakout H:${fmtPrice(triggerHigh)} L:${fmtPrice(triggerLow)}` };
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

function loadPositions(pid) {
  const f = posFile(pid);
  if (!existsSync(f)) return [];
  try { return JSON.parse(readFileSync(f, "utf8")); }
  catch { return []; }
}

function savePositions(pid, positions) {
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
    orderId:    entry.orderId,
    mode:       entry.mode || (PAPER_TRADING ? "PAPER" : BITGET_DEMO ? "DEMO" : "LIVE"),
    openedAt:   entry.timestamp,
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
async function fetchBitgetOpenPositions() {
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
    const path = `/api/v2/mix/order/fill-history?symbol=${symbol}&productType=USDT-FUTURES&limit=20`;
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

    // Filtriraj samo CLOSE fillove (ne entry fillove)
    const expectedCloseSide = pos?.side === "LONG" ? "close_long" : "close_short";
    const closeFills = d.data.fillList.filter(f =>
      f.side === expectedCloseSide || f.tradeSide === "close"
    );
    if (!closeFills.length) return null;

    // Sumej sve close fillove (može biti parcijalno zatvaranje)
    const totalQty = closeFills.reduce((s, f) => s + parseFloat(f.size || 0), 0);
    const avgExitPrice = closeFills.reduce((s, f) => s + parseFloat(f.price || 0) * parseFloat(f.size || 0), 0) / (totalQty || 1);
    const totalFee = closeFills.reduce((s, f) => s + Math.abs(parseFloat(f.fee || 0)), 0);

    // P&L = razlika cijene × količina (bez leverage jer je već u cijenama)
    const qty = pos?.quantity ?? (pos?.totalUSD / pos?.entryPrice) ?? totalQty;
    const entryPx = pos?.entryPrice ?? parseFloat(closeFills[0].price);
    const rawPnl = pos?.side === "LONG"
      ? (avgExitPrice - entryPx) * qty
      : (entryPx - avgExitPrice) * qty;

    return {
      exitPrice: avgExitPrice,
      realizedPnl: rawPnl,
      fee: totalFee,
      side: expectedCloseSide,
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
          const exitPrice  = closed?.exitPrice  ?? pos.sl;  // fallback na sl
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
          const pnl = realPnl !== null ? realPnl : (
            pos.side === "LONG"
              ? (exitPrice - pos.entryPrice) * qty
              : (pos.entryPrice - exitPrice) * qty
          );

          console.log(`  ${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [${pid}] ${pos.symbol} ${pos.side} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} | ${exitReason} | exit@${fmtPrice(exitPrice)}`);
          writeExitCsv(pid, pos, exitPrice, exitReason, pnl);
          await tg(`${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [ULTRA] ${pos.symbol} ${pos.side}\nP&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${exitReason}\nUlaz: ${fmtPrice(pos.entryPrice)} → Izlaz: ${fmtPrice(exitPrice)}`);
          if (pnl < 0) await checkAndRemoveSymbol(pid, pos.symbol);
          continue;  // Ne dodaj u stillOpen
        }
        // Još uvijek otvorena na Bitgetu — prikaz unrealized
        const prices = await fetchLivePrices([pos.symbol]);
        const liveP  = prices[pos.symbol] || pos.entryPrice;
        const qty    = pos.quantity ?? (pos.totalUSD / pos.entryPrice);
        const unrealized = pos.side === "LONG"
          ? (liveP - pos.entryPrice) * qty
          : (pos.entryPrice - liveP) * qty;
        console.log(`  ⏳ [${pid}] ${pos.symbol} ${pos.side} | Ulaz ${fmtPrice(pos.entryPrice)} | Sad ${fmtPrice(liveP)} | P&L ${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(4)}`);
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

function writeExitCsv(pid, pos, exitPrice, reason, pnl) {
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

// Zatvori live poziciju na BitGetu (market close order)
async function closeBitGetOrder(pos) {
  const quantity = (pos.quantity ?? (pos.totalUSD / pos.entryPrice)).toFixed(4);
  const closeSide = pos.side === "LONG" ? "sell" : "buy";
  const path = "/api/v2/mix/order/place-order";
  const orderBody = {
    symbol:      pos.symbol,
    productType: "USDT-FUTURES",
    marginMode:  "isolated",
    marginCoin:  "USDT",
    side:        closeSide,
    tradeSide:   "close",
    orderType:   "market",
    size:        quantity,
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
  console.log(`  📨 BitGet CLOSE response: code=${data.code} msg=${data.msg}`);
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

const CB_LOSSES    = 7;           // broj uzastopnih gubitaka → blokada
const CB_COOLDOWN  = 8 * 60 * 60 * 1000;  // 8 sati u ms
const CB_DRAWDOWN_MIN = 250;      // minimalni equity ($) — ispod = stop trading
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
  const slPct = pDef?.slPct ?? SL_PCT;
  const tpPct = pDef?.tpPct ?? TP_PCT;

  for (const bp of bitgetPos) {
    const side   = bp.holdSide === "long" ? "LONG" : "SHORT";
    const key    = `${bp.symbol}:${side}`;
    if (existingKeys.has(key)) continue;  // već praćena

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

    // ── Drawdown zaštita: equity < $250 → stop sve ────────────────────────────
    const equityNow = getPortfolioEquity(pid, pDef.startCapital || START_CAPITAL);
    if (equityNow < CB_DRAWDOWN_MIN) {
      console.log(`  🛑 [${pDef.name}] DRAWDOWN ZAŠTITA — equity $${equityNow.toFixed(2)} < $${CB_DRAWDOWN_MIN} — trading zablokiran!`);
      await tg(`🛑 <b>DRAWDOWN ZAŠTITA [${pDef.name}]</b>\nEquity: $${equityNow.toFixed(2)} — ispod minimuma $${CB_DRAWDOWN_MIN}\nTrading zablokiran do ručnog reseta.`);
      continue;
    }

    // ── Circuit breaker: 7 uzastopnih gubitaka → 8h pauza ────────────────────
    if (!await checkCircuitBreaker(pid, pDef.name)) continue;

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

    for (const symbol of pDef.symbols) {
      if (openSymbols.includes(symbol)) {
        console.log(`  ⏭️  [${pDef.name}] ${symbol} — pozicija već otvorena`);
        continue;
      }

      // Provjeri limit ponovo unutar petlje — BTC uvijek prolazi bez obzira na broj
      const currentOpen = loadPositions(pid).length;
      if (currentOpen >= MAX_OPEN_PER_PORTFOLIO && symbol !== BTC_EXCEPTION) {
        console.log(`  🔒 [${pDef.name}] Max ${MAX_OPEN_PER_PORTFOLIO} dostignut — preskačem ${symbol} (nije BTC)`);
        continue;  // continue umjesto break — da BTC na kraju liste ipak prođe
      }

      try {
        const candles = await fetchCandles(symbol, pDef.timeframe, 250);
        const price   = candles[candles.length - 1].close;

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

        // 🔄 INVERTED MODE — trgujemo suprotno od signala (long→short, short→long)
        const INVERT_SIGNALS = false;
        if (INVERT_SIGNALS && signal !== "NEUTRAL") {
          const orig = signal;
          signal = signal === "LONG" ? "SHORT" : "LONG";
          console.log(`  🔄 INVERT: ${orig} → ${signal} ${symbol}`);
        }

        // SL/TP — per-portfolio (fallback na globalne konstante)
        const slPct  = pDef.slPct ?? SL_PCT;
        const tpPct  = pDef.tpPct ?? TP_PCT;
        const slDist = price * (slPct / 100);
        const tpDist = price * (tpPct / 100);
        const sl = signal === "LONG" ? price - slDist : price + slDist;
        const tp = signal === "LONG" ? price + tpDist : price - tpDist;

        // Risk-based position sizing: SL gubitak = točno RISK_PCT% trenutne equity
        // notional = riskAmount / slPct  →  SL hit = -riskAmount, TP hit = +riskAmount*(tpPct/slPct)
        // margin = notional / actualLeverage — prilagođava se ako simbol ne podržava 100x
        const startCap   = pDef.startCapital ?? START_CAPITAL;
        const equity     = getPortfolioEquity(pid, startCap);
        const riskAmount = equity * (RISK_PCT / 100);
        const tradeSize  = riskAmount / (slPct / 100);
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
        const entry = { symbol, signal, price, sl, tp, tradeSize, margin, orderId, timestamp, strategy: pDef.strategy, timeframe: pDef.timeframe, slPct, tpPct, mode };

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

// ─── Fast breakout checker (svake minute) ──────────────────────────────────────
// Provjerava pending breakout trigere bez punog signal scana.
// Čim live cijena probije triggerHigh (LONG) ili triggerLow (SHORT) → odmah otvara trade.

export async function checkBreakouts() {
  const pid     = "synapse_t";
  const TTL     = 15 * 60 * 1000;
  const now     = Date.now();
  let   pending = loadPending(pid);

  // Makni istekle
  pending = pending.filter(p => now - p.ts < TTL);
  if (pending.length === 0) return;

  const rules     = JSON.parse(readFileSync("rules.json", "utf8"));
  const portfolios = buildPortfolios(rules);
  const pDef      = portfolios[pid];
  if (!pDef) return;

  const openPositions = loadPositions(pid);
  const openSymbols   = openPositions.map(p => p.symbol);

  for (const p of pending) {
    const { symbol, side, triggerHigh, triggerLow, signalPrice, ts } = p;

    // Provjeri limit svaki put (čitaj svježe da uvaži pozicije otvorene unutar iste petlje)
    const currentOpen = loadPositions(pid);
    if (currentOpen.length >= MAX_OPEN_PER_PORTFOLIO) {
      console.log(`  🔒 [checkBreakouts] Max ${MAX_OPEN_PER_PORTFOLIO} otvorenih — preskačem ${symbol}`);
      break;
    }

    // Ako već otvorena pozicija za ovaj simbol — preskoči
    if (currentOpen.map(x => x.symbol).includes(symbol)) continue;

    // Dohvati live ticker s Bitgeta
    let livePrice;
    try {
      const tickerUrl = `${BITGET.baseUrl}/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`;
      const tj = await fetch(tickerUrl).then(r => r.json());
      livePrice = parseFloat(tj?.data?.[0]?.lastPr || tj?.data?.[0]?.close || 0);
    } catch (_) { continue; }

    if (!livePrice) continue;

    const hit = side === "LONG"  ? livePrice >= triggerHigh
              : side === "SHORT" ? livePrice <= triggerLow
              : false;

    if (!hit) {
      console.log(`  ⏳ [ULTRA BRK fast] ${symbol} ${side} | Live: ${fmtPrice(livePrice)} | TrigH: ${fmtPrice(triggerHigh)} TrigL: ${fmtPrice(triggerLow)}`);
      continue;
    }

    // BREAKOUT! — makni iz pendinga i otvori trade
    const newPending = pending.filter(x => !(x.symbol === symbol && x.side === side));
    savePending(pid, newPending);

    // 🔄 INVERT: isti flag kao u glavnom scanneru
    const INVERT_SIGNALS = false;
    const actualSide = INVERT_SIGNALS ? (side === "LONG" ? "SHORT" : "LONG") : side;
    if (INVERT_SIGNALS) console.log(`  🔄 BRK INVERT: ${side} → ${actualSide} ${symbol}`);

    const slPct  = pDef.slPct ?? SL_PCT;
    const tpPct  = pDef.tpPct ?? TP_PCT;
    const slDist = livePrice * (slPct / 100);
    const tpDist = livePrice * (tpPct / 100);
    const sl = actualSide === "LONG" ? livePrice - slDist : livePrice + slDist;
    const tp = actualSide === "LONG" ? livePrice + tpDist : livePrice - tpDist;

    const startCap   = pDef.startCapital ?? START_CAPITAL;
    const equity     = getPortfolioEquity(pid, startCap);
    const riskAmount = equity * (RISK_PCT / 100);
    const tradeSize  = riskAmount / (slPct / 100);
    const margin     = tradeSize / LEVERAGE;

    if (!checkDailyLimit(pid)) continue;

    console.log(`🚀 [ULTRA BRK fast] ${side} ${symbol} @ ${fmtPrice(livePrice)} | SL ${fmtPrice(sl)} | TP ${fmtPrice(tp)}`);

    const isLive    = pDef.live === true && !PAPER_TRADING;
    const timestamp = new Date().toISOString();
    const orderId   = `${isLive ? "LIVE" : "PAPER"}-BRK-${Date.now()}`;
    const mode      = isLive ? (BITGET_DEMO ? "DEMO" : "LIVE") : "PAPER";
    const entry     = { symbol, signal: actualSide, price: livePrice, sl, tp, tradeSize, margin, orderId, timestamp, strategy: pDef.strategy, timeframe: pDef.timeframe, slPct, tpPct, mode };

    if (!isLive) {
      addPosition(pid, entry);
      writeEntryCsv(pid, entry);
      await tg(`📋 PAPER [ULTRA/fast] ${side === "LONG" ? "📈" : "📉"} <b>${side} ${symbol}</b>\nUlaz: ${fmtPrice(livePrice)} | SL: ${fmtPrice(sl)} | TP: ${fmtPrice(tp)}\nBreakout detektiran u realnom vremenu`);
    } else {
      try {
        const order = await placeBitGetOrder(symbol, side, tradeSize, livePrice, sl, tp, slPct, tpPct);
        const usedLev    = order?.actualLeverage || LEVERAGE;
        const usedMargin = tradeSize / usedLev;
        entry.orderId = order?.orderId || orderId;
        entry.margin  = usedMargin;
        addPosition(pid, entry);
        writeEntryCsv(pid, entry);
        await tg(`🔴 LIVE [ULTRA/fast] ${side === "LONG" ? "📈" : "📉"} <b>${side} ${symbol}</b>\nUlaz: ${fmtPrice(livePrice)} | SL: ${fmtPrice(sl)} | TP: ${fmtPrice(tp)}\nBreakout detektiran u realnom vremenu | ${usedLev}x`);
      } catch (err) {
        console.log(`  ❌ LIVE BRK NALOG PAO — ${err.message}`);
        await tg(`❌ LIVE BRK GREŠKA [ULTRA] ${symbol}\n${err.message}`);
      }
    }
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
