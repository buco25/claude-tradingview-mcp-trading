// Watchlista je samo kripto (07./09.10., odluka vlasnika: dionice i metali maknuti nakon gubitaka) — bez mreze, bez trgovanja.
import { readFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "watchlist-test-"));
const { isStockSym, isMetalSym } = await import("../bot.js");
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const wl = JSON.parse(readFileSync("rules.json", "utf8")).watchlist_synapse_t;
ok(Array.isArray(wl) && wl.length === 23, "watchlista ima 23 simbola (" + wl?.length + ")");
ok(new Set(wl).size === wl.length, "nema duplikata");
ok(wl.every(s => !isStockSym(s) && !isMetalSym(s)), "nijedna dionica ni metal na watchlisti: " + wl.filter(s => isStockSym(s) || isMetalSym(s)).join(","));
ok(wl.includes("BTCUSDT") && wl.includes("ETHUSDT"), "BTC i ETH su na watchlisti");
ok(wl.every(s => /^[A-Z0-9]+USDT$/.test(s)), "svi simboli su USDT perpetuali");
console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
