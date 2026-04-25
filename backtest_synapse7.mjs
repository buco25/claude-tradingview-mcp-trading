/**
 * SYNAPSE-7 Backtest — TF Comparison
 * Testira 5m / 15m / 1H / 4H na svim 21 simbolima
 * Isti 5 podsustava kao Pine Script strategija:
 *   1. AI kNN   2. AutoTune (Ehlers)   3. 6-Scale EMA
 *   4. RSI Pumori   5. CVD Delta
 * SL 2% / TP 4% / Rizik 2% / 25x
 */

const CAPITAL  = 1000;
const RISK_PCT = 0.020;
const LEVERAGE = 25;
const SL_PCT   = 2.0;
const TP_PCT   = 4.0;
const MIN_BARS = 300;
const DELAY_MS = 250;
const MIN_SIG  = 3;   // min od 5 podsustava mora se složiti

const SYMBOLS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT',
  'LINKUSDT','AVAXUSDT','NEARUSDT','AAVEUSDT','SUIUSDT','HYPEUSDT',
  'TAOUSDT','WLDUSDT','TRUMPUSDT','PEPEUSDT','ZECUSDT',
  'XAUUSDT','XAGUSDT','ORDIUSDT','RIVERUSDT',
];

const TIMEFRAMES = ['5m', '15m', '1H', '4H'];

// ─── Indicator helpers ────────────────────────────────────────────────────────

function emaSeries(closes, p) {
  const k = 2 / (p + 1);
  const r = new Array(closes.length).fill(null);
  if (closes.length < p) return r;
  let v = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
  r[p - 1] = v;
  for (let i = p; i < closes.length; i++) { v = closes[i] * k + v * (1 - k); r[i] = v; }
  return r;
}

function rmaSeries(vals, p) {
  const r = new Array(vals.length).fill(null);
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
    r[i + 1] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
  }
  return r;
}

// ─── 1. AI kNN (simplified — 3 features, rolling pattern matching) ─────────

function knnSignalSeries(closes, patLen = 10, mem = 20, k = 5, smth = 5, sigLen = 5) {
  const n = closes.length;
  const oscArr = new Array(n).fill(null);
  const sigArr = new Array(n).fill(null);

  // Feature: log-return
  const logRet = closes.map((c, i) => i === 0 ? 0 : Math.log(c / closes[i - 1]));
  // Feature: 5-bar momentum
  const mom5   = closes.map((c, i) => i < 5 ? 0 : (c - closes[i - 5]) / closes[i - 5]);
  // RSI normalised
  const rsi    = rsiSeries(closes, 14);

  const patterns = [];
  const labels   = [];

  const minStart = Math.max(patLen + 2, 35);

  for (let i = minStart; i < n; i++) {
    // Build current pattern (last patLen values of each feature)
    const pat = [];
    for (let j = patLen - 1; j >= 0; j--) {
      const idx = i - j;
      pat.push(logRet[idx] ?? 0, mom5[idx] ?? 0, ((rsi[idx] ?? 50) - 50) / 50);
    }

    // Compare to stored patterns
    const distances = patterns.map((p, pi) => {
      let d = 0;
      for (let x = 0; x < pat.length; x++) d += (pat[x] - p[x]) ** 2;
      return { d: Math.sqrt(d), label: labels[pi] };
    });

    // kNN prediction
    distances.sort((a, b) => a.d - b.d);
    const top = distances.slice(0, Math.min(k, distances.length));
    const sumD = top.reduce((s, x) => s + x.d, 0);
    let pred = 0;
    if (top.length > 0) {
      for (const t of top) {
        const w = top.length > 1 ? (sumD > 0 ? 1 - t.d / sumD : 1) : 1;
        pred += t.label * w;
      }
    }

    // Label for this bar = next bar's return sign
    if (i + 1 < n) {
      const futRet = Math.log(closes[i + 1] / closes[i]);
      const label = futRet > 0 ? 1 : futRet < 0 ? -1 : 0;
      if (patterns.length >= mem) { patterns.shift(); labels.shift(); }
      patterns.push(pat);
      labels.push(label);
    }

    oscArr[i] = pred;
  }

  // EMA smooth + signal
  const smArr = emaSeries(oscArr.map(v => v ?? 0), smth);
  const sgArr = emaSeries(smArr.map(v => v ?? 0), sigLen);

  return oscArr.map((_, i) => {
    if (smArr[i] === null || sgArr[i] === null) return 0;
    const cross = smArr[i - 1] != null && sgArr[i - 1] != null
      ? (smArr[i - 1] <= sgArr[i - 1] && smArr[i] > sgArr[i] ? 1
        : smArr[i - 1] >= sgArr[i - 1] && smArr[i] < sgArr[i] ? -1 : 0)
      : 0;
    // bull only when sig >= 0, bear only when sig <= 0
    if (cross === 1 && sgArr[i] >= 0) return 1;
    if (cross === -1 && sgArr[i] <= 0) return -1;
    return 0;
  });
}

// ─── 2. AutoTune Filter (Ehlers) ──────────────────────────────────────────────

function hpf(vals, p) {
  const w  = 1.414 * Math.PI / p;
  const q  = Math.exp(-w);
  const c1 = 2 * q * Math.cos(w);
  const c2 = q * q;
  const a0 = 0.25 * (1 + c1 + c2);
  const r  = new Array(vals.length).fill(0);
  for (let i = 4; i < vals.length; i++)
    r[i] = a0 * (vals[i] - 2 * vals[i-1] + vals[i-2]) + c1 * r[i-1] - c2 * r[i-2];
  return r;
}

function bpf(vals, p, bw) {
  const w0 = 2 * Math.PI / p;
  const l1 = Math.cos(w0);
  const g1 = Math.cos(w0 * bw);
  const s1 = 1 / g1 - Math.sqrt(1 / (g1 * g1) - 1);
  const r  = new Array(vals.length).fill(0);
  for (let i = 3; i < vals.length; i++)
    r[i] = 0.5 * (1 - s1) * (vals[i] - vals[i-2]) + l1*(1+s1)*r[i-1] - s1*r[i-2];
  return r;
}

function autoTuneSeries(closes, wlen = 20, bw = 0.25) {
  const n  = closes.length;
  const hp = hpf(closes, wlen);
  const bp = new Array(n).fill(0);
  const dc = new Array(n).fill(wlen);

  const window = new Array(wlen).fill(0);

  for (let i = wlen; i < n; i++) {
    window.shift(); window.push(hp[i]);

    // Rolling autocorrelation for each lag
    let minCorr = Infinity, minLag = 1;
    const sx  = window.reduce((a, b) => a + b, 0);
    const sxx = window.reduce((a, b) => a + b * b, 0);

    for (let lag = 1; lag <= wlen; lag++) {
      if (i - lag < 0) continue;
      // lagged window
      const lw = [];
      for (let j = i - lag - wlen + 1; j <= i - lag; j++)
        lw.push(j >= 0 ? hp[j] : 0);
      if (lw.length < wlen) continue;
      const sy  = lw.reduce((a, b) => a + b, 0);
      const syy = lw.reduce((a, b) => a + b * b, 0);
      let sxy = 0;
      for (let j = 0; j < wlen; j++) sxy += window[j] * lw[j];
      const cov  = wlen * sxy - sx * sy;
      const vx   = wlen * sxx - sx * sx;
      const vy   = wlen * syy - sy * sy;
      const den  = Math.sqrt(vx * vy);
      const corr = den > 0 ? cov / den : 0;
      if (corr < minCorr) { minCorr = corr; minLag = lag; }
    }

    let newDc = minLag * 2;
    const prevDc = dc[i - 1] || wlen;
    newDc = Math.min(Math.max(newDc, prevDc - 2), prevDc + 2);
    dc[i] = newDc;
  }

  // Compute BP using per-bar dc (approximate — use period from prev bar for stability)
  const bpAll = bpf(closes, Math.round(dc[dc.length - 1] || wlen), bw);
  for (let i = 0; i < n; i++) bp[i] = bpAll[i];

  return bp;
}

function atSignalSeries(closes) {
  const bp  = autoTuneSeries(closes, 20, 0.25);
  return bp.map((v, i) => {
    if (i === 0) return 0;
    if (v > 0 && v > bp[i-1]) return 1;
    if (v < 0 && v < bp[i-1]) return -1;
    return 0;
  });
}

// ─── 3. 6-Scale EMA Consensus ─────────────────────────────────────────────────

function scaleSignalSeries(closes, minConsensus = 3) {
  const pairs = [[3,11],[5,15],[11,21],[17,27],[27,37],[45,55]];
  const emas  = pairs.map(([f, s]) => [emaSeries(closes, f), emaSeries(closes, s)]);
  return closes.map((_, i) => {
    let up = 0, dn = 0;
    for (const [ef, es] of emas) {
      if (ef[i] === null || es[i] === null) continue;
      if (ef[i] > es[i]) up++; else dn++;
    }
    if (up >= minConsensus) return 1;
    if (dn >= minConsensus) return -1;
    return 0;
  });
}

// ─── 4. RSI Pumori ─────────────────────────────────────────────────────────────

function rsiMomSignalSeries(closes, rsiLen = 14, maLen = 14) {
  const rsi     = rsiSeries(closes, rsiLen);
  const rsiEma  = emaSeries(rsi.map(v => v ?? 0), maLen);
  return rsiEma.map((v, i) => {
    if (v === null || i === 0 || rsiEma[i-1] === null) return 0;
    if (v > 50 && v > rsiEma[i-1]) return 1;
    if (v < 50 && v < rsiEma[i-1]) return -1;
    return 0;
  });
}

// ─── 5. CVD Delta ─────────────────────────────────────────────────────────────

function cvdSignalSeries(candles, period = 20) {
  const delta = candles.map(c => c.volume * Math.sign(c.close - c.open));
  const roll  = new Array(candles.length).fill(0);
  let   sum   = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += delta[i];
    if (i >= period) sum -= delta[i - period];
    roll[i] = sum;
  }
  const smooth = emaSeries(roll, 9);
  return roll.map((v, i) => {
    if (smooth[i] === null) return 0;
    if (v > 0 && v > smooth[i]) return 1;
    if (v < 0 && v < smooth[i]) return -1;
    return 0;
  });
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles) {
  const n = candles.length;
  if (n < MIN_BARS) return null;

  const closes = candles.map(c => c.close);

  const aiSig  = knnSignalSeries(closes);
  const atSig  = atSignalSeries(closes);
  const scSig  = scaleSignalSeries(closes);
  const rsSig  = rsiMomSignalSeries(closes);
  const cvSig  = cvdSignalSeries(candles);

  let equity = CAPITAL, peak = CAPITAL, maxDD = 0;
  let inTrade = false, dir, entryP, sl, tp, posSize;
  const trades = [];

  const startBar = 100;

  for (let i = startBar; i < n; i++) {
    const bar = candles[i];

    // ── Exit ──
    if (inTrade) {
      let exitP = null, win = false;
      if (dir === 'long') {
        if (bar.low <= sl)  { exitP = sl; }
        else if (bar.high >= tp) { exitP = tp; win = true; }
      } else {
        if (bar.high >= sl) { exitP = sl; }
        else if (bar.low <= tp)  { exitP = tp; win = true; }
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
      const bullScore = [aiSig[i],atSig[i],scSig[i],rsSig[i],cvSig[i]].filter(v => v === 1).length;
      const bearScore = [aiSig[i],atSig[i],scSig[i],rsSig[i],cvSig[i]].filter(v => v === -1).length;

      const price  = bar.close;
      const slDist = price * (SL_PCT / 100);
      const tpDist = price * (TP_PCT / 100);
      const margin = equity * RISK_PCT;
      posSize = (margin * LEVERAGE) / price;

      if (bullScore >= MIN_SIG && !inTrade) {
        inTrade = true; dir = 'long'; entryP = price;
        sl = price - slDist; tp = price + tpDist;
      } else if (bearScore >= MIN_SIG && !inTrade) {
        inTrade = true; dir = 'short'; entryP = price;
        sl = price + slDist; tp = price - tpDist;
      }
    }
  }

  if (trades.length === 0) return { trades:0, wins:0, wr:0, pf:0, pnl:0, maxDD:0 };
  const wins   = trades.filter(t => t.win).length;
  const grossW = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));
  return {
    trades: trades.length, wins,
    wr: wins / trades.length * 100,
    pf: grossL === 0 ? 99 : grossW / grossL,
    pnl: equity - CAPITAL, maxDD,
  };
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function candlesNeeded(tf) {
  const ms = { '5m':300000, '15m':900000, '1H':3600000, '4H':14400000 }[tf] || 3600000;
  return Math.ceil(90 * 86400000 / ms) + 350;
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
      if (!d.data || !d.data.length) break;
      all     = [...d.data, ...all];
      endTime = parseInt(d.data[0][0]) - 1;
      await sleep(DELAY_MS);
      if (d.data.length < 1000) break;
    } catch { break; }
  }

  if (!all.length) return null;
  const parsed = all.map(c => ({
    t: parseInt(c[0]), open: parseFloat(c[1]),
    high: parseFloat(c[2]), low: parseFloat(c[3]),
    close: parseFloat(c[4]), volume: parseFloat(c[5]),
  })).sort((a, b) => a.t - b.t);
  return parsed.filter((c, i) => i === 0 || c.t !== parsed[i - 1].t);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('='.repeat(78));
  console.log('  SYNAPSE-7 — TF USPOREDBA: 5m vs 15m vs 1H vs 4H');
  console.log(`  5 signala: AI-kNN + AutoTune + 6-Scale + RSI + CVD`);
  console.log(`  Min ${MIN_SIG}/5 signala | SL ${SL_PCT}% | TP ${TP_PCT}% | Rizik ${(RISK_PCT*100).toFixed(1)}% | 25x | 90 dana`);
  console.log('='.repeat(78));

  console.log('\n⏳ Fetcham podatke...\n');

  const cache = {};
  for (const sym of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      process.stdout.write(`  ${sym.padEnd(12)} ${tf.padEnd(4)} ... `);
      const c = await fetchCandles(sym, tf);
      cache[`${sym}_${tf}`] = c;
      if (c) {
        const from = new Date(c[0].t).toISOString().slice(0,10);
        const to   = new Date(c[c.length-1].t).toISOString().slice(0,10);
        console.log(`${c.length} svjeća (${from} → ${to})`);
      } else {
        console.log('FAILED');
      }
      await sleep(DELAY_MS);
    }
  }

  const tfTotals = {};

  for (const tf of TIMEFRAMES) {
    console.log('');
    console.log('-'.repeat(78));
    console.log(`  TIMEFRAME: ${tf}`);
    console.log('-'.repeat(78));
    console.log(`  ${'Symbol'.padEnd(14)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'PF'.padEnd(7)} ${'PnL $'.padEnd(12)} MaxDD%`);
    console.log('  ' + '-'.repeat(58));

    let totT = 0, totW = 0, totPnl = 0;
    const rows = [];

    for (const sym of SYMBOLS) {
      const candles = cache[`${sym}_${tf}`];
      if (!candles) { rows.push({ sym, trades:0, wr:0, pf:0, pnl:0, maxDD:0 }); continue; }
      const r = runBacktest(candles);
      if (!r)      { rows.push({ sym, trades:0, wr:0, pf:0, pnl:0, maxDD:0 }); continue; }
      rows.push({ sym, ...r });
      totT += r.trades; totW += r.wins; totPnl += r.pnl;
    }

    rows.sort((a, b) => b.pf - a.pf);

    for (const r of rows) {
      if (r.trades === 0) { console.log(`  ${r.sym.padEnd(14)} 0 tradova`); continue; }
      const m = r.pf >= 2.0 ? ' *** ' : r.pf >= 1.5 ? ' **  ' : r.pf >= 1.0 ? ' *   ' : ' ❌  ';
      console.log(
        `  ${r.sym.padEnd(14)} ${String(r.trades).padEnd(8)}` +
        `${r.wr.toFixed(0).padStart(4)}%   ` +
        `${r.pf.toFixed(2).padEnd(7)}` +
        `$${r.pnl.toFixed(0).padStart(8)}    ` +
        `${r.maxDD.toFixed(1)}%${m}`
      );
    }

    const avgWR = totT > 0 ? (totW / totT * 100).toFixed(0) : 0;
    console.log('  ' + '-'.repeat(58));
    console.log(`  ${'UKUPNO'.padEnd(14)} ${String(totT).padEnd(8)}${String(avgWR+'%').padEnd(14)}$${totPnl.toFixed(0)}`);
    tfTotals[tf] = { trades: totT, pnl: totPnl, wr: avgWR };
  }

  // Finalni pobjednik
  console.log('');
  console.log('='.repeat(78));
  console.log('  SYNAPSE-7 — PREPORUKA TF-a');
  console.log('='.repeat(78));
  console.log(`  ${'TF'.padEnd(8)} ${'Tradova'.padEnd(10)} ${'WR%'.padEnd(10)} PnL $`);
  console.log('  ' + '-'.repeat(42));
  const sorted = Object.entries(tfTotals).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [tf, t] of sorted) {
    const medal = tf === sorted[0][0] ? ' 🏆' : '';
    console.log(`  ${tf.padEnd(8)} ${String(t.trades).padEnd(10)} ${String(t.wr+'%').padEnd(10)} $${t.pnl.toFixed(0)}${medal}`);
  }
  const bestTF = sorted[0][0];
  console.log('');
  console.log(`  ✅ Preporuka: koristiti ${bestTF} za SYNAPSE-7 Portfolio 4`);
  console.log('='.repeat(78));
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
