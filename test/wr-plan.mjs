// Test ishoda trejda POBJEDA / NERIJEŠENO / PORAZ (bot.js: plannedProfit / plannedLoss / classifyOutcome / tradePlanOutcomes / stClosedTrades)
// — bez mreze, bez trgovanja.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wr-plan-test-"));
const { WR_TARGET_FRAC, WR_LOSS_FRAC, plannedProfit, plannedLoss, classifyOutcome, tradePlanOutcomes, stClosedTrades } = await import("../bot.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

ok(WR_TARGET_FRAC === 0.7 && WR_LOSS_FRAC === 0.7, "pragovi: pobjeda >= 70% planirane dobiti, poraz <= -70% planiranog gubitka");
// planirana dobit / gubitak = Total USD * |TP|SL - cijena| / cijena
ok(near(plannedProfit(100, 50, 55), 10), "LONG: 100 $ notional, ulaz 50, TP 55 -> planirana dobit 10 $");
ok(near(plannedProfit(100, 50, 45), 10), "SHORT: TP ispod ulaza -> isto 10 $ (apsolutna udaljenost)");
ok(near(plannedLoss(100, 50, 48), 4), "SL 48 -> planirani gubitak 4 $");
ok(plannedProfit(0, 50, 55) === null && plannedProfit(100, 0, 55) === null && plannedProfit(100, 50, 0) === null && plannedProfit("", "x", undefined) === null, "nepoznat/neispravan ulaz -> null");

// ishod (planirano 10 $ dobiti, 4 $ rizika): W >= 7, L <= -2.8, izmedju = N
const c = n => classifyOutcome(n, 10, 4);
ok(c(7.0) === "W" && c(12) === "W", "tocno 70% cilja i vise -> POBJEDA (W)");
ok(c(6.99) === "N" || c(6.99) === "D", "69.9% cilja -> nije pobjeda");
ok(c(0.03) === "D" && c(-0.5) === "D" && c(3) === "D" && c(-2.79) === "D", "blagi plus/minus (+0.03, -0.5, +3, -2.79) -> NERIJEŠENO (D)");
ok(c(-2.8) === "L" && c(-4) === "L" && c(-9) === "L", "gubitak >= 70% rizika (-2.8, -4, -9) -> PORAZ (L)");
ok(classifyOutcome(5, null, 4) === null && classifyOutcome(5, 10, null) === null && classifyOutcome(5, 0, 4) === null && classifyOutcome(NaN, 10, 4) === null, "nepoznat plan ili rizik -> null (ne ulazi u WR)");

// tradePlanOutcomes: ulazni redak daje plan (ORIGINALNI TP/SL), izlazne noge se zbrajaju po Order ID-u
const E = (id, usd, px, tp, sl) => ({ "Order ID": id, "Total USD": String(usd), Price: String(px), TP: String(tp), SL: String(sl), Side: "LONG" });
const X = (id, net, tp = "999", sl = "1") => ({ "Order ID": id, "Net P&L": String(net), TP: tp, SL: sl, Side: "CLOSE_LONG" });
const m = tradePlanOutcomes(
  [E("A", 100, 50, 55, 48), E("B", 100, 50, 55, 48), E("C", 100, 50, 55, 48), E("D", 100, 50, 55, 48), E("E", 100, 50, 55, 48), E("", 100, 50, 55, 48), { "Order ID": "F", "Total USD": "", Price: "", TP: "", SL: "" }, E("G", 100, 50, 55, 48), E("H", 100, 50, 55, "")],
  [X("A", 8), X("B", 0.03), X("C", -5), X("D", 4), X("D", 3.2), X("F", 5), X("ZZZ", 9), X("G", -1.5), X("H", 2)]);
ok(m.get("A").result === "W", "A: +8 od 10 planiranih -> W");
ok(m.get("B").result === "D", "B: +0.03 -> NERIJEŠENO (ne poraz i ne pobjeda; ovo je ono sto je prije kvarilo WR)");
ok(m.get("C").result === "L", "C: -5 uz rizik 4 $ -> L");
ok(m.get("D").result === "W" && near(m.get("D").net, 7.2) && m.get("D").legs === 2, "D: dvije izlazne noge 4 + 3.2 = 7.2 >= 7 -> W (partial close se zbraja)");
ok(m.get("E").result === null, "E: otvoren (nema izlaza) -> null");
ok(m.get("F").result === null, "F: izlaz postoji ali ulaz nema plan -> null");
ok(m.get("G").result === "D", "G: -1.5 uz rizik 4 $ (37%) -> NERIJEŠENO");
ok(m.get("H").result === null, "H: ulaz bez SL-a -> nepoznat rizik -> null");
ok(!m.has("ZZZ") && !m.has(""), "izlaz bez ulaza i prazan Order ID se ignoriraju");
// trail/BE pomice TP i SL u izlaznom retku: plan se NE racuna iz njih
ok(tradePlanOutcomes([E("T", 100, 50, 55, 48)], [X("T", 6, "70", "52")]).get("T").result === "D", "plan iz ORIGINALNOG TP/SL, ne iz izlaznog retka: +6 od 10 -> N");

// stClosedTrades nosi planned/risk/result (Supertrend stats)
const H = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net P&L,SL,TP,Order ID,Mode,Portfolio,Notes,SigMask,EntryMode";
const csv = [H,
  "2026-10-07,08:00:00,BitGet,ETHUSDT,LONG,1,50,100,0.1,OPEN,49,53,S1,LIVE,synapse_t,n,,ST",
  "2026-10-07,09:00:00,BitGet,ETHUSDT,CLOSE_LONG,1,52.5,100,0.1,2.4,49,53,S1,LIVE,synapse_t,\"WIN: Soft TP | ST\",,ST",
  "2026-10-07,10:00:00,BitGet,SOLUSDT,LONG,1,50,100,0.1,OPEN,49,53,S2,LIVE,synapse_t,n,,ST",
  "2026-10-07,11:00:00,BitGet,SOLUSDT,CLOSE_LONG,1,50.2,100,0.1,0.1,49,53,S2,LIVE,synapse_t,\"WIN: Soft SL | ST\",,ST",
  "2026-10-07,12:00:00,BitGet,XRPUSDT,LONG,1,50,100,0.1,OPEN,49,53,S3,LIVE,synapse_t,n,,ST",
  "2026-10-07,13:00:00,BitGet,XRPUSDT,CLOSE_LONG,1,52.6,100,0.1,4.5,49,53,S3,LIVE,synapse_t,\"WIN: Soft TP | ST\",,ST",
  "2026-10-07,14:00:00,BitGet,ADAUSDT,LONG,1,50,100,0.1,OPEN,49,53,S4,LIVE,synapse_t,n,,ST",
  "2026-10-07,15:00:00,BitGet,ADAUSDT,CLOSE_LONG,1,49,100,0.1,-1.9,49,53,S4,LIVE,synapse_t,\"LOSS: Soft SL | ST\",,ST",
].join("\n");
const st = stClosedTrades(csv);
ok(st.length === 4 && near(st[0].planned, 6) && near(st[0].risk, 2), "ST: planirana dobit 6 $ (100 × 3/50), rizik 2 $ (100 × 1/50)");
ok(st[0].result === "D" && near(st[0].net, 2.4), "ST: +2.4 od 6 (40%) -> N");
ok(st[1].result === "D", "ST: +0.1 -> N");
ok(st[2].result === "W", "ST: +4.5 od 6 (75%) -> W");
ok(st[3].result === "L", "ST: -1.9 uz rizik 2 $ (95%) -> L");


// ── Nalaz #35: ishod se dodjeljuje SAMO zatvorenom trejdu ───────────────────
// Prije se klasificiralo na `legs > 0`, pa je trejd dobio ishod vec nakon prve parcijalne
// noge dok je pozicija jos otvorena. Zavrsenost se mjeri zbrojem zatvorene kolicine.
{
  const entry = (id, qty, usd, price, tp, sl) => ({
    "Order ID": id, "Quantity": String(qty), "Total USD": String(usd),
    "Price": String(price), "TP": String(tp), "SL": String(sl),
  });
  const exit = (id, qty, net) => ({ "Order ID": id, "Quantity": String(qty), "Net P&L": String(net) });

  // plan: 100 USD notional, ulaz 100, TP 106 → planirana dobit 6; SL 98 → rizik 2
  const e = entry("A", 1, 100, 100, 106, 98);

  // 1) samo +1R noga (0.1 od 1 kom) uz sitnu dobit — pozicija JOS OTVORENA
  {
    const m = tradePlanOutcomes([e], [exit("A", 0.1, 1.0)]);
    const o = m.get("A");
    ok(o.result === null, `#35: parcijalno zatvoren trejd nema ishod (bio bi "D") — result=${o.result}`);
    ok(o.open === true, `#35: oznacen kao otvoren — open=${o.open}`);
  }

  // 2) sve noge zatvorene (0.1 + 0.9) i ukupno >= 70% plana → POBJEDA
  {
    const m = tradePlanOutcomes([e], [exit("A", 0.1, 1.0), exit("A", 0.9, 3.5)]);
    const o = m.get("A");
    ok(o.result === "W", `#35: zatvoren trejd s 4.5 od 6 (75%) → W — result=${o.result}`);
    ok(o.open === false, `#35: nije otvoren — open=${o.open}`);
  }

  // 3) zatvoren u jednoj nozi
  {
    const m = tradePlanOutcomes([e], [exit("A", 1, -1.8)]);
    ok(m.get("A").result === "L", `#35: jedna noga, -1.8 od rizika 2 (90%) → L — ${m.get("A").result}`);
  }

  // 4) stari redak bez kolicine na ULAZU → ponasa se kao prije (ne ispada iz WR-a)
  {
    const eNoQty = { ...e, "Quantity": "" };
    const m = tradePlanOutcomes([eNoQty], [exit("A", 0.1, 1.0)]);
    ok(m.get("A").result === "D", `#35: ulaz bez kolicine → klasificira se kao prije — ${m.get("A").result}`);
  }

  // 5) tolerancija na zaokruzivanje: 0.995 od 1 kom se racuna kao zatvoreno
  {
    const m = tradePlanOutcomes([e], [exit("A", 0.995, 4.5)]);
    ok(m.get("A").result === "W", `#35: 99.5% kolicine = zatvoreno (tolerancija) — ${m.get("A").result}`);
  }

  // 6) bez izlaza uopce → null, kao i prije
  {
    const m = tradePlanOutcomes([e], []);
    ok(m.get("A").result === null, "#35: bez izlaznih redaka → null");
  }
}

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
