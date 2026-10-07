// Test bitgetPublicGet (razmak + ponavljanje na 429) i fetchLivePrices/fetchAllTickerPrices (jedan zahtjev + rezerva) — bez mreze.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bitget429-test-"));
const { bitgetPublicGet, fetchLivePrices, fetchAllTickerPrices, _resetTickerSnapshotForTest } = await import("../bot.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const R = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const noSleep = async () => {};

// ── bitgetPublicGet ──
{
  let n = 0; const seq = [R(429), R(429), R(200, { x: 1 })];
  const res = await bitgetPublicGet("u", { fetchImpl: async () => seq[n++], sleepImpl: noSleep, gapMs: 0 });
  ok(res.status === 200 && n === 3, "429, 429, 200 -> vraća 200 nakon 2 ponavljanja (3 zahtjeva): " + n);
}
{
  let n = 0;
  const res = await bitgetPublicGet("u", { fetchImpl: async () => { n++; return R(429); }, sleepImpl: noSleep, gapMs: 0 });
  ok(res.status === 429 && n === 4, "stalni 429 -> 1 + 3 ponavljanja = 4 zahtjeva, zadnji odgovor (429) se vraća pozivatelju: " + n);
}
{
  let n = 0;
  const res = await bitgetPublicGet("u", { fetchImpl: async () => { n++; return R(500); }, sleepImpl: noSleep, gapMs: 0 });
  ok(res.status === 500 && n === 1, "500 se NE ponavlja (samo 429)");
}
{
  const waits = []; let n = 0;
  await bitgetPublicGet("u", { fetchImpl: async () => (n++ < 3 ? R(429) : R(200)), sleepImpl: async ms => { waits.push(ms); }, gapMs: 0 });
  ok(waits.length === 3 && waits[0] >= 400 && waits[0] < 650 && waits[1] >= 800 && waits[1] < 1050 && waits[2] >= 1600 && waits[2] < 1850, "backoff 400/800/1600 ms + jitter: " + waits.join(","));
}
{ // razmak je zajednicki: 6 istovremenih poziva -> vremenski razmaknuti >= gap
  const stamps = [];
  await Promise.all(Array.from({ length: 6 }, () => bitgetPublicGet("u", { fetchImpl: async () => { stamps.push(Date.now()); return R(200); }, gapMs: 40 })));
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  ok(stamps.length === 6 && gaps.every(g => g >= 35), "6 istovremenih poziva razmaknuto najmanje ~40 ms: " + gaps.join(","));
}
{ // greska u jednom pozivu ne blokira lanac
  let n = 0;
  const p1 = bitgetPublicGet("u", { fetchImpl: async () => { throw new Error("mreza"); }, sleepImpl: noSleep, gapMs: 0 }).catch(e => e.message);
  const p2 = bitgetPublicGet("u", { fetchImpl: async () => { n++; return R(200); }, sleepImpl: noSleep, gapMs: 0 });
  ok((await p1) === "mreza" && (await p2).status === 200 && n === 1, "iznimka u jednom pozivu ne zaglavi lanac razmaka");
}

// ── fetchAllTickerPrices / fetchLivePrices ──
const T = (...pairs) => R(200, { data: pairs.map(([symbol, lastPr]) => ({ symbol, lastPr: String(lastPr) })) });
{
  _resetTickerSnapshotForTest(); let calls = []; let t = 1000;
  const deps = { get: async url => { calls.push(url); return url.includes("/tickers") ? T(["BTCUSDT", 84000], ["ETHUSDT", 2600], ["SOLUSDT", 116]) : R(200, { data: [{ lastPr: "5" }] }); }, now: () => t, ttl: 1500 };
  const p = await fetchLivePrices(["BTCUSDT", "ETHUSDT", "SOLUSDT"], deps);
  ok(calls.length === 1 && calls[0].includes("/tickers") && p.BTCUSDT === 84000 && p.SOLUSDT === 116, "3 simbola -> JEDAN zahtjev (/tickers), ne 3: " + calls.length);
  t += 1000; await fetchLivePrices(["BTCUSDT"], deps);
  ok(calls.length === 1, "unutar TTL-a (1.0 s < 1.5 s) -> 0 novih zahtjeva");
  t += 1000; await fetchLivePrices(["BTCUSDT"], deps);
  ok(calls.length === 2, "nakon TTL-a (2.0 s) -> novi snapshot");
}
{ // istovremeni pozivi dijele isti zahtjev
  _resetTickerSnapshotForTest(); let n = 0;
  const deps = { get: async () => { n++; await new Promise(r => setTimeout(r, 20)); return T(["BTCUSDT", 1], ["ETHUSDT", 2]); }, ttl: 1500 };
  await Promise.all([fetchLivePrices(["BTCUSDT"], deps), fetchLivePrices(["ETHUSDT"], deps), fetchLivePrices(["BTCUSDT", "ETHUSDT"], deps)]);
  ok(n === 1, "3 istovremena poziva -> 1 zahtjev (single-flight): " + n);
}
{ // simbol koji nije u snapshotu (npr. dionica) -> rezerva po simbolu; ostali iz snapshota
  _resetTickerSnapshotForTest(); const urls = [];
  const deps = { get: async url => { urls.push(url); return url.includes("/tickers") ? T(["BTCUSDT", 84000]) : R(200, { data: [{ lastPr: "237.5" }] }); }, ttl: 1500 };
  const p = await fetchLivePrices(["BTCUSDT", "NVDAUSDT"], deps);
  ok(p.BTCUSDT === 84000 && p.NVDAUSDT === 237.5 && urls.length === 2 && urls[1].includes("symbol=NVDAUSDT"), "simbol izvan snapshota -> pojedinacni ticker kao rezerva");
}
{ // snapshot pada (429 nakon ponavljanja) -> rezerva po simbolu, bez iznimke
  _resetTickerSnapshotForTest();
  const deps = { get: async url => url.includes("/tickers") ? R(429) : R(200, { data: [{ lastPr: "42" }] }), ttl: 1500 };
  const p = await fetchLivePrices(["BTCUSDT", "ETHUSDT"], deps);
  ok(p.BTCUSDT === 42 && p.ETHUSDT === 42, "snapshot 429 -> svaki simbol iz pojedinacne rezerve (kao prije promjene)");
}
{ // sve pada -> prazno/0, bez iznimke; pozivatelj ionako radi `if (!liveP) continue`
  _resetTickerSnapshotForTest();
  const deps = { get: async () => { throw new Error("mreza"); }, ttl: 1500 };
  let threw = false, p = null; try { p = await fetchLivePrices(["BTCUSDT"], deps); } catch { threw = true; }
  ok(!threw && !p.BTCUSDT, "sve zakaže -> bez iznimke, cijena nedostaje (pozivatelj preskače tick)");
}
{ // neuspjeh se NE kesira: iduci poziv ponovno pokusava
  _resetTickerSnapshotForTest(); let n = 0;
  const deps = { get: async url => { n++; return n === 1 ? R(500) : T(["BTCUSDT", 9]); }, ttl: 1500 };
  await fetchAllTickerPrices(deps).catch(() => {});
  const p = await fetchAllTickerPrices(deps);
  ok(p.BTCUSDT === 9 && n === 2, "pad snapshota se ne kešira — iduci poziv uspije");
}

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
