// Test Supertrend modula (bot.js): izracun (naspram TradingViewa), odluka 1D/4H/1H, gradnja naloga.
// Bez mreze, bez trgovanja. DATA_DIR na temp dir da import bot.js nikad ne pise u repo (vidi CLAUDE.md).
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "st-test-"));

const { calcSupertrend, supertrendState, supertrendDecision, stBuildOrder,
        ST_RR, ST_SL_MIN_PCT, ST_SL_MAX_PCT, ST_RISK_PCT } = await import("../bot.js");

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
o = stBuildOrder({ signal: "LONG", price: 100, line: 98, equity: 50, minNotional: 40 });
ok(o.floored && o.tradeSize === 40, "premala pozicija → podignuta na minimum (floored=true)");
ok(stBuildOrder({ signal: "LONG", price: 0, line: 98, equity: 570 }).skip && stBuildOrder({ signal: "LONG", price: 100, line: 0, equity: 570 }).skip, "nevažeća cijena/linija → preskoči");

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
