/**
 * SL/TP Comparison Backtest — 4 scenarija
 * Scenarij A: ATR×1.5 / ATR×3.0 (trenutno)
 * Scenarij B: ATR×0.75 / ATR×1.5 (upola manji)
 * Scenarij C: Fixed 2% SL / 4% TP
 * Scenarij D: ATR×1.0 / ATR×1.5 (brzi profit, R:R 1:1.5)
 *
 * MEGA strategija | Rizik 2% | Leverage 15x | 90 dana podataka
 */

const CAPITAL  = 1000;
const RISK_PCT = 0.020;
const LEVERAGE = 15;
const MIN_BARS = 210;
const DELAY_MS = 200;

const SCENARIOS = [
  { name: 'Trenutno  (ATR×1.5 / ATR×3.0)', slType: 'atr', slM: 1.5, tpM: 3.0 },
  { name: 'Opcija A  (ATR×0.75 / ATR×1.5)', slType: 'atr', slM: 0.75, tpM: 1.5 },
  { name: 'Opcija B  (Fiksni 2% / 4%)',      slType: 'pct', slM: 2.0,  tpM: 4.0 },
  { name: 'Opcija C  (ATR×1.0 / ATR×1.5)',  slType: 'atr', slM: 1.0,  tpM: 1.5 },
];

const SYMBOLS_TF = [
  { symbol: 'SOLUSDT',  tf: '1H'  },
  { symbol: 'XAGUSDT',  tf: '30m' },
  { symbol: 'HYPEUSDT', tf: '5m'  },
  { symbol: 'LINKUSDT', tf: '5m'  },
  { symbol: 'PEPEUSDT', tf: '5m'  },
  { symbol: 'ZECUSDT',  tf: '30m' },
  { symbol: 'BTCUSDT',  tf: '1H'  },
];

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(closes, p) {
  const k = 2 / (p + 1), r = new Array(closes.length).fill(null);
  if (closes.length < p) return r;
  let v = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
  r[p - 1] = v;
  for (let i = p; i < closes.length; i++) { v = closes[i] * k + v * (1 - k); r[i] = v; }
  return r;
}

function rma(vals, p) {
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
  const ag = rma(g, p), al = rma(l, p);
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
  return rma(trs, p);
}

function adxSeries(candles, p = 14) {
  const n = candles.length, r = new Array(n).fill(null);
  const trs = [candles[0].h - candles[0].l], pDMs = [0], mDMs = [0];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(candles[i].h-candles[i].l,
      Math.abs(candles[i].h-candles[i-1].c), Math.abs(candles[i].l-candles[i-1].c)));
    const up = candles[i].h - candles[i-1].h, dn = candles[i-1].l - candles[i].l;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  const atr = rma(trs, p), pDI = rma(pDMs, p), mDI = rma(mDMs, p);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!atr[i] || atr[i] === 0) continue;
    const pp = (pDI[i]/atr[i])*100, mm = (mDI[i]/atr[i])*100, s = pp + mm;
    dx[i] = s === 0 ? 0 : Math.abs(pp - mm) / s * 100;
  }
  const adx = rma(dx.map(v => v ?? 0), p);
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

// ─── API fetch (90 dana) ──────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function neededCandles(tf) {
  const ms = {'1D':86400000,'4H':14400000,'1H':3600000,'30m':1800000,'15m':900000,'5m':300000}[tf]||3600000;
  return Math.ceil(90 * 86400000 / ms) + 250;
}

async function fetchCandles(symbol, tf) {
  const BASE   = 'https://api.bitget.com/api/v2/mix/market';
  const needed = neededCandles(tf);
  const pages  = Math.ceil(needed / 1000);
  let all = [], endTime = null;

  for (let p = 0; p < pages; p++) {
    const url = `${BASE}/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${tf}&limit=1000` +
                (endTime ? `&endTime=${endTime}` : '');
    try {
      const res = await fetch(url);
      const d   = await res.json();
      if (!d.data || !Array.isArray(d.data) || d.data.length === 0) break;
      // API vraća ASC (najstariji first) — d.data[0] je najstariji
      all     = [...d.data, ...all];          // prepend older data
      endTime = parseInt(d.data[0][0]) - 1;  // najstariji candle u batchu
      await sleep(DELAY_MS);
      if (d.data.length < 1000) break;
    } catch { break; }
  }

  if (all.length === 0) return null;

  // Parse, sort i dedupliciraj po timestamp-u
  const parsed = all.map(c => ({
    t: parseInt(c[0]), o: parseFloat(c[1]),
    h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4])
  })).sort((a, b) => a.t - b.t);

  // Ukloni duplikate
  const deduped = parsed.filter((c, i) => i === 0 || c.t !== parsed[i-1].t);
  return deduped;
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles, scenario) {
  const n      = candles.length;
  if (n < MIN_BARS) return null;
  const closes = candles.map(c => c.c);
  const e9     = ema(closes, 9),   e9s  = e9;
  const e21    = ema(closes, 21);
  const e55    = ema(closes, 55);
  const e200   = ema(closes, 200);
  const rs     = rsiSeries(closes, 14);
  const ad     = adxSeries(candles, 14);
  const ch     = chopSeries(candles, 14);
  const at     = atrSeries(candles, 14);

  let equity = CAPITAL, peak = CAPITAL, maxDD = 0;
  let inTrade = false, dir, entryP, sl, tp, posSize;
  const trades = [];
  const durations = []; // trajanje trada u barovima

  for (let i = 200; i < n; i++) {
    const bar = candles[i];

    if (inTrade) {
      let exitP = null, win = false;
      if (dir === 'long') {
        if (bar.l <= sl)    { exitP = sl; win = false; }
        else if (bar.h >= tp) { exitP = tp; win = true;  }
      } else {
        if (bar.h >= sl)    { exitP = sl; win = false; }
        else if (bar.l <= tp) { exitP = tp; win = true;  }
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

    if (!inTrade) {
      const [v9, v9p, v21, v21p, v55, v200, r, a, c, av] =
        [e9[i], e9[i-1], e21[i], e21[i-1], e55[i], e200[i], rs[i], ad[i], ch[i], at[i]];
      if (!v9||!v21||!v55||!v200||!v9p||!v21p||!r||!a||!c||!av) continue;

      const close     = bar.c;
      const crossUp   = v9p < v21p && v9 > v21;
      const crossDown = v9p > v21p && v9 < v21;

      let slDist, tpDist;
      if (scenario.slType === 'atr') {
        slDist = av * scenario.slM;
        tpDist = av * scenario.tpM;
      } else {
        // Fiksni %
        slDist = close * (scenario.slM / 100);
        tpDist = close * (scenario.tpM / 100);
      }

      const margin = equity * RISK_PCT;

      if (crossUp && close > v55 && close > v200 && r > 30 && r < 60 && a > 18 && c < 61.8) {
        posSize = (margin * LEVERAGE) / close;
        inTrade = true; dir = 'long'; entryP = close;
        sl = close - slDist; tp = close + tpDist;
      } else if (crossDown && close < v55 && close < v200 && r > 40 && r < 70 && a > 18 && c < 61.8) {
        posSize = (margin * LEVERAGE) / close;
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
  console.log('='.repeat(72));
  console.log('  SL/TP USPOREDBA — 4 scenarija | MEGA strategija | 90 dana');
  console.log(`  Rizik: 2.0% | Leverage: ${LEVERAGE}x | Kapital: $${CAPITAL}`);
  console.log('='.repeat(72));

  // Fetch candles jednom za sve
  console.log('\nFetching podataka (90 dana)...');
  const cache = {};
  for (const { symbol, tf } of SYMBOLS_TF) {
    process.stdout.write(`  ${symbol} ${tf} ... `);
    await sleep(DELAY_MS);
    const c = await fetchCandles(symbol, tf);
    cache[`${symbol}_${tf}`] = c;
    if (c) {
      const from = new Date(c[0].t).toISOString().slice(0,10);
      const to   = new Date(c[c.length-1].t).toISOString().slice(0,10);
      console.log(`${c.length} svjeća (${from} → ${to})`);
    } else console.log('FAILED');
  }

  // Radi backtest za svaki scenarij
  for (const sc of SCENARIOS) {
    const rr = (sc.tpM / sc.slM).toFixed(1);
    const slDesc = sc.slType === 'atr' ? `ATR×${sc.slM}` : `${sc.slM}%`;
    const tpDesc = sc.slType === 'atr' ? `ATR×${sc.tpM}` : `${sc.tpM}%`;

    console.log('');
    console.log('-'.repeat(72));
    console.log(`  ${sc.name}`);
    console.log(`  SL = ${slDesc} | TP = ${tpDesc} | R:R = 1:${rr}`);
    console.log('-'.repeat(72));
    console.log(`  ${'Symbol'.padEnd(12)} ${'TF'.padEnd(6)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'PF'.padEnd(7)} ${'PnL $'.padEnd(12)} MaxDD%`);
    console.log('  ' + '-'.repeat(64));

    let totTrades = 0, totWins = 0, totPnl = 0;

    for (const { symbol, tf } of SYMBOLS_TF) {
      const candles = cache[`${symbol}_${tf}`];
      if (!candles) { console.log(`  ${symbol.padEnd(12)} ${tf.padEnd(6)} NO DATA`); continue; }

      const r = runBacktest(candles, sc);
      if (!r) { console.log(`  ${symbol.padEnd(12)} ${tf.padEnd(6)} FAILED`); continue; }

      totTrades += r.trades; totWins += r.wins; totPnl += r.pnl;

      const marker = r.pf >= 2.0 ? ' ***' : r.pf >= 1.5 ? ' **' : r.pf >= 1.0 ? ' *' : ' ❌';
      console.log(
        `  ${symbol.padEnd(12)} ${tf.padEnd(6)} ${String(r.trades).padEnd(8)}` +
        `${r.wr.toFixed(0).padEnd(8)} ${r.pf.toFixed(2).padEnd(7)}` +
        `${('$'+r.pnl.toFixed(0)).padEnd(12)} ${r.maxDD.toFixed(1)}%${marker}`
      );
    }

    const avgWR = totTrades > 0 ? (totWins/totTrades*100).toFixed(0) : 0;
    console.log('  ' + '-'.repeat(64));
    console.log(`  ${'UKUPNO'.padEnd(20)} ${String(totTrades).padEnd(8)}${String(avgWR+'%').padEnd(16)}$${totPnl.toFixed(0)}`);
  }

  // Sažetak usporedbe
  console.log('');
  console.log('='.repeat(72));
  console.log('  SAŽETAK USPOREDBE');
  console.log('='.repeat(72));
  console.log(`  ${'Scenarij'.padEnd(38)} ${'SL%'.padEnd(8)} ${'TP%'.padEnd(8)} R:R`);
  console.log('  ' + '-'.repeat(58));
  for (const sc of SCENARIOS) {
    const rr  = (sc.tpM / sc.slM).toFixed(1);
    const slP = sc.slType === 'pct' ? `${sc.slM}%` : `~${(sc.slM*4.4).toFixed(1)}%`;
    const tpP = sc.slType === 'pct' ? `${sc.tpM}%` : `~${(sc.tpM*4.4).toFixed(1)}%`;
    console.log(`  ${sc.name.padEnd(38)} ${slP.padEnd(8)} ${tpP.padEnd(8)} 1:${rr}`);
  }
  console.log('');
  console.log('  (ATR% procjena bazirana na ZEC 30m ~4.4% ATR)');
  console.log('='.repeat(72));
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
