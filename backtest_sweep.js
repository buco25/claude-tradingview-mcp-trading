// ─── SWEEP Bonus Backtest ──────────────────────────────────────────────────────
// Uspoređuje 3 moda za svaki simbol:
//   A) Trenutni: SWEEP blokira ulaz 6h
//   B) SWEEP ignoriran (ni bonus ni blok)
//   C) SWEEP + MSTR potvrda = +1 bonus signal (SMC pristup)
//
// Signal 9 (indeks 8): sigSWEEP
//   +1 = bullish sweep (vol≥2.5×avg, donji wick≥40% ranga, close>open) → LONG potvrda
//   -1 = bearish sweep (vol≥2.5×avg, gornji wick≥40% ranga, close<open) → SHORT potvrda
//    0 = nema sweep svjeće
//
// Pokretanje: node backtest_sweep.js [--bars 1000]
'use strict';

const ACTIVE_SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","TAOUSDT","AAVEUSDT"];
const SYMBOL_COMBOS = {
  "BTCUSDT":  { sigIdx:[0,1,2,3,7], minSig:4 },
  "ETHUSDT":  { sigIdx:[0,1,2,3,7], minSig:4 },
  "SOLUSDT":  { sigIdx:[0,1,3,5,6], minSig:4 },
  "TAOUSDT":  { sigIdx:[0,1,3,5,6], minSig:4 },
  "AAVEUSDT": { sigIdx:[0,1,2,3,7], minSig:4 },
};
const SYMBOL_SLTP = {
  "BTCUSDT":  {slPct:1.5,tpPct:2.25},
  "ETHUSDT":  {slPct:2.0,tpPct:3.0},
  "SOLUSDT":  {slPct:2.0,tpPct:3.0},
  "TAOUSDT":  {slPct:2.5,tpPct:3.75},
  "AAVEUSDT": {slPct:2.5,tpPct:3.75},
};
const VOL_EXH_TIERS = {
  "BTCUSDT":5.0,"ETHUSDT":4.0,"SOLUSDT":4.0,"TAOUSDT":2.5,"AAVEUSDT":3.0,
};
const ADX_MIN   = 22;
const RISK_PCT  = 1.5;
const START_CAP = 1000;
// SWEEP: vol threshold i wick threshold
const SWEEP_VOL_THR  = 2.5;  // × avg20
const SWEEP_WICK_PCT = 0.40; // wick ≥ 40% ranga

const args   = process.argv.slice(2);
const getArg = (f,d) => { const i=args.indexOf(f); return i>=0?args[i+1]:d; };
const BARS   = parseInt(getArg('--bars','1000'));

async function fetchCandles(symbol) {
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&limit=${Math.min(BARS,1000)}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(json.msg);
  return json.data.map(k=>({
    time:parseInt(k[0]),open:parseFloat(k[1]),high:parseFloat(k[2]),
    low:parseFloat(k[3]),close:parseFloat(k[4]),volume:parseFloat(k[5]),
  })).sort((a,b)=>a.time-b.time);
}

// ─── Indikatori ───────────────────────────────────────────────────────────────
function calcEMA(closes,p){
  if(closes.length<p)return null;
  const k=2/(p+1);let v=closes.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<closes.length;i++)v=closes[i]*k+v*(1-k);return v;
}
function rsiSeries(closes,p=14){
  const r=new Array(closes.length).fill(null);if(closes.length<=p)return r;
  let ag=0,al=0;
  for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al-=d;}
  ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];const g=d>0?d:0;const l=d<0?-d:0;
    ag=(ag*(p-1)+g)/p;al=(al*(p-1)+l)/p;r[i]=al===0?100:100-100/(1+ag/al);
  }
  return r;
}
function calcADX(candles,p=14){
  const n=candles.length,trs=[],pdms=[],mdms=[];
  for(let i=1;i<n;i++){
    const h=candles[i].high,l=candles[i].low,pc=candles[i-1].close;
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-candles[i-1].high,dn=candles[i-1].low-l;
    pdms.push(up>dn&&up>0?up:0);mdms.push(dn>up&&dn>0?dn:0);
  }
  let atr=trs.slice(0,p).reduce((a,b)=>a+b,0),sp=pdms.slice(0,p).reduce((a,b)=>a+b,0),sm=mdms.slice(0,p).reduce((a,b)=>a+b,0);
  const dx=[];
  for(let i=p;i<trs.length;i++){
    atr=atr-atr/p+trs[i];sp=sp-sp/p+pdms[i];sm=sm-sm/p+mdms[i];
    const pdi=atr>0?100*sp/atr:0,mdi=atr>0?100*sm/atr:0,s=pdi+mdi;
    dx.push(s>0?100*Math.abs(pdi-mdi)/s:0);
  }
  let adx=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<dx.length;i++)adx=(adx*(p-1)+dx[i])/p;return adx;
}
function calcMACD(closes){
  function es(arr,p){if(arr.length<p)return null;const k=2/(p+1);let v=arr.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<arr.length;i++)v=arr[i]*k+v*(1-k);return v;}
  const diffs=[];
  for(let i=26;i<=closes.length;i++){const f=es(closes.slice(0,i),12),s=es(closes.slice(0,i),26);if(f!==null&&s!==null)diffs.push(f-s);}
  if(diffs.length<9)return null;
  const sk=2/10;let sv=diffs.slice(0,9).reduce((a,b)=>a+b,0)/9;const hv=[];
  for(let j=9;j<diffs.length;j++){sv=diffs[j]*sk+sv*(1-sk);hv.push(diffs[j]-sv);}
  return hv.length>0?hv[hv.length-1]:null;
}
function calcVWAP(candles){
  let pv=0,v=0;for(const c of candles){const tp=(c.high+c.low+c.close)/3;pv+=tp*c.volume;v+=c.volume;}return v>0?pv/v:null;
}

// ─── Precompute ───────────────────────────────────────────────────────────────
function precompute(candles) {
  const out = [];
  for (let i = 210; i < candles.length; i++) {
    const sl = candles.slice(0,i+1), n = sl.length;
    const closes = sl.map(c=>c.close), opens = sl.map(c=>c.open), vols = sl.map(c=>c.volume);
    const price = closes[n-1];

    const ema50  = calcEMA(closes,50);
    const ema145 = calcEMA(closes,145);
    if(!ema50||!ema145){out.push(null);continue;}

    const rsiArr = rsiSeries(closes,14);
    const adx    = calcADX(sl);
    const macdH  = calcMACD(closes);
    const vwap   = calcVWAP(sl.slice(-96));

    let cvdSum=0;
    for(let j=n-20;j<n;j++)cvdSum+=(closes[j]>opens[j]?1:closes[j]<opens[j]?-1:0)*vols[j];

    // MSTR
    let sigMktStr=0;
    {const W=3,msEnd=n-W-1,msStart=Math.max(W,n-60);const mH=[],mL=[];
     for(let j=msStart;j<=msEnd;j++){let isH=true,isL=true;for(let k=j-W;k<=j+W;k++){if(k===j)continue;if(sl[k].high>=sl[j].high)isH=false;if(sl[k].low<=sl[j].low)isL=false;}if(isH)mH.push(sl[j].high);if(isL)mL.push(sl[j].low);}
     if(mH.length>=2&&mL.length>=2){if(mH[mH.length-1]>mH[mH.length-2]&&mL[mL.length-1]>mL[mL.length-2])sigMktStr=1;if(mH[mH.length-1]<mH[mH.length-2]&&mL[mL.length-1]<mL[mL.length-2])sigMktStr=-1;}}

    // RDIV
    let sigRsiDiv=0;
    {const DW=3,DRS=Math.max(DW,n-40),DRE=n-DW-1;const sH=[],sL=[];
     for(let j=DRS;j<=DRE;j++){let isH=true,isL=true;for(let k=j-DW;k<=j+DW;k++){if(k===j)continue;if(sl[k].high>=sl[j].high)isH=false;if(sl[k].low<=sl[j].low)isL=false;}if(isH&&rsiArr[j]!==null)sH.push({p:sl[j].high,r:rsiArr[j]});if(isL&&rsiArr[j]!==null)sL.push({p:sl[j].low,r:rsiArr[j]});}
     if(sH.length>=2){const h1=sH[sH.length-2],h2=sH[sH.length-1];if((h2.p-h1.p)/h1.p>0.005&&h1.r-h2.r>2)sigRsiDiv=-1;}
     if(sL.length>=2&&sigRsiDiv===0){const l1=sL[sL.length-2],l2=sL[sL.length-1];if((l1.p-l2.p)/l1.p>0.005&&l2.r-l1.r>2)sigRsiDiv=1;}}

    // FVG
    let sigFVG=0;
    for(let j=Math.max(2,n-30);j<n-1&&sigFVG===0;j++){
      const c0h=sl[j-2].high,c0l=sl[j-2].low,c2h=sl[j].high,c2l=sl[j].low;
      if(c2l>c0h&&(c2l-c0h)/c0h>=0.003&&price>=c0h*0.999&&price<=c2l*1.005)sigFVG=1;
      if(c0l>c2h&&(c0l-c2h)/c2h>=0.003&&price<=c0l*1.001&&price>=c2h*0.995)sigFVG=-1;
    }

    // VOL_EXH
    const volAvg20 = vols.slice(-22,-2).reduce((a,b)=>a+b,0)/20;
    const volR     = volAvg20>0 ? vols[n-1]/volAvg20 : 1;

    // SWEEP signal — na tekućoj 1H svjeći
    // Bullish sweep: MM srušio stopalice ispod, zatim reversal gore
    //   → vol≥2.5×avg20, donji wick≥40% ranga, svjeća zelena (close>open)
    // Bearish sweep: MM dizao iznad, zatim reversal dolje
    //   → vol≥2.5×avg20, gornji wick≥40% ranga, svjeća crvena (close<open)
    let sigSweep = 0;
    if (n >= 2) {
      // Gledamo prethodnu zatvoru svjeću (n-2) jer je n-1 trenutna (možda nije zatvorena)
      const sw = sl[n-2];
      const swRange = sw.high - sw.low;
      if (swRange > 0) {
        const swVol = vols[n-2];
        const swVolR = volAvg20 > 0 ? swVol / volAvg20 : 1;
        if (swVolR >= SWEEP_VOL_THR) {
          const lowerWick = Math.min(sw.close, sw.open) - sw.low;
          const upperWick = sw.high - Math.max(sw.close, sw.open);
          const isGreen   = sw.close > sw.open;
          const isRed     = sw.close < sw.open;
          // Bullish sweep: crvena/neutralna svjeća s dugim donjim wickom → reversal gore
          if (lowerWick / swRange >= SWEEP_WICK_PCT && isGreen) sigSweep = 1;
          // Bearish sweep: zelena/neutralna svjeća s dugim gornjim wickom → reversal dolje
          if (upperWick / swRange >= SWEEP_WICK_PCT && isRed)   sigSweep = -1;
        }
      }
    }

    // VWAP
    const prevC=closes[n-2],prevO=opens[n-2],currC=closes[n-1],currO=opens[n-1];
    const prevG=prevC>prevO,prevR=prevC<prevO,currG=currC>currO,currR=currC<currO;
    const vwapCrossUp=n>=3&&closes[n-3]<vwap&&closes[n-2]>vwap&&closes[n-1]>vwap;
    const vwapCrossDn=n>=3&&closes[n-3]>vwap&&closes[n-2]<vwap&&closes[n-1]<vwap;
    const vwapRejL=currC>vwap&&prevR&&prevC>vwap&&currG;
    const vwapRejS=currC<vwap&&prevG&&prevC<vwap&&currR;

    // sigs[8] = SWEEP
    const sigs = [
      price>ema50?1:-1,           // 0 E50
      cvdSum>0?1:-1,              // 1 CVD
      macdH!==null?(macdH>0?1:-1):0, // 2 MACD
      price>ema145?1:-1,          // 3 E145
      0,                          // 4 PWHL (nema weekly feed)
      sigRsiDiv,                  // 5 RDIV
      sigMktStr,                  // 6 MSTR
      sigFVG,                     // 7 FVG
      sigSweep,                   // 8 SWEEP (novi)
    ];

    out.push({
      barIdx:i, price, adx, volR, vwap,
      vwapLongOk:  vwapCrossUp||vwapRejL,
      vwapShortOk: vwapCrossDn||vwapRejS,
      sigs, candle: candles[i],
    });
  }
  return out;
}

// ─── Simulacija jednog simbola s jednim modom ─────────────────────────────────
// mode: 'block' = SWEEP blokira, 'ignore' = SWEEP ignoriran, 'bonus' = SWEEP kao bonus
function simulate(symbol, precomp, candles, mode) {
  const {slPct,tpPct} = SYMBOL_SLTP[symbol]||{slPct:2.0,tpPct:3.0};
  const volThr  = VOL_EXH_TIERS[symbol]??3.0;
  const combo   = SYMBOL_COMBOS[symbol];
  const sigIdx  = combo.sigIdx;  // [0,1,2,3,7] ili [0,1,3,5,6]
  const minSig  = combo.minSig;  // 4
  const trades  = []; let inTrade=null;
  let sweepBlockUntil = 0;  // za 'block' mode (6h u ms)

  for (let k=0; k<precomp.length; k++) {
    const p = precomp[k]; if(!p) continue;
    const c = candles[p.barIdx];

    if (inTrade) {
      let closed=false, pnlPct=0;
      if(inTrade.dir==="LONG"){
        if(c.low<=inTrade.sl){pnlPct=-slPct;closed=true;}
        else if(c.high>=inTrade.tp){pnlPct=tpPct;closed=true;}
      } else {
        if(c.high>=inTrade.sl){pnlPct=-slPct;closed=true;}
        else if(c.low<=inTrade.tp){pnlPct=tpPct;closed=true;}
      }
      if(closed){
        const riskUSD = START_CAP*RISK_PCT/100;
        trades.push({dir:inTrade.dir,pnlPct,pnlUSD:riskUSD*(pnlPct/slPct),win:pnlPct>0});
        inTrade=null;
      } else continue;
    }

    // Gatevi
    if(p.adx<ADX_MIN) continue;
    if(p.volR>=volThr) continue;
    if(!p.vwap) continue;

    const sweepSig = p.sigs[8];  // sigSweep

    // BLOCK mode: ako je sweep detektiran → blokira 6h
    if (mode === 'block') {
      if (sweepSig !== 0) {
        sweepBlockUntil = c.time + 6*3600*1000;
      }
      if (c.time < sweepBlockUntil) continue;
    }

    // Score samo za combo signale
    let bull=0, bear=0;
    for (const idx of sigIdx) {
      if(p.sigs[idx]===1) bull++;
      else if(p.sigs[idx]===-1) bear++;
    }

    // BONUS mode: SWEEP u smjeru ulaza = +1
    if (mode === 'bonus') {
      if (sweepSig === 1)  bull++;
      if (sweepSig === -1) bear++;
    }
    // 'ignore' mode: ništa s sweepom

    if(bull>=minSig && p.vwapLongOk)
      inTrade={dir:"LONG",  sl:p.price*(1-slPct/100), tp:p.price*(1+tpPct/100)};
    else if(bear>=minSig && p.vwapShortOk)
      inTrade={dir:"SHORT", sl:p.price*(1+slPct/100), tp:p.price*(1-tpPct/100)};
  }
  return trades;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍 SWEEP Bonus Backtest — ${ACTIVE_SYMBOLS.length} simbola | ${BARS} bara 1H\n`);
  console.log(`Sweep kriterij: vol≥${SWEEP_VOL_THR}×avg20, wick≥${SWEEP_WICK_PCT*100}% ranga\n`);
  console.log('Fetchujem candles...');

  const allPrecomp={}, allCandles={};
  for(const sym of ACTIVE_SYMBOLS){
    process.stdout.write(`  ${sym}... `);
    try{
      const c=await fetchCandles(sym);
      allCandles[sym]=c;
      allPrecomp[sym]=precompute(c);
      console.log(`${c.length} bara`);
    }catch(e){console.log(`GREŠKA: ${e.message}`);}
    await new Promise(r=>setTimeout(r,250));
  }

  const MODES = ['block','ignore','bonus'];
  const results = {};
  for(const mode of MODES) results[mode]={trades:0,wins:0,pnl:0,perSym:{}};

  for(const sym of ACTIVE_SYMBOLS){
    if(!allPrecomp[sym]) continue;
    for(const mode of MODES){
      const trades = simulate(sym, allPrecomp[sym], allCandles[sym], mode);
      const wins   = trades.filter(t=>t.win).length;
      const pnl    = trades.reduce((s,t)=>s+t.pnlUSD,0);
      results[mode].trades += trades.length;
      results[mode].wins   += wins;
      results[mode].pnl    += pnl;
      results[mode].perSym[sym] = {trades:trades.length, wins, pnl, wr:trades.length>0?(wins/trades.length*100).toFixed(1):'-'};
    }
  }

  // Ispis rezultata
  console.log('\n' + '═'.repeat(72));
  console.log('  MOD            | Tradova | WR%    | P&L ($) | PF');
  console.log('─'.repeat(72));

  for(const mode of MODES){
    const r = results[mode];
    const wr = r.trades>0?(r.wins/r.trades*100).toFixed(1):'-';
    const grossW = Object.values(r.perSym).reduce((s,v)=>s+Math.max(0,v.pnl),0);
    const grossL = Math.abs(Object.values(r.perSym).reduce((s,v)=>s+Math.min(0,v.pnl),0));
    const pf = grossL>0?(grossW/grossL).toFixed(2):'∞';
    const modeLabel = mode==='block'?'A) SWEEP blokira 6h ':mode==='ignore'?'B) SWEEP ignoriran  ':'C) SWEEP kao bonus  ';
    console.log(`  ${modeLabel} | ${String(r.trades).padStart(7)} | ${String(wr+'%').padStart(6)} | ${r.pnl>=0?'+':''}${r.pnl.toFixed(0).padStart(7)} | ${pf}`);
  }

  console.log('─'.repeat(72));
  console.log('\nPo simbolu:\n');
  console.log('  SIMBOL       | A: blok         | B: ignore       | C: bonus');
  console.log('─'.repeat(72));
  for(const sym of ACTIVE_SYMBOLS){
    const a=results.block.perSym[sym]||{}, b=results.ignore.perSym[sym]||{}, c=results.bonus.perSym[sym]||{};
    const fmt=v=>`${v.trades}t ${v.wr}% ${v.pnl>=0?'+':''}$${v.pnl?.toFixed(0)}`;
    console.log(`  ${sym.padEnd(12)} | ${fmt(a).padEnd(16)}| ${fmt(b).padEnd(16)}| ${fmt(c)}`);
  }
  console.log('\n');

  // Zaključak
  const best = MODES.reduce((a,b)=>results[a].pnl>results[b].pnl?a:b);
  const bestWr = results[best];
  console.log(`🏆 Najbolji mod: ${best.toUpperCase()}`);
  console.log(`   P&L: $${bestWr.pnl.toFixed(0)} | WR: ${(bestWr.wins/bestWr.trades*100).toFixed(1)}% | Tradova: ${bestWr.trades}\n`);
}

main().catch(console.error);
