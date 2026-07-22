/**
 * Trading Bot — ULTRA Strategy (synapse_t)
 *
 * ULTRA → 15m | Per-simbol SL/TP (30-day daily range analiza May 2026) | rizik 1.5% banke po tradeu
 *   Tier 0 (BTC):                       SL 1.5% / TP 2.25% → 52x  (liq ~1.55% = SL)
 *   Tier 1 (ETH/SOL/XRP/LINK/ADA/DOGE): SL 2.0% / TP 3.0%  → 41x  (liq ~2.04% = SL)
 *   Tier 2 (NEAR/HYPE/SUI/SEI/APT/TAO): SL 2.5% / TP 3.75% → 34x  (liq ~2.54% = SL)
 *   Tier 3 (JUP/ENA/INJ):               SL 3.0% / TP 4.5%  → 29x  (liq ~3.05% = SL)
 *
 * 50% zatvara na TP, 50% ostaje na trail SL. Max 3 pozicije, bez pyramidinga.
 * Rebalans 26.05.2026 — tješnji SL/TP za brži izlaz i bolji R:R.
 * Dinamički TP: BTC Regime NEUTRAL/kontra signal → TP = SL×1.5 | BULL+LONG ili BEAR+SHORT → TP = SL×3
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
// SURVIVAL MODE (20.07.): fiksni 1% dok ne dođe prvi profitabilan tjedan ILI proboj
// strukture (tjedni close < 60k / potvrđen breakout > 65.7k). Očuvanje kapitala za
// trending market. Vratiti na 1.0/1.5/2.0 kad se režim promijeni.
const RISK_PCT      = 1.0;    // bazni % banke po tradeu
const RISK_PCT_MIN  = 1.0;    // minimalni setup
const RISK_PCT_MAX  = 1.0;    // jak setup (survival: bez povećanja)
const SL_PCT        = 2.0;    // fallback SL % (Tier 1) — override per-simbol u symbol_sltp
const TP_PCT        = 3.0;    // fallback TP % (Tier 1, 1.5×SL) — override per-simbol u symbol_sltp

// ─── Dinamički TP — tržišni uvjeti (BTC Regime) ───────────────────────────────
// JAKO: BTC Regime BULL + signal LONG, ili BEAR + signal SHORT → TP = SL × 3 (1:3 R:R)
// NORMALNO: BTC Regime NEUTRAL, ili regime ne podudara signal → TP = SL × 1.5 (1:1.5 R:R)
const STRONG_SIGNAL_SCORE = 9;    // nekorišten za TP (zadržan za eventualne filter provjere)
const STRONG_TP_MULT      = 3.0;  // jako tržište → TP = SL × 3 (1:3 R:R)
const NORMAL_TP_MULT      = 2.0;  // konsolidacija / neutralno → TP = SL × 2.0 (1:2 R:R min, TraderaEdge standard)
const MAX_TRADES_PER_DAY = 100;
const MAX_OPEN_CRYPTO = 6;  // max otvorenih kripto pozicija
const MAX_OPEN_STOCKS = 3;  // max otvorenih pozicija na dionicama (xStocks)
const MAX_OPEN_PER_PORTFOLIO = MAX_OPEN_CRYPTO + MAX_OPEN_STOCKS;  // ukupni cap = 9
export const isStockSym = (s) => (SYMBOL_SECTORS[s] || "").startsWith("STOCK_");
const MAX_PYRAMID           = 1;   // max 1 adicija u istom smjeru (BTC only mode)
const MAX_NEW_ENTRIES_PER_SCAN = 2; // max NOVIH ulaza po scan ciklusu (08.07.: 4 longa u istom scanu = 1 oklada ×4)
const MAX_SAME_DIR_CRYPTO = 3;      // max kripto pozicija u ISTOM smjeru — svi altovi su jedan BTC-beta trade

// ─── 7. Korelacijski filter — sektori ─────────────────────────────────────────
const SYMBOL_SECTORS = {
  "BTCUSDT":    "BTC",
  "ETHUSDT":    "OG_L1", "SOLUSDT":  "OG_L1", "BNBUSDT": "OG_L1",
  "AVAXUSDT":   "L1",    "ATOMUSDT": "L1",    "ALGOUSDT": "L1",
  "XRPUSDT":    "PAYMENT", "ZECUSDT": "PAYMENT",
  "TAOUSDT":    "AI",    "RENDERUSDT": "AI",  "FETUSDT": "AI",
  "LINKUSDT":   "DEFI",  "AAVEUSDT": "DEFI", "HYPEUSDT": "DEFI",
  "DOGEUSDT":   "MEME",  "PEPEUSDT": "MEME",
  "SUIUSDT":    "L1",    "WLDUSDT": "AI", "VVVUSDT": "AI", "KAITOUSDT": "AI", "VIRTUALUSDT": "AI",
  "INJUSDT":    "DEFI",
  // Dionice
  "TSLAUSDT":   "STOCK_TECH", "NVDAUSDT": "STOCK_TECH", "PLTRUSDT": "STOCK_TECH",
  "MSTRUSDT":   "STOCK_CRYPTO", "COINUSDT": "STOCK_CRYPTO", "HOODUSDT": "STOCK_CRYPTO",
  "GMEUSDT":    "STOCK_MEME", "AMCUSDT": "STOCK_MEME",
  "SPCXUSDT":   "STOCK_SPACE",
};
const MAX_PER_SECTOR = 2;  // max otvorenih pozicija istog sektora

// ─── 4. Market Breadth ─────────────────────────────────────────────────────────
const BREADTH_STRONG = 5;   // ≥ 5 simbola u istom smjeru = jako tržište (pojačava TP×3)

// ─── 6. Partial TP — 50% na TP razini, 50% ostaje na trail SL ────────────────
const PARTIAL_TP_TRIGGER = 100;  // % TP puta → pali na pravom TP (100% = cijena dosegla TP)
const PARTIAL_CLOSE_PCT  = 50;   // % pozicije koji se zatvara na TP

// ─── ULTRA strategija — zaštitni parametri ────────────────────────────────────
const LONG_ONLY      = false;         // SHORT dozvoljeni kada BTC regime BEAR/NEUTRAL
const ADX_MIN        = 20;            // ADX prag — bazni (dinamički raste ako WR pada)
const SL_COOLDOWN_MS = 4 * 60 * 60 * 1000;  // 4h cooldown po simbolu nakon SL-a

// ─── Trailing stop — aktivira se nakon dovoljnog profita ─────────────────────
// Problem: 1.5% aktivacija + 0.8% gap → exit na samo +0.7% kod prvog odskok (XRP +$0.88)
// Fix: širi gap (1.5%) i kasnija aktivacija (2.5%) — preživljava normalne 1-2% skokove
const TRAIL_ACTIVATE_PCT = 0.50; // faktor TP-a za aktivaciju traila (50% puta do TP-a)
                                  // npr. TP 8.25% → trail se aktivira na 4.1%, TP 16.5% → 8.25%
const TRAIL_SL_PCT       = 1.5;  // trail SL X% ispod/iznad peak-a (bio 0.8 — pretijesan)

// ─── Ghost Stop — zaštita od stop huntinga ────────────────────────────────────
// pos.sl = pravi SL (što bot prati, što čuvamo u JSON-u)
// BitGet ghost SL = pravi SL ± GHOST_BUFFER% (vidljivo za algoritme, teže za hunt)
// Ako bot radi: zatvara na pravom SL (market order) — izlaz blizu pravog SL-a
// Ako bot padne: BitGet ghost SL je safety net (0.5% dalje — malo lošija egzekucija)
const GHOST_STOP_BUFFER = 0.005; // 0.5% buffer između pravog SL i ghost SL na burzi

// ─── VOL_EXH tiered threshold — ovisno o likvidnosti simbola ──────────────────
// Analiza: liquid simboli (BTC/ETH/SOL) nastavljaju trend pri 1.5-2× vol → viši threshold
// Tanki alti (TAO/HYPE/JUP/ENA) distribuiraju već pri 1.3× → niži threshold
// Izvor: MM/Algo analiza 23.05.2026 — docs/MM_Algo_Analysis.xlsx
const VOL_EXH_TIERS = {
  "BTCUSDT":  5.0,  // Tier 0
  "ETHUSDT":  4.0,  // Tier 1
  "SOLUSDT":  4.0,  // Tier 1
  "XRPUSDT":  4.0,  // Tier 1
  "ADAUSDT":  3.5,  // Tier 2
  "LINKUSDT": 3.5,  // Tier 2
  "DOGEUSDT": 3.5,  // Tier 2
  "NEARUSDT": 3.0,  // Tier 3
  "SUIUSDT":  3.0,  // Tier 3
  "APTUSDT":  3.0,  // Tier 3
  "SEIUSDT":  3.0,  // Tier 3
  "INJUSDT":  3.0,  // Tier 3
  "TAOUSDT":  2.5,  // Tier 4
  "HYPEUSDT": 2.5,  // Tier 4
  "JUPUSDT":  2.5,  // Tier 4
  "ENAUSDT":  2.5,  // Tier 4
};
const VOL_EXH_DEFAULT = 3.0; // fallback za nepoznate simbole

// ─── Per-simbol signal kombinacije (backtest optimizirano 16.06.2026) ──────────
// Indeksi odgovaraju sigs[] u analyzeUltra: 0=E50↑ 1=CVD↑ 2=MACD 3=E145 4=PWHL 5=RDIV 6=MSTR 7=FVG
// Jedinstveni TraderaEdge set za sve simbole:
// E50 + MACD + E145 (trend) · PWHL (weekly zone) · RDIV + MSTR (struktura)
// DEMA (Smart Hub) · LHUNT (Liquidity Hunt) — bez CVD/FVG/OB (nisu TraderaEdge)
const TE_COMBO = [0,2,3,4,5,6,9,10];
export const SYMBOL_COMBOS = {
  "BTCUSDT":    { sigIdx: TE_COMBO, minSig: 5 },
  // ── Majors ──────────────────────────────────────────────────────────────────
  "ETHUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "SOLUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "BNBUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "XRPUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "AVAXUSDT":   { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "LINKUSDT":   { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  // ── TraderaEdge momentum pickovi (iz videa) ─────────────────────────────────
  "RENDERUSDT": { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "FETUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "ATOMUSDT":   { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "ZECUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "ALGOUSDT":   { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "DOGEUSDT":   { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "SUIUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "HYPEUSDT":   { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "WLDUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "PEPEUSDT":   { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "INJUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "VVVUSDT":    { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "KAITOUSDT":  { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  "VIRTUALUSDT": { sigIdx: TE_COMBO, minSig: 5, btcAlign: true },
  // ── Extra (dobar WR history) ────────────────────────────────────────────────
  "TAOUSDT":    { sigIdx: TE_COMBO, minSig: 4 },
  "AAVEUSDT":   { sigIdx: TE_COMBO, minSig: 4 },
  // ── Tokenizirane dionice (Bitget xStocks futures) — bez btcAlign ───────────
  "TSLAUSDT":   { sigIdx: TE_COMBO, minSig: 5 },
  "NVDAUSDT":   { sigIdx: TE_COMBO, minSig: 5 },
  "SPCXUSDT":   { sigIdx: TE_COMBO, minSig: 5 },
  "MSTRUSDT":   { sigIdx: TE_COMBO, minSig: 5 },
  "COINUSDT":   { sigIdx: TE_COMBO, minSig: 5 },
  "HOODUSDT":   { sigIdx: TE_COMBO, minSig: 5 },
  "PLTRUSDT":   { sigIdx: TE_COMBO, minSig: 5 },
  "GMEUSDT":    { sigIdx: TE_COMBO, minSig: 5 },
  "AMCUSDT":    { sigIdx: TE_COMBO, minSig: 5 },
};

// ─── Ekonomski kalendar ───────────────────────────────────────────────────────
const ECON_BLOCK_MIN = 15;  // blokiraj ±15min oko HIGH impact USD eventa

// Persistan cooldown: symbol → timestamp zadnjeg SL-a (preživi restart!)
// Čita se lazy (nakon DATA_DIR inicijalizacije) — vidi loadSlCooldown() ispod.
const symbolSlCooldown = new Map();
const getSlCooldownFile = () => `${DATA_DIR}/sl_cooldown.json`;

function loadSlCooldown() {
  try {
    const f = getSlCooldownFile();
    if (!existsSync(f)) return;
    const raw = JSON.parse(readFileSync(f, "utf8"));
    const now = Date.now();
    for (const [sym, ts] of Object.entries(raw)) {
      if (now - ts < SL_COOLDOWN_MS) symbolSlCooldown.set(sym, ts);  // učitaj samo aktivne
    }
    if (symbolSlCooldown.size > 0)
      console.log(`  🕐 [COOLDOWN] Učitano ${symbolSlCooldown.size} aktivnih SL cooldowna s diska`);
  } catch {}
}

function saveSlCooldown() {
  try {
    const obj = Object.fromEntries(symbolSlCooldown);
    writeFileSync(getSlCooldownFile(), JSON.stringify(obj, null, 2));
  } catch {}
}

// ─── 1. DINAMIČKI ADX — raste kad je WR loš ──────────────────────────────────
// Čita zadnjih 10 trejdova iz CSV-a i računa trenutni WR.
// WR < 35% → ADX +3 (23) | WR < 25% → ADX +5 (25) + pauza 2h | baza ADX_MIN=20
const DYN_ADX_LOOKBACK  = 10;   // zadnjih N trejdova za WR procjenu
const DYN_ADX_BOOST_1   =  3;   // +3 kad WR < 35%  → ADX 25
const DYN_ADX_BOOST_2   =  5;   // +5 kad WR < 25%  → ADX 27
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
    if (wr < 25) return ADX_MIN + DYN_ADX_BOOST_2;  // ADX 27 (22+5)
    if (wr < 35) return ADX_MIN + DYN_ADX_BOOST_1;  // ADX 25 (22+3)
    return ADX_MIN;                                   // ADX 22 (normalno)
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

let _regimeCache   = { regime: "UNKNOWN", ts: 0 };
let _regime1hCache = { regime: "UNKNOWN", btcRsi1h: null, ts: 0 };
const REGIME_TTL = 15 * 60 * 1000;  // osvježi svakih 15min

// ─── BTC dnevni high tracker (za bounce mode) ─────────────────────────────────
let _btcDailyHigh = 0;
let _btcDailyHighDate = "";
function updateBtcDailyHigh(price) {
  const today = new Date().toISOString().slice(0, 10);
  if (_btcDailyHighDate !== today) { _btcDailyHigh = price; _btcDailyHighDate = today; }
  else if (price > _btcDailyHigh) _btcDailyHigh = price;
}
function getBtcDrawdownPct(price) {
  return _btcDailyHigh > 0 ? (price - _btcDailyHigh) / _btcDailyHigh * 100 : 0;
}

export async function getBtcRegimeExport() { return getBtcRegime(); }

// ─── BTC 1H regime — brži od 4H ───────────────────────────────────────────────
async function getBtcRegime1H() {
  if (Date.now() - _regime1hCache.ts < REGIME_TTL) return _regime1hCache;
  try {
    const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=60`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code !== "00000" || !d.data?.length) return _regime1hCache;
    const closes = d.data.map(k => parseFloat(k[4]));  // Bitget vraća ascending (najstarija prva)
    const n = closes.length - 1;
    // EMA20 i EMA50 na 1H
    const ema = (period) => {
      const k = 2/(period+1);
      let e = closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
      for (let i=period; i<=n; i++) e = closes[i]*k + e*(1-k);
      return e;
    };
    const e20 = ema(20), e50 = ema(50);
    const price = closes[n];
    // RSI14 na 1H
    let g=0, l=0;
    for (let i=n-14; i<n; i++) { const d=closes[i+1]-closes[i]; d>0?g+=d:l-=d; }
    const btcRsi1h = l===0 ? 100 : 100 - 100/(1+(g/14)/(l/14));
    const regime = (price > e20 && e20 > e50) ? "BULL"
                 : (price < e20 && e20 < e50) ? "BEAR"
                 : "NEUTRAL";
    updateBtcDailyHigh(price);
    _regime1hCache = { regime, btcRsi1h, currentPrice: price, ts: Date.now() };
    return _regime1hCache;
  } catch(e) {
    return _regime1hCache;
  }
}

// BTC tjedni close vs ključna ciklus-razina (TraderaEdge 07/2026: "bulls vladaju dok
// smo iznad 60k; tek tjedni close ispod = shorteri u dominaciji"). Cache 30 min.
let _btcWeeklyKeyCache = { belowKey: null, lastClose: null, key: null, ts: 0 };
export async function getBtcWeeklyVsKey() {
  if (Date.now() - _btcWeeklyKeyCache.ts < 30 * 60 * 1000 && _btcWeeklyKeyCache.belowKey !== null) return _btcWeeklyKeyCache;
  try {
    const key = JSON.parse(readFileSync("rules.json", "utf8")).btc_key_level ?? null;
    if (!key) return _btcWeeklyKeyCache;
    const d = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1W&limit=3`).then(r => r.json());
    if (d.code === "00000" && d.data?.length >= 2) {
      // ascending: predzadnji = zadnji DOVRŠENI tjedan
      const lastClose = parseFloat(d.data[d.data.length - 2][4]);
      _btcWeeklyKeyCache = { belowKey: lastClose < key, lastClose, key, ts: Date.now() };
    }
  } catch {}
  return _btcWeeklyKeyCache;
}

// BTC tjedni EMA10/EMA20 cross — potpuno automatski makro-fazni signal (TG 27.07.):
// "EMA10 probije EMA20 (uz volumen) = nova bull faza. Obrnuto = trend slabi/bear faza.
// Vaznije je biti na pravoj strani dugorocnog trenda nego gadjati svaki vrh/dno."
// Ne treba rucni unos razine — cisto racunanje iz tjednih svijeca.
let _btcWeeklyEmaCache = { bullPhase: null, ema10: null, ema20: null, ts: 0 };
export async function getBtcWeeklyEmaPhase() {
  if (Date.now() - _btcWeeklyEmaCache.ts < 60 * 60 * 1000 && _btcWeeklyEmaCache.bullPhase !== null) return _btcWeeklyEmaCache;
  try {
    // Binance public — Bitget ima samo ~13 tjedana povijesti, premalo za EMA20
    const d = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=120`).then(r => r.json());
    const cl = Array.isArray(d) ? d.map(k => parseFloat(k[4])) : [];
    if (cl.length >= 25) {
      const ema = (arr, p) => { const k = 2 / (p + 1); let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k); return e; };
      const e10 = ema(cl, 10), e20 = ema(cl, 20);
      _btcWeeklyEmaCache = { bullPhase: e10 > e20, ema10: e10, ema20: e20, ts: Date.now() };
    }
  } catch {}
  return _btcWeeklyEmaCache;
}

// BTC kraća trend-invalidacijska razina (odvojena od btc_key_level — ciklus linije).
// TraderaEdge 23.07: "gubitak ove zone i pretvaranje u otpor = prvi ozbiljan signal
// slabljenja trenda, fokus prebacujem na short". Dnevni close ispod = pooštri LONG.
let _btcInvalCache = { belowInval: null, lastClose: null, level: null, ts: 0 };
export async function getBtcDailyVsInvalidation() {
  if (Date.now() - _btcInvalCache.ts < 15 * 60 * 1000 && _btcInvalCache.belowInval !== null) return _btcInvalCache;
  try {
    const level = JSON.parse(readFileSync("rules.json", "utf8")).btc_invalidation_level ?? null;
    if (!level) return _btcInvalCache;
    const d = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1Dutc&limit=2`).then(r => r.json());
    if (d.code === "00000" && d.data?.length >= 1) {
      const lastClose = parseFloat(d.data[d.data.length - 1][4]);
      _btcInvalCache = { belowInval: lastClose < level, lastClose, level, ts: Date.now() };
    }
  } catch {}
  return _btcInvalCache;
}

// ─── CHILL mode — mrtvo tržište (ljetni režim) ───────────────────────────────
// TraderaEdge 14.07: "letnji režim, nizak volumen — nisam bio preterano aktivan,
// CHILL mode". Bot analiza 7d: 23 tradea, -8 USDT dok je mentor odradio 2-3.
// BTC 24h raspon < 2.5% → kripto minSig +1 i size ×0.7 (trguj rijetko i malo).
let _chillCache = { chill: false, rangePct: null, ts: 0 };
export async function getBtcChillMode() {
  if (Date.now() - _chillCache.ts < 15 * 60 * 1000) return _chillCache;
  try {
    const d = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=24`).then(r => r.json());
    if (d.code === "00000" && d.data?.length >= 20) {
      const hi = Math.max(...d.data.map(k => parseFloat(k[2])));
      const lo = Math.min(...d.data.map(k => parseFloat(k[3])));
      const px = parseFloat(d.data[d.data.length - 1][4]);
      const rangePct = (hi - lo) / px * 100;
      _chillCache = { chill: rangePct < 2.5, rangePct: parseFloat(rangePct.toFixed(2)), ts: Date.now() };
    }
  } catch {}
  return _chillCache;
}

// ─── Relativna snaga vs BTC (TraderaEdge Strong/Weak lista) ──────────────────
// alt/BTC ratio (1H, 7 dana) vs EMA20 ratija: iznad = STRONG, ispod = WEAK.
// Pravila (TG 10.07.): "shortuj slabe shitcoine kad BTC pada" + long samo strong altove.
const _relStrCache = {};
let _btcCloses1h = { closes: null, ts: 0 };
export async function getRelStrengthVsBtc(symbol) {
  const c = _relStrCache[symbol];
  if (c && Date.now() - c.ts < 30 * 60 * 1000) return c.state;
  try {
    if (!_btcCloses1h.closes || Date.now() - _btcCloses1h.ts > 30 * 60 * 1000) {
      const bd = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=168`).then(r => r.json());
      if (bd.code !== "00000") return null;
      _btcCloses1h = { closes: bd.data.map(k => parseFloat(k[4])), ts: Date.now() };
    }
    const ad = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&limit=168`).then(r => r.json());
    if (ad.code !== "00000") return null;
    const a = ad.data.map(k => parseFloat(k[4]));
    const b = _btcCloses1h.closes;
    const n = Math.min(a.length, b.length);
    if (n < 40) return null;
    const ratio = [];
    for (let i = 0; i < n; i++) ratio.push(a[a.length - n + i] / b[b.length - n + i]);
    const k20 = 2 / 21;
    let e = ratio.slice(0, 20).reduce((x, y) => x + y, 0) / 20;
    for (let i = 20; i < n; i++) e = ratio[i] * k20 + e * (1 - k20);
    const state = ratio[n - 1] > e ? "STRONG" : "WEAK";
    _relStrCache[symbol] = { state, ts: Date.now() };
    return state;
  } catch { return null; }
}

// BTC vs vlastiti daily EMA10 — globalni kripto filter (TraderaEdge: "altcoin ne živi
// izolovano, njegovo ponašanje zavisi šta radi BTC"). BTC ispod dEMA10 → alt LONG nema smisla.
let _btcDema10Cache = { above: null, ema10: null, ts: 0 };
async function getBtcDailyEma10() {
  if (Date.now() - _btcDema10Cache.ts < 10 * 60 * 1000 && _btcDema10Cache.above !== null) return _btcDema10Cache;
  try {
    const d = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1Dutc&limit=60`).then(r => r.json());
    if (d.code === "00000" && d.data?.length >= 11) {
      const cl = d.data.map(k => parseFloat(k[4]));  // ascending
      const k10 = 2 / 11;
      let e = cl.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
      for (let i = 10; i < cl.length; i++) e = cl[i] * k10 + e * (1 - k10);
      _btcDema10Cache = { above: cl[cl.length - 1] > e, ema10: e, ts: Date.now() };
    }
  } catch {}
  return _btcDema10Cache;
}

async function getBtcRegime() {
  if (Date.now() - _regimeCache.ts < REGIME_TTL) return _regimeCache.regime;
  try {
    const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=4H&limit=100`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code !== "00000" || !d.data?.length) return "UNKNOWN";

    const candles = d.data.map(k => ({
      close: parseFloat(k[4]), high: parseFloat(k[2]), low: parseFloat(k[3]),
    }));  // Bitget vraća ascending (najstarija prva)
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

    // EMA50 na 4H — za BTC Regime SHORT filter
    const k50 = 2/(50+1);
    let e50 = closes.slice(0,50).reduce((a,b)=>a+b,0)/50;
    for (let i=50; i<=n; i++) e50 = closes[i]*k50 + e50*(1-k50);
    const btcAboveEma50_4h = price > e50;

    // RSI14 na 4H BTC — za capitulation bounce detekciju
    const rsiPeriod = 14;
    let gains = 0, losses = 0;
    for (let i = n - rsiPeriod; i < n; i++) {
      const diff = closes[i+1] - closes[i];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgG = gains / rsiPeriod, avgL = losses / rsiPeriod;
    const btcRsi4h = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);

    // BTC Weekly Low — za MM Filter 4 (bounce protection)
    // Dohvati tjedni low iz zadnjih 2 tjedna (iz 4H candles — aproksimacija 2 tjedna = 84 bara)
    const weekBars = Math.min(84, candles.length);
    const btcWeeklyLow  = Math.min(...candles.slice(-weekBars).map(c => c.low));
    const btcWeeklyLowDist = btcWeeklyLow > 0 ? (price - btcWeeklyLow) / price : 1;

    _regimeCache = { regime, btcRsi4h, btcAboveEma50_4h, btcEma50_4h: e50,
      btcWeeklyLow, btcWeeklyLowDist, ts: Date.now() };
    console.log(`  📊 [REGIME] BTC 4H: ${regime} | 6Sc=${upPairs}/6 | Price${price>e55?">":"<"}EMA55 | EMA50=${e50.toFixed(0)} (${btcAboveEma50_4h?"IZNAD":"ISPOD"}) | RSI=${btcRsi4h.toFixed(1)} | WklyLow=${btcWeeklyLow.toFixed(0)} (${(btcWeeklyLowDist*100).toFixed(1)}% away)`);
    return regime;
  } catch(e) {
    console.log(`  ⚠️  [REGIME] Greška: ${e.message}`);
    return "UNKNOWN";
  }
}

// ─── BTC Spike Detector — Correlated Exit trigger ────────────────────────────
// Vraća { spike: bool, pct: number, direction: "UP"|"DOWN"|null }
// Spike UP = SHORT pozicije u opasnosti (BTC naglo skočio)
// Spike DOWN = LONG pozicije u opasnosti
let _btcSpikeCache = { spike: false, pct: 0, direction: null, ts: 0 };
const BTC_SPIKE_TTL  = 3 * 60 * 1000;   // osvježi svake 3 minute
const BTC_SPIKE_PCT  = 1.2;             // +1.2% u zadnja 2×15m = spike UP
const BTC_SPIKE_BARS = 2;               // gledamo zadnje 2 svjećice (30min)

async function checkBtcSpike() {
  if (Date.now() - _btcSpikeCache.ts < BTC_SPIKE_TTL) return _btcSpikeCache;
  try {
    const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=15m&limit=6`;
    const r   = await fetch(url);
    const d   = await r.json();
    if (d.code !== "00000" || !d.data?.length) return _btcSpikeCache;

    const candles = d.data.map(k => ({
      open: parseFloat(k[1]), close: parseFloat(k[4]),
    }));  // Bitget vraća ascending — najnoviji već zadnji

    const n    = candles.length;
    const base = candles[n - 1 - BTC_SPIKE_BARS].close;  // cijena prije 30min
    const now  = candles[n - 1].close;
    const pct  = (now - base) / base * 100;

    const spike     = Math.abs(pct) >= BTC_SPIKE_PCT;
    const direction = pct >  BTC_SPIKE_PCT ? "UP"
                    : pct < -BTC_SPIKE_PCT ? "DOWN" : null;

    _btcSpikeCache = { spike, pct: parseFloat(pct.toFixed(2)), direction, ts: Date.now() };
    if (spike) console.log(`  ⚡ [BTC SPIKE] ${pct > 0 ? "+" : ""}${pct.toFixed(2)}% u 30min → spike ${direction}`);
    return _btcSpikeCache;
  } catch(e) {
    console.log(`  ⚠️  [BTC SPIKE] Greška: ${e.message}`);
    return _btcSpikeCache;
  }
}

// ─── 4. Market Breadth — brzi pre-scan EMA9/21 na 15m ───────────────────────
let _breadthCache = { data: null, ts: 0 };
const BREADTH_TTL = 15 * 60 * 1000;

async function computeMarketBreadth(symbols) {
  if (Date.now() - _breadthCache.ts < BREADTH_TTL && _breadthCache.data) return _breadthCache.data;
  let bullish = 0, bearish = 0, neutral = 0;
  try {
    const results = await Promise.all(symbols.map(async sym => {
      try {
        const candles = await fetchCandles(sym, "15m", 25);
        if (candles.length < 22) return "NEUTRAL";
        const closes = candles.map(c => c.close);
        const n = closes.length - 1;
        // EMA9 i EMA21 na 15m
        const ka = 2 / 10, kb = 2 / 22;
        let ea = closes.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
        let eb = closes.slice(0, 21).reduce((a, b) => a + b, 0) / 21;
        for (let i = 21; i <= n; i++) {
          ea = closes[i] * ka + ea * (1 - ka);
          eb = closes[i] * kb + eb * (1 - kb);
        }
        const price = closes[n];
        if (ea > eb && price > ea) return "BULL";
        if (ea < eb && price < ea) return "BEAR";
        return "NEUTRAL";
      } catch { return "NEUTRAL"; }
    }));
    for (const r of results) {
      if (r === "BULL") bullish++;
      else if (r === "BEAR") bearish++;
      else neutral++;
    }
  } catch {}
  const data = { bullish, bearish, neutral, total: symbols.length };
  _breadthCache = { data, ts: Date.now() };
  return data;
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

// ─── VWAP (Volume Weighted Average Price) — dnevni, resetira u ponoć UTC ─────
export function calcVWAP(candles) {
  // Dnevni VWAP: samo svjeće od ponoći UTC do sad
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();

  const todayCandles = candles.filter(c => c.time >= midnightMs);

  // Fallback: ako nema dovoljno dnevnih svjeća (< 3), uzmi zadnjih 24 × 1H
  const slice = todayCandles.length >= 3 ? todayCandles : candles.slice(-24);

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

// ─── Liq Zone kalkulator — koristi već dohvaćene 1H candle ──────────────────
// Pronalazi pivot highs/lows i računa gdje su leveraged pozicije u opasnosti od liq.
// Vraća: { danger: "CLEAR"|"CAUTION"|"DANGER", minDist, closestLong, closestShort }
function calcLiqZones(candles) {
  const PIVOT_LEN = 8;   // bar-ova lijevo/desno za pivot detekciju (1H: 8h prozor)
  const N_PIVOTS  = 4;   // max pivota koje koristimo
  const RANGE_PCT = 12.0; // max % od cijene za prikaz zona
  const LEVS      = [10, 20, 25, 50, 100];

  if (!candles || candles.length < PIVOT_LEN * 2 + 5) return { danger: "CLEAR", minDist: 99 };

  const cp = candles[candles.length - 1].close;
  const phArr = [], plArr = [];

  for (let i = PIVOT_LEN; i < candles.length - PIVOT_LEN; i++) {
    const hi = candles[i].high, lo = candles[i].low;
    let isPH = true, isPL = true;
    for (let j = i - PIVOT_LEN; j <= i + PIVOT_LEN; j++) {
      if (j === i) continue;
      if (candles[j].high >= hi) isPH = false;
      if (candles[j].low  <= lo) isPL = false;
    }
    if (isPH && phArr.length < N_PIVOTS) phArr.push(hi);
    if (isPL && plArr.length < N_PIVOTS) plArr.push(lo);
  }

  const zones = [];
  phArr.forEach((entry, rank) => {
    LEVS.forEach(lev => {
      const liqP = entry * (1.0 - 1.0 / lev);
      const dist = Math.abs(liqP - cp) / cp * 100;
      if (dist <= RANGE_PCT) zones.push({ type: "LONG", price: liqP, lev, rank, dist });
    });
  });
  plArr.forEach((entry, rank) => {
    LEVS.forEach(lev => {
      const liqP = entry * (1.0 + 1.0 / lev);
      const dist = Math.abs(liqP - cp) / cp * 100;
      if (dist <= RANGE_PCT) zones.push({ type: "SHORT", price: liqP, lev, rank, dist });
    });
  });

  const cLong  = zones.filter(z => z.type === "LONG").sort((a,b) => a.dist - b.dist)[0];
  const cShort = zones.filter(z => z.type === "SHORT").sort((a,b) => a.dist - b.dist)[0];
  const minD   = Math.min(cLong?.dist ?? 99, cShort?.dist ?? 99);
  const danger = minD < 1.0 ? "DANGER" : minD < 2.5 ? "CAUTION" : "CLEAR";

  return { danger, minDist: +minD.toFixed(2), closestLong: cLong, closestShort: cShort };
}

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
const SESSION_DEAD_END   = 5;   // UTC sat (exclusive) — 01:00-04:59 UTC blokiran (07:00 Zagreb)

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
  if (won === null || won === undefined) return; // P&L nepoznat — ne kvari statistiku
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

// ─── getLSRForSymbols — batch wrapper (koristi postojeći getLongShortRatio) ────
export async function getLSRForSymbols(symbols) {
  const result = {};
  await Promise.all(symbols.map(async sym => { result[sym] = await getLongShortRatio(sym); }));
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

  // ── 1. Yahoo Finance (v8 chart API) ────────────────────────────────────────
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=4h&range=1d&includePrePost=false`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const d = await r.json();
      const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
      if (closes.length >= 2) {
        const change4h = parseFloat(((closes[closes.length-1] - closes[0]) / closes[0] * 100).toFixed(3));
        const direction = change4h > 0.3 ? '↑ jača' : change4h < -0.3 ? '↓ slabi' : '→ flat';
        _dxyCache = { change4h, direction, ts: Date.now() };
        return _dxyCache;
      }
    }
  } catch { /* proba fallback */ }

  // ── 2. Stooq.com CSV (manje vjerojatno blokiran od JSON) ─────────────────────
  try {
    const r = await fetch('https://stooq.com/q/l/?s=dxy.f&f=sd2t2ohlcv&e=csv', {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000)
    });
    const txt = await r.text();
    // Format: Symbol,Date,Time,Open,High,Low,Close,Volume  (header + data row)
    const lines = txt.trim().split('\n');
    if (lines.length >= 2) {
      const cols = lines[lines.length - 1].split(',');
      const open = parseFloat(cols[3]), close = parseFloat(cols[6]);
      if (!isNaN(open) && !isNaN(close) && open > 0) {
        const change4h = parseFloat(((close - open) / open * 100).toFixed(3));
        const direction = change4h > 0.3 ? '↑ jača' : change4h < -0.3 ? '↓ slabi' : '→ flat';
        _dxyCache = { change4h, direction, source: 'stooq-csv', ts: Date.now() };
        return _dxyCache;
      }
    }
  } catch { /* proba sljedeći */ }

  // ── 3. Stooq JSON — alternativni format ───────────────────────────────────
  try {
    const r = await fetch('https://stooq.com/q/l/?s=dxy.f&f=sd2t2ohlcvp&e=json', {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000)
    });
    const d = await r.json();
    const sym = d?.symbols?.[0];
    if (sym && sym.p != null && sym.o != null && sym.c != null && sym.o > 0) {
      // p = % change, ali možda nije dostupan — računaj iz o/c
      const change4h = parseFloat(((sym.c - sym.o) / sym.o * 100).toFixed(3));
      const direction = change4h > 0.3 ? '↑ jača' : change4h < -0.3 ? '↓ slabi' : '→ flat';
      _dxyCache = { change4h, direction, source: 'stooq-json', ts: Date.now() };
      return _dxyCache;
    }
  } catch { /* proba sljedeći */ }

  // ── 4. ECB EUR/USD proxy — DXY ≈ inverzija EUR/USD (korelacija ~0.97) ────────
  // ECB referentni tečaj: besplatan, bez ključa, pouzdan
  try {
    const r = await fetch(
      'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=2&format=jsondata',
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
    );
    const d = await r.json();
    const obs = d?.dataSets?.[0]?.series?.['0:0:0:0:0']?.observations;
    if (obs) {
      const keys = Object.keys(obs).sort((a, b) => parseInt(a) - parseInt(b));
      if (keys.length >= 2) {
        const prev  = parseFloat(obs[keys[keys.length - 2]][0]);  // jučer USD/EUR
        const today = parseFloat(obs[keys[keys.length - 1]][0]);  // danas
        if (prev > 0 && today > 0) {
          // USD/EUR raste = USD jači = DXY raste; skaliraj ~0.75 (EUR = 57.6% DXY težine)
          const usdEurChg = (today - prev) / prev * 100;
          const change4h = parseFloat((usdEurChg * 0.75).toFixed(3));
          const direction = change4h > 0.3 ? '↑ jača' : change4h < -0.3 ? '↓ slabi' : '→ flat';
          _dxyCache = { change4h, direction, source: 'ecb-proxy', ts: Date.now() };
          return _dxyCache;
        }
      }
    }
  } catch { /* sve failalo */ }

  return { change4h: null, direction: 'N/A', ts: Date.now() };
}
export { getDxyData };

// ─── Consecutive loss counter (za dashboard CB progress bar) ──────────────────
export function getConsecutiveLossCount(pid) {
  const f = csvFilePath(pid);
  if (!existsSync(f)) return 0;
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lines = readFileSync(f, "utf8").trim().split("\n");
    const exits = lines.slice(1)
      .filter(l => l.startsWith(today))  // samo danas
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

// ─── Direkcijski cooldown: 3 uzastopna SL-a istog smjera → smjer blokiran 4h ──
// (analiza 07.07.: bot uporno ponavljao LONG u padu — XRP/LINK/ALGO/AAVE/RENDER isti dan)
const DIR_STREAK_MAX = 3;
const DIR_COOLDOWN_MS = 4 * 60 * 60 * 1000;
// Simbol+smjer: 2 uzastopna SL-a na istom simbolu i smjeru → taj par blokiran 24h
// (analiza 20.07.: TAO shortan 4× u 5 dana, 3 gubitka — 4h cooldown prekratak)
export function getSymbolSideLossStreak(pid, symbol, side) {
  const f = csvFilePath(pid);
  if (!existsSync(f)) return { count: 0, blocked: false };
  try {
    const tag = side === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT";
    const lines = readFileSync(f, "utf8").trim().split("\n");
    const exits = lines.slice(1).filter(l => l.includes(tag) && l.includes(symbol) && !l.includes("Partial TP"));
    let count = 0, lastTs = 0;
    for (let i = exits.length - 1; i >= 0; i--) {
      const cols = exits[i].split(",");
      const pnl = parseFloat(cols[9] || 0);
      if (pnl >= 0) break;
      count++;
      if (!lastTs) lastTs = new Date(cols[0]).getTime() || 0;
    }
    const blocked = count >= 2 && Date.now() - lastTs < 24 * 60 * 60 * 1000;
    return { count, blocked };
  } catch { return { count: 0, blocked: false }; }
}

export function getDirLossStreak(pid, side) {
  const f = csvFilePath(pid);
  if (!existsSync(f)) return { count: 0, blocked: false };
  try {
    const tag = side === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT";
    const lines = readFileSync(f, "utf8").trim().split("\n");
    const exits = lines.slice(1).filter(l => l.includes(tag) && !l.includes("Partial TP"));
    let count = 0, lastTs = 0;
    for (let i = exits.length - 1; i >= 0; i--) {
      const cols = exits[i].split(",");
      const pnl = parseFloat(cols[9] || 0);
      if (pnl >= 0) break;                       // win tog smjera prekida niz
      count++;
      if (!lastTs) lastTs = new Date(cols[0]).getTime() || 0;
    }
    const blocked = count >= DIR_STREAK_MAX && Date.now() - lastTs < DIR_COOLDOWN_MS;
    return { count, blocked };
  } catch { return { count: 0, blocked: false }; }
}

// ─── 4. SIGNAL ANALIZA — prati koje signale bilježe pobjedu ──────────────────
// Svaki ulaz bilježi fingerprint aktivnih signala (bitmask)
// Čitamo nakon izlaza koji signal je bio aktivan i označavamo win/loss
// Svaka 10. analiza ispisuje per-signal WR u konzolu

const SIG_NAMES = ["E50","CVD","MACD","E145","PWHL","RDIV","MSTR","FVG","OB","DEMA","LHUNT"];
const getSigStatsFile = () => `${DATA_DIR}/signal_stats.json`;

function loadSigStats() {
  try { return existsSync(getSigStatsFile()) ? JSON.parse(readFileSync(getSigStatsFile(),"utf8")) : {}; }
  catch { return {}; }
}
function saveSigStats(st) {
  try { writeFileSync(getSigStatsFile(), JSON.stringify(st, null, 2)); } catch {}
}

function recordSignalOutcome(sigMask, won) {
  if (won === null || won === undefined) return; // P&L nepoznat — ne kvari statistiku
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
const SCAN_LOG_FILE  = `${DATA_DIR}/scan_log.csv`;

// ─── Scan Log — bilježi zašto je svaki simbol preskočen ili ušao ─────────────
function initScanLog() {
  if (!existsSync(SCAN_LOG_FILE)) {
    writeFileSync(SCAN_LOG_FILE, "Timestamp,Symbol,Signal,Score,RSI,ADX,VwapDist%,Blocker,Reason\n");
  }
}

function writeScanLog(entries) {
  initScanLog();
  const lines = entries.map(e => {
    const ts    = new Date().toISOString().slice(0, 16).replace("T", " ");
    const score = e.score ?? "—";
    const rsi   = e.rsi   != null ? parseFloat(e.rsi).toFixed(1)  : "—";
    const adx   = e.adx   != null ? parseFloat(e.adx).toFixed(1)  : "—";
    const vwap  = e.vwapDist != null ? parseFloat(e.vwapDist).toFixed(2) : "—";
    const reason = (e.reason || "").replace(/,/g, ";").slice(0, 120);
    return `${ts},${e.symbol},${e.signal || "NEUTRAL"},${score},${rsi},${adx},${vwap},${e.blocker || "—"},"${reason}"`;
  }).join("\n");
  appendFileSync(SCAN_LOG_FILE, lines + "\n");
}

// Čisti stare scan log retke (drži samo zadnjih 7 dana)
function cleanScanLog() {
  try {
    if (!existsSync(SCAN_LOG_FILE)) return;
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const lines  = readFileSync(SCAN_LOG_FILE, "utf8").split("\n");
    const header = lines[0];
    const kept   = lines.slice(1).filter(l => !l || l >= cutoff);
    writeFileSync(SCAN_LOG_FILE, header + "\n" + kept.join("\n"));
  } catch (_) {}
}

// Učitaj SL cooldown s diska (preživi restart) — pozvan ovdje jer DATA_DIR sad postoji
loadSlCooldown();

// ─── Portfolio definicije ──────────────────────────────────────────────────────

const PORTFOLIO_IDS = ["synapse_t"];  // Aktivni portfolio — samo ULTRA

function buildPortfolios(rules) {
  const tfs = rules.portfolio_timeframes || {};
  return {
    synapse_t: {
      id:           "synapse_t",
      name:         "ULTRA",
      symbols:      rules.watchlist_synapse_t  || [],
      strategy:     "synapse_t",
      params:       rules.strategies.synapse_t?.params || {},
      timeframe:    tfs.synapse_t    || "15m",
      slPct:        1.0, tpPct: 2.0,
      live:         true,
      startCapital: 296.99,
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
    const body = Buffer.from(JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }), "utf8");
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) console.warn("[TG FAIL]", json.description, "| preview:", msg.slice(0, 60));
  } catch (e) { console.warn("[TG ERROR]", e.message); }
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

// Dohvati dnevni H/L za symbol (koristi se za day range filter pri ulasku)
const _dayHLCache = {};
async function fetchDayHL(symbol) {
  const now = Date.now();
  const cached = _dayHLCache[symbol];
  if (cached && now - cached.ts < 5 * 60 * 1000) return cached; // 5min cache
  try {
    const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1D&limit=1`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.code !== "00000" || !json.data?.length) return null;
    const c = json.data[0];
    const high = parseFloat(c[2]), low = parseFloat(c[3]);
    const result = { high, low, ts: now };
    _dayHLCache[symbol] = result;
    return result;
  } catch { return null; }
}

async function fetchKlines(symbol, interval = TIMEFRAME, limit = 250) {
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${interval}&limit=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`BitGet HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(`BitGet: ${json.msg}`);
  return json.data; // raw arrays: [time, open, high, low, close, volume, ...]
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
  const { minSig = 4, adxMin = 20 } = cfg;

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
  const { minSig = 8, _dynAdx, symbol: _sym, _pwh = null, _pwl = null } = cfg;
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
  const ema50  = ema(50);
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

  // sig19: RSI divergencija — klasični reversal signal
  // Bullish div: cijena LL ali RSI HL → LONG (dno bez momentum potvrde = iscrpljeni selleri)
  // Bearish div: cijena HH ali RSI LH → SHORT (vrh bez momentum potvrde = iscrpljeni buyeri)
  let sigRsiDiv = 0;
  {
    const DIV_LOOKBACK = 40;  // gledaj zadnjih 40 bara za swing točke
    const DIV_WING = 3;       // min 3 bara svake strane za swing high/low
    const DIV_MIN_RSI_DIFF = 2.0;  // min RSI razlika da ne broji šum
    const DIV_MIN_PRICE_DIFF = 0.005; // min 0.5% razlika u cijeni
    const start = Math.max(DIV_WING, n - DIV_LOOKBACK);
    const end   = n - DIV_WING - 1;  // ne uključuj zadnje barove (nemaju desnu stranu)

    const swingHighs = [], swingLows = [];
    for (let i = start; i <= end; i++) {
      const hi = candles[i].high, lo = candles[i].low;
      let isHigh = true, isLow = true;
      for (let j = i - DIV_WING; j <= i + DIV_WING; j++) {
        if (j === i) continue;
        if (candles[j].high >= hi) isHigh = false;
        if (candles[j].low  <= lo) isLow  = false;
      }
      if (isHigh && rsiArr2[i] !== null) swingHighs.push({ i, price: hi, rsi: rsiArr2[i] });
      if (isLow  && rsiArr2[i] !== null) swingLows.push({  i, price: lo, rsi: rsiArr2[i] });
    }

    // Bearish div: zadnja 2 swing higha — cijena HH, RSI LH
    if (swingHighs.length >= 2) {
      const h1 = swingHighs[swingHighs.length - 2];
      const h2 = swingHighs[swingHighs.length - 1];
      const priceDiff = (h2.price - h1.price) / h1.price;
      const rsiDiff   = h1.rsi - h2.rsi;  // h1 viši RSI, h2 niži = divergencija
      if (priceDiff > DIV_MIN_PRICE_DIFF && rsiDiff > DIV_MIN_RSI_DIFF) sigRsiDiv = -1;
    }
    // Bullish div: zadnja 2 swing lowa — cijena LL, RSI HL
    if (swingLows.length >= 2 && sigRsiDiv === 0) {
      const l1 = swingLows[swingLows.length - 2];
      const l2 = swingLows[swingLows.length - 1];
      const priceDiff = (l1.price - l2.price) / l1.price;
      const rsiDiff   = l2.rsi - l1.rsi;  // l2 viši RSI, l1 niži = divergencija
      if (priceDiff > DIV_MIN_PRICE_DIFF && rsiDiff > DIV_MIN_RSI_DIFF) sigRsiDiv = 1;
    }
  }

  // ── sig20: Previous Weekly High/Low (PWH/PWL) — POST-SWEEP potvrda ──────────────
  // MM pattern: cijena proba ispod PWL (hvata SL-ove), zatim se vrati iznad = LONG
  //             cijena proba iznad PWH (hvata SL-ove), zatim se vrati ispod = SHORT
  // Čekamo SWEEP (low/high prošao razinu) + ZATVORENA svjeća natrag = potvrđen reversal
  let sigPWHL = 0;
  {
    const PWHL_ZONE  = 0.015;  // 1.5% zona oko PWH/PWL
    const SWEEP_BARS = 4;      // gledaj zadnjih 4 bara za sweep
    const recentLows  = candles.slice(-SWEEP_BARS - 1, -1).map(c => c.low);
    const recentHighs = candles.slice(-SWEEP_BARS - 1, -1).map(c => c.high);
    const sweptPWL = _pwl !== null && recentLows.some(l => l < _pwl);    // proba ispod PWL
    const sweptPWH = _pwh !== null && recentHighs.some(h => h > _pwh);   // proba iznad PWH
    // Bullish: sweep ispod PWL → zatvorena svjeća natrag iznad PWL → LONG
    if (sweptPWL && price > _pwl && (price - _pwl) / price < PWHL_ZONE && rsiRising)  sigPWHL =  1;
    // Bearish: sweep iznad PWH → zatvorena svjeća natrag ispod PWH → SHORT
    if (sweptPWH && price < _pwh && (_pwh - price) / price < PWHL_ZONE && rsiFalling) sigPWHL = -1;
  }

  // ── sig21: Market Structure — HH/HL (uptrend) vs LL/LH (downtrend) ──────────
  // Gleda zadnjih 60 bara, traži swing highs/lows (3 bara sa svake strane)
  // HH + HL = uptrend = +1 | LL + LH = downtrend = -1
  let sigMktStr = 0;
  {
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
    if (msHighs.length >= 2 && msLows.length >= 2) {
      const lastH = msHighs[msHighs.length - 1], prevH = msHighs[msHighs.length - 2];
      const lastL = msLows[msLows.length - 1],   prevL = msLows[msLows.length - 2];
      if (lastH > prevH && lastL > prevL) sigMktStr =  1;  // HH + HL = uptrend
      if (lastH < prevH && lastL < prevL) sigMktStr = -1;  // LH + LL = downtrend
    }
  }

  // ── sig22: Fair Value Gap (FVG) — 3-svjećički imbalance ──────────────────────
  // Bullish FVG: low[i] > high[i-2] → gap gore, cijena u njemu = support
  // Bearish FVG: high[i] < low[i-2] → gap dolje, cijena u njemu = resistance
  // Tražimo unmitigated FVG u zadnjih 30 bara koji cijena trenutno respektira
  let sigFVG = 0;
  {
    const FVG_LOOKBACK = 30, FVG_MIN_PCT = 0.003;
    for (let i = Math.max(2, n - FVG_LOOKBACK); i < n - 1 && sigFVG === 0; i++) {
      const c0h = candles[i-2].high, c0l = candles[i-2].low;
      const c2h = candles[i].high,   c2l = candles[i].low;
      // Bullish FVG: c2.low > c0.high
      if (c2l > c0h) {
        const gapPct = (c2l - c0h) / c0h;
        if (gapPct >= FVG_MIN_PCT && price >= c0h * 0.999 && price <= c2l * 1.005) sigFVG =  1;
      }
      // Bearish FVG: c0.low > c2.high
      if (c0l > c2h) {
        const gapPct = (c0l - c2h) / c2h;
        if (gapPct >= FVG_MIN_PCT && price <= c0l * 1.001 && price >= c2h * 0.995) sigFVG = -1;
      }
    }
  }

  // ── Order Block (OB) — SMC institucijski ulaz/izlaz zona ────────────────────
  // Bullish OB: zadnja crvena svjeća prije snažnog bullish poteza → cijena se vratila = +1
  // Bearish OB: zadnja zelena svjeća prije snažnog bearish poteza → cijena se vratila = -1
  let sigOB = 0;
  {
    const OB_LOOKBACK  = 50;
    const OB_CANDLES   = 3;    // min uzastopnih u smjeru za "snažan potez"
    const OB_MOVE_PCT  = 1.5;  // min % poteza ukupno
    const OB_BUFFER    = 0.003; // ±0.3% zone
    const obsStart = Math.max(1, n - OB_LOOKBACK);
    for (let i = obsStart; i < n - OB_CANDLES - 1 && sigOB === 0; i++) {
      // Bullish OB: crvena svjeća + zatim OB_CANDLES uzastopno zelenih + ukupni potez ≥ OB_MOVE_PCT%
      if (candles[i].close < candles[i].open) {
        let allGreen = true;
        for (let j = i+1; j <= i+OB_CANDLES; j++) { if (candles[j].close <= candles[j].open) allGreen=false; }
        const move = (candles[i+OB_CANDLES].close - candles[i].close) / candles[i].close * 100;
        if (allGreen && move >= OB_MOVE_PCT) {
          const inZone = price >= candles[i].low*(1-OB_BUFFER) && price <= candles[i].high*(1+OB_BUFFER);
          if (inZone) sigOB = 1;
        }
      }
      // Bearish OB: zelena svjeća + zatim OB_CANDLES uzastopno crvenih
      if (candles[i].close > candles[i].open && sigOB === 0) {
        let allRed = true;
        for (let j = i+1; j <= i+OB_CANDLES; j++) { if (candles[j].close >= candles[j].open) allRed=false; }
        const move = (candles[i].close - candles[i+OB_CANDLES].close) / candles[i].close * 100;
        if (allRed && move >= OB_MOVE_PCT) {
          const inZone = price >= candles[i].low*(1-OB_BUFFER) && price <= candles[i].high*(1+OB_BUFFER);
          if (inZone) sigOB = -1;
        }
      }
    }
  }

  // ── sig10: Daily EMA 10 / EMA 20 retest (TraderaEdge Smart Hub) ─────────────
  // Bullish: daily EMA10 > EMA20 (dnevni uptrend) + cijena iznad EMA10 = bull kontekst
  // Bearish: daily EMA10 < EMA20 (dnevni downtrend) + cijena ispod EMA10 = bear kontekst
  // Najjači signal: cijena je retestirala EMA10 (unutar 1.5%) i RSI raste/pada
  const { _dailyEma10 = null, _dailyEma20 = null } = cfg;
  let sigDailyEMA = 0;
  if (_dailyEma10 !== null && _dailyEma20 !== null) {
    const nearEma10  = Math.abs(price - _dailyEma10) / price < 0.015;
    const aboveEma10 = price > _dailyEma10;
    // Primarni signal: iznad/ispod daily EMA10 = bull/bear dnevni kontekst
    // Pojačano: retest EMA10 (unutar 1.5%) + RSI potvrda = jači ulaz (TraderaEdge Smart Hub)
    if      (aboveEma10 && nearEma10 && rsiRising)   sigDailyEMA =  1;  // retest EMA10 s gore + RSI raste
    else if (aboveEma10)                              sigDailyEMA =  1;  // iznad daily EMA10 = bull
    else if (!aboveEma10 && nearEma10 && rsiFalling)  sigDailyEMA = -1;  // retest EMA10 s dole + RSI pada
    else                                              sigDailyEMA = -1;  // ispod daily EMA10 = bear
  }

  // ── sig11: Liquidity Hunt — sve ključne zone (TraderaEdge) ───────────────────
  // Prati: Monthly Open/High/Low, Weekly Open, Yearly Open, PWH, PWL
  // Bullish sweep: cijena prošla ispod zone → uzela SL-ove → sada iznad = LONG
  // Bearish sweep: cijena prošla iznad zone → uzela SL-ove → sada ispod = SHORT
  // Kontekst: iznad/ispod majority zona = bull/bear bias
  const {
    _monthlyOpen = null, _monthlyHigh = null, _monthlyLow = null,
    _weeklyOpen  = null, _yearlyOpen  = null, _fridayClose = null
  } = cfg;
  let sigMOPEN = 0;
  const LH_ZONE = 0.015;  // 1.5% proximity za sweep detekciju
  // Sweep prozor 48h (192×15m) — HTF sweep traje danima (10.07.: TraderaEdge 59k ulaz
  // nakon sweep-a Yearly Low koji je trajao dane; stari 2h prozor bi ga propustio).
  // Reclaim svježina i dalje: cijena SADA iznad zone + RSI okreće.
  const recentLowsLH  = candles.slice(-192).map(c => c.low);
  const recentHighsLH = candles.slice(-192).map(c => c.high);
  // Sakupi sve dostupne LH razine (+ ključna ciklus-razina za BTC, npr. 60k —
  // TraderaEdge 07/2026: "svaki satoshi ispod 60k agresivno kupljen; očekuje se fakeout")
  const _lhLevels = [
    _monthlyOpen, _weeklyOpen, _yearlyOpen, _fridayClose,
    _monthlyHigh, _monthlyLow,
    cfg._pwh ?? null, cfg._pwl ?? null,
    cfg._keyLevel ?? null
  ].filter(v => v !== null && v > 0);
  let _sweepInfo = null;  // za Liquidity Hunt strategiju (standalone ulaz)
  if (_lhLevels.length > 0) {
    let sweepBull = 0, sweepBear = 0;
    for (const lvl of _lhLevels) {
      const near     = Math.abs(price - lvl) / price < LH_ZONE;
      const sweptBel = recentLowsLH.some(l  => l < lvl * 0.999);
      const sweptAbv = recentHighsLH.some(h => h > lvl * 1.001);
      if (sweptBel && price > lvl && near && rsiRising)  { sweepBull++; _sweepInfo = { dir: 1,  level: lvl }; }
      if (sweptAbv && price < lvl && near && rsiFalling) { sweepBear++; _sweepInfo = { dir: -1, level: lvl }; }
    }
    if (sweepBull > 0 && sweepBear > 0) _sweepInfo = null;  // konfliktni sweepovi — ne diraj
    if (sweepBull > sweepBear && sweepBull > 0)      sigMOPEN =  1;  // aktivan sweep + recovery
    else if (sweepBear > sweepBull && sweepBear > 0) sigMOPEN = -1;
    else {
      // Kontekst: je li cijena iznad/ispod majority ključnih zona
      const bullCtx = _lhLevels.filter(l => price > l * 1.001).length;
      const bearCtx = _lhLevels.filter(l => price < l * 0.999).length;
      if (bullCtx > bearCtx)      sigMOPEN =  1;
      else if (bearCtx > bullCtx) sigMOPEN = -1;
    }
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

  // ── 9 signala: +1 = bullish, -1 = bearish, 0 = neutral ──
  // OBAVEZNI GATING (3 gateva): ADX≥dynamic, RSI asimetričan, VOL_EXH
  // REVERSANI (logika invertirana za pullback): E50, CVD
  // NOVO (06.06.2026): PWH/PWL (weekly S/R), MktStr (market structure), FVG (fair value gap)
  const sigs = [
    price > ema50 ? 1 : -1,                            //  1. E50   TREND: iznad EMA50 = bullish
    cvdSum > 0 ? 1 : -1,                              //  2. CVD   TREND: kupci dominiraju = bullish
    macdHist !== null ? (macdHist > 0 ? 1 : -1) : 0, //  3. MACD  MOM: histogram momentum
    price > ema145 ? 1 : -1,                          //  4. E145  TREND: dugoročni trend
    sigPWHL,                                           //  5. PWHL  Weekly: bounce PWL/rejection PWH
    sigRsiDiv,                                         //  6. RDIV  RSI divergencija
    sigMktStr,                                         //  7. MSTR  Market Structure HH/HL vs LL/LH
    sigFVG,                                            //  8. FVG   Fair Value Gap imbalance
    sigOB,                                             //  9. OB    Order Block (SMC institucijska zona)
    sigDailyEMA,                                       // 10. DEMA  Daily EMA10/20 retest (TraderaEdge Smart Hub)
    sigMOPEN,                                          // 11. LHUNT Liquidity Hunt: MOpen+WOpen+YOpen+MH/ML+PWH/PWL
  ];

  // Per-simbol combo filter — koristi samo signale iz SYMBOL_COMBOS
  const _combo    = SYMBOL_COMBOS[_sym];
  const _comboIdx = _combo?.sigIdx ?? [0,1,2,3,4,5,6,7];
  const _activeSigs = _comboIdx.map(i => sigs[i]);
  const bullCnt = _activeSigs.filter(s => s === 1).length;
  const bearCnt = _activeSigs.filter(s => s === -1).length;

  // ── Težinski bonus: CVD + E145 su "premium" signali (samo ako su u combu) ────
  const cvdBull  = sigs[1] === 1  && _comboIdx.includes(1);
  const e145Bull = sigs[3] === 1  && _comboIdx.includes(3);
  const cvdBear  = sigs[1] === -1 && _comboIdx.includes(1);
  const e145Bear = sigs[3] === -1 && _comboIdx.includes(3);
  const _premiumBonusBull = (cvdBull && e145Bull) ? 1 : 0;
  const _premiumBonusBear = (cvdBear && e145Bear) ? 1 : 0;
  // Bonus 2: PWHL + MSTR u istom smjeru (samo ako oba u combu)
  const _pwhInCombo  = _comboIdx.includes(4);
  const _mstrInCombo = _comboIdx.includes(6);
  const _pwhMstrBonusBull = (_pwhInCombo && _mstrInCombo && sigs[4] === 1  && sigs[6] === 1)  ? 1 : 0;
  const _pwhMstrBonusBear = (_pwhInCombo && _mstrInCombo && sigs[4] === -1 && sigs[6] === -1) ? 1 : 0;
  const bullScore = bullCnt + _premiumBonusBull + _pwhMstrBonusBull;
  const bearScore = bearCnt + _premiumBonusBear + _pwhMstrBonusBear;
  // Vikend: +1 signal — subotom/nedjeljom tanka likvidnost, samo najjači setupi
  // (post-mortem 05.07.: svi likvidirani ulazi bili subotnji minimalni 5/8)
  const _dowMC = new Date().getUTCDay();
  const _weekendBoost = (_dowMC === 0 || _dowMC === 6) ? 1 : 0;
  // CHILL mode: mrtvo tržište → kripto traži +1 signal (dionice izuzete — ne prate BTC)
  const _chillBoost = (cfg._chillMode && !isStockSym(_sym)) ? 1 : 0;
  const MIN_CONFIRM = (_combo?.minSig ?? minSig) + _weekendBoost + _chillBoost;
  // BTC trend-invalidacija: dnevni close ispod razine = prvi signal slabljenja → pooštri LONG
  const _invalBoost = (cfg._invalBoost && !isStockSym(_sym)) ? 1 : 0;
  const MIN_CONFIRM_LONG = MIN_CONFIRM + _invalBoost;

  // ══ OBAVEZNI GATEVI (3) ══

  // 0. DEMA gate — TraderaEdge momentum pravilo: LONG samo iznad daily EMA10,
  //    SHORT samo ispod (analiza 07.07.: pullback longovi ispod dnevnog trenda = 18L)
  if (sigDailyEMA === -1 && bullScore >= MIN_CONFIRM && bearScore < MIN_CONFIRM) {
    return { price, signal: "NEUTRAL", bullScore, bearScore,
      reason: `DEMA gate: cijena ispod daily EMA10 — LONG blokiran (dnevni trend dolje)` };
  }
  if (sigDailyEMA === 1 && bearScore >= MIN_CONFIRM && bullScore < MIN_CONFIRM) {
    return { price, signal: "NEUTRAL", bullScore, bearScore,
      reason: `DEMA gate: cijena iznad daily EMA10 — SHORT blokiran (dnevni trend gore)` };
  }

  // 1. ADX ≥ effectiveAdx — trend strategije traže trend. Ako ga NEMA,
  //    market je u zoni/fakeout modu → TraderaEdge router: SWEEP i RANGE strategije
  if (adx < effectiveAdx) {

    // ── STRATEGIJA: LIQUIDITY HUNT (sweep + reclaim HTF zone) ────────────────
    // TraderaEdge: "čekati konfirmaciju da se likvidnost skine, a tek onda ući;
    // u zadnjem low tog impulsa staviti stop loss" — kratkoročni kontra trade
    if (_sweepInfo) {
      if (_sweepInfo.dir === 1) {
        const _swLow = Math.min(...recentLowsLH);
        const _slP = _swLow * 0.997;
        const _slPctS = (price - _slP) / price * 100;
        if (_slPctS >= 0.6 && _slPctS <= 4) {
          const _tpP = price + (price - _slP) * 2;  // 1:2
          return { price, signal: "LONG", bullScore: MIN_CONFIRM, bearScore: 0,
            _strategy: "SWEEP", _slPrice: _slP, _tpPrice: _tpP, nearSup, nearRes,
            reason: `SWEEP LONG: likvidnost skinuta ispod ${_sweepInfo.level.toFixed(4)} + reclaim | SL ispod sweep low` };
        }
      }
      if (_sweepInfo.dir === -1) {
        const _swHigh = Math.max(...recentHighsLH);
        const _slP = _swHigh * 1.003;
        const _slPctS = (_slP - price) / price * 100;
        if (_slPctS >= 0.6 && _slPctS <= 4) {
          const _tpP = price - (_slP - price) * 2;
          return { price, signal: "SHORT", bullScore: 0, bearScore: MIN_CONFIRM,
            _strategy: "SWEEP", _slPrice: _slP, _tpPrice: _tpP, nearSup, nearRes,
            reason: `SWEEP SHORT: fake breakout iznad ${_sweepInfo.level.toFixed(4)} + pad | SL iznad sweep high` };
        }
      }
    }

    // ── STRATEGIJA: RANGE / Smart Hub (bounce sa S/R ruba zone) ──────────────
    // TraderaEdge: "kada je market u zoni, mnogo bolje radi momentum/zonska trgovina —
    // pracenje range high/low, reakcije, podrške i otpora"
    if (nearSup !== null && nearRes !== null) {
      const _rWidth = (nearRes - nearSup) / price * 100;
      if (_rWidth >= 1.5 && _rWidth <= 8) {
        const _supDist = (price - nearSup) / price * 100;
        const _resDist = (nearRes - price) / price * 100;
        // LONG bounce s donjeg ruba: cijena na supportu + RSI okreće gore iz niskog
        if (_supDist <= 0.5 && rsiRising && rsi < 45) {
          const _slP = nearSup * 0.996;
          const _slPctR = (price - _slP) / price * 100;
          const _tpP = Math.min(nearRes * 0.998, price + (price - _slP) * 2);
          if ((_tpP - price) >= (price - _slP) * 1.5) {  // min 1:1.5 unutar zone
            return { price, signal: "LONG", bullScore: MIN_CONFIRM, bearScore: 0,
              _strategy: "RANGE", _slPrice: _slP, _tpPrice: _tpP, nearSup, nearRes,
              reason: `RANGE LONG: bounce @ sup ${nearSup.toFixed(4)} (zona ${_rWidth.toFixed(1)}%, RSI ${rsi.toFixed(0)}↑)` };
          }
        }
        // SHORT rejection s gornjeg ruba
        if (_resDist <= 0.5 && rsiFalling && rsi > 55) {
          const _slP = nearRes * 1.004;
          const _slPctR = (_slP - price) / price * 100;
          const _tpP = Math.max(nearSup * 1.002, price - (_slP - price) * 2);
          if ((price - _tpP) >= (_slP - price) * 1.5) {
            return { price, signal: "SHORT", bullScore: 0, bearScore: MIN_CONFIRM,
              _strategy: "RANGE", _slPrice: _slP, _tpPrice: _tpP, nearSup, nearRes,
              reason: `RANGE SHORT: rejection @ res ${nearRes.toFixed(4)} (zona ${_rWidth.toFixed(1)}%, RSI ${rsi.toFixed(0)}↓)` };
          }
        }
      }
    }

    return { price, signal: "NEUTRAL", bullScore: bullCnt, bearScore: bearCnt,
      reason: `ADX ${adx.toFixed(1)} < ${effectiveAdx} — zona bez ruba/sweepa, nema ulaza` };
  }

  // 6-Scale info (nije više obavezan gate, koristi se samo za _strongTrend i reason string)
  const scaleOkLong  = scaleUp >= 4;
  const scaleOkShort = scaleDn >= 4;

  // RSI — info only, više nije obavezan gate
  const _strongTrend = adx > 50 && scaleUp === 6;
  const _strongTrendS = adx > 50 && scaleDn === 6;
  const rsiLongOk  = true;
  const rsiShortOk = true;

  // 4. VOL EXHAUSTION gate
  const VOL_EXH_THRESHOLD = VOL_EXH_TIERS[_sym] ?? VOL_EXH_DEFAULT;
  const volRatioNow = volAvg20 > 0 ? volLast / volAvg20 : 1;
  const volExhOk = volRatioNow < VOL_EXH_THRESHOLD;
  const _isMaxScore = bullCnt === 7 || bearCnt === 7;
  if (!volExhOk && !_isMaxScore) {
    return { price, signal: "NEUTRAL", bullScore: bullCnt, bearScore: bearCnt,
      reason: `VOL_EXH: ${volRatioNow.toFixed(2)}x avg ≥ ${VOL_EXH_THRESHOLD}× (${_sym||"def"}) — high-vol svjeća, čekamo pullback` };
  }
  if (!volExhOk && _isMaxScore) {
    console.log(`  ⚡ [VOL_EXH bypass] ${_sym} — max score, ignoriramo VOL_EXH (${volRatioNow.toFixed(2)}x)`);
  }

  // 5. VWAP crossover + potvrda
  // Ulaz SAMO kad je:
  //   - Svjeća N-2: bila na suprotnoj strani VWAP
  //   - Svjeća N-1: probila VWAP (zatvorila na novoj strani)
  //   - Svjeća N (trenutna): potvrdila proboj (zatvara na istoj strani)
  // Ako VWAP nije dostupan → blokira
  const vwapVal = calcVWAP(candles);
  if (!vwapVal || vwapVal <= 0) {
    console.log(`  ⚠️  [VWAP] ${_sym} — VWAP nije dostupan, blokiran`);
  }
  // ── VWAP entry detekcija: Cross ILI Rejection ────────────────────────────────
  // 1. Cross + potvrda: probijena VWAP + iduća svjeća potvrđuje
  const _vwapCrossUp   = vwapVal && n >= 3
    && closes[n-3] < vwapVal        // N-2: bio ispod
    && closes[n-2] > vwapVal        // N-1: probio iznad
    && closes[n-1] > vwapVal;       // N:   potvrdio → LONG
  const _vwapCrossDown = vwapVal && n >= 3
    && closes[n-3] > vwapVal        // N-2: bio iznad
    && closes[n-2] < vwapVal        // N-1: probio ispod
    && closes[n-1] < vwapVal;       // N:   potvrdio → SHORT

  // 2. Rejection: cijena ispod VWAP, zelena svjeća ne probije, slijedeća crvena → SHORT
  //              cijena iznad VWAP, crvena svjeća ne padne ispod, slijedeća zelena → LONG
  const _prevOpen  = candles[n-2]?.open  ?? closes[n-2];
  const _prevClose = candles[n-2]?.close ?? closes[n-2];
  const _currOpen  = candles[n-1]?.open  ?? closes[n-1];
  const _currClose = candles[n-1]?.close ?? closes[n-1];
  const _prevGreen = _prevClose > _prevOpen;  // zelena svjeća
  const _prevRed   = _prevClose < _prevOpen;  // crvena svjeća
  const _currGreen = _currClose > _currOpen;
  const _currRed   = _currClose < _currOpen;

  const _vwapRejectShort = vwapVal && n >= 2
    && _currClose < vwapVal    // trenutno ispod VWAP
    && _prevGreen              // prethodna zelena (pokušala gore)
    && _prevClose < vwapVal    // ali nije prešla VWAP
    && _currRed;               // ova crvena = odbijanje → SHORT

  const _vwapRejectLong = vwapVal && n >= 2
    && _currClose > vwapVal    // trenutno iznad VWAP
    && _prevRed                // prethodna crvena (pokušala dolje)
    && _prevClose > vwapVal    // ali nije prešla VWAP
    && _currGreen;             // ova zelena = odbijanje → LONG

  // 3. Proximity fallback: cijena unutar ±0.5% od VWAP = na VWAP razini, ok za ulaz
  const _vwapProximity = vwapVal && Math.abs(price - vwapVal) / vwapVal <= 0.005;

  const _vwapLongOk  = _vwapCrossUp   || _vwapRejectLong  || _vwapProximity;
  const _vwapShortOk = _vwapCrossDown || _vwapRejectShort || _vwapProximity;

  const _bonusBullTag = [
    _premiumBonusBull   ? "CVD+E145" : "",
    _pwhMstrBonusBull   ? "PWH+MSTR" : "",
  ].filter(Boolean).join(",");
  const _bonusBearTag = [
    _premiumBonusBear   ? "CVD+E145" : "",
    _pwhMstrBonusBear   ? "PWH+MSTR" : "",
  ].filter(Boolean).join(",");
  const bonusTag = _bonusBullTag ? ` [+${_premiumBonusBull+_pwhMstrBonusBull}:${_bonusBullTag}]`
                : _bonusBearTag ? ` [+${_premiumBonusBear+_pwhMstrBonusBear}:${_bonusBearTag}]` : "";

  // Dodaj extra info za nove signale u reason
  const _newSigsBull = [sigPWHL===1?"PWL✓":"", sigMktStr===1?"MSTR✓":"", sigFVG===1?"FVG✓":""].filter(Boolean).join(" ");
  const _newSigsBear = [sigPWHL===-1?"PWH✓":"", sigMktStr===-1?"MSTR✓":"", sigFVG===-1?"FVG✓":""].filter(Boolean).join(" ");

  if (bullScore >= MIN_CONFIRM_LONG && rsiLongOk) {
    if (!vwapVal || vwapVal <= 0) {
      return { price, signal: "NEUTRAL", bullScore, bearScore,
        reason: `PBK LONG blokiran: VWAP nedostupan` };
    }
    if (!_vwapLongOk) {
      const vd = ((price - vwapVal) / vwapVal * 100).toFixed(1);
      return { price, signal: "NEUTRAL", bullScore, bearScore, vwap: vwapVal,
        reason: `PBK LONG blokiran: nema VWAP crossover potvrde (cijena ${vd}% od VWAP)` };
    }
    // Zone confluence (TG 21.07. Korak #2: "ne juri market cenu — čekaj da market dođe tebi")
    // Trend LONG samo uz potporu: 15m pivot sup ili HTF zona unutar 1.5% ispod/na cijeni
    {
      const _confL = [nearSup, cfg._pwl, _monthlyLow, _weeklyOpen, _monthlyOpen, _fridayClose, _yearlyOpen, cfg._keyLevel]
        .filter(v => v != null && v > 0 && v <= price * 1.002);
      if (!_confL.some(l => (price - l) / price <= 0.015)) {
        return { price, signal: "NEUTRAL", bullScore, bearScore, nearSup, nearRes, vwap: vwapVal,
          reason: `PBK LONG blokiran: cijena nije uz potporu — ne jurimo, čekamo zonu` };
      }
    }
    const sigMask = sigs.reduce((mask, v, i) => v === 1 ? mask | (1 << i) : mask, 0);
    return { price, signal: "LONG", bullScore, bearScore, sigMask,
      nearSup, nearRes, vwap: vwapVal,
      reason: `ULTRA LONG ↑${bullCnt}/8 ADX:${adx.toFixed(0)}✓ RSI:${rsi.toFixed(0)}✓ VWAP✓${bonusTag}${_newSigsBull?" "+_newSigsBull:""}` };
  }
  if (!LONG_ONLY && bearScore >= MIN_CONFIRM && rsiShortOk) {
    if (!vwapVal || vwapVal <= 0) {
      return { price, signal: "NEUTRAL", bullScore, bearScore,
        reason: `PBK SHORT blokiran: VWAP nedostupan` };
    }
    if (!_vwapShortOk) {
      const vd = ((price - vwapVal) / vwapVal * 100).toFixed(1);
      return { price, signal: "NEUTRAL", bullScore, bearScore, vwap: vwapVal,
        reason: `PBK SHORT blokiran: nema VWAP crossover potvrde (cijena ${vd}% od VWAP)` };
    }
    // Zone confluence — trend SHORT samo uz otpor (15m pivot res ili HTF zona ≤1.5% iznad)
    {
      const _confS = [nearRes, cfg._pwh, _monthlyHigh, _weeklyOpen, _monthlyOpen, _fridayClose, _yearlyOpen, cfg._keyLevel]
        .filter(v => v != null && v > 0 && v >= price * 0.998);
      if (!_confS.some(l => (l - price) / price <= 0.015)) {
        return { price, signal: "NEUTRAL", bullScore, bearScore, nearSup, nearRes, vwap: vwapVal,
          reason: `PBK SHORT blokiran: cijena nije uz otpor — ne jurimo, čekamo zonu` };
      }
    }
    return { price, signal: "SHORT", bullScore, bearScore,
      nearSup, nearRes, vwap: vwapVal,
      reason: `ULTRA SHORT ↓${bearCnt}/8 ADX:${adx.toFixed(0)}✓ RSI:${rsi.toFixed(0)}✓ VWAP✓${bonusTag}${_newSigsBear?" "+_newSigsBear:""}` };
  }
  if (LONG_ONLY && bearScore >= MIN_CONFIRM && rsiShortOk) {
    return { price, signal: "NEUTRAL", bullScore, bearScore,
      reason: `SHORT↓${bearCnt}/8 blokiran — LONG_ONLY mod aktivan` };
  }

  // ── MOMENTUM fallback (hibrid) ──────────────────────────────────────────────
  // Ako pullback signal nije dostigao prag, provjeri momentum/breakout logiku:
  // Isti 13 signala ali 6 reversanih vraćamo u originalnu (trend-following) logiku.
  // Viši prag (MOM_MIN) jer su momentum ulazi rizičniji od pullback ulaza.
  const MOM_MIN = _combo?.minSig ?? 5;  // = combo minSig (4/5 za optimizirane simbole)
  const momSigs = [
    price > ema50  ?  1 : -1,                          //  1. E50   MOM: >EMA50 = trend gore = +1
    cvdSum > 0 ?  1 : -1,                              //  2. CVD   MOM: kupni vol = potvrda pumpa = +1
    macdHist !== null ? (macdHist > 0 ? 1 : -1) : 0,  //  3. MACD  MOM: isti
    price > ema145 ?  1 : -1,                          //  4. E145  TREND: isti
    sigPWHL,                                            //  5. PWHL  Weekly: isti
    sigRsiDiv,                                          //  6. RDIV  RSI div: isti
    sigMktStr,                                          //  7. MSTR  Market Structure: isti
    sigFVG,                                             //  8. FVG   Fair Value Gap: isti
  ];
  const _momActiveSigs = _comboIdx.map(i => momSigs[i]);
  const momBullBase = _momActiveSigs.filter(s => s === 1).length;
  const momBearBase = _momActiveSigs.filter(s => s === -1).length;
  // Bonus 1: CVD + E145 za momentum (samo ako u combu)
  const momCvdBull  = momSigs[1] === 1  && _comboIdx.includes(1);
  const momE145Bull = momSigs[3] === 1  && _comboIdx.includes(3);
  const momCvdBear  = momSigs[1] === -1 && _comboIdx.includes(1);
  const momE145Bear = momSigs[3] === -1 && _comboIdx.includes(3);
  // Bonus 2: PWHL + MSTR za momentum (samo ako oba u combu)
  const momPwhMstrBull = (_pwhInCombo && _mstrInCombo && momSigs[4] === 1  && momSigs[6] === 1)  ? 1 : 0;
  const momPwhMstrBear = (_pwhInCombo && _mstrInCombo && momSigs[4] === -1 && momSigs[6] === -1) ? 1 : 0;
  const momBull = momBullBase + (momCvdBull && momE145Bull ? 1 : 0) + momPwhMstrBull;
  const momBear = momBearBase + (momCvdBear && momE145Bear ? 1 : 0) + momPwhMstrBear;

  // Za momentum: bez 6SC gate (breakout sam potvrđuje smjer), ADX ≥ 20
  const MOM_ADX_MIN = 20;

  if (momBull >= MOM_MIN && rsiLongOk && adx >= MOM_ADX_MIN) {
    if (!vwapVal || vwapVal <= 0) {
      return { price, signal: "NEUTRAL", bullScore: momBull, bearScore: momBear,
        reason: `MOM LONG blokiran: VWAP nedostupan` };
    }
    if (!_vwapLongOk) {
      const _mvd = ((price - vwapVal) / vwapVal * 100).toFixed(1);
      return { price, signal: "NEUTRAL", bullScore: momBull, bearScore: momBear, vwap: vwapVal,
        reason: `MOM LONG blokiran: nema VWAP crossover potvrde (cijena ${_mvd}% od VWAP)` };
    }
    return { price, signal: "LONG", bullScore: momBull, bearScore: momBear,
      nearSup, nearRes, isMomentum: true, vwap: vwapVal,
      reason: `MOMENTUM LONG ↑${momBullBase}/8 | VWAP cross✓ ADX:${adx.toFixed(0)}✓ RSI:${rsi.toFixed(0)}✓${_strongTrend?" [STRONG]":""}${sigRsiDiv===1?" RDIV✓":""}${sigMktStr===1?" MSTR✓":""}${sigFVG===1?" FVG✓":""}` };
  }
  if (!LONG_ONLY && momBear >= MOM_MIN && rsiShortOk && adx >= MOM_ADX_MIN) {
    if (!vwapVal || vwapVal <= 0) {
      return { price, signal: "NEUTRAL", bullScore: momBull, bearScore: momBear,
        reason: `MOM SHORT blokiran: VWAP nedostupan` };
    }
    if (!_vwapShortOk) {
      const _svd = ((price - vwapVal) / vwapVal * 100).toFixed(1);
      return { price, signal: "NEUTRAL", bullScore: momBull, bearScore: momBear, vwap: vwapVal,
        reason: `MOM SHORT blokiran: nema VWAP crossover potvrde (cijena ${_svd}% od VWAP)` };
    }
    return { price, signal: "SHORT", bullScore: momBull, bearScore: momBear,
      nearSup, nearRes, isMomentum: true, vwap: vwapVal,
      reason: `MOMENTUM SHORT ↓${momBearBase}/8 | VWAP cross✓ ADX:${adx.toFixed(0)}✓ RSI:${rsi.toFixed(0)}✓${_strongTrendS?" [STRONG]":""}${sigRsiDiv===-1?" RDIV✓":""}${sigMktStr===-1?" MSTR✓":""}${sigFVG===-1?" FVG✓":""}` };
  }

  // Dijagnoza zašto nema signala
  const dirStr = scaleOkLong ? `LONG(${scaleUp}/6)` : scaleOkShort ? `SHORT(${scaleDn}/6)` : `6Sc✗`;
  const _rsiLongPrag  = _strongTrend  ? 85 : 72;
  const _rsiShortPrag = _strongTrendS ? 15 : 30;
  const whyNot = bullCnt >= bearCnt
    ? `↑${bullCnt}/9 ${dirStr}${!rsiLongOk  ? ` RSI${rsi.toFixed(0)}≥${_rsiLongPrag}✗`  : ""} | MOM:${momBull}/9`
    : `↓${bearCnt}/9 ${dirStr}${!rsiShortOk ? ` RSI${rsi.toFixed(0)}≤${_rsiShortPrag}✗` : ""} | MOM:${momBear}/9`;
  return { price, signal: "NEUTRAL", bullScore: bullCnt, bearScore: bearCnt,
    momBull, momBear,
    reason: `ULTRA: ${whyNot} (treba ${MIN_CONFIRM}/9 pullback ili ${MOM_MIN}/9 momentum)` };
}

// ─── ULTRA Immediate Entry ─────────────────────────────────────────────────────
// Ulaz odmah na close signal-svjećice — bez čekanja H/L breakouta.
// Signal pali → trade se otvara na trenutnoj cijeni (close zadnje svjećice).

// check5mSRTest — uklonjeno 06.06.2026 (bio samo logging, nije blokirao trade)

async function analyzeUltraPullback(symbol, candles, cfg) {
  const last  = candles[candles.length - 1];
  const price = last.close;

  // Očisti stale pending zapise (legacy)
  const pid = "synapse_t";
  let pending = loadPending(pid);
  pending = pending.filter(p => p.symbol !== symbol);
  savePending(pid, pending);

  // ── Dohvati Previous Weekly High/Low + Weekly Open ────────────────────────
  // Bitget vraća ascending: zadnji = tekući tjedan, predzadnji = prethodni (dovršeni)
  let _pwh = null, _pwl = null, _wOpen = null;
  try {
    const wUrl = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1W&limit=3`;
    const wd = await fetch(wUrl).then(r => r.json());
    if (wd.code === "00000" && wd.data?.length >= 2) {
      const wLast = wd.data.length - 1;
      _wOpen = parseFloat(wd.data[wLast][1]);      // tekući tjedan open
      const prevWeek = wd.data[wLast - 1];         // prethodni (dovršeni) tjedan
      _pwh = parseFloat(prevWeek[2]);  // high
      _pwl = parseFloat(prevWeek[3]);  // low
    }
  } catch(e) {
    console.log(`  ⚠️  [PWH/PWL] ${symbol} — ne mogu dohvatiti weekly candle: ${e.message}`);
  }

  // ── Dohvati Daily EMA 10/20 + sve Liquidity Hunt zone ────────────────────────
  let _dailyEma10 = null, _dailyEma20 = null;
  let _monthlyOpen = null, _monthlyHigh = null, _monthlyLow = null;
  let _yearlyOpen  = null, _fridayClose = null;
  const _weeklyOpen = _wOpen;  // iz tjednog fetcha gore
  try {
    // Daily candles — ascending, history max ~90 dana
    const dUrl = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1Dutc&limit=90`;
    const dd = await fetch(dUrl).then(r => r.json());
    if (dd.code === "00000" && dd.data?.length >= 21) {
      const dC = dd.data.map(k => ({
        ts: parseInt(k[0]), open: parseFloat(k[1]),
        high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4])
      }));
      const dCl = dC.map(c => c.close);
      const dn = dCl.length;
      const dema = (p) => {
        const k = 2/(p+1); let v = dCl.slice(0,p).reduce((a,b)=>a+b,0)/p;
        for (let i=p; i<dn; i++) v = dCl[i]*k + v*(1-k);
        return v;
      };
      _dailyEma10 = dema(10);
      _dailyEma20 = dema(20);
      const now = new Date();
      // Monthly Open/High/Low
      const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const monthCandles = dC.filter(c => c.ts >= monthStart);
      if (monthCandles.length > 0) {
        _monthlyOpen = monthCandles[0].open;
        _monthlyHigh = Math.max(...monthCandles.map(c => c.high));
        _monthlyLow  = Math.min(...monthCandles.map(c => c.low));
      }
      // Friday close — zadnji dovršeni petak (TraderaEdge AMA: "Friday closing" zona)
      const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const fridays = dC.filter(c => new Date(c.ts).getUTCDay() === 5 && c.ts < todayStart);
      if (fridays.length > 0) _fridayClose = fridays[fridays.length - 1].close;
    }
    // Yearly Open — mjesečne svijeće (daily history preplitka)
    const mUrl = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1Mutc&limit=13`;
    const md = await fetch(mUrl).then(r => r.json());
    if (md.code === "00000" && md.data?.length >= 1) {
      const yearStart = Date.UTC(new Date().getUTCFullYear(), 0, 1);
      const janCandle = md.data.find(k => parseInt(k[0]) >= yearStart);
      if (janCandle) _yearlyOpen = parseFloat(janCandle[1]);
    }
  } catch(e) {
    console.log(`  ⚠️  [DEMA/LHUNT] ${symbol} — ${e.message}`);
  }

  // Pokreni analizu (proslijedi symbol + PWH/PWL + daily signali)
  // Ključna ciklus-razina (samo BTC) — iz rules.json (btc_key_level, npr. 60000)
  let _keyLevel = null;
  if (symbol === "BTCUSDT") {
    try { _keyLevel = JSON.parse(readFileSync("rules.json", "utf8")).btc_key_level ?? null; } catch {}
  }

  const result = analyzeUltra(candles, { ...cfg, symbol, _pwh, _pwl, _dailyEma10, _dailyEma20, _monthlyOpen, _monthlyHigh, _monthlyLow, _weeklyOpen, _yearlyOpen, _fridayClose, _keyLevel });

  if (result.signal === "LONG" || result.signal === "SHORT") {
    console.log(`  ✅ [ULTRA] ${symbol} ${result.signal} @ ${fmtPrice(price)} — (${result.bullScore ?? 0}↑/${result.bearScore ?? 0}↓)`);
  }

  // HTF zone za SL postavljanje (TraderaEdge: stop ispod likvidnosne zone, ne 15m pivota)
  result._zonesSL = {
    pwl: _pwl, pwh: _pwh,
    monthlyLow: _monthlyLow, monthlyHigh: _monthlyHigh,
    monthlyOpen: _monthlyOpen, weeklyOpen: _weeklyOpen,
    yearlyOpen: _yearlyOpen, fridayClose: _fridayClose,
  };

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

// ─── Helpers ────────────────────────────────────────────────────────────────────

// Cache pricePlace + minTradeNum po simbolu (dohvat iz BitGet contracts API)
const _pricePlace = {};
const _minTradeNum = {};

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
        if (c.symbol && c.minTradeNum !== undefined) {
          _minTradeNum[c.symbol] = parseFloat(c.minTradeNum);
        }
      }
      console.log(`✅ Učitano ${Object.keys(_pricePlace).length} simbola s pricePlace + minTradeNum`);
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
    entryMode:  entry.entryMode || "PBK",  // "MOM" ili "PBK"
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

const _softFailAlertTs = new Map();  // symbol:side → ts zadnjeg SOFT FAIL alerta (anti-spam)
const TRAIL_STRATEGIES = ["synapse_t"];  // koje strategije koriste trail
const TRAIL_TRIGGER    = 2.5;            // % gain koji aktivira trail
const TRAIL_STEP       = 0.5;            // korak pomaka TP-a (%)
const TRAIL_GIVEBACK   = 1.0;            // % ispod peaka — prostor za disanje u trendu
                                         // (06.07.: AAVE izbačen na prvi titraj jer je SL stajao na cijeni)

function applyTrail(pos, currentPrice) {
  if (!TRAIL_STRATEGIES.includes(pos.strategy)) return false;

  const entry = pos.entryPrice;
  const gainPct = pos.side === "LONG"
    ? (currentPrice - entry) / entry * 100
    : (entry - currentPrice) / entry * 100;

  // ── Break-even @ +1R (TraderaEdge AMA: "čim ode na 100%, break even") ──────
  // Kad profit dosegne 1× rizik (slPct), SL ide na entry (+0.05% za fee)
  const _riskPct = parseFloat(pos.slPct) || 2.0;
  if (!pos.beApplied && gainPct >= _riskPct) {
    const beSl = pos.side === "LONG" ? entry * 1.0005 : entry * 0.9995;
    const improved = pos.side === "LONG" ? beSl > pos.sl : beSl < pos.sl;
    pos.beApplied = true;
    if (improved) {
      pos.sl = beSl;
      console.log(`  🛡️  [BE] ${pos.symbol} ${pos.side} — +1R (${gainPct.toFixed(2)}% ≥ ${_riskPct}%) → SL na break-even ${fmtPrice(beSl)}`);
      if (gainPct < TRAIL_TRIGGER) return true;  // BE primijenjen, trail još nije
    }
  }

  if (gainPct < TRAIL_TRIGGER) return false;

  const steps     = Math.floor((gainPct - TRAIL_TRIGGER) / TRAIL_STEP);
  const origTpPct = pos.side === "LONG"
    ? (pos.origTp ?? pos.tp - entry) / entry * 100   // origTp za referentni TP
    : (entry - (pos.origTp ?? pos.tp)) / entry * 100;

  // Peak-based trail: SL prati vrh s TRAIL_GIVEBACK prostora (ne stoji na cijeni)
  // Pod: nikad ispod break-evena (+0.3% za fee) — aktivirani trail je uvijek u plusu
  pos.trailPeak = pos.side === "LONG"
    ? Math.max(pos.trailPeak ?? currentPrice, currentPrice)
    : Math.min(pos.trailPeak ?? currentPrice, currentPrice);
  const newTpPct = (pos.origTpPct ?? origTpPct) + (steps + 1) * TRAIL_STEP;

  let newSl, newTp;
  if (pos.side === "LONG") {
    newSl = Math.max(pos.trailPeak * (1 - TRAIL_GIVEBACK / 100), entry * 1.003);
    newTp = entry * (1 + newTpPct / 100);
    if (newSl <= pos.sl && newTp <= pos.tp) return false;  // ništa novo
    pos.sl = Math.max(pos.sl, newSl);
    pos.tp = Math.max(pos.tp, newTp);
  } else {
    newSl = Math.min(pos.trailPeak * (1 + TRAIL_GIVEBACK / 100), entry * 0.997);
    newTp = entry * (1 - newTpPct / 100);
    if (newSl >= pos.sl && newTp >= pos.tp) return false;
    pos.sl = Math.min(pos.sl, newSl);
    pos.tp = Math.min(pos.tp, newTp);
  }
  // NAPOMENA: ne postavljamo pos.trailActive — soft SL monitor izvršava trail izlaz
  // (trailActive flag koristi samo partial-TP peak mehanizam koji sam pomiče SL)

  // Pohrani originalni TP% za referencu (samo prvi put)
  if (!pos.origTpPct) pos.origTpPct = origTpPct;

  return true;  // pozicija ažurirana
}

// Dohvati stvarnu veličinu pozicije za jedan simbol/stranu s Bitgeta
// Vraća: { total, available } | null = POTVRĐENO ne postoji | { error: true } = API greška
// KRITIČNO (05.07.2026): greška se NE SMIJE tumačiti kao "pozicija ne postoji" —
// to je preko noći tiho izbacilo 6 živih pozicija iz trackinga → likvidacije bez SL-a.
async function fetchBitgetPositionSize(symbol, side) {
  try {
    const holdSide = side === "LONG" ? "long" : "short";
    // Koristi all-position (single-position ne postoji u Standard/Classic API-ju)
    const path = "/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT";
    const ts   = Date.now().toString();
    const sign = signBitGet(ts, "GET", path);
    const r    = await fetch(`${BITGET.baseUrl}${path}`, {
      headers: {
        "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET.passphrase,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    const d = await r.json();
    if (d.code !== "00000") {
      console.log(`  ⚠️  fetchBitgetPositionSize(${symbol} ${side}): Bitget ${d.code} ${d.msg}`);
      return { error: true };
    }
    const pos = (d.data || []).find(p => p.symbol === symbol && p.holdSide === holdSide && parseFloat(p.total) > 0);
    if (!pos) return null;  // API OK, pozicije stvarno nema
    return {
      total:     parseFloat(pos.total),
      available: parseFloat(pos.available ?? pos.total),
    };
  } catch (e) {
    console.log(`  ⚠️  fetchBitgetPositionSize(${symbol} ${side}): ${e.message}`);
    return { error: true };
  }
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
// Retry: do 3 pokušaja × 3s razmak (Bitget fill može kasniti par sekundi)
async function fetchBitgetClosedPnl(symbol, pos, attempt = 1) {
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
    if (d.code !== "00000" || !d.data?.fillList?.length) {
      if (attempt < 3) {
        console.log(`  ⏳ [fetchBitgetClosedPnl] ${symbol} — pokušaj ${attempt}/3, čekam 3s...`);
        await new Promise(res => setTimeout(res, 3000));
        return fetchBitgetClosedPnl(symbol, pos, attempt + 1);
      }
      return null;
    }

    // Filtriraj samo CLOSE fillove NAKON otvaranja pozicije
    const openTs = pos?.openTs
      || (pos?.openedAt ? new Date(pos.openedAt).getTime() : 0)
      || (pos?.ts       ? new Date(pos.ts).getTime()       : 0);
    const expectedCloseSide = pos?.side === "LONG" ? "close_long" : "close_short";

    const closeFills = d.data.fillList.filter(f => {
      const fillTs = parseInt(f.cTime || f.uTime || f.time || 0);
      const isAfterOpen = !openTs || fillTs >= openTs - 60_000;  // 1min tolerancija
      const isClose = f.side === expectedCloseSide
        || f.tradeSide === "close"
        || f.tradeSide === "burst_close"   // likvidacija
        || f.tradeSide === "forced_close"; // prisilno zatvaranje
      return isClose && isAfterOpen;
    });

    if (!closeFills.length) {
      if (attempt < 3) {
        console.log(`  ⏳ [fetchBitgetClosedPnl] ${symbol} — nema close fillova, pokušaj ${attempt}/3, čekam 3s...`);
        await new Promise(res => setTimeout(res, 3000));
        return fetchBitgetClosedPnl(symbol, pos, attempt + 1);
      }
      console.log(`  ⚠️  [fetchBitgetClosedPnl] ${symbol} — nema close fillova ni nakon 3 pokušaja (openTs=${openTs})`);
      return null;
    }

    // Bitget direktno vraća `profit` po fillu — to je najtočniji izvor
    const bitgetPnlSum = closeFills.reduce((s, f) => s + parseFloat(f.profit || f.realizedProfits || 0), 0);
    const hasBitgetPnl = closeFills.some(f => f.profit != null || f.realizedProfits != null);

    // Sumej sve close fillove za exit cijenu i fee
    const totalQty     = closeFills.reduce((s, f) => s + parseFloat(f.size  || 0), 0);
    const avgExitPrice = closeFills.reduce((s, f) => s + parseFloat(f.price || 0) * parseFloat(f.size || 0), 0) / (totalQty || 1);
    const totalFee     = closeFills.reduce((s, f) => s + Math.abs(parseFloat(f.fee || 0)), 0);

    if (!avgExitPrice || avgExitPrice <= 0) {
      console.log(`  ⚠️  [fetchBitgetClosedPnl] ${symbol} — avgExitPrice=${avgExitPrice} je nevažeći`);
      return null;
    }

    // P&L: prefer Bitget direktni profit (najtočniji), fallback na ručni izračun
    const entryPx = pos?.entryPrice ?? parseFloat(closeFills[0].price);
    const qty     = pos?.quantity ?? (pos?.totalUSD / pos?.entryPrice) ?? totalQty;
    const calcPnl = pos?.side === "LONG"
      ? (avgExitPrice - entryPx) * qty
      : (entryPx - avgExitPrice) * qty;

    const rawPnl = hasBitgetPnl ? bitgetPnlSum : calcPnl;

    // Sanity check: ako Bitget PnL i ručni izračun imaju različit predznak — warn
    if (hasBitgetPnl && Math.sign(bitgetPnlSum) !== Math.sign(calcPnl) && Math.abs(calcPnl) > 0.01) {
      console.warn(`  ⚠️  [fetchBitgetClosedPnl] ${symbol} — predznak razlika! Bitget=${bitgetPnlSum.toFixed(4)} Ručni=${calcPnl.toFixed(4)} → koristim Bitget`);
    }

    // Sanity cap: maksimalni gubitak = margina × 1.1
    const maxLoss = pos?.margin ? pos.margin * 1.1 : (pos?.totalUSD ?? 999);
    const pnlCapped = Math.max(rawPnl, -maxLoss);
    if (pnlCapped !== rawPnl) {
      console.log(`  ⚠️  [fetchBitgetClosedPnl] ${symbol} — P&L capped ${rawPnl.toFixed(2)} → ${pnlCapped.toFixed(2)}`);
    }

    console.log(`  📊 [fetchBitgetClosedPnl] ${symbol} ${pos?.side} | exit=${avgExitPrice.toFixed(6)} entry=${entryPx.toFixed(6)} qty=${qty.toFixed(4)} fills=${closeFills.length} pnl=${pnlCapped.toFixed(4)} src=${hasBitgetPnl?"bitget":"calc"}`);

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

/**
 * Automatski cross-referencira CSV s Bitget fill historijom i ispravlja
 * sve trades gdje je exit cijena = SL cijena (znak buga fetchBitgetClosedPnl).
 * Exportirano za poziv iz dashboard.js admin endpointa.
 */
// NOTE: fetchBitgetPositionHistory — privremeno onemogućeno.
// Bitget position/history-position closeTime=0 sprječava pouzdan matching.
// Alternativa: koristiti ručni fix-csv endpoint s podacima s Bitget UI-a.
async function fetchBitgetPositionHistory(symbol, startMs, endMs) {
  return []; // onemogućeno
  // Bitget v2: position/history-position — zatvorene pozicije s achievedProfits i closeAvgPrice
  const path = `/api/v2/mix/position/history-position?productType=USDT-FUTURES&symbol=${symbol}&startTime=${startMs}&endTime=${endMs}&limit=100`;
  try {
    const ts   = Date.now().toString();
    const sign = signBitGet(ts, "GET", path);
    const r    = await fetch(`${BITGET.baseUrl}${path}`, {
      headers: {
        "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET.passphrase,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    const list = d.data?.list ?? d.data?.result ?? (Array.isArray(d.data) ? d.data : []);
    console.log(`  📡 [posHistory] ${symbol} → code=${d.code} msg=${d.msg} positions=${list.length}`);
    if (d.code !== "00000" || !list.length) return [];

    return list.map(p => ({
      closeTime:       parseInt(p.closeTime || p.cTime || p.uTime || 0),
      closeAvgPrice:   parseFloat(p.closeAvgPrice || p.avgClosePrice || 0),
      openAvgPrice:    parseFloat(p.openAvgPrice  || p.avgOpenPrice  || 0),
      achievedProfits: parseFloat(p.achievedProfits ?? p.netProfit ?? p.realizedPnl ?? 0),
    }));
  } catch (e) {
    console.error(`  ⚠️  fetchBitgetPositionHistory(${symbol}) greška: ${e.message}`);
    return [];
  }
}

export async function autoFixCsvFromBitget(pid = "synapse_t") {
  const f = csvFilePath(pid);
  if (!existsSync(f)) return { error: "CSV not found" };

  const lines   = readFileSync(f, "utf8").split("\n");
  const header  = lines[0];
  const results = { checked: 0, fixed: 0, skipped: 0, errors: 0, details: [] };
  const newLines = [header];

  // Cache za position history po simbolu da ne pozivamo API više puta za isti simbol
  const posHistoryCache = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { newLines.push(line); continue; }

    // Parsiraj red uz podršku za navodne znakove
    const cols = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur); cur = ""; }
      else cur += ch;
    }
    cols.push(cur);

    const side = cols[4] || "";
    if (side !== "CLOSE_LONG" && side !== "CLOSE_SHORT") { newLines.push(line); continue; }

    const exitPrice = parseFloat(cols[6]) || 0;
    const slPrice   = parseFloat(cols[10]) || 0;
    const curPnl    = parseFloat(cols[9]) || 0;

    // Provjeri je li exit = SL (bug indikator) — tolerancija 0.01%
    const isSuspect = slPrice > 0 && Math.abs(exitPrice - slPrice) < 0.0001 * slPrice;
    if (!isSuspect) { newLines.push(line); continue; }

    results.checked++;
    const symbol    = cols[3] || "";
    const tradeSide = side === "CLOSE_LONG" ? "LONG" : "SHORT";
    const closeTs   = new Date(`${cols[0]}T${cols[1] || "00:00:00"}Z`).getTime();

    console.log(`  🔍 [autoFix] ${symbol} ${cols[0]} ${cols[1]} — curPnl=${curPnl.toFixed(4)} exit=${exitPrice}`);

    try {
      // Dohvati position history ± 1 dan oko datuma zatvaranja
      const cacheKey = `${symbol}_${cols[0]}`;
      if (!posHistoryCache[cacheKey]) {
        await new Promise(r => setTimeout(r, 1500)); // rate limit zaštita
        const startMs = closeTs - 2 * 24 * 60 * 60 * 1000; // -2 dana
        const endMs   = closeTs + 2 * 24 * 60 * 60 * 1000; // +2 dana
        posHistoryCache[cacheKey] = await fetchBitgetPositionHistory(symbol, startMs, endMs);
      }
      const history = posHistoryCache[cacheKey];

      if (!history.length) {
        console.log(`  ⚠️  [autoFix] ${symbol} ${cols[0]} — position history prazan, preskačem`);
        results.skipped++;
        newLines.push(line);
        continue;
      }

      // Dohvati entry cijenu iz prethodnog OPEN reda za ovaj simbol
      const entryPrice = (() => {
        for (let j = i - 1; j >= 1; j--) {
          const prev = lines[j].split(",");
          if (prev[3] === symbol && (prev[4] === "LONG" || prev[4] === "SHORT")) {
            return parseFloat(prev[6]) || 0;
          }
        }
        return 0;
      })();

      // Matching strategija (od najpouzdanije do najmanje):
      // 1. Pokušaj matching po entry cijeni (openAvgPrice) — najtočniji
      // 2. Fallback: closest po closeTime (±24h prošireno)
      let match = null;
      if (entryPrice > 0) {
        match = history
          .filter(p => p.openAvgPrice > 0 && Math.abs(p.openAvgPrice - entryPrice) / entryPrice < 0.005) // 0.5% tolerancija
          .sort((a, b) => Math.abs(a.openAvgPrice - entryPrice) - Math.abs(b.openAvgPrice - entryPrice))[0];
      }
      if (!match) {
        // Fallback: najbliži po closeTime (±24h)
        match = history
          .filter(p => Math.abs(p.closeTime - closeTs) < 24 * 60 * 60 * 1000)
          .sort((a, b) => Math.abs(a.closeTime - closeTs) - Math.abs(b.closeTime - closeTs))[0];
      }

      // Debug: ispiši što je pronađeno za prvih par pokušaja
      if (history.length) {
        const sample = history[0];
        console.log(`  🔎 [autoFix] ${symbol} ${cols[0]} entry=${entryPrice} | Bitget: openAvg=${sample.openAvgPrice} closeAvg=${sample.closeAvgPrice} achievedPnl=${sample.achievedProfits} closeTime=${new Date(sample.closeTime).toISOString()}`);
      }

      if (!match) {
        console.log(`  ⚠️  [autoFix] ${symbol} ${cols[0]} — nema matching (entry=${entryPrice}), preskačem`);
        results.skipped++;
        newLines.push(line);
        continue;
      }

      const newPnl       = match.achievedProfits;
      const newExitPrice = match.closeAvgPrice || exitPrice;

      // Ako je razlika zanemariva — nije bug
      if (Math.abs(newPnl - curPnl) < 0.05) {
        console.log(`  ✅ [autoFix] ${symbol} ${cols[0]} — P&L ok (${curPnl.toFixed(4)} ≈ ${newPnl.toFixed(4)}), preskačem`);
        results.skipped++;
        newLines.push(line);
        continue;
      }

      // Ispravi red
      cols[6] = String(newExitPrice > 0 ? newExitPrice : exitPrice);
      cols[9] = String(newPnl);
      const notesIdx = cols.length - 1;
      if (cols[notesIdx]) {
        cols[notesIdx] = cols[notesIdx]
          .replace(/^"?LOSS:/, newPnl >= 0 ? '"WIN:' : '"LOSS:')
          .replace(/^"?WIN:/,  newPnl >= 0 ? '"WIN:' : '"LOSS:')
          .replace(/Izlaz [0-9.]+/, `Izlaz ${cols[6]}`);
      }
      newLines.push(cols.join(","));
      results.fixed++;
      results.details.push({ symbol, date: cols[0], oldPnl: curPnl, newPnl, oldExit: exitPrice, newExit: parseFloat(cols[6]) });
      console.log(`  ✏️  [autoFix] ${symbol} ${cols[0]} — P&L ${curPnl.toFixed(4)} → ${newPnl.toFixed(4)} | exit ${exitPrice} → ${cols[6]}`);

    } catch (e) {
      console.error(`  ❌ [autoFix] ${symbol} ${cols[0]} greška: ${e.message}`);
      results.errors++;
      newLines.push(line);
    }
  }

  writeFileSync(f, newLines.join("\n"));
  console.log(`  🏁 [autoFix] Završeno: ${results.checked} provjereno, ${results.fixed} ispravljeno, ${results.skipped} preskočeno, ${results.errors} grešaka`);
  return results;
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

          // Ako fill fetch nije uspio — pokušaj dohvatiti live cijenu kao fallback exit
          if (!closed) {
            console.warn(`  ⚠️  [${pid}] ${pos.symbol} — fill fetch nije uspio, koristim live cijenu ili TP za procjenu`);
            // Pokušaj dohvatiti live cijenu — bolje od fiksnog SL-a
            let _fallbackExit = pos.entryPrice;
            try {
              const _liveMap = await fetchLivePrices([pos.symbol]);
              const _live = _liveMap[pos.symbol];
              if (_live) {
                // Ako je live cijena bliža TP-u nego SL-u → vjerojatno TP pogođen
                const distToSl = Math.abs(_live - pos.sl);
                const distToTp = Math.abs(_live - pos.tp);
                _fallbackExit = distToTp < distToSl ? pos.tp : _live;
              }
            } catch(_) {
              // Ne možemo dohvatiti live — koristi TP kao optimistični fallback
              // jer je pozicija već zatvorena (ne znamo kako)
              _fallbackExit = pos.tp;
            }
            const _fallbackQty  = pos.quantity ?? (pos.totalUSD / pos.entryPrice);
            const _fallbackPnl  = pos.side === "LONG"
              ? (_fallbackExit - pos.entryPrice) * _fallbackQty
              : (pos.entryPrice - _fallbackExit) * _fallbackQty;
            const _maxLoss = pos.margin ? pos.margin * 1.1 : pos.totalUSD * 0.02;
            const _pnl = Math.max(_fallbackPnl, -_maxLoss);
            // Odredi razlog iz stvarnog smjera izlaza, ne samo predznaka P&L
            const _priceDiff = pos.side === "LONG"
              ? _fallbackExit - pos.entryPrice
              : pos.entryPrice - _fallbackExit;
            const _exitReason = _priceDiff > 0 ? "TP/Trail" : "SL dostignut";
            console.log(`  ${_pnl >= 0 ? "✅" : "❌"} [${pid}] ${pos.symbol} — fallback P&L: ${_pnl.toFixed(4)} @ ${fmtPrice(_fallbackExit)} (${_exitReason})`);
            writeExitCsv(pid, pos, _fallbackExit, _exitReason + " (est.)", _pnl);
            await tg(`${_pnl >= 0 ? "✅" : "❌"} [ULTRA] ${pos.symbol} ${pos.side}\nP&L: ${_pnl >= 0?"+":""}$${_pnl.toFixed(2)} | ${_exitReason} (procjena)\nUlaz: ${fmtPrice(pos.entryPrice)} → Izlaz: ${fmtPrice(_fallbackExit)}\n⚠️ Fill podaci nisu dohvaćeni — P&L je procjena`);
            if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, _pnl >= 0);
            recordSymbolOutcome(pos.symbol, _pnl >= 0);
            if (_pnl < 0) {
              symbolSlCooldown.set(pos.symbol, Date.now());
              saveSlCooldown();
              await recordSymbolSl(pid, pos.symbol);
              await checkAndRemoveSymbol(pid, pos.symbol);
            }
            continue;
          }

          const exitPrice  = closed.exitPrice;
          const realPnl    = closed.realizedPnl;
          const fee        = closed.fee ?? 0;

          // Odredi razlog zatvaranja
          const priceDiff = pos.side === "LONG"
            ? exitPrice - pos.entryPrice
            : pos.entryPrice - exitPrice;
          const exitReason = priceDiff > 0 ? "TP/Trail dostignut" : "SL/Likvidacija";

          // Sanity cap: maksimalni gubitak = margina × 1.1
          const maxLoss = pos.margin ? pos.margin * 1.1 : pos.totalUSD * 0.02;
          const pnl = Math.max(realPnl, -maxLoss);
          if (pnl !== realPnl) {
            console.log(`  ⚠️  P&L capped: ${realPnl.toFixed(4)} → ${pnl.toFixed(4)} (maxLoss=${maxLoss.toFixed(2)})`);
          }

          console.log(`  ${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [${pid}] ${pos.symbol} ${pos.side} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} | ${exitReason} | exit@${fmtPrice(exitPrice)}`);
          writeExitCsv(pid, pos, exitPrice, exitReason, pnl);
          await tg(`${pnl >= 0 ? "✅ WIN" : "❌ LOSS"} [ULTRA] ${pos.symbol} ${pos.side}\nP&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${exitReason}\nUlaz: ${fmtPrice(pos.entryPrice)} → Izlaz: ${fmtPrice(exitPrice)}`);
          // 4. Signal analiza — bilježi outcome po signalima
          if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, pnl >= 0);
          recordSymbolOutcome(pos.symbol, pnl >= 0);

          if (pnl < 0) {
            // Cooldown 4h — ne ulazi ponovo u ovaj simbol (persistan na disku, preživi restart)
            symbolSlCooldown.set(pos.symbol, Date.now());
            saveSlCooldown();
            console.log(`  🕐 [${pid}] ${pos.symbol} — cooldown 4h aktivan (SL hit)`);
            // 2. Blacklist — 3 uzastopna SL → 24h ban
            await recordSymbolSl(pid, pos.symbol);
            await checkAndRemoveSymbol(pid, pos.symbol);
          } else {
            // WIN exit — dodaj u re-entry queue (45 min prozor za ponovni ulaz u trend)
            const prev = _winReEntry.get(pos.symbol);
            const cnt  = (prev?.count || 0) + 1;
            if (cnt <= REENTRY_MAX) {
              _winReEntry.set(pos.symbol, { side: pos.side, pid, ts: Date.now(), count: cnt });
              console.log(`  🔁 [RE-ENTRY] ${pos.symbol} WIN — re-entry enabled (${cnt}/${REENTRY_MAX}, 45min prozor)`);
            }
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

        // ── PARTIAL TP @ +1R: zatvori 50%, SL na break-even ─────────────────────
        // TraderaEdge "manualno zatvaranje u plusu" automatizirano: trade koji ode
        // +1R pa se vrati postaje mali WIN umjesto punog LOSS-a (analiza 07.07.: WR 28%,
        // prosjek WIN $0.48 vs LOSS $0.57 — dobici su bježali nenaplaćeni)
        if (isLivePortfolio && !pos.partial1R && !pos.partialClosed && !pos.trailActive && pos.sl) {
          const _gain1R = pos.side === "LONG"
            ? (liveP - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - liveP) / pos.entryPrice * 100;
          const _risk1R = parseFloat(pos.slPct) || 2.0;
          if (_gain1R >= _risk1R) {
            const _bp1R = await fetchBitgetPositionSize(pos.symbol, pos.side);
            if (_bp1R && !_bp1R.error) {
              const _minQ = _minTradeNum[pos.symbol] ?? 0;
              const _gainPerUnit = Math.abs(liveP - pos.entryPrice);
              const _totalProfit = _gainPerUnit * _bp1R.total;
              // Zatvori TOČNO onoliko da je dobit $1 (+2% buffer za fee) — može biti više ili manje od 50%
              let _closeQty = (1.02 / _gainPerUnit);
              // Bitget minimumi: količina naloga + min 5.5 USDT notional
              _closeQty = Math.max(_closeQty, _minQ, 5.5 / liveP);
              // Ostatak mora biti tradabilan — ako bi ostao dust, zatvori sve (dobit je ionako ≥ $1)
              if (_bp1R.total - _closeQty < _minQ) _closeQty = _bp1R.total;

              if (_totalProfit < 1.02) {
                // Ni cijela pozicija ne nosi $1 na +1R — bez splita, SL na BE, vozi do punog TP-a
                pos.partial1R = true;
                pos.sl = pos.side === "LONG" ? pos.entryPrice * 1.0005 : pos.entryPrice * 0.9995;
                console.log(`  💰 [1R] ${pos.symbol} — cijela pozicija nosi $${_totalProfit.toFixed(2)} < $1 → bez splita, SL na BE, vozimo do TP-a`);
              } else {
                const _r1R = await bitgetPost("/api/v2/mix/order/place-order", {
                  symbol: pos.symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
                  side: pos.side === "LONG" ? "buy" : "sell", tradeSide: "close", marginMode: "isolated",
                  holdSide: pos.side === "LONG" ? "long" : "short",
                  orderType: "market", size: _closeQty.toFixed(4),
                }).catch(() => null);
                if (_r1R?.code === "00000") {
                  const _pnl1R = _gainPerUnit * _closeQty;
                  const _pctClosed = (_closeQty / _bp1R.total * 100).toFixed(0);
                  pos.partial1R = true;
                  pos.quantity  = Math.max(_bp1R.total - _closeQty, 0);
                  pos.sl = pos.side === "LONG" ? pos.entryPrice * 1.0005 : pos.entryPrice * 0.9995;
                  writeExitCsv(pid, { ...pos, quantity: _closeQty }, liveP, `Partial TP +1R (${_pctClosed}%)`, _pnl1R);
                  console.log(`  💰 [1R] ${pos.symbol} ${pos.side} — +1R (${_gain1R.toFixed(2)}%) → ${_pctClosed}% zatvoreno (+$${_pnl1R.toFixed(2)}), SL na BE`);
                  await tg(`💰 <b>PARTIAL +1R</b> ${pos.symbol} ${pos.side}\n${_pctClosed}% zatvoreno @ ${fmtPrice(liveP)} → +$${_pnl1R.toFixed(2)} zaključano\nOstatak: SL na break-even, trail lovi trend`);
                  if (pos.quantity <= 0) { stillOpen.push({ ...pos, _remove: true }); continue; }
                }
              }
            }
          }
        }

        // ── STOCK FLAT — ISKLJUČEN na zahtjev (09.07.): dionice smiju prenoćiti.
        // Čuva ih exchange SL/TP; napomena: overnight/earnings gap može preskočiti SL.
        const _stockFlat = false;

        // ── TIME-STOP (20.07.): 12h bez +0.5R → zatvori (chop bleed) ──────────
        // Analiza 3 tjedna: medijan gubitnika visi 13.6h prije SL-a. TraderaEdge za
        // zonske trgovine: "ostanite kraći vremenski period". Dionice: samo u sesiji.
        let _timeStop = false;
        if (!pos.partial1R && !pos.trailActive && !pos.partialClosed && pos.timestamp) {
          const _ageH = (Date.now() - new Date(pos.timestamp).getTime()) / 3600000;
          const _gainTS = pos.side === "LONG"
            ? (liveP - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - liveP) / pos.entryPrice * 100;
          const _halfR = (parseFloat(pos.slPct) || 2.0) * 0.5;
          if (_ageH > 12 && _gainTS < _halfR) {
            const _nowTS = new Date();
            const _hTS = _nowTS.getUTCHours(), _mTS = _nowTS.getUTCMinutes(), _dTS = _nowTS.getUTCDay();
            const _stkOk = !isStockSym(pos.symbol) ||
              (_dTS >= 1 && _dTS <= 5 && (_hTS > 13 || (_hTS === 13 && _mTS >= 35)) && _hTS < 20);
            if (_stkOk) _timeStop = true;
          }
        }

        // ── SOFT SL: bot zatvara na pravom SL (ghost stop bypass) ──────────────
        // pos.sl = pravi SL koji bot prati — BitGet ghost SL je 0.5% dalje (decoy)
        // Samo dok trail NIJE aktivan (trail sam pomiče SL pa nema potrebe za soft check)
        if (isLivePortfolio && pos.sl && (_stockFlat || _timeStop || (!pos.trailActive && !pos.partialClosed))) {
          const softSlHit = _stockFlat || _timeStop || (pos.side === "LONG" ? liveP <= pos.sl : liveP >= pos.sl);
          if (softSlHit) {
            console.log(_timeStop
              ? `  ⏱️  [TIME-STOP] ${pos.symbol} ${pos.side} — 12h+ bez +0.5R → tržišni izlaz @ ${fmtPrice(liveP)} (chop bleed)`
              : _stockFlat
              ? `  🏦 [STOCK FLAT] ${pos.symbol} ${pos.side} — US market close/zatvoreno → tržišni izlaz @ ${fmtPrice(liveP)} (gap zaštita)`
              : `  🛑 [SOFT SL] ${pos.symbol} ${pos.side} — cijena ${fmtPrice(liveP)} ≤ SL ${fmtPrice(pos.sl)} → tržišni izlaz`);
            // Provjeri pravu veličinu na Bitgetu
            const bitPos2 = await fetchBitgetPositionSize(pos.symbol, pos.side);
            if (bitPos2?.error) {
              console.log(`  ⚠️  [SOFT SL] ${pos.symbol} — API greška pri provjeri, pozicija OSTAJE praćena (retry sljedeći ciklus)`);
              stillOpen.push(pos);
              continue;
            }
            if (!bitPos2) {
              console.log(`  ⚠️  [SOFT SL] ${pos.symbol} ne postoji na Bitgetu — uklanjam tracking`);
              stillOpen.push({ ...pos, _remove: true });
              continue;
            }
            const closeQty  = (bitPos2.total > 0 ? bitPos2.total : bitPos2.available).toFixed(4);
            const closeSide = pos.side === "LONG" ? "buy" : "sell";  // Bitget v2 hedge: close nosi side ISTOG smjera kao pozicija
            // Otkaži plan naloge PRIJE close-a (ne nakon 22002) — sprječava blokadu
            await cancelAllPlanOrders(pos.symbol, pos.side).catch(() => {});
            let softClosed  = false;
            for (let attempt = 1; attempt <= 3 && !softClosed; attempt++) {
              try {
                const closeR = await bitgetPost("/api/v2/mix/order/place-order", {
                  symbol: pos.symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
                  side: closeSide, tradeSide: "close", marginMode: "isolated",
                  holdSide: pos.side === "LONG" ? "long" : "short",
                  orderType: "market", size: closeQty,
                });
                if (closeR.code === "22002") {
                  // Pozicija već ne postoji ili je blokirana pending nalogom
                  console.log(`  ⚠️  [SOFT SL] ${pos.symbol} — 22002 No position, pokušavam otkazati plan naloge...`);
                  const cancelled = await cancelAllPlanOrders(pos.symbol, pos.side);
                  console.log(`  🗑️  [SOFT SL] Otkazano ${cancelled} plan naloga za ${pos.symbol}`);
                  // Provjeri da li pozicija uopće postoji nakon otkazivanja
                  const recheck = await fetchBitgetPositionSize(pos.symbol, pos.side);
                  if (!recheck && !recheck?.error) {
                    console.log(`  ℹ️  [SOFT SL] ${pos.symbol} — pozicija ne postoji na Bitgetu (već zatvorena) → uklanjam tracking`);
                    stillOpen.push({ ...pos, _remove: true });
                    softClosed = true; // izlaz iz retry petlje
                    break;
                  }
                  if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
                  continue;
                }
                if (closeR.code !== "00000") throw new Error(`Bitget: ${closeR.code} ${closeR.msg}`);
                softClosed = true;
              } catch (e) {
                console.log(`  ❌ [SOFT SL] ${pos.symbol} pokušaj ${attempt}/3: ${e.message}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
              }
            }
            if (!softClosed) {
              console.log(`  🚨 [SOFT SL] ${pos.symbol} — svi pokušaji neuspješni, pozicija OSTAJE u trackingu`);
              // TG alert max 1× po satu po poziciji — bez spama
              if (!pos._closeFailAlertTs || Date.now() - pos._closeFailAlertTs > 60 * 60 * 1000) {
                pos._closeFailAlertTs = Date.now();
                await tg(`🚨 <b>SOFT SL FAIL</b> ${pos.symbol} ${pos.side}\nNije moguće zatvoriti! Provjeri Bitget ručno.\n(pozicija ostaje praćena, retry sljedeći ciklus)`);
              }
              stillOpen.push(pos);  // NE gubi tracking — pozicija je i dalje živa na Bitgetu
              continue;
            }
            // Ako je pozicija bila externally closed (22002 + ne postoji) — samo ukloni tracking bez CSV
            if (pos._remove) { continue; }
            const softQtyN = parseFloat(closeQty);
            const pnl = pos.side === "LONG"
              ? (liveP - pos.entryPrice) * softQtyN
              : (pos.entryPrice - liveP) * softQtyN;
            writeExitCsv(pid, pos, liveP, _timeStop ? "Time-stop 12h" : "Soft SL — bot izlaz", pnl);
            await tg(`🛑 [SOFT SL] ${pos.symbol} ${pos.side}\nBot zatvorio na SL ${fmtPrice(pos.sl)}\nEgzekucija: ${fmtPrice(liveP)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
            symbolSlCooldown.set(pos.symbol, Date.now());
            saveSlCooldown();
            await recordSymbolSl(pid, pos.symbol);
            await checkAndRemoveSymbol(pid, pos.symbol);
            if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, false);
            recordSymbolOutcome(pos.symbol, false);
            continue;
          }
        }

        // ── TP HIT: zatvori 50% na TP razini, aktiviraj trail za ostatak 50% ──
        // Pali se kad cijena dosegne TP (100% TP puta). Otkazuje Bitget plan naloge
        // da track_stop ne zatvori cijelu poziciju, pa trail preuzima ostatak.
        if (!pos.partialClosed && !pos.trailActive && isLivePortfolio) {
          const _tpPctP    = pos.tpPct ?? 4.0;
          const _pricePctP = pos.side === "LONG"
            ? (liveP - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - liveP) / pos.entryPrice * 100;
          const _tpProgressP = _pricePctP / _tpPctP * 100;
          if (_tpProgressP >= PARTIAL_TP_TRIGGER) {
            console.log(`  🎯 [TP HIT] ${pos.symbol} ${pos.side} — TP dostignut @ ${fmtPrice(liveP)} (+${_pricePctP.toFixed(1)}%) → zatvaramo ${PARTIAL_CLOSE_PCT}%, ostatak na trail SL`);
            const _pClosed = await partialClosePosition(pos);
            if (_pClosed) {
              // Otkaži sve Bitget plan naloge (track_stop bi inače zatvorio puni qty)
              await cancelAllPlanOrders(pos.symbol, pos.side);
              // Aktiviraj trail odmah — peak počinje od TP razine
              pos.partialClosed = true;
              pos.trailActive   = true;
              pos.trailPeak     = liveP;
              const _newQty = (pos.quantity ?? (pos.totalUSD / pos.entryPrice)) * (1 - PARTIAL_CLOSE_PCT / 100);
              const _allPos = loadPositions(pid);
              const _pIdx   = _allPos.findIndex(p => p.symbol === pos.symbol && p.side === pos.side);
              if (_pIdx >= 0) {
                _allPos[_pIdx].partialClosed = true;
                _allPos[_pIdx].trailActive   = true;
                _allPos[_pIdx].trailPeak     = liveP;
                _allPos[_pIdx].quantity      = _newQty;
                savePositions(pid, _allPos);
              }
              // Postavi Ghost SL na Bitgetu za preostalu 50% poziciju
              await updateTrailSL(pos, pos.sl);
              await tg(`✅ <b>TP HIT [ULTRA]</b> ${pos.symbol} ${pos.side}\n+${_pricePctP.toFixed(1)}% @ ${fmtPrice(liveP)}\n\n💰 50% pozicije ZATVORENO — profit zaključan\n📈 50% ostaje — trail SL ${TRAIL_SL_PCT}% ispod vrha\nTrail peak start: ${fmtPrice(liveP)}`);
            }
          }
        }

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

        // ── TRAILING STOP: prati peak i pomiče SL — aktivira se tek nakon TP HIT ──
        // Aktivacija se radi u TP HIT bloku iznad (partialClosed=true, trailActive=true).
        // Ovdje samo pratimo peak i ažuriramo SL na Bitgetu.
        if (isLivePortfolio && pos.trailActive && pos.partialClosed) {
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
  const entryMode = entry.entryMode || "PBK";
  const sigCount  = entry.sigMask != null
    ? entry.sigMask.toString(2).split("").filter(b => b === "1").length
    : "?";

  const row = [
    date, time, "BitGet", entry.symbol, entry.signal,
    qty, fmtPrice(entry.price), entry.tradeSize.toFixed(2),
    fee, "OPEN",
    fmtPrice(entry.sl), fmtPrice(entry.tp),
    entry.orderId || "", mode, pid,
    `"${entry.strategy} | ${entryMode} | Sig ${sigCount}/13 | SL ${entry.slPct??SL_PCT}% TP ${entry.tpPct??TP_PCT}%"`,
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
  const icon    = pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "CLOSED";

  const row = [
    date, time, "BitGet", pos.symbol,
    exitSide,
    pos.quantity.toFixed(6),
    fmtPrice(exitPrice),
    pos.totalUSD.toFixed(2),
    feeTotal, netPnl,
    fmtPrice(pos.sl), fmtPrice(pos.tp),
    pos.orderId || "", pos.mode, pid,
    `"${icon}: ${reason} | ${pos.entryMode || "PBK"} | Ulaz ${fmtPrice(pos.entryPrice)} → Izlaz ${fmtPrice(exitPrice)}"`,
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
const BE_TRIGGER_PCT = 40;   // % TP-a koji mora biti dostignut
const BE_BUFFER_PCT  = 0.2;  // % iznad/ispod entry za SL (pokrije fees)

async function moveSLtoBreakEven(pos) {
  if (pos.beMoved) return false;
  if (PAPER_TRADING) return false;

  const { symbol, side, entryPrice } = pos;
  // Novi SL: entry + buffer (LONG: dobitak pri povratku, SHORT: minimalni gubitak)
  const newSlPrice = entryPrice * (1 + BE_BUFFER_PCT / 100);

  // Soft SL — samo ažuriraj lokalno, nema Bitget nalog
  console.log(`  🔒 [BE-STOP] ${symbol} ${side} — soft SL pomaknut na ${fmtPrice(newSlPrice, symbol)} (+${BE_BUFFER_PCT}% od entry ${fmtPrice(entryPrice)})`);
  await tg(`🔒 <b>BE-STOP [ULTRA]</b> ${symbol} ${side}\nSoft SL pomaknut na entry+${BE_BUFFER_PCT}%: ${fmtPrice(newSlPrice, symbol)}\nProfit zagarantiran pri povratku na entry.`);

  // Ažuriraj pos.sl u JSON-u
  for (const pid of PORTFOLIO_IDS) {
    const allPos = loadPositions(pid);
    const idx = allPos.findIndex(p => p.symbol === symbol && p.side === side);
    if (idx >= 0) {
      allPos[idx].sl     = newSlPrice;
      allPos[idx].beMoved = true;
      savePositions(pid, allPos);
      return true;
    }
  }
  return true;
}

// ─── 6. Partial TP — zatvori 50% pozicije kad je 50% TP puta dostignut ──────────
async function partialClosePosition(pos, closePct = PARTIAL_CLOSE_PCT) {
  if (PAPER_TRADING) return false;
  if (pos.partialClosed) return false;
  const qty       = (pos.quantity ?? (pos.totalUSD / pos.entryPrice)) * (closePct / 100);
  const closeSide = pos.side === "LONG" ? "buy" : "sell";  // Bitget v2 hedge: close nosi side ISTOG smjera kao pozicija
  try {
    const res = await bitgetPost("/api/v2/mix/order/place-order", {
      symbol: pos.symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
      side: closeSide, tradeSide: "close", marginMode: "isolated",
      holdSide: pos.side === "LONG" ? "long" : "short",
      orderType: "market",
      size: parseFloat(qty.toFixed(4)).toString(),
    });
    if (res.code === "00000") {
      console.log(`  📦 [PARTIAL-TP] ${pos.symbol} ${pos.side} — zatvoreno ${closePct}% (qty: ${qty.toFixed(4)}) | ostatak čeka TP`);
      await tg(`📦 <b>PARTIAL-TP [ULTRA]</b> ${pos.symbol} ${pos.side}\nZatvoreno ${closePct}% pozicije (${qty.toFixed(4)} jed)\nOstatak čeka puni TP.`);
      return true;
    }
    console.log(`  ⚠️  [PARTIAL-TP] ${pos.symbol} fail: ${res.code} ${res.msg}`);
    return false;
  } catch(e) {
    console.log(`  ⚠️  [PARTIAL-TP] ${pos.symbol} greška: ${e.message}`);
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

// ─── Soft Exit Monitor — pozivati svakih 15s iz dashboard.js ─────────────────
// Prati live cijenu za sve otvorene pozicije i zatvara tržišnim nalogom
// kad cijena dostigne soft SL ili soft TP. Nema Bitget SL/TP ordere.
export async function softExitMonitor() {
  if (PAPER_TRADING) return;
  for (const pid of PORTFOLIO_IDS) {
    try {
      const pDef = buildPortfolios(JSON.parse(readFileSync("rules.json", "utf8")))[pid];
      if (!pDef?.live) continue;

      const positions = loadPositions(pid);
      if (!positions.length) continue;

      const symbols = [...new Set(positions.map(p => p.symbol))];
      const prices  = await fetchLivePrices(symbols);

      for (const pos of positions) {
        const liveP = prices[pos.symbol];
        if (!liveP || !pos.sl || !pos.tp) continue;

        // Trail SL/TP — pomakni razine ako je cijena dovoljno u profitu
        const trailMoved = applyTrail(pos, liveP);
        if (trailMoved) {
          savePositions(pid, loadPositions(pid).map(p =>
            (p.symbol === pos.symbol && p.side === pos.side) ? pos : p
          ));
          console.log(`  🔁 [TRAIL] ${pos.symbol} ${pos.side} — SL→${fmtPrice(pos.sl)} TP→${fmtPrice(pos.tp)}`);
        }

        // Emergency close — ako gubitak > 85% margine (pre-likvidacija)
        // Bez ovoga bot može propustiti SL i pozicija ide u likvidaciju (burst_loss)
        const _unrealPnl = pos.side === "LONG"
          ? (liveP - pos.entryPrice) * (pos.quantity ?? 1)
          : (pos.entryPrice - liveP) * (pos.quantity ?? 1);
        const _margin = pos.margin ?? (pos.totalUSD / (pos.leverage ?? 25));
        const _lossRatio = _margin > 0 ? -_unrealPnl / _margin : 0;
        if (_lossRatio > 0.85 && _unrealPnl < 0) {
          console.log(`  🚨 [EMRG] ${pos.symbol} ${pos.side} — gubitak ${(_lossRatio*100).toFixed(0)}% margine, zatvaramo ODMAH (pre-likvidacija)`);
          await tg(`🚨 <b>EMERGENCY CLOSE [ULTRA]</b> ${pos.symbol} ${pos.side}\nGubitak ${(_lossRatio*100).toFixed(0)}% margine — zatvaramo prije likvidacije!\nCijena: ${fmtPrice(liveP)} | Entry: ${fmtPrice(pos.entryPrice)} | P&L: $${_unrealPnl.toFixed(2)}`);
          const bitPos = await fetchBitgetPositionSize(pos.symbol, pos.side);
          if (bitPos && !bitPos.error) {
            const qty = (bitPos.total > 0 ? bitPos.total : bitPos.available).toFixed(4);
            const closeSide = pos.side === "LONG" ? "buy" : "sell";  // Bitget v2 hedge: close nosi side ISTOG smjera kao pozicija
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const r = await bitgetPost("/api/v2/mix/order/place-order", {
                  symbol: pos.symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
                  side: closeSide, tradeSide: "close", marginMode: "isolated",
                  holdSide: pos.side === "LONG" ? "long" : "short",
                  orderType: "market", size: qty,
                });
                if (r.code !== "00000") throw new Error(`${r.code} ${r.msg}`);
                break;
              } catch(e) {
                if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
              }
            }
          }
          const allPos = loadPositions(pid);
          savePositions(pid, allPos.filter(p => !(p.symbol === pos.symbol && p.side === pos.side)));
          writeExitCsv(pid, pos, liveP, "Emergency close (pre-likvidacija)", _unrealPnl);
          if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, false);
          recordSymbolOutcome(pos.symbol, false);
          continue;
        }

        const slHit = pos.side === "LONG" ? liveP <= pos.sl : liveP >= pos.sl;
        const tpHit = pos.side === "LONG" ? liveP >= pos.tp : liveP <= pos.tp;

        if (!slHit && !tpHit) continue;

        const reason = slHit ? "SL" : "TP";
        const level  = slHit ? pos.sl : pos.tp;
        console.log(`  ${slHit ? "🛑" : "🎯"} [SOFT ${reason}] ${pos.symbol} ${pos.side} — cijena ${fmtPrice(liveP)} ${slHit ? "≤" : "≥"} ${reason} ${fmtPrice(level)} → zatvaramo`);

        // Dohvati pravu veličinu s Bitgeta — lokalna qty može biti pogrešna
        const bitPos = await fetchBitgetPositionSize(pos.symbol, pos.side);
        if (bitPos?.error) {
          console.log(`  ⚠️  [SOFT ${reason}] ${pos.symbol} — API greška pri provjeri, pozicija OSTAJE praćena`);
          continue;
        }
        if (!bitPos) {
          // Pozicija zatvorena izvana (ručno / drugi bot) — dohvati pravi P&L i zapiši u CSV
          console.log(`  ⚠️  [SOFT ${reason}] ${pos.symbol} — pozicija ne postoji na Bitgetu, dohvaćam P&L i zatvaramo tracking`);
          const closed = await fetchBitgetClosedPnl(pos.symbol, pos).catch(() => null);
          if (closed) {
            const priceDiff = pos.side === "LONG" ? closed.exitPrice - pos.entryPrice : pos.entryPrice - closed.exitPrice;
            const exitReason = priceDiff > 0 ? "TP/Ručno" : "SL/Ručno";
            writeExitCsv(pid, pos, closed.exitPrice, exitReason, closed.realizedPnl);
            await tg(`${closed.realizedPnl >= 0 ? "✅" : "❌"} [ULTRA] ${pos.symbol} ${pos.side} zatvoreno izvana\nP&L: ${closed.realizedPnl >= 0?"+":""}$${closed.realizedPnl.toFixed(2)} | ${exitReason}\nUlaz: ${fmtPrice(pos.entryPrice)} → Izlaz: ${fmtPrice(closed.exitPrice)}`);
            if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, closed.realizedPnl >= 0);
            recordSymbolOutcome(pos.symbol, closed.realizedPnl >= 0);
          } else {
            // Fallback — procijeni iz live cijene
            const _liveMap = await fetchLivePrices([pos.symbol]).catch(() => ({}));
            const _live = _liveMap[pos.symbol] || pos.tp;
            const _pnl = pos.side === "LONG" ? (_live - pos.entryPrice) * (pos.quantity ?? 1) : (pos.entryPrice - _live) * (pos.quantity ?? 1);
            writeExitCsv(pid, pos, _live, "Zatvoreno izvana (est.)", _pnl);
            await tg(`⚠️ [ULTRA] ${pos.symbol} ${pos.side} zatvoreno izvana\nP&L procjena: ${_pnl>=0?"+":""}$${_pnl.toFixed(2)}\nUlaz: ${fmtPrice(pos.entryPrice)} → Live: ${fmtPrice(_live)}`);
          }
          const allPos = loadPositions(pid);
          savePositions(pid, allPos.filter(p => !(p.symbol === pos.symbol && p.side === pos.side)));
          continue;
        }
        // Koristi total (ne available) — available može biti 0 ako postoji pending order
        const qty      = (bitPos.total > 0 ? bitPos.total : bitPos.available).toFixed(4);
        const closeSide = pos.side === "LONG" ? "buy" : "sell";  // Bitget v2 hedge: close nosi side ISTOG smjera kao pozicija
        console.log(`  📐 [SOFT ${reason}] ${pos.symbol} — Bitget veličina: ${qty} (lokalna: ${(pos.quantity ?? "?").toString()})`);

        // Otkaži plan naloge PRIJE close-a — sprječava 22002 blokadu
        await cancelAllPlanOrders(pos.symbol, pos.side).catch(() => {});
        // 3 pokušaja s 2s pauzom između
        let closed = false;
        let _extClosed = false; // true ako je 22002 + pozicija ne postoji
        for (let attempt = 1; attempt <= 3 && !closed; attempt++) {
          try {
            const closeRes = await bitgetPost("/api/v2/mix/order/place-order", {
              symbol: pos.symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
              side: closeSide, tradeSide: "close", marginMode: "isolated",
              holdSide: pos.side === "LONG" ? "long" : "short",
              orderType: "market", size: qty,
            });
            if (closeRes.code === "22002") {
              // Pending nalog blokira ili pozicija ne postoji — otkaži plan naloge pa retry
              console.log(`  ⚠️  [SOFT ${reason}] ${pos.symbol} — 22002, otkazujem plan naloge...`);
              const cancelled = await cancelAllPlanOrders(pos.symbol, pos.side);
              console.log(`  🗑️  [SOFT ${reason}] Otkazano ${cancelled} plan naloga`);
              const recheck = await fetchBitgetPositionSize(pos.symbol, pos.side);
              if (!recheck && !recheck?.error) {
                console.log(`  ℹ️  [SOFT ${reason}] ${pos.symbol} — pozicija zatvorena izvana → dohvaćam P&L`);
                _extClosed = true;
                break;
              }
              if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
              continue;
            }
            if (closeRes.code !== "00000") throw new Error(`${closeRes.code} ${closeRes.msg}`);
            closed = true;
          } catch (e) {
            console.log(`  ❌ [SOFT ${reason}] ${pos.symbol} pokušaj ${attempt}/3: ${e.message} | qty=${qty}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          }
        }

        // Pozicija zatvorena od strane Bitgeta (22002 + ne postoji) — dohvati P&L i ukloni
        if (_extClosed) {
          const closedExt = await fetchBitgetClosedPnl(pos.symbol, pos).catch(() => null);
          if (closedExt) {
            writeExitCsv(pid, pos, closedExt.exitPrice, "Zatvoreno izvana", closedExt.realizedPnl);
            await tg(`${closedExt.realizedPnl >= 0 ? "✅" : "❌"} [ULTRA] ${pos.symbol} ${pos.side} zatvoreno izvana\nP&L: ${closedExt.realizedPnl >= 0?"+":""}$${closedExt.realizedPnl.toFixed(2)}\nUlaz: ${fmtPrice(pos.entryPrice)} → Izlaz: ${fmtPrice(closedExt.exitPrice)}`);
            if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, closedExt.realizedPnl >= 0);
            recordSymbolOutcome(pos.symbol, closedExt.realizedPnl >= 0);
          } else {
            const _pnl = pos.side === "LONG" ? (liveP - pos.entryPrice) * (pos.quantity ?? 1) : (pos.entryPrice - liveP) * (pos.quantity ?? 1);
            writeExitCsv(pid, pos, liveP, "Zatvoreno izvana (est.)", _pnl);
            await tg(`⚠️ [ULTRA] ${pos.symbol} ${pos.side} zatvoreno izvana\nP&L procjena: ${_pnl>=0?"+":""}$${_pnl.toFixed(2)}`);
          }
          const allPos2 = loadPositions(pid);
          savePositions(pid, allPos2.filter(p => !(p.symbol === pos.symbol && p.side === pos.side)));
          continue;
        }

        if (!closed) {
          console.log(`  🚨 [SOFT ${reason}] ${pos.symbol} — svi pokušaji neuspješni, pozicija ostaje otvorena`);
          // TG max 1× po satu po poziciji (modul-level mapa — pozicije se učitavaju s diska svaki ciklus)
          const _failKey = `${pos.symbol}:${pos.side}`;
          if (!_softFailAlertTs.has(_failKey) || Date.now() - _softFailAlertTs.get(_failKey) > 60 * 60 * 1000) {
            _softFailAlertTs.set(_failKey, Date.now());
            await tg(`🚨 <b>SOFT ${reason} FAIL</b> ${pos.symbol} ${pos.side}\nNije moguće zatvoriti! Provjeri Bitget ručno.\nCijena: ${fmtPrice(liveP)} | ${reason}: ${fmtPrice(level)} | qty: ${qty}\n(retry se nastavlja automatski)`);
          }
          continue;
        }

        const pnl = pos.side === "LONG"
          ? (liveP - pos.entryPrice) * parseFloat(qty)
          : (pos.entryPrice - liveP) * parseFloat(qty);

        // Ukloni poziciju iz trackinga i zapisuj u CSV
        const allPos = loadPositions(pid);
        savePositions(pid, allPos.filter(p => !(p.symbol === pos.symbol && p.side === pos.side)));
        const exitLabel = slHit ? "Soft SL — bot izlaz" : "Soft TP — bot izlaz";
        writeExitCsv(pid, pos, liveP, exitLabel, pnl);

        if (slHit) {
          await tg(`🛑 <b>SOFT SL [ULTRA]</b> ${pos.symbol} ${pos.side}\nCijena: ${fmtPrice(liveP)} | SL: ${fmtPrice(pos.sl)}\nP&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
          symbolSlCooldown.set(pos.symbol, Date.now());
          saveSlCooldown();
          await recordSymbolSl(pid, pos.symbol);
          await checkAndRemoveSymbol(pid, pos.symbol);
          if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, false);
          recordSymbolOutcome(pos.symbol, false);
        } else {
          await tg(`🎯 <b>SOFT TP [ULTRA]</b> ${pos.symbol} ${pos.side}\nCijena: ${fmtPrice(liveP)} | TP: ${fmtPrice(pos.tp)}\nP&L: +$${pnl.toFixed(2)}`);
          if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, true);
          recordSymbolOutcome(pos.symbol, true);
        }
      }
    } catch (e) {
      console.log(`  ⚠️  [softExitMonitor] ${pid} greška: ${e.message}`);
    }
  }
}

// ─── Izračunaj siguran leverage na osnovu SL% ─────────────────────────────────
// Formula: liq_distance = 1/leverage - maintenance_margin
// Osiguravamo da liq_distance > SL + buffer
//   Tier1 SL=1.5% → 40x (liq 2.00%)  ✅
//   Tier2 SL=2.0% → 35x (liq 2.36%)  ✅
//   Tier3 SL=2.5% → 30x (liq 2.83%)  ✅
//   BTC   SL=1.5% → 40x (liq 2.00%)  ✅ (BTC_LEVERAGE 75x je PREVIŠE za 1.5% SL)
function getSafeLeverage(slPct) {
  // Redoslijed okidanja MORA biti: soft SL (slPct) → ghost SL (slPct+0.5%) → liq
  // 05.07.2026: buffer 0.4% bio pretanak — liq je padala NA/PRIJE ghost SL-a
  // (fees + funding + spread jedu marginu) → 6 likvidacija preko noći.
  // Buffer: liq minimalno SL + 1.2% (ghost +0.5% ostaje sigurno unutra).
  // 22.07.2026: dinamički cap (TraderaEdge model) — visok leverage SAMO uz uzak stop:
  //   SL ≤ 1% (SWEEP/zone ulazi) → do 50x | SL > 1% → do 30x
  //   Rizik u dolarima identičan (risk-based sizing) — samo manja zaključana margina.
  const SAFETY = 0.012;  // 1.2% = ghost offset 0.5% + maintenance ~0.4% + fees/spread rezerva
  const maxLev = 1 / (slPct / 100 + SAFETY);
  const cap = slPct <= 1.0 ? 50 : 30;
  return Math.max(5, Math.min(cap, Math.floor(maxLev)));
  // Provjera: SL0.7%→50x(liq@1.9%) SL1%→45x(liq@2.2%) SL2%→30x(cap) SL2.5%→27x(liq@3.7%)
}

async function setupSymbol(symbol, slPct, preferredLeverage = null) {
  // 1) Isolated margin mode
  const mm = await bitgetPost("/api/v2/mix/account/set-margin-mode", {
    symbol, productType: "USDT-FUTURES", marginCoin: "USDT", marginMode: "isolated",
  });
  if (mm.code !== "00000") console.log(`  ⚠️  marginMode ${symbol}: ${mm.msg}`);

  // 2) Tier-based leverage — sprječava likvidaciju PRIJE SL-a
  //    Prioritet: preferredLeverage (iz symbol_sltp.leverage) > getSafeLeverage(slPct) > globalni
  let targetLev;
  if (preferredLeverage != null) {
    // Direktno iz rules.json — već je izračunat za tier
    targetLev = preferredLeverage;
    const liqDist = ((1 / targetLev - 0.005) * 100).toFixed(2);
    console.log(`  🛡️  ${symbol} Tier leverage ${targetLev}x (liq @ ~${liqDist}%)`);
  } else if (slPct != null) {
    targetLev = getSafeLeverage(slPct);
    const liqDist = ((1 / targetLev - 0.005) * 100).toFixed(2);
    console.log(`  🛡️  ${symbol} SL=${slPct}% → siguran leverage ${targetLev}x (liq @ ~${liqDist}% > SL)`);
  } else {
    targetLev = symbol === "BTCUSDT" ? BTC_LEVERAGE : LEVERAGE;
    const liqDist = ((1 / targetLev - 0.005) * 100).toFixed(2);
    if (liqDist < 2.0) {
      console.log(`  ⚠️  ${symbol}: leverage ${targetLev}x → liq @ ~${liqDist}% — pazi, blizu liq!`);
    }
  }

  // Generiraj listu fallback leveragea u silaznom redoslijedu (uvijek niži, nikad viši)
  const levFallbacks = [targetLev];
  for (const f of [50, 45, 40, 35, 30, 25, 20, 15, 10]) {
    if (f < targetLev) levFallbacks.push(f);
  }

  let actualLeverage = targetLev;
  for (const holdSide of ["long", "short"]) {
    let set = false;
    for (const lev of levFallbacks) {
      const lv = await bitgetPost("/api/v2/mix/account/set-leverage", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        leverage: String(lev), holdSide,
      });
      if (lv.code === "00000") {
        if (lev !== targetLev) {
          console.log(`  ℹ️  ${symbol} ${holdSide}: max leverage je ${lev}x (ne ${targetLev}x) — sizing prilagođen`);
          if (holdSide === "long") actualLeverage = lev;
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
  const closeSide = side === "LONG" ? "buy" : "sell";  // Bitget v2 hedge: close nosi side ISTOG smjera kao pozicija
  try {
    // Otkaži sve otvorene SL/TP naloge za ovaj simbol
    await bitgetPost("/api/v2/mix/order/cancel-plan-order", {
      symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
      planType: "profit_loss",
    }).catch(() => {});

    // Market close nalog
    const r = await bitgetPost("/api/v2/mix/order/place-order", {
      symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
      side: closeSide, tradeSide: "close", marginMode: "isolated",
      holdSide: side === "LONG" ? "long" : "short",
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

async function placeBitGetOrder(symbol, side, sizeUSD, price, sl, tp, slPct, tpPct, preferredLeverage = null) {
  // Postavi isolated margin + tier-based leverage prije svakog naloga
  // preferredLeverage (iz symbol_sltp.leverage) ima prioritet nad getSafeLeverage
  const actualLeverage = await setupSymbol(symbol, slPct, preferredLeverage);
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

  // Dohvati pravu fill količinu iz order detalja (baseVolume)
  let fillQty = parseFloat(quantity);
  if (orderId) {
    try {
      const detailPath2 = `/api/v2/mix/order/detail?symbol=${symbol}&productType=USDT-FUTURES&orderId=${orderId}`;
      const ts3   = Date.now().toString();
      const sign3 = signBitGet(ts3, "GET", detailPath2);
      const det2  = await fetch(`${BITGET.baseUrl}${detailPath2}`, {
        headers: {
          "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign3,
          "ACCESS-TIMESTAMP": ts3, "ACCESS-PASSPHRASE": BITGET.passphrase,
          "Content-Type": "application/json",
        },
      }).then(r => r.json());
      if (det2.code === "00000" && det2.data?.baseVolume) {
        fillQty = parseFloat(det2.data.baseVolume);
        console.log(`  📐 Fill količina: ${fillQty} (procjena: ${quantity})`);
      }
    } catch (_) {}
  }

  // Soft SL/TP — NE postavljamo ordere na Bitgetu (MM ne vidi razine)
  // Bot prati cijenu svakih 15s i zatvara tržišnim nalogom kad SL/TP bude dostignut.
  // SL i TP razine čuvamo u pos.sl / pos.tp za softExitMonitor.
  console.log(`  🛡️  Soft SL @ ${fmtPrice(slFromFill, symbol)} | Soft TP @ ${fmtPrice(tpFromFill, symbol)} (praćeno lokalno, nije na Bitgetu)`);

  return { orderId, fillPrice, fillQty, actualLeverage, slFromFill, tpFromFill };
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

  // Pokušaj 2: fallback — place-order s pravom veličinom s Bitgeta
  const bitPosData = await fetchBitgetPositionSize(pos.symbol, pos.side);
  const quantity   = (bitPosData && !bitPosData.error)
    ? bitPosData.available.toFixed(4)
    : (pos.quantity ?? (pos.totalUSD / pos.entryPrice)).toFixed(4);
  const closeSide = pos.side === "LONG" ? "buy" : "sell";  // Bitget v2 hedge: close nosi side ISTOG smjera kao pozicija
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
  // Soft trail SL — samo ažuriraj lokalno u JSON-u, nema Bitget nalog
  for (const pid of PORTFOLIO_IDS) {
    const allPos = loadPositions(pid);
    const idx = allPos.findIndex(p => p.symbol === symbol && p.side === side);
    if (idx >= 0) {
      allPos[idx].sl = newSlPrice;
      savePositions(pid, allPos);
      return true;
    }
  }
  return true;
}

// ─── Cancel TP nalog na BitGetu (koristi se kad trail preuzima izlaz) ─────────
async function cancelTpOrder(pos) {
  if (PAPER_TRADING) return false;
  const { symbol, side } = pos;
  const holdSide = side === "LONG" ? "long" : "short";
  try {
    const ts   = Date.now().toString();
    const path = `/api/v2/mix/order/orders-plan-pending?symbol=${symbol}&productType=USDT-FUTURES&planType=pos_profit`;
    const sign = signBitGet(ts, "GET", path);
    const r    = await fetch(`${BITGET.baseUrl}${path}`, {
      headers: { "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET.passphrase, "Content-Type": "application/json" },
    });
    const d = await r.json();
    const orders = (d.data?.entrustedList || []).filter(o => o.holdSide === holdSide);
    if (orders.length > 0) {
      await bitgetPost("/api/v2/mix/order/cancel-plan-order", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        orderId: orders[0].orderId,
      });
      console.log(`  🚫 [TRAIL] TP nalog otkazan za ${symbol} — trail SL sada jedini izlaz`);
      return true;
    }
    return false;  // nema aktivnog TP naloga
  } catch (e) {
    console.log(`  ⚠️  [TRAIL] cancelTpOrder failed ${symbol}: ${e.message}`);
    return false;
  }
}

// ─── Pyramid: otkaži SVE plan naloge za simbol/smjer (SL + TP + trail) ───────────
async function cancelAllPlanOrders(symbol, side) {
  const holdSide = side === "LONG" ? "long" : "short";
  const planTypes = ["pos_loss", "pos_profit", "track_stop"];
  let cancelled = 0;
  for (const planType of planTypes) {
    try {
      const ts   = Date.now().toString();
      const path = `/api/v2/mix/order/orders-plan-pending?symbol=${symbol}&productType=USDT-FUTURES&planType=${planType}`;
      const sign = signBitGet(ts, "GET", path);
      const r    = await fetch(`${BITGET.baseUrl}${path}`, {
        headers: { "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": sign,
          "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": BITGET.passphrase, "Content-Type": "application/json" },
      });
      const d = await r.json();
      const orders = (d.data?.entrustedList || []).filter(o => o.holdSide === holdSide);
      for (const o of orders) {
        await bitgetPost("/api/v2/mix/order/cancel-plan-order", {
          symbol, productType: "USDT-FUTURES", marginCoin: "USDT", orderId: o.orderId,
        });
        cancelled++;
        console.log(`  🗑️  [PYRAMID] Otkazan ${planType} nalog ${o.orderId} za ${symbol}`);
      }
    } catch (e) {
      console.log(`  ⚠️  [PYRAMID] cancelAllPlanOrders ${symbol} ${planType}: ${e.message}`);
    }
  }
  return cancelled;
}

// ─── Pyramid: dodaj na postojeću poziciju, merged SL/TP od avg entry ─────────────
// One-Way mode na BitGetu: svi LONG orderi za isti simbol spajaju se u jednu poziciju.
// Ova funkcija:
//   1. Otvara dodatnu količinu bez SL/TP
//   2. Otkazuje stare SL/TP plan naloge
//   3. Računa prosječnu ulaznu cijenu (weighted avg)
//   4. Postavlja nove SL/TP od avg entry
//   5. Ažurira postojeći JSON zapis (ne dodaje novi)
async function addToPyramid(pid, existingPos, signal, newTradeSize, slPct, tpPct, isLive, symSltp) {
  const { symbol, side, entryPrice: oldEntry, quantity: oldQty, totalUSD: oldNotional } = existingPos;
  const holdSide = side === "LONG" ? "long" : "short";

  if (isLive && !PAPER_TRADING) {
    // ── LIVE: otvori dodatnu količinu na BitGetu ──
    const liveP = (await fetchLivePrices([symbol]))[symbol] || oldEntry;
    const newQty = newTradeSize / liveP;

    // 1. Otvori market order (bez SL/TP — postavljamo ručno ispod)
    const orderBody = {
      symbol, productType: "USDT-FUTURES",
      marginMode: "isolated", marginCoin: "USDT",
      side: side === "LONG" ? "buy" : "sell",
      tradeSide: "open", orderType: "market", size: newQty.toFixed(4),
    };
    const orderData = await bitgetPost("/api/v2/mix/order/place-order", orderBody);
    if (!orderData || orderData.code !== "00000") {
      console.log(`  ❌ [PYRAMID] Order fail: ${orderData?.code} ${orderData?.msg}`);
      return null;
    }

    // 2. Čekaj fill i dohvati stvarnu cijenu
    await new Promise(r => setTimeout(r, 2000));
    let fillPrice = liveP;
    try {
      const orderId = orderData.data?.orderId;
      const detPath = `/api/v2/mix/order/detail?symbol=${symbol}&productType=USDT-FUTURES&orderId=${orderId}`;
      const ts2 = Date.now().toString();
      const det = await fetch(`${BITGET.baseUrl}${detPath}`, {
        headers: { "ACCESS-KEY": BITGET.apiKey, "ACCESS-SIGN": signBitGet(ts2, "GET", detPath),
          "ACCESS-TIMESTAMP": ts2, "ACCESS-PASSPHRASE": BITGET.passphrase, "Content-Type": "application/json" },
      }).then(r => r.json());
      if (det.code === "00000" && det.data?.priceAvg) fillPrice = parseFloat(det.data.priceAvg);
    } catch(e) { console.log(`  ⚠️  [PYRAMID] Fill fetch: ${e.message}`); }

    // 3. Otkaži stare SL/TP naloge
    await cancelAllPlanOrders(symbol, side);

    // 4. Prosječna ulazna cijena
    const totalQty  = oldQty + newQty;
    const avgEntry  = (oldQty * oldEntry + newQty * fillPrice) / totalQty;
    const totalUSD  = oldNotional + newTradeSize;

    // 5. Novi SL/TP od avg entry
    const _slPct = slPct ?? SL_PCT;
    const _tpPct = tpPct ?? TP_PCT;
    const newSl = side === "LONG" ? avgEntry * (1 - _slPct / 100) : avgEntry * (1 + _slPct / 100);
    const newTp = side === "LONG" ? avgEntry * (1 + _tpPct / 100) : avgEntry * (1 - _tpPct / 100);

    // 6. Postavi novi hard SL
    await bitgetPost("/api/v2/mix/order/place-tpsl-order", {
      symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
      planType: "pos_loss",
      triggerPrice: fmtPrice(newSl, symbol),
      triggerType: "mark_price", holdSide,
    });
    // 7. Postavi novi trailing stop (aktivacija na TP razini)
    try {
      const trailCallbackRatio = String((_slPct / 100).toFixed(4));
      await bitgetPost("/api/v2/mix/order/place-tpsl-order", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        planType: "track_stop",
        triggerPrice: fmtPrice(newTp, symbol),
        callbackRatio: trailCallbackRatio, holdSide,
      });
    } catch(e) {
      // Fallback: fiksni TP
      await bitgetPost("/api/v2/mix/order/place-tpsl-order", {
        symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
        planType: "pos_profit",
        triggerPrice: fmtPrice(newTp, symbol),
        triggerType: "mark_price", holdSide,
      });
    }

    // 8. Ažuriraj JSON zapis — jedan merged zapis, ne dva
    const allPos = loadPositions(pid);
    const idx = allPos.findIndex(p => p.symbol === symbol && p.side === side);
    if (idx >= 0) {
      allPos[idx].entryPrice = parseFloat(avgEntry.toFixed(6));
      allPos[idx].quantity   = totalQty;
      allPos[idx].totalUSD   = totalUSD;
      allPos[idx].sl         = newSl;
      allPos[idx].tp         = newTp;
      allPos[idx].trailActive = false;  // reset trail
      allPos[idx].trailPeak   = null;
      allPos[idx].beMoved     = false;
      allPos[idx].pyramidCount = (allPos[idx].pyramidCount || 1) + 1;
      savePositions(pid, allPos);
    }

    console.log(`  🔺 [PYRAMID] ${symbol} ${side} — avg entry ${fmtPrice(avgEntry)} | qty ${totalQty.toFixed(4)} | SL ${fmtPrice(newSl)} TP ${fmtPrice(newTp)}`);
    await tg(`🔺 [PYRAMID +${(allPos[idx]?.pyramidCount||2)}] ${symbol} ${side}\nAvg entry: ${fmtPrice(avgEntry)} (bio: ${fmtPrice(oldEntry)})\nQty: ${totalQty.toFixed(4)} | SL: ${fmtPrice(newSl)} | TP: ${fmtPrice(newTp)}`);
    return { avgEntry, totalQty, newSl, newTp };

  } else {
    // ── PAPER: simulacija pyramid ──
    const liveP = (await fetchLivePrices([symbol]))[symbol] || oldEntry;
    const newQty    = newTradeSize / liveP;
    const totalQty  = oldQty + newQty;
    const avgEntry  = (oldQty * oldEntry + newQty * liveP) / totalQty;
    const totalUSD  = oldNotional + newTradeSize;
    const _slPct    = slPct ?? SL_PCT;
    const _tpPct    = tpPct ?? TP_PCT;
    const newSl = side === "LONG" ? avgEntry * (1 - _slPct / 100) : avgEntry * (1 + _slPct / 100);
    const newTp = side === "LONG" ? avgEntry * (1 + _tpPct / 100) : avgEntry * (1 - _tpPct / 100);

    const allPos = loadPositions(pid);
    const idx = allPos.findIndex(p => p.symbol === symbol && p.side === side);
    if (idx >= 0) {
      const prevCount = allPos[idx].pyramidCount || 1;
      allPos[idx].entryPrice   = parseFloat(avgEntry.toFixed(6));
      allPos[idx].quantity     = totalQty;
      allPos[idx].totalUSD     = totalUSD;
      allPos[idx].sl           = newSl;
      allPos[idx].tp           = newTp;
      allPos[idx].trailActive  = false;
      allPos[idx].trailPeak    = null;
      allPos[idx].beMoved      = false;
      allPos[idx].pyramidCount = prevCount + 1;
      savePositions(pid, allPos);
      console.log(`  🔺 [PYRAMID PAPER] ${symbol} ${side} — avg entry ${fmtPrice(avgEntry)} | qty ${totalQty.toFixed(4)} | SL ${fmtPrice(newSl)} TP ${fmtPrice(newTp)}`);
    }
    return { avgEntry, totalQty, newSl, newTp };
  }
}

// ─── Re-entry tracking — prati WIN izlaze za brzo ponovni ulaz u trend ─────────
// Kad pozicija zatvori s profitom (WIN), čuvamo simbol/smjer do 45 min.
// Sljedeći scan() ciklus može re-ući u ISTI smjer s labavijim uvjetima.
const _winReEntry = new Map();  // symbol → { side, pid, ts, count }
const REENTRY_WINDOW_MS  = 45 * 60 * 1000;  // 45 min prozor za re-entry
const REENTRY_MAX         = 2;               // max ponavljanja po trendu

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

const CB_DRAWDOWN_MIN = 100;      // minimalni equity ($) — ispod = stop trading
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
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const exits = lines.slice(1)
      .filter(l => l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT"))
      .filter(l => {
        const cols = l.split(",");
        // Samo danas
        if (!l.startsWith(today)) return false;
        // Ignoriraj trade-ove prije ručnog reseta
        if (!manualResetAt) return true;
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
    const BTC_EXCEPTION = "BTCUSDT";  // BTC uvijek može otvoriti kao bonus slot (4. trade)

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

    // ── 2b. Correlated Exit — BTC spike zatvara sve SHORT pozicije ──────────────
    if (pDef.strategy === "synapse_t") {
      const _spike = await checkBtcSpike();
      if (_spike.spike && _spike.direction === "UP") {
        // BTC naglo skočio → sve open SHORT pozicije su u opasnosti
        const _openShorts = loadPositions(pid).filter(p => p.side === "SHORT");
        if (_openShorts.length > 0) {
          console.log(`  🚨 [CORR EXIT] BTC +${_spike.pct}% u 30min (spike UP) → zatvaramo ${_openShorts.length} SHORT pozicija`);
          for (const _sp of _openShorts) {
            try {
              const _isLiveCe = pDef.live === true && !PAPER_TRADING;
              if (_isLiveCe) {
                const _closeRes = await bitgetPost("/api/v2/mix/order/place-order", {
                  symbol: _sp.symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
                  side: "sell", tradeSide: "close", marginMode: "isolated",  // v2 hedge: close SHORT = side sell
                  holdSide: "short",
                  orderType: "market",
                  size: (await fetchBitgetPositionSize(_sp.symbol, "SHORT"))?.total?.toFixed(4) ?? "0",
                });
                if (_closeRes.code !== "00000") throw new Error(`${_closeRes.code} ${_closeRes.msg}`);
              }
              const _livePxMap = await fetchLivePrices([_sp.symbol]).catch(() => ({}));
              const _exitPx    = _livePxMap[_sp.symbol] ?? _sp.entryPrice;
              const _qty       = _sp.quantity ?? 0;
              const _pnlUsd    = (_sp.entryPrice - _exitPx) * _qty;
              writeExitCsv(pid, _sp, _exitPx, `CORR EXIT: BTC spike +${_spike.pct}% u 30min`, _pnlUsd);
              if (_pnlUsd < 0) { symbolSlCooldown.set(_sp.symbol, Date.now()); saveSlCooldown(); }
              await tg(`⚡ [CORR EXIT] ${_sp.symbol} SHORT\nBTC spike +${_spike.pct}% u 30min → zatvoren preventivno\nP&L: ${_pnlUsd >= 0?"+":""}$${_pnlUsd.toFixed(2)}`).catch(()=>{});
              const _allPos = loadPositions(pid);
              savePositions(pid, _allPos.filter(p => !(p.symbol === _sp.symbol && p.side === "SHORT")));
              console.log(`  ✅ [CORR EXIT] ${_sp.symbol} SHORT zatvoren`);
            } catch(e) {
              console.log(`  ⚠️  [CORR EXIT] ${_sp.symbol} greška: ${e.message}`);
            }
          }
        } else {
          console.log(`  ⚡ [CORR EXIT] BTC +${_spike.pct}% spike — nema otvorenih SHORT-ova`);
        }
      } else if (_spike.spike && _spike.direction === "DOWN") {
        // BTC naglo pao → sve open LONG pozicije su u opasnosti (upozorenje)
        const _openLongs = loadPositions(pid).filter(p => p.side === "LONG");
        if (_openLongs.length > 0) {
          console.log(`  ⚠️  [CORR WARN] BTC ${_spike.pct}% u 30min (spike DOWN) — ${_openLongs.length} LONG pozicija pod pritiskom`);
        }
      }
    }

    // ── 3. Market Regime: BTC 4H + 1H ────────────────────────────────────────────
    let _btcRegime = "UNKNOWN";
    let _btcRegime1h = "UNKNOWN";
    let _btcRsi1h = null;
    let _bounceMode = false;
    if (pDef.strategy === "synapse_t") {
      _btcRegime = await getBtcRegime();
      if (_btcRegime === "UNKNOWN") console.log(`  ⚠️  [${pDef.name}] BTC regime: UNKNOWN — nastavljamo oprezno`);
      else console.log(`  📊 [${pDef.name}] BTC 4H regime: ${_btcRegime}`);

      // BTC 1H regime — brži signal
      const r1h = await getBtcRegime1H();
      _btcRegime1h = r1h.regime;
      _btcRsi1h    = r1h.btcRsi1h;
      console.log(`  📊 [${pDef.name}] BTC 1H regime: ${_btcRegime1h} | RSI1H: ${_btcRsi1h?.toFixed(1)}`);

      // Bounce mode: BTC 1H RSI < 30 ILI dnevni drawdown > 8%
      const _drawdown = getBtcDrawdownPct(r1h.currentPrice || 0);
      _bounceMode = (_btcRsi1h !== null && _btcRsi1h < 30) || _drawdown < -8;
      if (_bounceMode) console.log(`  🔄 [BOUNCE MODE] BTC 1H RSI=${_btcRsi1h?.toFixed(1)} drawdown=${_drawdown.toFixed(1)}% — tražimo LONG signale`);
    }

    // ── SP500 Risk-Off gate — blokira LONG, ali dozvoljava SHORT ─────────────
    let _sp500Regime = "NEUTRAL";
    if (pDef.strategy === "synapse_t") {
      const sp = await getSp500Data();
      _sp500Regime = sp.regime;
      if (sp.change4h !== null) console.log(`  📈 [SP500] ${sp.change4h}% (4H) — ${sp.regime}`);
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
      // CHILL mode — mrtvo tržište: kripto minSig +1 + size ×0.7
      const _chillSt = await getBtcChillMode();
      pDef.params._chillMode = _chillSt.chill;
      if (_chillSt.chill) console.log(`  😴 [CHILL] BTC 24h raspon ${_chillSt.rangePct}% < 2.5% — mrtvo tržište → kripto minSig +1, size ×0.7`);
      // BTC trend-invalidacija (23.07.): dnevni close ispod razine → pooštri LONG (+1 minSig)
      const _invalSt = await getBtcDailyVsInvalidation();
      pDef.params._invalBoost = _invalSt.belowInval === true;
      if (_invalSt.belowInval) console.log(`  ⚠️  [INVAL] BTC daily close $${_invalSt.lastClose?.toFixed(0)} < $${_invalSt.level} → trend slabi, kripto LONG +1 minSig`);
      // BTC tjedni EMA10/EMA20 makro-fazni signal (27.07.) — automatski, bez ručnog unosa
      const _weeklyEma = await getBtcWeeklyEmaPhase();
      pDef.params._weeklyBullPhase = _weeklyEma.bullPhase;
      if (_weeklyEma.bullPhase !== null) console.log(`  📅 [W-EMA] BTC tjedni EMA10 ${_weeklyEma.ema10?.toFixed(0)} ${_weeklyEma.bullPhase ? ">" : "<"} EMA20 ${_weeklyEma.ema20?.toFixed(0)} → ${_weeklyEma.bullPhase ? "BULL faza" : "BEAR faza"}`);
    }

    // ── 1. USDT.D proxy — Stablecoin Inflow/Outflow ──────────────────────────
    let _stableDir = "NEUTRAL";
    if (pDef.strategy === "synapse_t") {
      try {
        const stable = await getStablecoinInflow();
        _stableDir = stable?.direction ?? "NEUTRAL";
        console.log(`  💰 [STABLE] ${stable?.totalB ?? '?'}B USD | ${_stableDir} ${stable?.changePct ?? '?'}% (7d)`);
      } catch { console.log(`  ⚠️  [STABLE] Nije dostupno`); }
    }

    // ── 5. BTC Dominance / Altcoin Season ─────────────────────────────────────
    let _altSeason = null;
    if (pDef.strategy === "synapse_t") {
      try {
        _altSeason = await getAltcoinSeason();
        if (_altSeason) console.log(`  🌊 [BTC.D] ${_altSeason.btcDom}% — ${_altSeason.season} (score: ${_altSeason.score})`);
      } catch { console.log(`  ⚠️  [BTC.D] Nije dostupno`); }
    }

    // ── 4. Market Breadth pre-scan (EMA9/21 na 15m) ───────────────────────────
    let _marketBreadth = { bullish: 0, bearish: 0, neutral: 0, total: 0 };
    if (pDef.strategy === "synapse_t") {
      _marketBreadth = await computeMarketBreadth(pDef.symbols);
      console.log(`  📊 [BREADTH] ▲${_marketBreadth.bullish} ▼${_marketBreadth.bearish} —${_marketBreadth.neutral} / ${_marketBreadth.total} simbola`);
    }

    // SWEEP detektor uklonjen — backtest pokazao da 6h blok smanjuje P&L i WR
    // (112t/60.7%/+$870 s blokom vs 119t/61.3%/+$953 bez bloka)

    let _newEntriesThisScan = 0;  // Reset po portfoliju, ne dopuštamo simultano previše ulaza
    const _scanLogEntries = [];  // skuplja log entries za ovaj scan ciklus

    // ── Dohvati stvarno otvorene pozicije na Bitgetu (jednom po scan ciklusu) ──
    // Ako Bitget već ima poziciju za neki simbol (ručno ili izvana), ne ulazimo
    const _isLive = pDef.live === true && !PAPER_TRADING;
    const _bitgetLivePositions = _isLive ? await fetchBitgetOpenPositions() : null;

    for (const symbol of pDef.symbols) {
      // Bitget provjera otvorene pozicije — odgođena do nakon signal computation (vidi ispod)

      // ── Pyramid (DCA) logika: dopuštamo max MAX_PYRAMID adicija u ISTOM smjeru ──
      const existingPosList = openPositions.filter(p => p.symbol === symbol);
      const existingPos     = existingPosList[0];  // prva/primarna pozicija
      if (existingPos) {
        // Ako signal nije u istom smjeru — skip
        // (signal još nije poznat ovdje, provjerava se ispod nakon analize)
        // Placeholder: ako smjer ne odgovara, skip odmah u analizi
        const pyramidCount = existingPosList.length;
        // BTC VIP iznimka (26.07.): score se provjerava kasnije nakon analize — ovdje
        // samo BTC-u dopuštamo proći dalje i kad je normalni pyramid limit dosegnut.
        if (pyramidCount >= MAX_PYRAMID && symbol !== BTC_EXCEPTION) {
          console.log(`  ⏭️  [${pDef.name}] ${symbol} — max pyramid (${pyramidCount}/${MAX_PYRAMID}) dostignut, preskačem`);
          continue;
        }
        // Inače puštamo da prođe analizu — smjer će se provjeriti ispod
        console.log(`  🔺 [${pDef.name}] ${symbol} — postoji pozicija (${existingPos.side}), provjeravamo pyramid ulaz (${pyramidCount}/${MAX_PYRAMID})`);
      }

      // Provjeri limit otvorenih pozicija (ukupni + po klasi: kripto/dionice)
      const _openNow    = loadPositions(pid);
      const currentOpen = _openNow.length;
      const _reEntry = _winReEntry.get(symbol);
      const _reEntryActive = _reEntry && (Date.now() - _reEntry.ts) < REENTRY_WINDOW_MS;
      if (!_reEntryActive && _reEntry) _winReEntry.delete(symbol);
      const _maxOpen = _reEntryActive ? MAX_OPEN_PER_PORTFOLIO + 1 : MAX_OPEN_PER_PORTFOLIO;
      if (currentOpen >= _maxOpen && symbol !== BTC_EXCEPTION) {
        console.log(`  🔒 [${pDef.name}] Max ${MAX_OPEN_PER_PORTFOLIO}${_reEntryActive?" (re-entry +1)":""} dostignut — preskačem ${symbol}`);
        _scanLogEntries.push({ symbol, signal: "SKIP", blocker: `MAX_POS(${currentOpen}/${_maxOpen})`, reason: "Max otvorenih pozicija dostignut" });
        continue;
      }
      const _symIsStock = isStockSym(symbol);
      const _classOpen  = _openNow.filter(p => isStockSym(p.symbol) === _symIsStock).length;
      const _classMax   = _symIsStock ? MAX_OPEN_STOCKS : MAX_OPEN_CRYPTO;
      if (_classOpen >= _classMax && symbol !== BTC_EXCEPTION && !openSymbols.includes(symbol)) {
        console.log(`  🔒 [${pDef.name}] Max ${_classMax} ${_symIsStock ? "dionica" : "kripto"} dostignut (${_classOpen}) — preskačem ${symbol}`);
        _scanLogEntries.push({ symbol, signal: "SKIP", blocker: `MAX_${_symIsStock ? "STOCK" : "CRYPTO"}(${_classOpen}/${_classMax})`, reason: `Max ${_symIsStock ? "dionica" : "kripto"} pozicija` });
        continue;
      }

      // ── Max novih ulaza po scan ciklusu ────────────────────────────────
      // Sprječava 8 simultanih LONG/SHORT ulaza kad svi simboli signaliziraju odjednom
      if (_newEntriesThisScan >= MAX_NEW_ENTRIES_PER_SCAN && symbol !== BTC_EXCEPTION) {
        console.log(`  🚦 [${pDef.name}] Max ${MAX_NEW_ENTRIES_PER_SCAN} novih ulaza ovaj scan — preskačem ${symbol}`);
        continue;
      }

      // ── 2. Symbol Blacklist ─────────────────────────────────────────────
      if (isBlacklisted(symbol)) continue;

      try {
        // ── Macro size multiplier — umjesto blokada smanjujemo poziciju ──────
        // (TraderaEdge pristup: pusti trejd, kontroliraj rizik veličinom)
        let _macroSizeMult = 1.0;

        // ── Noćni blok — analiza 100 tradeova (08.07.): ulazi 20-06 UTC su WR 24%,
        //    -11.6 USDT. Tanka likvidnost + nitko ne gleda. Upravljanje pozicijama
        //    (SL/TP/trail/partial) radi 24/7 — blokiran je samo NOVI ulaz.
        const sess = getSessionInfo();
        const _nightH = new Date().getUTCHours();
        if ((_nightH >= 20 || _nightH < 6) && !isStockSym(symbol)) {
          _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "NIGHT", reason: `Noćni blok ${_nightH}:00 UTC (WR 24% noću)` });
          continue;
        }

        // ── Weekend — TraderaEdge AMA: "weekendom se inače ne trguje" ───────
        const _dow = new Date().getUTCDay();
        if (_dow === 0 || _dow === 6) {
          _macroSizeMult *= 0.5;
          console.log(`  📅 [WEEKEND] ${symbol} — ${_dow === 6 ? "subota" : "nedjelja"} → size ×0.5`);
        }

        // ── CHILL mode — mrtvo tržište: kripto size ×0.7 ────────────────────
        if (pDef.params._chillMode && !isStockSym(symbol)) {
          _macroSizeMult *= 0.7;
        }

        // ── Dionice: ulaz SAMO dok US tržište radi (13:35–19:30 UTC, pon–pet) ──
        // xStocks izvan sesije stoje (zamrznuta cijena = lažni signali).
        // Pozicije SMIJU prenoćiti (flat isključen 09.07. na zahtjev)
        if (isStockSym(symbol)) {
          const _nowS = new Date();
          const _hS = _nowS.getUTCHours(), _mS = _nowS.getUTCMinutes();
          const _inSession = _dow >= 1 && _dow <= 5
            && (_hS > 13 || (_hS === 13 && _mS >= 35))
            && (_hS < 19 || (_hS === 19 && _mS <= 30));
          if (!_inSession) {
            _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "STOCK_SESSION", reason: "US tržište zatvoreno" });
            continue;
          }
        }

        // ── A) MM Blackout — UKLONJEN 25.05.2026 ────────────────────────────
        // Bio temeljen na našim lošim trejdovima, ne na tržišnim podacima.
        // Zamijenjen s Coinglass sweep detektorom koji gleda stvarne tržišne likvide.

        // ── 1H Trend Filter ─────────────────────────────────────────────────
        const trend1h = pDef.strategy === "synapse_t" ? await calcTrend1H(symbol) : { trend: 'UNKNOWN' };

        // synapse_t uvijek skenira 1H candles za pullback logiku (bez obzira na portfolio TF)
        // portfolio TF je "15m" samo da shouldRunNow okida svakih 15 min
        const candleTf = pDef.strategy === "synapse_t" ? "1H" : pDef.timeframe;
        const candles = await fetchCandles(symbol, candleTf, 250);
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

        // Bounce mode: smanji minSig na 3 (tržište oversold, manji prag za LONG)
        const _bounceParams = _bounceMode
          ? { ...pDef.params, minSig: Math.min(pDef.params?.minSig ?? 4, 3) }
          : pDef.params;

        let result;
        switch (pDef.strategy) {
          case "synapse_t":   result = await analyzeUltraPullback(symbol, candles, _bounceParams);      break;
          default:            result = { signal: "NEUTRAL", reason: "Nepoznata strategija" };         break;
        }

        let { signal, reason } = result;

        // ── 15m Momentum fallback — ako je 1H pullback NEUTRAL, provjeri 15m momentum ──
        if (signal === "NEUTRAL" && pDef.strategy === "synapse_t") {
          try {
            const candles15m = await fetchCandles(symbol, "15m", 250);
            const result15m  = await analyzeUltraPullback(symbol, candles15m, _bounceParams);
            if (result15m.signal !== "NEUTRAL" && result15m.isMomentum) {
              Object.assign(result, result15m);
              ({ signal } = result);
              console.log(`  🚀 [15m MOM] ${symbol} — ${result15m.reason}`);
            }
          } catch(e) { console.log(`  ⚠️  [15m MOM] ${symbol} fetch error: ${e.message}`); }
        }

        if (signal === "NEUTRAL") {
          console.log(`  🚫 [${pDef.name}] ${symbol} — ${reason}`);
          _scanLogEntries.push({
            symbol, signal: "NEUTRAL",
            score: Math.max(result.bullScore || 0, result.bearScore || 0),
            rsi: result.price != null ? null : null,  // rsi u reason stringu
            adx: null, vwapDist: result.vwap ? ((result.price - result.vwap) / result.vwap * 100).toFixed(2) : null,
            blocker: "SIGNAL", reason,
          });
          continue;
        }

        // ── Bitget provjera otvorene pozicije (smjer-svjesna) ────────────────────
        // Ako drugi bot drži poziciju na Bitgetu u ISTOM smjeru → dopuštamo ulaz (adicija).
        // Ako je SUPROTAN smjer → preskačemo (nema hedgea).
        if (_bitgetLivePositions !== null) {
          const _hasBitgetLong  = _bitgetLivePositions.has(`${symbol}:long`);
          const _hasBitgetShort = _bitgetLivePositions.has(`${symbol}:short`);
          if (_hasBitgetLong || _hasBitgetShort) {
            const _bitgetSide = _hasBitgetLong ? "LONG" : "SHORT";
            if (_bitgetSide !== signal) {
              console.log(`  🚫 [${pDef.name}] ${symbol} — Bitget ima ${_bitgetSide}, signal je ${signal} (suprotan) → skip`);
              _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: "BITGET_OPPOSITE", reason: `Bitget ${_bitgetSide} vs signal ${signal}` });
              continue;
            }
            console.log(`  ✅ [${pDef.name}] ${symbol} — Bitget ima ${_bitgetSide}, signal isti (${signal}) → dopuštamo adiciju`);
          }
        }

        // ── D) Quiet Pullback filter — uklonjen za BTC-only (BTC ima trajno visok vol) ──

        // ── C) Per-simbol Liq Zone Filter ────────────────────────────────────────────
        // Svaki simbol provjerava VLASTITE liq zone iz već dohvaćenih 1H candles.
        // DANGER  (< 1%): MM ima razlog sweepnuti baš ovaj simbol → skip
        // CAUTION (< 2.5%): traži score ≥ 6/7 (umjesto 4/7 PBK ili 5/7 MOM)
        // CLEAR   (≥ 2.5%): normalno
        if (pDef.strategy === "synapse_t" && !existingPos) {
          const _liqStatus = calcLiqZones(candles);
          if (_liqStatus.danger !== "CLEAR") {
            const _icon = _liqStatus.danger === "DANGER" ? "🔴" : "🟡";
            if (_liqStatus.danger === "DANGER") {
              // Za LONG: SHORT liq zona ISPOD cijene = već prošla ili support → ignoriramo
              // Za SHORT: LONG liq zona IZNAD cijene = već prošla ili support → ignoriramo
              const cp = candles[candles.length - 1].close;
              const _dangerousForLong  = _liqStatus.closestLong  && _liqStatus.closestLong.dist  < 1.0 && _liqStatus.closestLong.price  < cp;  // LONG liq ispod = MM može sweepnuti dolje
              const _dangerousForShort = _liqStatus.closestShort && _liqStatus.closestShort.dist < 1.0 && _liqStatus.closestShort.price > cp;  // SHORT liq iznad = MM može sweepnuti gore
              const _realDanger = (signal === "LONG" && _dangerousForLong) || (signal === "SHORT" && _dangerousForShort);
              if (_realDanger) {
                console.log(`  ${_icon} [LIQ] ${symbol} — DANGER (${_liqStatus.minDist.toFixed(1)}% do liq · LONG $${_liqStatus.closestLong?.price.toFixed(0)||"?"} · SHORT $${_liqStatus.closestShort?.price.toFixed(0)||"?"}) → preskačem`);
                _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: `LIQ_DANGER(${_liqStatus.minDist.toFixed(1)}%)`, reason: `Liq zona ${_liqStatus.minDist.toFixed(1)}% od cijene` });
                continue;
              } else {
                console.log(`  🟡 [LIQ] ${symbol} — zona ${_liqStatus.minDist.toFixed(1)}% ali nije opasna za ${signal} → nastavljam`);
              }
            }
            if (_liqStatus.danger === "CAUTION") {
              const _scoreNow = Math.max(result.bullScore ?? 0, result.bearScore ?? 0);
              if (_scoreNow < 6) {
                console.log(`  ${_icon} [LIQ] ${symbol} — CAUTION (${_liqStatus.minDist.toFixed(1)}%), score ${_scoreNow}/7 < 6 → preskačem`);
                continue;
              }
              console.log(`  ${_icon} [LIQ] ${symbol} — CAUTION ali score ${_scoreNow}/7 ≥ 6 → dopuštam`);
            }
          } else {
            console.log(`  🟢 [LIQ] ${symbol} — CLEAR (${_liqStatus.minDist.toFixed(1)}% do liq)`);
          }
        }

        // ── Pyramid / Flip logika ─────────────────────────────────────────────
        if (existingPos && existingPos.side !== signal) {
          // Suprotan signal — flip samo ako je jak (score >= 5)
          const _flipScore = signal === "LONG" ? (result.bullScore ?? 0) : (result.bearScore ?? 0);
          const FLIP_MIN_SCORE = 5;
          if (_flipScore >= FLIP_MIN_SCORE && isLive) {
            console.log(`  🔄 [FLIP] ${symbol} — jak kontra signal (score=${_flipScore}) → zatvaramo ${existingPos.side}, otvaramo ${signal}`);
            // Zatvori postojeću poziciju
            const _flipBitPos = await fetchBitgetPositionSize(symbol, existingPos.side).catch(() => null);
            if (_flipBitPos && !_flipBitPos.error) {
              await cancelAllPlanOrders(symbol, existingPos.side).catch(() => {});
              const _flipQty      = (_flipBitPos.total > 0 ? _flipBitPos.total : _flipBitPos.available).toFixed(4);
              const _flipCloseSide = existingPos.side === "LONG" ? "buy" : "sell";  // v2 hedge close
              const _flipCloseRes  = await bitgetPost("/api/v2/mix/order/place-order", {
                symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
                side: _flipCloseSide, tradeSide: "close", marginMode: "isolated",
                holdSide: existingPos.side === "LONG" ? "long" : "short",
                orderType: "market", size: _flipQty,
              });
              if (_flipCloseRes.code === "00000") {
                const _flipLiveMap = await fetchLivePrices([symbol]).catch(() => ({}));
                const _flipExit = _flipLiveMap[symbol] ?? existingPos.entryPrice;
                const _flipPnl  = existingPos.side === "LONG"
                  ? (_flipExit - existingPos.entryPrice) * parseFloat(_flipQty)
                  : (existingPos.entryPrice - _flipExit) * parseFloat(_flipQty);
                writeExitCsv(pid, existingPos, _flipExit, `FLIP → ${signal} (score=${_flipScore})`, _flipPnl);
                if (existingPos.sigMask != null) recordSignalOutcome(existingPos.sigMask, _flipPnl >= 0);
                recordSymbolOutcome(symbol, _flipPnl >= 0);
                const _allPos = loadPositions(pid);
                savePositions(pid, _allPos.filter(p => !(p.symbol === symbol && p.side === existingPos.side)));
                await tg(`🔄 <b>FLIP [ULTRA]</b> ${symbol}\nZatvoren ${existingPos.side} → otvaram ${signal}\nScore: ${_flipScore}/6 | P&L: ${_flipPnl >= 0 ? "+" : ""}$${_flipPnl.toFixed(2)}`);
                // Nastavi s otvaranjem nove pozicije u suprotnom smjeru
              } else {
                console.log(`  ❌ [FLIP] Close fail: ${_flipCloseRes.code} ${_flipCloseRes.msg} → skip`);
                continue;
              }
            } else {
              // Pozicija ne postoji na Bitgetu — samo ukloni tracking
              const _allPos = loadPositions(pid);
              savePositions(pid, _allPos.filter(p => !(p.symbol === symbol && p.side === existingPos.side)));
            }
          } else {
            console.log(`  ⏭️  [${pDef.name}] ${symbol} — pozicija ${existingPos.side}, kontra signal ${signal} (score=${_flipScore} < ${FLIP_MIN_SCORE}) → skip`);
            continue;
          }
        }
        if (existingPos && existingPos.side === signal) {
          // BTC VIP pyramid (26.07.): score >=7/8 dobiva dodatnu adiciju iznad MAX_PYRAMID
          if (existingPosList.length >= MAX_PYRAMID) {
            const _pyScore = signal === "LONG" ? (result.bullScore ?? 0) : (result.bearScore ?? 0);
            const _pyComboLen = SYMBOL_COMBOS[symbol]?.sigIdx?.length ?? 8;
            if (symbol === BTC_EXCEPTION && _pyScore >= 7 && _pyComboLen >= 8) {
              console.log(`  ⭐ [VIP PYRAMID] ${symbol} ${signal} — score ${_pyScore}/${_pyComboLen} ≥ 7 → dodatna adicija ${existingPosList.length + 1} iznad limita`);
              result._vipSlot = true;
            } else {
              console.log(`  ⏭️  [${pDef.name}] ${symbol} — max pyramid (${existingPosList.length}/${MAX_PYRAMID}) dostignut, preskačem`);
              continue;
            }
          } else {
            console.log(`  🔺 [PYRAMID] ${symbol} ${signal} — adicija ${existingPosList.length + 1}/${MAX_PYRAMID} u trendu`);
          }
        }

        // RE-ENTRY marker — loguj i očisti queue ako smjer odgovara
        if (_reEntryActive && _reEntry.side === signal) {
          console.log(`  🔁 [RE-ENTRY] ${symbol} ${signal} — isti smjer kao WIN exit, nastavljam trend`);
          _winReEntry.delete(symbol);  // iskorišten
        }

        // ── Regime + SP500 + 1H trend filter — po smjeru signala ─────────────
        if (pDef.strategy === "synapse_t") {
          // ── Bypass uvjeti ──────────────────────────────────────────────────────
          // 1. Kapitulacija: BTC 4H RSI < 15
          const _btcRsi4h = _regimeCache.btcRsi4h ?? null;
          const _capitulation = signal === "LONG" && _btcRsi4h !== null && _btcRsi4h < 15;
          // 2. Bounce mode: BTC 1H RSI < 30 ili dnevni drawdown > 8%
          const _bounceBypass = signal === "LONG" && _bounceMode;
          const _anyLongBypass = _capitulation || _bounceBypass;
          if (_capitulation) console.log(`  🔄 [BOUNCE] ${symbol} — BTC 4H RSI ${_btcRsi4h?.toFixed(1)} < 15 → kapitulacija bypass`);
          if (_bounceBypass && !_capitulation) console.log(`  🔄 [BOUNCE] ${symbol} — bounce mode aktivan (1H RSI < 30) → LONG bypass`);

          // BTC 1H je primarni regime filter (brži od 4H)
          // 4H ostaje samo kao kontekst za TP dinamiku
          const _effectiveRegime = _btcRegime1h !== "UNKNOWN" ? _btcRegime1h : _btcRegime;

          // RANGE/SWEEP strategije su po prirodi kontra-trend (zona/liquidity hunt)
          // → izuzete od BTC regime i BTC align trend filtera
          const _stratBypass = ["RANGE", "SWEEP"].includes(result._strategy);
          if (_stratBypass) console.log(`  🎪 [${result._strategy}] ${symbol} — zonska strategija → regime/align bypass`);

          // LONG filter: 1H BEAR blokira, OSIM ako je 4H BULL (pullback setup)
          // Pullback u BULL trendu = Telegram trader strategija, ali traži score ≥ 5
          if (signal === "LONG" && _effectiveRegime === "BEAR" && !_anyLongBypass && !_stratBypass) {
            const _4hBull = _btcRegime === "BULL";
            if (_4hBull) {
              const _pullbackScore = result.bullScore ?? 0;
              const _pullbackMin = 5;
              if (_pullbackScore >= _pullbackMin) {
                console.log(`  🔄 [PULLBACK] ${symbol} — 4H BULL + 1H pullback, score ${_pullbackScore}/6 ≥ ${_pullbackMin} → LONG dopušten`);
              } else {
                console.log(`  🌧️  [REGIME] ${symbol} — 4H BULL + 1H BEAR pullback, score ${_pullbackScore} < ${_pullbackMin} → LONG blokiran`);
                _scanLogEntries.push({ symbol, signal, score: _pullbackScore, blocker: `PULLBACK_SCORE(${_pullbackScore}<${_pullbackMin})`, reason: `4H BULL + 1H BEAR, slab signal` });
                continue;
              }
            } else {
              console.log(`  🌧️  [REGIME] ${symbol} — BTC 1H BEAR + 4H ${_btcRegime} → LONG blokiran`);
              _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: `BTC_REGIME(${_effectiveRegime})`, reason: "BTC 1H BEAR → LONG blokiran", vwapDist: result.vwap ? ((result.price-result.vwap)/result.vwap*100).toFixed(2) : null });
              continue;
            }
          }

          // SHORT filter — tri razine zaštite:
          // 1. BTC 4H EMA50: ako cijena IZNAD EMA50 → tržište u recovery/bull fazi → SHORT blokiran
          // 2. BTC 1H BULL + simbol nije bearish → SHORT blokiran
          // 3. BTC 1H NEUTRAL + BTC 4H iznad EMA50 → SHORT blokiran (NEUTRAL ne znači da možemo SHORT)
          const _btcAboveEma50 = _regimeCache.btcAboveEma50_4h ?? false;
          const _sym1hTrend = result?.trend1h || trend1h?.trend || null;

          if (signal === "SHORT" && _btcAboveEma50 && _sym1hTrend !== "BEAR" && !_stratBypass) {
            const _ema50str = _regimeCache.btcEma50_4h ? ` (EMA50=$${_regimeCache.btcEma50_4h.toFixed(0)})` : "";
            console.log(`  ☀️  [REGIME EMA50] ${symbol} — BTC 4H iznad EMA50${_ema50str} + simbol 1H ${_sym1hTrend||"?"} → SHORT blokiran`);
            _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: `BTC_EMA50_ABOVE`, reason: `BTC 4H iznad EMA50, simbol 1H ${_sym1hTrend||"?"} → SHORT blokiran` });
            continue;
          }
          if (signal === "SHORT" && _effectiveRegime === "BULL" && _sym1hTrend !== "BEAR" && !_stratBypass) {
            console.log(`  ☀️  [REGIME] ${symbol} — BTC 1H BULL + simbol 1H ${_sym1hTrend||"?"} → SHORT blokiran`);
            _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: `BTC_REGIME(${_effectiveRegime})`, reason: `BTC 1H BULL, simbol 1H ${_sym1hTrend||"?"} → SHORT blokiran` });
            continue;
          }
          if (signal === "SHORT" && (_effectiveRegime === "BULL" || _btcAboveEma50) && _sym1hTrend === "BEAR") {
            console.log(`  ⚡ [REGIME] ${symbol} — BTC BULL/Recovery ali simbol 1H BEAR → SHORT dopušten (divergencija)`);
          }
          // Bounce mode: blokira SHORT (tražimo samo LONG reversal)
          if (signal === "SHORT" && _bounceMode) {
            console.log(`  🔄 [BOUNCE MODE] ${symbol} — bounce mode, SHORT blokiran`);
            continue;
          }

          // Direkcijski cooldown — 3 uzastopna SL-a istog smjera = smjer blokiran 4h
          {
            const _dirStreak = getDirLossStreak(pid, signal);
            if (_dirStreak.blocked) {
              console.log(`  🧊 [DIR-CD] ${symbol} — ${_dirStreak.count} uzastopna ${signal} SL-a → ${signal} blokiran 4h`);
              _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "DIR_COOLDOWN", reason: `${_dirStreak.count}× ${signal} SL zaredom` });
              continue;
            }
          }

          // Simbol+smjer cooldown — 2 uzastopna SL-a na istoj ideji = 24h pauza za taj par
          {
            const _ssStreak = getSymbolSideLossStreak(pid, symbol, signal);
            if (_ssStreak.blocked) {
              console.log(`  🧊 [SYM-CD] ${symbol} — ${_ssStreak.count}× ${signal} SL zaredom na ovom simbolu → blokiran 24h`);
              _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "SYM_COOLDOWN", reason: `${_ssStreak.count}× ${signal} SL na ${symbol} — 24h pauza` });
              continue;
            }
          }

          // Korelacijski cap — max 3 kripto pozicije u ISTOM smjeru (08.07.: 6 istovremenih
          // longova = jedna BTC oklada plaćena 6 puta). BTC iznimka vrijedi, dionice izuzete.
          // VIP slot (26.07.): score ≥ 7/8 dobiva +1 dodatni slot iznad limita — max 1 VIP
          // istovremeno po smjeru, da ni "jaki" signali ne postanu novi izvor korelacije.
          if (!isStockSym(symbol) && symbol !== "BTCUSDT" && !openSymbols.includes(symbol)) {
            const _openCrypto = loadPositions(pid).filter(p => !isStockSym(p.symbol) && p.side === signal);
            const _sameDir = _openCrypto.length;
            if (_sameDir >= MAX_SAME_DIR_CRYPTO) {
              const _score = signal === "LONG" ? (result.bullScore ?? 0) : (result.bearScore ?? 0);
              const _comboLen = SYMBOL_COMBOS[symbol]?.sigIdx?.length ?? 8;
              const _vipEligible = _score >= 7 && _comboLen >= 8;
              const _vipUsed = _openCrypto.some(p => p.vipSlot === true);
              if (_vipEligible && !_vipUsed) {
                console.log(`  ⭐ [VIP] ${symbol} — score ${_score}/${_comboLen} ≥ 7 → VIP slot (${_sameDir}/${MAX_SAME_DIR_CRYPTO}+1)`);
                result._vipSlot = true;
              } else {
                console.log(`  🔗 [SAME-DIR] ${symbol} — već ${_sameDir} kripto ${signal} pozicija (max ${MAX_SAME_DIR_CRYPTO}) → preskačem`);
                _scanLogEntries.push({ symbol, signal: "SKIP", blocker: `SAME_DIR(${_sameDir}/${MAX_SAME_DIR_CRYPTO})`, reason: `Previše kripto ${signal} pozicija — korelacija` });
                continue;
              }
            }
          }

          // BTC ključna ciklus-razina (60k) — TraderaEdge macro pravilo, prošireno 20.07.:
          // SVI kripto trend SHORTOVI tek NAKON tjednog closea ispod razine (analiza 3 tjedna:
          // short WR 26%, -9.9 USDT — shortali smo akumulaciju). SWEEP/RANGE izuzeti.
          if (!isStockSym(symbol) && signal === "SHORT" && !_stratBypass) {
            const _wk = await getBtcWeeklyVsKey();
            if (_wk.belowKey === false) {
              console.log(`  🏛️  [KEY-LVL] ${symbol} — BTC tjedni close $${_wk.lastClose?.toFixed(0)} ≥ $${_wk.key} → kripto trend SHORT blokiran (akumulacija)`);
              _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "KEY_LEVEL", reason: `BTC tjedni close iznad $${_wk.key} — ne shortamo akumulaciju` });
              continue;
            }
            if (_wk.belowKey === true) console.log(`  ⚠️  [KEY-LVL] ${symbol} — BTC tjedni close < $${_wk.key} → SHORT režim potvrđen`);
          }

          // BTC daily EMA10 — globalni kripto filter: BTC ispod svog dEMA10 → alt LONG blokiran
          // (altovi prate BTC; per-simbol DEMA gate ovo ne hvata dok alt još nije probio svoju EMA)
          if (!isStockSym(symbol) && symbol !== "BTCUSDT" && signal === "LONG" && !_stratBypass) {
            const _btcDema = await getBtcDailyEma10();
            if (_btcDema.above === false) {
              console.log(`  🌐 [BTC-dEMA10] ${symbol} — BTC ispod svog daily EMA10 ($${_btcDema.ema10?.toFixed(0)}) → alt LONG blokiran`);
              _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "BTC_DEMA10", reason: "BTC ispod daily EMA10 — altovi prate BTC" });
              continue;
            }
          }

          // Strong/Weak relativna snaga vs BTC (TraderaEdge): LONG samo STRONG altove,
          // SHORT samo WEAK altove ("shortuj slabe shitcoine kad BTC pada, ne lidere")
          if (!isStockSym(symbol) && symbol !== "BTCUSDT" && !_stratBypass) {
            const _relStr = await getRelStrengthVsBtc(symbol);
            if (_relStr === "WEAK" && signal === "LONG") {
              console.log(`  🐌 [REL-STR] ${symbol} — WEAK vs BTC → LONG blokiran (long samo strong altove)`);
              _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "REL_STR_WEAK", reason: "Slab vs BTC — LONG samo na strong altovima" });
              continue;
            }
            if (_relStr === "STRONG" && signal === "SHORT") {
              console.log(`  💪 [REL-STR] ${symbol} — STRONG vs BTC → SHORT blokiran (ne shortaj lidere)`);
              _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "REL_STR_STRONG", reason: "Jak vs BTC — ne shortamo lidere" });
              continue;
            }
            if (_relStr) console.log(`  ${_relStr === "STRONG" ? "💪" : "🐌"} [REL-STR] ${symbol} — ${_relStr} vs BTC → ${signal} usklađen`);
          }

          // BTC align filter — za ETH/SOL zahtijevamo eksplicitni BTC trend (ne NEUTRAL)
          // Sprječava ulaze na kraju poteza kad BTC nema jasnog smjera
          const _needsBtcAlign = SYMBOL_COMBOS[symbol]?.btcAlign === true;
          if (_needsBtcAlign && !_stratBypass) {
            if (signal === "LONG" && _effectiveRegime !== "BULL") {
              console.log(`  🔒 [BTC ALIGN] ${symbol} — LONG zahtijeva BTC BULL, trenutno ${_effectiveRegime} → blokiram`);
              continue;
            }
            if (signal === "SHORT" && _effectiveRegime !== "BEAR") {
              console.log(`  🔒 [BTC ALIGN] ${symbol} — SHORT zahtijeva BTC BEAR, trenutno ${_effectiveRegime} → blokiram`);
              continue;
            }
          }

          // Day range filter — LONG samo u donjem dijelu dana (≤45%), SHORT samo u gornjem (≥55%)
          // Analiza 36 trejdova pokazala da SOL/ETH/TAO LONG ulaze blizu vrha dana → odmah SL
          {
            const _dayHL = await fetchDayHL(symbol).catch(() => null);
            if (_dayHL && _dayHL.high > _dayHL.low) {
              const _hlRange   = _dayHL.high - _dayHL.low;
              const _livePriceMap = await fetchLivePrices([symbol]).catch(() => ({}));
              const _livePrice = _livePriceMap[symbol] ?? null;
              if (_livePrice) {
                const _posInRange = (_livePrice - _dayHL.low) / _hlRange * 100;
                // >80% dana = kupovanje vrha — HARD BLOCK (post-mortem 05.07.: AVAX 81%, LINK 97% → likvidacije)
                if (signal === "LONG" && _posInRange > 80) {
                  console.log(`  📊 [DAY RANGE] ${symbol} — cijena na ${_posInRange.toFixed(0)}% dana → LONG BLOKIRAN (vrh dana)`);
                  _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "DAY_RANGE", reason: `LONG na ${_posInRange.toFixed(0)}% dana` });
                  continue;
                }
                if (signal === "SHORT" && _posInRange < 20) {
                  console.log(`  📊 [DAY RANGE] ${symbol} — cijena na ${_posInRange.toFixed(0)}% dana → SHORT BLOKIRAN (dno dana)`);
                  _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "DAY_RANGE", reason: `SHORT na ${_posInRange.toFixed(0)}% dana` });
                  continue;
                }
                // 65-80% (LONG) / 20-35% (SHORT) = oprezna zona — size penal
                if (signal === "LONG" && _posInRange > 65) {
                  _macroSizeMult *= 0.6;
                  console.log(`  📊 [DAY RANGE] ${symbol} — cijena na ${_posInRange.toFixed(0)}% dana → LONG size ×0.6 (visoko u danu)`);
                } else if (signal === "SHORT" && _posInRange < 35) {
                  _macroSizeMult *= 0.6;
                  console.log(`  📊 [DAY RANGE] ${symbol} — cijena na ${_posInRange.toFixed(0)}% dana → SHORT size ×0.6 (nisko u danu)`);
                } else {
                  console.log(`  📊 [DAY RANGE] ${symbol} — cijena na ${_posInRange.toFixed(0)}% dana → ${signal} dozvoljen`);
                }
              }
            }
          }

          // SP500 RISK_OFF → LONG smanjeni size (bila blokada)
          if (signal === "LONG" && _sp500Regime === "RISK_OFF" && !_anyLongBypass) {
            _macroSizeMult *= 0.6;
            console.log(`  🚨 [SP500] ${symbol} — RISK_OFF → LONG size ×0.6`);
          }
          // Fear & Greed ekstremi → smanjeni size (bila blokada)
          if (signal === "SHORT" && _fearGreed !== null && _fearGreed <= 15) {
            _macroSizeMult *= 0.5;
            console.log(`  😱 [F&G] ${symbol} — Extreme Fear (${_fearGreed}) → SHORT size ×0.5 (bounce rizik)`);
          }
          if (signal === "LONG" && _fearGreed !== null && _fearGreed >= 85) {
            _macroSizeMult *= 0.5;
            console.log(`  🤑 [F&G] ${symbol} — Extreme Greed (${_fearGreed}) → LONG size ×0.5 (reversal rizik)`);
          }
          // DXY jaki dolar → LONG smanjeni size (bila blokada)
          if (signal === "LONG" && _dxyChange !== null && _dxyChange > 0.3) {
            _macroSizeMult *= 0.7;
            console.log(`  💵 [DXY] ${symbol} — DXY +${_dxyChange}% → LONG size ×0.7 (jaki dolar)`);
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

        // ── 7. Korelacijski filter — max MAX_PER_SECTOR pozicija istog sektora ──
        if (pDef.strategy === "synapse_t") {
          const sector = SYMBOL_SECTORS[symbol];
          if (sector && sector !== "BTC") {
            const sectorOpen = openPositions.filter(p => SYMBOL_SECTORS[p.symbol] === sector).length;
            if (sectorOpen >= MAX_PER_SECTOR) {
              console.log(`  🔗 [SEKTOR] ${symbol} — sektor "${sector}" pun (${sectorOpen}/${MAX_PER_SECTOR}) → preskačem`);
              continue;
            }
          }
        }

        // ── 1. Stablecoin OUTFLOW → LONG oprezniji (size ×0.7) ──────────────
        // Outflow = kapital napušta crypto ecosystem → smanjujemo izloženost
        let _stableSizeMult = 1.0;
        if (pDef.strategy === "synapse_t" && signal === "LONG" && _stableDir === "OUTFLOW") {
          _stableSizeMult = 0.7;
          console.log(`  💰 [STABLE-OUT] ${symbol} — stablecoin OUTFLOW → size ×0.7`);
        }

        // ── 5. BTC Dominance — BTC_SEASON blokira altcoin LONG ───────────────
        // BTC_SEASON (BTC.D > 58%) = BTC vodi tržište, altcoini slabe → ne idemo LONG altcoin
        if (pDef.strategy === "synapse_t" && signal === "LONG" && symbol !== "BTCUSDT") {
          if (_altSeason?.season === "BTC SEASON") {
            console.log(`  🌊 [BTC.D] ${symbol} — BTC_SEASON (${_altSeason.btcDom}%) → altcoin LONG blokiran`);
            continue;
          }
        }

        // ── 2. Funding rate gate — blokira LONG ako tržište preokomjerno long ──
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

        // ── Long/Short Ratio — squeeze detection + WHALE alignment ─────────────
        // getLongShortRatio vraća { longRatio: "55.1", shortRatio: "44.9", trend } (Binance, %)
        // < 40% long = retail pretežno short = kontrarian LONG (short squeeze)
        // > 62% long = retail pretežno long  = kontrarian SHORT (long squeeze)
        // + TraderaEdge AI Whale Summary logika: TOP traderi (position ratio) vs retail —
        //   "top bullish + retail bearish = najjači long setup"
        let _squeezeMult = 1.0;
        let _whaleMult = 1.0;
        if (pDef.strategy === "synapse_t") {
          // Top-trader position ratio (Binance public, 30-min cache po simbolu)
          try {
            const _ttKey = `_tt_${symbol}`;
            if (!global[_ttKey] || Date.now() - global[_ttKey].ts > 30 * 60 * 1000) {
              const _tt = await fetch(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=1`).then(r => r.json()).catch(() => null);
              global[_ttKey] = { ratio: _tt?.[0]?.longShortRatio ? parseFloat(_tt[0].longShortRatio) : null, ts: Date.now() };
            }
            const _ttRatio = global[_ttKey].ratio;
            if (_ttRatio !== null) {
              if (signal === "LONG"  && _ttRatio >= 1.4) { _whaleMult = 1.2; console.log(`  🐋 [WHALE] ${symbol} — top traderi ${_ttRatio.toFixed(2)} L/S → LONG usklađen s kitovima ×1.2`); }
              if (signal === "SHORT" && _ttRatio <= 0.7) { _whaleMult = 1.2; console.log(`  🐋 [WHALE] ${symbol} — top traderi ${_ttRatio.toFixed(2)} L/S → SHORT usklađen s kitovima ×1.2`); }
              if (signal === "LONG"  && _ttRatio <= 0.7) { _whaleMult = 0.7; console.log(`  🐋 [WHALE] ${symbol} — top traderi SHORT (${_ttRatio.toFixed(2)}) a mi LONG → oprez ×0.7`); }
              if (signal === "SHORT" && _ttRatio >= 1.4) { _whaleMult = 0.7; console.log(`  🐋 [WHALE] ${symbol} — top traderi LONG (${_ttRatio.toFixed(2)}) a mi SHORT → oprez ×0.7`); }
            }
          } catch {}
          const lsr = await getLongShortRatio(symbol);
          if (lsr) {
            const lr       = parseFloat(lsr.longRatio);   // npr. 55.1
            const extreme  = lr < 33 || lr > 72;
            const bearish  = lr < 40;
            const bullish  = lr > 62;
            if (signal === "LONG" && bearish) {
              if (oi.rising && oi.changePct > 8) {
                _squeezeMult = extreme ? 1.4 : 1.25;
                console.log(`  🔥 [SQUEEZE] ${symbol} — retail ${lr.toFixed(1)}% long + OI+${oi.changePct.toFixed(1)}% → short squeeze setup ×${_squeezeMult}`);
              } else {
                console.log(`  📊 [LSR] ${symbol} — retail bearish (${lr.toFixed(1)}% long) → kontrarian long bias`);
              }
            } else if (signal === "SHORT" && bullish) {
              if (oi.rising && oi.changePct > 8) {
                _squeezeMult = extreme ? 1.4 : 1.25;
                console.log(`  🔥 [SQUEEZE] ${symbol} — retail ${lr.toFixed(1)}% long + OI+${oi.changePct.toFixed(1)}% → long squeeze setup ×${_squeezeMult}`);
              } else {
                console.log(`  📊 [LSR] ${symbol} — retail bullish (${lr.toFixed(1)}% long) → kontrarian short bias`);
              }
            } else if (signal === "LONG" && lr > 65) {
              _squeezeMult = 0.8;
              console.log(`  ⚠️  [LSR] ${symbol} — retail previše long (${lr.toFixed(1)}%) → size ×0.8`);
            } else if (signal === "SHORT" && lr < 35) {
              _squeezeMult = 0.8;
              console.log(`  ⚠️  [LSR] ${symbol} — retail previše short (${lr.toFixed(1)}%) → size ×0.8`);
            } else {
              console.log(`  📊 [LSR] ${symbol} — retail ${lr.toFixed(1)}% long (neutral, trend: ${lsr.trend})`);
            }
          }
        }


        // ── Cooldown provjera: 4h pauza po simbolu nakon SL-a ──────────────
        const lastSl = symbolSlCooldown.get(symbol);
        if (lastSl && (Date.now() - lastSl) < SL_COOLDOWN_MS) {
          const remainMin = Math.ceil((SL_COOLDOWN_MS - (Date.now() - lastSl)) / 60000);
          console.log(`  🕐 [${pDef.name}] ${symbol} — cooldown aktivan, još ${remainMin}min (SL bio ${Math.round((Date.now()-lastSl)/60000)}min nazad)`);
          continue;
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
          // Momentum ulaz → preskoči S/R SL, koristi ATR direktno (breakout nema smisla ispod prethodnog S/R-a)
          if (result.isMomentum && atrTrend?.currentAtr > 0) {
            const rawSlPct = (atrTrend.currentAtr * 1.2 / price) * 100;  // tijesan ATR SL za momentum
            const rawTpPct = (atrTrend.currentAtr * 3.5 / price) * 100;  // veći TP — ride the trend
            slPct = Math.min(Math.max(rawSlPct, tierSlMin), tierSlMax);
            tpPct = Math.min(Math.max(rawTpPct, tierTpMin), tierTpMax);
            sl = signal === "LONG" ? price * (1 - slPct / 100) : price * (1 + slPct / 100);
            tp = signal === "LONG" ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
            slMethod = "MOM-ATR";
            console.log(`  🚀 [MOM-SL] ${symbol} MOMENTUM: SL ${slPct.toFixed(2)}% TP ${tpPct.toFixed(2)}% RR=${( tpPct/slPct).toFixed(1)}x`);
          }

          // 00. Strategy override — RANGE/SWEEP donose vlastiti SL/TP (rub zone / sweep ekstrem)
          if (slMethod === "tier" && result._slPrice && result._tpPrice) {
            const _oSlPct = Math.abs(price - result._slPrice) / price * 100;
            if (_oSlPct >= 0.5 && _oSlPct <= 4.5) {
              sl = result._slPrice; slPct = _oSlPct;
              tp = result._tpPrice; tpPct = Math.abs(tp - price) / price * 100;
              slMethod = result._strategy ?? "STRAT";
              console.log(`  🎪 [${result._strategy}] ${symbol} ${signal}: SL ${fmtPrice(sl)} (${slPct.toFixed(2)}%) | TP ${fmtPrice(tp)} (${tpPct.toFixed(2)}%) RR=${(tpPct/slPct).toFixed(1)}x`);
            }
          }

          // 0. HTF zone SL — TraderaEdge stil: stop ispod likvidnosne zone (PWL,
          //    monthly low, weekly/monthly open...), dublje i teže za sweep od 15m pivota.
          //    Najbliža zona ispod cijene (LONG) / iznad (SHORT), do max 4% udaljenosti.
          if (slMethod === "tier" && result._zonesSL) {
            const HTF_SL_MAX = 4.0;
            const _z = result._zonesSL;
            const _htfCands = (signal === "LONG"
              ? [_z.pwl, _z.monthlyLow, _z.weeklyOpen, _z.monthlyOpen, _z.fridayClose, _z.yearlyOpen].filter(v => v != null && v > 0 && v < price).sort((a, b) => b - a)
              : [_z.pwh, _z.monthlyHigh, _z.weeklyOpen, _z.monthlyOpen, _z.fridayClose, _z.yearlyOpen].filter(v => v != null && v > 0 && v > price).sort((a, b) => a - b));
            for (const _zone of _htfCands) {
              const _zSlPrice = signal === "LONG" ? _zone * (1 - SR_BUFFER) : _zone * (1 + SR_BUFFER);
              const _zSlPct = Math.abs(price - _zSlPrice) / price * 100;
              if (_zSlPct >= tierSlMin && _zSlPct <= HTF_SL_MAX) {
                slPct = _zSlPct;
                tpPct = Math.min(Math.max(slPct * 2.5, tierTpMin), tierTpMax);
                sl = _zSlPrice;
                tp = signal === "LONG" ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
                slMethod = "HTF";
                console.log(`  🏛️  [HTF-SL] ${symbol} ${signal}: zona @ ${fmtPrice(_zone)} → SL ${fmtPrice(sl)} (${slPct.toFixed(2)}%) | TP ${fmtPrice(tp)} (${tpPct.toFixed(2)}%) RR=${(tpPct/slPct).toFixed(1)}x`);
                break;
              }
            }
          }

          // 1. Pokušaj S/R-based SL (za pullback signale)
          const srLevel = slMethod === "tier" ? (signal === "LONG" ? result.nearSup : result.nearRes) : null;
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

        // ── Dinamički TP — BTC Regime ─────────────────────────────────────────
        // JAKO: BTC Regime BULL+LONG ili BEAR+SHORT → TP × 3 (1:3 R:R)
        // NORMALNO: NEUTRAL ili kontra → TP × 2.0 (1:2 R:R)
        // 4H RSI ekstrem isključuje JAKO — overbought/oversold bull nije "jako", nego KASNO
        // tržište (post-mortem 05.07.: RSI 71.6 + JAKO → TP ×3 na vrhu poteza)
        const _rsi4h = _regimeCache?.btcRsi4h ?? 50;
        const _rsiOkForStrong = signal === "LONG" ? _rsi4h < 70 : _rsi4h > 30;
        // Tjedni EMA makro-faza mora biti usklađena (27.07.): "vaznije biti na pravoj
        // strani dugorocnog trenda" — JAKO LONG samo u tjednoj BULL fazi, SHORT u BEAR fazi
        const _weeklyPhase = pDef.params._weeklyBullPhase;
        const _weeklyOkForStrong = _weeklyPhase === null ? true
          : (signal === "LONG" ? _weeklyPhase === true : _weeklyPhase === false);
        const _isStrong = _rsiOkForStrong && _weeklyOkForStrong &&
                          ((_btcRegime === "BULL" && signal === "LONG") ||
                           (_btcRegime === "BEAR" && signal === "SHORT"));
        if (!_rsiOkForStrong) console.log(`  ⚠️  [RSI-4H] ${symbol} — BTC 4H RSI ${_rsi4h.toFixed(1)} ekstrem → nije JAKO (TP ×2, standardni rizik)`);
        if (_rsiOkForStrong && !_weeklyOkForStrong) console.log(`  ⚠️  [W-EMA] ${symbol} — tjedna makro-faza suprotna signalu → nije JAKO (TP ×2, standardni rizik)`);
        const _tpMult     = _isStrong ? STRONG_TP_MULT : NORMAL_TP_MULT;
        const _dynTpPct   = slPct * _tpMult;
        const signalStrength = _isStrong ? "strong" : "normal";

        if (_dynTpPct > tpPct && !result._tpPrice) {  // RANGE/SWEEP TP je vezan uz zonu — ne rastezati
          tpPct = _dynTpPct;
          tp    = signal === "LONG" ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
        }

        if (_isStrong) {
          console.log(`  💪 [JAKO] ${symbol} — Regime:${_btcRegime} + ${signal} → TP ×3 = ${tpPct.toFixed(2)}% | RR 1:${(tpPct/slPct).toFixed(1)}`);
        } else {
          console.log(`  📊 [NORMALNO] ${symbol} — Regime:${_btcRegime} → TP ×2 = ${tpPct.toFixed(2)}% | RR 1:${(tpPct/slPct).toFixed(1)}`);
        }

        // Risk-based position sizing: SL gubitak = dinamički 0.5–1.5% equity
        // 1.5% — regime aligned (JAKO) + score ≥ minSig+2 | 0.5% — minimalni score | 1.0% — ostalo
        const startCap   = pDef.startCapital ?? START_CAPITAL;
        const equity     = getPortfolioEquity(pid, startCap);

        const _entryScore  = signal === "LONG" ? (result.bullScore ?? 0) : (result.bearScore ?? 0);
        const _comboMinSig = SYMBOL_COMBOS[symbol]?.minSig ?? 5;
        let _dynRiskPct;
        if      (_isStrong && _entryScore >= _comboMinSig + 2) _dynRiskPct = RISK_PCT_MAX;
        else if (_entryScore <= _comboMinSig)                  _dynRiskPct = RISK_PCT_MIN;
        else                                                   _dynRiskPct = RISK_PCT;
        const _symRiskPct = rules.symbol_sltp?.[symbol]?.riskPct ?? _dynRiskPct;
        const riskAmount = equity * (_symRiskPct / 100);
        console.log(`  🎚️  [RISK] ${symbol} — score ${_entryScore}/${SYMBOL_COMBOS[symbol]?.sigIdx?.length ?? 8}, ${_isStrong ? "JAKO" : "normalno"} → rizik $${riskAmount.toFixed(2)} (${_symRiskPct}% banke)`);
        // Ukupni size mult (macro + stable + vwap + oi) ne smije pasti ispod 0.5
        // — inače stack multiplikatora spusti rizik daleko ispod RISK_PCT_MIN
        const _rawMult   = (atrTrend?.sizeMult ?? 1) * (_oiSizeMult ?? 1) * (_vwapSizeMult ?? 1) * (_stableSizeMult ?? 1) * (_macroSizeMult ?? 1);
        const _totalMult = Math.max(_rawMult, 0.5) * (_squeezeMult ?? 1) * (_whaleMult ?? 1);  // squeeze/whale idu iznad floora
        let tradeSize  = (riskAmount / (slPct / 100)) * _totalMult;
        if (_rawMult < 1) console.log(`  ⚖️  [MULT] ${symbol} — kombinirani mult ×${_rawMult.toFixed(2)}${_rawMult < 0.5 ? " → floor ×0.50" : ""}`);
        // Minimum: Bitget minTradeNum + $40 notional floor (margina ≥ ~$1 na 33-52x)
        // — ispod toga fee pojede dobit, a nalozi < min qty padaju s 45110/45111
        const _minQtyNotional = (_minTradeNum[symbol] ?? 0) * price * 1.05;
        const _minNotional = Math.max(40, _minQtyNotional);
        if (tradeSize < _minNotional) {
          console.log(`  📏 [MIN] ${symbol} — size $${tradeSize.toFixed(0)} < $${_minNotional.toFixed(0)} (minQty ${_minTradeNum[symbol] ?? "?"}) → podignut na minimum`);
          tradeSize = _minNotional;
        }
        const margin     = tradeSize / LEVERAGE;  // preliminarno — ažurira se nakon setupSymbol

        if (!checkDailyLimit(pid)) {
          console.log(`  ❌ [${pDef.name}] Dnevni limit dostignut`);
          continue;
        }

        const isLive    = pDef.live === true && !PAPER_TRADING;
        const _isPyramid = existingPos && existingPos.side === signal;

        console.log(`🎯 [${pDef.name}] ${_isPyramid?"🔺 PYRAMID":"NEW"} ${signal} ${symbol} @ ${fmtPrice(price)} | SL ${fmtPrice(sl)} | TP ${fmtPrice(tp)} | $${tradeSize.toFixed(0)}`);

        // ── PYRAMID: merged avg entry, single SL/TP na BitGetu ──────────────────
        if (_isPyramid) {
          const pyramidResult = await addToPyramid(pid, existingPos, signal, tradeSize, slPct, tpPct, isLive, symSltp);
          if (pyramidResult) {
            _newEntriesThisScan++;
            // CSV zapis pyramid adicije (za povijest)
            writeCsv(pid, {
              symbol, side: signal,
              price: fmtPrice(pyramidResult.avgEntry), sl: fmtPrice(pyramidResult.newSl), tp: fmtPrice(pyramidResult.newTp),
              quantity: pyramidResult.totalQty.toFixed(4), totalUSD: (existingPos.totalUSD + tradeSize).toFixed(2),
              notes: `PYRAMID +${existingPosList.length + 1} | avg entry ${fmtPrice(pyramidResult.avgEntry)} | SL ${slPct.toFixed(1)}% TP ${tpPct.toFixed(1)}%`,
              orderId: `${isLive?"LIVE":"PAPER"}-PYR-${Date.now()}`,
              mode: isLive ? (BITGET_DEMO ? "DEMO" : "LIVE") : "PAPER",
            });
          }
          continue;  // Ne prolazimo kroz normalni entry flow
        }

        // ── NOVI ulaz (nije pyramid) ─────────────────────────────────────────────
        const timestamp = new Date().toISOString();
        const orderId   = `${isLive ? "LIVE" : "PAPER"}-${Date.now()}`;
        const mode      = isLive ? (BITGET_DEMO ? "DEMO" : "LIVE") : "PAPER";
        const entry = { symbol, signal, price, sl, tp, tradeSize, margin, orderId, timestamp, strategy: pDef.strategy, timeframe: pDef.timeframe, slPct, tpPct, mode, sigMask: result.sigMask ?? null, entryMode: result.isMomentum ? "MOM" : "PBK", signalStrength, vipSlot: result._vipSlot === true };

        const _strengthEmoji = signalStrength === "strong" ? "💪" : "📊";
        const _rrLabel = `RR 1:${(tpPct/slPct).toFixed(1)}`;
        const _vipTag = entry.vipSlot ? " ⭐VIP" : "";

        if (!isLive) {
          addPosition(pid, entry);
          writeEntryCsv(pid, entry);
          _newEntriesThisScan++;
          _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: "ENTERED", reason: `${result.isMomentum?"MOM":"PBK"} ulaz @ ${fmtPrice(price)} SL ${fmtPrice(sl)} TP ${fmtPrice(tp)}`, vwapDist: result.vwap ? ((price-result.vwap)/result.vwap*100).toFixed(2) : null });
          // Dinamički leverage: zone-based SL → getSafeLeverage izračunava; tier SL → fiksni
          const _dynLev = slMethod === "tier" ? (symSltp.leverage ?? null) : null;
          const _displayLev = _dynLev ?? getSafeLeverage(slPct);
          await tg(`📋 PAPER [${pDef.name}/${pDef.timeframe}] ${signal === "LONG" ? "📈" : "📉"} <b>${signal} ${symbol}</b> ${_strengthEmoji}${_vipTag}\nUlaz: ${fmtPrice(price)} | SL: ${fmtPrice(sl)} (${slPct.toFixed(1)}%) | TP: ${fmtPrice(tp)} (${tpPct.toFixed(1)}%) | ${_rrLabel}\nEquity: $${equity.toFixed(2)} | Risk: $${riskAmount.toFixed(2)} | Notional: $${tradeSize.toFixed(0)} | Margin: $${margin.toFixed(2)} | ${_displayLev}x [${slMethod}]`);
        } else {
          try {
            const _dynLev = slMethod === "tier" ? (symSltp.leverage ?? null) : null;
            const order = await placeBitGetOrder(symbol, signal, tradeSize, price, sl, tp, slPct, tpPct, _dynLev);
            const usedLev    = order?.actualLeverage || LEVERAGE;
            const usedMargin = tradeSize / usedLev;
            entry.orderId    = order?.orderId || orderId;
            entry.margin     = usedMargin;
            // Koristi SL/TP izračunate od stvarne fill cijene (ne signal cijene)
            if (order?.slFromFill) entry.sl = order.slFromFill;
            if (order?.tpFromFill) entry.tp = order.tpFromFill;
            if (order?.fillPrice)  entry.entryPrice = order.fillPrice;
            if (order?.fillQty)    entry.quantity   = order.fillQty;
            addPosition(pid, entry);
            writeEntryCsv(pid, entry);
            _newEntriesThisScan++;
            console.log(`  ✅ LIVE NALOG [${pDef.name}] — ${entry.orderId}`);
            await tg(`🔴 LIVE [${pDef.name}/${pDef.timeframe}] ${signal === "LONG" ? "📈" : "📉"} <b>${signal} ${symbol}</b> ${_strengthEmoji}${_vipTag}\nUlaz: ${fmtPrice(price)} | SL: ${fmtPrice(sl)} (${slPct.toFixed(1)}%) | TP: ${fmtPrice(tp)} (${tpPct.toFixed(1)}%) | ${_rrLabel}\nEquity: $${equity.toFixed(2)} | Risk: $${riskAmount.toFixed(2)} | Notional: $${tradeSize.toFixed(0)} | Margin: $${usedMargin.toFixed(2)} | ${usedLev}x`);
          } catch (err) {
            console.log(`  ❌ LIVE NALOG PAO — ${err.message}`);
            await tg(`❌ LIVE GREŠKA [${pDef.name}] ${symbol}\n${err.message}`);
          }
        }

      } catch (err) {
        console.log(`  ❌ [${pDef.name}] ${symbol}: ${err.message}`);
        _scanLogEntries.push({ symbol, signal: "ERROR", blocker: "ERROR", reason: err.message });
      }
    }

    // Piši scan log jednom po scan ciklusu
    if (_scanLogEntries.length > 0) {
      try { writeScanLog(_scanLogEntries); } catch (_) {}
    }
  }

  // Čisti stari log jednom dnevno (ujutro)
  if (new Date().getUTCHours() === 6 && new Date().getUTCMinutes() < 10) {
    try { cleanScanLog(); } catch (_) {}
  }

  // Tjedna analiza — ponedjeljak 08:00 UTC (10:00 HR), jednom tjedno (guard fajl)
  {
    const _nw = new Date();
    if (_nw.getUTCDay() === 1 && _nw.getUTCHours() === 8) {
      const _wf = `${DATA_DIR}/weekly_report_last.txt`;
      const _today = _nw.toISOString().slice(0, 10);
      let _last = null;
      try { _last = readFileSync(_wf, "utf8").trim(); } catch {}
      if (_last !== _today) {
        try { writeFileSync(_wf, _today); await generateWeeklyAnalysis(); } catch (_) {}
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

// ─── Daily MM/Algo Report ─────────────────────────────────────────────────────
// Generira se automatski svaki dan u 07:00 UTC iz dashboard.js schedulera.
// Sprema se u DATA_DIR/daily_reports/YYYY-MM-DD.md i latest.md
// Šalje se na Telegram kao jutarnji brief.

const REPORT_SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","TAOUSDT","AAVEUSDT"];

function _parseTradeCsv(days = 7) {
  const pid = "synapse_t";
  const f   = csvFilePath(pid);
  if (!existsSync(f)) return null;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  let total = 0, wins = 0, longs = 0, shorts = 0;
  let totalWinUsd = 0, totalLossUsd = 0, winCount = 0, lossCount = 0;
  const slBySymbol = {}, slByHour = {};

  const lines = readFileSync(f, "utf8").trim().split("\n");
  for (let i = 1; i < lines.length; i++) {
    // CSV cols: Date,Time(UTC),Exchange,Symbol,Side,Qty,Price,TotalUSD,Fee,NetP&L,SL,TP,...
    const cols = lines[i].split(",");
    if (cols.length < 10) continue;
    const side = cols[4]?.trim();
    // Uzimamo samo exit redove (CLOSE_LONG / CLOSE_SHORT)
    if (!side?.startsWith("CLOSE")) continue;
    const dateStr = cols[0]?.trim(), timeStr = cols[1]?.trim();
    if (!dateStr || !timeStr) continue;
    const ts = new Date(`${dateStr}T${timeStr}Z`).getTime();
    if (isNaN(ts) || ts < cutoff) continue;

    const symbol = cols[3]?.trim();
    const netPnl = parseFloat(cols[9]);
    if (isNaN(netPnl)) continue;

    total++;
    if (side === "CLOSE_LONG")  longs++;
    else                        shorts++;

    if (netPnl >= 0) {
      wins++; winCount++; totalWinUsd += netPnl;
    } else {
      lossCount++; totalLossUsd += Math.abs(netPnl);
      if (symbol) slBySymbol[symbol] = (slBySymbol[symbol] || 0) + 1;
      const hour = timeStr.slice(0, 2);
      slByHour[hour] = (slByHour[hour] || 0) + 1;
    }
  }

  const wr      = total > 0 ? (wins / total * 100).toFixed(1) : "N/A";
  const avgWin  = winCount   > 0 ? (totalWinUsd  / winCount).toFixed(2)  : "0";
  const avgLoss = lossCount  > 0 ? (totalLossUsd / lossCount).toFixed(2) : "0";
  const rr      = lossCount > 0 && winCount > 0 ? (totalWinUsd/winCount / (totalLossUsd/lossCount)).toFixed(2) : "N/A";

  const topSlSyms  = Object.entries(slBySymbol).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topSlHours = Object.entries(slByHour).sort((a,b)=>b[1]-a[1]).slice(0,3)
    .map(([h,n]) => `${h}:00 UTC (${n}×)`);

  return { total, wins, longs, shorts, wr, avgWin, avgLoss, rr, topSlSyms, topSlHours };
}

function _analyzeMMPhase(sym, candles) {
  if (!candles || candles.length < 22)
    return { sym, phase:"N/A", volRatio:"—", threshold:"—", rsi:50, dir:"—", trend:"—", price:0 };

  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);
  const n      = candles.length;

  // Vol ratio: zadnja svjeća vs avg20 prethodnih
  const avg20   = vols.slice(-21, -1).reduce((a,b)=>a+b,0) / 20;
  const lastVol = vols[n-1];
  const volRatio = avg20 > 0 ? lastVol / avg20 : 1;

  const threshold = VOL_EXH_TIERS[sym] ?? VOL_EXH_DEFAULT;

  // MM faza
  let phase;
  if      (volRatio < 0.5)         phase = "AKUMULACIJA";
  else if (volRatio < 1.2)         phase = "NEUTRALNO";
  else if (volRatio < threshold)   phase = "MARKUP";
  else if (volRatio < 3.5)         phase = "DISTRIBUCIJA";
  else                             phase = "CRASH/PANIC";

  // RSI (Wilder, 14)
  const rsiArr = _rsiSeries(closes, 14);
  const rsi    = Math.round(rsiArr[n-1] ?? 50);

  // ADX approximation — avg directional movement zadnjih 14 barova
  let dmPlus = 0, dmMinus = 0, tr14 = 0;
  for (let i = Math.max(1, n-14); i < n; i++) {
    const high = candles[i].high, low = candles[i].low;
    const phigh = candles[i-1].high, plow = candles[i-1].low, pclose = candles[i-1].close;
    const dm_p = high - phigh > plow - low ? Math.max(high - phigh, 0) : 0;
    const dm_m = plow - low > high - phigh ? Math.max(plow - low, 0) : 0;
    const trueRange = Math.max(high - low, Math.abs(high - pclose), Math.abs(low - pclose));
    dmPlus += dm_p; dmMinus += dm_m; tr14 += trueRange;
  }
  const di_p = tr14 > 0 ? (dmPlus  / tr14) * 100 : 0;
  const di_m = tr14 > 0 ? (dmMinus / tr14) * 100 : 0;
  const adxApprox = (di_p + di_m) > 0 ? Math.round(Math.abs(di_p - di_m) / (di_p + di_m) * 100) : 0;

  const lastC  = candles[n-1];
  const dir    = lastC.close > lastC.open ? "BULL" : "BEAR";
  const ema50v = closes.slice(-50).reduce((a,b)=>a+b,0) / Math.min(50, n);
  const trend  = lastC.close > ema50v ? "↑" : "↓";

  return {
    sym, phase,
    volRatio: volRatio.toFixed(2),
    threshold,
    rsi, adx: adxApprox,
    dir, trend,
    price: lastC.close,
  };
}

function _buildReport(dateStr, stats, symReports) {
  const phaseEmoji = {
    "AKUMULACIJA": "🔵", "NEUTRALNO": "⬜", "MARKUP": "🟡",
    "DISTRIBUCIJA": "🔴", "CRASH/PANIC": "💥", "N/A": "❓",
  };

  // Grupiraj po fazi
  const byPhase = {};
  for (const r of symReports) {
    if (r.error) continue;
    (byPhase[r.phase] = byPhase[r.phase] || []).push(r);
  }
  const accum  = byPhase["AKUMULACIJA"] || [];
  const markup = byPhase["MARKUP"]      || [];
  const distrib = (byPhase["DISTRIBUCIJA"] || []).concat(byPhase["CRASH/PANIC"] || []);

  // Strategy verdict
  const wrNum  = parseFloat(stats?.wr);
  const rrNum  = parseFloat(stats?.rr);
  let verdict, verdictReason;
  if (!stats || stats.total < 3) {
    verdict = "HOLD"; verdictReason = "premalo podataka za procjenu";
  } else if (wrNum >= 45 && rrNum >= 1.0) {
    verdict = "HOLD"; verdictReason = `WR ${stats.wr}% + R:R ${stats.rr} — strategija radi`;
  } else if (wrNum < 35) {
    verdict = "ADJUST"; verdictReason = `WR ${stats.wr}% prenisko — razmatraj filtere`;
  } else if (rrNum < 0.7) {
    verdict = "ADJUST"; verdictReason = `R:R ${stats.rr} prenizak — gubitak veći od dobitka`;
  } else {
    verdict = "HOLD"; verdictReason = `WR ${stats.wr}% prihvatljivo, pratimo`;
  }

  // ── Telegram message (max ~2000 char) ──────────────────────────────────────
  let tgMsg = `📊 <b>ULTRA Jutarnji Brief — ${dateStr}</b>\n\n`;

  if (stats && stats.total > 0) {
    tgMsg += `📈 <b>Performance (7 dana)</b>\n`;
    tgMsg += `Tradovi: ${stats.total} (L:${stats.longs}/S:${stats.shorts}) | WR: <b>${stats.wr}%</b> | R:R: <b>${stats.rr}</b>\n`;
    tgMsg += `Avg Win: +$${stats.avgWin} | Avg Loss: -$${stats.avgLoss}\n`;
    if (stats.topSlSyms.length)
      tgMsg += `⚠️ Top SL: ${stats.topSlSyms.map(([s,n])=>`${s.replace("USDT","")}(${n})`).join(", ")}\n`;
    if (stats.topSlHours.length)
      tgMsg += `🕐 MM sweep: ${stats.topSlHours.join(", ")}\n`;
    tgMsg += "\n";
  } else {
    tgMsg += `📈 <b>Performance:</b> nema zatvorenih tradova u zadnjih 7 dana\n\n`;
  }

  tgMsg += `🎯 <b>MM Faze (1H trenutno)</b>\n`;
  for (const [phase, syms] of Object.entries(byPhase)) {
    if (!syms.length) continue;
    tgMsg += `${phaseEmoji[phase]||"⬜"} <b>${phase}</b>: ${syms.map(r=>r.sym.replace("USDT","")).join(", ")}\n`;
  }
  tgMsg += "\n";

  if (accum.length)
    tgMsg += `🟢 Prati za ulaz: ${accum.map(r=>`${r.sym.replace("USDT","")}(RSI:${r.rsi} ${r.trend})`).join(", ")}\n`;
  if (markup.length)
    tgMsg += `🟡 Bot aktivan: ${markup.map(r=>r.sym.replace("USDT","")).join(", ")}\n`;
  if (distrib.length)
    tgMsg += `🔴 Izbjegavaj: ${distrib.map(r=>`${r.sym.replace("USDT","")}(${r.volRatio}×)`).join(", ")}\n`;

  tgMsg += `\n⚖️ Strategija: <b>${verdict}</b> — ${verdictReason}`;

  // ── Markdown report ────────────────────────────────────────────────────────
  let md = `# ULTRA Daily MM/Algo Report — ${dateStr}\n`;
  md += `**Generirano:** ${new Date().toISOString()} UTC\n\n`;

  // Performance
  md += `## 📈 Performance (zadnjih 7 dana)\n\n`;
  if (stats && stats.total > 0) {
    md += `| Metrika | Vrijednost |\n|---|---|\n`;
    md += `| Ukupno tradova | ${stats.total} |\n`;
    md += `| LONG / SHORT | ${stats.longs} / ${stats.shorts} |\n`;
    md += `| **Win Rate** | **${stats.wr}%** |\n`;
    md += `| **R:R** | **${stats.rr}** |\n`;
    md += `| Avg Win | +$${stats.avgWin} |\n`;
    md += `| Avg Loss | -$${stats.avgLoss} |\n\n`;
    if (stats.topSlSyms.length) {
      md += `### Top SL simboli\n`;
      md += stats.topSlSyms.map(([s,n])=>`- ${s}: ${n} SL hit`).join("\n") + "\n\n";
    }
    if (stats.topSlHours.length) {
      md += `### MM Sweep sati (UTC)\n`;
      md += stats.topSlHours.map(h=>`- ${h}`).join("\n") + "\n\n";
    }
  } else {
    md += `_Nema zatvorenih tradova u zadnjih 7 dana._\n\n`;
  }

  // Symbol MM table
  md += `## 📊 MM Faze svih simbola\n\n`;
  md += `| Simbol | Faza | Vol/Avg20 | Threshold | RSI | ADX | Smjer | vs EMA50 |\n`;
  md += `|--------|------|-----------|-----------|-----|-----|-------|----------|\n`;
  for (const r of symReports) {
    if (r.error) { md += `| ${r.sym} | ❌ ERROR | — | — | — | — | — | — |\n`; continue; }
    const e = phaseEmoji[r.phase] || "⬜";
    md += `| ${r.sym} | ${e} ${r.phase} | ${r.volRatio}× | ${r.threshold}× | ${r.rsi} | ${r.adx} | ${r.dir} | ${r.trend} |\n`;
  }
  md += "\n";

  // Preporuke
  md += `## 🎯 Preporuke\n\n`;
  if (accum.length)  md += `**🟢 Prati za ulaz (akumulacija):** ${accum.map(r=>r.sym).join(", ")}\n\n`;
  if (markup.length) md += `**🟡 Markup faza (bot radi):** ${markup.map(r=>r.sym).join(", ")}\n\n`;
  if (distrib.length) md += `**🔴 Izbjegavaj (distribucija/panic):** ${distrib.map(r=>r.sym).join(", ")}\n\n`;

  md += `## ⚖️ Zaključak\n\n`;
  md += `**Strategija: ${verdict}** — ${verdictReason}\n\n`;
  md += `---\n*Generirano automatski od ULTRA Bot v3 | ${dateStr} | 8 signala min 6/8 + BTC EMA50 4H filter*\n`;

  return { md, tg: tgMsg };
}

// ─── Tjedna analiza (TraderaEdge framework) — ponedjeljkom na Telegram ────────
// Mehanika njegove analize: trend (RSI) > cijena, tjedni close vs ključna razina,
// udaljenost do likvidnosnih zona, stanje akumulacije/distribucije + tjedni učinak bota.
export async function generateWeeklyAnalysis() {
  try {
    console.log(`📅 [Weekly] Generiranje tjedne analize...`);
    // 1. BTC tjedne svijeće — RSI trend i divergencija
    // Binance public (Bitget ima samo ~13 tjedana povijesti, premalo za RSI14)
    const wkB = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=120").then(r => r.json());
    const wCloses = wkB.map(k => parseFloat(k[4]));
    const rsiW    = calcRSI(wCloses, 14);
    const rsiW4   = calcRSI(wCloses.slice(0, -4), 14);  // prije 4 tjedna
    const pxNow   = wCloses[wCloses.length - 1];
    const px4     = wCloses[wCloses.length - 5];
    const trendTxt = rsiW > rsiW4 ? "jača" : "slabi";
    let divTxt = "nema jasne divergencije";
    if (pxNow > px4 && rsiW < rsiW4) divTxt = "⚠️ BEARISH divergencija (cijena ↑, RSI ↓) — snaga impulsa opada";
    if (pxNow < px4 && rsiW > rsiW4) divTxt = "🟢 BULLISH divergencija (cijena ↓, RSI ↑) — prodavači se troše";

    // 2. Ključna razina (tjedni close vs 60k)
    const wkKey = await getBtcWeeklyVsKey();
    const keyTxt = wkKey.key
      ? (wkKey.belowKey
        ? `🔴 Tjedni close $${wkKey.lastClose?.toFixed(0)} ISPOD $${wkKey.key} — shorteri u dominaciji, zona ${(wkKey.key*0.97/1000).toFixed(0)}-${(wkKey.key*0.8/1000).toFixed(0)}k u igri`
        : `🟢 Tjedni close $${wkKey.lastClose?.toFixed(0)} iznad $${wkKey.key} — bulls vladaju, akumulacija`)
      : "ključna razina nije postavljena";
    const distKey = wkKey.key ? ((pxNow - wkKey.key) / pxNow * 100) : null;

    // 3. Daily kontekst
    const dEma = await getBtcDailyEma10();
    const _fgRaw = await getFearGreed().catch(() => null);
    const fg   = (_fgRaw && typeof _fgRaw === "object") ? (_fgRaw.value ?? null) : _fgRaw;

    // 4. Tjedni učinak bota (CSV exits zadnjih 7 dana)
    let botTxt = "nema tradeova";
    try {
      const f = csvFilePath("synapse_t");
      if (existsSync(f)) {
        const wkAgo = Date.now() - 7 * 24 * 3600 * 1000;
        const exits = readFileSync(f, "utf8").trim().split("\n").slice(1)
          .filter(l => (l.includes("CLOSE_LONG") || l.includes("CLOSE_SHORT")))
          .filter(l => { const t = new Date(l.split(",")[0]).getTime(); return isFinite(t) && t >= wkAgo; });
        const pnls = exits.map(l => parseFloat(l.split(",")[9] || 0)).filter(isFinite);
        const w = pnls.filter(p => p >= 0).length, lo = pnls.length - w;
        const net = pnls.reduce((a, b) => a + b, 0);
        if (pnls.length) botTxt = `${w}W/${lo}L (WR ${(w/pnls.length*100).toFixed(0)}%) · net ${net >= 0 ? "+" : ""}$${net.toFixed(2)}`;
      }
    } catch {}

    // 5. Playbook — pravila iz TraderaEdge framework-a
    const play = [];
    if (wkKey.key && !wkKey.belowKey) play.push(`• LONG bias; BTC trend SHORT blokiran do tjednog closea ispod $${wkKey.key}`);
    if (wkKey.key && wkKey.belowKey)  play.push(`• SHORT režim aktivan; pazi na fakeout — sweep $${wkKey.key} + reclaim = LONG (SWEEP strategija spremna)`);
    if (distKey !== null && Math.abs(distKey) < 3) play.push(`• Cijena ${Math.abs(distKey).toFixed(1)}% od ključne razine — SWEEP scenarij u dometu`);
    if (dEma.above === false) play.push(`• BTC ispod daily EMA10 — alt LONG blokiran, čekaj reclaim`);
    if (fg !== null && fg <= 25) play.push(`• Fear ${fg} — bounce rizik za shortove (bounce mode štiti)`);
    if (rsiW < 40 && pxNow < px4) play.push(`• Tjedni RSI ${rsiW.toFixed(0)} nisko + cijena pada — zona interesa za akumulaciju (TraderaEdge DCA logika)`);
    // Sanity check ključne razine — podsjetnik da je ručna i treba li je osvježiti
    if (wkKey.key) {
      const _minW12 = Math.min(...wCloses.slice(-12));
      if (distKey !== null && Math.abs(distKey) > 20) play.push(`• ⚠️ Cijena ${Math.abs(distKey).toFixed(0)}% od ključne razine $${wkKey.key} — razina možda zastarjela, provjeri novu TraderaEdge analizu`);
      play.push(`• Info: min tjedni close (12 tj.): $${_minW12.toFixed(0)} · ključna razina $${wkKey.key} je ručna (iz analize)`);
    }

    const msg = `📅 <b>TJEDNA ANALIZA</b> (${new Date().toISOString().slice(0,10)})\n\n` +
      `<b>₿ BTC:</b> $${pxNow.toFixed(0)}\n` +
      `Tjedni RSI: ${rsiW.toFixed(1)} (${trendTxt} vs prije 4 tjedna)\n${divTxt}\n\n` +
      `<b>Ključna razina:</b>\n${keyTxt}\n` +
      (distKey !== null ? `Udaljenost: ${distKey >= 0 ? "+" : ""}${distKey.toFixed(1)}%\n` : "") +
      `Daily EMA10: ${dEma.above === null ? "?" : dEma.above ? "iznad ✅" : "ispod ❌"} · F&G: ${fg ?? "?"}\n\n` +
      `<b>🤖 Bot ovaj tjedan:</b> ${botTxt}\n\n` +
      `<b>📋 Playbook:</b>\n${play.join("\n") || "• Bez posebnih uvjeta — standardni režim"}`;
    await tg(msg);
    console.log(`📅 [Weekly] Poslano na Telegram`);
    return msg;
  } catch (e) {
    console.log(`⚠️ [Weekly] greška: ${e.message}`);
    return null;
  }
}

export async function generateDailyReport() {
  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  console.log(`📋 [Daily Report] Generiranje za ${dateStr}...`);

  // 1. Trade analiza
  const stats = _parseTradeCsv(7);

  // 2. MM skeniranje svih simbola (paralelno za brzinu)
  const symReports = await Promise.all(REPORT_SYMBOLS.map(async sym => {
    try {
      const candles = await fetchCandles(sym, "1H", 60);
      return _analyzeMMPhase(sym, candles);
    } catch (e) {
      console.log(`  ⚠️ [Daily Report] ${sym}: ${e.message}`);
      return { sym, error: e.message };
    }
  }));

  // 3. Build report
  const report = _buildReport(dateStr, stats, symReports);

  // 4. Spremi u fajl
  try {
    const reportDir = `${DATA_DIR}/daily_reports`;
    if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
    writeFileSync(`${reportDir}/${dateStr}.md`, report.md, "utf8");
    writeFileSync(`${reportDir}/latest.md`,    report.md, "utf8");
    console.log(`📋 [Daily Report] Spremen: ${reportDir}/${dateStr}.md`);
  } catch (e) {
    console.log(`  ⚠️ [Daily Report] Greška pri pisanju fajla: ${e.message}`);
  }

  // 5. Telegram
  try { await tg(report.tg); } catch (e) {
    console.log(`  ⚠️ [Daily Report] Telegram greška: ${e.message}`);
  }

  return report.md;
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
