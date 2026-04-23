/**
 * Trading Bot — 3-Portfolio Mode
 *
 * Portfolio 1 — EMA+RSI:   XAUUSDT DOGEUSDT NEARUSDT AVAXUSDT RIVERUSDT ADAUSDT
 * Portfolio 2 — 3-Layer:   ETHUSDT SUIUSDT AAVEUSDT ORDIUSDT TAOUSDT WLDUSDT TRUMPUSDT XRPUSDT
 * Portfolio 3 — MEGA:      SOLUSDT XAGUSDT HYPEUSDT LINKUSDT PEPEUSDT ZECUSDT BTCUSDT
 *
 * Fiksni SL 2% / TP 4% / R:R 1:2 | Margin 2% × $1000 | 15x leverage | 1H TF
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

// ─── Config ────────────────────────────────────────────────────────────────────

const TIMEFRAME     = "1H";
const LEVERAGE      = 15;
const START_CAPITAL = 1000;   // po portfoliju
const RISK_PCT      = 2.0;    // % margine po tradeu
const SL_PCT        = 2.0;    // fiksni SL %
const TP_PCT        = 4.0;    // fiksni TP %
const MAX_TRADES_PER_DAY = 100;

const PAPER_TRADING = process.env.PAPER_TRADING !== "false";
const BITGET_DEMO   = process.env.BITGET_DEMO === "true";
const BITGET = {
  apiKey:     process.env.BITGET_API_KEY,
  secretKey:  process.env.BITGET_SECRET_KEY,
  passphrase: process.env.BITGET_PASSPHRASE,
  baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
};

// ─── Perzistentni direktorij ───────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : ".");
if (DATA_DIR !== "." && !existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const HEARTBEAT_FILE = `${DATA_DIR}/heartbeat.json`;

// ─── Portfolio definicije ──────────────────────────────────────────────────────

const PORTFOLIO_IDS = ["ema_rsi", "three_layer", "mega"];

function buildPortfolios(rules) {
  return {
    ema_rsi: {
      id:       "ema_rsi",
      name:     "EMA+RSI",
      symbols:  rules.watchlist_ema_rsi   || [],
      strategy: "ema_rsi",
      params:   rules.strategies.ema_rsi.params,
    },
    three_layer: {
      id:       "three_layer",
      name:     "3-Layer",
      symbols:  rules.watchlist_3layer    || [],
      strategy: "three_layer",
      params:   rules.strategies.three_layer.params,
    },
    mega: {
      id:       "mega",
      name:     "MEGA",
      symbols:  rules.watchlist_mega      || [],
      strategy: "mega",
      params:   rules.strategies.mega.params,
    },
  };
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

// ─── Helpers ────────────────────────────────────────────────────────────────────

function fmtPrice(p) {
  if (!p && p !== 0) return "";
  if (p >= 1000)  return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  if (p >= 0.001) return p.toFixed(6);
  return p.toFixed(10);
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
    sl:         entry.sl,
    tp:         entry.tp,
    orderId:    entry.orderId,
    mode:       PAPER_TRADING ? "PAPER" : BITGET_DEMO ? "DEMO" : "LIVE",
    openedAt:   entry.timestamp,
    portfolio:  pid,
    strategy:   entry.strategy,
  });
  savePositions(pid, positions);
}

async function checkPortfolioPositions(pid) {
  const positions = loadPositions(pid);
  if (positions.length === 0) return;
  console.log(`  🔍 [${pid}] Provjera ${positions.length} pozicija`);

  const stillOpen = [];

  for (const pos of positions) {
    try {
      const candles = await fetchCandles(pos.symbol, TIMEFRAME, 5);
      const bar     = candles[candles.length - 1];
      let exitPrice = null, exitReason = null;

      if (pos.side === "LONG") {
        if (bar.high >= pos.tp)   { exitPrice = pos.tp; exitReason = "TP dostignut"; }
        else if (bar.low <= pos.sl) { exitPrice = pos.sl; exitReason = "SL dostignut"; }
      } else {
        if (bar.low  <= pos.tp)   { exitPrice = pos.tp; exitReason = "TP dostignut"; }
        else if (bar.high >= pos.sl){ exitPrice = pos.sl; exitReason = "SL dostignut"; }
      }

      if (exitPrice !== null) {
        const pnl = pos.side === "LONG"
          ? (exitPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - exitPrice) * pos.quantity;
        console.log(`  ${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [${pid}] ${pos.symbol} ${pos.side} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);
        writeExitCsv(pid, pos, exitPrice, exitReason, pnl);
        await tg(`${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [${pid}] ${pos.symbol} ${pos.side}\nP&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${exitReason}`);
      } else {
        const unrealized = pos.side === "LONG"
          ? (bar.close - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - bar.close) * pos.quantity;
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
  const fee  = (entry.tradeSize * 0.0005).toFixed(4);
  const mode = PAPER_TRADING ? "PAPER" : BITGET_DEMO ? "DEMO" : "LIVE";

  const row = [
    date, time, "BitGet", entry.symbol, entry.signal,
    qty, fmtPrice(entry.price), entry.tradeSize.toFixed(2),
    fee, "OPEN",
    fmtPrice(entry.sl), fmtPrice(entry.tp),
    entry.orderId || "", mode, pid,
    `"${entry.strategy} | SL ${SL_PCT}% TP ${TP_PCT}%"`,
  ].join(",");

  appendFileSync(csvFilePath(pid), row + "\n");
}

function writeExitCsv(pid, pos, exitPrice, reason, pnl) {
  const now     = new Date();
  const date    = now.toISOString().slice(0, 10);
  const time    = now.toISOString().slice(11, 19);
  const exitSide = pos.side === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT";
  const fee     = (pos.totalUSD * 0.0005).toFixed(4);
  const netPnl  = (pnl - parseFloat(fee)).toFixed(4);
  const icon    = pnl >= 0 ? "WIN" : "LOSS";

  const row = [
    date, time, "BitGet", pos.symbol,
    exitSide,
    pos.quantity.toFixed(6),
    fmtPrice(exitPrice),
    pos.totalUSD.toFixed(2),
    fee, netPnl,
    fmtPrice(pos.sl), fmtPrice(pos.tp),
    pos.orderId || "", pos.mode, pid,
    `"${icon}: ${reason} | Ulaz ${fmtPrice(pos.entryPrice)} → Izlaz ${fmtPrice(exitPrice)}"`,
  ].join(",");

  appendFileSync(csvFilePath(pid), row + "\n");
}

// ─── BitGet Execution ────────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  return crypto.createHmac("sha256", BITGET.secretKey)
    .update(`${timestamp}${method}${path}${body}`).digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price, sl, tp) {
  const quantity  = (sizeUSD / price).toFixed(4);
  const timestamp = Date.now().toString();
  const path      = "/api/v2/mix/order/place-order";
  const orderBody = {
    symbol, productType: "USDT-FUTURES",
    marginMode: "isolated", marginCoin: "USDT",
    side: side === "LONG" ? "buy" : "sell",
    tradeSide: "open", orderType: "market", size: quantity,
  };
  if (sl) orderBody.presetStopLossPrice   = fmtPrice(sl);
  if (tp) orderBody.presetTakeProfitPrice = fmtPrice(tp);
  const body = JSON.stringify(orderBody);
  const headers = {
    "Content-Type": "application/json",
    "ACCESS-KEY":        BITGET.apiKey,
    "ACCESS-SIGN":       signBitGet(timestamp, "POST", path, body),
    "ACCESS-TIMESTAMP":  timestamp,
    "ACCESS-PASSPHRASE": BITGET.passphrase,
  };
  if (BITGET_DEMO) headers["x-simulated-trading"] = "1";
  const res  = await fetch(`${BITGET.baseUrl}${path}`, { method: "POST", headers, body });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet: ${data.msg}`);
  return data.data;
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

  const totalSymbols = Object.values(portfolios).reduce((s, p) => s + p.symbols.length, 0);
  console.log(`[${utcNow.toISOString().slice(0,16)}] ${modLabel} | 3 portfolia | ${totalSymbols} simbola | ${LEVERAGE}x | UTC ${utcHour}:${String(utcMin).padStart(2,"0")}`);

  writeHeartbeat("running", { portfolios: 3, symbols: totalSymbols, leverage: LEVERAGE });

  // Provjeri otvorene pozicije svih portfolia
  for (const pid of PORTFOLIO_IDS) {
    await checkPortfolioPositions(pid);
  }

  // Skeniraj svaki portfolio
  for (const [pid, pDef] of Object.entries(portfolios)) {
    const openSymbols = loadPositions(pid).map(p => p.symbol);

    for (const symbol of pDef.symbols) {
      if (openSymbols.includes(symbol)) {
        console.log(`  ⏭️  [${pDef.name}] ${symbol} — pozicija već otvorena`);
        continue;
      }

      // Na 1H — pokreni samo na početku sata
      if (utcMin !== 0 && utcMin !== 1) {
        // Preskočiti - nije početak sata. Provjera pozicija je i dalje aktiva.
        continue;
      }

      try {
        const candles = await fetchCandles(symbol, TIMEFRAME, 250);
        const price   = candles[candles.length - 1].close;

        let result;
        switch (pDef.strategy) {
          case "mega":        result = analyzeMega(candles, pDef.params);        break;
          case "three_layer": result = analyzeThreeLayer(candles, pDef.params);  break;
          default:            result = analyzeEmaRsi(candles, pDef.params);      break;
        }

        const { signal, reason } = result;

        if (signal === "NEUTRAL") {
          console.log(`  🚫 [${pDef.name}] ${symbol} — ${reason}`);
          continue;
        }

        // Fiksni SL 2% / TP 4%
        const slDist = price * (SL_PCT / 100);
        const tpDist = price * (TP_PCT / 100);
        const sl = signal === "LONG" ? price - slDist : price + slDist;
        const tp = signal === "LONG" ? price + tpDist : price - tpDist;

        // Veličina pozicije: 2% × $1000 = $20 margin | $300 notional
        const margin    = START_CAPITAL * (RISK_PCT / 100);
        const tradeSize = margin * LEVERAGE;

        if (!checkDailyLimit(pid)) {
          console.log(`  ❌ [${pDef.name}] Dnevni limit dostignut`);
          continue;
        }

        console.log(`🎯 [${pDef.name}] ${signal} ${symbol} @ ${fmtPrice(price)} | SL ${fmtPrice(sl)} | TP ${fmtPrice(tp)} | $${tradeSize.toFixed(0)}`);

        const timestamp = new Date().toISOString();
        const orderId   = `PAPER-${Date.now()}`;
        const entry = { symbol, signal, price, sl, tp, tradeSize, orderId, timestamp, strategy: pDef.strategy };

        if (PAPER_TRADING) {
          addPosition(pid, entry);
          writeEntryCsv(pid, entry);
          await tg(`📋 PAPER [${pDef.name}] ${signal === "LONG" ? "📈" : "📉"} <b>${signal} ${symbol}</b>\nUlaz: ${fmtPrice(price)} | SL: ${fmtPrice(sl)} | TP: ${fmtPrice(tp)}\nNotional: $${tradeSize.toFixed(0)} | Margin: $${margin.toFixed(0)} | ${LEVERAGE}x`);
        } else {
          try {
            const order = await placeBitGetOrder(symbol, signal, tradeSize, price, sl, tp);
            entry.orderId = order?.orderId || orderId;
            addPosition(pid, entry);
            writeEntryCsv(pid, entry);
            console.log(`  ✅ NALOG POSTAVLJEN — ${entry.orderId}`);
          } catch (err) {
            console.log(`  ❌ NALOG PAO — ${err.message}`);
          }
        }

      } catch (err) {
        console.log(`  ❌ [${pDef.name}] ${symbol}: ${err.message}`);
      }
    }
  }

  writeHeartbeat("ok", { portfolios: 3, symbols: totalSymbols, leverage: LEVERAGE });
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
