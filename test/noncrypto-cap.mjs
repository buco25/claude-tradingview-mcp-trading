// Test zajednickog stropa dionica+metala (bot.js, MAX_OPEN_NONCRYPTO) — bez mreze, bez trgovanja.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "noncrypto-test-"));
const { MAX_OPEN_NONCRYPTO, nonCryptoCapBlocks, isStockSym, isMetalSym } = await import("../bot.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const P = (...syms) => syms.map(symbol => ({ symbol }));

ok(MAX_OPEN_NONCRYPTO === 1, "strop je 1 (dionica ILI metal)");
ok(isStockSym("TSLAUSDT") && isMetalSym("XAUUSDT") && !isStockSym("XAUUSDT") && !isMetalSym("BTCUSDT"), "klasifikacija: TSLA dionica, XAU metal (NIJE dionica), BTC ni jedno");
ok(nonCryptoCapBlocks("TSLAUSDT", []) === false, "nema otvorenih -> prva dionica smije");
ok(nonCryptoCapBlocks("XAUUSDT", []) === false, "nema otvorenih -> prvi metal smije");
ok(nonCryptoCapBlocks("NVDAUSDT", P("TSLAUSDT")) === true, "1 dionica otvorena -> druga dionica blokirana");
ok(nonCryptoCapBlocks("XAUUSDT", P("TSLAUSDT")) === true, "1 dionica otvorena -> metal blokiran (ZAJEDNICKI strop)");
ok(nonCryptoCapBlocks("TSLAUSDT", P("XAGUSDT")) === true, "1 metal otvoren -> dionica blokirana");
ok(nonCryptoCapBlocks("XAUUSDT", P("PAXGUSDT")) === true, "1 metal otvoren -> drugi metal blokiran");
ok(nonCryptoCapBlocks("BTCUSDT", P("TSLAUSDT")) === false && nonCryptoCapBlocks("SOLUSDT", P("XAUUSDT", "TSLAUSDT")) === false, "kripto nikad ne pada na ovaj strop");
ok(nonCryptoCapBlocks("TSLAUSDT", P("BTCUSDT", "ETHUSDT", "SOLUSDT")) === false, "otvorena samo kripto -> dionica smije (kripto se ne racuna)");
ok(nonCryptoCapBlocks("TSLAUSDT", P("TSLAUSDT")) === false, "ista pozicija (pyramid) nije novi slot");
ok(nonCryptoCapBlocks("TSLAUSDT", undefined) === false && nonCryptoCapBlocks("TSLAUSDT", null) === false, "undefined/null -> bez greske");

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
