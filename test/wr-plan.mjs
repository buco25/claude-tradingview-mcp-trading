// Test WR po 70% planirane dobiti (bot.js: plannedProfit / reachedPlan / tradePlanOutcomes / stClosedTrades) — bez mreze, bez trgovanja.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wr-plan-test-"));
const { WR_TARGET_FRAC, plannedProfit, reachedPlan, tradePlanOutcomes, stClosedTrades } = await import("../bot.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

ok(WR_TARGET_FRAC === 0.7, "prag je 70% planirane dobiti");
// planirana dobit = Total USD * |TP - cijena| / cijena
ok(near(plannedProfit(100, 50, 55), 10), "LONG: 100 $ notional, ulaz 50, TP 55 -> planirano 10 $");
ok(near(plannedProfit(100, 50, 45), 10), "SHORT: TP ispod ulaza -> isto 10 $ (apsolutna udaljenost)");
ok(plannedProfit(0, 50, 55) === null && plannedProfit(100, 0, 55) === null && plannedProfit(100, 50, 0) === null && plannedProfit("", "x", undefined) === null, "nepoznat/neispravan ulaz -> null");
// pobjeda tek na >= 70%
ok(reachedPlan(7.0, 10) === true, "tocno 70% -> pobjeda");
ok(reachedPlan(6.99, 10) === false, "69.9% -> NIJE pobjeda");
ok(reachedPlan(0.03, 10) === false, "izlaz na +0.03 $ (scratch) -> NIJE pobjeda");
ok(reachedPlan(-4, 10) === false, "gubitak -> nije pobjeda");
ok(reachedPlan(12, 10) === true, "iznad cilja -> pobjeda");
ok(reachedPlan(5, null) === null && reachedPlan(5, 0) === null && reachedPlan(NaN, 10) === null, "nepoznata planirana dobit -> null (ne ulazi u WR)");

// tradePlanOutcomes: ulazni redak daje plan (ORIGINALNI TP), izlazne noge se zbrajaju po Order ID-u
const E = (id, usd, px, tp) => ({ "Order ID": id, "Total USD": String(usd), Price: String(px), TP: String(tp), Side: "LONG" });
const X = (id, net, tp = "999") => ({ "Order ID": id, "Net P&L": String(net), TP: tp, Side: "CLOSE_LONG" });
const m = tradePlanOutcomes(
  [E("A", 100, 50, 55), E("B", 100, 50, 55), E("C", 100, 50, 55), E("D", 100, 50, 55), E("E", 100, 50, 55), E("", 100, 50, 55), { "Order ID": "F", "Total USD": "", Price: "", TP: "" }],
  [X("A", 8), X("B", 0.03), X("C", -5), X("D", 4), X("D", 3.2), X("F", 5), X("ZZZ", 9)]);
ok(m.get("A").hit === true, "A: +8 od 10 planiranih -> pobjeda");
ok(m.get("B").hit === false, "B: +0.03 -> nije pobjeda (ovo je ono sto je prije kvarilo WR)");
ok(m.get("C").hit === false, "C: gubitak -> nije pobjeda");
ok(m.get("D").hit === true && near(m.get("D").net, 7.2) && m.get("D").legs === 2, "D: dvije izlazne noge 4 + 3.2 = 7.2 >= 7 -> pobjeda (partial close se zbraja)");
ok(m.get("E").hit === null, "E: otvoren (nema izlaza) -> null");
ok(m.get("F").hit === null, "F: izlaz postoji ali ulaz nema cilj -> null");
ok(!m.has("ZZZ") && !m.has(""), "izlaz bez ulaza i prazan Order ID se ignoriraju");
// trail pomice TP u izlaznom retku: plan se NE racuna iz njega
ok(tradePlanOutcomes([E("T", 100, 50, 55)], [X("T", 6, "70")]).get("T").hit === false, "plan iz ORIGINALNOG TP-a (55), ne iz izlaznog retka (trail 70): +6 od 10 -> nije pobjeda");

// stClosedTrades nosi planned/hit (Supertrend stats)
const H = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net P&L,SL,TP,Order ID,Mode,Portfolio,Notes,SigMask,EntryMode";
const csv = [H,
  "2026-10-07,08:00:00,BitGet,ETHUSDT,LONG,1,50,100,0.1,OPEN,49,53,S1,LIVE,synapse_t,n,,ST",
  "2026-10-07,09:00:00,BitGet,ETHUSDT,CLOSE_LONG,1,52.5,100,0.1,2.4,49,53,S1,LIVE,synapse_t,\"WIN: Soft TP | ST\",,ST",
  "2026-10-07,10:00:00,BitGet,SOLUSDT,LONG,1,50,100,0.1,OPEN,49,53,S2,LIVE,synapse_t,n,,ST",
  "2026-10-07,11:00:00,BitGet,SOLUSDT,CLOSE_LONG,1,50.2,100,0.1,0.1,49,53,S2,LIVE,synapse_t,\"WIN: Soft SL | ST\",,ST",
  "2026-10-07,12:00:00,BitGet,XRPUSDT,LONG,1,50,100,0.1,OPEN,49,53,S3,LIVE,synapse_t,n,,ST",
  "2026-10-07,13:00:00,BitGet,XRPUSDT,CLOSE_LONG,1,52.6,100,0.1,4.5,49,53,S3,LIVE,synapse_t,\"WIN: Soft TP | ST\",,ST",

].join("\n");
const st = stClosedTrades(csv);
ok(st.length === 3 && near(st[0].planned, 6), "ST: planirana dobit 6 $ (100 $ × 3/50)");
ok(st[0].hit === false && near(st[0].net, 2.4), "ST: +2.4 od 6 (40%) -> nije pobjeda");
ok(st[1].hit === false, "ST: +0.1 -> nije pobjeda");
ok(st[2].hit === true, "ST: +4.5 od 6 (75%) -> pobjeda");

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
