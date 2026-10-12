// Test pravila "kontra tjedni Supertrend BTC-a -> pola rizika" (bot.js) — bez mreze, bez trgovanja.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wkst-test-"));
const { weeklyCounterSizeMult, weeklySupertrendBias, fetchBtcWeeklyCandles, WEEKLY_COUNTER_MULT, calcSupertrend } = await import("../bot.js");
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const W = 7 * 86400e3, MON = Date.UTC(2023, 0, 2);   // ponedjeljak
const mk = (n, f, from = MON) => Array.from({ length: n }, (_, i) => { const c = f(i); return { time: from + i * W, open: c, high: c * 1.03, low: c * 0.97, close: c }; });
const NOW = MON + 200 * W;

ok(WEEKLY_COUNTER_MULT === 0.5, "kontra mnozitelj je 0.5");
ok(weeklyCounterSizeMult("LONG", "BULL") === 1 && weeklyCounterSizeMult("SHORT", "BEAR") === 1, "s trendom -> puni rizik");
ok(weeklyCounterSizeMult("SHORT", "BULL") === 0.5 && weeklyCounterSizeMult("LONG", "BEAR") === 0.5, "protiv trenda -> pola rizika");
ok(weeklyCounterSizeMult("LONG", "UNKNOWN") === 1 && weeklyCounterSizeMult("SHORT", "UNKNOWN") === 1 && weeklyCounterSizeMult("LONG", undefined) === 1, "nepoznato -> bez promjene");

const up = mk(80, i => 100 + i * 3), dn = mk(80, i => 400 - i * 3);
ok(weeklySupertrendBias(up, NOW) === "BULL", "stalni rast -> BULL");
ok(weeklySupertrendBias(dn, NOW) === "BEAR", "stalni pad -> BEAR");
ok(weeklySupertrendBias(up.slice(0, 20), NOW) === "UNKNOWN", "premalo tjedana -> UNKNOWN");
ok(weeklySupertrendBias([], NOW) === "UNKNOWN" && weeklySupertrendBias(undefined, NOW) === "UNKNOWN", "prazno -> UNKNOWN");
// tjedan koji se formira se ne racuna: zadnja svijeca kreni obrat, ali nije zatvorena
const turn = [...mk(80, i => 100 + i * 3), ...mk(1, () => 20, MON + 80 * W)];
ok(weeklySupertrendBias(turn, MON + 80 * W + 3 * 86400e3) === "BULL", "tjedan u formiranju se ignorira");
ok(weeklySupertrendBias(turn, MON + 82 * W) === "BEAR", "isti tjedan nakon zatvaranja -> BEAR");
// rupa u podacima: koristi samo neprekinuti rep
const gap = [...mk(30, i => 100 + i * 3), ...mk(50, i => 300 - i * 3, MON + 31 * W)];
ok(weeklySupertrendBias(gap, NOW) === "BEAR", "rupa -> samo rep poslije rupe (50 tj.)");
const gapShort = [...mk(60, i => 100 + i * 3), ...mk(20, i => 300 - i * 3, MON + 61 * W)];
ok(weeklySupertrendBias(gapShort, NOW) === "UNKNOWN", "rep poslije rupe prekratak -> UNKNOWN");
// redoslijed / duplikati ne smiju mijenjati rezultat
ok(weeklySupertrendBias([...up].reverse().concat(up.slice(0, 5)), NOW) === "BULL", "obrnut redoslijed + duplikati -> isto");
// poklapanje s calcSupertrend na zatvorenim tjednima
ok((calcSupertrend(up).bull.at(-1) === true) === (weeklySupertrendBias(up, NOW) === "BULL"), "isti izracun kao calcSupertrend");

// fetch: straniceni, spaja duplikat na rubu stranice
const all = mk(40, i => 100 + i * 3); const pageSize = 13; const calls = [];
const fakeGet = async url => { const end = +new URL(url).searchParams.get("endTime"); calls.push(end);
  const eligible = all.filter(c => c.time <= end).slice(-pageSize).reverse();   // Bitget: do endTime, najnovije prve; poredak nebitan
  return { ok: true, json: async () => ({ code: "00000", data: eligible.map(c => [String(c.time), c.open, c.high, c.low, c.close]) }) }; };
const got = await fetchBtcWeeklyCandles({ get: fakeGet, pages: 6, now: all.at(-1).time + 1 });
const uniq = [...new Map(got.map(c => [c.time, c])).values()].sort((a, b) => a.time - b.time);
ok(uniq.length === 40 && uniq.every((c, i) => c.time === all[i].time), `stranicenje bez rupa (${uniq.length}/40 tjedana, ${calls.length} zahtjeva)`);
let threw = false; try { await fetchBtcWeeklyCandles({ get: async () => ({ ok: false, status: 500 }), pages: 2 }); } catch { threw = true; }
ok(threw, "HTTP greska -> iznimka (getBtcWeeklyBias je hvata i zadrzava staro stanje)");
console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
