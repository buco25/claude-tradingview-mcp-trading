// Test zdravlja Bitget autentikacije za vanjski nadzor (bot.js: bitgetAuthHealth) — bez mreze, bez trgovanja.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "authhealth-test-"));
const { bitgetAuthHealth } = await import("../bot.js");
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const MIN = 60 * 1000, T0 = 1e12;
const mk = (over = {}) => ({ now: T0, paper: false, startedAt: T0 - 60 * MIN, maxAgeMs: 10 * MIN, memoMs: 60 * 1000, memo: { ts: 0, res: null }, fetchEquity: async () => {}, getLastOkTs: () => T0 - 2 * MIN, ...over });

ok((await bitgetAuthHealth(mk({ paper: true }))).ok === true, "PAPER mod je uvijek OK (nema stvarnog Bitget poziva)");
ok((await bitgetAuthHealth(mk())).ok === true, "zadnji uspjeh prije 2 min -> OK");
ok((await bitgetAuthHealth(mk({ getLastOkTs: () => T0 - 9 * MIN }))).ok === true, "zadnji uspjeh prije 9 min -> jos OK (kratki zastoj ne diže alarm)");
const stale = await bitgetAuthHealth(mk({ getLastOkTs: () => T0 - 11 * MIN }));
ok(stale.ok === false && stale.reason === "stale", "zadnji uspjeh prije 11 min -> NEUSPJEH (pad kljuca se vidi)");
ok((await bitgetAuthHealth(mk({ getLastOkTs: () => 0 }))).ok === false, "nikad uspjeha i proces stariji od 10 min -> NEUSPJEH");
const starting = await bitgetAuthHealth(mk({ getLastOkTs: () => 0, startedAt: T0 - 3 * MIN }));
ok(starting.ok === true && starting.reason === "starting", "tek pokrenut proces bez uspjeha -> 'starting' (OK 10 min)");

// poziva svjez potpisani poziv i uzima u obzir njegov uspjeh
let last = T0 - 30 * MIN, called = 0;
const fresh = await bitgetAuthHealth(mk({ fetchEquity: async () => { called++; last = T0; }, getLastOkTs: () => last }));
ok(called === 1 && fresh.ok === true, "poziva svjez dohvat stanja; ako uspije, OK");
const memo = { ts: 0, res: null }; called = 0; last = T0 - 30 * MIN;
const f = async () => { called++; };
await bitgetAuthHealth(mk({ memo, fetchEquity: f, getLastOkTs: () => last }));
await bitgetAuthHealth(mk({ memo, fetchEquity: f, getLastOkTs: () => last, now: T0 + 30 * 1000 }));
ok(called === 1, "unutar 60 s rezultat se pamti (javna ruta ne opterecuje Bitget), cak i neuspjeh");
await bitgetAuthHealth(mk({ memo, fetchEquity: f, getLastOkTs: () => last, now: T0 + 61 * 1000 }));
ok(called === 2, "nakon 60 s ponovno provjerava");

// izuzetak pri dohvatu ne ruši rutu
let threw = false, r;
try { r = await bitgetAuthHealth(mk({ fetchEquity: async () => { throw new Error("mreza"); }, getLastOkTs: () => T0 - 30 * MIN })); } catch { threw = true; }
ok(!threw && r.ok === false, "izuzetak pri dohvatu ne baca, ishod odlucuje zadnji uspjeh");

// single-flight: paralelni zahtjevi (javna ruta, memo jos prazan) dijele JEDAN dohvat — i kad dohvat traje i kad neuspije
for (const failing of [false, true]) {
  let n = 0; const memoP = { ts: 0, res: null };
  const slow = async () => { n++; await new Promise(r => setTimeout(r, 30)); if (failing) throw new Error("Bitget pao"); };
  const rs = await Promise.all(Array.from({ length: 25 }, () => bitgetAuthHealth(mk({ memo: memoP, fetchEquity: slow, getLastOkTs: () => failing ? T0 - 30 * MIN : T0 }))));
  ok(n === 1, `25 istovremenih poziva -> 1 dohvat prema Bitgetu (${failing ? "neuspjeh" : "uspjeh"}), bilo ${n}`);
  ok(rs.every(r => r === rs[0]) && rs[0].ok === !failing, "svi dobiju isti rezultat");
  ok(memoP.pending === null, "pending se ocisti nakon zavrsetka");
}

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
