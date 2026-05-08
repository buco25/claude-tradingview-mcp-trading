/**
 * Whale Copy Tracker — HyperLiquid
 * Prati wallet: 0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00
 * Demo mode: $1000 start | 1% rizik po tradeu | bez stvarnih naloga
 *
 * Logika:
 *  - Svake 60s povlači pozicije whalea s HyperLiquid API-ja
 *  - Nova pozicija (nije bila u prošlom snapshotu) → otvori paper trade
 *  - Pozicija nestala → zatvori paper trade, zabilježi P&L
 *  - Veličina: 1% banke / trade, leverage = whale leverage (cap 20x za demo)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";

// ─── Config ────────────────────────────────────────────────────────────────────

const WHALE_ADDR    = "0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00";
const HL_API        = "https://api.hyperliquid.xyz/info";
const START_CAPITAL = 1000;
const RISK_PCT      = 1.0;   // % banke po tradeu
const MAX_LEV       = 20;    // cap leverage za demo (whale koristi do 20x)
const POLL_MS       = 60_000; // svake 60 sekundi

const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : ".");
const STATE_FILE  = `${DATA_DIR}/whale_state.json`;
const CSV_FILE    = `${DATA_DIR}/whale_trades.csv`;
const STATUS_FILE = `${DATA_DIR}/whale_status.json`;

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID   || "";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtP(n) { return parseFloat(n).toFixed(4); }
function fmtUSD(n) { return "$" + parseFloat(n).toFixed(2); }

async function tg(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }),
    });
  } catch (_) {}
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { snapshot: {}, positions: {}, bank: START_CAPITAL, trades: 0 };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch (_) { return { snapshot: {}, positions: {}, bank: START_CAPITAL, trades: 0 }; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function writeCsv(row) {
  if (!existsSync(CSV_FILE)) {
    appendFileSync(CSV_FILE, "timestamp,coin,side,entryPrice,exitPrice,size,pnl,bank\n");
  }
  appendFileSync(CSV_FILE, row + "\n");
}

function writeStatus(state, whalePositions) {
  const openList = Object.entries(state.positions).map(([coin, p]) => ({
    coin,
    side: p.side,
    entryPrice: p.entryPrice,
    size: p.size,
    leverage: p.leverage,
    notional: p.notional,
    openTs: p.openTs,
    // unrealizedPnl iz trenutnih whale cijena (approximacija)
    currentPrice: whalePositions[coin]?.markPx || p.entryPrice,
    unrealizedPnl: whalePositions[coin]
      ? (p.side === "LONG"
          ? (whalePositions[coin].markPx - p.entryPrice) * p.size
          : (p.entryPrice - whalePositions[coin].markPx) * p.size)
      : 0,
  }));

  const totalUnrealized = openList.reduce((s, p) => s + p.unrealizedPnl, 0);

  writeFileSync(STATUS_FILE, JSON.stringify({
    ts: new Date().toISOString(),
    bank: state.bank,
    startCapital: START_CAPITAL,
    pnl: state.bank - START_CAPITAL + totalUnrealized,
    pnlPct: ((state.bank - START_CAPITAL + totalUnrealized) / START_CAPITAL * 100).toFixed(2),
    realizedPnl: state.bank - START_CAPITAL,
    unrealizedPnl: totalUnrealized,
    trades: state.trades,
    openPositions: openList,
    whaleAddr: WHALE_ADDR,
  }, null, 2));
}

// ─── HyperLiquid API ───────────────────────────────────────────────────────────

async function fetchWhalePositions() {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: WHALE_ADDR }),
  });
  const data = await res.json();

  const positions = {};
  for (const ap of (data.assetPositions || [])) {
    const p = ap.position;
    const szi = parseFloat(p.szi);
    if (szi === 0) continue;
    positions[p.coin] = {
      side:    szi > 0 ? "LONG" : "SHORT",
      szi:     Math.abs(szi),
      entryPx: parseFloat(p.entryPx),
      markPx:  parseFloat(p.markPx || p.entryPx),
      leverage: parseInt(p.leverage?.value || 1),
      unrealizedPnl: parseFloat(p.unrealizedPnl),
    };
  }
  return positions;
}

// ─── Scan loop ─────────────────────────────────────────────────────────────────

async function scan() {
  let state;
  try {
    state = loadState();
  } catch (_) {
    state = { snapshot: {}, positions: {}, bank: START_CAPITAL, trades: 0 };
  }

  let whaleNow;
  try {
    whaleNow = await fetchWhalePositions();
  } catch (e) {
    console.error("🐋 HL API greška:", e.message);
    return;
  }

  const prevCoins = new Set(Object.keys(state.snapshot));
  const nowCoins  = new Set(Object.keys(whaleNow));

  // ── Novo otvorene (pojavio se coin koji nije bio) ──────────────────────────
  for (const coin of nowCoins) {
    if (prevCoins.has(coin)) continue;  // već bio

    const wp = whaleNow[coin];
    const equity    = state.bank;
    const riskAmt   = equity * (RISK_PCT / 100);
    const lev       = Math.min(wp.leverage, MAX_LEV);
    const entryPx   = wp.markPx;
    const notional  = riskAmt * lev;
    const size      = notional / entryPx;

    state.positions[coin] = {
      side: wp.side, entryPrice: entryPx, size, notional,
      riskAmt, leverage: lev, openTs: Date.now(),
    };
    state.trades++;

    const msg = `🐋 <b>WHALE OTVORIO — DEMO KOPIJA</b>\n` +
      `${wp.side === "LONG" ? "📈" : "📉"} <b>${wp.side} ${coin}</b> @ ${fmtP(entryPx)}\n` +
      `Whale lev: ${wp.leverage}x | Naša kopija: ${lev}x\n` +
      `Notional: ${fmtUSD(notional)} | Rizik: ${fmtUSD(riskAmt)}\n` +
      `Banka: ${fmtUSD(equity)} | Trade #${state.trades}`;
    console.log(msg.replace(/<[^>]+>/g, ""));
    await tg(msg);
  }

  // ── Zatvorene (bio je, sad nema) ───────────────────────────────────────────
  for (const coin of prevCoins) {
    if (nowCoins.has(coin)) continue;  // još uvijek otvoren

    const our = state.positions[coin];
    if (!our) continue;

    // Izlazna cijena: zadnja poznata mark cijena iz prošlog snapshota
    const exitPx = state.snapshot[coin]?.markPx || our.entryPrice;
    const rawPnl = our.side === "LONG"
      ? (exitPx - our.entryPrice) * our.size
      : (our.entryPrice - exitPx) * our.size;
    const pnl = Math.max(rawPnl, -our.riskAmt);  // ne možeš izgubiti više od uloga

    state.bank += pnl;
    const durationMin = Math.round((Date.now() - our.openTs) / 60000);

    writeCsv([
      new Date().toISOString(), coin, our.side,
      fmtP(our.entryPrice), fmtP(exitPx),
      fmtP(our.size), pnl.toFixed(2), state.bank.toFixed(2),
    ].join(","));

    delete state.positions[coin];

    const icon  = pnl >= 0 ? "✅" : "❌";
    const msg = `🐋 <b>WHALE ZATVORIO — DEMO P&L</b>\n` +
      `${icon} <b>${our.side} ${coin}</b> — ${pnl >= 0 ? "+" : ""}${fmtUSD(pnl)}\n` +
      `Ulaz: ${fmtP(our.entryPrice)} → Izlaz: ${fmtP(exitPx)}\n` +
      `Trajanje: ${durationMin}min\n` +
      `Banka: ${fmtUSD(state.bank)} (${pnl >= 0 ? "+" : ""}${((pnl / START_CAPITAL) * 100).toFixed(2)}%)`;
    console.log(msg.replace(/<[^>]+>/g, ""));
    await tg(msg);
  }

  // Ažuriraj snapshot
  state.snapshot = whaleNow;
  saveState(state);
  writeStatus(state, whaleNow);

  const openCount = Object.keys(state.positions).length;
  console.log(`🐋 [${new Date().toISOString().slice(11,16)}] Whale tracker — ${openCount} otvorenih demo pozicija | banka: ${fmtUSD(state.bank)}`);
}

// ─── Start ─────────────────────────────────────────────────────────────────────

export async function startWhaleTracker() {
  console.log("🐋 Whale tracker pokrenut — pratim " + WHALE_ADDR);
  await scan();
  setInterval(scan, POLL_MS);
}

// Direktno pokretanje
if (process.argv[1]?.endsWith("whale_tracker.js")) {
  startWhaleTracker();
}
