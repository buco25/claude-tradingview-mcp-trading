/**
 * Backtest — zadnjih ~30 dana, svi simboli, sve strategije
 * Fixed dollar model: SL=$15, TP=$45 (1:3 R:R), margin=$15, notional=$105 (7x)
 */
import "dotenv/config";

const MARGIN   = 15;
const LEVERAGE = 15;
const NOTIONAL = MARGIN * LEVERAGE; // $225
const RR       = 2.5;

const SYMBOLS = {
  mega: {
    syms: ["SOLUSDT","XAGUSDT","HYPEUSDT","LINKUSDT","PEPEUSDT","ZECUSDT"],
    tfs:  { SOLUSDT:"1H", XAGUSDT:"30m", HYPEUSDT:"5m", LINKUSDT:"5m", PEPEUSDT:"5m", ZECUSDT:"30m" }
  },
  "3layer": {
    syms: ["ETHUSDT","SUIUSDT","AAVEUSDT","ORDIUSDT","TAOUSDT","WLDUSDT","TRUMPUSDT"],
    tfs:  { ORDIUSDT:"30m", TAOUSDT:"30m" }, defaultTF:"1H"
  },
  ema_rsi: {
    syms: ["XAUUSDT","DOGEUSDT","NEARUSDT","AVAXUSDT","RIVERUSDT","ADAUSDT"], defaultTF:"1H"
  },
  ob: {
    syms: ["BTCUSDT","XRPUSDT"], defaultTF:"1H"
  },
};

async function fetchCandles(symbol, tf) {
  const limit = tf==="5m" ? 1000 : tf==="30m" ? 1000 : 1000;
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${tf}&limit=${limit}`;
  const d   = await fetch(url).then(r=>r.json());
  if (d.code !== "00000") return [];
  return d.data.map(k=>({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4] }));
}

function calcEma(arr, p) {
  if (arr.length < p) return null;
  const m = 2/(p+1);
  let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p; i<arr.length; i++) e = arr[i]*m + e*(1-m);
  return e;
}

function calcEmaArr(arr, p) {
  const m = 2/(p+1);
  let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  const out = new Array(p-1).fill(null);
  out.push(e);
  for (let i=p; i<arr.length; i++) { e = arr[i]*m + e*(1-m); out.push(e); }
  return out;
}

function calcRsi(arr, p=14) {
  if (arr.length < p+1) return null;
  let g=0, l=0;
  for (let i=arr.length-p; i<arr.length; i++) {
    const d = arr[i]-arr[i-1];
    if (d>0) g+=d; else l-=d;
  }
  return l===0 ? 100 : 100-100/(1+(g/p)/(l/p));
}

function calcAdx(candles, p=14) {
  if (candles.length < p*3) return null;
  const trs=[],pd=[],md=[];
  for (let i=1; i<candles.length; i++) {
    const h=candles[i].high, l=candles[i].low, ph=candles[i-1].high, pl=candles[i-1].low, pc=candles[i-1].close;
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const u=h-ph, dn=pl-l;
    pd.push(u>dn&&u>0?u:0); md.push(dn>u&&dn>0?dn:0);
  }
  let st=trs.slice(0,p).reduce((a,b)=>a+b,0), sp=pd.slice(0,p).reduce((a,b)=>a+b,0), sm=md.slice(0,p).reduce((a,b)=>a+b,0);
  const dx=[];
  for (let i=p; i<trs.length; i++) {
    st=st-st/p+trs[i]; sp=sp-sp/p+pd[i]; sm=sm-sm/p+md[i];
    const pdi=st>0?100*sp/st:0, mdi=st>0?100*sm/st:0, s=pdi+mdi;
    dx.push(s>0?100*Math.abs(pdi-mdi)/s:0);
  }
  let a=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p; i<dx.length; i++) a=(a*(p-1)+dx[i])/p;
  return a;
}

function calcChop(candles, p=14) {
  const sl=candles.slice(-(p+1)); let s=0;
  for (let i=1; i<sl.length; i++) {
    const h=sl[i].high, l=sl[i].low, pc=sl[i-1].close;
    s+=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
  }
  const hh=Math.max(...sl.slice(1).map(c=>c.high)), ll=Math.min(...sl.slice(1).map(c=>c.low));
  return (hh-ll)===0 ? null : 100*Math.log10(s/(hh-ll))/Math.log10(p);
}

function calcMacdHist(closes, f=12, s=26, sig=9) {
  const fe=calcEmaArr(closes,f), se=calcEmaArr(closes,s);
  const diff=fe.map((v,i)=>v!=null&&se[i]!=null?v-se[i]:null).filter(v=>v!=null);
  if (diff.length < sig) return null;
  const sigLine=calcEmaArr(diff,sig);
  const lastSig=sigLine[sigLine.length-1];
  const lastDiff=diff[diff.length-1];
  return lastSig!=null ? lastDiff-lastSig : null;
}

function simulateTrade(candles, entryIdx, signal, price) {
  const qty    = NOTIONAL / price;
  const slDist = MARGIN / qty;
  const tpDist = slDist * RR;
  const sl = signal==="LONG" ? price-slDist : price+slDist;
  const tp = signal==="LONG" ? price+tpDist : price-tpDist;

  for (let i=entryIdx+1; i<candles.length; i++) {
    const { high, low } = candles[i];
    if (signal==="LONG") {
      if (low  <= sl) return { pnl:-MARGIN, exit:"SL", bars:i-entryIdx };
      if (high >= tp) return { pnl:+MARGIN*RR, exit:"TP", bars:i-entryIdx };
    } else {
      if (high >= sl) return { pnl:-MARGIN, exit:"SL", bars:i-entryIdx };
      if (low  <= tp) return { pnl:+MARGIN*RR, exit:"TP", bars:i-entryIdx };
    }
  }
  const last = candles[candles.length-1].close;
  const pnl  = signal==="LONG" ? (last-price)*qty : (price-last)*qty;
  return { pnl:Math.max(-MARGIN, Math.min(MARGIN*RR, pnl)), exit:"OPEN", bars:candles.length-entryIdx };
}

async function backtestMega(symbol, tf) {
  const candles = await fetchCandles(symbol, tf);
  if (candles.length < 220) return [];
  const trades=[], WARMUP=210;
  let skip=0;
  for (let i=WARMUP; i<candles.length-1; i++) {
    if (skip>0) { skip--; continue; }
    const sl=candles.slice(0,i+1), closes=sl.map(c=>c.close), price=closes.at(-1);
    const e9=calcEma(closes,9), e21=calcEma(closes,21), e55=calcEma(closes,55), e200=calcEma(closes,200);
    const p9=calcEma(closes.slice(0,-1),9), p21=calcEma(closes.slice(0,-1),21);
    const p29=calcEma(closes.slice(0,-2),9), p221=calcEma(closes.slice(0,-2),21);
    if (!e9||!e21||!e55||!e200||!p9||!p21||!p29||!p221) continue;
    const crossUp  =(p29<=p221&&p9>p21)||(p9<=p21&&e9>e21);
    const crossDown=(p29>=p221&&p9<p21)||(p9>=p21&&e9<e21);
    const tUp=price>e55&&price>e200, tDn=price<e55&&price<e200;
    const r=calcRsi(closes), a=calcAdx(sl), ch=calcChop(sl);
    if (r===null) continue;
    const adxOK=a===null||a>18, chopOK=ch===null||ch<61.8;
    let signal=null;
    if (crossUp  &&tUp&&r>30&&r<60&&adxOK&&chopOK) signal="LONG";
    if (crossDown&&tDn&&r>40&&r<70&&adxOK&&chopOK) signal="SHORT";
    if (!signal) continue;
    const t=simulateTrade(candles,i,signal,price);
    trades.push({ symbol,tf,signal,price,...t, date:new Date(candles[i].time).toISOString().slice(0,10) });
    skip=t.bars;
  }
  return trades;
}

async function backtest3Layer(symbol, tf) {
  const candles = await fetchCandles(symbol, tf);
  if (candles.length < 160) return [];
  const trades=[]; let skip=0;
  for (let i=150; i<candles.length-1; i++) {
    if (skip>0) { skip--; continue; }
    const sl=candles.slice(0,i+1), closes=sl.map(c=>c.close), price=closes.at(-1);
    const e9=calcEma(closes,9), e21=calcEma(closes,21), e145=calcEma(closes,145);
    const p9=calcEma(closes.slice(0,-1),9), p21=calcEma(closes.slice(0,-1),21);
    const p29=calcEma(closes.slice(0,-2),9), p221=calcEma(closes.slice(0,-2),21);
    if (!e9||!e21||!e145||!p9||!p21||!p29||!p221) continue;
    const hist=calcMacdHist(closes);
    if (hist===null) continue;
    const crossUp  =(p29<=p221&&p9>p21)||(p9<=p21&&e9>e21);
    const crossDown=(p29>=p221&&p9<p21)||(p9>=p21&&e9<e21);
    let signal=null;
    if (crossUp  &&price>e145&&hist>0) signal="LONG";
    if (crossDown&&price<e145&&hist<0) signal="SHORT";
    if (!signal) continue;
    const t=simulateTrade(candles,i,signal,price);
    trades.push({ symbol,tf,signal,price,...t, date:new Date(candles[i].time).toISOString().slice(0,10) });
    skip=t.bars;
  }
  return trades;
}

async function backtestEmaRsi(symbol, tf) {
  const candles = await fetchCandles(symbol, tf);
  if (candles.length < 60) return [];
  const trades=[]; let skip=0;
  for (let i=55; i<candles.length-1; i++) {
    if (skip>0) { skip--; continue; }
    const sl=candles.slice(0,i+1), closes=sl.map(c=>c.close), price=closes.at(-1);
    const e9=calcEma(closes,9), e21=calcEma(closes,21), e50=calcEma(closes,50);
    const p9=calcEma(closes.slice(0,-1),9), p21=calcEma(closes.slice(0,-1),21);
    const p29=calcEma(closes.slice(0,-2),9), p221=calcEma(closes.slice(0,-2),21);
    if (!e9||!e21||!e50||!p9||!p21||!p29||!p221) continue;
    const r=calcRsi(closes); if (r===null) continue;
    const crossUp  =(p29<=p221&&p9>p21)||(p9<=p21&&e9>e21);
    const crossDown=(p29>=p221&&p9<p21)||(p9>=p21&&e9<e21);
    let signal=null;
    if (crossUp  &&e9>e50&&r>35&&r<58) signal="LONG";
    if (crossDown&&e9<e50&&r>42&&r<65) signal="SHORT";
    if (!signal) continue;
    const t=simulateTrade(candles,i,signal,price);
    trades.push({ symbol,tf,signal,price,...t, date:new Date(candles[i].time).toISOString().slice(0,10) });
    skip=t.bars;
  }
  return trades;
}

// ─── Run ─────────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(72)}`);
console.log(`  BACKTEST — zadnjih ~30 dana | SL $${MARGIN} / TP $${MARGIN*RR} | 1:${RR} R:R | ${LEVERAGE}x | Notional $${NOTIONAL}`);
console.log(`${"═".repeat(72)}\n`);

const allTrades = [];

for (const [strat, cfg] of Object.entries(SYMBOLS)) {
  console.log(`\n── ${strat.toUpperCase()} ${"─".repeat(60)}`);
  for (const sym of cfg.syms) {
    const tf = cfg.tfs?.[sym] || cfg.defaultTF || "1H";
    process.stdout.write(`  ${sym.padEnd(12)} ${tf.padEnd(5)} `);
    try {
      let trades = [];
      if      (strat==="mega")    trades=await backtestMega(sym,tf);
      else if (strat==="3layer")  trades=await backtest3Layer(sym,tf);
      else if (strat==="ema_rsi") trades=await backtestEmaRsi(sym,tf);

      const wins   = trades.filter(t=>t.pnl>0).length;
      const losses = trades.filter(t=>t.pnl<=0).length;
      const total  = trades.reduce((s,t)=>s+t.pnl,0);
      const wr     = trades.length>0?(wins/trades.length*100).toFixed(0):"0";
      const pf     = losses>0?((wins*MARGIN*RR)/(losses*MARGIN)).toFixed(2):"∞";
      const icon   = total>0?"✅":"❌";
      console.log(`${icon}  ${String(trades.length).padStart(3)} trades | WR ${String(wr).padStart(3)}% | PF ${String(pf).padStart(5)} | P&L ${total>=0?"+":""}$${total.toFixed(2)}`);
      allTrades.push(...trades);
    } catch(e) {
      console.log(`❌  greška: ${e.message}`);
    }
    await new Promise(r=>setTimeout(r,300));
  }
}

const wins  = allTrades.filter(t=>t.pnl>0).length;
const losses= allTrades.filter(t=>t.pnl<=0).length;
const open  = allTrades.filter(t=>t.exit==="OPEN").length;
const total = allTrades.reduce((s,t)=>s+t.pnl,0);
const wr    = allTrades.length>0?(wins/allTrades.length*100).toFixed(1):"0";
const pf    = losses>0?((wins*MARGIN*RR)/(losses*MARGIN)).toFixed(2):"∞";

console.log(`\n${"═".repeat(72)}`);
console.log(`  UKUPNO:        ${allTrades.length} trades | ${wins} ✅ win / ${losses} ❌ loss / ${open} ⏳ open`);
console.log(`  Win Rate:      ${wr}%  (break-even = 25%)`);
console.log(`  Profit Factor: ${pf}  (treba >1.0)`);
console.log(`  Ukupni P&L:    ${total>=0?"+":""}$${total.toFixed(2)}`);
console.log(`  Avg po tradeu: $${allTrades.length>0?(total/allTrades.length).toFixed(2):"0"}`);
console.log(`${"═".repeat(72)}\n`);
