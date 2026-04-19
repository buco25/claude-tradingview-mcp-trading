/**
 * Claude + TradingView MCP — Fib Golden Pocket + Market Structure Bot
 *
 * Strategija: Pivot detekcija (HH+HL / LH+LL) + Fib Golden Pocket (0.5-0.618)
 *             + Sniper EMA9/EMA21 filter + ATR SL + 1.5x Fib TP
 *
 * Backtest: BINANCE:BTCUSDT.P 1H | PF 1.78 | +42.67% | 8.01% DD (15 mj.)
 *
 * Local:  node bot.js
 * Cloud:  Railway (cron svaki sat: "0 * * * *")
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import crypto from "crypto";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    console.log(`\n⚠️  Nedostaju kredencijali u .env: ${missing.join(", ")}`);
    console.log("Dodaj ih u .env fajl i ponovo pokreni: node bot.js\n");
    process.exit(0);
  }

  // onboarding done
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol:          process.env.SYMBOL           || "BTCUSDT",
  timeframe:       process.env.TIMEFRAME         || "1H",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD  || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD   || "50"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY     || "100"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  bitgetDemo:      process.env.BITGET_DEMO === "true",
  tradeMode:       process.env.TRADE_MODE        || "futures",
  leverage:        parseInt(process.env.LEVERAGE  || "5"),
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
  // Strategija parametri
  strategy: {
    pivotLen:  4,      // Pivot lookback
    fibLo:     0.45,   // Fib zona donja granica
    fibHi:     0.65,   // Fib zona gornja granica
    fibTp:     1.5,    // Fib TP ekstenzija
    ema9Len:   9,      // EMA brzi
    ema21Len:  21,     // EMA spori
    atrLen:    14,     // ATR period
    atrSlMult: 0.5,    // ATR × 0.5 za SL buffer
    riskPct:   1.5,    // Rizik % po tradeu
  },
};

// ─── Perzistentni data direktorij (Railway Volume na /app/data, lokalno ./data) ─
const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : ".");
if (DATA_DIR !== "." && !existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const LOG_FILE = `${DATA_DIR}/safety-check-log.json`;

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced
  ).length;
}

// ─── Market Data (BitGet Futures public API — besplatno, bez autentikacije) ──

async function fetchCandles(symbol, interval, limit = 200) {
  const intervalMap = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "1H", "4H": "4H", "1D": "1D", "1W": "1W",
  };
  const granularity = intervalMap[interval] || "1H";
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BitGet API greška: ${res.status}`);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(`BitGet greška: ${json.msg}`);
  // BitGet vraća: [timestamp, open, high, low, close, volume, quoteVolume]
  return json.data.map((k) => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  })); // BitGet vraća od starijeg prema novijem — već chronološki, NE reversati
}

// ─── Indikatori ─────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
  }
  return ema;
}

function calcATR(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low  = candles[i].low;
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  // Wilders smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 3) return null;
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  let smTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smPDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smMDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxArr = [];
  for (let i = period; i < trs.length; i++) {
    smTR  = smTR  - smTR  / period + trs[i];
    smPDM = smPDM - smPDM / period + plusDMs[i];
    smMDM = smMDM - smMDM / period + minusDMs[i];
    const pdi = smTR > 0 ? 100 * smPDM / smTR : 0;
    const mdi = smTR > 0 ? 100 * smMDM / smTR : 0;
    const diSum = pdi + mdi;
    dxArr.push(diSum > 0 ? 100 * Math.abs(pdi - mdi) / diSum : 0);
  }
  if (dxArr.length < period) return null;
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) adx = (adx * (period - 1) + dxArr[i]) / period;
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
  if (range === 0 || atrSum === 0) return null;
  return 100 * Math.log10(atrSum / range) / Math.log10(period);
}

// ─── Timezone helper ─────────────────────────────────────────────────────────

function getCROHour() {
  // Hrvatsko vrijeme: CEST = UTC+2 (ožujak–listopad), CET = UTC+1 (listopad–ožujak)
  const now   = new Date();
  const month = now.getUTCMonth() + 1;
  const day   = now.getUTCDate();
  // DST: zadnja nedjelja u ožujku → zadnja nedjelja u listopadu (aproksimacija)
  const isDST = (month > 3 && month < 10) ||
                (month === 3 && day >= 25) ||
                (month === 10 && day < 25);
  const offset = isDST ? 2 : 1;
  return (now.getUTCHours() + offset) % 24;
}

// ─── Order Block helpers ─────────────────────────────────────────────────────

const OB_PENDING_FILE = `${DATA_DIR}/ob_pending.json`;

function loadObPending() {
  if (!existsSync(OB_PENDING_FILE)) return [];
  try { return JSON.parse(readFileSync(OB_PENDING_FILE, "utf8")); }
  catch { return []; }
}

function saveObPending(list) {
  writeFileSync(OB_PENDING_FILE, JSON.stringify(list, null, 2));
}

function getObTrend(candles, e21Len = 21, e50Len = 50) {
  const closes = candles.map(c => c.close);
  const e21 = calcEMA(closes, e21Len);
  const e50 = calcEMA(closes, e50Len);
  if (!e21 || !e50) return "NEUTRAL";
  const price = closes[closes.length - 1];
  if (price > e21 && e21 > e50) return "UP";
  if (price < e21 && e21 < e50) return "DOWN";
  return "NEUTRAL";
}

function findObCandle(candles, trend, lookback = 10) {
  const lb = Math.min(lookback, candles.length - 2);
  for (let i = candles.length - 1; i >= candles.length - lb; i--) {
    const c     = candles[i];
    const later = candles.slice(i + 1);
    if (!later.length) continue;
    // Uptrend: bearish svjeća (down-close) potvrđena probijanjem iznad nje
    if (trend === "UP" && c.close < c.open && later.some(l => l.high > c.high))
      return { high: c.high, low: c.low, bodyTop: c.open, bodyBot: c.close };
    // Downtrend: bullish svjeća (up-close) potvrđena probijanjem ispod nje
    if (trend === "DOWN" && c.close > c.open && later.some(l => l.low < c.low))
      return { high: c.high, low: c.low, bodyTop: c.close, bodyBot: c.open };
  }
  return null;
}

function analyzeOrderBlock(candles, cfg, symbol) {
  const { sessionHours, obLookback, ema21Len, ema50Len, rrRatio } = cfg;
  const currentHour = getCROHour();  // Hrvatsko vrijeme (CEST/CET)
  const current     = candles[candles.length - 1];
  const price       = current.close;

  // ── Provjeri postoje li aktivni setups za ovaj simbol ────────────────────
  const all    = loadObPending();
  const maxAge = 3 * 60 * 60 * 1000; // 3h window
  const now    = Date.now();
  const active = all.filter(p => p.symbol === symbol && (now - p.createdAt) < maxAge);
  const others = all.filter(p => p.symbol !== symbol);

  for (const setup of active) {
    const { ob, trend } = setup;
    const inZone = current.low <= ob.bodyTop && current.high >= ob.bodyBot;

    if (trend === "UP" && inZone) {
      const entryPrice = price;
      const sl = ob.low;
      const tp = entryPrice + rrRatio * (entryPrice - sl);
      saveObPending([...others, ...active.filter(p => p.id !== setup.id)]);
      return { signal: "LONG",  price: entryPrice, sl, tp,
               reason: `OB retest — ${setup.session} | Zona ${ob.bodyBot.toFixed(0)}–${ob.bodyTop.toFixed(0)}` };
    }
    if (trend === "DOWN" && inZone) {
      const entryPrice = price;
      const sl = ob.high;
      const tp = entryPrice - rrRatio * (sl - entryPrice);
      saveObPending([...others, ...active.filter(p => p.id !== setup.id)]);
      return { signal: "SHORT", price: entryPrice, sl, tp,
               reason: `OB retest — ${setup.session} | Zona ${ob.bodyBot.toFixed(0)}–${ob.bodyTop.toFixed(0)}` };
    }
  }

  // Spremi očišćenu listu (istekli uklonjeni)
  saveObPending([...others, ...active]);

  // ── Session open: kreiraj novi setup ─────────────────────────────────────
  const sessionName = currentHour === 9  ? "London/LSE"
                    : currentHour === 15 ? "New York/NYSE"
                    : null;
  if (sessionHours.includes(currentHour) && sessionName) {
    const trend = getObTrend(candles, ema21Len, ema50Len);
    if (trend !== "NEUTRAL") {
      const ob = findObCandle(candles, trend, obLookback);
      if (ob) {
        const setup = { id: now, symbol, ob, trend, session: sessionName, createdAt: now };
        saveObPending([...others, ...active, setup]);
        console.log(`  📌 OB ${symbol} ${sessionName} | ${trend} | $${ob.bodyBot.toFixed(0)}–$${ob.bodyTop.toFixed(0)}`);
      }
    } else {
    }
    return { signal: "NEUTRAL", price, reason: `${sessionName} session open — setup kreiran, čekam retest` };
  }

  const waitMsg = active.length > 0
    ? `Čekam retest OB zone (${active.length} setup aktivan, zona: ${active[0].ob.bodyBot.toFixed(0)}–${active[0].ob.bodyTop.toFixed(0)})`
    : "Nije session open, nema aktivnih OB setupova";
  return { signal: "NEUTRAL", price, reason: waitMsg };
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal + 2) return null;
  // Skupi MACD linije za svaki bar od indeksa `slow` nadalje
  const diffs = [];
  for (let i = slow; i <= closes.length; i++) {
    const f = calcEMA(closes.slice(0, i), fast);
    const s = calcEMA(closes.slice(0, i), slow);
    if (f !== null && s !== null) diffs.push(f - s);
  }
  const sigLine = calcEMA(diffs, signal);
  if (!sigLine) return null;
  const macdLine = diffs[diffs.length - 1];
  return macdLine - sigLine; // histogram
}

// Pivot High: vrh gdje je high[i] > svih high-ova ±pivotLen
function findPivots(candles, pivotLen) {
  const pivotHighs = [];
  const pivotLows  = [];

  // Tražimo samo potvrđene pivote (ne zadnjih pivotLen svjeća — nema potvrde)
  for (let i = pivotLen; i < candles.length - pivotLen; i++) {
    const c = candles[i];

    // Pivot High
    let isHigh = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j !== i && candles[j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) pivotHighs.push({ index: i, price: c.high, time: c.time });

    // Pivot Low
    let isLow = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j !== i && candles[j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) pivotLows.push({ index: i, price: c.low, time: c.time });
  }

  return { pivotHighs, pivotLows };
}

// ─── Market Struktura + Fib Golden Pocket ───────────────────────────────────

function analyzeMarket(candles, cfg) {
  const { pivotLen, fibLo, fibHi, fibTp, ema9Len, ema21Len, atrLen, atrSlMult } = cfg;

  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1];

  const ema9  = calcEMA(closes, ema9Len);
  const ema21 = calcEMA(closes, ema21Len);
  const atr   = calcATR(candles, atrLen);

  const { pivotHighs, pivotLows } = findPivots(candles, pivotLen);

  // Potrebna su min 2 pivot higha i 2 pivot lowa
  if (pivotHighs.length < 2 || pivotLows.length < 2) {
    return { price, ema9, ema21, atr, signal: "NEUTRAL", reason: "Nedovoljno pivota za strukturu" };
  }

  // Zadnja dva pivot higha i lowa (kronološki)
  const ph1 = pivotHighs[pivotHighs.length - 1].price;
  const ph2 = pivotHighs[pivotHighs.length - 2].price;
  const pl1 = pivotLows[pivotLows.length - 1].price;
  const pl2 = pivotLows[pivotLows.length - 2].price;

  const uptrend   = ph1 > ph2 && pl1 > pl2;  // HH + HL
  const downtrend = ph1 < ph2 && pl1 < pl2;  // LH + LL

  // Fib zone za LONG (retracement od pl1 do ph1)
  const gpBullHi = ph1 - (ph1 - pl1) * fibLo;   // 0.5 nivo
  const gpBullLo = ph1 - (ph1 - pl1) * fibHi;   // 0.618 nivo
  const bullTp   = pl1 + (ph1 - pl1) * fibTp;   // 1.5x ekstenzija
  const longSl   = pl1 - atr * atrSlMult;

  // Fib zone za SHORT (retracement od ph1 do pl1)
  const gpBearLo = pl1 + (ph1 - pl1) * fibLo;
  const gpBearHi = pl1 + (ph1 - pl1) * fibHi;
  const bearTp   = ph1 - (ph1 - pl1) * fibTp;
  const shortSl  = ph1 + atr * atrSlMult;

  const inBullGp = price <= gpBullHi && price >= gpBullLo;
  const inBearGp = price >= gpBearLo && price <= gpBearHi;

  const sniperLong  = ema9 > ema21;
  const sniperShort = ema9 < ema21;

  return {
    price, ema9, ema21, atr,
    ph1, ph2, pl1, pl2,
    uptrend, downtrend,
    gpBullHi, gpBullLo, bullTp, longSl,
    gpBearLo, gpBearHi, bearTp, shortSl,
    inBullGp, inBearGp,
    sniperLong, sniperShort,
  };
}

// ─── EMA Cross + RSI Strategy ───────────────────────────────────────────────

function analyzeEmaRsi(candles, cfg) {
  const { ema9Len, ema21Len, ema50Len, rsiLen, rsiLongLo, rsiLongHi, rsiShortLo, rsiShortHi, atrLen, atrSl, atrTp } = cfg;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];

  const ema9  = calcEMA(closes, ema9Len);
  const ema21 = calcEMA(closes, ema21Len);
  const ema50 = calcEMA(closes, ema50Len);
  const rsi   = calcRSI(closes, rsiLen);
  const atr   = calcATR(candles, atrLen);

  if (!ema9 || !ema21 || !ema50 || !rsi || !atr) return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka" };

  // Crossover detection (compare last two candles)
  const prevCloses = closes.slice(0, -1);
  const prevEma9  = calcEMA(prevCloses, ema9Len);
  const prevEma21 = calcEMA(prevCloses, ema21Len);

  const crossUp   = prevEma9 <= prevEma21 && ema9 > ema21;
  const crossDown = prevEma9 >= prevEma21 && ema9 < ema21;

  let signal = "NEUTRAL", sl = null, tp = null, reason = "";

  if (price > ema50 && crossUp && rsi >= rsiLongLo && rsi <= rsiLongHi) {
    signal = "LONG";
    sl = price - atr * atrSl;
    tp = price + atr * atrTp;
    reason = `EMA cross UP | RSI ${rsi.toFixed(1)} | Cijena > EMA50`;
  } else if (price < ema50 && crossDown && rsi >= rsiShortLo && rsi <= rsiShortHi) {
    signal = "SHORT";
    sl = price + atr * atrSl;
    tp = price - atr * atrTp;
    reason = `EMA cross DOWN | RSI ${rsi.toFixed(1)} | Cijena < EMA50`;
  } else {
    if (!crossUp && !crossDown) reason = "Nema EMA crossovera";
    else if (price <= ema50 && crossUp) reason = "Cross UP ali cijena ispod EMA50";
    else if (price >= ema50 && crossDown) reason = "Cross DOWN ali cijena iznad EMA50";
    else if (crossUp && (rsi < rsiLongLo || rsi > rsiLongHi)) reason = `RSI ${rsi.toFixed(1)} izvan zone [${rsiLongLo}-${rsiLongHi}]`;
    else if (crossDown && (rsi < rsiShortLo || rsi > rsiShortHi)) reason = `RSI ${rsi.toFixed(1)} izvan zone [${rsiShortLo}-${rsiShortHi}]`;
    else reason = "Uvjeti nisu ispunjeni";
  }

  return { price, ema9, ema21, ema50, rsi, atr, signal, sl, tp, reason, crossUp, crossDown };
}

// ─── 3-Layer Strategy (Signal + Momentum + Trend) ───────────────────────────

function analyzeThreeLayer(candles, cfg) {
  const { ema9Len, ema21Len, ema145Len, macdFast, macdSlow, macdSignal, atrLen, atrSl, atrTp } = cfg;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];

  const ema9   = calcEMA(closes, ema9Len);
  const ema21  = calcEMA(closes, ema21Len);
  const ema145 = calcEMA(closes, ema145Len);
  const atr    = calcATR(candles, atrLen);
  const hist   = calcMACD(closes, macdFast, macdSlow, macdSignal);

  if (!ema9 || !ema21 || !ema145 || !atr || hist === null) {
    return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka (EMA/MACD/ATR)" };
  }

  // Layer 1 — EMA9/21 crossover (signal layer)
  const prevCloses = closes.slice(0, -1);
  const prevEma9   = calcEMA(prevCloses, ema9Len);
  const prevEma21  = calcEMA(prevCloses, ema21Len);

  const crossUp   = prevEma9 !== null && prevEma21 !== null && prevEma9 <= prevEma21 && ema9 > ema21;
  const crossDown = prevEma9 !== null && prevEma21 !== null && prevEma9 >= prevEma21 && ema9 < ema21;

  // Layer 2 — MACD histogram (momentum)
  const bullMomentum = hist > 0;
  const bearMomentum = hist < 0;

  // Layer 3 — EMA145 trend filter
  const uptrend   = price > ema145;
  const downtrend = price < ema145;

  let signal = "NEUTRAL", sl = null, tp = null, reason = "";

  if (crossUp && bullMomentum && uptrend) {
    signal = "LONG";
    sl     = price - atr * atrSl;
    tp     = price + atr * atrTp;
    reason = `EMA9/21 cross UP | MACD hist ${hist.toFixed(6)} > 0 | Cijena > EMA145`;
  } else if (crossDown && bearMomentum && downtrend) {
    signal = "SHORT";
    sl     = price + atr * atrSl;
    tp     = price - atr * atrTp;
    reason = `EMA9/21 cross DOWN | MACD hist ${hist.toFixed(6)} < 0 | Cijena < EMA145`;
  } else {
    if (!crossUp && !crossDown)      reason = "Nema EMA crossovera";
    else if (!bullMomentum && crossUp)  reason = `MACD hist negativan (${hist.toFixed(6)}) — nema momentum`;
    else if (!bearMomentum && crossDown) reason = `MACD hist pozitivan (${hist.toFixed(6)}) — nema momentum`;
    else if (!uptrend && crossUp)    reason = `Cijena ispod EMA145 — trend filter odbio LONG`;
    else if (!downtrend && crossDown) reason = `Cijena iznad EMA145 — trend filter odbio SHORT`;
    else reason = "Uvjeti nisu ispunjeni";
  }

  return { price, ema9, ema21, ema145, atr, hist, signal, sl, tp, reason, crossUp, crossDown };
}

// ─── MEGA Strategy ──────────────────────────────────────────────────────────

function analyzeMega(candles, cfg) {
  const {
    ema9Len = 9, ema21Len = 21, ema55Len = 55, ema200Len = 200,
    rsiLen = 14, adxLen = 14, adxMin = 18, chopLen = 14, chopMax = 61.8,
    rsiLongLo = 30, rsiLongHi = 60, rsiShortLo = 40, rsiShortHi = 70,
    atrLen = 14, slMult = 1.5, tpMult = 3.0,
  } = cfg;

  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length - 1];
  const ema9    = calcEMA(closes, ema9Len);
  const ema21   = calcEMA(closes, ema21Len);
  const ema55   = calcEMA(closes, ema55Len);
  const ema200  = calcEMA(closes, ema200Len);
  const rsi     = calcRSI(closes, rsiLen);
  const atr     = calcATR(candles, atrLen);
  const adx     = calcADX(candles, adxLen);
  const chop    = calcChop(candles, chopLen);

  if (!ema9 || !ema21 || !ema55 || !atr || rsi === null) {
    return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka" };
  }

  const prevCloses = closes.slice(0, -1);
  const prevEma9   = calcEMA(prevCloses, ema9Len);
  const prevEma21  = calcEMA(prevCloses, ema21Len);
  if (!prevEma9 || !prevEma21) return { price, signal: "NEUTRAL", reason: "Nedovoljno podataka za cross" };

  const crossUp   = prevEma9 <= prevEma21 && ema9 > ema21;
  const crossDown = prevEma9 >= prevEma21 && ema9 < ema21;

  const trendUp   = price > ema55 && (!ema200 || price > ema200);
  const trendDown = price < ema55 && (!ema200 || price < ema200);
  const trending  = adx === null || adx > adxMin;
  const notChoppy = chop === null || chop < chopMax;

  let signal = "NEUTRAL", sl = null, tp = null, reason = "";

  if (crossUp && trendUp && rsi > rsiLongLo && rsi < rsiLongHi && trending && notChoppy) {
    signal = "LONG";
    sl     = price - atr * slMult;
    tp     = price + atr * tpMult;
    reason = `EMA9/21 cross UP | RSI ${rsi.toFixed(1)} | ADX ${adx?.toFixed(1) ?? "n/a"} | Chop ${chop?.toFixed(1) ?? "n/a"}`;
  } else if (crossDown && trendDown && rsi > rsiShortLo && rsi < rsiShortHi && trending && notChoppy) {
    signal = "SHORT";
    sl     = price + atr * slMult;
    tp     = price - atr * tpMult;
    reason = `EMA9/21 cross DOWN | RSI ${rsi.toFixed(1)} | ADX ${adx?.toFixed(1) ?? "n/a"} | Chop ${chop?.toFixed(1) ?? "n/a"}`;
  } else {
    const why = [];
    if (!crossUp && !crossDown)               why.push("Nema EMA9/21 crossovera");
    if ((crossUp && !trendUp) || (crossDown && !trendDown)) why.push("Trend filter (EMA55/200) nije potvrđen");
    if (crossUp   && !(rsi > rsiLongLo && rsi < rsiLongHi))   why.push(`RSI ${rsi.toFixed(1)} van zone ${rsiLongLo}-${rsiLongHi}`);
    if (crossDown && !(rsi > rsiShortLo && rsi < rsiShortHi)) why.push(`RSI ${rsi.toFixed(1)} van zone ${rsiShortLo}-${rsiShortHi}`);
    if (!trending)  why.push(`ADX ${adx?.toFixed(1) ?? "n/a"} < ${adxMin}`);
    if (!notChoppy) why.push(`Chop ${chop?.toFixed(1) ?? "n/a"} > ${chopMax}`);
    reason = why.join(" | ") || "Uvjeti nisu ispunjeni";
  }

  return { price, ema9, ema21, ema55, ema200, rsi, atr, adx, chop, signal, sl, tp, reason };
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(m) {
  const results = [];
  let signal = "NEUTRAL";

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
  };

  if (m.uptrend) {
    check("Uptrend potvrđen (HH + HL)", "ph1 > ph2 i pl1 > pl2",
      `ph1=${m.ph1?.toFixed(0)} > ph2=${m.ph2?.toFixed(0)}, pl1=${m.pl1?.toFixed(0)} > pl2=${m.pl2?.toFixed(0)}`, m.uptrend);
    check("Cijena u Fib Golden Pocket zoni (0.5–0.618)",
      `$${m.gpBullLo?.toFixed(2)} – $${m.gpBullHi?.toFixed(2)}`, `$${m.price?.toFixed(2)}`, m.inBullGp);
    check("EMA9 > EMA21 (Sniper long potvrda)", `EMA9 > EMA21`,
      `EMA9=${m.ema9?.toFixed(2)} | EMA21=${m.ema21?.toFixed(2)}`, m.sniperLong);
    if (results.every((r) => r.pass)) signal = "LONG";
  } else if (m.downtrend) {
    check("Downtrend potvrđen (LH + LL)", "ph1 < ph2 i pl1 < pl2",
      `ph1=${m.ph1?.toFixed(0)} < ph2=${m.ph2?.toFixed(0)}, pl1=${m.pl1?.toFixed(0)} < pl2=${m.pl2?.toFixed(0)}`, m.downtrend);
    check("Cijena u Fib Golden Pocket zoni (0.5–0.618)",
      `$${m.gpBearLo?.toFixed(2)} – $${m.gpBearHi?.toFixed(2)}`, `$${m.price?.toFixed(2)}`, m.inBearGp);
    check("EMA9 < EMA21 (Sniper short potvrda)", `EMA9 < EMA21`,
      `EMA9=${m.ema9?.toFixed(2)} | EMA21=${m.ema21?.toFixed(2)}`, m.sniperShort);
    if (results.every((r) => r.pass)) signal = "SHORT";
  } else {
    results.push({ label: "Market struktura NEUTRAL", required: "Uptrend ili Downtrend", actual: "Neutral", pass: false });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass, signal };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log, marginUsed) {
  const todayCount = countTodaysTrades(log);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`❌ Dnevni limit dostignut: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return { ok: false, stopAll: true };
  }
  if (marginUsed > CONFIG.maxTradeSizeUSD) {
    return { ok: false, stopAll: false };
  }
  return { ok: true, stopAll: false, todayCount };
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey).update(message).digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price, sl, tp) {
  const quantity  = (sizeUSD / price).toFixed(4);
  const timestamp = Date.now().toString();
  const path      = "/api/v2/mix/order/place-order";

  const orderBody = {
    symbol:      symbol,           // već sadrži USDT npr. "DOGEUSDT"
    productType: "USDT-FUTURES",
    marginMode:  "isolated",
    marginCoin:  "USDT",
    side:        side === "LONG" ? "buy" : "sell",
    tradeSide:   "open",
    orderType:   "market",
    size:        quantity,
  };
  if (sl) orderBody.presetStopLossPrice   = fmtPrice(sl);
  if (tp) orderBody.presetTakeProfitPrice = fmtPrice(tp);

  const body = JSON.stringify(orderBody);

  const signature = signBitGet(timestamp, "POST", path, body);

  const headers = {
    "Content-Type":      "application/json",
    "ACCESS-KEY":        CONFIG.bitget.apiKey,
    "ACCESS-SIGN":       signature,
    "ACCESS-TIMESTAMP":  timestamp,
    "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
  };
  if (CONFIG.bitgetDemo) headers["x-simulated-trading"] = "1";

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers,
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet greška: ${data.msg}`);
  return data.data;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Dinamički broj decimala ovisno o veličini cijene
function fmtPrice(price) {
  if (!price && price !== 0) return "";
  if (price >= 1000)  return price.toFixed(2);
  if (price >= 1)     return price.toFixed(4);
  if (price >= 0.001) return price.toFixed(6);
  return price.toFixed(10);
}

// ─── Position Tracking ───────────────────────────────────────────────────────

const POSITIONS_FILE = `${DATA_DIR}/open_positions.json`;

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return [];
  try { return JSON.parse(readFileSync(POSITIONS_FILE, "utf8")); }
  catch { return []; }
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// Provjeri jesu li otvorene pozicije dostigle TP ili SL
async function checkOpenPositions() {
  const positions = loadPositions();
  if (positions.length === 0) return [];

  const closed = [];
  const stillOpen = [];

  if (positions.length > 0) console.log(`  🔍 Provjera ${positions.length} otvorenih pozicija`);

  for (const pos of positions) {
    try {
      const candles = await fetchCandles(pos.symbol, CONFIG.timeframe, 5);
      const current = candles[candles.length - 1];
      const high    = current.high;
      const low     = current.low;
      const close   = current.close;

      let exitReason = null;
      let exitPrice  = null;

      if (pos.side === "LONG") {
        if (high >= pos.tp) {
          exitReason = "TP dostignut";
          exitPrice  = pos.tp;
        } else if (low <= pos.sl) {
          exitReason = "SL dostignut";
          exitPrice  = pos.sl;
        }
      } else if (pos.side === "SHORT") {
        if (low <= pos.tp) {
          exitReason = "TP dostignut";
          exitPrice  = pos.tp;
        } else if (high >= pos.sl) {
          exitReason = "SL dostignut";
          exitPrice  = pos.sl;
        }
      }

      if (exitReason) {
        const pnl = pos.side === "LONG"
          ? (exitPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - exitPrice) * pos.quantity;
        const pnlPct = (pnl / pos.totalUSD) * 100;

        console.log(`  ${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} ${pos.symbol} ${pos.side} | Ulaz ${fmtPrice(pos.entryPrice)} → ${fmtPrice(exitPrice)} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`);

        writeExitCsv(pos, exitPrice, exitReason, pnl);
        closed.push({ ...pos, exitPrice, exitReason, pnl });
      } else {
        const unrealizedPnl = pos.side === "LONG"
          ? (close - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - close) * pos.quantity;
        console.log(`  ⏳ ${pos.symbol} ${pos.side} | Ulaz ${fmtPrice(pos.entryPrice)} | Sad ${fmtPrice(close)} | P&L ${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(4)}`);
        stillOpen.push(pos);
      }
    } catch (err) {
      console.log(`  ⚠️  Greška pri provjeri ${pos.symbol}: ${err.message}`);
      stillOpen.push(pos);
    }
  }

  savePositions(stillOpen);
  return closed;
}

function addOpenPosition(entry) {
  const positions = loadPositions();
  const quantity  = entry.tradeSize / entry.price;
  positions.push({
    symbol:     entry.symbol,
    side:       entry.signal,
    entryPrice: entry.price,
    quantity,
    totalUSD:   entry.tradeSize,
    sl:         entry.sl,
    tp:         entry.tp,
    orderId:    entry.orderId,
    mode:       entry.paperTrading ? "PAPER" : entry.bitgetDemo ? "DEMO" : "LIVE",
    openedAt:   entry.timestamp,
  });
  savePositions(positions);
}

// ─── Tax CSV ─────────────────────────────────────────────────────────────────

const CSV_FILE    = `${DATA_DIR}/trades.csv`;
const CSV_HEADERS = ["Date","Time (UTC)","Exchange","Symbol","Side","Quantity","Price","Total USD","Fee (est.)","Net P&L","SL","TP","Order ID","Mode","Notes"].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const note = `,,,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
  }
}

function writeTradeCsv(entry) {
  const now  = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "", qty = "", total = "", fee = "", net = "", sl = "", tp = "", orderId = "", mode = "", notes = "";

  if (!entry.allPass) {
    const failed = entry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED"; orderId = "BLOCKED"; notes = `Blokirano: ${failed}`;
  } else {
    const quantity = entry.tradeSize / entry.price;
    side    = entry.signal;
    qty     = quantity.toFixed(6);
    total   = entry.tradeSize.toFixed(2);
    fee     = (entry.tradeSize * 0.0005).toFixed(4);
    net     = "OPEN";
    sl      = fmtPrice(entry.sl);
    tp      = fmtPrice(entry.tp);
    orderId = entry.orderId || "";
    mode    = entry.paperTrading ? "PAPER" : entry.bitgetDemo ? "DEMO" : "LIVE";
    notes   = entry.error ? `Greška: ${entry.error}` : "Svi uvjeti ispunjeni";
  }

  const row = [date, time, "BitGet", entry.symbol, side, qty, fmtPrice(entry.price), total, fee, net, sl, tp, orderId, mode, `"${notes}"`].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
}

function writeExitCsv(pos, exitPrice, reason, pnl) {
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  const exitSide = pos.side === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT";
  const fee      = (pos.totalUSD * 0.0005).toFixed(4);
  const netPnl   = (pnl - parseFloat(fee)).toFixed(4);
  const icon     = pnl >= 0 ? "WIN" : "LOSS";

  const row = [
    date, time, "BitGet", pos.symbol,
    exitSide,
    pos.quantity.toFixed(6),
    fmtPrice(exitPrice),
    pos.totalUSD.toFixed(2),
    fee,
    netPnl,
    fmtPrice(pos.sl),
    fmtPrice(pos.tp),
    pos.orderId || "",
    pos.mode,
    `"${icon}: ${reason} | Ulaz ${fmtPrice(pos.entryPrice)} → Izlaz ${fmtPrice(exitPrice)}"`,
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
}

// Tax summary: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("Nema trades.csv — još nema tradova."); return; }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows  = lines.slice(1).map((l) => l.split(","));
  const live    = rows.filter((r) => r[13] === "LIVE");
  const paper   = rows.filter((r) => r[13] === "PAPER");
  const blocked = rows.filter((r) => r[13] === "BLOCKED");
  const totalVol  = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
  console.log("\n── Tax Sažetak ──────────────────────────────────────────\n");
  console.log(`  Ukupno odluka:          ${rows.length}`);
  console.log(`  Live tradovi:           ${live.length}`);
  console.log(`  Paper tradovi:          ${paper.length}`);
  console.log(`  Blokirani:              ${blocked.length}`);
  console.log(`  Ukupni volumen (USD):   $${totalVol.toFixed(2)}`);
  console.log(`  Ukupne naknade (proc.): $${totalFees.toFixed(4)}`);
  console.log(`\n  Kompletan zapis: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  const modLabel = CONFIG.paperTrading ? "PAPER" : CONFIG.bitgetDemo ? "DEMO" : "LIVE";

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const watchlistGP   = rules.watchlist_fib_gp   || [];
  const watchlistEMA  = rules.watchlist_ema_rsi  || [];
  const watchlist3L   = rules.watchlist_3layer   || [];
  const watchlistOB   = rules.watchlist_ob       || [];
  const watchlistMEGA = rules.watchlist_mega     || [];
  const symbolTFs     = rules.symbol_timeframes  || {};
  const watchlist = [...watchlistGP, ...watchlistEMA, ...watchlist3L, ...watchlistOB, ...watchlistMEGA];
  const stratGP   = rules.strategies.fib_gp.params;
  const stratEMA  = rules.strategies.ema_rsi.params;
  const strat3L   = rules.strategies.three_layer.params;
  const stratOB   = rules.strategies.order_block.params;
  const stratMEGA = rules.strategies.mega.params;

  // Per-symbol timeframe — sve strategije podržavaju vlastiti TF
  const utcNow = new Date();
  const utcMin = utcNow.getUTCMinutes();
  const utcHour = utcNow.getUTCHours();

  function getSymbolTF(symbol) {
    return symbolTFs[symbol] || rules.default_timeframe || "1H";
  }

  function shouldRunNow(tf) {
    switch (tf) {
      case "1m":  return true;
      case "5m":  return true;
      case "15m": return utcMin % 15 === 0;
      case "30m": return utcMin % 30 === 0;
      case "1H":  return utcMin === 0;
      case "4H":  return utcMin === 0 && utcHour % 4 === 0;
      case "1D":  return utcMin === 0 && utcHour === 0;
      default:    return utcMin === 0;
    }
  }

  console.log(`[${new Date().toISOString().slice(0,16)}] ${modLabel} | ${watchlist.length} simbola | ${CONFIG.leverage}x | UTC ${utcHour}:${String(utcMin).padStart(2,"0")}`);

  const log = loadLog();

  // Provjeri otvorene pozicije PRIJE skeniranja novih signala
  await checkOpenPositions();

  // Učitaj otvorene pozicije da preskočimo već otvorene parove
  const openSymbols = loadPositions().map(p => p.symbol);

  for (const symbol of watchlist) {
    if (openSymbols.includes(symbol)) {
      console.log(`  ⏭️  ${symbol} — pozicija već otvorena`);
      continue;
    }

    try {
      const symTF = getSymbolTF(symbol);
      if (!shouldRunNow(symTF)) continue; // silent skip — ne logiramo svaki TF skip

      const useMEGA = watchlistMEGA.includes(symbol);
      const useGP   = watchlistGP.includes(symbol);
      const use3L   = watchlist3L.includes(symbol);
      const useOB   = watchlistOB.includes(symbol);

      const candles = await fetchCandles(symbol, symTF, 200);
      const price   = candles[candles.length - 1].close;

      let signal, sl, tp, logConditions, allPass;

      if (useMEGA) {
        const mg = analyzeMega(candles, stratMEGA);
        signal  = mg.signal;
        sl      = mg.sl;
        tp      = mg.tp;
        allPass = signal !== "NEUTRAL";
        logConditions = [{ label: mg.reason, pass: allPass, required: "EMA cross + EMA55/200 + RSI + ADX + Chop", actual: mg.reason }];
        if (allPass) console.log(`🎯 SIGNAL ${symbol} MEGA ${signal} @ ${fmtPrice(price)} | SL ${fmtPrice(sl)} | TP ${fmtPrice(tp)}`);
        else console.log(`  🚫 ${symbol} MEGA — ${mg.reason}`);

      } else if (useGP) {
        const m = analyzeMarket(candles, { ...CONFIG.strategy, ...stratGP });
        if (!m.ema9 || !m.ema21 || !m.atr) { console.log(`  ⚠️  ${symbol} — nedovoljno podataka`); continue; }
        const sc = runSafetyCheck(m);
        signal        = sc.signal;
        allPass       = sc.allPass;
        logConditions = sc.results;
        sl = signal === "LONG" ? m.longSl : signal === "SHORT" ? m.shortSl : null;
        tp = signal === "LONG" ? m.bullTp : signal === "SHORT" ? m.bearTp  : null;
        if (allPass) console.log(`🎯 SIGNAL ${symbol} FibGP ${signal} @ ${fmtPrice(price)} | SL ${fmtPrice(sl)} | TP ${fmtPrice(tp)}`);

      } else if (use3L) {
        const t = analyzeThreeLayer(candles, strat3L);
        if (!t.ema9 || !t.ema145) { console.log(`  ⚠️  ${symbol} — nedovoljno podataka`); continue; }
        signal  = t.signal;
        sl      = t.sl;
        tp      = t.tp;
        allPass = signal !== "NEUTRAL";
        logConditions = [{ label: t.reason, pass: allPass, required: "EMA cross + MACD hist + EMA145 trend", actual: t.reason }];
        if (allPass) console.log(`🎯 SIGNAL ${symbol} 3-Layer ${signal} @ ${fmtPrice(price)} | SL ${fmtPrice(sl)} | TP ${fmtPrice(tp)}`);
        else console.log(`  🚫 ${symbol} 3-Layer — ${t.reason}`);

      } else if (useOB) {
        const o = analyzeOrderBlock(candles, stratOB, symbol);
        signal  = o.signal;
        sl      = o.sl || null;
        tp      = o.tp || null;
        allPass = signal !== "NEUTRAL";
        logConditions = [{ label: o.reason, pass: allPass, required: "OB retest na session open", actual: o.reason }];
        if (allPass) console.log(`🎯 SIGNAL ${symbol} OB ${signal} @ ${fmtPrice(price)} | SL ${fmtPrice(sl)} | TP ${fmtPrice(tp)}`);

      } else {
        const e = analyzeEmaRsi(candles, stratEMA);
        if (!e.ema9 || !e.ema50) { console.log(`  ⚠️  ${symbol} — nedovoljno podataka`); continue; }
        signal  = e.signal;
        sl      = e.sl;
        tp      = e.tp;
        allPass = signal !== "NEUTRAL";
        logConditions = [{ label: e.reason, pass: allPass, required: "EMA cross + RSI zona + EMA50 filter", actual: e.reason }];
        if (allPass) console.log(`🎯 SIGNAL ${symbol} EMA+RSI ${signal} @ ${fmtPrice(price)} | SL ${fmtPrice(sl)} | TP ${fmtPrice(tp)}`);
        else console.log(`  🚫 ${symbol} EMA+RSI — ${e.reason}`);
      }

      // Veličina pozicije
      const marginUsed = CONFIG.portfolioValue * (CONFIG.strategy.riskPct / 100);
      const tradeSize  = marginUsed * CONFIG.leverage;

      const limits = checkTradeLimits(log, marginUsed);
      if (!limits.ok) {
        if (limits.stopAll) { console.log("Bot staje — dostignut dnevni limit."); return; }
        continue;
      }

      const logEntry = {
        timestamp:    new Date().toISOString(),
        symbol,
        timeframe:    symTF,
        price,
        signal,
        sl,
        tp,
        conditions:   logConditions,
        allPass,
        tradeSize,
        orderPlaced:  false,
        orderId:      null,
        paperTrading: CONFIG.paperTrading,
        bitgetDemo:   CONFIG.bitgetDemo,
        error:        null,
      };

      if (allPass) {
        if (CONFIG.paperTrading) {
          console.log(`📋 PAPER ${signal} ${symbol} | Notional $${tradeSize.toFixed(2)} | Margin $${marginUsed.toFixed(2)} | ${CONFIG.leverage}x`);
          logEntry.orderPlaced = true;
          logEntry.orderId = `PAPER-${Date.now()}`;
          addOpenPosition(logEntry);
        } else {
          console.log(`🔴 LIVE NALOG — ${signal} ${symbol} $${tradeSize.toFixed(2)}`);
          try {
            const order = await placeBitGetOrder(symbol, signal, tradeSize, price, sl, tp);
            logEntry.orderPlaced = true;
            logEntry.orderId = order?.orderId;
            console.log(`✅ NALOG POSTAVLJEN — ${order?.orderId}`);
            addOpenPosition(logEntry);
          } catch (err) {
            console.log(`❌ NALOG PAO — ${err.message}`);
            logEntry.error = err.message;
          }
        }
      }

      log.trades.push(logEntry);
      writeTradeCsv(logEntry);

    } catch (err) {
      console.log(`❌ Greška za ${symbol}: ${err.message}`);
    }
  }

  saveLog(log);
}

// ─── Status Dashboard ─────────────────────────────────────────────────────────

async function showStatus() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  📊 TRADING BOT STATUS DASHBOARD");
  console.log(`  ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── Otvorene pozicije s live cijenom ──
  const positions = loadPositions();
  console.log(`── Otvorene pozicije (${positions.length}) ──────────────────────────────\n`);

  if (positions.length === 0) {
    console.log("  Nema otvorenih pozicija.\n");
  } else {
    for (const pos of positions) {
      try {
        const candles = await fetchCandles(pos.symbol, CONFIG.timeframe, 3);
        const current = candles[candles.length - 1].close;
        const pnl     = pos.side === "LONG"
          ? (current - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - current) * pos.quantity;
        const pnlPct  = (pnl / pos.totalUSD) * 100;
        const riskAmt = Math.abs(pos.entryPrice - pos.sl) * pos.quantity;
        const tpAmt   = Math.abs(pos.tp - pos.entryPrice) * pos.quantity;
        const rr      = tpAmt / riskAmt;

        const bar = pnl >= 0 ? "🟢" : "🔴";
        console.log(`  ${bar} ${pos.symbol} ${pos.side} [${pos.mode}]`);
        console.log(`     Ulaz:     ${fmtPrice(pos.entryPrice)}`);
        console.log(`     Sad:      ${fmtPrice(current)}`);
        console.log(`     SL:       ${fmtPrice(pos.sl)}   TP: ${fmtPrice(pos.tp)}`);
        console.log(`     R:R       1 : ${rr.toFixed(2)}`);
        console.log(`     P&L:      ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}  (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`);
        console.log(`     Notional: $${pos.totalUSD.toFixed(2)}  |  Margin: $${(pos.totalUSD / CONFIG.leverage).toFixed(2)}  |  ${CONFIG.leverage}x`);
        console.log(`     Otvoreno: ${pos.openedAt}\n`);
      } catch (e) {
        console.log(`  ⚠️  ${pos.symbol}: ne mogu dohvatiti cijenu\n`);
      }
    }
  }

  // ── Statistika zatvorenih tradova iz CSV ──
  if (!existsSync(CSV_FILE)) { console.log("Nema trades.csv."); return; }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(2); // preskoči header i NOTE
  const exits = lines
    .map(l => l.split(","))
    .filter(r => (r[4] === "CLOSE_LONG" || r[4] === "CLOSE_SHORT") && r[14]);

  const wins   = exits.filter(r => r[14]?.includes("WIN"));
  const losses = exits.filter(r => r[14]?.includes("LOSS"));
  const totalPnl = exits.reduce((s, r) => s + parseFloat(r[9] || 0), 0);

  const winRate = exits.length > 0 ? (wins.length / exits.length * 100).toFixed(1) : "—";

  // Prosječni R:R iz zatvorenih tradova
  let avgRR = "—";
  if (exits.length > 0) {
    const rrValues = exits.map(r => {
      const notes = r[14] || "";
      const ulazMatch = notes.match(/Ulaz ([\d.e-]+)/);
      const izlazMatch = notes.match(/Izlaz ([\d.e-]+)/);
      return ulazMatch && izlazMatch ? Math.abs(parseFloat(izlazMatch[1]) - parseFloat(ulazMatch[1])) : null;
    }).filter(Boolean);
    if (rrValues.length > 0) avgRR = (rrValues.reduce((a, b) => a + b, 0) / rrValues.length).toFixed(4);
  }

  console.log("── Statistika zatvorenih tradova ────────────────────────────\n");
  console.log(`  Ukupno zatvorenih:  ${exits.length}`);
  console.log(`  ✅ Win:             ${wins.length}`);
  console.log(`  ❌ Loss:            ${losses.length}`);
  console.log(`  Win rate:           ${winRate}%`);
  console.log(`  Ukupni P&L:         ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(4)}`);

  // ── Zadnjih 5 zatvorenih tradova ──
  if (exits.length > 0) {
    console.log("\n── Zadnjih 5 zatvorenih ─────────────────────────────────────\n");
    exits.slice(-5).reverse().forEach(r => {
      const icon  = r[14]?.includes("WIN") ? "✅" : "❌";
      const pnl   = parseFloat(r[9] || 0);
      const notes = r[14]?.replace(/^"|"$/g, "") || "";
      console.log(`  ${icon} ${r[0]} ${r[3]} ${r[4]?.replace("CLOSE_", "")}  P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);
      console.log(`     ${notes}`);
    });
  }

  console.log("\n─────────────────────────────────────────────────────────────\n");
  console.log("  Pokreni bot:    node bot.js");
  console.log("  Tax sažetak:   node bot.js --tax-summary");
  console.log("═══════════════════════════════════════════════════════════\n");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (process.argv.includes("--status")) {
  showStatus().catch(err => { console.error(err); process.exit(1); });
} else {
  run().catch((err) => {
    console.error("Bot greška:", err);
    process.exit(1);
  });
}
