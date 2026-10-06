// Test stropa novih ULTRA-4H ulaza PO SVIJECI (bot.js) — bez mreze, bez trgovanja.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "u4h-cap-test-"));
const { MAX_NEW_ENTRIES_PER_4H_CANDLE: CAP, u4hCandleEntries, u4hCandleEntryAdded, u4hCandleCapLogOnce,
        MAX_NEW_ENTRIES_PER_1H_CANDLE: CAP1, h1CandleEntries, h1CandleEntryAdded, h1CandleCapLogOnce, MAX_OPEN_1H } = await import("../bot.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const H = 3600e3, at = (d, h, m = 0) => Date.UTC(2026, 9, d, h, m);

ok(CAP === 2, "strop je 2 ulaza po 4H svijeci");
// 06.10. 08:00 svijeca: FET + ATOM u istom prolazu, VIRTUAL minutu kasnije (stvarni slucaj)
let pos = [];
ok(u4hCandleEntries(at(6, 8, 1), pos) === 0, "nova svijeca bez pozicija -> 0 ulaza");
u4hCandleEntryAdded(at(6, 8, 1), pos); pos.push({ symbol: "FETUSDT", openedAt: at(6, 8, 1) });
u4hCandleEntryAdded(at(6, 8, 1), pos); pos.push({ symbol: "ATOMUSDT", openedAt: at(6, 8, 1) });
ok(u4hCandleEntries(at(6, 8, 2), pos) >= CAP, "nakon FET+ATOM strop je dostignut -> VIRTUAL u iducem prolazu (08:02) je blokiran");
ok(u4hCandleEntries(at(6, 11, 59), pos) >= CAP, "blokirano do kraja svijece (11:59)");
ok(u4hCandleEntries(at(6, 12, 0), pos) === 0, "nova svijeca (12:00) -> brojac se vraca na 0 (pozicije iz 08:00 ne racunaju)");
// ulaz zatvoren unutar svijece i dalje se broji (brojac je u memoriji, ne ovisi o otvorenim pozicijama)
u4hCandleEntryAdded(at(6, 12, 1), []); u4hCandleEntryAdded(at(6, 12, 2), []);
ok(u4hCandleEntries(at(6, 12, 30), []) === 2, "dva ulaza u svijeci koja su vec zatvorena i dalje se broje (2)");
// restart usred svijece: brojac krece od pozicija otvorenih u ovoj svijeci (openedAt kao broj I kao ISO string)
const bucketStart = at(6, 16);
const restartPos = [{ openedAt: bucketStart + 5 * 60e3 }, { openedAt: new Date(bucketStart + 6 * 60e3).toISOString() }, { openedAt: bucketStart - 2 * H }];
ok(u4hCandleEntries(at(6, 17), restartPos) === 2, "nakon restarta: 2 pozicije otvorene u ovoj svijeci (broj + ISO), jedna iz stare se ne broji");
// degenerirano: bez pozicija / losi openedAt nikad ne baca
ok(u4hCandleEntries(at(7, 0), undefined) === 0 && u4hCandleEntries(at(7, 4), [{}, { openedAt: "x" }, { openedAt: null }]) === 0, "undefined / neispravan openedAt -> 0, bez greske");
// log samo jednom po svijeci
u4hCandleEntries(at(8, 0), []);
ok(u4hCandleCapLogOnce() === true && u4hCandleCapLogOnce() === false, "poruka o stropu ispisuje se jednom po svijeci");
u4hCandleEntries(at(8, 4), []);
ok(u4hCandleCapLogOnce() === true, "u iducoj svijeci opet moze jednom");

// ── 1H (06.10., MAX_OPEN_1H 3 -> 5 + strop 2 po 1H svijeci) ──
ok(MAX_OPEN_1H === 5 && CAP1 === 2, "1H: max 5 otvorenih, strop 2 ulaza po 1H svijeci");
{
  let p1 = [];
  ok(h1CandleEntries(at(9, 10, 1), p1) === 0, "1H: nova svijeca -> 0");
  h1CandleEntryAdded(at(9, 10, 1), p1); p1.push({ openedAt: at(9, 10, 1) });
  ok(h1CandleEntries(at(9, 10, 16), p1) === 1, "1H: scan nakon 15 min unutar iste svijece i dalje vidi 1 ulaz (per-scan brojac bi se vratio na 0)");
  h1CandleEntryAdded(at(9, 10, 16), p1); p1.push({ openedAt: at(9, 10, 16) });
  ok(h1CandleEntries(at(9, 10, 46), p1) >= CAP1, "1H: drugi ulaz u 10:16 -> u 10:46 strop dostignut (treci ulaz blokiran)");
  ok(h1CandleEntries(at(9, 11, 0), p1) === 0, "1H: nova svijeca (11:00) -> brojac na 0");
  // 1H i 4H brojaci su NEOVISNI
  u4hCandleEntries(at(9, 8, 5), []); u4hCandleEntryAdded(at(9, 8, 5), []); u4hCandleEntryAdded(at(9, 8, 6), []);
  ok(u4hCandleEntries(at(9, 8, 10), []) === 2 && h1CandleEntries(at(9, 8, 10), []) === 0, "1H i 4H brojaci su neovisni (2 4H ulaza ne blokiraju 1H)");
  // restart usred 1H svijece: otvorene pozicije iz ove svijece (broj + ISO), stara se ne broji
  const bs = at(9, 14);
  ok(h1CandleEntries(at(9, 14, 20), [{ openedAt: bs + 60e3 }, { openedAt: new Date(bs + 120e3).toISOString() }, { openedAt: bs - 30 * 60e3 }]) === 2, "1H nakon restarta: 2 iz ove svijece, 1 iz stare se ne broji");
  h1CandleEntries(at(10, 3), []);
  ok(h1CandleCapLogOnce() === true && h1CandleCapLogOnce() === false, "1H: poruka jednom po svijeci");
}

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
