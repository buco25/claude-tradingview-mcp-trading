/**
 * Timeframe Comparison Backtest
 * Testira sve MEGA simbole na 5m, 15m i 1H
 * Fiksni SL 2.5% / TP 5.0% / R:R 1:2 / Rizik 2.0% / Leverage 15x
 */

const CAPITAL  = 1000;
const RISK_PCT = 0.020;
const LEVERAGE = 15;
const SL_PCT   = 2.5;   // fiksni %
const TP_PCT   = 5.0;   // fiksni %
const MIN_BARS = 210;
const DELAY_MS = 250;

const SYMBOLS = [
  'SOLUSDT', 'XAGUSDT', 'HYPEUSDT', 'LINKUSDT',
  'PEPEUSDT', 'ZECUSDT', 'BTCUSDT',
  'ETHUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT',
  'AAVEUSDT', 'SUIUSDT', 'NEARUSDT',
];

const TIMEFRAMES = ['5m', '15m', '1H'];

// ─── Indicators ───────────────────────────────────────────────────────────────

function emaSeries(closes, p) {
  const k = 2 / (p + 1), r = new Array(closes.length).fill(null);
  if (closes.length < p) return r;
  let v = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
  r[p - 1] = v;
  for (let i = p; i < closes.length; i++) { v = closes[i] * k + v * (1 - k); r[i] = v; }
  return r;
}

function rmaSeries(vals, p) {
  const r = new Array(vals.length).fill(null);
  if (vals.length < p) return r;
  let v = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  r[p - 1] = v;
  for (let i = p; i < vals.length; i++) { v = (v * (p - 1) + vals[i]) / p; r[i] = v; }
  return r;
}

function rsiSeries(closes, p = 14) {
  const r = new Array(closes.length).fill(null);
  const g = [], l = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g.push(d > 0 ? d : 0); l.push(d < 0 ? -d : 0);
  }
  const ag = rmaSeries(g, p), al = rmaSeries(l, p);
  for (let i = 0; i < ag.length; i++) {
    if (ag[i] === null) continue;
    r[i + 1] = 100 - 100 / (1 + (al[i] === 0 ? 100 : ag[i] / al[i]));
  }
  return r;
}

function atrSeries(candles, p = 14) {
  const trs = [candles[0].h - candles[0].l];
  for (let i = 1; i < candles.length; i++)
    trs.push(Math.max(candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c)));
  return rmaSeries(trs, p);
}

function adxSeries(candles, p = 14) {
  const n = candles.length, r = new Array(n).fill(null);
  const trs = [candles[0].h - candles[0].l], pDMs = [0], mDMs = [0];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(candles[i].h-candles[i].l,
      Math.abs(candles[i].h-candles[i-1].c), Math.abs(candles[i].l-candles[i-1].c)));
    const up = candles[i].h-candles[i-1].h, dn = candles[i-1].l-candles[i].l;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  const atr = rmaSeries(trs, p), pDI = rmaSeries(pDMs, p), mDI = rmaSeries(mDMs, p);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!atr[i] || atr[i] === 0) continue;
    const pp = (pDI[i]/atr[i])*100, mm = (mDI[i]/atr[i])*100, s = pp+mm;
    dx[i] = s === 0 ? 0 : Math.abs(pp-mm)/s*100;
  }
  const adx = rmaSeries(dx.map(v => v ?? 0), p);
  for (let i = 0; i < n; i++) if (dx[i] !== null && adx[i] !== null) r[i] = adx[i];
  return r;
}

function chopSeries(candles, p = 14) {
  const n = candles.length, r = new Array(n).fill(null);
  const atr1 = atrSeries(candles, 1);
  for (let i = p - 1; i < n; i++) {
    let sum = 0, hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) {
      if (atr1[j]) sum += atr1[j];
      if (candles[j].h > hi) hi = candles[j].h;
      if (candles[j].l < lo) lo = candles[j].l;
    }
    const range = hi - lo;
    if (range > 0) r[i] = (100 * Math.log10(sum / range)) / Math.log10(p);
  }
  return r;
}

// ─── Fetch (90 dana) ──────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function candlesNeeded(tf) {
  const ms = { '5m':300000, '15m':900000, '1H':3600000 }[tf] || 3600000;
  return Math.ceil(90 * 86400000 / ms) + 250;
}

async function fetchCandles(symbol, tf) {
  const BASE   = 'https://api.bitget.com/api/v2/mix/market';
  const needed = candlesNeeded(tf);
  const pages  = Math.ceil(needed / 1000);
  let all = [], endTime = null;

  for (let p = 0; p < pages; p++) {
    const url = `${BASE}/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${tf}&limit=1000` +
                (endTime ? `&endTime=${endTime}` : '');
    try {
      const res = await fetch(url);
      const d   = await res.json();
      if (!d.data || !Array.isArray(d.data) || d.data.length === 0) break;
      all     = [...d.data, ...all];
      endTime = parseInt(d.data[0][0]) - 1;  // najstariji u batchu (ASC)
      await sleep(DELAY_MS);
      if (d.data.length < 1000) break;
    } catch { break; }
  }

  if (all.length === 0) return null;
  const parsed = all.map(c => ({
    t: parseInt(c[0]), o: parseFloat(c[1]),
    h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4])
  })).sort((a, b) => a.t - b.t);
  return parsed.filter((c, i) => i === 0 || c.t !== parsed[i-1].t);
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

function runBacktest(candles) {
  const n = candles.length;
  if (n < MIN_BARS) return null;

  const closes = candles.map(c => c.c);
  const e9   = emaSeries(closes, 9);
  const e21  = emaSeries(closes, 21);
  const e55  = emaSeries(closes, 55);
  const e200 = emaSeries(closes, 200);
  const rsi  = rsiSeries(closes, 14);
  const adx  = adxSeries(candles, 14);
  const chop = chopSeries(candles, 14);

  let equity = CAPITAL, peak = CAPITAL, maxDD = 0;
  let inTrade = false, dir, entryP, sl, tp, posSize;
  const trades = [];

  for (let i = 200; i < n; i++) {
    const bar = candles[i], close = bar.c;

    // ── Exit ──
    if (inTrade) {
      let exitP = null, win = false;
      if (dir === 'long') {
        if (bar.l <= sl)    { exitP = sl; win = false; }
        else if (bar.h >= tp) { exitP = tp; win = true; }
      } else {
        if (bar.h >= sl)    { exitP = sl; win = false; }
        else if (bar.l <= tp) { exitP = tp; win = true; }
      }
      if (exitP !== null) {
        const pnl = (dir === 'long' ? exitP - entryP : entryP - exitP) * posSize;
        equity += pnl;
        trades.push({ win, pnl });
        if (equity > peak) peak = equity;
        const dd = (peak - equity) / peak * 100;
        if (dd > maxDD) maxDD = dd;
        inTrade = false;
      }
    }

    // ── Entry ──
    if (!inTrade) {
      const [v9, v9p, v21, v21p, v55, v200, r, a, ch] =
        [e9[i], e9[i-1], e21[i], e21[i-1], e55[i], e200[i], rsi[i], adx[i], chop[i]];

      if (!v9||!v21||!v55||!v9p||!v21p||r===null) continue;

      const crossUp   = v9p < v21p && v9 > v21;
      const crossDown = v9p > v21p && v9 < v21;
      const trendUp   = close > v55 && (!v200 || close > v200);
      const trendDown = close < v55 && (!v200 || close < v200);
      const trending  = !a  || a  > 18;
      const notChoppy = !ch || ch < 61.8;

      const slDist = close * (SL_PCT / 100);
      const tpDist = close * (TP_PCT / 100);
      const margin  = equity * RISK_PCT;
      posSize = (margin * LEVERAGE) / close;

      if (crossUp && trendUp && r > 30 && r < 60 && trending && notChoppy) {
        inTrade = true; dir = 'long'; entryP = close;
        sl = close - slDist; tp = close + tpDist;
      } else if (crossDown && trendDown && r > 40 && r < 70 && trending && notChoppy) {
        inTrade = true; dir = 'short'; entryP = close;
        sl = close + slDist; tp = close - tpDist;
      }
    }
  }

  if (trades.length === 0) return { trades:0, wins:0, wr:0, pf:0, pnl:0, maxDD:0 };
  const wins   = trades.filter(t => t.win).length;
  const grossW = trades.filter(t => t.win).reduce((s,t) => s+t.pnl, 0);
  const grossL = Math.abs(trades.filter(t => !t.win).reduce((s,t) => s+t.pnl, 0));
  return {
    trades: trades.length, wins,
    wr: wins/trades.length*100,
    pf: grossL === 0 ? 99 : grossW/grossL,
    pnl: equity - CAPITAL, maxDD
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('='.repeat(76));
  console.log('  TIMEFRAME USPOREDBA — 5m vs 15m vs 1H');
  console.log(`  MEGA strategija | SL ${SL_PCT}% | TP ${TP_PCT}% | R:R 1:2 | Rizik ${(RISK_PCT*100).toFixed(1)}% | 90 dana`);
  console.log('='.repeat(76));

  // Fetch jednom po (simbol, TF)
  console.log('\nFetching podataka...');
  const cache = {};
  for (const sym of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      process.stdout.write(`  ${sym} ${tf} ... `);
      await sleep(DELAY_MS);
      const c = await fetchCandles(sym, tf);
      cache[`${sym}_${tf}`] = c;
      if (c) {
        const from = new Date(c[0].t).toISOString().slice(0,10);
        const to   = new Date(c[c.length-1].t).toISOString().slice(0,10);
        console.log(`${c.length} svjeća (${from} → ${to})`);
      } else console.log('FAILED');
    }
  }

  // Rezultati po TF
  const tfTotals = {};
  for (const tf of TIMEFRAMES) {
    console.log('');
    console.log('-'.repeat(76));
    console.log(`  TIMEFRAME: ${tf}`);
    console.log('-'.repeat(76));
    console.log(`  ${'Symbol'.padEnd(12)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'PF'.padEnd(7)} ${'PnL $'.padEnd(12)} MaxDD%`);
    console.log('  ' + '-'.repeat(58));

    let totT = 0, totW = 0, totPnl = 0;
    const rows = [];

    for (const sym of SYMBOLS) {
      const candles = cache[`${sym}_${tf}`];
      if (!candles) { rows.push({ sym, trades:0, wr:0, pf:0, pnl:0, maxDD:0 }); continue; }
      const r = runBacktest(candles);
      rows.push({ sym, ...r });
      totT += r.trades; totW += r.wins; totPnl += r.pnl;
    }

    // Sortiraj po PF
    rows.sort((a, b) => b.pf - a.pf);
    for (const r of rows) {
      if (r.trades === 0) { console.log(`  ${r.sym.padEnd(12)} 0 tradova`); continue; }
      const m = r.pf >= 2.0 ? ' ***' : r.pf >= 1.5 ? ' **' : r.pf >= 1.0 ? ' *' : ' ❌';
      console.log(
        `  ${r.sym.padEnd(12)} ${String(r.trades).padEnd(8)}${r.wr.toFixed(0).padEnd(8)}` +
        `${r.pf.toFixed(2).padEnd(7)}${('$'+r.pnl.toFixed(0)).padEnd(12)}${r.maxDD.toFixed(1)}%${m}`
      );
    }
    const avgWR = totT > 0 ? (totW/totT*100).toFixed(0) : 0;
    console.log('  ' + '-'.repeat(58));
    console.log(`  ${'UKUPNO'.padEnd(12)} ${String(totT).padEnd(8)}${String(avgWR+'%').padEnd(15)}$${totPnl.toFixed(0)}`);
    tfTotals[tf] = { trades: totT, wr: avgWR, pnl: totPnl };
  }

  // Finalni sažetak
  console.log('');
  console.log('='.repeat(76));
  console.log('  POBJEDNIK — ukupni PnL na svim simbolima');
  console.log('='.repeat(76));
  console.log(`  ${'TF'.padEnd(8)} ${'Tradova'.padEnd(10)} ${'WR%'.padEnd(10)} ${'PnL $'}`);
  console.log('  ' + '-'.repeat(40));
  const sorted = Object.entries(tfTotals).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [tf, t] of sorted) {
    const medal = tf === sorted[0][0] ? ' 🏆' : '';
    console.log(`  ${tf.padEnd(8)} ${String(t.trades).padEnd(10)} ${String(t.wr+'%').padEnd(10)} $${t.pnl.toFixed(0)}${medal}`);
  }
  console.log('');
  console.log(`  Preporuka: koristiti ${sorted[0][0]} za sve simbole`);
  console.log('='.repeat(76));
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
