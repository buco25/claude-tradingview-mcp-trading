// Test pravila "bez SHORT ulaza dok je BTC 4H BULL" (bot.js: shortBlockedByBtcBull) — bez mreze, bez trgovanja.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "nobullshort-test-"));
const { shortBlockedByBtcBull } = await import("../bot.js");
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
ok(shortBlockedByBtcBull("SHORT", "BULL") === true, "SHORT + BTC 4H BULL -> blokiran");
ok(shortBlockedByBtcBull("LONG", "BULL") === false, "LONG + BULL -> dopusten");
ok(shortBlockedByBtcBull("SHORT", "BEAR") === false, "SHORT + BEAR -> dopusten");
ok(shortBlockedByBtcBull("SHORT", "NEUTRAL") === false, "SHORT + NEUTRAL -> dopusten (blokada samo u BULL)");
ok(shortBlockedByBtcBull("LONG", "BEAR") === false, "LONG + BEAR -> NIJE dodano novo pravilo (u bearu LONG i SHORT daju isto)");
ok(shortBlockedByBtcBull("SHORT", "UNKNOWN") === false && shortBlockedByBtcBull("SHORT", undefined) === false, "nepoznat/undefined regime -> ne blokira (isto kao postojeci 4H gate)");
ok(shortBlockedByBtcBull("NEUTRAL", "BULL") === false && shortBlockedByBtcBull(undefined, "BULL") === false, "bez signala -> false");
console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
