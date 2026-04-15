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
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
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

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Otvori u Google Sheets ili Excel — ili reci Claudeu:\n` +
    `   "Premjesti trades.csv na Desktop"\n`
  );
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

const LOG_FILE = "safety-check-log.json";

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
  })).reverse(); // BitGet vraća od novijeg prema starijem — trebamo chronološki
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

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(m) {
  const results = [];
  let signal = "NEUTRAL";

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "❌";
    console.log(`  ${icon} ${label}`);
    console.log(`     Traži: ${required} | Stvarno: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  if (m.uptrend) {
    console.log(`  Struktura: 📈 UPTREND (HH+HL) — provjera LONG uvjeta\n`);
    console.log(`  Pivot High 1: $${m.ph1?.toFixed(2)} | Pivot High 2: $${m.ph2?.toFixed(2)}`);
    console.log(`  Pivot Low  1: $${m.pl1?.toFixed(2)} | Pivot Low  2: $${m.pl2?.toFixed(2)}`);
    console.log(`  Fib zona:    $${m.gpBullLo?.toFixed(2)} – $${m.gpBullHi?.toFixed(2)} (0.618–0.5)\n`);

    check(
      "Uptrend potvrđen (HH + HL)",
      "ph1 > ph2 i pl1 > pl2",
      `ph1=${m.ph1?.toFixed(0)} > ph2=${m.ph2?.toFixed(0)}, pl1=${m.pl1?.toFixed(0)} > pl2=${m.pl2?.toFixed(0)}`,
      m.uptrend
    );
    check(
      "Cijena u Fib Golden Pocket zoni (0.5–0.618)",
      `$${m.gpBullLo?.toFixed(2)} – $${m.gpBullHi?.toFixed(2)}`,
      `$${m.price?.toFixed(2)}`,
      m.inBullGp
    );
    check(
      "EMA9 > EMA21 (Sniper long potvrda)",
      `EMA9 > EMA21`,
      `EMA9=${m.ema9?.toFixed(2)} | EMA21=${m.ema21?.toFixed(2)}`,
      m.sniperLong
    );

    if (results.every((r) => r.pass)) {
      signal = "LONG";
      console.log(`\n  🎯 SL: $${m.longSl?.toFixed(2)} | TP: $${m.bullTp?.toFixed(2)}`);
    }

  } else if (m.downtrend) {
    console.log(`  Struktura: 📉 DOWNTREND (LH+LL) — provjera SHORT uvjeta\n`);
    console.log(`  Pivot High 1: $${m.ph1?.toFixed(2)} | Pivot High 2: $${m.ph2?.toFixed(2)}`);
    console.log(`  Pivot Low  1: $${m.pl1?.toFixed(2)} | Pivot Low  2: $${m.pl2?.toFixed(2)}`);
    console.log(`  Fib zona:    $${m.gpBearLo?.toFixed(2)} – $${m.gpBearHi?.toFixed(2)} (0.5–0.618)\n`);

    check(
      "Downtrend potvrđen (LH + LL)",
      "ph1 < ph2 i pl1 < pl2",
      `ph1=${m.ph1?.toFixed(0)} < ph2=${m.ph2?.toFixed(0)}, pl1=${m.pl1?.toFixed(0)} < pl2=${m.pl2?.toFixed(0)}`,
      m.downtrend
    );
    check(
      "Cijena u Fib Golden Pocket zoni (0.5–0.618)",
      `$${m.gpBearLo?.toFixed(2)} – $${m.gpBearHi?.toFixed(2)}`,
      `$${m.price?.toFixed(2)}`,
      m.inBearGp
    );
    check(
      "EMA9 < EMA21 (Sniper short potvrda)",
      `EMA9 < EMA21`,
      `EMA9=${m.ema9?.toFixed(2)} | EMA21=${m.ema21?.toFixed(2)}`,
      m.sniperShort
    );

    if (results.every((r) => r.pass)) {
      signal = "SHORT";
      console.log(`\n  🎯 SL: $${m.shortSl?.toFixed(2)} | TP: $${m.bearTp?.toFixed(2)}`);
    }

  } else {
    console.log("  Struktura: ⏸️  NEUTRAL — nema jasnog HH+HL ni LH+LL. Čekam.\n");
    results.push({ label: "Market struktura", required: "Uptrend ili Downtrend", actual: "Neutral", pass: false });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass, signal };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log, marginUsed) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`❌ Dnevni limit dostignut: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return { ok: false, stopAll: true };
  }
  console.log(`✅ Tradovi danas: ${todayCount}/${CONFIG.maxTradesPerDay}`);

  if (marginUsed > CONFIG.maxTradeSizeUSD) {
    console.log(`❌ Margin $${marginUsed.toFixed(2)} > max $${CONFIG.maxTradeSizeUSD} — preskačem ovaj par`);
    return { ok: false, stopAll: false };
  }
  console.log(`✅ Margin: $${marginUsed.toFixed(2)} (max $${CONFIG.maxTradeSizeUSD})`);

  return { ok: true, stopAll: false };
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey).update(message).digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price, sl, tp) {
  const quantity  = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path = "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol:      `${symbol}USDT_UMCBL`,
    side:        side === "LONG" ? "open_long" : "open_short",
    orderType:   "market",
    size:        quantity,
    productType: "umcbl",
    marginCoin:  "USDT",
    marginMode:  "isolated",
    presetStopLossPrice:   sl?.toFixed(2),
    presetTakeProfitPrice: tp?.toFixed(2),
  });

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

const POSITIONS_FILE = "open_positions.json";

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

  console.log(`\n${"═".repeat(57)}`);
  console.log(`  🔍 Provjera otvorenih pozicija (${positions.length})`);
  console.log(`${"═".repeat(57)}`);

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

        console.log(`\n  ${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} ${pos.symbol} ${pos.side}`);
        console.log(`     Ulaz: ${fmtPrice(pos.entryPrice)} → Izlaz: ${fmtPrice(exitPrice)}`);
        console.log(`     P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`);

        writeExitCsv(pos, exitPrice, exitReason, pnl);
        closed.push({ ...pos, exitPrice, exitReason, pnl });
      } else {
        const unrealizedPnl = pos.side === "LONG"
          ? (close - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - close) * pos.quantity;
        console.log(`\n  ⏳ OPEN  ${pos.symbol} ${pos.side} | Ulaz: ${fmtPrice(pos.entryPrice)} | Sad: ${fmtPrice(close)} | P&L: ${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(4)}`);
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

const CSV_FILE    = "trades.csv";
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
  console.log(`📄 Tax evidencija snimljena → ${CSV_FILE}`);
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
  console.log(`📄 Exit snimljen → ${CSV_FILE}`);
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

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Fib Golden Pocket Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  const modLabel = CONFIG.paperTrading ? "📋 PAPER TRADING" : CONFIG.bitgetDemo ? "🟡 BITGET DEMO" : "🔴 LIVE TRADING";
  console.log(`  Mod: ${modLabel}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategija: ${rules.strategy.name}`);
  console.log(`Timeframe: ${CONFIG.timeframe} | Leverage: ${CONFIG.leverage}x`);

  const watchlist = rules.watchlist || [CONFIG.symbol];
  console.log(`\nWatchlist: ${watchlist.join(", ")}`);

  const log = loadLog();

  // Provjeri otvorene pozicije PRIJE skeniranja novih signala
  await checkOpenPositions();

  for (const symbol of watchlist) {
    console.log(`\n${"═".repeat(57)}`);
    console.log(`  📊 ${symbol}`);
    console.log(`${"═".repeat(57)}`);

    try {
      // Dohvati svjeće
      console.log("\n── Dohvaćanje podataka s BitGet ────────────────────────\n");
      const candles = await fetchCandles(symbol, CONFIG.timeframe, 200);
      const price   = candles[candles.length - 1].close;
      console.log(`  Trenutna cijena: $${price.toFixed(4)}`);

      // Analiziraj tržište
      const m = analyzeMarket(candles, CONFIG.strategy);

      if (!m.ema9 || !m.ema21 || !m.atr) {
        console.log("⚠️  Nedovoljno podataka za indikatore. Preskačem.");
        continue;
      }

      console.log(`  EMA9:  $${m.ema9.toFixed(4)}`);
      console.log(`  EMA21: $${m.ema21.toFixed(4)}`);
      console.log(`  ATR14: $${m.atr.toFixed(4)}`);
      if (m.ph1) console.log(`  Pivot High 1/2: $${m.ph1.toFixed(4)} / $${m.ph2?.toFixed(4)}`);
      if (m.pl1) console.log(`  Pivot Low  1/2: $${m.pl1.toFixed(4)} / $${m.pl2?.toFixed(4)}`);

      // Izračunaj veličinu pozicije
      let slDist = 0;
      if (m.uptrend && m.longSl)    slDist = Math.max(price - m.longSl, 0.0001);
      if (m.downtrend && m.shortSl) slDist = Math.max(m.shortSl - price, 0.0001);

      const riskAmount  = CONFIG.portfolioValue * (CONFIG.strategy.riskPct / 100);
      const rawQty      = riskAmount / slDist;
      // maxTradeSizeUSD = max MARGIN (collateral), notional = margin × leverage
      const maxNotional = CONFIG.maxTradeSizeUSD * CONFIG.leverage;
      const tradeSize   = Math.min(rawQty * price, maxNotional);
      const marginUsed  = tradeSize / CONFIG.leverage;

      // Provjeri dnevne limite
      const limits = checkTradeLimits(log, marginUsed);
      if (!limits.ok) {
        if (limits.stopAll) {
          console.log("\nBot staje — dostignut dnevni limit.");
          return;
        }
        continue; // Preskoči samo ovaj par, nastavi s ostalima
      }

      // Safety check
      const { results, allPass, signal } = runSafetyCheck(m);

      console.log("\n── Odluka ───────────────────────────────────────────────\n");

      const sl = signal === "LONG"  ? m.longSl  : signal === "SHORT" ? m.shortSl : null;
      const tp = signal === "LONG"  ? m.bullTp  : signal === "SHORT" ? m.bearTp  : null;

      const logEntry = {
        timestamp:    new Date().toISOString(),
        symbol,
        timeframe:    CONFIG.timeframe,
        price,
        indicators:   { ema9: m.ema9, ema21: m.ema21, atr: m.atr },
        pivots:       { ph1: m.ph1, ph2: m.ph2, pl1: m.pl1, pl2: m.pl2 },
        signal,
        sl,
        tp,
        conditions:   results,
        allPass,
        tradeSize,
        orderPlaced:  false,
        orderId:      null,
        paperTrading: CONFIG.paperTrading,
        bitgetDemo:   CONFIG.bitgetDemo,
        error:        null,
      };

      if (!allPass) {
        const failed = results.filter((r) => !r.pass).map((r) => r.label);
        console.log(`🚫 TRADE BLOKIRAN`);
        failed.forEach((f) => console.log(`   - ${f}`));
      } else {
        console.log(`✅ SVI UVJETI ISPUNJENI — Signal: ${signal}`);
        console.log(`   Ulaz: ${fmtPrice(price)} | SL: ${fmtPrice(sl)} | TP: ${fmtPrice(tp)}`);
        console.log(`   Notional: $${tradeSize.toFixed(2)} | Margin: $${marginUsed.toFixed(2)} | Leverage: ${CONFIG.leverage}x`);

        if (CONFIG.paperTrading) {
          console.log(`\n📋 PAPER TRADE — ${signal} ${symbol} | Notional: $${tradeSize.toFixed(2)} | Margin: $${marginUsed.toFixed(2)} | ${CONFIG.leverage}x`);
          console.log(`   (Postavi PAPER_TRADING=false za prave naloge)`);
          logEntry.orderPlaced = true;
          logEntry.orderId = `PAPER-${Date.now()}`;
          addOpenPosition(logEntry);
        } else {
          console.log(`\n🔴 POSTAVLJAM LIVE NALOG — ${signal} $${tradeSize.toFixed(2)} ${symbol}`);
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
  console.log(`\nLog odluke snimljen → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
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
