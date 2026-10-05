// Test Supertrend modula (bot.js): izracun (naspram TradingViewa), odluka 1D/4H/1H, gradnja naloga.
// Bez mreze, bez trgovanja. DATA_DIR na temp dir da import bot.js nikad ne pise u repo (vidi CLAUDE.md).
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "st-test-"));

const { calcSupertrend, supertrendState, supertrendDecision, stBuildOrder,
        ST_RR, ST_SL_MIN_PCT, ST_SL_MAX_PCT, ST_RISK_PCT, stClosedTrades } = await import("../bot.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// ── 1) TradingView referenca: stvarne BTC 1H svijece, TV je pokazivao SILAZNI trend, linija 86612.62 ──
const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures/st-btc-1h.json"), "utf8"));
const candles = fx.candles.map(([time, open, high, low, close]) => ({ time, open, high, low, close }));
const st = calcSupertrend(candles);
const last = candles.length - 1;
ok(st.bull[last] === fx.expected.bull, `smjer zadnje svijece = ${st.bull[last] ? "uzlazno" : "silazno"} (TradingView: silazno)`);
ok(near(st.line[last], fx.expected.line, 0.005), `linija ${st.line[last].toFixed(2)} = TradingView ${fx.expected.line} (do centa)`);

// ── 2) zagrijavanje i ratchet ──
ok(st.bull.slice(0, 9).every(v => v === null) && st.bull[9] !== null, "prvih 9 svijeca bez vrijednosti (ATR 10 se zagrijava)");
// u silaznom trendu gornja linija nikad ne raste; u uzlaznom donja nikad ne pada (osim kod obrata)
let ratchetOk = true;
for (let i = 11; i < candles.length; i++) {
  if (st.bull[i] === st.bull[i - 1]) {
    if (st.bull[i] && st.line[i] < st.line[i - 1] - 1e-9) ratchetOk = false;
    if (!st.bull[i] && st.line[i] > st.line[i - 1] + 1e-9) ratchetOk = false;
  }
}
ok(ratchetOk, "ratchet: linija se u trendu pomice samo u smjeru trenda (299 svijeca)");

// ── 3) sinteticki: rast pa pad → obrat ──
const mk = (closes) => closes.map((c, i) => ({ time: i * 3600e3, open: i ? closes[i - 1] : c, high: Math.max(c, i ? closes[i - 1] : c) + 0.5, low: Math.min(c, i ? closes[i - 1] : c) - 0.5, close: c }));
const up = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
const down = Array.from({ length: 40 }, (_, i) => 178 - i * 3);
const s2 = calcSupertrend(mk([...up, ...down]));
ok(s2.bull[39] === true && s2.line[39] < up[39], "stalan rast → uzlazno, linija ispod cijene");
ok(s2.bull[79] === false && s2.line[79] > down[39], "nakon dugog pada → silazno, linija iznad cijene");
const flipAt = s2.bull.findIndex((b, i) => i > 40 && b === false);
ok(flipAt > 40 && flipAt < 70, `obrat se dogodi tijekom pada (svijeca ${flipAt})`);

// ── 4) supertrendState: obrat na zadnjoj ZATVORENOJ svijeci ──
const closedFlip = mk([...up, ...down.slice(0, flipAt - 40 + 1)]);
const stf = supertrendState(closedFlip);
ok(stf && stf.flipped === true && stf.bull === false, "supertrendState prepoznaje obrat na zadnjoj zatvorenoj svijeci");
const stn = supertrendState(closedFlip.slice(0, -2));
ok(stn && stn.flipped === false, "bez obrata prije obrata");
ok(supertrendState(mk([1, 2, 3])) === null, "premalo svijeca → null");

// ── 5) supertrendDecision ──
const NOW = Date.UTC(2026, 9, 5, 12, 5);                 // 12:05 UTC
const flipBarOpen = Date.UTC(2026, 9, 5, 11, 0);         // svijeca 11:00 zatvorena u 12:00 → 5 min staro
const S = (bull, flipped = false, time = flipBarOpen) => ({ bull, flipped, line: 100, time });
let d = supertrendDecision(S(true), S(true), S(true, true), NOW);
ok(d.signal === "LONG" && d.line === 100 && d.flipTs === flipBarOpen, "1D bull + 4H bull + 1H obrat u bull → LONG");
d = supertrendDecision(S(false), S(false), S(false, true), NOW);
ok(d.signal === "SHORT", "1D bear + 4H bear + 1H obrat u bear → SHORT");
d = supertrendDecision(S(true), S(false), S(true, true), NOW);
ok(d.signal === null && /usklađeni/.test(d.reason), "1D i 4H nisu usklađeni → nema ulaza");
d = supertrendDecision(S(true), S(true), S(true, false), NOW);
ok(d.signal === null && /nije obrnuo/.test(d.reason), "1H nije obrnuo (samo je u trendu) → nema ulaza (ne ulazimo usred trenda)");
d = supertrendDecision(S(true), S(true), S(false, true), NOW);
ok(d.signal === null && /protiv/.test(d.reason), "1H obrat PROTIV 1D/4H → nema ulaza");
d = supertrendDecision(S(true), S(true), S(true, true, Date.UTC(2026, 9, 5, 9, 0)), NOW);
ok(d.signal === null && /prozor/.test(d.reason), "obrat prije 3 sata (izvan prozora) → nema ulaza");
d = supertrendDecision(S(true), S(true), S(true, true, Date.UTC(2026, 9, 5, 11, 0)), Date.UTC(2026, 9, 5, 12, 24));
ok(d.signal === "LONG", "24 min nakon zatvaranja svijece je jos unutar prozora od 25 min");
d = supertrendDecision(S(true), S(true), S(true, true, Date.UTC(2026, 9, 5, 11, 0)), Date.UTC(2026, 9, 5, 12, 26));
ok(d.signal === null, "26 min nakon → izvan prozora");
ok(supertrendDecision(null, S(true), S(true, true), NOW).signal === null, "nedostaje stanje → nema ulaza");

// ── 6) stBuildOrder: SL = linija, TP = 3R, velicina iz rizika ──
let o = stBuildOrder({ signal: "LONG", price: 100, line: 98, equity: 570 });
ok(near(o.slPct, 2) && o.sl === 98 && near(o.tpPct, 6) && near(o.tp, 106), `LONG: SL 2% = linija, TP ${o.tpPct}% (R:R 1:${ST_RR}) @ ${o.tp}`);
ok(near(o.riskAmount, 570 * ST_RISK_PCT / 100) && near(o.tradeSize, o.riskAmount / 0.02), `veličina iz rizika: $${o.riskAmount.toFixed(2)} / 2% = $${o.tradeSize.toFixed(2)}`);
o = stBuildOrder({ signal: "SHORT", price: 100, line: 102.5, equity: 570 });
ok(near(o.slPct, 2.5) && near(o.tp, 100 * (1 - 0.075)) && o.sl === 102.5, "SHORT: SL iznad cijene = linija, TP ispod (3R)");
ok(near(stBuildOrder({ signal: "LONG", price: 100, line: 98, equity: 570, sizeMult: 0.5 }).tradeSize, 570 * 0.5 * ST_RISK_PCT / 100 / 0.02),
  "vikend/chill sizeMult 0.5 → pola rizika → pola pozicije");
ok(stBuildOrder({ signal: "LONG", price: 100, line: 100.5, equity: 570 }).skip, "LONG s linijom IZNAD cijene → preskoči (već prešla liniju)");
ok(stBuildOrder({ signal: "SHORT", price: 100, line: 99.5, equity: 570 }).skip, "SHORT s linijom ISPOD cijene → preskoči");
ok(/izvan/.test(stBuildOrder({ signal: "LONG", price: 100, line: 99.8, equity: 570 }).skip || ""), `SL ${(0.2).toFixed(1)}% < ${ST_SL_MIN_PCT}% → preskoči`);
ok(/izvan/.test(stBuildOrder({ signal: "LONG", price: 100, line: 94, equity: 570 }).skip || ""), `SL 6% > ${ST_SL_MAX_PCT}% → preskoči`);
ok(!stBuildOrder({ signal: "LONG", price: 100, line: 95.6, equity: 570 }).skip, "SL 4.4% (unutar raspona) prolazi");
ok(ST_SL_MIN_PCT === 0.8, "minimum SL-a je 0.8%");
ok(/izvan/.test(stBuildOrder({ signal: "LONG", price: 100, line: 99.3, equity: 570 }).skip || ""), "SL 0.7% (bio bi prošao uz staro 0.5%) → preskoči");
ok(/izvan/.test(stBuildOrder({ signal: "SHORT", price: 100, line: 100.53, equity: 570 }).skip || ""), "SL 0.53% (trade od 04.10.) → preskoči");
ok(!stBuildOrder({ signal: "LONG", price: 100, line: 99.1, equity: 570 }).skip, "SL 0.9% prolazi");
o = stBuildOrder({ signal: "LONG", price: 100, line: 98, equity: 50, minNotional: 40 });
ok(o.floored && o.tradeSize === 40, "premala pozicija → podignuta na minimum (floored=true)");
ok(stBuildOrder({ signal: "LONG", price: 0, line: 98, equity: 570 }).skip && stBuildOrder({ signal: "LONG", price: 100, line: 0, equity: 570 }).skip, "nevažeća cijena/linija → preskoči");

// ── 7) stClosedTrades: samo ST, grupirano po Order ID-u (djelomično zatvaranje = JEDAN trade) ──
const HDR = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net P&L,SL,TP,Order ID,Mode,Portfolio,Notes,SigMask,EntryMode,BTCRegime1H,BTCRegime4H,Night,Weekend,CandlePat";
const csvRow = (date, time, sym, side, price, net, id, notes, mode) =>
  [date, time, "BitGet", sym, side, 1, price, 100, 0.1, net, 0, 0, id, "LIVE", "synapse_t", '"' + notes + '"', "", mode, "", "", "", "", ""].join(",");
const csv = [HDR,
  csvRow("2026-10-04", "10:00:00", "BTCUSDT", "LONG", 85228.6, "OPEN", "A1", "ST open", "ST"),
  csvRow("2026-10-04", "22:00:00", "BTCUSDT", "CLOSE_LONG", 86584.4, 4.2, "A1", "WIN: Soft TP — bot izlaz | ST | Ulaz 85228.6 → Izlaz 86584.4", "ST"),
  csvRow("2026-10-05", "09:00:00", "ETHUSDT", "SHORT", 3000, "OPEN", "B1", "ST open", "ST"),
  csvRow("2026-10-05", "12:00:00", "ETHUSDT", "CLOSE_SHORT", 2950, 2.0, "B1", "WIN: Partial TP | ST | x", "ST"),
  csvRow("2026-10-05", "15:00:00", "ETHUSDT", "CLOSE_SHORT", 3040, -3.5, "B1", "LOSS: Soft SL — bot izlaz | ST | y", "ST"),
  csvRow("2026-10-05", "09:30:00", "SOLUSDT", "LONG", 150, "OPEN", "C1", "ST open", "ST"),
  csvRow("2026-10-05", "10:00:00", "XRPUSDT", "LONG", 2, "OPEN", "D1", "PBK open", "PBK"),
  csvRow("2026-10-05", "11:00:00", "XRPUSDT", "CLOSE_LONG", 2.1, 9.9, "D1", "WIN: TP | PBK | z", "PBK")].join("\n");
const tr = stClosedTrades(csv);
ok(tr.length === 2, "samo zatvoreni ST tradeovi (PBK ignoriran, otvoreni SOL ignoriran): " + tr.length);
ok(tr[0].symbol === "BTCUSDT" && tr[0].side === "LONG" && near(tr[0].net, 4.2) && tr[0].reason === "Soft TP — bot izlaz", "BTC: neto +4.2, razlog izvučen iz Notes");
ok(tr[1].symbol === "ETHUSDT" && near(tr[1].net, -1.5), "ETH: djelomično zatvaranje (+2.0) i ostatak (-3.5) = JEDAN trade, neto -1.5 (" + tr[1].net + ")");
ok(tr[1].exit === 3040 && tr[1].entry === 3000, "ETH: ulaz 3000, izlaz = zadnja noga 3040");
ok(stClosedTrades("").length === 0 && stClosedTrades(HDR).length === 0 && stClosedTrades(undefined).length === 0, "prazan/nepostojeći CSV → prazno, bez greške");

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
