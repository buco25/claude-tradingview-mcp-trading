// Test: SL/TP se ne pomicu dok cijena nije presla TRAIL_ARM_TP_PCT % puta do TP-a (bot.js) — bez mreze, bez trgovanja.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "trailarm-test-"));
const { applyTrailForTest: apply, TRAIL_ARM_TP_PCT, BE_STOP_ENABLED, PARTIAL_1R_ENABLED } = await import("../bot.js");
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const mk = (side) => side === "LONG"
  ? { symbol: "TESTUSDT", strategy: "ultra_4h", side, entryPrice: 100, sl: 98.5, tp: 103.75, slPct: 1.5, tpPct: 3.75, quantity: 10, margin: 40 }
  : { symbol: "TESTUSDT", strategy: "ultra_4h", side, entryPrice: 100, sl: 101.5, tp: 96.25, slPct: 1.5, tpPct: 3.75, quantity: 10, margin: 40 };
const px = (side, gainPct) => side === "LONG" ? 100 * (1 + gainPct / 100) : 100 * (1 - gainPct / 100);

ok(TRAIL_ARM_TP_PCT === 95, "prag aktivacije je 95% puta do TP-a");
ok(BE_STOP_ENABLED === false && PARTIAL_1R_ENABLED === false, "BE-stop i partial +1R su iskljuceni");

for (const side of ["LONG", "SHORT"]) {
  const p = mk(side), sl0 = p.sl, tp0 = p.tp;
  // 1R, 30% ROE, 70% TP, 90% TP: nista se ne smije pomaknuti
  for (const g of [0.5, 1.5, 2.0, 2.6, 3.0, 3.37]) {
    const moved = apply(p, px(side, g));
    ok(moved === false && p.sl === sl0 && p.tp === tp0 && !p.trailArmed, `${side} +${g}% (${(g / 3.75 * 100).toFixed(0)}% TP) -> SL/TP netaknuti`);
  }
  // 96% TP: aktivira trail
  const moved = apply(p, px(side, 3.6));
  ok(moved === true && p.trailArmed === true, `${side} 96% TP -> trail armiran i spremljen`);
  ok(side === "LONG" ? p.sl > sl0 : p.sl < sl0, `${side} SL pomaknut prema profitu`);
  ok(side === "LONG" ? p.tp > tp0 : p.tp < tp0, `${side} TP produzen`);
  // povlacenje ispod 95%: ostaje armiran, SL se ne vraca unazad
  const slAfter = p.sl;
  apply(p, px(side, 2.0));
  ok(p.trailArmed === true && (side === "LONG" ? p.sl >= slAfter : p.sl <= slAfter), `${side} povlacenje -> trail ostaje armiran, SL se ne popusta`);
}
// pozicija koju je stari kod vec stavio u trail ostaje armirana
const old = mk("LONG"); old.trailPeak = 103;
apply(old, 102.5);
ok(old.sl > 98.5, "vec postojeci trail (trailPeak) nastavlja raditi");
// strategija bez trail podrske
const other = { ...mk("LONG"), strategy: "nesto_drugo" };
ok(apply(other, 103.7) === false && !other.trailArmed, "strategija izvan TRAIL_STRATEGIES -> bez promjene");

console.log(fail ? `\n${fail} FAIL` : "\nSVE OK");
process.exit(fail ? 1 : 0);
