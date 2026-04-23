/**
 * MEGA MEGA Strategy Backtest
 * = MEGA (EMA9/21 + EMA55/200 + RSI + ADX + Chop)
 * + EMA145 trend filter (iz 3-Layer)
 * + MACD histogram momentum (iz 3-Layer)
 *
 * LONG entry (SVE mora biti true):
 *   EMA9 crossed above EMA21
 *   close > EMA55 AND close > EMA200 AND close > EMA145
 *   MACD histogram > 0 (momentum pozitivan)
 *   RSI > 30 AND RSI < 60
 *   ADX > 18
 *   Choppiness < 61.8
 *
 * SHORT entry (SVE mora biti true):
 *   EMA9 crossed below EMA21
 *   close < EMA55 AND close < EMA200 AND close < EMA145
 *   MACD histogram < 0 (momentum negativan)
 *   RSI > 40 AND RSI < 70
 *   ADX > 18
 *   Choppiness < 61.8
 *
 * Risk: 2.0% equity | SL = ATR×1.5 | TP = ATR×3.0 | Leverage 15x
 */

const CAPITAL   = 1000;
const RISK_PCT  = 0.020;   // 2.0% po tradeu
const LEVERAGE  = 15;
const SL_MULT   = 1.5;
const TP_MULT   = 3.0;
const MIN_BARS  = 210;
const DELAY_MS  = 200;

// MEGA watchlist s optimalnim TF-ovima
const SYMBOLS_TF = [
  { symbol: 'SOLUSDT',  tf: '1H'  },
  { symbol: 'XAGUSDT',  tf: '30m' },
  { symbol: 'HYPEUSDT', tf: '5m'  },
  { symbol: 'LINKUSDT', tf: '5m'  },
  { symbol: 'PEPEUSDT', tf: '5m'  },
  { symbol: 'ZECUSDT',  tf: '30m' },
  { symbol: 'BTCUSDT',  tf: '15m' },
];

// Dodajemo sve ostale simbole iz watchlisti za usporedbu
const ALL_SYMBOLS_TF = [
  { symbol: 'SOLUSDT',   tf: '1H'  },
  { symbol: 'XAGUSDT',   tf: '30m' },
  { symbol: 'HYPEUSDT',  tf: '5m'  },
  { symbol: 'LINKUSDT',  tf: '5m'  },
  { symbol: 'PEPEUSDT',  tf: '5m'  },
  { symbol: 'ZECUSDT',   tf: '30m' },
  { symbol: 'BTCUSDT',   tf: '15m' },
  { symbol: 'ETHUSDT',   tf: '1H'  },
  { symbol: 'SUIUSDT',   tf: '1H'  },
  { symbol: 'AAVEUSDT',  tf: '1H'  },
  { symbol: 'ORDIUSDT',  tf: '30m' },
  { symbol: 'TAOUSDT',   tf: '30m' },
  { symbol: 'XRPUSDT',   tf: '1H'  },
  { symbol: 'XAUUSDT',   tf: '1H'  },
  { symbol: 'DOGEUSDT',  tf: '1H'  },
  { symbol: 'ADAUSDT',   tf: '1H'  },
  { symbol: 'NEARUSDT',  tf: '1H'  },
];

const SHORT_TF = ['1D', '4H', '1H', '30m'];

// ─── Indicator helpers ────────────────────────────────────────────────────────

function calcEMASeries(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  let v = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = v;
  for (let i = period; i < closes.length; i++) {
    v = closes[i] * k + v * (1 - k);
    result[i] = v;
  }
  return result;
}

function calcRMASeries(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  let v = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = v;
  for (let i = period; i < values.length; i++) {
    v = (v * (period - 1) + values[i]) / period;
    result[i] = v;
  }
  return result;
}

function calcRSISeries(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const ag = calcRMASeries(gains, period);
  const al = calcRMASeries(losses, period);
  for (let i = 0; i < ag.length; i++) {
    if (ag[i] === null) continue;
    const rs = al[i] === 0 ? 100 : ag[i] / al[i];
    result[i + 1] = 100 - 100 / (1 + rs);
  }
  return result;
}

function calcATRSeries(candles, period = 14) {
  const trs = [candles[0].h - candles[0].l];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
  }
  return calcRMASeries(trs, period);
}

function calcADXSeries(candles, period = 14) {
  const n = candles.length;
  const result = new Array(n).fill(null);
  const trs = [candles[0].h - candles[0].l];
  const pDMs = [0], mDMs = [0];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
    const up = candles[i].h - candles[i - 1].h;
    const dn = candles[i - 1].l - candles[i].l;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  const atr  = calcRMASeries(trs, period);
  const pDI  = calcRMASeries(pDMs, period);
  const mDI  = calcRMASeries(mDMs, period);
  const dx   = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!atr[i] || atr[i] === 0) continue;
    const p = (pDI[i] / atr[i]) * 100;
    const m = (mDI[i] / atr[i]) * 100;
    const s = p + m;
    dx[i] = s === 0 ? 0 : (Math.abs(p - m) / s) * 100;
  }
  const adx = calcRMASeries(dx.map(v => v ?? 0), period);
  for (let i = 0; i < n; i++) {
    if (dx[i] !== null && adx[i] !== null) result[i] = adx[i];
  }
  return result;
}

function calcChopSeries(candles, period = 14) {
  const n    = candles.length;
  const result = new Array(n).fill(null);
  const atr1 = calcATRSeries(candles, 1);
  for (let i = period - 1; i < n; i++) {
    let sum = 0, hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (atr1[j]) sum += atr1[j];
      if (candles[j].h > hi) hi = candles[j].h;
      if (candles[j].l < lo) lo = candles[j].l;
    }
    const range = hi - lo;
    if (range === 0) continue;
    result[i] = (100 * Math.log10(sum / range)) / Math.log10(period);
  }
  return result;
}

// MACD histogram series
function calcMACDHistSeries(closes, fast = 12, slow = 26, signal = 9) {
  const n       = closes.length;
  const result  = new Array(n).fill(null);
  const emaFast = calcEMASeries(closes, fast);
  const emaSlow = calcEMASeries(closes, slow);

  // MACD line = emaFast - emaSlow
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );

  // Signal line = EMA9 of macdLine
  const validMacd   = macdLine.filter(v => v !== null);
  const signalRaw   = calcEMASeries(validMacd, signal);
  let vi = 0;
  const signalLine  = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (macdLine[i] !== null) {
      signalLine[i] = signalRaw[vi++] ?? null;
    }
  }

  // Histogram = macdLine - signalLine
  for (let i = 0; i < n; i++) {
    if (macdLine[i] !== null && signalLine[i] !== null) {
      result[i] = macdLine[i] - signalLine[i];
    }
  }
  return result;
}

// ─── API fetch ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Izračun potrebnih candles za 90 dana
function neededCandles(tf) {
  const msPerCandle = {
    '1D': 86400000, '4H': 14400000, '1H': 3600000,
    '30m': 1800000, '15m': 900000, '5m': 300000
  }[tf] || 3600000;
  return Math.ceil(90 * 86400000 / msPerCandle) + 250; // +250 za warmup indikatora
}

async function fetchCandles(symbol, tf) {
  const BASE   = 'https://api.bitget.com/api/v2/mix/market';
  const needed = neededCandles(tf);
  const pages  = Math.ceil(needed / 1000);
  let all      = [];
  let endTime  = null;

  for (let p = 0; p < pages; p++) {
    const url = `${BASE}/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${tf}&limit=1000` +
                (endTime ? `&endTime=${endTime}` : '');
    try {
      const res = await fetch(url);
      const d   = await res.json();
      if (!d.data || !Array.isArray(d.data) || d.data.length === 0) break;
      all     = [...d.data, ...all];
      endTime = parseInt(d.data[d.data.length - 1][0]) - 1; // najstariji candle - 1ms
      await sleep(DELAY_MS);
      if (d.data.length < 1000) break;
    } catch { break; }
  }

  if (all.length === 0) return null;

  return all.map(c => ({
    t: parseInt(c[0]),
    o: parseFloat(c[1]),
    h: parseFloat(c[2]),
    l: parseFloat(c[3]),
    c: parseFloat(c[4]),
  })).sort((a, b) => a.t - b.t);
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles, label = 'MEGA MEGA') {
  const n = candles.length;
  if (n < MIN_BARS) return null;

  const closes  = candles.map(c => c.c);
  const ema9    = calcEMASeries(closes, 9);
  const ema21   = calcEMASeries(closes, 21);
  const ema55   = calcEMASeries(closes, 55);
  const ema145  = calcEMASeries(closes, 145);
  const ema200  = calcEMASeries(closes, 200);
  const rsi     = calcRSISeries(closes, 14);
  const adx     = calcADXSeries(candles, 14);
  const chop    = calcChopSeries(candles, 14);
  const atr     = calcATRSeries(candles, 14);
  const macdH   = calcMACDHistSeries(closes, 12, 26, 9);

  let equity    = CAPITAL;
  let peak      = CAPITAL;
  let maxDD     = 0;
  let inTrade   = false;
  let tradeDir, entry, sl, tp, posSize;
  const trades  = [];

  for (let i = 200; i < n; i++) {
    const bar   = candles[i];
    const close = bar.c;

    // ── Exit ──
    if (inTrade) {
      let exitPrice = null, win = false;
      if (tradeDir === 'long') {
        if (bar.l <= sl)  { exitPrice = sl;  win = false; }
        else if (bar.h >= tp) { exitPrice = tp; win = true; }
      } else {
        if (bar.h >= sl)  { exitPrice = sl;  win = false; }
        else if (bar.l <= tp) { exitPrice = tp; win = true; }
      }
      if (exitPrice !== null) {
        const diff = tradeDir === 'long' ? exitPrice - entry : entry - exitPrice;
        const pnl  = diff * posSize;
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
      const e9  = ema9[i],  e9p  = ema9[i - 1];
      const e21 = ema21[i], e21p = ema21[i - 1];
      const e55 = ema55[i];
      const e145 = ema145[i];
      const e200 = ema200[i];
      const r   = rsi[i];
      const a   = adx[i];
      const ch  = chop[i];
      const av  = atr[i];
      const mh  = macdH[i];

      if (!e9||!e21||!e55||!e145||!e200||!e9p||!e21p||!r||!a||!ch||!av||mh===null) continue;

      const crossAbove = e9p < e21p && e9 > e21;
      const crossBelow = e9p > e21p && e9 < e21;
      const slDist = av * SL_MULT;
      const tpDist = av * TP_MULT;

      // LONG: svi filteri moraju biti bullish
      if (crossAbove
        && close > e55 && close > e200 && close > e145
        && mh > 0
        && r > 30 && r < 60
        && a > 18 && ch < 61.8) {

        const margin = equity * RISK_PCT;
        posSize  = (margin * LEVERAGE) / close;
        inTrade  = true; tradeDir = 'long';
        entry    = close;
        sl       = close - slDist;
        tp       = close + tpDist;
      }
      // SHORT: svi filteri moraju biti bearish
      else if (crossBelow
        && close < e55 && close < e200 && close < e145
        && mh < 0
        && r > 40 && r < 70
        && a > 18 && ch < 61.8) {

        const margin = equity * RISK_PCT;
        posSize  = (margin * LEVERAGE) / close;
        inTrade  = true; tradeDir = 'short';
        entry    = close;
        sl       = close + slDist;
        tp       = close - tpDist;
      }
    }
  }

  if (trades.length === 0) return { trades: 0, wins: 0, wr: 0, pf: 0, pnl: 0, maxDD: 0 };

  const wins     = trades.filter(t => t.win).length;
  const grossW   = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0);
  const grossL   = Math.abs(trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));
  const pf       = grossL === 0 ? 99 : grossW / grossL;

  return {
    trades: trades.length, wins,
    wr: (wins / trades.length) * 100,
    pf, pnl: equity - CAPITAL, maxDD
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('='.repeat(72));
  console.log('  MEGA MEGA Strategy Backtest');
  console.log('  = MEGA + EMA145 + MACD histogram');
  console.log(`  Rizik: ${(RISK_PCT*100).toFixed(1)}% | Leverage: ${LEVERAGE}x | SL: ATR×${SL_MULT} | TP: ATR×${TP_MULT} | R:R 1:2`);
  console.log('='.repeat(72));
  console.log('');

  const results = [];

  for (const { symbol, tf } of ALL_SYMBOLS_TF) {
    process.stdout.write(`${symbol} ${tf} ... `);
    await sleep(DELAY_MS);
    const candles = await fetchCandles(symbol, tf);

    if (!candles || candles.length < MIN_BARS) {
      console.log(`preskočeno (${candles?.length ?? 0} svjeća)`);
      results.push({ symbol, tf, trades: 0, wins: 0, wr: 0, pf: 0, pnl: 0, maxDD: 0 });
      continue;
    }

    const r = runBacktest(candles);
    results.push({ symbol, tf, ...r });

    if (r.trades === 0) {
      console.log('0 tradova');
    } else {
      const marker = r.pf >= 2.0 ? '***' : r.pf >= 1.5 ? '**' : r.pf >= 1.0 ? '*' : '❌';
      console.log(`${r.trades} tradova | WR ${r.wr.toFixed(0)}% | PF ${r.pf.toFixed(2)} | PnL $${r.pnl.toFixed(0)} | DD ${r.maxDD.toFixed(1)}%  ${marker}`);
    }
  }

  // ── Usporedna tablica ──
  console.log('');
  console.log('='.repeat(72));
  console.log('  REZULTATI — sortirano po Profit Factoru');
  console.log('='.repeat(72));
  console.log(`  ${'Symbol'.padEnd(12)} ${'TF'.padEnd(6)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'PF'.padEnd(7)} ${'PnL $'.padEnd(12)} MaxDD%`);
  console.log('  ' + '-'.repeat(64));

  const sorted = [...results].sort((a, b) => b.pf - a.pf);
  let totalTrades = 0, totalWins = 0, totalPnl = 0;

  for (const r of sorted) {
    if (r.trades === 0) continue;
    totalTrades += r.trades;
    totalWins   += r.wins;
    totalPnl    += r.pnl;
    const marker = r.pf >= 2.0 ? ' ***' : r.pf >= 1.5 ? ' **' : r.pf >= 1.0 ? ' *' : ' ❌';
    console.log(
      `  ${r.symbol.padEnd(12)} ${r.tf.padEnd(6)} ${String(r.trades).padEnd(8)}` +
      `${r.wr.toFixed(0).padEnd(8)} ${r.pf.toFixed(2).padEnd(7)}` +
      `${('$' + r.pnl.toFixed(0)).padEnd(12)} ${r.maxDD.toFixed(1)}%${marker}`
    );
  }

  const avgWR = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(0) : 0;
  console.log('  ' + '-'.repeat(64));
  console.log(`  ${'UKUPNO'.padEnd(20)} ${String(totalTrades).padEnd(8)}${String(avgWR + '%').padEnd(8)} ${''.padEnd(7)}$${totalPnl.toFixed(0)}`);

  // Top setovi
  const top = results.filter(r => r.pf >= 1.5 && r.trades >= 3).sort((a, b) => b.pf - a.pf);
  console.log('');
  console.log('='.repeat(72));
  console.log(`  TOP SETOVI (PF >= 1.5, min 3 trada): ${top.length} pronađeno`);
  console.log('='.repeat(72));
  for (const r of top) {
    console.log(`  ${r.symbol.padEnd(12)} ${r.tf.padEnd(6)} PF=${r.pf.toFixed(2)}  WR=${r.wr.toFixed(0)}%  tradova=${r.trades}  PnL=$${r.pnl.toFixed(0)}  DD=${r.maxDD.toFixed(1)}%`);
  }

  console.log('');
  console.log('  LEGENDA: *** PF>=2.0  ** PF>=1.5  * PF>=1.0  ❌ PF<1.0');
  console.log('  Min 3 trada po simbolu za statisticku pouzdanost');
  console.log('='.repeat(72));
  console.log('');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
