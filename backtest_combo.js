// ─── ULTRA Backtest — Signal Combo Optimizer ──────────────────────────────────
// Testira sve C(8,5)=56 kombinacije 5 signala od 8, na svim 13 simbola
// Pokretanje: node backtest_combo.js [--bars 1000] [--minsig 4]
'use strict';

const ALL_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT","LINKUSDT","ADAUSDT",
  "TAOUSDT","SEIUSDT","PEPEUSDT","JUPUSDT","FETUSDT","AAVEUSDT",
];
const SYMBOL_SLTP = {
  "BTCUSDT":  {slPct:1.5,tpPct:2.25}, "ETHUSDT":  {slPct:2.0,tpPct:3.0},
  "SOLUSDT":  {slPct:2.0,tpPct:3.0},  "XRPUSDT":  {slPct:2.0,tpPct:3.0},
  "BNBUSDT":  {slPct:1.5,tpPct:2.25}, "LINKUSDT": {slPct:2.0,tpPct:3.0},
  "ADAUSDT":  {slPct:2.0,tpPct:3.0},  "TAOUSDT":  {slPct:2.5,tpPct:3.75},
  "SEIUSDT":  {slPct:2.5,tpPct:3.75}, "PEPEUSDT": {slPct:2.0,tpPct:3.0},
  "JUPUSDT":  {slPct:3.0,tpPct:4.5},  "FETUSDT":  {slPct:2.5,tpPct:3.75},
  "AAVEUSDT": {slPct:2.5,tpPct:3.75},
};
const VOL_EXH_TIERS = {
  "BTCUSDT":5.0,"ETHUSDT":4.0,"SOLUSDT":4.0,"XRPUSDT":4.0,
  "ADAUSDT":3.5,"LINKUSDT":3.5,"SEIUSDT":3.0,"TAOUSDT":2.5,
  "JUPUSDT":2.5,"FETUSDT":3.0,"AAVEUSDT":3.0,"PEPEUSDT":3.5,"BNBUSDT":4.0,
};
const VOL_EXH_DEFAULT = 3.0;
const ADX_MIN = 22;
const RISK_PCT = 1.5;
const START_CAPITAL = 1000;

const args   = process.argv.slice(2);
const getArg = (f,d) => { const i=args.indexOf(f); return i>=0?args[i+1]:d; };
const BARS    = parseInt(getArg('--bars','1000'));
const MIN_SIG = parseInt(getArg('--minsig','4')); // 4/5 ≈ 80% (vs trenutnih 6/8=75%)
const TF      = getArg('--tf','1H');

// ─── 8 signala (indeksi) ──────────────────────────────────────────────────────
const SIGNAL_NAMES = ['E50↑','CVD↑','MACD','E145','PWHL','RDIV','MSTR','FVG'];

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${TF}&limit=${Math.min(BARS,1000)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(json.msg);
  return json.data.map(k=>({time:parseInt(k[0]),open:parseFloat(k[1]),high:parseFloat(k[2]),low:parseFloat(k[3]),close:parseFloat(k[4]),volume:parseFloat(k[5])})).sort((a,b)=>a.time-b.time);
}

// ─── Indikatori ───────────────────────────────────────────────────────────────
function calcEMA(closes,p){
  if(closes.length<p)return null;
  const k=2/(p+1);let v=closes.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<closes.length;i++)v=closes[i]*k+v*(1-k);return v;
}
function rsiSeries(closes,p=14){
  const r=new Array(closes.length).fill(null);
  if(closes.length<=p)return r;
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
  for(let i=p;i<dx.length;i++)adx=(adx*(p-1)+dx[i])/p;
  return adx;
}
function calcMACD(closes){
  function es(arr,p){if(arr.length<p)return null;const k=2/(p+1);let v=arr.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<arr.length;i++)v=arr[i]*k+v*(1-k);return v;}
  const diffs=[];
  for(let i=26;i<=closes.length;i++){const f=es(closes.slice(0,i),12),s=es(closes.slice(0,i),26);if(f!==null&&s!==null)diffs.push(f-s);}
  if(diffs.length<9)return null;
  const hv=[];const sk=2/10;let sv=diffs.slice(0,9).reduce((a,b)=>a+b,0)/9;
  for(let j=9;j<diffs.length;j++){sv=diffs[j]*sk+sv*(1-sk);hv.push(diffs[j]-sv);}
  return hv.length>0?hv[hv.length-1]:null;
}
function calcVWAP(candles){
  let pv=0,v=0;for(const c of candles){const tp=(c.high+c.low+c.close)/3;pv+=tp*c.volume;v+=c.volume;}return v>0?pv/v:null;
}

// ─── Precompute signale za sve barove ─────────────────────────────────────────
function precomputeSignals(candles) {
  const results = [];
  for (let i = 210; i < candles.length; i++) {
    const slice  = candles.slice(0, i+1);
    const n      = slice.length;
    const closes = slice.map(c=>c.close);
    const opens  = slice.map(c=>c.open);
    const vols   = slice.map(c=>c.volume);
    const price  = closes[n-1];

    const ema50  = calcEMA(closes,50);
    const ema145 = calcEMA(closes,145);
    if(!ema50||!ema145){results.push(null);continue;}
    const rsiArr = rsiSeries(closes,14);
    const rsi=rsiArr[n-1]??50,rsi1=rsiArr[n-2]??rsi,rsi2=rsiArr[n-3]??rsi1;
    const rsiRising=rsi>rsi1&&rsi1>rsi2,rsiFalling=rsi<rsi1&&rsi1<rsi2;
    const adx    = calcADX(slice);
    const macdH  = calcMACD(closes);
    const vwap   = calcVWAP(slice.slice(-96));

    let cvdSum=0;
    for(let j=n-20;j<n;j++)cvdSum+=(closes[j]>opens[j]?1:closes[j]<opens[j]?-1:0)*vols[j];

    // MSTR
    let sigMktStr=0;
    {const W=3,msEnd=n-W-1,msStart=Math.max(W,n-60);const mH=[],mL=[];
     for(let j=msStart;j<=msEnd;j++){let isH=true,isL=true;for(let k=j-W;k<=j+W;k++){if(k===j)continue;if(slice[k].high>=slice[j].high)isH=false;if(slice[k].low<=slice[j].low)isL=false;}if(isH)mH.push(slice[j].high);if(isL)mL.push(slice[j].low);}
     if(mH.length>=2&&mL.length>=2){if(mH[mH.length-1]>mH[mH.length-2]&&mL[mL.length-1]>mL[mL.length-2])sigMktStr=1;if(mH[mH.length-1]<mH[mH.length-2]&&mL[mL.length-1]<mL[mL.length-2])sigMktStr=-1;}}

    // RDIV
    let sigRsiDiv=0;
    {const DW=3,DRS=Math.max(DW,n-40),DRE=n-DW-1;const sH=[],sL=[];
     for(let j=DRS;j<=DRE;j++){let isH=true,isL=true;for(let k=j-DW;k<=j+DW;k++){if(k===j)continue;if(slice[k].high>=slice[j].high)isH=false;if(slice[k].low<=slice[j].low)isL=false;}if(isH&&rsiArr[j]!==null)sH.push({p:slice[j].high,r:rsiArr[j]});if(isL&&rsiArr[j]!==null)sL.push({p:slice[j].low,r:rsiArr[j]});}
     if(sH.length>=2){const h1=sH[sH.length-2],h2=sH[sH.length-1];if((h2.p-h1.p)/h1.p>0.005&&h1.r-h2.r>2)sigRsiDiv=-1;}
     if(sL.length>=2&&sigRsiDiv===0){const l1=sL[sL.length-2],l2=sL[sL.length-1];if((l1.p-l2.p)/l1.p>0.005&&l2.r-l1.r>2)sigRsiDiv=1;}}

    // FVG
    let sigFVG=0;
    for(let j=Math.max(2,n-30);j<n-1&&sigFVG===0;j++){
      const c0h=slice[j-2].high,c0l=slice[j-2].low,c2h=slice[j].high,c2l=slice[j].low;
      if(c2l>c0h&&(c2l-c0h)/c0h>=0.003&&price>=c0h*0.999&&price<=c2l*1.005)sigFVG=1;
      if(c0l>c2h&&(c0l-c2h)/c2h>=0.003&&price<=c0l*1.001&&price>=c2h*0.995)sigFVG=-1;
    }

    // VOL_EXH
    const volAvg=vols.slice(-20).reduce((a,b)=>a+b,0)/20;
    const volR=volAvg>0?vols[n-1]/volAvg:1;

    // VWAP
    const prevC=closes[n-2],prevO=opens[n-2],currC=closes[n-1],currO=opens[n-1];
    const prevG=prevC>prevO,prevR=prevC<prevO,currG=currC>currO,currR=currC<currO;
    const vwapCrossUp=n>=3&&closes[n-3]<vwap&&closes[n-2]>vwap&&closes[n-1]>vwap;
    const vwapCrossDn=n>=3&&closes[n-3]>vwap&&closes[n-2]<vwap&&closes[n-1]<vwap;
    const vwapRejL=currC>vwap&&prevR&&prevC>vwap&&currG;
    const vwapRejS=currC<vwap&&prevG&&prevC<vwap&&currR;
    const vwapLongOk=vwapCrossUp||vwapRejL;
    const vwapShortOk=vwapCrossDn||vwapRejS;

    // 8 signala kao niz [+1/-1/0]
    const sigs = [
      ema50  ? (price>ema50  ?1:-1) : 0,  // 0 E50↑
      cvdSum>0?1:-1,                        // 1 CVD↑
      macdH!==null?(macdH>0?1:-1):0,       // 2 MACD
      ema145 ? (price>ema145?1:-1) : 0,    // 3 E145
      0,                                    // 4 PWHL (nema weekly feed)
      sigRsiDiv,                            // 5 RDIV
      sigMktStr,                            // 6 MSTR
      sigFVG,                               // 7 FVG
    ];

    results.push({
      barIdx: i, price, adx, volR, vwap, vwapLongOk, vwapShortOk,
      sigs, candle: candles[i],
    });
  }
  return results;
}

// ─── Simulacija za jednu kombinaciju signala ──────────────────────────────────
function simulateCombo(symbol, precomp, candles, sigIndices, minSig) {
  const {slPct,tpPct} = SYMBOL_SLTP[symbol]||{slPct:2.0,tpPct:3.0};
  const volThr = VOL_EXH_TIERS[symbol]??VOL_EXH_DEFAULT;
  const trades=[]; let inTrade=null;

  for(let k=0;k<precomp.length;k++){
    const p=precomp[k]; if(!p)continue;

    if(inTrade){
      const c=candles[p.barIdx]; let closed=false,pnlPct=0;
      if(inTrade.dir==="LONG"){
        if(c.low<=inTrade.sl){pnlPct=-slPct;closed=true;}
        else if(c.high>=inTrade.tp){pnlPct=tpPct;closed=true;}
      }else{
        if(c.high>=inTrade.sl){pnlPct=-slPct;closed=true;}
        else if(c.low<=inTrade.tp){pnlPct=tpPct;closed=true;}
      }
      if(closed){
        const riskUSD=START_CAPITAL*RISK_PCT/100;
        trades.push({dir:inTrade.dir,pnlPct,pnlUSD:riskUSD*(pnlPct/slPct),win:pnlPct>0});
        inTrade=null;
      }else continue;
    }

    // Gatevi
    if(p.adx<ADX_MIN)continue;
    if(p.volR>=(volThr))continue;
    if(!p.vwap)continue;

    // Score samo za odabrane signale
    let bull=0,bear=0;
    for(const idx of sigIndices){
      if(p.sigs[idx]===1)bull++;
      else if(p.sigs[idx]===-1)bear++;
    }

    if(bull>=minSig&&p.vwapLongOk)
      inTrade={dir:"LONG",sl:p.price*(1-slPct/100),tp:p.price*(1+tpPct/100)};
    else if(bear>=minSig&&p.vwapShortOk)
      inTrade={dir:"SHORT",sl:p.price*(1+slPct/100),tp:p.price*(1-tpPct/100)};
  }
  return trades;
}

// ─── Kombinacije C(8,5) ───────────────────────────────────────────────────────
function combinations(arr, k) {
  const result=[];
  function helper(start,current){
    if(current.length===k){result.push([...current]);return;}
    for(let i=start;i<arr.length;i++){current.push(arr[i]);helper(i+1,current);current.pop();}
  }
  helper(0,[]);
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sigIdxAll = [0,1,2,3,4,5,6,7];
  const combos = combinations(sigIdxAll, 5);
  console.log(`\nULTRA Combo Backtest — ${ALL_SYMBOLS.length} simbola | ${combos.length} kombinacija | minSig=${MIN_SIG}/5 | ${BARS} bara\n`);

  // 1. Fetch + precompute sve simbole
  console.log('Fetchujem i precompute-am candles...');
  const allPrecomp = {};
  const allCandles = {};
  for(const sym of ALL_SYMBOLS){
    process.stdout.write(`  ${sym}... `);
    try{
      const c=await fetchCandles(sym);
      allCandles[sym]=c;
      allPrecomp[sym]=precomputeSignals(c);
      console.log(`${c.length} bara, ${allPrecomp[sym].filter(Boolean).length} aktivnih barova`);
    }catch(e){console.log(`GREŠKA: ${e.message}`);}
    await new Promise(r=>setTimeout(r,200));
  }

  // 2. Za svaku kombinaciju, testiraj sve simbole
  console.log(`\nTestiram ${combos.length} kombinacija...\n`);
  const comboResults = [];

  for(const combo of combos){
    const label = combo.map(i=>SIGNAL_NAMES[i]).join('+');
    let totalTrades=0,totalWins=0,totalPnL=0;
    const perSym={};

    for(const sym of ALL_SYMBOLS){
      if(!allPrecomp[sym])continue;
      const trades=simulateCombo(sym,allPrecomp[sym],allCandles[sym],combo,MIN_SIG);
      const wins=trades.filter(t=>t.win).length;
      const pnl=trades.reduce((s,t)=>s+t.pnlUSD,0);
      perSym[sym]={trades:trades.length,wins,pnl};
      totalTrades+=trades.length;totalWins+=wins;totalPnL+=pnl;
    }

    const wr=totalTrades>0?totalWins/totalTrades*100:0;
    const grossW=Object.values(perSym).reduce((s,v)=>s+Math.max(0,v.pnl),0);
    const grossL=Math.abs(Object.values(perSym).reduce((s,v)=>s+Math.min(0,v.pnl),0));
    const pf=grossL>0?grossW/grossL:grossW>0?99:0;
    comboResults.push({label,combo,totalTrades,totalWins,totalPnL,wr,pf,perSym});
  }

  // 3. Sortiraj po P&L
  comboResults.sort((a,b)=>b.totalPnL-a.totalPnL);

  // 4. Ispis top 15
  const G="\x1b[32m",R="\x1b[31m",Y="\x1b[33m",C="\x1b[36m",B="\x1b[1m",RESET="\x1b[0m";
  const sep='─'.repeat(80);
  console.log(`\n${sep}`);
  console.log(`  TOP 15 KOMBINACIJA (sortirano po P&L) — minSig ${MIN_SIG}/5`);
  console.log(sep);
  console.log(`  ${'SIGNALI'.padEnd(40)} ${'TRAD'.padStart(5)} ${'WR%'.padStart(6)} ${'P&L $'.padStart(9)} ${'PF'.padStart(5)}`);
  console.log(sep);

  for(let i=0;i<Math.min(15,comboResults.length);i++){
    const r=comboResults[i];
    const col=r.totalPnL>=0?G:R;
    const pnlStr=(r.totalPnL>=0?'+':'')+r.totalPnL.toFixed(2);
    console.log(`  ${String(i+1).padStart(2)}. ${r.label.padEnd(38)} ${String(r.totalTrades).padStart(5)} ${r.wr.toFixed(1).padStart(5)}% ${col}${pnlStr.padStart(9)}${RESET} ${r.pf.toFixed(2).padStart(5)}`);
  }
  console.log(sep);

  // 5. Top 5 tokena po ukupnom P&L (prosjek svih kombinacija)
  const symTotals = {};
  for(const sym of ALL_SYMBOLS){
    const allPnl = comboResults.map(r=>r.perSym[sym]?.pnl||0);
    const allTrades = comboResults.map(r=>r.perSym[sym]?.trades||0);
    symTotals[sym] = {
      avgPnl: allPnl.reduce((a,b)=>a+b,0)/allPnl.length,
      bestPnl: Math.max(...allPnl),
      totalTradesAvg: allTrades.reduce((a,b)=>a+b,0)/allTrades.length,
    };
  }
  const top5syms = Object.entries(symTotals).sort((a,b)=>b[1].bestPnl-a[1].bestPnl).slice(0,5).map(e=>e[0]);

  console.log(`\n${sep}`);
  console.log(`  TOP 5 TOKENA — sve kombinacije (sortirano po best P&L)`);
  console.log(sep);

  for(const sym of top5syms){
    const symCombos = comboResults.map(r=>({label:r.label,combo:r.combo,...r.perSym[sym]})).filter(r=>r.trades>0).sort((a,b)=>b.pnl-a.pnl);
    const best = symCombos[0];
    const avg = symCombos.reduce((s,r)=>s+r.pnl,0)/symCombos.length;
    console.log(`\n  ${B}${sym}${RESET}  Best: ${G}+$${best.pnl.toFixed(2)}${RESET}  Avg po kombi: ${avg>=0?G:R}${avg>=0?'+':''}$${avg.toFixed(2)}${RESET}`);
    console.log(`  ${'KOMBINACIJA'.padEnd(42)} ${'TRAD'.padStart(4)} ${'WR%'.padStart(5)} ${'P&L $'.padStart(8)}`);
    console.log(`  ${'─'.repeat(64)}`);
    for(let i=0;i<Math.min(5,symCombos.length);i++){
      const r=symCombos[i];
      const wr=r.trades>0?(r.wins/r.trades*100).toFixed(0):0;
      const col=r.pnl>=0?G:R;
      console.log(`  ${String(i+1)}. ${r.label.padEnd(40)} ${String(r.trades).padStart(4)} ${String(wr).padStart(4)}% ${col}${(r.pnl>=0?'+':'')}$${r.pnl.toFixed(2)}${RESET}`);
    }
  }

  // 6. Ispis po simbolu za top 3 kombinacije
  console.log(`\n${sep}`);
  console.log(`  TOP 3 KOMBINACIJE — detalji po simbolu`);
  console.log(sep);

  for(let i=0;i<3;i++){
    const r=comboResults[i];
    console.log(`\n  ${B}#${i+1}: ${r.label}${RESET}  WR:${r.wr.toFixed(1)}%  P&L:${r.totalPnL>=0?G:R}$${r.totalPnL.toFixed(2)}${RESET}  PF:${r.pf.toFixed(2)}`);
    const symRows=Object.entries(r.perSym).sort((a,b)=>b[1].pnl-a[1].pnl);
    for(const [sym,s] of symRows){
      if(s.trades===0)continue;
      const wr=s.trades>0?(s.wins/s.trades*100).toFixed(0):0;
      const col=s.pnl>=0?G:R;
      console.log(`     ${sym.padEnd(12)} ${String(s.trades).padStart(3)} trad  WR:${String(wr).padStart(3)}%  ${col}${(s.pnl>=0?'+':'')}$${s.pnl.toFixed(2)}${RESET}`);
    }
  }

  // 6. Best combo po simbolu
  console.log(`\n${sep}`);
  console.log(`  BEST KOMBINACIJA PO SIMBOLU`);
  console.log(sep);

  for(const sym of ALL_SYMBOLS){
    const best=comboResults.filter(r=>r.perSym[sym]&&r.perSym[sym].trades>0).sort((a,b)=>b.perSym[sym].pnl-a.perSym[sym].pnl)[0];
    if(!best)continue;
    const s=best.perSym[sym];
    const wr=s.trades>0?(s.wins/s.trades*100).toFixed(0):0;
    const col=s.pnl>=0?G:R;
    console.log(`  ${sym.padEnd(12)} ${best.label.padEnd(38)} WR:${String(wr).padStart(3)}%  ${col}${(s.pnl>=0?'+':'')}$${s.pnl.toFixed(2)}${RESET}`);
  }
  console.log(sep+'\n');
}

main().catch(e=>{console.error(e);process.exit(1);});
