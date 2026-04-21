/**
 * MEGA Strategy — SL Comparison Backtest
 * Uspoređuje slMult 1.5 vs 1.0 na MEGA watchlisti
 * Leverage: 15x | Margin: $15 (1.5% od $1000) | TP mult: 3.0 uvijek
 */

const CAPITAL      = 1000;
const LEVERAGE     = 15;
const SL_MULT      = 1.5;   // optimalni (potvrđen backtestom)
const TP_MULT      = 3.0;
const RISK_PCTS    = [0.015, 0.020, 0.025];  // 1.5%, 2.0%, 2.5%
const MIN_BARS     = 210;
const DELAY_MS     = 200;

// MEGA watchlist s optimalnim TF-ovima iz rules.json
const SYMBOLS_TF = [
  { symbol: 'SOLUSDT',  tf: '1H'  },
  { symbol: 'XAGUSDT',  tf: '30m' },
  { symbol: 'HYPEUSDT', tf: '5m'  },
  { symbol: 'LINKUSDT', tf: '5m'  },
  { symbol: 'PEPEUSDT', tf: '5m'  },
  { symbol: 'ZECUSDT',  tf: '30m' },
  { symbol: 'BTCUSDT',  tf: '15m' },
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
  if (closes.length < period + 1) return result;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  const avgGains  = calcRMASeries(gains, period);
  const avgLosses = calcRMASeries(losses, period);
  for (let i = 0; i < avgGains.length; i++) {
    if (avgGains[i] === null) continue;
    const rs = avgLosses[i] === 0 ? 100 : avgGains[i] / avgLosses[i];
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
  const plusDMs = [0], minusDMs = [0];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
    const up   = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
  }
  const atr     = calcRMASeries(trs, period);
  const pDI_rma = calcRMASeries(plusDMs, period);
  const mDI_rma = calcRMASeries(minusDMs, period);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!atr[i] || atr[i] === 0) continue;
    const pDI = (pDI_rma[i] / atr[i]) * 100;
    const mDI = (mDI_rma[i] / atr[i]) * 100;
    const sum  = pDI + mDI;
    dx[i] = sum === 0 ? 0 : (Math.abs(pDI - mDI) / sum) * 100;
  }
  const adx = calcRMASeries(dx.map(v => v ?? 0), period);
  for (let i = 0; i < n; i++) {
    if (dx[i] !== null && adx[i] !== null) result[i] = adx[i];
  }
  return result;
}

function calcChopSeries(candles, period = 14) {
  const n   = candles.length;
  const result = new Array(n).fill(null);
  const atr1 = calcATRSeries(candles, 1);
  for (let i = period - 1; i < n; i++) {
    let sumATR = 0, hiH = -Infinity, loL = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (atr1[j] !== null) sumATR += atr1[j];
      if (candles[j].h > hiH) hiH = candles[j].h;
      if (candles[j].l < loL) loL = candles[j].l;
    }
    const range = hiH - loL;
    if (range === 0) continue;
    result[i] = (100 * Math.log10(sumATR / range)) / Math.log10(period);
  }
  return result;
}

// ─── API fetch ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchCandles(symbol, tf) {
  const BASE = 'https://api.bitget.com/api/v2/mix/market';
  let candles = [];

  if (SHORT_TF.includes(tf)) {
    const url = `${BASE}/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${tf}&limit=1000`;
    try {
      const res = await fetch(url);
      const d   = await res.json();
      if (!d.data || !Array.isArray(d.data)) return null;
      candles = d.data;
    } catch { return null; }
  } else {
    // Pagination za 5m, 15m
    let endTime = Date.now();
    for (let batch = 0; batch < 12; batch++) {
      const url = `${BASE}/history-candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${tf}&limit=200&endTime=${endTime}`;
      try {
        const res = await fetch(url);
        const d   = await res.json();
        if (!d.data || !Array.isArray(d.data) || d.data.length === 0) break;
        candles  = [...d.data, ...candles];
        endTime  = parseInt(d.data[0][0]) - 1;
        await sleep(DELAY_MS);
        if (d.data.length < 200) break;
      } catch { break; }
    }
    if (candles.length === 0) return null;
  }

  return candles.map(c => ({
    t: parseInt(c[0]),
    o: parseFloat(c[1]),
    h: parseFloat(c[2]),
    l: parseFloat(c[3]),
    c: parseFloat(c[4]),
  })).sort((a, b) => a.t - b.t);
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles, slMult, riskPct) {
  const n = candles.length;
  if (n < MIN_BARS) return null;

  const closes = candles.map(c => c.c);
  const ema9   = calcEMASeries(closes, 9);
  const ema21  = calcEMASeries(closes, 21);
  const ema55  = calcEMASeries(closes, 55);
  const ema200 = calcEMASeries(closes, 200);
  const rsi    = calcRSISeries(closes, 14);
  const adx    = calcADXSeries(candles, 14);
  const chop   = calcChopSeries(candles, 14);
  const atr    = calcATRSeries(candles, 14);

  let equity    = CAPITAL;
  let peakEquity = CAPITAL;
  let maxDD     = 0;
  let inTrade   = false;
  let tradeDir, entryPrice, slPrice, tpPrice, posSize;
  const trades  = [];

  for (let i = 200; i < n; i++) {
    const bar = candles[i];

    // ── Exit check ──
    if (inTrade) {
      let exitPrice = null, win = false;
      if (tradeDir === 'long') {
        if (bar.l <= slPrice)  { exitPrice = slPrice; win = false; }
        else if (bar.h >= tpPrice) { exitPrice = tpPrice; win = true; }
      } else {
        if (bar.h >= slPrice)  { exitPrice = slPrice; win = false; }
        else if (bar.l <= tpPrice) { exitPrice = tpPrice; win = true; }
      }
      if (exitPrice !== null) {
        const diff = tradeDir === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
        const pnl  = diff * posSize;
        equity += pnl;
        trades.push({ win, pnl });
        if (equity > peakEquity) peakEquity = equity;
        const dd = (peakEquity - equity) / peakEquity * 100;
        if (dd > maxDD) maxDD = dd;
        inTrade = false;
      }
    }

    // ── Entry check ──
    if (!inTrade) {
      const e9 = ema9[i], e9p = ema9[i-1];
      const e21 = ema21[i], e21p = ema21[i-1];
      const e55 = ema55[i], e200 = ema200[i];
      const r = rsi[i], a = adx[i], ch = chop[i], atrVal = atr[i];
      const close = bar.c;

      if (!e9||!e21||!e55||!e200||!e9p||!e21p||!r||!a||!ch||!atrVal) continue;

      const crossAbove = e9p < e21p && e9 > e21;
      const crossBelow = e9p > e21p && e9 < e21;

      const slDist = atrVal * slMult;
      const tpDist = atrVal * TP_MULT;

      // LONG
      if (crossAbove && close > e55 && close > e200 && r > 30 && r < 60 && a > 18 && ch < 61.8) {
        const margin = equity * riskPct;
        posSize    = (margin * LEVERAGE) / close;
        inTrade    = true;
        tradeDir   = 'long';
        entryPrice = close;
        slPrice    = close - slDist;
        tpPrice    = close + tpDist;
      }
      // SHORT
      else if (crossBelow && close < e55 && close < e200 && r > 40 && r < 70 && a > 18 && ch < 61.8) {
        const margin = equity * riskPct;
        posSize    = (margin * LEVERAGE) / close;
        inTrade    = true;
        tradeDir   = 'short';
        entryPrice = close;
        slPrice    = close + slDist;
        tpPrice    = close - tpDist;
      }
    }
  }

  if (trades.length === 0) return { trades: 0, wins: 0, wr: 0, pf: 0, pnl: 0, maxDD: 0 };

  const wins      = trades.filter(t => t.win).length;
  const grossWin  = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));
  const pf        = grossLoss === 0 ? 99 : grossWin / grossLoss;

  return {
    trades: trades.length,
    wins,
    wr: (wins / trades.length) * 100,
    pf,
    pnl: equity - CAPITAL,
    maxDD
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('='.repeat(72));
  console.log('  MEGA RISK% COMPARISON — 1.5% vs 2.0% vs 2.5% margina');
  console.log(`  Leverage: ${LEVERAGE}x | SL mult: ${SL_MULT} | TP mult: ${TP_MULT} | R:R = 1:2`);
  console.log('='.repeat(72));

  // Fetch sve candle setove (jednom)
  const candleCache = {};
  for (const { symbol, tf } of SYMBOLS_TF) {
    process.stdout.write(`Fetching ${symbol} ${tf} ... `);
    await sleep(DELAY_MS);
    const candles = await fetchCandles(symbol, tf);
    candleCache[`${symbol}_${tf}`] = candles;
    console.log(candles ? `${candles.length} candles` : 'FAILED');
  }

  // Results po RISK_PCT
  for (const riskPct of RISK_PCTS) {
    const marginAmt = (CAPITAL * riskPct).toFixed(0);
    const notional  = (CAPITAL * riskPct * LEVERAGE).toFixed(0);
    console.log('');
    console.log('-'.repeat(72));
    console.log(`  Rizik = ${(riskPct*100).toFixed(1)}%  |  Margin/trade = $${marginAmt}  |  Notional = $${notional}`);
    console.log('-'.repeat(72));
    console.log(`  ${'Symbol'.padEnd(12)} ${'TF'.padEnd(6)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'PF'.padEnd(7)} ${'PnL $'.padEnd(12)} MaxDD%`);
    console.log('  ' + '-'.repeat(64));

    let totalTrades = 0, totalWins = 0, totalPnl = 0;

    for (const { symbol, tf } of SYMBOLS_TF) {
      const candles = candleCache[`${symbol}_${tf}`];
      if (!candles) { console.log(`  ${symbol.padEnd(12)} ${tf.padEnd(6)} NO DATA`); continue; }

      const r = runBacktest(candles, SL_MULT, riskPct);
      if (!r) { console.log(`  ${symbol.padEnd(12)} ${tf.padEnd(6)} FAILED`); continue; }

      totalTrades += r.trades;
      totalWins   += r.wins;
      totalPnl    += r.pnl;

      const marker = r.pf >= 2.0 ? ' ***' : r.pf >= 1.5 ? ' **' : r.pf >= 1.0 ? ' *' : ' ❌';
      console.log(
        `  ${symbol.padEnd(12)} ${tf.padEnd(6)} ${String(r.trades).padEnd(8)}` +
        `${r.wr.toFixed(0).padEnd(8)} ${r.pf.toFixed(2).padEnd(7)}` +
        `${('$' + r.pnl.toFixed(0)).padEnd(12)} ${r.maxDD.toFixed(1)}%${marker}`
      );
    }

    const totalWR = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(0) : 0;
    console.log('  ' + '-'.repeat(64));
    console.log(`  ${'UKUPNO'.padEnd(20)} ${String(totalTrades).padEnd(8)}${String(totalWR + '%').padEnd(8)} ${''.padEnd(7)}$${totalPnl.toFixed(0)}`);
  }

  console.log('');
  console.log('='.repeat(72));
  console.log('  WR i PF su isti za sve — mijenja se samo iznos profita/gubitka');
  console.log('  MaxDD% raste s većim rizikom — pazi na drawdown!');
  console.log('='.repeat(72));
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
