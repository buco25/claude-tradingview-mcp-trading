// Test vektorskih svijeca (PVSRA) i gatea "nepopunjena tjedna BTC vektorska svijeca" (bot.js) — bez mreze, bez trgovanja.
// DATA_DIR na temp dir da import bot.js nikad ne pise u repo (vidi CLAUDE.md).
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "vector-test-"));

const { vectorCandleAt, unfilledVectors, vectorContext, weeklyVectorBlock,
  VEC_LOOKBACK, VEC_WEEKLY_GATE_ENABLED, VEC_WEEKLY_MAX_DIST_PCT } = await import("../bot.js");
const { entryTradeRow } = await import("../supabase-log.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

// mirna svijeca: raspon 2, volumen 100
const calm = (p = 100) => ({ open: p, close: p + 0.5, high: p + 1, low: p - 1, volume: 100 });
const base = (n = 12, p = 100) => Array.from({ length: n }, () => calm(p));

// --- vectorCandleAt ---
// jedna ranija svijeca sa sirokim rasponom (umnozak 100 x 6 = 600), da pravilo umnoska ne proglasi klimaksom svaku s vecim volumenom
const wide = () => { const b = base(); b[5] = { open: 100, close: 100.5, high: 103, low: 97, volume: 100 }; return b; };
{ const c = [...wide(), { open: 100, close: 100.6, high: 101, low: 99, volume: 160 }];
  const v = vectorCandleAt(c, c.length - 1);
  ok(v.type === "ABOVE" && v.bull === true && v.ratio === 1.6, `volumen 160 % -> ABOVE bikovska (${v.type}, ${v.ratio})`); }
{ const c = [...base(), { open: 100, close: 100.6, high: 101, low: 99, volume: 160 }];
  ok(vectorCandleAt(c, c.length - 1).type === "CLIMAX", "isti volumen 160 %, ali najveci umnozak u 10 svijeca -> CLIMAX (pravilo umnoska)");
  ok(vectorCandleAt(base(), 11).type === "", "niz jednakih svijeca nije vektorski (umnozak mora biti strogo veci)"); }
{ const c = [...base(), { open: 100.6, close: 100, high: 101, low: 99, volume: 210 }];
  const v = vectorCandleAt(c, c.length - 1);
  ok(v.type === "CLIMAX" && v.bull === false, `volumen 210 % -> CLIMAX medvjeda (${v.type})`); }
{ // umnozak volumen x raspon: volumen samo 120 %, ali raspon 4x -> najveci umnozak u 10 svijeca -> CLIMAX
  const c = [...base(), { open: 100, close: 103, high: 104, low: 96, volume: 120 }];
  ok(vectorCandleAt(c, c.length - 1).type === "CLIMAX", "najveci umnozak volumen x raspon -> CLIMAX i uz volumen 120 %"); }
{ const c = [...wide(), { open: 100, close: 100.5, high: 101, low: 99, volume: 140 }];
  ok(vectorCandleAt(c, c.length - 1).type === "", "volumen 140 % (ispod 150 %) i umnozak nije najveci -> nije vektorska"); }
{ const c = [...base(), { open: 100, close: 100.5, high: 100.6, low: 99.9, volume: 140 }];   // manji raspon -> umnozak 98 < 200
  ok(vectorCandleAt(c, c.length - 1).type === "", "volumen 140 % i manji raspon -> nije vektorska"); }
{ const c = [...base(), { open: 100, close: 100, high: 101, low: 99, volume: 300 }];
  ok(vectorCandleAt(c, c.length - 1).type === "", "doji (open == close) se ne racuna kao vektorska"); }
{ const c = [...base(), { open: 100, close: 101, high: 101, low: 99 }];
  ok(vectorCandleAt(c, c.length - 1).type === "", "bez volumena -> nije vektorska");
  ok(vectorCandleAt(c, 3).type === "" && vectorCandleAt(null, 5).type === "" && vectorCandleAt(c, 99).type === "", "premalo povijesti / los ulaz -> nije vektorska, ne baca"); }
ok(VEC_LOOKBACK === 10, "prozor usporedbe je 10 svijeca (PVSRA)");

// --- unfilledVectors ---
{ // bikovska vektorska s otvaranjem 100, cijena ode gore i NE vrati se
  const c = [...base(), { time: 1, open: 100, close: 105, high: 105.5, low: 99.8, volume: 300 }, { open: 105, close: 106, high: 107, low: 104, volume: 100 }, { open: 106, close: 107, high: 108, low: 105, volume: 100 }];
  const u = unfilledVectors(c, c.length - 2);
  ok(u.length === 1 && u[0].open === 100 && u[0].bull === true, "bikovska vektorska bez povratka do otvaranja = nepopunjena");
  const c2 = [...c, { open: 107, close: 101, high: 107, low: 99.9, volume: 100 }];   // povratak ispod 100
  ok(unfilledVectors(c2, c2.length - 2).filter(x => x.open === 100).length === 0, "povratak do otvaranja (i u svijeci koja se formira) = popunjena"); }
{ const c = [...base(), { open: 100, close: 95, high: 100.2, low: 94.5, volume: 300 }, { open: 95, close: 94, high: 96, low: 93, volume: 100 }, { open: 94, close: 93, high: 95, low: 92, volume: 100 }];
  const u = unfilledVectors(c, c.length - 2);
  ok(u.length === 1 && u[0].bull === false, "medvjeda vektorska bez povratka gore = nepopunjena");
  ok(unfilledVectors(c, c.length - 2, 1).length === 0, "scan ogranicava koliko se unatrag gleda"); }

// --- vectorContext (samo mjerenje) ---
{ const c = [...base(), { open: 100, close: 105, high: 105.5, low: 99.8, volume: 300 }, { open: 105, close: 106, high: 107, low: 104, volume: 100 }, { open: 106, close: 106.5, high: 107, low: 105.5, volume: 10 }];
  const L = vectorContext(c, "LONG", 106), S = vectorContext(c, "SHORT", 106);
  ok(L.vecAgainstPct === 5.66 && L.vecTargetPct === "", `LONG: nepopunjena bikovska ispod = PROTIV (${L.vecAgainstPct}), nema mete gore`);
  ok(S.vecTargetPct === 5.66 && S.vecAgainstPct === "", `SHORT: ista svijeca = U SMJERU (${S.vecTargetPct})`);
  ok(L.vec === "", "zadnja zatvorena svijeca nije vektorska -> prazna oznaka"); }
{ const c = [...base(), { open: 100, close: 105, high: 105.5, low: 99.8, volume: 300 }, { open: 105, close: 105.2, high: 105.5, low: 104.9, volume: 10 }];
  const k = vectorContext(c, "LONG", 105);
  ok(k.vec === "CLIMAX_BULL" && k.vecRatio === 3, `zadnja zatvorena je vektorska -> oznaka ${k.vec}, omjer ${k.vecRatio}`); }
{ const none = JSON.stringify({ vec: "", vecRatio: "", vecTargetPct: "", vecAgainstPct: "" });
  ok(JSON.stringify(vectorContext(null, "LONG", 1)) === none && JSON.stringify(vectorContext([{}, {}, {}], "LONG", 1)) === none
    && JSON.stringify(vectorContext(base(20), "NEUTRAL", 100)) === none && JSON.stringify(vectorContext(base(20), "LONG", NaN)) === none,
    "los ulaz -> prazno, NIKAD ne baca (zove se nakon naloga na 4H putu)");
  const bad = base(20); bad[15] = undefined;
  let threw = false; try { vectorContext(bad, "LONG", 100); } catch { threw = true; }
  ok(!threw, "rupa u nizu svijeca ne baca iznimku"); }
{ const e = entryTradeRow("ultra_4h", { symbol: "BTCUSDT", signal: "SHORT", price: 65000, timestamp: 1, vec: "CLIMAX_BEAR", vecRatio: 2.4, vecTargetPct: 3.5, vecAgainstPct: "" });
  ok(e.data.vec === "CLIMAX_BEAR" && e.data.vecRatio === 2.4 && e.data.vecTargetPct === 3.5 && !("vecAgainstPct" in e.data), "trade_log: polja vektorske svijece ulaze, prazno se izostavlja");
  const e2 = entryTradeRow("ultra_4h", { symbol: "BTCUSDT", signal: "SHORT", price: 65000, timestamp: 1, vec: "", vecRatio: "" });
  ok(!("vec" in e2.data) && !("vecRatio" in e2.data), "trade_log: bez vektorske svijece nema polja"); }

// --- weeklyVectorBlock (gate) ---
const WEEK = 7 * 86400e3, T0 = Date.UTC(2026, 0, 5);          // ponedjeljak
const wk = (i, o, c, h, l, v = 100) => ({ time: T0 + i * WEEK, open: o, close: c, high: h ?? Math.max(o, c) + 1, low: l ?? Math.min(o, c) - 1, volume: v });
// 11 mirnih tjedana oko 60 000, zatim bikovska vektorska 62 900 -> 77 700, zatim tri tjedna gore pa pad na 65 500 (ne do 62 900)
const calmW = Array.from({ length: 11 }, (_, i) => wk(i, 60000, 60400, 61000, 59500));
const weekly = [...calmW, wk(11, 62900, 77700, 78000, 62500, 300), wk(12, 77700, 80000, 82000, 76000), wk(13, 80000, 78000, 81000, 77000), wk(14, 78000, 74800, 78500, 74000), wk(15, 74800, 65500, 75000, 65000)];
const NOW = T0 + 15 * WEEK + 3 * 86400e3;                     // tjedan 15 se jos formira
{ const b = weeklyVectorBlock("LONG", 65500, weekly, NOW);
  ok(b && b.level === 62900 && b.distPct === 3.97, `LONG: nepopunjena bikovska tjedna 3,97 % ispod -> BLOK (${b && b.level}, ${b && b.distPct})`);
  ok(weeklyVectorBlock("SHORT", 65500, weekly, NOW) === null, "SHORT: ista svijeca ne blokira (vuce u smjeru shorta)");
  ok(weeklyVectorBlock("LONG", 75000, weekly, NOW) === null, `LONG: svijeca dalja od ${VEC_WEEKLY_MAX_DIST_PCT} % ne blokira`);
  ok(weeklyVectorBlock("LONG", 62000, weekly, NOW) === null, "LONG: cijena ISPOD otvaranja -> razina nije ispod cijene, ne blokira");
  const b2 = weeklyVectorBlock("LONG", undefined, weekly, NOW);
  ok(b2 && b2.level === 62900, "bez cijene uzima zadnji close iz tjednih svijeca (65 500)"); }
{ const filled = [...weekly.slice(0, 15), wk(15, 74800, 63000, 75000, 62800)];     // tjedan u formiranju dotakne 62 800 < 62 900
  ok(weeklyVectorBlock("LONG", 63000, filled, NOW) === null, "popunjena (i u tjednu koji se formira) vise ne blokira"); }
{ // medvjeda vektorska 74 800 -> 65 500 kad se tjedan 15 ZATVORI; cijena se vrati na 68 500 -> SHORT blokiran
  const w2 = [...weekly.slice(0, 15), wk(15, 74800, 65500, 75000, 65000, 320), wk(16, 65500, 68500, 69000, 65200)];
  const now2 = T0 + 16 * WEEK + 86400e3;
  const b = weeklyVectorBlock("SHORT", 68500, w2, now2);
  ok(b && b.level === 74800 && b.distPct === 9.2, `SHORT: nepopunjena medvjeda tjedna 9,2 % iznad -> BLOK (${b && b.level}, ${b && b.distPct})`);
  ok(weeklyVectorBlock("SHORT", 66000, w2, now2) === null, "SHORT: ista svijeca 13 % iznad -> izvan praga, ne blokira");
  ok(weeklyVectorBlock("SHORT", 68500, w2, T0 + 15 * WEEK + 86400e3) === null, "tjedan u formiranju se NE klasificira kao vektorska"); }
{ const noVol = weekly.map(({ volume, ...c }) => c);
  ok(weeklyVectorBlock("LONG", 65500, noVol, NOW) === null, "bez volumena -> bez blokade");
  ok(weeklyVectorBlock("LONG", 65500, [], NOW) === null && weeklyVectorBlock("LONG", 65500, null, NOW) === null && weeklyVectorBlock("LONG", 65500, weekly.slice(10), NOW) === null, "bez podataka / premalo tjedana -> bez blokade");
  const gap = weekly.filter((_, i) => i !== 13);              // rupa u nizu -> gleda se samo neprekinut rep (2 tjedna) -> premalo
  ok(weeklyVectorBlock("LONG", 65500, gap, NOW) === null, "rupa u tjednim svijecama -> bez blokade");
  ok(weeklyVectorBlock("NEUTRAL", 65500, weekly, NOW) === null, "nepoznat smjer -> bez blokade");
  const dup = [...weekly, ...weekly.slice(5, 9)];             // duplikati s ruba stranice dohvata
  ok(weeklyVectorBlock("LONG", 65500, dup, NOW)?.level === 62900, "duplikati tjedana se spajaju"); }
ok(VEC_WEEKLY_GATE_ENABLED === true, "gate je ukljucen (vracanje: VEC_WEEKLY_GATE_ENABLED = false)");

// --- izvor: gate je na 1H trend putu i u evaluateU4hGates, Supertrend ga NE gleda; tjedni dohvat nosi volumen ---
{ const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bot.js"), "utf8").replace(/\r/g, "");
  const iRun = src.indexOf('blocker: "VEC_WEEKLY"');
  ok(iRun > 0 && /getBtcWeeklyVectorBlock\(signal,/.test(src.slice(iRun - 900, iRun)) && /!_stratBypass/.test(src.slice(iRun - 900, iRun)) && /dir: signal/.test(src.slice(iRun - 200, iRun + 300)),
    "1H: gate zove getBtcWeeklyVectorBlock, izuzima SWEEP/RANGE i ostavlja scan_log zapis sa smjerom");
  const g0 = src.indexOf("async function evaluateU4hGates"), g1 = src.indexOf("export async function previewU4hGates");
  ok(g0 > 0 && g1 > g0 && /getBtcWeeklyVectorBlock\(dir,/.test(src.slice(g0, g1)), "4H: gate je u evaluateU4hGates (jedini izvor istine)");
  const s0 = src.indexOf("// ===== SUPERTREND BEGIN"), s1 = src.indexOf("// ===== SUPERTREND END");
  ok(s0 > 0 && s1 > s0 && !/getBtcWeeklyVectorBlock|weeklyVectorBlock/.test(src.slice(s0, s1)), "Supertrend blok ne zove gate vektorske svijece");
  ok(/volume: \+x\[5\]/.test(src), "tjedni BTC dohvat cuva volumen");
  ok((src.match(/\.\.\.vectorContext\(/g) || []).length === 3, "vectorContext se upisuje na sva tri ulazna puta (1H, 4H, ST)"); }

// --- weeklyVectorOverview (dashboard kartica) ---
{ const { weeklyVectorOverview } = await import("../bot.js");
  const o = weeklyVectorOverview(weekly, 65500, NOW);
  ok(o.enabled === true && o.price === 65500 && o.maxDistPct === VEC_WEEKLY_MAX_DIST_PCT, "pregled: nosi stanje gatea, cijenu i prag");
  ok(o.levels.length === 1 && o.levels[0].level === 62900 && o.levels[0].bull === true && o.levels[0].distPct === -3.97, `pregled: nepopunjena razina s predznakom (${o.levels[0] && o.levels[0].distPct})`);
  ok(o.blockLong && o.blockLong.level === 62900 && o.blockShort === null, "pregled: blokada je ista kao u gateu (LONG da, SHORT ne)");
  const e = weeklyVectorOverview([], 65500, NOW);
  ok(e.levels.length === 0 && e.blockLong === null && e.blockShort === null && e.price === null, "pregled bez podataka: prazno, ne baca"); }

// --- dashboard.js: kartica postoji, a klijentski kod se izvrsava (NIKAD ne importati dashboard.js — cita se samo izvor) ---
{ const dsrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard.js"), "utf8").replace(/\r/g, "");
  ok(/getBtcWeeklyVectorOverview,/.test(dsrc) && /result\.vecWeekly = await getBtcWeeklyVectorOverview\(\)/.test(dsrc), "dashboard: uvozi pregled i salje ga u odgovoru (vecWeekly)");
  ok(/id="btc-vec-val"/.test(dsrc) && /id="btc-vec-sub"/.test(dsrc), "dashboard: kartica ima oba elementa");
  const a = dsrc.indexOf("// VEC-CARD BEGIN"), b = dsrc.indexOf("// VEC-CARD END");
  const snip = a > 0 && b > a ? dsrc.slice(a, b) : "";
  ok(snip.length > 200 && !/[`\\]|\$\{/.test(snip), "dashboard: klijentski kod kartice nema backtick, backslash ni dolar-viticu (zivi u template literalu)");
  const run = (d) => { const els = { "btc-vec-val": { style: {} }, "btc-vec-sub": {} }; new Function("d", "document", snip)(d, { getElementById: id => els[id] || null }); return els; };
  let els = run({ vecWeekly: { enabled: true, maxDistPct: 10, levels: [{ level: 62900, bull: true, distPct: -3.97 }], blockLong: { level: 62900, distPct: 3.97 }, blockShort: null } });
  ok(els["btc-vec-val"].textContent === "⛔ LONG" && /62[.,\s]?900/.test(els["btc-vec-sub"].textContent) && /-3\.97%/.test(els["btc-vec-sub"].textContent), `kartica: blokiran LONG, razina i udaljenost (${els["btc-vec-val"].textContent} | ${els["btc-vec-sub"].textContent})`);
  els = run({ vecWeekly: { enabled: true, maxDistPct: 10, levels: [], blockLong: null, blockShort: null } });
  ok(els["btc-vec-val"].textContent === "✅ slobodno" && /nema nepopunjenih/.test(els["btc-vec-sub"].textContent), "kartica: nista ne blokira");
  els = run({ vecWeekly: { enabled: false, maxDistPct: 10, levels: [], blockLong: null, blockShort: null } });
  ok(els["btc-vec-val"].textContent === "isključen", "kartica: gate iskljucen");
  let threw = false; try { run({}); run({ vecWeekly: null }); } catch { threw = true; }
  ok(!threw, "kartica: bez podataka ne baca (ostaje crtica)"); }

// --- vectorTrailTarget + paljenje traila na vektorskoj razini (16.11.) ---
{ const { vectorTrailTarget, applyTrailForTest: apply, VEC_TRAIL_ARM_ENABLED, VEC_TRAIL_ARM_STRATEGIES, VEC_TRAIL_MIN_R } = await import("../bot.js");
  ok(VEC_TRAIL_ARM_ENABLED === true && VEC_TRAIL_ARM_STRATEGIES.join() === "ultra_4h" && VEC_TRAIL_MIN_R === 0.3, "paljenje traila na vektorskoj razini: ukljuceno, samo ultra_4h, najmanje 0,3R");
  // medvjeda vektorska s otvaranjem 104 (pad na 100), cijena ostaje ispod -> za LONG s ulazom 100 meta je 104 (4 % iznad)
  const c = [...base(12, 104), { open: 104, close: 100, high: 104.2, low: 99.5, volume: 300 }, { open: 100, close: 100.5, high: 101, low: 99.6, volume: 100 }, { open: 100.5, close: 100.2, high: 100.8, low: 100, volume: 10 }];
  ok(vectorTrailTarget(c, "LONG", 100, 2, 6) === 104, "LONG: meta = otvaranje nepopunjene medvjede svijece iznad ulaza (4 %, izmedu 0,3R i TP-a)");
  ok(vectorTrailTarget(c, "LONG", 100, 2, 3.5) === null, "meta dalja od TP-a (4 % >= 3,5 %) se ne koristi");
  ok(vectorTrailTarget(c, "LONG", 100, 14, 30) === null, "meta bliza od 0,3R (4 % < 0,3 x 14 %) se ne koristi");
  ok(vectorTrailTarget(c, "SHORT", 100, 2, 6) === null, "SHORT: medvjeda svijeca iznad nije meta u smjeru");
  ok(vectorTrailTarget(null, "LONG", 100, 2, 6) === null && vectorTrailTarget(c, "LONG", NaN, 2, 6) === null && vectorTrailTarget(c, "X", 100, 2, 6) === null && vectorTrailTarget([{}, {}], "LONG", 100, 2, 6) === null, "los ulaz -> null, ne baca");
  // paljenje: LONG ulaz 100, SL 98, TP 105 (5 %), vektorska razina 102 (2 % = 40 % puta do TP-a)
  const mk = (strategy, vecTarget) => ({ symbol: "TESTUSDT", strategy, side: "LONG", entryPrice: 100, sl: 98, tp: 105, slPct: 2, tpPct: 5, quantity: 10, margin: 50, vecTarget });
  let p = mk("ultra_4h", 102);
  ok(apply(p, 101.9) === false && !p.trailArmed && p.sl === 98, "ispod vektorske razine: nista se ne mice");
  ok(apply(p, 102.0) === true && p.trailArmed === true && p.vecArmed === true, "na vektorskoj razini: trail armiran i oznacen (vecArmed)");
  ok(p.sl > 98, `nakon paljenja SL ide u korist pozicije (${p.sl})`);
  p = mk("ultra_4h", null);
  ok(apply(p, 102.5) === false && !p.trailArmed && p.sl === 98, "bez vektorske razine: ponasanje kao prije (trail tek na 95 % TP-a)");
  ok(apply(p, 104.8) === true && p.trailArmed === true && !p.vecArmed, "bez razine: armira se na 96 % TP-a, bez oznake vecArmed");
  p = mk("synapse_t", 102);
  ok(apply(p, 102.5) === false && !p.trailArmed, "synapse_t (1H): vektorska razina NE pali trail");
  const s = { symbol: "TESTUSDT", strategy: "ultra_4h", side: "SHORT", entryPrice: 100, sl: 102, tp: 95, slPct: 2, tpPct: 5, quantity: 10, margin: 50, vecTarget: 98 };
  ok(apply(s, 98.1) === false && apply(s, 98.0) === true && s.vecArmed === true && s.sl < 102, "SHORT: pali se kad cijena PADNE do razine, SL se spusta");
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bot.js"), "utf8").replace(/\r/g, "");
  const a0 = src.indexOf("function addPosition(pid, entry)");
  ok(a0 > 0 && /vecTarget:\s+entry\.vecTarget > 0 \? entry\.vecTarget : null/.test(src.slice(a0, a0 + 2500)), "addPosition sprema vecTarget u poziciju");
  ok((src.match(/vecTarget: vectorTrailTarget\(/g) || []).length === 1, "vecTarget se racuna samo na ULTRA-4H ulazu");
  const e = entryTradeRow("ultra_4h", { symbol: "BTCUSDT", signal: "LONG", price: 100, timestamp: 1, vecTarget: 102 });
  const { exitTradeRow } = await import("../supabase-log.js");
  const x = exitTradeRow("ultra_4h", { symbol: "BTCUSDT", side: "LONG", entryPrice: 100, vecTarget: 102, vecArmed: true }, 103, "Soft SL", 3, 0.1);
  const x2 = exitTradeRow("ultra_4h", { symbol: "BTCUSDT", side: "LONG", entryPrice: 100 }, 103, "Soft SL", 3, 0.1);
  ok(e.data.vecTarget === 102 && x.data.vecTarget === 102 && x.data.vecArmed === 1 && !("vecArmed" in x2.data) && !("vecTarget" in x2.data), "trade_log: vecTarget na ulazu i izlazu, vecArmed samo kad je trail upaljen na razini"); }

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
