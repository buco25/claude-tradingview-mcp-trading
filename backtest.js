// ─── ULTRA Bot — Paper Mode Backtest v2 ──────────────────────────────────────
// Ista logika kao bot.js: 8 signala, trend-following E50/CVD, bez MM filtera
// Pokretanje: node backtest.js [--symbol BTCUSDT] [--bars 500] [--minsig 6] [--tf 15m]
'use strict';

// ─── Konfiguracija (= bot.js) ─────────────────────────────────────────────────
const ALL_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT","LINKUSDT","ADAUSDT",
  "SUIUSDT","TAOUSDT","HYPEUSDT","SEIUSDT","PEPEUSDT","JUPUSDT","FETUSDT","AAVEUSDT","WLDUSDT",
];
const SYMBOL_SLTP = {
  "BTCUSDT":  { slPct:1.5, tpPct:2.25 }, "ETHUSDT":  { slPct:2.0, tpPct:3.0  },
  "SOLUSDT":  { slPct:2.0, tpPct:3.0  }, "XRPUSDT":  { slPct:2.0, tpPct:3.0  },
  "BNBUSDT":  { slPct:1.5, tpPct:2.25 }, "LINKUSDT": { slPct:2.0, tpPct:3.0  },
  "ADAUSDT":  { slPct:2.0, tpPct:3.0  }, "SUIUSDT":  { slPct:2.5, tpPct:3.75 },
  "TAOUSDT":  { slPct:2.5, tpPct:3.75 }, "HYPEUSDT": { slPct:2.5, tpPct:3.75 },
  "SEIUSDT":  { slPct:2.5, tpPct:3.75 }, "PEPEUSDT": { slPct:2.0, tpPct:3.0  },
  "JUPUSDT":  { slPct:3.0, tpPct:4.5  }, "FETUSDT":  { slPct:2.5, tpPct:3.75 },
  "AAVEUSDT": { slPct:2.5, tpPct:3.75 }, "WLDUSDT":  { slPct:3.0, tpPct:4.5  },
};
const VOL_EXH_TIERS = {
  "BTCUSDT":5.0, "ETHUSDT":4.0, "SOLUSDT":4.0, "XRPUSDT":4.0,
  "ADAUSDT":3.5, "LINKUSDT":3.5, "DOGEUSDT":3.5,
  "NEARUSDT":3.0, "SUIUSDT":3.0, "APTUSDT":3.0, "SEIUSDT":3.0, "INJUSDT":3.0,
  "TAOUSDT":2.5, "HYPEUSDT":2.5, "JUPUSDT":2.5, "ENAUSDT":2.5,
};
const VOL_EXH_DEFAULT = 3.0;
const ADX_MIN       = 22;
const RISK_PCT      = 1.5;
const START_CAPITAL = 1000;

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : d; };
const TARGET  = getArg('--symbol', null);
const BARS    = parseInt(getArg('--bars', '500'));
const MIN_SIG = parseInt(getArg('--minsig', '6'));
const TF      = getArg('--tf', '15m');
const SYMBOLS = TARGET ? [TARGET] : ALL_SYMBOLS;

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function fetchCandles(symbol, limit = Math.min(BARS, 1000)) {
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${TF}&limit=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(json.msg);
  return json.data
    .map(k => ({ time:parseInt(k[0]), open:parseFloat(k[1]), high:parseFloat(k[2]), low:parseFloat(k[3]), close:parseFloat(k[4]), volume:parseFloat(k[5]) }))
    .sort((a,b) => a.time - b.time);
}

// ─── Indikatori ───────────────────────────────────────────────────────────────
function calcEMA(closes, p) {
  if (closes.length < p) return null;
  const k = 2/(p+1); let v = closes.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i = p; i < closes.length; i++) v = closes[i]*k + v*(1-k);
  return v;
}

function rsiSeries(closes, p = 14) {
  const r = new Array(closes.length).fill(null);
  if (closes.length <= p) return r;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i]-closes[i-1]; if (d>0) ag+=d; else al-=d; }
  ag /= p; al /= p;
  r[p] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  for (let i = p+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1]; const g = d>0?d:0; const l = d<0?-d:0;
    ag = (ag*(p-1)+g)/p; al = (al*(p-1)+l)/p;
    r[i] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  }
  return r;
}

function calcADX(candles, p = 14) {
  const n = candles.length; const trs=[], pdms=[], mdms=[];
  for (let i = 1; i < n; i++) {
    const h=candles[i].high, l=candles[i].low, pc=candles[i-1].close;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    const up=h-candles[i-1].high, dn=candles[i-1].low-l;
    pdms.push(up>dn&&up>0?up:0); mdms.push(dn>up&&dn>0?dn:0);
  }
  let atr=trs.slice(0,p).reduce((a,b)=>a+b,0), sp=pdms.slice(0,p).reduce((a,b)=>a+b,0), sm=mdms.slice(0,p).reduce((a,b)=>a+b,0);
  const dx=[];
  for (let i=p; i<trs.length; i++) {
    atr=atr-atr/p+trs[i]; sp=sp-sp/p+pdms[i]; sm=sm-sm/p+mdms[i];
    const pdi=atr>0?100*sp/atr:0, mdi=atr>0?100*sm/atr:0, s=pdi+mdi;
    dx.push(s>0?100*Math.abs(pdi-mdi)/s:0);
  }
  let adx=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p; i<dx.length; i++) adx=(adx*(p-1)+dx[i])/p;
  return adx;
}

function calcMACD(closes) {
  function emaSlice(arr, p) {
    if (arr.length < p) return null;
    const k=2/(p+1); let v=arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
    for (let i=p; i<arr.length; i++) v=arr[i]*k+v*(1-k); return v;
  }
  const diffs=[];
  for (let i=26; i<=closes.length; i++) {
    const f=emaSlice(closes.slice(0,i),12), s=emaSlice(closes.slice(0,i),26);
    if (f!==null&&s!==null) diffs.push(f-s);
  }
  if (diffs.length<9) return null;
  const hv=[]; const sk=2/10; let sv=diffs.slice(0,9).reduce((a,b)=>a+b,0)/9;
  for (let j=9; j<diffs.length; j++) { sv=diffs[j]*sk+sv*(1-sk); hv.push(diffs[j]-sv); }
  return hv.length > 0 ? hv[hv.length-1] : null;
}

function calcVWAP(candles) {
  let pv=0, v=0;
  for (const c of candles) { const tp=(c.high+c.low+c.close)/3; pv+=tp*c.volume; v+=c.volume; }
  return v>0?pv/v:null;
}

// ─── Analiza na baru i ────────────────────────────────────────────────────────
function analyze(candles, symbol) {
  const n = candles.length;
  if (n < 210) return null;
  const closes = candles.map(c=>c.close);
  const opens  = candles.map(c=>c.open);
  const vols   = candles.map(c=>c.volume);
  const price  = closes[n-1];

  // Indikatori
  const ema50  = calcEMA(closes, 50);
  const ema145 = calcEMA(closes, 145);
  if (!ema50 || !ema145) return null;
  const rsiArr = rsiSeries(closes, 14);
  const rsi    = rsiArr[n-1] ?? 50;
  const rsi1   = rsiArr[n-2] ?? rsi;
  const rsi2   = rsiArr[n-3] ?? rsi1;
  const rsiRising  = rsi > rsi1 && rsi1 > rsi2;
  const rsiFalling = rsi < rsi1 && rsi1 < rsi2;
  const adx    = calcADX(candles);
  const macdH  = calcMACD(closes);
  const vwap   = calcVWAP(candles.slice(-96));

  // CVD 20
  let cvdSum = 0;
  for (let i=n-20; i<n; i++) cvdSum += (closes[i]>opens[i]?1:closes[i]<opens[i]?-1:0)*vols[i];

  // Market Structure
  let sigMktStr = 0;
  { const W=3, msEnd=n-W-1, msStart=Math.max(W, n-60);
    const mH=[], mL=[];
    for (let i=msStart; i<=msEnd; i++) {
      let isH=true, isL=true;
      for (let j=i-W; j<=i+W; j++) { if(j===i)continue; if(candles[j].high>=candles[i].high)isH=false; if(candles[j].low<=candles[i].low)isL=false; }
      if(isH)mH.push(candles[i].high); if(isL)mL.push(candles[i].low);
    }
    if(mH.length>=2&&mL.length>=2) {
      if(mH[mH.length-1]>mH[mH.length-2]&&mL[mL.length-1]>mL[mL.length-2]) sigMktStr=1;
      if(mH[mH.length-1]<mH[mH.length-2]&&mL[mL.length-1]<mL[mL.length-2]) sigMktStr=-1;
    }
  }

  // RSI divergencija
  let sigRsiDiv = 0;
  { const DW=3, DRS=Math.max(DW,n-40), DRE=n-DW-1;
    const sH=[], sL=[];
    for (let i=DRS; i<=DRE; i++) {
      let isH=true, isL=true;
      for (let j=i-DW; j<=i+DW; j++) { if(j===i)continue; if(candles[j].high>=candles[i].high)isH=false; if(candles[j].low<=candles[i].low)isL=false; }
      if(isH&&rsiArr[i]!==null)sH.push({p:candles[i].high, r:rsiArr[i]});
      if(isL&&rsiArr[i]!==null)sL.push({p:candles[i].low,  r:rsiArr[i]});
    }
    if(sH.length>=2){const h1=sH[sH.length-2],h2=sH[sH.length-1]; if((h2.p-h1.p)/h1.p>0.005&&h1.r-h2.r>2)sigRsiDiv=-1;}
    if(sL.length>=2&&sigRsiDiv===0){const l1=sL[sL.length-2],l2=sL[sL.length-1]; if((l1.p-l2.p)/l1.p>0.005&&l2.r-l1.r>2)sigRsiDiv=1;}
  }

  // FVG
  let sigFVG = 0;
  for (let i=Math.max(2,n-30); i<n-1&&sigFVG===0; i++) {
    const c0h=candles[i-2].high, c0l=candles[i-2].low, c2h=candles[i].high, c2l=candles[i].low;
    if(c2l>c0h&&(c2l-c0h)/c0h>=0.003&&price>=c0h*0.999&&price<=c2l*1.005) sigFVG=1;
    if(c0l>c2h&&(c0l-c2h)/c2h>=0.003&&price<=c0l*1.001&&price>=c2h*0.995) sigFVG=-1;
  }

  // VOL_EXH gate
  const volAvg = vols.slice(-20).reduce((a,b)=>a+b,0)/20;
  const volR   = volAvg>0 ? vols[n-1]/volAvg : 1;
  if (volR >= (VOL_EXH_TIERS[symbol] ?? VOL_EXH_DEFAULT)) return null;

  // ADX gate
  if (adx < ADX_MIN) return null;

  // RSI gate
  const rsiLongOk  = rsi < 72;
  const rsiShortOk = rsi > 30;

  // 8 signala
  const sigs = [
    price > ema50  ? 1 : -1,                                     // E50  trend
    cvdSum > 0 ? 1 : -1,                                         // CVD  trend
    macdH !== null ? (macdH > 0 ? 1 : -1) : 0,                  // MACD
    price > ema145 ? 1 : -1,                                     // E145
    0,                                                            // PWHL (nema weekly feed u backtestu)
    sigRsiDiv,                                                    // RDIV
    sigMktStr,                                                    // MSTR
    sigFVG,                                                       // FVG
  ];
  const bullCnt = sigs.filter(s=>s===1).length;
  const bearCnt = sigs.filter(s=>s===-1).length;
  const premBull = (sigs[1]===1 && sigs[3]===1) ? 1 : 0;
  const premBear = (sigs[1]===-1 && sigs[3]===-1) ? 1 : 0;
  const bullScore = bullCnt + premBull;
  const bearScore = bearCnt + premBear;

  // VWAP gate
  if (!vwap) return null;
  const prevC=closes[n-2], prevO=opens[n-2], currC=closes[n-1], currO=opens[n-1];
  const prevG=prevC>prevO, prevR=prevC<prevO, currG=currC>currO, currR=currC<currO;
  const vwapCrossUp  = n>=3 && closes[n-3]<vwap && closes[n-2]>vwap && closes[n-1]>vwap;
  const vwapCrossDn  = n>=3 && closes[n-3]>vwap && closes[n-2]<vwap && closes[n-1]<vwap;
  const vwapRejL     = currC>vwap && prevR && prevC>vwap && currG;
  const vwapRejS     = currC<vwap && prevG && prevC<vwap && currR;
  const vwapLongOk   = vwapCrossUp || vwapRejL;
  const vwapShortOk  = vwapCrossDn || vwapRejS;

  if (bullScore >= MIN_SIG && rsiLongOk  && vwapLongOk)  return "LONG";
  if (bearScore >= MIN_SIG && rsiShortOk && vwapShortOk) return "SHORT";
  return null;
}

// ─── Simulacija trejdova po simbolu ───────────────────────────────────────────
function simulate(symbol, candles) {
  const { slPct, tpPct } = SYMBOL_SLTP[symbol] || { slPct:2.0, tpPct:3.0 };
  const trades = []; let inTrade = null;

  for (let i = 210; i < candles.length; i++) {
    // Provjeri exit na ovoj svjećici
    if (inTrade) {
      const c = candles[i]; let closed=false, pnlPct=0, reason='';
      if (inTrade.dir === "LONG") {
        if (c.low  <= inTrade.sl) { pnlPct=-slPct; closed=true; reason='SL'; }
        else if (c.high >= inTrade.tp) { pnlPct=tpPct;  closed=true; reason='TP'; }
      } else {
        if (c.high >= inTrade.sl) { pnlPct=-slPct; closed=true; reason='SL'; }
        else if (c.low  <= inTrade.tp) { pnlPct=tpPct;  closed=true; reason='TP'; }
      }
      if (closed) {
        const riskUSD = START_CAPITAL * RISK_PCT / 100;
        trades.push({ dir:inTrade.dir, pnlPct, pnlUSD: riskUSD*(pnlPct/slPct), win:pnlPct>0, reason });
        inTrade = null;
      } else continue;
    }

    const sig = analyze(candles.slice(0, i+1), symbol);
    if (!sig) continue;
    const entry = candles[i].close;
    inTrade = {
      dir: sig,
      sl: sig==="LONG" ? entry*(1-slPct/100) : entry*(1+slPct/100),
      tp: sig==="LONG" ? entry*(1+tpPct/100) : entry*(1-tpPct/100),
    };
  }
  return trades;
}

// ─── Ispis rezultata ──────────────────────────────────────────────────────────
const G="\x1b[32m", R="\x1b[31m", Y="\x1b[33m", C="\x1b[36m", RESET="\x1b[0m";

function printResults(bySymbol) {
  const sep = '─'.repeat(72);
  console.log(`\n${sep}`);
  console.log(`  ULTRA Backtest  |  TF:${TF}  |  minSig:${MIN_SIG}/8  |  bars:${BARS}  |  rizik:${RISK_PCT}%/trade`);
  console.log(sep);
  console.log(`  ${"SIMBOL".padEnd(12)} ${"TREJDOVA".padStart(9)} ${"WR%".padStart(6)} ${"P&L $".padStart(9)} ${"PF".padStart(6)}  LONG/SHORT`);
  console.log(sep);

  let tTrades=0, tWins=0, tPnL=0;
  for (const sym of Object.keys(bySymbol).sort()) {
    const ts = bySymbol[sym];
    if (!ts.length) { console.log(`  ${sym.padEnd(12)}  ${"—".padStart(9)}`); continue; }
    const wins = ts.filter(t=>t.win).length;
    const wr   = (wins/ts.length*100).toFixed(0);
    const pnl  = ts.reduce((s,t)=>s+t.pnlUSD, 0);
    const grossW = ts.filter(t=>t.win).reduce((s,t)=>s+t.pnlUSD,0);
    const grossL = Math.abs(ts.filter(t=>!t.win).reduce((s,t)=>s+t.pnlUSD,0));
    const pf   = grossL===0 ? '∞' : (grossW/grossL).toFixed(2);
    const longs  = ts.filter(t=>t.dir==="LONG").length;
    const shorts = ts.filter(t=>t.dir==="SHORT").length;
    const col = pnl>=0?G:R;
    const pnlStr = (pnl>=0?'+':'')+pnl.toFixed(2);
    console.log(`  ${sym.padEnd(12)} ${String(ts.length).padStart(9)} ${String(wr).padStart(5)}% ${col}${pnlStr.padStart(9)}${RESET} ${pf.padStart(6)}  L:${longs} S:${shorts}`);
    tTrades+=ts.length; tWins+=wins; tPnL+=pnl;
  }
  const tWR  = tTrades>0?(tWins/tTrades*100).toFixed(1):'0';
  const tCol = tPnL>=0?G:R;
  console.log(sep);
  console.log(`  ${"UKUPNO".padEnd(12)} ${String(tTrades).padStart(9)} ${String(tWR).padStart(5)}% ${tCol}${((tPnL>=0?'+':'')+tPnL.toFixed(2)).padStart(9)}${RESET}`);
  console.log(sep);

  // Breakdown LONG vs SHORT
  const allTrades = Object.values(bySymbol).flat();
  const lT = allTrades.filter(t=>t.dir==="LONG");
  const sT = allTrades.filter(t=>t.dir==="SHORT");
  const lWR = lT.length>0?(lT.filter(t=>t.win).length/lT.length*100).toFixed(1):'0';
  const sWR = sT.length>0?(sT.filter(t=>t.win).length/sT.length*100).toFixed(1):'0';
  const lPnL = lT.reduce((s,t)=>s+t.pnlUSD,0);
  const sPnL = sT.reduce((s,t)=>s+t.pnlUSD,0);
  console.log(`\n  LONG:  ${lT.length} trejdova  WR:${lWR}%  P&L:${lPnL>=0?'+':''}$${lPnL.toFixed(2)}`);
  console.log(`  SHORT: ${sT.length} trejdova  WR:${sWR}%  P&L:${sPnL>=0?'+':''}$${sPnL.toFixed(2)}`);
  console.log(`\n  Napomena: PWHL signal=0 (nema weekly feed) | TP/SL po tier iz rules.json\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nULTRA Backtest — ${SYMBOLS.length} simbola | ${TF} | minSig=${MIN_SIG}/8 | ${BARS} bara\nFetchujem candles...\n`);

  const bySymbol = {};
  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym.padEnd(12)}... `);
    try {
      const candles = await fetchCandles(sym);
      const trades  = simulate(sym, candles);
      bySymbol[sym] = trades;
      const wins = trades.filter(t=>t.win).length;
      const pnl  = trades.reduce((s,t)=>s+t.pnlUSD,0);
      const col  = pnl>=0?G:R;
      console.log(`${trades.length} trejdova  WR:${trades.length>0?(wins/trades.length*100).toFixed(0):0}%  P&L:${col}${pnl>=0?'+':''}$${pnl.toFixed(2)}${RESET}`);
    } catch(e) {
      console.log(`GREŠKA: ${e.message}`);
      bySymbol[sym] = [];
    }
    await new Promise(r=>setTimeout(r,200));
  }

  printResults(bySymbol);
}

main().catch(e=>{ console.error(e); process.exit(1); });
