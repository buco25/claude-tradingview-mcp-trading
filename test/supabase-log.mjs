// Test Supabase bilježenja (supabase-log.js) — bez mreže, bez trgovanja. Lažni fetch i lažni timer.
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "sblog-test-"));
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY;
const { createSupabaseLogger, scanEntryToSignalRow, u4hSignalRow, entryTradeRow, exitTradeRow, scanStrategyOf } = await import("../supabase-log.js");
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const KEY = "sb_publishable_TESTKEY_not_real";
const env = { SUPABASE_URL: "https://abc.supabase.co/", SUPABASE_ANON_KEY: KEY };
const mk = (over = {}) => { const calls = []; const logs = [];
  const l = createSupabaseLogger({ env, setTimer: () => ({ unref() {} }), clearTimer() {}, now: () => 1e12, log: m => logs.push(m), ...over,
    fetchImpl: over.fetchImpl ?? (async (u, i) => { calls.push({ u, i }); return { ok: true, status: 201 }; }) });
  return { l, calls, logs }; };
const sig = { scan_ts: "2026-10-29T10:00:00Z", strategy: "1H", symbol: "BTCUSDT", signal: "LONG", blocked: false, entered: true };

// --- no-op bez ključeva ---
{ let called = 0, timers = 0;
  const l = createSupabaseLogger({ env: {}, fetchImpl: async () => { called++; return { ok: true }; }, setTimer: () => { timers++; return {}; } });
  l.logSignal(sig); l.logTrade({ event: "entry", symbol: "X" }); await l.flush();
  ok(called === 0 && timers === 0 && l.status().enabled === false && l.status().queued === 0, "bez SUPABASE_URL/KEY: nula poziva, nula timera, nista u redu"); }
{ const l = createSupabaseLogger({ env: { ...env, SUPABASE_LOG_ENABLED: "false" }, fetchImpl: async () => { throw new Error("ne smije"); }, setTimer: () => ({}) });
  l.logSignal(sig); ok(l.status().enabled === false, "SUPABASE_LOG_ENABLED=false gasi bilježenje"); }

// --- uspješan flush: URL, headeri, tijelo ---
{ const { l, calls } = mk(); l.logSignal(sig); l.logSignal({ ...sig, symbol: "ETHUSDT", nepoznato: "x" }); l.logTrade({ event: "entry", symbol: "BTCUSDT", data: { a: 1 } });
  ok(l.status().queued === 3, "logSignal/logTrade samo stavljaju u red (sinkrono, bez poziva)");
  ok(calls.length === 0, "nijedan mrezni poziv prije flusha");
  await l.flush();
  ok(calls.length === 2, "jedan POST po tablici (2 tablice)");
  const c = calls.find(x => x.u.endsWith("/rest/v1/signal_log"));
  ok(c && c.u === "https://abc.supabase.co/rest/v1/signal_log", "URL: kosa crta s kraja SUPABASE_URL ukljonjena");
  ok(c.i.headers.Prefer === "return=minimal", "Prefer: return=minimal (anon nema SELECT)");
  ok(c.i.headers.apikey === KEY && !("Authorization" in c.i.headers), "sb_publishable_ kljuc: samo apikey, bez Bearer");
  const body = JSON.parse(c.i.body);
  ok(body.length === 2 && !("nepoznato" in body[1]), "batch od 2 retka, nepoznati stupci odbaceni");
  ok(c.i.signal != null, "zahtjev ima AbortSignal (timeout)");
  ok(l.status().sent === 3 && l.status().queued === 0, "red prazan nakon uspjeha"); }
{ const { l, calls } = mk({ env: { ...env, SUPABASE_ANON_KEY: "eyJhbGciOi.test.jwt" } }); l.logSignal(sig); await l.flush();
  ok(calls[0].i.headers.Authorization === "Bearer eyJhbGciOi.test.jwt", "stari JWT anon kljuc ide i kao Bearer"); }

// --- greške ne bacaju i ne blokiraju ---
{ const logs = []; const l = createSupabaseLogger({ env, setTimer: () => ({}), now: () => 1e12, log: m => logs.push(m),
    fetchImpl: async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; } });
  l.logSignal(sig); let threw = false; try { await l.flush(); } catch { threw = true; }
  ok(!threw, "timeout u fetchu ne baca");
  ok(l.status().queued === 1, "timeout: batch se vraca u red (ponovni pokusaj)");
  ok(logs.length === 1 && !logs.join("").includes(KEY), "greška se logira jednom i kljuc se nikad ne ispisuje"); }
{ let t = 1e12; const l = createSupabaseLogger({ env, setTimer: () => ({}), now: () => t, log: () => {}, fetchImpl: async () => ({ ok: false, status: 503 }) });
  l.logSignal(sig); await l.flush(); const n1 = l.status().failed;
  await l.flush(); ok(l.status().failed === n1, "backoff: drugi flush odmah nakon greške ne zove mrežu");
  t += 16000; await l.flush(); ok(l.status().failed > n1, "nakon backoffa ponovo pokusava"); }
{ const l = createSupabaseLogger({ env, setTimer: () => ({}), now: () => 1e12, log: () => {}, fetchImpl: async () => ({ ok: false, status: 401 }) });
  l.logSignal(sig); await l.flush();
  ok(l.status().queued === 0 && l.status().dropped === 1, "4xx (npr. ključ/RLS): batch se odbacuje, ne ponavlja zauvijek"); }
{ const l = createSupabaseLogger({ env, setTimer: () => ({}), maxQueue: 5, fetchImpl: async () => ({ ok: true }) });
  for (let i = 0; i < 12; i++) l.logSignal({ ...sig, symbol: "S" + i });
  ok(l.status().queued === 5 && l.status().dropped === 7, "red ograničen (najstariji se odbacuju)"); }
{ let busy = 0, maxBusy = 0; const l = createSupabaseLogger({ env, setTimer: () => ({}), fetchImpl: async () => { busy++; maxBusy = Math.max(maxBusy, busy); await new Promise(r => setTimeout(r, 20)); busy--; return { ok: true }; } });
  l.logSignal(sig); await Promise.all([l.flush(), l.flush(), l.flush()]);
  ok(maxBusy === 1, "istovremeni flushevi se ne preklapaju (single-flight)"); }
{ // logSignal ne bacaju ni na smeću
  const l = createSupabaseLogger({ env, setTimer: () => ({}), fetchImpl: async () => ({ ok: true }) });
  let threw = false; try { l.logSignal(null); l.logSignal(undefined); l.logTrade(null); l.logSignal({ get symbol() { throw new Error("x"); } }); } catch { threw = true; }
  ok(!threw, "logSignal/logTrade ne bacaju ni na null/nevaljan unos"); }

// --- pretvorbe ---
ok(scanEntryToSignalRow({ symbol: "A", signal: "NEUTRAL", blocker: "SIGNAL" }) === null, "NEUTRAL se ne bilježi");
ok(scanEntryToSignalRow({ symbol: "A", signal: "SKIP", blocker: "MAX_POS" }) === null, "SKIP bez smjera se ne bilježi");
{ const r = scanEntryToSignalRow({ symbol: "ETHUSDT", signal: "SKIP", dir: "SHORT", blocker: "KEY_LEVEL", reason: "BTC tjedni close iznad $57392" }, "T");
  ok(r && r.signal === "SHORT" && r.blocked === true && r.entered === false && r.blockers[0] === "KEY_LEVEL" && r.bear_score === null, "SKIP s dir=SHORT -> SHORT, blokiran, KEY_LEVEL"); }
ok(scanEntryToSignalRow({ symbol: "A", signal: "SKIP", dir: "NEUTRAL", blocker: "X" }) === null, "SKIP s nevaljanim smjerom se ne bilježi");
ok(scanEntryToSignalRow({ symbol: "A", signal: "ERROR", blocker: "ERROR" }) === null, "ERROR se ne bilježi");
{ const r = scanEntryToSignalRow({ symbol: "ETHUSDT", signal: "SHORT", score: 6, blocker: "BTC_4H_BULL_NO_SHORT", reason: "BTC 4H BULL → SHORT blokiran", rsi: "41.2", adx: null }, "T");
  ok(r.strategy === "1H" && r.blocked === true && r.entered === false && r.blockers[0] === "BTC_4H_BULL_NO_SHORT", "blokirani 1H signal: blocked/blockers");
  ok(r.bear_score === 6 && r.bull_score === null, "SHORT: score ide u bear_score");
  ok(r.gates.rsi === 41.2 && !("adx" in r.gates), "gates: rsi broj, adx null izostavljen"); }
{ const r = scanEntryToSignalRow({ symbol: "SOLUSDT", signal: "LONG", score: 7, bullScore: 7, bearScore: 2, isMomentum: true, halfSize: false, price: 150.5, blocker: "ENTERED", reason: "MOM ulaz @ 150.5" });
  ok(r.entered === true && r.blocked === false && r.blockers.length === 0 && r.is_momentum === true && r.price === 150.5, "ENTERED: entered, bez blokera, momentum, cijena"); }
ok(scanStrategyOf({ blocker: "ENTERED", reason: "ST ulaz @ 1 SL 2 TP 3" }) === "ST" && scanStrategyOf({ blocker: "ST_NIGHT", reason: "x" }) === "ST" && scanStrategyOf({ blocker: "ENTERED", reason: "PBK ulaz @ 1" }) === "1H", "Supertrend se prepoznaje u zajedničkom scan logu");
{ const r = u4hSignalRow("BTCUSDT", { signal: "LONG", bullScore: 6, bearScore: 1, isMomentum: false, price: 70000 }, { ok: false, blockers: [{ text: "max kripto", log: "x" }], notes: ["  ⭐ note"], candlePat: "NONE", vipSlot: false, dayRangeSizeMult: 1 }, "T");
  ok(r.strategy === "4H" && r.blocked === true && r.blockers[0] === "max kripto" && r.bull_score === 6 && r.gates.candlePat === "NONE", "4H red: blokeri iz evaluateU4hGates"); }
ok(u4hSignalRow("X", { signal: "NEUTRAL" }, null) === null, "4H NEUTRAL se ne bilježi");
{ const e = entryTradeRow("synapse_t", { symbol: "BTCUSDT", signal: "LONG", price: 70000, sl: 69000, tp: 72000, tradeSize: 100, sigMask: 255, timestamp: 1e12, fundingPct: null, apiKey: "TAJNA" });
  ok(e.event === "entry" && e.side === "LONG" && e.data.price === 70000 && !("fundingPct" in e.data), "trade ENTRY: data, null izostavljen");
  ok(!JSON.stringify(e).includes("TAJNA"), "trade data je whitelist — nepoznata polja (npr. tajne) ne ulaze"); }
{ const x = exitTradeRow("ultra_4h", { symbol: "ETHUSDT", side: "SHORT", entryPrice: 3000, sl: 3100, tp: 2800, quantity: 1, totalUSD: 3000 }, 2900, "TP", 100, 3.6);
  ok(x.event === "exit" && x.data.net === 96.4 && x.data.exitPrice === 2900, "trade EXIT: net = pnl - fee"); }
{ const x = exitTradeRow("p", { symbol: "A", side: "LONG" }, NaN, "r", Infinity, undefined);
  ok(!("exitPrice" in x.data) && !("pnl" in x.data) && !("net" in x.data), "NaN/Infinity ne ulaze u jsonb"); }

// --- ograničenja baze (CHECK) + loš redak ne odnosi cijeli batch ---
{ const rows = [
    entryTradeRow("synapse_t_s_dugacak_naziv_portfelja_preko_30", { symbol: "X".repeat(40), signal: "BOTH", price: 1, timestamp: 1 }),
    exitTradeRow("p", { symbol: "A", side: "CLOSE_LONG", notes: "x" }, 1, "r", 1, 0.1),
    scanEntryToSignalRow({ symbol: "Y".repeat(40), signal: "LONG", strategy: "S".repeat(40), blocker: "B", reason: "r".repeat(1000) }),
    u4hSignalRow("Z", { signal: "SHORT" }, { ok: false, blockers: Array.from({ length: 30 }, (_, i) => ({ text: "b" + i })), notes: [] }) ];
  ok(rows[0].event === "entry" && rows[1].event === "exit", "event je malim slovima (CHECK trade_log_event_check)");
  ok(rows[0].portfolio.length <= 30 && rows[0].symbol.length <= 24, "portfolio ≤30 i symbol ≤24 znakova");
  ok(rows[0].side === null && rows[1].side === null, "side samo LONG/SHORT, inače null (CHECK trade_log_side_check)");
  ok(rows[2].symbol.length <= 24 && rows[2].strategy.length <= 20 && rows[2].reason.length <= 400, "signal_log: symbol ≤24, strategy ≤20, reason ≤400");
  ok(rows[3].blockers.length <= 20, "signal_log: blockers ≤20 elemenata");
  const big = entryTradeRow("p", { symbol: "A", signal: "LONG", price: 1, orderId: "o".repeat(500), btcRegime1h: "x".repeat(500), btcRegime4h: "y".repeat(500), candlePat: "z".repeat(500), strategy: "s".repeat(500), timestamp: 1 });
  ok(JSON.stringify(big.data).length <= 3000, "data ≤3000 znakova (CHECK pg_column_size ≤4000)"); }
{ const seen = []; const l = createSupabaseLogger({ env, setTimer: () => ({}), now: () => 1e12, log: () => {},
    fetchImpl: async (u, i) => { const b = JSON.parse(i.body); seen.push(b.length); return b.some(r => r.symbol === "LOS") ? { ok: false, status: 400, text: async () => "violates check constraint" } : { ok: true, status: 201 }; } });
  for (const s of ["A", "B", "LOS", "C", "D"]) l.logSignal({ ...sig, symbol: s });
  await l.flush();
  ok(l.status().sent === 4 && l.status().dropped === 1, "400: loš redak se odbacuje, ostala 4 su poslana pojedinačno");
  ok(String(l.status().lastError).includes("check constraint"), "poruka greške iz baze ulazi u status (bez ključa)"); }

// --- bot.js: pisanje CSV-a ne ovisi o Supabaseu i ne baca ---
const { initCsv, writeEntryCsv, writeExitCsv, csvFilePath } = await import("../bot.js");
initCsv("synapse_t");
writeEntryCsv("synapse_t", { symbol: "BTCUSDT", signal: "LONG", price: 70000, sl: 69000, tp: 72000, tradeSize: 100, timestamp: Date.now(), strategy: "t", orderId: "o1" });
writeExitCsv("synapse_t", { symbol: "BTCUSDT", side: "LONG", quantity: 0.001, totalUSD: 100, sl: 69000, tp: 72000, orderId: "o1", mode: "LIVE", entryPrice: 70000 }, 71000, "TP", 1.0);
ok(readFileSync(csvFilePath("synapse_t"), "utf8").trim().split("\n").length === 3, "writeEntryCsv/writeExitCsv i dalje pisu CSV (bez Supabase varijabli)");

// --- noćni signali (nightShadowLog): samo bilježenje, ne ruši skener ---
{ const { nightShadowLog } = await import("../bot.js");
  const emitted = []; const candles = [{ close: 100 }, { close: 101 }];
  const analyze = async (s) => s === "SIGUSDT" ? { signal: "LONG", bullScore: 6, bearScore: 1, isMomentum: false, reason: "PBK" }
    : s === "BADUSDT" ? (() => { throw new Error("mreža"); })() : { signal: "NEUTRAL", reason: "nema" };
  const deps = { enabled: () => true, fetchCandles: async () => candles, analyze, logSignal: r => emitted.push(r), timeoutMs: 200 };
  const n = await nightShadowLog({ params: {} }, ["NEUUSDT", "SIGUSDT", "BADUSDT", "SHORTUSDT"], deps);
  ok(n === 1 && emitted.length === 1 && emitted[0].symbol === "SIGUSDT", "bilježi samo LONG/SHORT; NEUTRAL i greška jednog simbola ne prekidaju ostale");
  ok(emitted[0].blocked === true && emitted[0].entered === false && emitted[0].blockers[0] === "NIGHT_BLOCK" && emitted[0].gates.night === true && emitted[0].gates.shadow === true && emitted[0].price === 101,
     "noćni redak: blocked, NIGHT_BLOCK, gates.night/shadow, cijena zadnje svijeće");
  ok(await nightShadowLog({ params: {} }, ["SIGUSDT"], { ...deps, enabled: () => false, logSignal: () => { throw new Error("ne smije"); } }) === 0, "bez Supabase bilježenja: nula dohvata i nula redaka");
  let calls = 0; const slow = { ...deps, fetchCandles: async () => { calls++; await new Promise(r => setTimeout(r, 30)); return candles; }, logSignal: () => {} };
  const p1 = nightShadowLog({ params: {} }, ["SIGUSDT", "SIGUSDT"], slow); const p2 = nightShadowLog({ params: {} }, ["SIGUSDT"], slow);
  await Promise.all([p1, p2]); ok(calls === 2, "jedan prolaz odjednom: drugi poziv tijekom prvog se preskače");
  const t0 = Date.now(); await nightShadowLog({ params: {} }, ["SIGUSDT"], { ...deps, fetchCandles: () => new Promise(() => {}), timeoutMs: 50 });
  ok(Date.now() - t0 < 1000, "dohvat koji visi prekida se timeoutom"); }

if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log("\nSve OK");
process.exit(0);
