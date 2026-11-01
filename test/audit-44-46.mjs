/**
 * Nalazi #44, #45, #46 (01.11.) — bez mreze, bez trgovanja.
 *
 * #45 i dio #44/#46 su IZVORNI testovi: citaju bot.js i padaju na obrascu koji je nalaz
 * stvorio. Regresijski test signalne jezgre ovo NE MOZE uhvatiti — ne dohvaca mrezu, a
 * scan_log zapisi i redoslijed dohvata nisu dio goldena.
 */
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "audit4446-"));

const SRC = readFileSync(new URL("../bot.js", import.meta.url), "utf8");
const L = SRC.split("\n");
const { bounceParams, utcDayBucket, nightShadowLog } = await import("../bot.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

// ── #45: svaki gate koji blokira POZNATI signal mora ostaviti zapis ───────────
{
  const od = L.findIndex(l => l.includes("let { signal, reason } = result;"));
  const doo = L.findIndex((l, i) => i > od && l.includes("Piši scan log jednom po scan ciklusu"));
  ok(od > 0 && doo > od, `raspon nakon signala je nadjen (bot.js:${od + 1}..${doo + 1})`);
  const bez = [];
  for (let i = od; i < doo; i++) {
    if (!/^\s*continue;\s*$/.test(L[i])) continue;
    let push = false;
    for (let j = i; j > i - 9 && j >= 0; j--) if (/_scanLogEntries\.push/.test(L[j])) { push = true; break; }
    if (!push) bez.push("bot.js:" + (i + 1));
  }
  ok(bez.length === 0,
    `svaki continue nakon signala ostavlja scan_log zapis${bez.length ? " — bez zapisa: " + bez.join(", ") : ""}`);
  const skipDir = (SRC.match(/signal: "SKIP", dir: signal/g) || []).length;
  ok(skipDir >= 26, `SKIP zapisi nose dir (smjer signala) — ${skipDir}`);
}

// ── #44: tjedni/dnevni/mjesecni dohvat ne smije biti goli fetch ───────────────
{
  const goli = L
    .map((l, i) => ({ n: i + 1, l }))
    .filter(x => /await fetch\(\s*[wdm]Url/.test(x.l) || /fetch\((w|d|m)Url\)/.test(x.l));
  ok(goli.length === 0,
    `dohvati u analyzeUltraPullback ne koriste goli fetch${goli.length ? " — " + goli.map(x => "bot.js:" + x.n).join(", ") : ""}`);
  ok(/const wd = await _cachedDwmJson\(/.test(SRC), "tjedni ide kroz _cachedDwmJson (kes)");
  ok(/const md = await _cachedDwmJson\(/.test(SRC), "mjesecni ide kroz _cachedDwmJson (kes)");
  // DNEVNI se NE SMIJE kesirati: dailyEma racuna se i iz svijece koja se jos formira
  ok(/const dd = await bitgetPublicGet\(dUrl, \{ retries: 0 \}\)/.test(SRC),
    "dnevni ide kroz bitgetPublicGet BEZ kesa (dailyEma ukljucuje svijecu u formiranju)");
  ok(!/_cachedDwmJson\(\s*`d:/.test(SRC), "dnevni NIJE u kesu");
}

// ── #44: utcDayBucket se mijenja tocno na granici UTC dana ───────────────────
{
  const d = (s) => utcDayBucket(Date.parse(s));
  ok(d("2026-11-01T00:00:00Z") === d("2026-11-01T23:59:59Z"), "isti UTC dan -> isti bucket");
  ok(d("2026-11-01T23:59:59Z") + 1 === d("2026-11-02T00:00:00Z"), "granica UTC dana -> novi bucket");
  // tjedna i mjesecna granica UVIJEK padaju na granicu dana, pa kes po danu ne moze preskociti svijecu
  ok(d("2026-11-30T23:59:59Z") !== d("2026-12-01T00:00:00Z"), "granica mjeseca je i granica bucketa");
}

// ── #46: jedan izvor bounce praga ────────────────────────────────────────────
{
  ok(bounceParams({ a: 1 }, false)._minSigOverride === undefined, "bez bounce moda prag se ne mijenja");
  ok(bounceParams({ a: 1 }, true)._minSigOverride === 3, "u bounce modu prag je 3");
  ok(bounceParams({ a: 1 }, true).a === 1, "ostali parametri prolaze dalje");
  // Komentari se preskacu: jedan OPISUJE stari oblik (kao u test/candle-granularity.mjs).
  const inline = L.filter(l => /_minSigOverride: 3/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
  ok(inline.length === 1, `_minSigOverride: 3 u KODU postoji na jednom mjestu (helper) — ${inline.length}`);
  ok(/nightShadowLog\(pDef, _nightShadow, \{ params: bounceParams\(pDef\.params, _bounceMode\) \}\)/.test(SRC),
    "nocno biljezenje dobiva ISTE parametre kao stvarni put");
}

// ── #44 + #46: nocni prolaz jednom po satu, s predanim parametrima ───────────
{
  const H = 3600000, T = 1762000000000;   // fiksni sat
  const pDef = { name: "T", strategy: "synapse_t", timeframe: "1H", params: { base: true } };
  let analize = 0, vidjeniParams = null;
  const deps = (now, params) => ({
    now, params, enabled: () => true,
    fetchCandles: async () => [{ close: 100, high: 101, low: 99, open: 100, volume: 1 }],
    analyze: async (_s, _c, p) => { analize++; vidjeniParams = p; return { signal: "LONG", bullScore: 6, reason: "x" }; },
    logSignal: () => {}, timeoutMs: 500,
  });

  const a = await nightShadowLog(pDef, ["AAAUSDT"], deps(T, { marker: "prvi" }));
  ok(a === 1 && analize === 1, `prvi prolaz u satu radi — zapisano ${a}`);
  ok(vidjeniParams?.marker === "prvi", "analiza dobiva PREDANE parametre, ne pDef.params");

  const b = await nightShadowLog(pDef, ["AAAUSDT", "BBBUSDT"], deps(T + 10 * 60000, { marker: "drugi" }));
  ok(b === 0 && analize === 1, `drugi prolaz u ISTOM satu se preskace — vratio ${b}, analiza i dalje ${analize}`);

  const c = await nightShadowLog(pDef, ["AAAUSDT"], deps(T + H, { marker: "treci" }));
  ok(c === 1 && analize === 2, `novi sat -> prolaz se ponavlja — zapisano ${c}`);
}

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
