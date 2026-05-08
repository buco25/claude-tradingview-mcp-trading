// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  ULTRA SL/TP Comparison Backtest                                            ║
// ║  Testira 4 kombinacije SL/TP na svim simbolima, TF: 15m                    ║
// ║  Pokreni: node backtest_sltp.js                                             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

const SYMBOLS = [
  "XAUUSDT","DOGEUSDT","NEARUSDT","ADAUSDT",
  "ETHUSDT","SUIUSDT","TAOUSDT",
  "SOLUSDT","HYPEUSDT","LINKUSDT","PEPEUSDT","ZECUSDT","BTCUSDT"
];

const TIMEFRAME  = "15m";
const MIN_SIG    = 10;
const BAR_LIMIT  = 1000;
const RISK_PCT   = 1.5;   // % banke koji riskiraš po tradeu (1.5% → 40x → SL = 100% margine)

const COMBOS = [
  { sl: 1.0, tp: 2.0, label: "SL 1%  / TP 2%  (RR 1:2)" },
  { sl: 1.5, tp: 3.0, label: "SL 1.5%/ TP 3%  (RR 1:2)" },
  { sl: 2.0, tp: 4.0, label: "SL 2%  / TP 4%  (RR 1:2)" },
  { sl: 2.5, tp: 5.0, label: "SL 2.5%/ TP 5%  (RR 1:2)" },
];

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

// ─── Indikatori ────────────────────────────────────────────────────────────────
function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = val;
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
    out[i] = val;
  }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macdHistSeries(closes) {
  const fastE = emaSeries(closes, 12);
  const slowE = emaSeries(closes, 26);
  const diffs = closes.map((_, i) =>
    fastE[i] !== null && slowE[i] !== null ? fastE[i] - slowE[i] : null);
  const out = new Array(closes.length).fill(null);
  const k = 2 / 10;
  let sv = null, cnt = 0;
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i] === null) continue;
    if (sv === null) { sv = diffs[i]; cnt++; if (cnt >= 9) out[i] = diffs[i] - sv; }
    else { sv = diffs[i] * k + sv * (1 - k); out[i] = diffs[i] - sv; }
  }
  return out;
}

function adxSeries(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;
  const trs = [], pdms = [], mdms = [];
  for (let i = 1; i < n; i++) {
    const h = candles[i].high, l = candles[i].low;
    const ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdms.push(up > dn && up > 0 ? up : 0);
    mdms.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let pdm = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let mdm = mdms.slice(0, period).reduce((a, b) => a + b, 0);
  const dxArr = [];
  for (let i = period; i < trs.length; i++) {
    atr = atr - atr / period + trs[i];
    pdm = pdm - pdm / period + pdms[i];
    mdm = mdm - mdm / period + mdms[i];
    const pdi = atr === 0 ? 0 : 100 * pdm / atr;
    const mdi = atr === 0 ? 0 : 100 * mdm / atr;
    const sum = pdi + mdi;
    dxArr.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
  }
  if (dxArr.length < period) return out;
  let adxVal = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period * 2] = adxVal;
  for (let i = period; i < dxArr.length; i++) {
    adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
    out[period * 2 + (i - period) + 1] = adxVal;
  }
  return out;
}

function choppinessSeries(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    const sl = candles.slice(i - period + 1, i + 1);
    let atrSum = 0, hh = -Infinity, ll = Infinity;
    for (let j = 0; j < sl.length; j++) {
      const h = sl[j].high, l = sl[j].low;
      const pc = j > 0 ? sl[j-1].close : sl[j].open;
      atrSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    out[i] = hh === ll ? 100 : 100 * Math.log10(atrSum / (hh - ll)) / Math.log10(period);
  }
  return out;
}

function precompute(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  return {
    closes, volumes,
    e9: emaSeries(closes,9), e21: emaSeries(closes,21),
    e50: emaSeries(closes,50), e55: emaSeries(closes,55), e145: emaSeries(closes,145),
    e3: emaSeries(closes,3),   e11: emaSeries(closes,11),
    e7: emaSeries(closes,7),   e15: emaSeries(closes,15),
    e13: emaSeries(closes,13), e21b: emaSeries(closes,21),
    e19: emaSeries(closes,19), e29: emaSeries(closes,29),
    e29b: emaSeries(closes,29),e47: emaSeries(closes,47),
    e45: emaSeries(closes,45), e55b: emaSeries(closes,55),
    rsi: rsiSeries(closes,14),
    macdH: macdHistSeries(closes),
    adx: adxSeries(candles,14),
    chop: choppinessSeries(candles,14),
    volMA: emaSeries(volumes,20),
  };
}

function scoreAt(i, s, candles) {
  const { closes, volumes, e9, e21, e50, e55, e145,
          e3, e11, e7, e15, e13, e21b, e19, e29, e29b, e47, e45, e55b,
          rsi, macdH, adx, chop, volMA } = s;
  if (!e9[i]||!e21[i]||!e50[i]||!e55[i]||!e145[i]||!rsi[i]||!adx[i]||!chop[i]) return null;

  const price = closes[i], rsiVal = rsi[i], adxVal = adx[i];
  const rsiRising  = rsi[i] > rsi[i-1] && rsi[i-1] > rsi[i-2];
  const rsiFalling = rsi[i] < rsi[i-1] && rsi[i-1] < rsi[i-2];

  let rsiMin5 = Infinity, rsiMax5 = -Infinity;
  for (let k = i-4; k <= i; k++) {
    if (rsi[k]) { rsiMin5 = Math.min(rsiMin5,rsi[k]); rsiMax5 = Math.max(rsiMax5,rsi[k]); }
  }

  let cvdSum = 0;
  for (let k = Math.max(0,i-19); k <= i; k++) {
    const c = candles[k];
    cvdSum += c.close > c.open ? c.volume : c.close < c.open ? -c.volume : 0;
  }

  const scaleUp = [e3[i]>e11[i],e7[i]>e15[i],e13[i]>e21b[i],e19[i]>e29[i],e29b[i]>e47[i],e45[i]>e55b[i]].filter(Boolean).length;
  const scaleDn = [e3[i]<e11[i],e7[i]<e15[i],e13[i]<e21b[i],e19[i]<e29[i],e29b[i]<e47[i],e45[i]<e55b[i]].filter(Boolean).length;

  let crossUp = false, crossDn = false;
  for (let k = Math.max(1,i-2); k <= i; k++) {
    if (e9[k]>e21[k]&&e9[k-1]<=e21[k-1]) crossUp=true;
    if (e9[k]<e21[k]&&e9[k-1]>=e21[k-1]) crossDn=true;
  }

  let mccUp = false, mccDn = false;
  for (let k = Math.max(1,i-2); k <= i; k++) {
    if (macdH[k]!==null&&macdH[k-1]!==null) {
      if (macdH[k]>0&&macdH[k-1]<=0) mccUp=true;
      if (macdH[k]<0&&macdH[k-1]>=0) mccDn=true;
    }
  }

  const sigs = [
    e9[i]>e21[i]?1:-1,
    crossUp?1:crossDn?-1:0,
    price>e50[i]?1:-1,
    rsiVal<50&&rsiVal>30?1:rsiVal>50&&rsiVal<70?-1:0,
    price>e55[i]?1:-1,
    adxVal>18?(e9[i]>e21[i]?1:-1):0,
    chop[i]<61.8?1:-1,
    scaleUp>=4?1:scaleDn>=4?-1:0,
    cvdSum>0?1:-1,
    rsiMin5<35&&rsiVal>35&&rsiRising?1:rsiMax5>65&&rsiVal<65&&rsiFalling?-1:0,
    macdH[i]!==null?(macdH[i]>0?1:-1):0,
    price>e145[i]?1:-1,
    volumes[i]>(volMA[i]||0)?1:0,
    mccUp?1:mccDn?-1:0,
    rsiRising?1:rsiFalling?-1:0,
    adxVal>25?(e9[i]>e21[i]?1:-1):0,
  ];

  const bull = sigs.filter(v=>v===1).length;
  const bear = sigs.filter(v=>v===-1).length;
  return { bull, bear };
}

function runBacktest(candles, slPct, tpPct) {
  const s = precompute(candles);
  const trades = [];
  let position = null;
  let pending  = null;
  const START  = 210;

  for (let i = START; i < candles.length - 1; i++) {
    const bar = candles[i], next = candles[i+1];

    if (position) {
      let exitPrice = null, exitReason = null;
      if (position.side === "LONG") {
        if (next.low  <= position.sl) { exitPrice = position.sl; exitReason = "SL"; }
        else if (next.high >= position.tp) { exitPrice = position.tp; exitReason = "TP"; }
      } else {
        if (next.high >= position.sl) { exitPrice = position.sl; exitReason = "SL"; }
        else if (next.low  <= position.tp) { exitPrice = position.tp; exitReason = "TP"; }
      }
      if (exitPrice !== null) {
        const pnlPct = position.side === "LONG"
          ? (exitPrice - position.entryPrice) / position.entryPrice * 100
          : (position.entryPrice - exitPrice) / position.entryPrice * 100;
        trades.push({ side: position.side, pnlPct, exitReason });
        position = null;
      }
      continue;
    }

    const sc = scoreAt(i, s, candles);
    if (!sc) continue;
    const longSig  = sc.bull >= MIN_SIG;
    const shortSig = sc.bear >= MIN_SIG;

    if (pending) {
      if (pending.side==="LONG"  && !longSig)  { pending=null; }
      else if (pending.side==="SHORT" && !shortSig) { pending=null; }
      else if (i > pending.sigBar) {
        const broke = pending.side==="LONG" ? bar.high>pending.trigH : bar.low<pending.trigL;
        if (broke) {
          const ep = pending.side==="LONG" ? pending.trigH : pending.trigL;
          position = {
            side: pending.side, entryPrice: ep,
            sl: pending.side==="LONG" ? ep*(1-slPct/100) : ep*(1+slPct/100),
            tp: pending.side==="LONG" ? ep*(1+tpPct/100) : ep*(1-tpPct/100),
          };
          pending = null;
        }
      }
      if (pending) continue;
    }

    if (!position) {
      if (longSig)       pending = { side:"LONG",  trigH:bar.high, trigL:bar.low, sigBar:i };
      else if (shortSig) pending = { side:"SHORT", trigH:bar.high, trigL:bar.low, sigBar:i };
    }
  }
  return trades;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
const G="\x1b[32m", R="\x1b[31m", Y="\x1b[33m", B="\x1b[36m", W="\x1b[1m", RESET="\x1b[0m";

async function main() {
  console.log(`\n${W}${"═".repeat(70)}${RESET}`);
  console.log(`  🎯 ULTRA SL/TP Comparison Backtest — ${TIMEFRAME} — ${SYMBOLS.length} simbola`);
  console.log(`  Min signala: ${MIN_SIG}/16 | Rizik: ${RISK_PCT}% banke po tradeu`);
  console.log(`${W}${"═".repeat(70)}${RESET}\n`);

  // Fetch sve candle jednom
  const candleMap = {};
  for (const symbol of SYMBOLS) {
    try {
      process.stdout.write(`  ⏳ Fetch ${symbol}...`);
      candleMap[symbol] = await fetchCandles(symbol, TIMEFRAME, BAR_LIMIT);
      process.stdout.write(` ${candleMap[symbol].length} svjeća ✓\n`);
      await new Promise(r => setTimeout(r, 100));
    } catch(e) {
      console.log(` ❌ ${e.message}`);
    }
  }

  // Rezultati po kombu
  const results = {};
  for (const combo of COMBOS) {
    results[combo.label] = { trades:0, wins:0, losses:0 };
  }

  // Backtest svakog simbola za svaki combo
  for (const symbol of SYMBOLS) {
    const candles = candleMap[symbol];
    if (!candles || candles.length < 250) continue;

    for (const combo of COMBOS) {
      const trades = runBacktest(candles, combo.sl, combo.tp);
      const wins   = trades.filter(t => t.exitReason==="TP").length;
      const losses = trades.filter(t => t.exitReason==="SL").length;
      results[combo.label].trades  += trades.length;
      results[combo.label].wins    += wins;
      results[combo.label].losses  += losses;
    }
  }

  // Ispis tablice
  console.log(`\n${W}${"═".repeat(70)}${RESET}`);
  console.log(`  📊 REZULTATI — ${TIMEFRAME} — svi simboli zbrojeni`);
  console.log(`${W}${"═".repeat(70)}${RESET}`);

  const HDR = `${"COMBO".padEnd(26)} ${"TRAD".padStart(5)} ${"WIN".padStart(5)} ${"LOSS".padStart(5)} ${"WR%".padStart(7)} ${"P&L%".padStart(9)} ${"PF".padStart(7)} ${"ZARADA".padStart(9)}`;
  console.log(`${B}${HDR}${RESET}`);
  console.log("─".repeat(78));

  let bestPnl = -Infinity, bestLabel = "";

  for (const combo of COMBOS) {
    const r   = results[combo.label];
    const rr  = combo.tp / combo.sl;
    const wr  = r.trades ? r.wins / r.trades * 100 : 0;
    // P&L u % banke uz RISK_PCT rizik po tradeu
    const pnlPct = r.wins * RISK_PCT * rr - r.losses * RISK_PCT;
    const grossW = r.wins   * RISK_PCT * rr;
    const grossL = r.losses * RISK_PCT;
    const pf     = grossL === 0 ? Infinity : grossW / grossL;
    // Koliko $ zarade na $300 banci
    const profit = 300 * pnlPct / 100;

    const col  = pnlPct >= 0 ? G : R;
    const pnlS = (pnlPct>=0?"+":"") + pnlPct.toFixed(1) + "%";
    const pfS  = pf === Infinity ? "∞" : pf.toFixed(2);
    const profS= (profit>=0?"+":"") + profit.toFixed(1) + "$";
    const wrS  = wr.toFixed(1) + "%";

    // Minimalni WR potreban za break-even: 1/(1+RR)
    const minWr = 1 / (1 + rr) * 100;
    const wrOk  = wr >= minWr ? G : R;

    console.log(
      `${col}${combo.label.padEnd(26)}${RESET}` +
      ` ${String(r.trades).padStart(5)}` +
      ` ${String(r.wins).padStart(5)}` +
      ` ${String(r.losses).padStart(5)}` +
      ` ${wrOk}${wrS.padStart(7)}${RESET}` +
      ` ${col}${pnlS.padStart(9)}${RESET}` +
      ` ${col}${pfS.padStart(7)}${RESET}` +
      ` ${col}${profS.padStart(9)}${RESET}`
    );

    if (pnlPct > bestPnl) { bestPnl = pnlPct; bestLabel = combo.label; }
  }

  console.log("─".repeat(78));
  console.log(`\n  ${Y}Break-even WR:${RESET} RR 1:2 → 33.3% | RR 1:2 → 33.3% (sve iste jer je RR uvijek 1:2)`);
  console.log(`  ${Y}Rizik:${RESET} ${RISK_PCT}% banke po tradeu | Početni kapital: $300`);
  console.log(`\n  ${G}🏆 Najbolja kombinacija: ${bestLabel}${RESET}`);

  // Detalji po simbolu za svaki combo
  console.log(`\n\n${W}${"═".repeat(70)}${RESET}`);
  console.log(`  📋 DETALJI PO SIMBOLU (svi comboji)`);
  console.log(`${W}${"═".repeat(70)}${RESET}`);

  const symHdr = `${"SIMBOL".padEnd(12)}` + COMBOS.map(c => ` ${("SL"+c.sl+"/TP"+c.tp).padStart(12)}`).join("");
  console.log(`${B}${symHdr}${RESET}`);
  console.log("─".repeat(60));

  for (const symbol of SYMBOLS) {
    const candles = candleMap[symbol];
    if (!candles || candles.length < 250) continue;

    let line = symbol.padEnd(12);
    for (const combo of COMBOS) {
      const trades = runBacktest(candles, combo.sl, combo.tp);
      const wins   = trades.filter(t => t.exitReason==="TP").length;
      const losses = trades.filter(t => t.exitReason==="SL").length;
      const rr     = combo.tp / combo.sl;
      const pnl    = wins * RISK_PCT * rr - losses * RISK_PCT;
      const col    = pnl >= 0 ? G : R;
      const pnlS   = (pnl>=0?"+":"") + pnl.toFixed(1) + "% T"+trades.length;
      line += ` ${col}${pnlS.padStart(12)}${RESET}`;
    }
    console.log(line);
  }

  console.log(`\n  ℹ️  Svaki poziv runBacktest() je cache-free (rerun svakog simbola za detalje)`);
  console.log(`     za brže: samo zbrojeni rezultati su pouzdani (gore)\n`);
}

main().catch(err => { console.error("GREŠKA:", err); process.exit(1); });
