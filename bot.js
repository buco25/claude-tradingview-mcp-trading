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
const RISK_PCT      = 1.5;    // % banke koji rizikaš po tradeu (= veličina uloga/margine)
const SL_PCT        = 2.0;    // fallback SL % (Tier 1) — override per-simbol u symbol_sltp
const TP_PCT        = 3.0;    // fallback TP % (Tier 1, 1.5×SL) — override per-simbol u symbol_sltp

// ─── Dinamički TP — tržišni uvjeti (BTC Regime) ───────────────────────────────
// JAKO: BTC Regime BULL + signal LONG, ili BEAR + signal SHORT → TP = SL × 3 (1:3 R:R)
// NORMALNO: BTC Regime NEUTRAL, ili regime ne podudara signal → TP = SL × 1.5 (1:1.5 R:R)
const STRONG_SIGNAL_SCORE = 9;    // nekorišten za TP (zadržan za eventualne filter provjere)
const STRONG_TP_MULT      = 3.0;  // jako tržište → TP = SL × 3 (1:3 R:R)
const NORMAL_TP_MULT      = 1.5;  // konsolidacija / neutralno → TP = SL × 1.5 (1:1.5 R:R)
const MAX_TRADES_PER_DAY = 100;
const MAX_OPEN_PER_PORTFOLIO = 3;  // max otvorenih pozicija po portfoliju
const MAX_PYRAMID           = 0;   // pyramid onemogućen (26.05.2026) — jedna pozicija po simbolu
const MAX_NEW_ENTRIES_PER_SCAN = 3; // max NOVIH ulaza po scan ciklusu (sprječava 8 simultanih gubitaka)

// ─── 7. Korelacijski filter — sektori ─────────────────────────────────────────
const SYMBOL_SECTORS = {
  "BTCUSDT":  "BTC",
  "ETHUSDT":  "OG_L1", "SOLUSDT": "OG_L1",
  "TAOUSDT":  "AI",
  "AAVEUSDT": "DEFI",
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
const SYMBOL_COMBOS = {
  "BTCUSDT":  { sigIdx: [0,1,2,3,7,8], minSig: 4 }, // E50↑+CVD↑+MACD+E145+FVG+OB  WR68%
  "ETHUSDT":  { sigIdx: [0,1,2,3,7,8], minSig: 4 }, // E50↑+CVD↑+MACD+E145+FVG+OB  WR67%
  "SOLUSDT":  { sigIdx: [0,1,3,5,6,8], minSig: 4 }, // E50↑+CVD↑+E145+RDIV+MSTR+OB WR67%
  "TAOUSDT":  { sigIdx: [0,1,3,5,6,8], minSig: 4 }, // E50↑+CVD↑+E145+RDIV+MSTR+OB WR50%
  "AAVEUSDT": { sigIdx: [0,1,2,3,7,8], minSig: 4 }, // E50↑+CVD↑+MACD+E145+FVG+OB  WR65%
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
    const closes = d.data.map(k => parseFloat(k[4])).reverse();
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
    })).reverse();  // najnoviji zadnji

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

// ─── 4. SIGNAL ANALIZA — prati koje signale bilježe pobjedu ──────────────────
// Svaki ulaz bilježi fingerprint aktivnih signala (bitmask)
// Čitamo nakon izlaza koji signal je bio aktivan i označavamo win/loss
// Svaka 10. analiza ispisuje per-signal WR u konzolu

const SIG_NAMES = ["E50⟳","RSI⟳","CHP","CVD⟳","R⟳","MCD","E145","MCC⟳","RSI↗","SRS","SRB"];
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

  // ── FIB 0.702 kontekstualni gate (soft) — Golden Ratio ───────────────────────
  // Iz videa: 0.702 je non-tradicionalni FIB. Ako cijena pada ispod 0.702 razine,
  // veliki je signal promjene trenda → blokiramo LONG (ne SHORT)
  // Računamo od recentnog swing high/low (zadnjih 100 bara)
  let _fib702Level = null, _fib702Bearish = false;
  {
    const FIB_LOOKBACK = 100;
    const fibStart = Math.max(0, n - FIB_LOOKBACK);
    const swHigh = Math.max(...candles.slice(fibStart).map(c => c.high));
    const swLow  = Math.min(...candles.slice(fibStart).map(c => c.low));
    if (swHigh > swLow) {
      _fib702Level = swHigh - (swHigh - swLow) * 0.702;
      _fib702Bearish = price < _fib702Level;
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
  const MIN_CONFIRM = _combo?.minSig ?? minSig;

  // ══ OBAVEZNI GATEVI (3) ══

  // 1. ADX ≥ effectiveAdx — tržište mora biti u jasnom trendu
  if (adx < effectiveAdx) {
    return { price, signal: "NEUTRAL", bullScore: bullCnt, bearScore: bearCnt,
      reason: `ADX ${adx.toFixed(1)} < ${effectiveAdx} — ranging, nema ulaza` };
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

  // 5. FIB 0.702 Golden Ratio — soft gate za LONG
  // Iz SMC edukacije: ako cijena ispod 0.702 FIB razine, trend je promijenjen → blokira LONG
  // SHORT i dalje dozvoljen (breakdowns su validni ispod 0.702)
  if (_fib702Bearish && _fib702Level !== null) {
    const fibPct = ((_fib702Level - price) / price * 100).toFixed(1);
    console.log(`  📐 [FIB702] ${_sym} — cijena ${fibPct}% ispod Golden Ratio (${_fib702Level?.toFixed(2)}) → LONG blokiran`);
    // Blokira samo LONG pullback — SHORT i momentum SHORT i dalje prolaze
    if (bullScore >= minSig && (bearScore < minSig)) {
      return { price, signal: "NEUTRAL", bullScore, bearScore,
        reason: `FIB702 LONG blokiran: cijena ${fibPct}% ispod Golden Ratio ${_fib702Level?.toFixed(2)}` };
    }
  }

  // 6. VWAP crossover + potvrda
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

  if (bullScore >= MIN_CONFIRM && rsiLongOk) {
    if (!vwapVal || vwapVal <= 0) {
      return { price, signal: "NEUTRAL", bullScore, bearScore,
        reason: `PBK LONG blokiran: VWAP nedostupan` };
    }
    if (!_vwapLongOk) {
      const vd = ((price - vwapVal) / vwapVal * 100).toFixed(1);
      return { price, signal: "NEUTRAL", bullScore, bearScore, vwap: vwapVal,
        reason: `PBK LONG blokiran: nema VWAP crossover potvrde (cijena ${vd}% od VWAP)` };
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

  // ── Dohvati Previous Weekly High/Low (PWH/PWL) ────────────────────────────
  // Bitget: granularity=1W, limit=3 → data[0]=tekući tjedan, data[1]=prethodni
  let _pwh = null, _pwl = null;
  try {
    const wUrl = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1W&limit=3`;
    const wd = await fetch(wUrl).then(r => r.json());
    if (wd.code === "00000" && wd.data?.length >= 2) {
      const prevWeek = wd.data[1];  // index 1 = prethodni (dovršeni) tjedan
      _pwh = parseFloat(prevWeek[2]);  // high
      _pwl = parseFloat(prevWeek[3]);  // low
    }
  } catch(e) {
    console.log(`  ⚠️  [PWH/PWL] ${symbol} — ne mogu dohvatiti weekly candle: ${e.message}`);
  }

  // Pokreni analizu (proslijedi symbol + PWH/PWL za tiered VOL_EXH threshold)
  const result = analyzeUltra(candles, { ...cfg, symbol, _pwh, _pwl });

  if (result.signal === "LONG" || result.signal === "SHORT") {
    console.log(`  ✅ [ULTRA] ${symbol} ${result.signal} @ ${fmtPrice(price)} — (${result.bullScore ?? 0}↑/${result.bearScore ?? 0}↓)`);
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

          // Ako fill fetch nije uspio — izračunaj P&L iz SL/TP cijene koju znamo
          if (!closed) {
            console.warn(`  ⚠️  [${pid}] ${pos.symbol} — fill fetch nije uspio, računam P&L iz SL/TP cijene`);
            // Određujemo exit cijenu: SL ili TP (ovisno o smjeru pomaka)
            const _fallbackExit = pos.sl || pos.entryPrice;
            const _fallbackQty  = pos.quantity ?? (pos.totalUSD / pos.entryPrice);
            const _fallbackPnl  = pos.side === "LONG"
              ? (_fallbackExit - pos.entryPrice) * _fallbackQty
              : (pos.entryPrice - _fallbackExit) * _fallbackQty;
            const _maxLoss = pos.margin ? pos.margin * 1.1 : pos.totalUSD * 0.02;
            const _pnl = Math.max(_fallbackPnl, -_maxLoss);
            const _exitReason = _pnl >= 0 ? "TP/Trail" : "SL dostignut";
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

        // ── SOFT SL: bot zatvara na pravom SL (ghost stop bypass) ──────────────
        // pos.sl = pravi SL koji bot prati — BitGet ghost SL je 0.5% dalje (decoy)
        // Samo dok trail NIJE aktivan (trail sam pomiče SL pa nema potrebe za soft check)
        if (isLivePortfolio && pos.sl && !pos.trailActive && !pos.partialClosed) {
          const softSlHit = pos.side === "LONG" ? liveP <= pos.sl : liveP >= pos.sl;
          if (softSlHit) {
            console.log(`  🛑 [SOFT SL] ${pos.symbol} ${pos.side} — cijena ${fmtPrice(liveP)} ≤ SL ${fmtPrice(pos.sl)} → tržišni izlaz (ghost bypass)`);
            try {
              const hSide = pos.side === "LONG" ? "long" : "short";
              await bitgetPost("/api/v2/mix/order/place-order", {
                symbol: pos.symbol, productType: "USDT-FUTURES", marginMode: "isolated", marginCoin: "USDT",
                side: hSide === "long" ? "sell" : "buy", tradeSide: "close",
                orderType: "market", size: String(qty.toFixed(4)),
              });
              const pnl = pos.side === "LONG"
                ? (liveP - pos.entryPrice) * qty
                : (pos.entryPrice - liveP) * qty;
              writeExitCsv(pid, pos, liveP, "Soft SL — bot izlaz", pnl);
              await tg(`🛑 [SOFT SL] ${pos.symbol} ${pos.side}\nBot zatvorio na pravom SL ${fmtPrice(pos.sl)}\nEgzekucija: ${fmtPrice(liveP)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n(Ghost SL na BitGet ${pos.side === "LONG" ? "-" : "+"}0.5% nije bio vidljiv algoritmima)`);
              symbolSlCooldown.set(pos.symbol, Date.now());
              saveSlCooldown();
              await recordSymbolSl(pid, pos.symbol);
              await checkAndRemoveSymbol(pid, pos.symbol);
              if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, false);
              recordSymbolOutcome(pos.symbol, false);
              continue;
            } catch (e) {
              console.log(`  ⚠️  [SOFT SL] Greška zatvaranja ${pos.symbol}: ${e.message} — ostavljamo, ghost SL na BitGet aktivan`);
            }
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
const BE_TRIGGER_PCT = 50;   // % TP-a koji mora biti dostignut
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
  const closeSide = pos.side === "LONG" ? "sell" : "buy";
  try {
    const res = await bitgetPost("/api/v2/mix/order/place-order", {
      symbol: pos.symbol, productType: "USDT-FUTURES",
      marginMode: "isolated", marginCoin: "USDT",
      side: closeSide, tradeSide: "close",
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

        const slHit = pos.side === "LONG" ? liveP <= pos.sl : liveP >= pos.sl;
        const tpHit = pos.side === "LONG" ? liveP >= pos.tp : liveP <= pos.tp;

        if (!slHit && !tpHit) continue;

        const reason = slHit ? "SL" : "TP";
        const level  = slHit ? pos.sl : pos.tp;
        console.log(`  ${slHit ? "🛑" : "🎯"} [SOFT ${reason}] ${pos.symbol} ${pos.side} — cijena ${fmtPrice(liveP)} ${slHit ? "≤" : "≥"} ${reason} ${fmtPrice(level)} → zatvaramo`);

        try {
          const closeSide = pos.side === "LONG" ? "sell" : "buy";
          const qty = (pos.quantity ?? (pos.totalUSD / pos.entryPrice)).toFixed(4);
          const closeRes = await bitgetPost("/api/v2/mix/order/place-order", {
            symbol: pos.symbol, productType: "USDT-FUTURES",
            marginMode: "isolated", marginCoin: "USDT",
            side: closeSide, tradeSide: "close",
            orderType: "market", size: qty,
          });
          if (closeRes.code !== "00000") throw new Error(`${closeRes.code} ${closeRes.msg}`);

          const pnl = pos.side === "LONG"
            ? (liveP - pos.entryPrice) * parseFloat(qty)
            : (pos.entryPrice - liveP) * parseFloat(qty);

          // Ukloni poziciju iz trackinga
          const allPos = loadPositions(pid);
          savePositions(pid, allPos.filter(p => !(p.symbol === pos.symbol && p.side === pos.side)));

          if (slHit) {
            await tg(`🛑 <b>SOFT SL [ULTRA]</b> ${pos.symbol} ${pos.side}\nCijena: ${fmtPrice(liveP)} | SL: ${fmtPrice(pos.sl)}\nP&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n(Razina nije bila vidljiva na Bitgetu)`);
            symbolSlCooldown.set(pos.symbol, Date.now());
            saveSlCooldown();
            await recordSymbolSl(pid, pos.symbol);
            await checkAndRemoveSymbol(pid, pos.symbol);
            if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, false);
            recordSymbolOutcome(pos.symbol, false);
          } else {
            await tg(`🎯 <b>SOFT TP [ULTRA]</b> ${pos.symbol} ${pos.side}\nCijena: ${fmtPrice(liveP)} | TP: ${fmtPrice(pos.tp)}\nP&L: +$${pnl.toFixed(2)}\n(Razina nije bila vidljiva na Bitgetu)`);
            if (pos.sigMask != null) recordSignalOutcome(pos.sigMask, true);
            recordSymbolOutcome(pos.symbol, true);
          }
        } catch (e) {
          console.log(`  ❌ [SOFT ${reason}] ${pos.symbol} close greška: ${e.message}`);
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
  // Strategija: liq cijena = SL cijena (likvidacija je backup za SL)
  // Formula: liq_dist = 1/L - MMR → postavimo liq_dist = SL% → L = 1/(SL% + MMR)
  // Math.floor → liq je uvijek malo DALJE od SL-a (SL uvijek okida prvi)
  const MAINT  = 0.004;  // 0.4% BitGet maintenance margin (standardni za male pozicije)
  const maxLev = 1 / (slPct / 100 + MAINT);
  return Math.max(10, Math.min(125, Math.floor(maxLev)));
  // Provjera: SL2.5%→34x(liq@2.54%) SL4%→22x(liq@4.15%) SL5.5%→16x(liq@5.85%) SL7%→13x(liq@7.29%)
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

  // Soft SL/TP — NE postavljamo ordere na Bitgetu (MM ne vidi razine)
  // Bot prati cijenu svakih 15s i zatvara tržišnim nalogom kad SL/TP bude dostignut.
  // SL i TP razine čuvamo u pos.sl / pos.tp za softExitMonitor.
  console.log(`  🛡️  Soft SL @ ${fmtPrice(slFromFill, symbol)} | Soft TP @ ${fmtPrice(tpFromFill, symbol)} (praćeno lokalno, nije na Bitgetu)`);

  return { orderId, fillPrice, actualLeverage, slFromFill, tpFromFill };
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
        const _openShorts = pDef.positions.filter(p => p.side === "SHORT");
        if (_openShorts.length > 0) {
          console.log(`  🚨 [CORR EXIT] BTC +${_spike.pct}% u 30min (spike UP) → zatvaramo ${_openShorts.length} SHORT pozicija`);
          for (const _sp of _openShorts) {
            try {
              const _isLiveCe = pDef.live === true && !PAPER_TRADING;
              if (_isLiveCe) await closeBitGetOrder(_sp);
              const _pnlEst = _sp.entry > 0 ? ((_sp.entry - _sp.lastPrice) / _sp.entry * 100).toFixed(2) : "?";
              const _exitPx  = _sp.lastPrice ?? _sp.entryPrice ?? _sp.entry;
              const _qty     = _sp.qty ?? _sp.size ?? 0;
              const _pnlUsd  = _sp.side === "SHORT"
                ? (_sp.entryPrice - _exitPx) * _qty
                : (_exitPx - _sp.entryPrice) * _qty;
              writeExitCsv(pid, _sp, _exitPx, `CORR EXIT: BTC spike +${_spike.pct}% u 30min`, _pnlUsd);
              if (_pnlUsd < 0) { symbolSlCooldown.set(_sp.symbol, Date.now()); saveSlCooldown(); }
              await tg(`⚡ [CORR EXIT] ${_sp.symbol} SHORT\nBTC spike +${_spike.pct}% u 30min → zatvoren preventivno\nP&L: ${_pnlUsd >= 0?"+":""}$${_pnlUsd.toFixed(2)}`).catch(()=>{});
              pDef.positions = pDef.positions.filter(p => p.symbol !== _sp.symbol || p.side !== "SHORT");
              console.log(`  ✅ [CORR EXIT] ${_sp.symbol} SHORT zatvoren (est. ${_pnlEst}%)`);
            } catch(e) {
              console.log(`  ⚠️  [CORR EXIT] ${_sp.symbol} greška: ${e.message}`);
            }
          }
        } else {
          console.log(`  ⚡ [CORR EXIT] BTC +${_spike.pct}% spike — nema otvorenih SHORT-ova`);
        }
      } else if (_spike.spike && _spike.direction === "DOWN") {
        // BTC naglo pao → sve open LONG pozicije su u opasnosti (upozorenje)
        const _openLongs = pDef.positions.filter(p => p.side === "LONG");
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
        if (pyramidCount >= MAX_PYRAMID) {
          console.log(`  ⏭️  [${pDef.name}] ${symbol} — max pyramid (${pyramidCount}/${MAX_PYRAMID}) dostignut, preskačem`);
          continue;
        }
        // Inače puštamo da prođe analizu — smjer će se provjeriti ispod
        console.log(`  🔺 [${pDef.name}] ${symbol} — postoji pozicija (${existingPos.side}), provjeravamo pyramid ulaz (${pyramidCount}/${MAX_PYRAMID})`);
      }

      // Provjeri limit otvorenih pozicija
      const currentOpen = loadPositions(pid).length;
      const _reEntry = _winReEntry.get(symbol);
      const _reEntryActive = _reEntry && (Date.now() - _reEntry.ts) < REENTRY_WINDOW_MS;
      if (!_reEntryActive && _reEntry) _winReEntry.delete(symbol);
      const _maxOpen = _reEntryActive ? MAX_OPEN_PER_PORTFOLIO + 1 : MAX_OPEN_PER_PORTFOLIO;
      if (currentOpen >= _maxOpen && symbol !== BTC_EXCEPTION) {
        console.log(`  🔒 [${pDef.name}] Max ${MAX_OPEN_PER_PORTFOLIO}${_reEntryActive?" (re-entry +1)":""} dostignut — preskačem ${symbol}`);
        _scanLogEntries.push({ symbol, signal: "SKIP", blocker: `MAX_POS(${currentOpen}/${_maxOpen})`, reason: "Max otvorenih pozicija dostignut" });
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
        // ── Session Filter gate ─────────────────────────────────────────────
        const sess = getSessionInfo();
        if (sess.dead) {
          console.log(`  🌙 [SESSION] ${symbol} — dead zone (${sess.utcHour}:00 UTC, 01-06 UTC blokiran) → preskačem`);
          _scanLogEntries.push({ symbol, signal: "SKIP", blocker: "DEAD_ZONE", reason: `Dead zone ${sess.utcHour}:00 UTC` });
          continue;
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

        // ── D) Quiet Pullback filter — ulazimo samo na tihim svjećama ──────────
        // PBK signal: max 2.0× | MOM signal: max 3.0×
        // Pyramid (existingPos): preskačemo filter — već smo u poziciji
        if (pDef.strategy === "synapse_t" && !existingPos) {
          const _isPbk   = !result.isMomentum;
          const _volMax  = _isPbk ? 2.0 : 3.0;
          const _isMax7  = (result.bullScore >= 7 || result.bearScore >= 7);
          if (volAnomaly.ratio > _volMax && !_isMax7) {
            console.log(`  🔇 [QUIET] ${symbol} ${signal} (${_isPbk?"PBK":"MOM"}) — volRatio ${volAnomaly.ratio}× > ${_volMax}× → preskačem`);
            continue;
          }
          if (volAnomaly.ratio > _volMax && _isMax7) {
            console.log(`  ⚡ [QUIET bypass] ${symbol} — 7/7+ score, QUIET ignoriran`);
          }
        }

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
              console.log(`  ${_icon} [LIQ] ${symbol} — DANGER (${_liqStatus.minDist.toFixed(1)}% do liq · LONG $${_liqStatus.closestLong?.price.toFixed(0)||"?"} · SHORT $${_liqStatus.closestShort?.price.toFixed(0)||"?"}) → preskačem`);
              _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: `LIQ_DANGER(${_liqStatus.minDist.toFixed(1)}%)`, reason: `Liq zona ${_liqStatus.minDist.toFixed(1)}% od cijene` });
              continue;
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

        // ── Pyramid provjera smjera: ako postoji pozicija, signal mora biti ISTI smjer ──
        if (existingPos && existingPos.side !== signal) {
          console.log(`  ⏭️  [${pDef.name}] ${symbol} — pozicija ${existingPos.side} otvorena, signal ${signal} suprotan → skip (bez hedgea)`);
          continue;
        }
        if (existingPos && existingPos.side === signal) {
          console.log(`  🔺 [PYRAMID] ${symbol} ${signal} — adicija ${existingPosList.length + 1}/${MAX_PYRAMID} u trendu`);
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

          // LONG blokiran samo ako je 1H BEAR (ne 4H)
          if (signal === "LONG" && _effectiveRegime === "BEAR" && !_anyLongBypass) {
            console.log(`  🌧️  [REGIME] ${symbol} — BTC 1H BEAR → LONG blokiran`);
            _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: `BTC_REGIME(${_effectiveRegime})`, reason: "BTC 1H BEAR → LONG blokiran", vwapDist: result.vwap ? ((result.price-result.vwap)/result.vwap*100).toFixed(2) : null });
            continue;
          }

          // SHORT filter — tri razine zaštite:
          // 1. BTC 4H EMA50: ako cijena IZNAD EMA50 → tržište u recovery/bull fazi → SHORT blokiran
          // 2. BTC 1H BULL + simbol nije bearish → SHORT blokiran
          // 3. BTC 1H NEUTRAL + BTC 4H iznad EMA50 → SHORT blokiran (NEUTRAL ne znači da možemo SHORT)
          const _btcAboveEma50 = _regimeCache.btcAboveEma50_4h ?? false;
          const _sym1hTrend = result?.trend1h || trend1h?.trend || null;

          if (signal === "SHORT" && _btcAboveEma50 && _sym1hTrend !== "BEAR") {
            const _ema50str = _regimeCache.btcEma50_4h ? ` (EMA50=$${_regimeCache.btcEma50_4h.toFixed(0)})` : "";
            console.log(`  ☀️  [REGIME EMA50] ${symbol} — BTC 4H iznad EMA50${_ema50str} + simbol 1H ${_sym1hTrend||"?"} → SHORT blokiran`);
            _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: `BTC_EMA50_ABOVE`, reason: `BTC 4H iznad EMA50, simbol 1H ${_sym1hTrend||"?"} → SHORT blokiran` });
            continue;
          }
          if (signal === "SHORT" && _effectiveRegime === "BULL" && _sym1hTrend !== "BEAR") {
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

          // SP500 RISK_OFF → blokira LONG, ali SHORT prolazi (osim bypass)
          if (signal === "LONG" && _sp500Regime === "RISK_OFF" && !_anyLongBypass) {
            console.log(`  🚨 [SP500] ${symbol} — RISK_OFF → LONG blokiran`);
            continue;
          }
          // Fear & Greed: samo ekstremni rubovi blokiraju
          if (signal === "SHORT" && _fearGreed !== null && _fearGreed <= 15) {
            console.log(`  😱 [F&G] ${symbol} — Extreme Fear (${_fearGreed} ≤ 15) → SHORT blokiran (bounce rizik)`);
            continue;
          }
          if (signal === "LONG" && _fearGreed !== null && _fearGreed >= 85) {
            console.log(`  🤑 [F&G] ${symbol} — Extreme Greed (${_fearGreed} ≥ 85) → LONG blokiran (reversal rizik)`);
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

        // ── Dinamički TP — tržišni uvjeti (BTC Regime + Market Breadth) ────────
        // JAKO: BTC Regime BULL+LONG ili BEAR+SHORT AND Breadth ≥ 5 → TP × 3 (1:3 R:R)
        // NORMALNO: NEUTRAL ili Breadth prenizak → TP × 1.5 (1:1.5 R:R)
        // Pravilo: samo POVEĆAVAMO TP, nikad ne smanjujemo ako je S/R dal bolji target
        const _breadthBull = _marketBreadth.bullish >= BREADTH_STRONG;
        const _breadthBear = _marketBreadth.bearish >= BREADTH_STRONG;
        const _isStrong = (_btcRegime === "BULL" && signal === "LONG"  && _breadthBull) ||
                          (_btcRegime === "BEAR" && signal === "SHORT" && _breadthBear);
        const _tpMult     = _isStrong ? STRONG_TP_MULT : NORMAL_TP_MULT;
        const _dynTpPct   = slPct * _tpMult;
        const signalStrength = _isStrong ? "strong" : "normal";

        if (_dynTpPct > tpPct) {
          tpPct = _dynTpPct;
          tp    = signal === "LONG" ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
        }

        if (_isStrong) {
          console.log(`  💪 [JAKO TRŽIŠTE] ${symbol} — Regime:${_btcRegime} + Breadth▲${_marketBreadth.bullish} + ${signal} → TP ×3 = ${tpPct.toFixed(2)}% | RR 1:${(tpPct/slPct).toFixed(1)}`);
        } else {
          console.log(`  📊 [KONSOLIDACIJA] ${symbol} — Regime:${_btcRegime} Breadth▲${_marketBreadth.bullish}▼${_marketBreadth.bearish} → TP ×1.5 = ${tpPct.toFixed(2)}% | RR 1:${(tpPct/slPct).toFixed(1)}`);
        }

        // Risk-based position sizing: SL gubitak = točno RISK_PCT% trenutne equity
        const startCap   = pDef.startCapital ?? START_CAPITAL;
        const equity     = getPortfolioEquity(pid, startCap);

        const riskAmount = equity * (RISK_PCT / 100);
        const tradeSize  = (riskAmount / (slPct / 100)) * (atrTrend?.sizeMult ?? 1) * (_oiSizeMult ?? 1) * (_vwapSizeMult ?? 1) * (_stableSizeMult ?? 1);
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
        const entry = { symbol, signal, price, sl, tp, tradeSize, margin, orderId, timestamp, strategy: pDef.strategy, timeframe: pDef.timeframe, slPct, tpPct, mode, sigMask: result.sigMask ?? null, entryMode: result.isMomentum ? "MOM" : "PBK", signalStrength };

        const _strengthEmoji = signalStrength === "strong" ? "💪" : "📊";
        const _rrLabel = `RR 1:${(tpPct/slPct).toFixed(1)}`;

        if (!isLive) {
          addPosition(pid, entry);
          writeEntryCsv(pid, entry);
          _newEntriesThisScan++;
          _scanLogEntries.push({ symbol, signal, score: Math.max(result.bullScore||0,result.bearScore||0), blocker: "ENTERED", reason: `${result.isMomentum?"MOM":"PBK"} ulaz @ ${fmtPrice(price)} SL ${fmtPrice(sl)} TP ${fmtPrice(tp)}`, vwapDist: result.vwap ? ((price-result.vwap)/result.vwap*100).toFixed(2) : null });
          await tg(`📋 PAPER [${pDef.name}/${pDef.timeframe}] ${signal === "LONG" ? "📈" : "📉"} <b>${signal} ${symbol}</b> ${_strengthEmoji}\nUlaz: ${fmtPrice(price)} | SL: ${fmtPrice(sl)} (${slPct.toFixed(1)}%) | TP: ${fmtPrice(tp)} (${tpPct.toFixed(1)}%) | ${_rrLabel}\nEquity: $${equity.toFixed(2)} | Risk: $${riskAmount.toFixed(2)} | Notional: $${tradeSize.toFixed(0)} | Margin: $${margin.toFixed(2)} | ${symSltp.leverage ?? LEVERAGE}x`);
        } else {
          try {
            const order = await placeBitGetOrder(symbol, signal, tradeSize, price, sl, tp, slPct, tpPct, symSltp.leverage ?? null);
            const usedLev    = order?.actualLeverage || LEVERAGE;
            const usedMargin = tradeSize / usedLev;
            entry.orderId    = order?.orderId || orderId;
            entry.margin     = usedMargin;
            // Koristi SL/TP izračunate od stvarne fill cijene (ne signal cijene)
            if (order?.slFromFill) entry.sl = order.slFromFill;
            if (order?.tpFromFill) entry.tp = order.tpFromFill;
            if (order?.fillPrice)  entry.entryPrice = order.fillPrice;
            addPosition(pid, entry);
            writeEntryCsv(pid, entry);
            _newEntriesThisScan++;
            console.log(`  ✅ LIVE NALOG [${pDef.name}] — ${entry.orderId}`);
            await tg(`🔴 LIVE [${pDef.name}/${pDef.timeframe}] ${signal === "LONG" ? "📈" : "📉"} <b>${signal} ${symbol}</b> ${_strengthEmoji}\nUlaz: ${fmtPrice(price)} | SL: ${fmtPrice(sl)} (${slPct.toFixed(1)}%) | TP: ${fmtPrice(tp)} (${tpPct.toFixed(1)}%) | ${_rrLabel}\nEquity: $${equity.toFixed(2)} | Risk: $${riskAmount.toFixed(2)} | Notional: $${tradeSize.toFixed(0)} | Margin: $${usedMargin.toFixed(2)} | ${usedLev}x`);
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
