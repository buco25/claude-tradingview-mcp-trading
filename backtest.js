// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  ULTRA Backtest — 16 signala | H/L Breakout Entry                          ║
// ║  Pokreni: node backtest.js                                                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// @ts-check

const SYMBOLS = [
  "XAUUSDT","DOGEUSDT","NEARUSDT","RIVERUSDT","ADAUSDT",
  "ETHUSDT","SUIUSDT","TAOUSDT",
  "SOLUSDT","XAGUSDT","HYPEUSDT","LINKUSDT","PEPEUSDT","ZECUSDT","BTCUSDT"
];
const TIMEFRAMES  = ["15m", "1H", "4H"];
const MIN_SIG     = 10;
const SL_PCT      = 2.5;
const TP_PCT      = 5.0;
const EQUITY_RISK = 2.0;   // % equitija koji riskiraš po tradeu
const BAR_LIMIT   = 1000;  // Bitget max po pozivu

// ─── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = BAR_LIMIT) {
  const url = `https://api.bitget.com/api/v2/mix/market/candles` +
    `?symbol=${symbol}&productType=USDT-FUTURES&granularity=${interval}&limit=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(json.msg);
  return json.data
    .map(k => ({
      time:   parseInt(k[0]),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }))
    .sort((a, b) => a.time - b.time);
}

// ─── Indikatori (precomputed series) ───────────────────────────────────────────

function emaSeries(closes, period) {
  const out  = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k    = 2 / (period + 1);
  let val    = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = val;
  for (let i = period; i < closes.length; i++) {
    val    = closes[i] * k + val * (1 - k);
    out[i] = val;
  }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  // Wilder smoothing
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d    = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macdHistSeries(closes, fast = 12, slow = 26, sig = 9) {
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const diffs = closes.map((_, i) =>
    fastE[i] !== null && slowE[i] !== null ? fastE[i] - slowE[i] : null);
  // Signal EMA of diffs (skip nulls)
  const out  = new Array(closes.length).fill(null);
  const k    = 2 / (sig + 1);
  let   sv   = null;
  let   cnt  = 0;
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i] === null) continue;
    if (sv === null) {
      sv = diffs[i];
      cnt++;
      if (cnt >= sig) out[i] = diffs[i] - sv;
    } else {
      sv     = diffs[i] * k + sv * (1 - k);
      out[i] = diffs[i] - sv;
    }
  }
  return out;
}

function adxSeries(candles, period = 14) {
  // Wilder smoothed ADX
  const n   = candles.length;
  const out = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;

  const trs = [], pdms = [], mdms = [];
  for (let i = 1; i < n; i++) {
    const h = candles[i].high,  l = candles[i].low;
    const ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdms.push(up > dn && up > 0 ? up : 0);
    mdms.push(dn > up && dn > 0 ? dn : 0);
  }

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let pdm = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let mdm = mdms.slice(0, period).reduce((a, b) => a + b, 0);

  const diPlus = [], diMinus = [], dxArr = [];
  for (let i = period; i < trs.length; i++) {
    atr = atr - atr / period + trs[i];
    pdm = pdm - pdm / period + pdms[i];
    mdm = mdm - mdm / period + mdms[i];
    const pdi = atr === 0 ? 0 : 100 * pdm / atr;
    const mdi = atr === 0 ? 0 : 100 * mdm / atr;
    diPlus.push(pdi);
    diMinus.push(mdi);
    const sum = pdi + mdi;
    dxArr.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
  }

  // ADX = Wilder EMA of DX over period
  if (dxArr.length < period) return out;
  let adxVal = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const startIdx = period * 2; // offset in candles array
  out[startIdx] = adxVal;
  for (let i = period; i < dxArr.length; i++) {
    adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
    out[startIdx + (i - period) + 1] = adxVal;
  }
  return out;
}

function choppinessSeries(candles, period = 14) {
  const n   = candles.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    const sl = candles.slice(i - period + 1, i + 1);
    let atrSum = 0;
    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < sl.length; j++) {
      const h = sl[j].high, l = sl[j].low;
      const pc = j > 0 ? sl[j-1].close : sl[j].open;
      atrSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    out[i] = (hh === ll) ? 100 : 100 * Math.log10(atrSum / (hh - ll)) / Math.log10(period);
  }
  return out;
}

// ─── Precompute sve serije za jedan simbol ──────────────────────────────────────

function precompute(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  return {
    closes, volumes,
    e9:    emaSeries(closes, 9),
    e21:   emaSeries(closes, 21),
    e50:   emaSeries(closes, 50),
    e55:   emaSeries(closes, 55),
    e145:  emaSeries(closes, 145),
    // 6-Scale EMA parovi
    e3:    emaSeries(closes, 3),   e11:   emaSeries(closes, 11),
    e7:    emaSeries(closes, 7),   e15:   emaSeries(closes, 15),
    e13:   emaSeries(closes, 13),  e21b:  emaSeries(closes, 21),
    e19:   emaSeries(closes, 19),  e29:   emaSeries(closes, 29),
    e29b:  emaSeries(closes, 29),  e47:   emaSeries(closes, 47),
    e45:   emaSeries(closes, 45),  e55b:  emaSeries(closes, 55),
    // Ostalo
    rsi:   rsiSeries(closes, 14),
    macdH: macdHistSeries(closes),
    adx:   adxSeries(candles, 14),
    chop:  choppinessSeries(candles, 14),
    // Volume MA
    volMA: emaSeries(volumes, 20),
  };
}

// ─── Signal score na baru i ─────────────────────────────────────────────────────

function scoreAt(i, s, candles) {
  const { closes, volumes, e9, e21, e50, e55, e145,
          e3, e11, e7, e15, e13, e21b, e19, e29, e29b, e47, e45, e55b,
          rsi, macdH, adx, chop, volMA } = s;

  if (!e9[i] || !e21[i] || !e50[i] || !e55[i] || !e145[i]) return null;
  if (!rsi[i] || !adx[i] || !chop[i]) return null;

  const price  = closes[i];
  const rsiVal = rsi[i];
  const adxVal = adx[i];

  // RSI direction
  const rsiRising  = rsi[i] > rsi[i-1] && rsi[i-1] > rsi[i-2];
  const rsiFalling = rsi[i] < rsi[i-1] && rsi[i-1] < rsi[i-2];

  // RSI min/max last 5
  let rsiMin5 = Infinity, rsiMax5 = -Infinity;
  for (let k = i - 4; k <= i; k++) {
    if (rsi[k]) { rsiMin5 = Math.min(rsiMin5, rsi[k]); rsiMax5 = Math.max(rsiMax5, rsi[k]); }
  }

  // CVD 20
  let cvdSum = 0;
  for (let k = Math.max(0, i - 19); k <= i; k++) {
    const c = candles[k];
    cvdSum += c.close > c.open ? c.volume : c.close < c.open ? -c.volume : 0;
  }

  // 6-Scale
  const scaleUp = [
    e3[i]>e11[i], e7[i]>e15[i], e13[i]>e21b[i],
    e19[i]>e29[i], e29b[i]>e47[i], e45[i]>e55b[i]
  ].filter(Boolean).length;
  const scaleDn = [
    e3[i]<e11[i], e7[i]<e15[i], e13[i]<e21b[i],
    e19[i]<e29[i], e29b[i]<e47[i], e45[i]<e55b[i]
  ].filter(Boolean).length;

  // EMA cross last 3
  let crossUp = false, crossDn = false;
  for (let k = Math.max(1, i - 2); k <= i; k++) {
    if (e9[k] > e21[k] && e9[k-1] <= e21[k-1]) crossUp = true;
    if (e9[k] < e21[k] && e9[k-1] >= e21[k-1]) crossDn = true;
  }

  // MACD cross last 3
  let mccUp = false, mccDn = false;
  for (let k = Math.max(1, i - 2); k <= i; k++) {
    if (macdH[k] !== null && macdH[k-1] !== null) {
      if (macdH[k] > 0 && macdH[k-1] <= 0) mccUp = true;
      if (macdH[k] < 0 && macdH[k-1] >= 0) mccDn = true;
    }
  }

  const sigs = [
    e9[i] > e21[i] ? 1 : -1,                                                          // 1 EMA
    crossUp ? 1 : crossDn ? -1 : 0,                                                   // 2 CRS
    price > e50[i] ? 1 : -1,                                                           // 3 E50
    rsiVal < 50 && rsiVal > 30 ? 1 : rsiVal > 50 && rsiVal < 70 ? -1 : 0,            // 4 RSI zona
    price > e55[i] ? 1 : -1,                                                           // 5 E55
    adxVal > 18 ? (e9[i] > e21[i] ? 1 : -1) : 0,                                    // 6 ADX smjer
    chop[i] < 61.8 ? 1 : -1,                                                           // 7 CHP
    scaleUp >= 4 ? 1 : scaleDn >= 4 ? -1 : 0,                                         // 8 6Sc
    cvdSum > 0 ? 1 : -1,                                                               // 9 CVD
    rsiMin5 < 35 && rsiVal > 35 && rsiRising ? 1 :
      rsiMax5 > 65 && rsiVal < 65 && rsiFalling ? -1 : 0,                            // 10 R⟳
    macdH[i] !== null ? (macdH[i] > 0 ? 1 : -1) : 0,                                // 11 MCD
    price > e145[i] ? 1 : -1,                                                          // 12 E145
    volumes[i] > (volMA[i] || 0) ? 1 : 0,                                             // 13 VOL
    mccUp ? 1 : mccDn ? -1 : 0,                                                       // 14 MCC
    rsiRising ? 1 : rsiFalling ? -1 : 0,                                               // 15 R↗
    adxVal > 25 ? (e9[i] > e21[i] ? 1 : -1) : 0,                                    // 16 ADX+
  ];

  const bull = sigs.filter(v => v === 1).length;
  const bear = sigs.filter(v => v === -1).length;
  return { bull, bear };
}

// ─── Backtest jednog simbola ────────────────────────────────────────────────────

function runBacktest(candles, minSig = MIN_SIG, slPct = SL_PCT, tpPct = TP_PCT) {
  const s      = precompute(candles);
  const trades = [];
  let position = null;  // { side, entryPrice, sl, tp }
  let pending  = null;  // { side, trigH, trigL, sigBar }

  const START = 210;  // dovoljno historije za sve indikatore

  for (let i = START; i < candles.length - 1; i++) {
    const bar     = candles[i];
    const nextBar = candles[i + 1];

    // ── 1. Provjera exitta otvorene pozicije na nextBar-u ──────────────────────
    if (position) {
      let exitPrice = null, exitReason = null;
      if (position.side === "LONG") {
        if (nextBar.low  <= position.sl) { exitPrice = position.sl; exitReason = "SL"; }
        else if (nextBar.high >= position.tp) { exitPrice = position.tp; exitReason = "TP"; }
      } else {
        if (nextBar.high >= position.sl) { exitPrice = position.sl; exitReason = "SL"; }
        else if (nextBar.low  <= position.tp) { exitPrice = position.tp; exitReason = "TP"; }
      }
      if (exitPrice !== null) {
        const pnlPct = position.side === "LONG"
          ? (exitPrice - position.entryPrice) / position.entryPrice * 100
          : (position.entryPrice - exitPrice) / position.entryPrice * 100;
        trades.push({ side: position.side, pnlPct, exitReason, bar: i });
        position = null;
      }
      continue;  // dok je pozicija otvorena, ne tražimo novi signal
    }

    const sc = scoreAt(i, s, candles);
    if (!sc) continue;
    const { bull, bear } = sc;
    const longSig  = bull >= minSig;
    const shortSig = bear >= minSig;

    // ── 2. Provjera breakouta pendinga ─────────────────────────────────────────
    if (pending) {
      // Cancel ako signal nestao
      if (pending.side === "LONG"  && !longSig)  { pending = null; }
      else if (pending.side === "SHORT" && !shortSig) { pending = null; }
      else if (i > pending.sigBar) {
        const broke = pending.side === "LONG"
          ? bar.high > pending.trigH
          : bar.low  < pending.trigL;
        if (broke) {
          const ep  = pending.side === "LONG" ? pending.trigH : pending.trigL;
          const sl  = pending.side === "LONG" ? ep * (1 - slPct / 100) : ep * (1 + slPct / 100);
          const tp  = pending.side === "LONG" ? ep * (1 + tpPct / 100) : ep * (1 - tpPct / 100);
          position  = { side: pending.side, entryPrice: ep, sl, tp };
          pending   = null;
        }
      }
      if (pending) continue;  // još čekamo, ne postavljamo novi
    }

    // ── 3. Novi signal → postavi pending ───────────────────────────────────────
    if (!position) {
      if (longSig) {
        pending = { side: "LONG",  trigH: bar.high, trigL: bar.low, sigBar: i };
      } else if (shortSig) {
        pending = { side: "SHORT", trigH: bar.high, trigL: bar.low, sigBar: i };
      }
    }
  }

  return trades;
}

// ─── Formatiranje ───────────────────────────────────────────────────────────────

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", B = "\x1b[36m", RESET = "\x1b[0m";

function fmt(n, decimals = 1) {
  const s = n.toFixed(decimals);
  return n >= 0 ? `${G}+${s}%${RESET}` : `${R}${s}%${RESET}`;
}

function printTable(rows, totals) {
  const H = `${"SIMBOL".padEnd(12)} ${"TRAD".padStart(5)} ${"W".padStart(4)} ${"L".padStart(4)} ${"WR%".padStart(6)} ${"P&L%".padStart(9)} ${"PF".padStart(6)}`;
  console.log(`${B}${H}${RESET}`);
  console.log("─".repeat(52));
  for (const r of rows) {
    const col   = r.pnl >= 0 ? G : R;
    const pnlS  = (r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(1) + "%";
    const wrS   = r.trades ? (r.wins / r.trades * 100).toFixed(1) + "%" : "—";
    const pfS   = r.pf === Infinity ? "∞" : r.pf.toFixed(2);
    console.log(`${col}${r.symbol.padEnd(12)}${RESET}` +
      ` ${String(r.trades).padStart(5)} ${String(r.wins).padStart(4)} ${String(r.losses).padStart(4)}` +
      ` ${wrS.padStart(6)} ${pnlS.padStart(9)} ${pfS.padStart(6)}`);
  }
  console.log("─".repeat(52));
  const tPnlS = (totals.pnl >= 0 ? "+" : "") + totals.pnl.toFixed(1) + "%";
  const tWrS  = totals.trades ? (totals.wins / totals.trades * 100).toFixed(1) + "%" : "—";
  const tPfS  = totals.pf === Infinity ? "∞" : totals.pf.toFixed(2);
  const tCol  = totals.pnl >= 0 ? G : R;
  console.log(`${tCol}${"UKUPNO".padEnd(12)}${RESET}` +
    ` ${String(totals.trades).padStart(5)} ${String(totals.wins).padStart(4)} ${String(totals.losses).padStart(4)}` +
    ` ${tWrS.padStart(6)} ${tPnlS.padStart(9)} ${tPfS.padStart(6)}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🎯 ULTRA Backtest`);
  console.log(`  16 signala · min ${MIN_SIG}/16 · SL ${SL_PCT}% / TP ${TP_PCT}% · RR 1:2`);
  console.log(`  Simboli: ${SYMBOLS.length} · TF: ${TIMEFRAMES.join(", ")} · ${BAR_LIMIT} svjeća`);
  console.log(`  Rizik po tradeu: ${EQUITY_RISK}% equitija`);
  console.log(`${"═".repeat(60)}\n`);

  const summary = [];

  for (const tf of TIMEFRAMES) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  📊 Timeframe: ${B}${tf}${RESET}`);
    console.log(`${"═".repeat(60)}`);

    const rows = [];
    let tfTrades = 0, tfWins = 0, tfLosses = 0, tfPnl = 0;

    for (const symbol of SYMBOLS) {
      try {
        process.stdout.write(`  Fetchujem ${symbol} ${tf}...`);
        const candles = await fetchCandles(symbol, tf, BAR_LIMIT);
        process.stdout.write(` ${candles.length} svjeća\r`);

        if (candles.length < 250) {
          console.log(`  ⚠️  ${symbol} — nedovoljno svjeća (${candles.length})`);
          continue;
        }

        const trades = runBacktest(candles);
        const wins   = trades.filter(t => t.exitReason === "TP").length;
        const losses = trades.filter(t => t.exitReason === "SL").length;
        // P&L u % equitija: TP = +EQUITY_RISK*(TP/SL), SL = -EQUITY_RISK
        const pnl    = wins * EQUITY_RISK * (TP_PCT / SL_PCT) - losses * EQUITY_RISK;
        const grossW = wins   * EQUITY_RISK * (TP_PCT / SL_PCT);
        const grossL = losses * EQUITY_RISK;
        const pf     = grossL === 0 ? Infinity : grossW / grossL;

        rows.push({ symbol, trades: trades.length, wins, losses, pnl, pf });
        tfTrades += trades.length; tfWins += wins; tfLosses += losses; tfPnl += pnl;

        await new Promise(r => setTimeout(r, 120));  // rate limit
      } catch (e) {
        console.log(`  ❌ ${symbol} — ${e.message}`);
      }
    }

    const tfGrossW = tfWins   * EQUITY_RISK * (TP_PCT / SL_PCT);
    const tfGrossL = tfLosses * EQUITY_RISK;
    const tfPF     = tfGrossL === 0 ? Infinity : tfGrossW / tfGrossL;

    console.log("");
    printTable(rows, { trades: tfTrades, wins: tfWins, losses: tfLosses, pnl: tfPnl, pf: tfPF });
    summary.push({ tf, trades: tfTrades, wins: tfWins, losses: tfLosses, pnl: tfPnl, pf: tfPF });
  }

  // ── Finalni sažetak ──────────────────────────────────────────────────────────
  console.log(`\n\n${"═".repeat(60)}`);
  console.log(`  📋 SAŽETAK PO TIMEFRAME-u`);
  console.log(`${"═".repeat(60)}`);
  console.log(`${B}${"TF".padEnd(6)} ${"TRAD".padStart(5)} ${"W".padStart(4)} ${"L".padStart(4)} ${"WR%".padStart(6)} ${"P&L%".padStart(9)} ${"PF".padStart(6)}${RESET}`);
  console.log("─".repeat(45));

  let best = null;
  for (const r of summary) {
    const wr  = r.trades ? (r.wins / r.trades * 100).toFixed(1) + "%" : "—";
    const pnl = (r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(1) + "%";
    const pf  = r.pf === Infinity ? "∞" : r.pf.toFixed(2);
    const col = r.pnl >= 0 ? G : R;
    console.log(`${col}${r.tf.padEnd(6)}${RESET}` +
      ` ${String(r.trades).padStart(5)} ${String(r.wins).padStart(4)} ${String(r.losses).padStart(4)}` +
      ` ${wr.padStart(6)} ${pnl.padStart(9)} ${pf.padStart(6)}`);
    if (!best || r.pnl > best.pnl) best = r;
  }

  console.log(`${"═".repeat(60)}`);
  if (best) {
    console.log(`\n  🏆 Najbolji TF: ${G}${best.tf}${RESET} — P&L ${fmt(best.pnl)} | PF ${best.pf === Infinity ? "∞" : best.pf.toFixed(2)}`);
  }
  console.log(`\n  ℹ️  P&L = equity % uz ${EQUITY_RISK}% rizik po tradeu`);
  console.log(`       TP hit = +${(EQUITY_RISK * TP_PCT / SL_PCT).toFixed(1)}% | SL hit = -${EQUITY_RISK.toFixed(1)}%\n`);
}

main().catch(err => { console.error("GREŠKA:", err); process.exit(1); });
