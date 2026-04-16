/**
 * Backtest: Order Block / One Candle Strategy
 *
 * Strategija iz videa:
 * - Uptrend: bearish (down-close) svjeće = support (OB za LONG)
 * - Downtrend: bullish (up-close) svjeće = resistance (OB za SHORT)
 * - Trguje se samo na otvaranju 3 sesije:
 *     Korea/Asia  = 00:00 UTC
 *     London      = 07:00 UTC
 *     New York    = 14:00 UTC
 * - Entry: cijena retestira OB body zonu
 * - SL: ispod OB low (long) / iznad OB high (short)
 * - TP: 1:2 R:R
 */

const CFG = {
  portfolio:    1000,
  riskPct:      1.5,
  maxMargin:    250,
  leverage:     5,
  rrRatio:      2.0,
  sessionHours: [9, 15],       // CRO: London 09:00, New York 15:00 (CEST=UTC+2)
  emaTrendLen:  21,
  ema2Len:      50,
  obLookback:   10,
  entryWindow:  3,
};

function calcEMA(closes, p) {
  if (closes.length < p) return null;
  const k = 2 / (p + 1);
  let v = closes.slice(0, p).reduce((a, b) => a + b) / p;
  for (let i = p; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

function getTrend(candles) {
  const closes = candles.map(c => c.close);
  const e21 = calcEMA(closes, CFG.emaTrendLen);
  const e50 = calcEMA(closes, CFG.ema2Len);
  if (!e21 || !e50) return "NEUTRAL";
  const price = closes[closes.length - 1];
  if (price > e21 && e21 > e50) return "UP";
  if (price < e21 && e21 < e50) return "DOWN";
  return "NEUTRAL";
}

function findOB(candles, trend) {
  const lb = Math.min(CFG.obLookback, candles.length - 2);
  for (let i = candles.length - 1; i >= candles.length - lb; i--) {
    const c = candles[i];
    const later = candles.slice(i + 1);
    if (!later.length) continue;

    if (trend === "UP" && c.close < c.open) {
      // Bearish svjeća u uptrend — OB za LONG
      // Mora biti "potvrđena": cijena je u međuvremenu prešla iznad nje
      if (later.some(l => l.high > c.high)) {
        return { high: c.high, low: c.low, bodyTop: c.open, bodyBot: c.close, type: "BULL" };
      }
    }
    if (trend === "DOWN" && c.close > c.open) {
      // Bullish svjeća u downtrend — OB za SHORT
      if (later.some(l => l.low < c.low)) {
        return { high: c.high, low: c.low, bodyTop: c.close, bodyBot: c.open, type: "BEAR" };
      }
    }
  }
  return null;
}

function getSession(hour) {
  if (hour === 9)  return "London";
  if (hour === 15) return "New York";
  return null;
}

async function run() {
  const res = await fetch(
    "https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=1000"
  );
  const d = await res.json();
  const all = d.data.map(k => {
    const ts   = parseInt(k[0]);
    const d2   = new Date(ts);
    const mon  = d2.getUTCMonth() + 1;
    const day  = d2.getUTCDate();
    const isDST = (mon > 3 && mon < 10) || (mon === 3 && day >= 25) || (mon === 10 && day < 25);
    const croOff = isDST ? 2 : 1;
    return {
      time:  ts,
      open:  parseFloat(k[1]),
      high:  parseFloat(k[2]),
      low:   parseFloat(k[3]),
      close: parseFloat(k[4]),
      hour:  (d2.getUTCHours() + croOff) % 24,  // Hrvatsko vrijeme
    };
  });

  const minLB = CFG.ema2Len + 5;
  let equity = CFG.portfolio;
  const trades = [];
  let openTrade    = null;
  let pendingSetup = null;
  let entryCandle  = -1;

  for (let i = minLB; i < all.length; i++) {
    const c     = all[i];
    const slice = all.slice(0, i + 1);

    // ── Provjeri otvoreni trade ──────────────────────────────────────────────
    if (openTrade) {
      const { side, sl, tp, entryPrice, qty, margin } = openTrade;
      let closed = false;
      if (side === "LONG") {
        if (c.high >= tp)     { closed = true; openTrade.exitPrice = tp;  openTrade.reason = "TP"; }
        else if (c.low <= sl) { closed = true; openTrade.exitPrice = sl;  openTrade.reason = "SL"; }
      } else {
        if (c.low <= tp)      { closed = true; openTrade.exitPrice = tp;  openTrade.reason = "TP"; }
        else if (c.high >= sl){ closed = true; openTrade.exitPrice = sl;  openTrade.reason = "SL"; }
      }
      if (closed) {
        const pnl = side === "LONG"
          ? (openTrade.exitPrice - entryPrice) * qty
          : (entryPrice - openTrade.exitPrice) * qty;
        const net = pnl - margin * 0.001;
        equity += net;
        trades.push({
          ...openTrade,
          pnl: net, equity,
          exitDate: new Date(c.time).toISOString().slice(0, 10),
        });
        openTrade    = null;
        pendingSetup = null;
      }
      if (openTrade) continue;
    }

    // ── Session open — tražimo setup ─────────────────────────────────────────
    if (CFG.sessionHours.includes(c.hour) && !pendingSetup) {
      const trend = getTrend(slice);
      if (trend !== "NEUTRAL") {
        const ob = findOB(slice, trend);
        if (ob) {
          pendingSetup = { ob, trend, session: getSession(c.hour) };
          entryCandle  = i;
        }
      }
    }

    // ── Čekaj retest OB zone (unutar entryWindow svjeća) ────────────────────
    if (pendingSetup && !openTrade && i > entryCandle && i <= entryCandle + CFG.entryWindow) {
      const { ob, trend, session } = pendingSetup;

      if (trend === "UP") {
        // Long: low svjeće dira OB body zonu
        if (c.low <= ob.bodyTop && c.high >= ob.bodyBot) {
          const entryPrice = ob.bodyTop;
          const sl         = ob.low;
          const tp         = entryPrice + CFG.rrRatio * (entryPrice - sl);
          const slDist     = Math.max(entryPrice - sl, 1e-8);
          const riskAmt    = equity * (CFG.riskPct / 100);
          const notional   = Math.min((riskAmt / slDist) * entryPrice, CFG.maxMargin * CFG.leverage);
          const qty        = notional / entryPrice;
          const margin     = notional / CFG.leverage;
          openTrade = {
            side: "LONG", entryPrice, sl, tp, qty, notional, margin,
            entryTime: c.time,
            entryDate: new Date(c.time).toISOString().slice(0, 10),
            session,
          };
          pendingSetup = null;
        }
      } else if (trend === "DOWN") {
        // Short: high svjeće dira OB body zonu
        if (c.high >= ob.bodyBot && c.low <= ob.bodyTop) {
          const entryPrice = ob.bodyBot;
          const sl         = ob.high;
          const tp         = entryPrice - CFG.rrRatio * (sl - entryPrice);
          const slDist     = Math.max(sl - entryPrice, 1e-8);
          const riskAmt    = equity * (CFG.riskPct / 100);
          const notional   = Math.min((riskAmt / slDist) * entryPrice, CFG.maxMargin * CFG.leverage);
          const qty        = notional / entryPrice;
          const margin     = notional / CFG.leverage;
          openTrade = {
            side: "SHORT", entryPrice, sl, tp, qty, notional, margin,
            entryTime: c.time,
            entryDate: new Date(c.time).toISOString().slice(0, 10),
            session,
          };
          pendingSetup = null;
        }
      }
    } else if (pendingSetup && i > entryCandle + CFG.entryWindow) {
      pendingSetup = null; // entry window istekao
    }
  }

  // ── Statistika ───────────────────────────────────────────────────────────────
  const wins      = trades.filter(t => t.pnl >= 0);
  const losses    = trades.filter(t => t.pnl < 0);
  const gw        = wins.reduce((s, t) => s + t.pnl, 0);
  const gl        = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);

  let peak = CFG.portfolio, maxDD = 0, eq = CFG.portfolio;
  for (const t of trades) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Po sesiji
  const bySess = {};
  for (const t of trades) {
    if (!bySess[t.session]) bySess[t.session] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl >= 0) bySess[t.session].wins++; else bySess[t.session].losses++;
    bySess[t.session].pnl += t.pnl;
  }

  const startDate = new Date(all[minLB].time).toISOString().slice(0, 10);
  const endDate   = new Date(all[all.length - 1].time).toISOString().slice(0, 10);

  const pf = gl > 0 ? (gw / gl).toFixed(2) : wins.length > 0 ? "∞" : "0";
  const wr = trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0";

  console.log("\n" + "═".repeat(68));
  console.log("  BTCUSDT — Order Block / One Candle Strategy (1H)");
  console.log("  London (09:00 CRO) · New York (15:00 CRO)  |  CEST=UTC+2");
  console.log("═".repeat(68));
  console.log(`\n  📅 Period:          ${startDate} → ${endDate}`);
  console.log("  💰 Početni kapital: $1.000  |  Rizik: 1.5%/trade  |  5x leverage");
  console.log("  📐 R:R: 1:2  |  Entry: OB body  |  SL: OB low/high\n");
  console.log("─".repeat(68));
  console.log("  UKUPNI REZULTATI");
  console.log("─".repeat(68));
  console.log(`  Ukupno tradova:    ${trades.length}`);
  console.log(`  ✅ Wins:           ${wins.length} (${wr}%)`);
  console.log(`  ❌ Losses:         ${losses.length}`);
  console.log(`  📈 Profit Factor:  ${pf}`);
  console.log(`  💵 Ukupni P&L:     ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (${(totalPnl / CFG.portfolio * 100).toFixed(1)}%)`);
  console.log(`  💼 Završni kapital:$${(CFG.portfolio + totalPnl).toFixed(2)}`);
  console.log(`  📉 Max Drawdown:   ${maxDD.toFixed(1)}%\n`);

  console.log("─".repeat(68));
  console.log("  PO SESIJI");
  console.log("─".repeat(68));
  for (const [sess, s] of Object.entries(bySess)) {
    const tot = s.wins + s.losses;
    const sessWR  = (s.wins / tot * 100).toFixed(0);
    const sessGL  = trades.filter(t => t.session === sess && t.pnl < 0).reduce((a, t) => a + Math.abs(t.pnl), 0);
    const sessGW  = trades.filter(t => t.session === sess && t.pnl >= 0).reduce((a, t) => a + t.pnl, 0);
    const sessPF  = sessGL > 0 ? (sessGW / sessGL).toFixed(2) : "∞";
    console.log(`  ${sess.padEnd(14)} W:${String(s.wins).padEnd(3)} L:${String(s.losses).padEnd(3)} WR:${sessWR.padEnd(4)}% PF:${sessPF.padEnd(6)} P&L:${(s.pnl >= 0 ? "+" : "")}$${s.pnl.toFixed(2)}`);
  }

  console.log("\n" + "─".repeat(68));
  console.log("  LISTA SVIH TRADOVA");
  console.log("─".repeat(68));
  console.log("  #   Datum       Sesija          Smjer  Ulaz      Izlaz(razlog)     P&L       Kapital");
  console.log("  " + "─".repeat(64));
  trades.forEach((t, i) => {
    const icon   = t.pnl >= 0 ? "✅" : "❌";
    const pnlStr = (t.pnl >= 0 ? "+$" : "-$") + Math.abs(t.pnl).toFixed(2);
    console.log(
      `  ${icon} ${String(i + 1).padEnd(3)} ${t.entryDate.padEnd(12)}` +
      `${(t.session || "?").padEnd(16)}${t.side.padEnd(7)}` +
      `${t.entryPrice.toFixed(0).padEnd(10)}` +
      `${(t.exitPrice.toFixed(0) + "(" + t.reason + ")").padEnd(18)}` +
      `${pnlStr.padEnd(10)}$${t.equity.toFixed(2)}`
    );
  });
  console.log("═".repeat(68) + "\n");
}

run().catch(console.error);
