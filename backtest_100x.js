// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  ULTRA — Backtest 100x Leverage | SL 1% / TP 2% | Compound Equity          ║
// ║  Simulira realnu banku $300 sa compound growthom                            ║
// ║  Pokreni: node backtest_100x.js                                             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

const SYMBOLS = [
  "XAUUSDT","DOGEUSDT","NEARUSDT","ADAUSDT",
  "ETHUSDT","SUIUSDT","TAOUSDT",
  "SOLUSDT","HYPEUSDT","LINKUSDT","PEPEUSDT","ZECUSDT","BTCUSDT"
];

const TIMEFRAMES  = ["15m", "1H", "4H"];
const MIN_SIG     = 10;
const SL_PCT      = 1.0;    // SL 1% × 100x = 100% margine = likvidacija
const TP_PCT      = 2.0;    // TP 2% × 100x = 200% margine = +3% banke
const LEVERAGE    = 100;
const RISK_PCT    = 1.5;    // % banke koji riskiraš po tradeu (= margin)
const START_BANK  = 300;    // početna banka $
const BAR_LIMIT   = 1000;

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
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + (d > 0 ? d : 0)) / period;
    al = (al * (period-1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function macdHistSeries(closes) {
  const fE = emaSeries(closes, 12), sE = emaSeries(closes, 26);
  const diffs = closes.map((_, i) => fE[i]&&sE[i] ? fE[i]-sE[i] : null);
  const out = new Array(closes.length).fill(null);
  const k = 2/10; let sv=null, cnt=0;
  for (let i=0; i<diffs.length; i++) {
    if (diffs[i]===null) continue;
    if (sv===null) { sv=diffs[i]; cnt++; if(cnt>=9) out[i]=diffs[i]-sv; }
    else { sv=diffs[i]*k+sv*(1-k); out[i]=diffs[i]-sv; }
  }
  return out;
}

function adxSeries(candles, period = 14) {
  const n=candles.length, out=new Array(n).fill(null);
  if (n < period*2+1) return out;
  const trs=[],pdms=[],mdms=[];
  for (let i=1;i<n;i++) {
    const h=candles[i].high,l=candles[i].low,ph=candles[i-1].high,pl=candles[i-1].low,pc=candles[i-1].close;
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-ph,dn=pl-l;
    pdms.push(up>dn&&up>0?up:0); mdms.push(dn>up&&dn>0?dn:0);
  }
  let atr=trs.slice(0,period).reduce((a,b)=>a+b,0);
  let pdm=pdms.slice(0,period).reduce((a,b)=>a+b,0);
  let mdm=mdms.slice(0,period).reduce((a,b)=>a+b,0);
  const dxArr=[];
  for (let i=period;i<trs.length;i++) {
    atr=atr-atr/period+trs[i]; pdm=pdm-pdm/period+pdms[i]; mdm=mdm-mdm/period+mdms[i];
    const pdi=atr===0?0:100*pdm/atr, mdi=atr===0?0:100*mdm/atr, sum=pdi+mdi;
    dxArr.push(sum===0?0:100*Math.abs(pdi-mdi)/sum);
  }
  if (dxArr.length<period) return out;
  let adxVal=dxArr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period*2]=adxVal;
  for (let i=period;i<dxArr.length;i++) {
    adxVal=(adxVal*(period-1)+dxArr[i])/period;
    out[period*2+(i-period)+1]=adxVal;
  }
  return out;
}

function choppinessSeries(candles, period=14) {
  const n=candles.length, out=new Array(n).fill(null);
  for (let i=period;i<n;i++) {
    const sl=candles.slice(i-period+1,i+1);
    let atrSum=0,hh=-Infinity,ll=Infinity;
    for (let j=0;j<sl.length;j++) {
      const h=sl[j].high,l=sl[j].low,pc=j>0?sl[j-1].close:sl[j].open;
      atrSum+=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
      if(h>hh)hh=h; if(l<ll)ll=l;
    }
    out[i]=hh===ll?100:100*Math.log10(atrSum/(hh-ll))/Math.log10(period);
  }
  return out;
}

function precompute(candles) {
  const closes=candles.map(c=>c.close), volumes=candles.map(c=>c.volume);
  return {
    closes,volumes,
    e9:emaSeries(closes,9),e21:emaSeries(closes,21),e50:emaSeries(closes,50),
    e55:emaSeries(closes,55),e145:emaSeries(closes,145),
    e3:emaSeries(closes,3),e11:emaSeries(closes,11),e7:emaSeries(closes,7),
    e15:emaSeries(closes,15),e13:emaSeries(closes,13),e21b:emaSeries(closes,21),
    e19:emaSeries(closes,19),e29:emaSeries(closes,29),e29b:emaSeries(closes,29),
    e47:emaSeries(closes,47),e45:emaSeries(closes,45),e55b:emaSeries(closes,55),
    rsi:rsiSeries(closes,14),macdH:macdHistSeries(closes),
    adx:adxSeries(candles,14),chop:choppinessSeries(candles,14),
    volMA:emaSeries(volumes,20),
  };
}

function scoreAt(i, s, candles) {
  const {closes,volumes,e9,e21,e50,e55,e145,e3,e11,e7,e15,e13,e21b,e19,e29,e29b,e47,e45,e55b,rsi,macdH,adx,chop,volMA}=s;
  if (!e9[i]||!e21[i]||!e50[i]||!e55[i]||!e145[i]||!rsi[i]||!adx[i]||!chop[i]) return null;
  const price=closes[i],rsiVal=rsi[i],adxVal=adx[i];
  const rsiRising=rsi[i]>rsi[i-1]&&rsi[i-1]>rsi[i-2];
  const rsiFalling=rsi[i]<rsi[i-1]&&rsi[i-1]<rsi[i-2];
  let rsiMin5=Infinity,rsiMax5=-Infinity;
  for (let k=i-4;k<=i;k++) if(rsi[k]){rsiMin5=Math.min(rsiMin5,rsi[k]);rsiMax5=Math.max(rsiMax5,rsi[k]);}
  let cvdSum=0;
  for (let k=Math.max(0,i-19);k<=i;k++){const c=candles[k];cvdSum+=c.close>c.open?c.volume:c.close<c.open?-c.volume:0;}
  const scaleUp=[e3[i]>e11[i],e7[i]>e15[i],e13[i]>e21b[i],e19[i]>e29[i],e29b[i]>e47[i],e45[i]>e55b[i]].filter(Boolean).length;
  const scaleDn=[e3[i]<e11[i],e7[i]<e15[i],e13[i]<e21b[i],e19[i]<e29[i],e29b[i]<e47[i],e45[i]<e55b[i]].filter(Boolean).length;
  let crossUp=false,crossDn=false;
  for (let k=Math.max(1,i-2);k<=i;k++){if(e9[k]>e21[k]&&e9[k-1]<=e21[k-1])crossUp=true;if(e9[k]<e21[k]&&e9[k-1]>=e21[k-1])crossDn=true;}
  let mccUp=false,mccDn=false;
  for (let k=Math.max(1,i-2);k<=i;k++){if(macdH[k]!==null&&macdH[k-1]!==null){if(macdH[k]>0&&macdH[k-1]<=0)mccUp=true;if(macdH[k]<0&&macdH[k-1]>=0)mccDn=true;}}
  const sigs=[
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
  return { bull:sigs.filter(v=>v===1).length, bear:sigs.filter(v=>v===-1).length };
}

// ─── Backtest s compound equity ────────────────────────────────────────────────
function runBacktest(candles) {
  const s = precompute(candles);
  const trades = [];
  let position = null, pending = null;
  const START = 210;

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
        const pricePct = position.side === "LONG"
          ? (exitPrice - position.entryPrice) / position.entryPrice * 100
          : (position.entryPrice - exitPrice) / position.entryPrice * 100;
        // P&L u % banke: margin = RISK_PCT% banke, notional = margin × LEVERAGE
        // gubitak/dobitak = pricePct × LEVERAGE × margin = pricePct × LEVERAGE × RISK_PCT% banke
        // ali je cappiran na 100% margine (likvidacija = -RISK_PCT% banke)
        const pnlBankPct = exitReason === "SL"
          ? -RISK_PCT                          // SL = gubiš cijelu marginu
          : RISK_PCT * (TP_PCT / SL_PCT);      // TP = dobitak = margin × RR
        trades.push({
          side: position.side, exitReason, pricePct,
          pnlBankPct, time: candles[i+1].time,
        });
        position = null;
      }
      continue;
    }

    const sc = scoreAt(i, s, candles);
    if (!sc) continue;
    const longSig  = sc.bull >= MIN_SIG;
    const shortSig = sc.bear >= MIN_SIG;

    if (pending) {
      if (pending.side==="LONG"  && !longSig)  pending=null;
      else if (pending.side==="SHORT" && !shortSig) pending=null;
      else if (i > pending.sigBar) {
        const broke = pending.side==="LONG" ? bar.high>pending.trigH : bar.low<pending.trigL;
        if (broke) {
          const ep = pending.side==="LONG" ? pending.trigH : pending.trigL;
          position = {
            side: pending.side, entryPrice: ep,
            sl: pending.side==="LONG" ? ep*(1-SL_PCT/100) : ep*(1+SL_PCT/100),
            tp: pending.side==="LONG" ? ep*(1+TP_PCT/100) : ep*(1-TP_PCT/100),
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

// ─── Helpers ───────────────────────────────────────────────────────────────────
const G="\x1b[32m",R="\x1b[31m",Y="\x1b[33m",B="\x1b[36m",W="\x1b[1m",RESET="\x1b[0m";
const c=(n,d=1)=>{ const s=(n>=0?"+":"")+n.toFixed(d)+"%"; return (n>=0?G:R)+s+RESET; };
const d=(n)=>{ const s=(n>=0?"+$":"-$")+Math.abs(n).toFixed(2); return (n>=0?G:R)+s+RESET; };

function simEquity(trades) {
  let bank = START_BANK, peak = START_BANK, maxDD = 0;
  let consLoss = 0, maxConsLoss = 0;
  for (const t of trades) {
    bank *= (1 + t.pnlBankPct / 100);
    if (bank > peak) peak = bank;
    const dd = (peak - bank) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    if (t.exitReason === "SL") { consLoss++; if (consLoss > maxConsLoss) maxConsLoss = consLoss; }
    else consLoss = 0;
  }
  return { finalBank: bank, maxDD, maxConsLoss };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${W}${"═".repeat(72)}${RESET}`);
  console.log(`  🚀 ULTRA Backtest — ${LEVERAGE}x Leverage | SL ${SL_PCT}% / TP ${TP_PCT}% | RR 1:2`);
  console.log(`  Banka: $${START_BANK} | Rizik: ${RISK_PCT}% po tradeu | Min signala: ${MIN_SIG}/16`);
  console.log(`  Margin = $${(START_BANK*RISK_PCT/100).toFixed(2)} | Notional = $${(START_BANK*RISK_PCT/100*LEVERAGE).toFixed(0)} | SL hit = -$${(START_BANK*RISK_PCT/100).toFixed(2)} | TP hit = +$${(START_BANK*RISK_PCT/100*TP_PCT/SL_PCT).toFixed(2)}`);
  console.log(`${W}${"═".repeat(72)}${RESET}\n`);

  for (const tf of TIMEFRAMES) {
    console.log(`\n${W}${"═".repeat(72)}${RESET}`);
    console.log(`  📊 Timeframe: ${B}${tf}${RESET}`);
    console.log(`${W}${"═".repeat(72)}${RESET}`);

    const HDR = `${"SIMBOL".padEnd(12)} ${"TRAD".padStart(5)} ${"WIN".padStart(4)} ${"SL".padStart(4)} ${"WR%".padStart(6)} ${"P&L%".padStart(8)} ${"PROFIT".padStart(9)} ${"MaxDD%".padStart(8)} ${"MaxLoss".padStart(8)}`;
    console.log(`\n${B}${HDR}${RESET}`);
    console.log("─".repeat(72));

    let totTrades=0, totWins=0, totLoss=0, allTrades=[];

    for (const symbol of SYMBOLS) {
      try {
        process.stdout.write(`  ⏳ ${symbol}...\r`);
        const candles = await fetchCandles(symbol, tf, BAR_LIMIT);
        if (candles.length < 250) continue;

        const trades  = runBacktest(candles);
        const wins    = trades.filter(t=>t.exitReason==="TP").length;
        const losses  = trades.filter(t=>t.exitReason==="SL").length;
        const pnlPct  = wins*RISK_PCT*(TP_PCT/SL_PCT) - losses*RISK_PCT;
        const profit  = START_BANK * pnlPct / 100;
        const wr      = trades.length ? wins/trades.length*100 : 0;
        const { maxDD, maxConsLoss } = simEquity(trades);
        const col     = pnlPct>=0 ? G : R;

        totTrades+=trades.length; totWins+=wins; totLoss+=losses;
        allTrades.push(...trades);

        console.log(
          `${col}${symbol.padEnd(12)}${RESET}` +
          ` ${String(trades.length).padStart(5)}` +
          ` ${String(wins).padStart(4)} ${String(losses).padStart(4)}` +
          ` ${(wr.toFixed(1)+"%").padStart(6)}` +
          ` ${col}${((pnlPct>=0?"+":"")+pnlPct.toFixed(1)+"%").padStart(8)}${RESET}` +
          ` ${col}${((profit>=0?"+$":"-$")+Math.abs(profit).toFixed(2)).padStart(9)}${RESET}` +
          ` ${R}${(maxDD.toFixed(1)+"%").padStart(8)}${RESET}` +
          ` ${Y}${String(maxConsLoss).padStart(8)}${RESET}`
        );
        await new Promise(r=>setTimeout(r,100));
      } catch(e) { console.log(`  ❌ ${symbol}: ${e.message}`); }
    }

    // Ukupno za TF
    const totWr   = totTrades ? totWins/totTrades*100 : 0;
    const totPnl  = totWins*RISK_PCT*(TP_PCT/SL_PCT) - totLoss*RISK_PCT;
    const totProfit = START_BANK * totPnl / 100;
    const totPF   = totLoss ? (totWins*RISK_PCT*(TP_PCT/SL_PCT))/(totLoss*RISK_PCT) : Infinity;
    const { finalBank, maxDD: tfMaxDD, maxConsLoss: tfMaxCons } = simEquity(allTrades);
    const tfCol   = totPnl>=0 ? G : R;

    console.log("─".repeat(72));
    console.log(
      `${tfCol}${"UKUPNO".padEnd(12)}${RESET}` +
      ` ${String(totTrades).padStart(5)}` +
      ` ${String(totWins).padStart(4)} ${String(totLoss).padStart(4)}` +
      ` ${(totWr.toFixed(1)+"%").padStart(6)}` +
      ` ${tfCol}${((totPnl>=0?"+":"")+totPnl.toFixed(1)+"%").padStart(8)}${RESET}` +
      ` ${tfCol}${((totProfit>=0?"+$":"-$")+Math.abs(totProfit).toFixed(2)).padStart(9)}${RESET}` +
      ` ${R}${(tfMaxDD.toFixed(1)+"%").padStart(8)}${RESET}` +
      ` ${Y}${String(tfMaxCons).padStart(8)}${RESET}`
    );

    // Equity simulacija
    console.log(`\n  💰 Equity simulacija (compound, $${START_BANK} start):`);
    console.log(`     Završna banka: ${tfCol}$${finalBank.toFixed(2)}${RESET}  (+${((finalBank-START_BANK)/START_BANK*100).toFixed(1)}%)`);
    console.log(`     Max Drawdown:  ${R}${tfMaxDD.toFixed(1)}%${RESET}`);
    console.log(`     Max cons. gubitaka: ${Y}${tfMaxCons}${RESET}`);
    console.log(`     Profit Factor: ${totPF===Infinity?"∞":totPF.toFixed(2)}`);

    // Win Rate vs Break-even
    const beWr = 1/(1+TP_PCT/SL_PCT)*100;
    const wrOk = totWr >= beWr;
    console.log(`     Win Rate: ${totWr.toFixed(1)}% vs break-even ${beWr.toFixed(1)}% → ${wrOk?G+"✅ PROFITABILAN"+RESET:R+"❌ GUBITAN"+RESET}`);
  }

  // Finale
  console.log(`\n\n${W}${"═".repeat(72)}${RESET}`);
  console.log(`  📋 LEGENDA`);
  console.log(`${"─".repeat(72)}`);
  console.log(`  TRAD = ukupno trejdova | WIN = TP pogođen | SL = stop loss pogođen`);
  console.log(`  P&L% = % početne banke ($${START_BANK}) | PROFIT = apsolutni $ dobitak`);
  console.log(`  MaxDD% = max drawdown od peaka (po simbolu) | MaxLoss = max uzastopnih SL-ova`);
  console.log(`  Compound equity = banka raste/pada s trejdovima (RISK_PCT% se računa na tekuću banku)`);
  console.log(`\n  💡 Formula: margin = banka × ${RISK_PCT}% | notional = margin × ${LEVERAGE}x`);
  console.log(`             SL hit: -$${(START_BANK*RISK_PCT/100).toFixed(2)} (${RISK_PCT}% banke)`);
  console.log(`             TP hit: +$${(START_BANK*RISK_PCT/100*TP_PCT/SL_PCT).toFixed(2)} (${(RISK_PCT*TP_PCT/SL_PCT).toFixed(1)}% banke)\n`);
}

main().catch(err => { console.error("GREŠKA:", err); process.exit(1); });
