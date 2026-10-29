// Test mjerenja fundinga u CSV-u (bot.js: getFundingForLog, stupac FundingPct) — bez mreze, bez trgovanja.
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "fundcsv-test-"));
const { getFundingForLog, CSV_HEADERS, initCsv, writeEntryCsv, csvFilePath } = await import("../bot.js");
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const resp = body => async () => ({ json: async () => body });
const T = 1e12;

// --- getFundingForLog ---
let calls = 0;
const good = async () => { calls++; return { json: async () => ({ code: "00000", data: [{ fundingRate: "0.0001" }] }) }; };
ok(await getFundingForLog("AAAUSDT", { fetchImpl: good, cache: {}, now: T }) === 0.01, "uspjeh: 0.0001 -> 0.01 (postotak, kao getFundingRate)");
ok(await getFundingForLog("AAAUSDT", { fetchImpl: resp({ code: "00000", data: [{ fundingRate: "0" }] }), cache: {}, now: T }) === 0, "STVARNA nula ostaje 0 (nije greska)");
ok(await getFundingForLog("AAAUSDT", { fetchImpl: resp({ code: "00000", data: [{ fundingRate: "-0.0003" }] }), cache: {}, now: T }) === -0.03, "negativan funding");
ok(await getFundingForLog("AAAUSDT", { fetchImpl: resp({ code: "40001", msg: "x" }), cache: {}, now: T }) === null, "code != 00000 -> null (ne lazna nula)");
ok(await getFundingForLog("AAAUSDT", { fetchImpl: resp({ code: "00000", data: [] }), cache: {}, now: T }) === null, "prazan odgovor -> null");
ok(await getFundingForLog("AAAUSDT", { fetchImpl: resp({ code: "00000", data: [{ fundingRate: "abc" }] }), cache: {}, now: T }) === null, "neispravan broj -> null");
ok(await getFundingForLog("AAAUSDT", { fetchImpl: async () => { throw new Error("mreza"); }, cache: {}, now: T }) === null, "izuzetak (mreza/timeout) -> null, ne baca");
const cache = {}; calls = 0;
await getFundingForLog("BBBUSDT", { fetchImpl: good, cache, now: T });
await getFundingForLog("BBBUSDT", { fetchImpl: good, cache, now: T + 60000 });
ok(calls === 1, "svjez kes se koristi (drugi poziv ne dohvaca ponovno)");
await getFundingForLog("BBBUSDT", { fetchImpl: good, cache, now: T + 16 * 60000, ttl: 15 * 60000 });
ok(calls === 2, "istekao kes -> novi dohvat");

// --- CSV stupac ---
const cols = CSV_HEADERS.split(",");
ok(cols.at(-1) === "FundingPct" && cols.length === 26, "zaglavlje ima 26 stupaca, FundingPct zadnji (indeks 25)");
ok(cols.indexOf("Net P&L") === 9 && cols.indexOf("EntryDistATR") === 24, "stari indeksi netaknuti (Net P&L 9, EntryDistATR 24)");
const pid = "fundtest"; initCsv(pid);
const mkEntry = o => ({ symbol: "BTCUSDT", signal: "LONG", price: 80000, tradeSize: 100, sl: 79000, tp: 82500, orderId: "X1", timestamp: new Date(Date.UTC(2026, 9, 24, 12)).toISOString(), strategy: "ultra_4h", slPct: 1.5, tpPct: 3, entryMode: "PBK", sigMask: 5, btcRegime1h: "BULL", btcRegime4h: "BULL", candlePat: "NONE", candleCtx: "RED_STRONG", entryDistAtr: 0.1, ...o });
writeEntryCsv(pid, mkEntry({ fundingPct: 0.01 })); writeEntryCsv(pid, mkEntry({ fundingPct: 0 })); writeEntryCsv(pid, mkEntry({}));
const lines = readFileSync(csvFilePath(pid), "utf8").trim().split("\n");
const row = i => lines[i].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
ok(lines[0] === CSV_HEADERS && row(1).length === 26 && row(1)[25] === "0.01", "redak s fundingom: 26 stupaca, indeks 25 = 0.01");
ok(row(2)[25] === "0", "funding 0 se upisuje kao 0 (ne prazno)");
ok(row(3)[25] === "", "bez fundinga (null/undefined) -> prazno polje");
ok(row(1)[9] === "OPEN" && row(1)[3] === "BTCUSDT" && row(1)[24] === "0.1", "ostali stupci na istim indeksima (Net P&L 9, Symbol 3, EntryDistATR 24)");

// --- migracija starog zaglavlja (25 stupaca) ne dira podatkovne retke ---
const old25 = CSV_HEADERS.replace(",FundingPct", ""), pid2 = "fundold";
writeFileSync(csvFilePath(pid2), old25 + "\n" + "2026-10-01,10:00:00,BitGet,ETHUSDT,LONG,1,2000,50,0.03,0.5,1,1,O1,LIVE,p,\"n\",1,PBK,BULL,BULL,false,false,NONE,,\n");
initCsv(pid2);
const l2 = readFileSync(csvFilePath(pid2), "utf8").trim().split("\n");
ok(l2[0] === CSV_HEADERS && l2[1].startsWith("2026-10-01,10:00:00,BitGet,ETHUSDT"), "stari 25-stupcani CSV se migrira: zaglavlje novo, stari redak netaknut");

// --- nalaz #41: DIJELJENI kes s getFundingRate ne smije podmetnuti laznu nulu ---
// Testovi gore svjesno koriste `cache: {}`; upravo ta izolacija je 24.10. propustila nalaz #41,
// jer produkcija dijeli _frCache s getFundingRate, koja na odgovor BEZ podatka kesira 0.
ok(await getFundingForLog("CCCUSDT", { cache: { CCCUSDT: { rate: 0, ts: T, ok: false } }, now: T,
    fetchImpl: () => { throw new Error("ne smije dohvacati"); } }) === null,
  "kesirana LAZNA nula (ok:false) -> null, bez novog dohvata");
ok(await getFundingForLog("CCCUSDT", { cache: { CCCUSDT: { rate: 0, ts: T, ok: true } }, now: T,
    fetchImpl: () => { throw new Error("ne smije dohvacati"); } }) === 0,
  "kesirana STVARNA nula (ok:true) -> 0");
ok(await getFundingForLog("CCCUSDT", { cache: { CCCUSDT: { rate: 0.05, ts: T - 16 * 60000, ok: false } }, now: T,
    fetchImpl: resp({ code: "00000", data: [{ fundingRate: "0.0002" }] }) }) === 0.02,
  "istekao ok:false unos se ne pamti -> svjez dohvat");

// Integracija na STVARNOM modulu: gate otrovan 429-om, pa zapis u CSV bez ikakvih opcija.
// Ovo je tocno scenarij iz nalaza #41 — getFundingForLog mora vratiti null, ne 0.
{
  const pravi = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 429, json: async () => ({ code: "429", msg: "Too many requests" }) });
  try {
    const { getAllFundingRates } = await import("../bot.js");
    const gate = (await getAllFundingRates(["ZZZUSDT"]))["ZZZUSDT"];
    const csv  = await getFundingForLog("ZZZUSDT");          // BEZ opcija -> stvarni _frCache
    ok(gate === 0, `gate i dalje dobije 0 (ponasanje NEPROMIJENJENO) — ${gate}`);
    ok(csv === null, `CSV dobije null, ne laznu nulu iz dijeljenog kesa — ${JSON.stringify(csv)}`);
  } finally { globalThis.fetch = pravi; }
}

// --- nalaz #43: poziv ide kroz bitgetPublicGet, i to bez ponavljanja ---
{
  let opts = null;
  const fakeGet = async (u, o) => { opts = o; return { status: 200, json: async () => ({ code: "00000", data: [{ fundingRate: "0.0001" }] }) }; };
  const v = await getFundingForLog("DDDUSDT", { cache: {}, now: T, get: fakeGet });
  ok(v === 0.01, "ide kroz predani get (bitgetPublicGet u produkciji)");
  ok(opts?.retries === 0, `retries: 0 — mjerenje ne odgada bota backoffom (${opts?.retries})`);
  ok(typeof opts?.fetchImpl === "function", "timeout ide kroz fetchImpl omotac");
}

// --- nalaz #42: funding se NIKAD ne cita unutar entry literala (cita se IZVOR) ---
// Regresijski test ne moze uhvatiti redoslijed prema placeBitGetOrder, pa ga cuva ovo:
// `fundingPct: await` u literalu je tocno oblik koji je na ST i 1H putu cekao PRIJE naloga.
{
  const bot = readFileSync(new URL("../bot.js", import.meta.url), "utf8");
  const uLiteralu = bot.split("\n")
    .map((l, i) => ({ n: i + 1, l }))
    .filter(x => /fundingPct:\s*await/.test(x.l) && !/^\s*(\/\/|\*)/.test(x.l));
  ok(uLiteralu.length === 0,
    `nijedan \`fundingPct: await\` u literalu${uLiteralu.length ? " — nadeno na " + uLiteralu.map(x => "bot.js:" + x.n).join(", ") : ""}`);
  const dopisa = (bot.match(/entry\.fundingPct = await getFundingForLog/g) || []).length;
  ok(dopisa === 5, `funding se dopisuje nakon naloga na svih 5 mjesta (1H paper/live, ST paper/live, 4H) — ${dopisa}`);
}

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
