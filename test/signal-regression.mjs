#!/usr/bin/env node
/**
 * Regresijski test signalne jezgre (analyzeUltra preko exportane analyzeUltra4h).
 *
 * ZAŠTO POSTOJI
 * Audit 04.10.2026 (issue #17) našao je 12 bugova u signalnom/gate putu — među njima
 * prag koji je tiho preskakao vikend/CHILL/Wyckoff bustove i četiri formule u
 * dashboard skeneru koje su se raziđale od bot.js. Nijedan od njih ne bi pao na
 * `node --check`, jer to hvata samo sintaksu. Ovaj test je mreža za takve regresije:
 * zamrzne ulaze i usporedi izlaz signalne jezgre sa snimljenim "golden" stanjem.
 *
 * KAKO SE KORISTI
 *   node test/signal-regression.mjs            # provjeri (izlazi 1 ako ima razlike)
 *   node test/signal-regression.mjs --update   # prihvati trenutno stanje kao novo golden
 *
 * Nakon NAMJERNE promjene scoringa/pragova test će pasti — to je točka. Pregledaj diff
 * koji ispiše, i ako je promjena željena, pokreni --update i commitaj novi fixture
 * ZAJEDNO s promjenom koda, da diff u PR-u pokazuje što se stvarno promijenilo.
 *
 * TRI STVARI KOJE SU OVDJE NAMJERNE — NE MIJENJAJ IH BEZ RAZLOGA
 *
 * 1) SAT JE ZAMRZNUT na srijedu. analyzeUltra čita `new Date().getUTCDay()` i subotom/
 *    nedjeljom diže prag za +2 signala (_weekendBoost). Bez zamrzavanja test prolazi
 *    radnim danom a pada vikendom. Upravo je ta ovisnost o satu 04.10. zamaskirala
 *    pravi nalaz dok se nije izolirala.
 *
 * 2) NE IMPORTAMO dashboard.js. Taj modul na module-levelu diže HTTP server i kroz 15 s
 *    zove runUltra4hStrategy() — import u testu bi STVARNO trgovao. bot.js je siguran
 *    jer ima `_isMain` guard, pa se run() pali samo kad je bot.js entry point.
 *    (Posljedica: skenerov scanSymbol ovaj test NE pokriva. Da bi ga pokrio, trebalo bi
 *    signalni izračun izvući iz dashboard.js u bot.js — vidi nalaz #4 u issue #17.)
 *
 * 3) BEZ MREŽE. analyzeUltra4h je čista funkcija (candles → signal). analyzeUltraPullback
 *    i analyzeUltra4hFull rade HTTP fetcheve, pa se u testu NE koriste — test mora biti
 *    determinističan i raditi offline/u CI-u.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// ── 1) Zamrzni sat PRIJE importa bot.js ──────────────────────────────────────
const FROZEN = Date.UTC(2026, 8, 30, 12, 0, 0); // srijeda 30.09.2026 12:00 UTC
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(FROZEN); else super(...args); }
  static now() { return FROZEN; }
}
globalThis.Date = FrozenDate;
if (new Date().getUTCDay() !== 3) {
  console.error("FATAL: zamrzavanje sata nije uspjelo — test bi bio ovisan o danu u tjednu.");
  process.exit(2);
}

// DATA_DIR u temp: bot.js na importu zove loadSlCooldown() i može kreirati data dir.
// Ne želimo da test ikad piše u repo.
process.env.DATA_DIR ||= join(process.env.TMPDIR || "/tmp", "ultra-signal-test-data");

const bot = await import("../bot.js");

// ── BOGATIJI vs SIROMAŠNIJI način snimanja ───────────────────────────────────
// analyzeUltra4h je jedina ČISTA (bez mreže) ulazna točka u signalnu jezgru koja je
// trenutno exportana. Problem: _finalizeUltra4hSignal za NEUTRAL vraća samo
// `{ signal: "NEUTRAL" }` — bez bullScore/bearScore. Kako je većina slučajeva NEUTRAL,
// promjena scoringa koja NE prebaci stranu praga ovim testom NE BI bila uhvaćena.
//
// Rješenje je jedna linija u bot.js:
//     export { analyzeUltra as analyzeUltraForTest };
// Tada ovaj test automatski prelazi na bogati način: snima bullScore/bearScore i reason
// za SVAKI slučaj (uključujući NEUTRAL) i prolazi kroz cfg varijante (zone + bustovi),
// pa pokriva i PBK grane i zone-confluence gate. Dok ta linija ne postoji, test radi u
// siromašnijem načinu i to glasno kaže u ispisu.
const RICH = typeof bot.analyzeUltraForTest === "function";
const analyzeRich = RICH ? bot.analyzeUltraForTest : null;
const { analyzeUltra4h } = bot;

// ── 2) Deterministički generator svijeća ─────────────────────────────────────
// Vlastiti LCG umjesto Math.random da je fixture reproducibilan na svakoj mašini.
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
function makeCandles(seed, drift, vol, n = 250) {
  const rand = lcg(seed);
  const out = [];
  let px = 100;
  let t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    px = Math.max(1, px * (1 + drift + (rand() - 0.5) * vol));
    const o = px * (1 + (rand() - 0.5) * vol * 0.4);
    const c = px * (1 + (rand() - 0.5) * vol * 0.4);
    out.push({
      time: t, open: o, close: c,
      high: Math.max(o, c) * (1 + rand() * vol * 0.5),
      low:  Math.min(o, c) * (1 - rand() * vol * 0.5),
      volume: 800 + rand() * 900,
    });
    t += 4 * 3600 * 1000; // 4H svijeće
  }
  return out;
}

// ── 3) Matrica slučajeva ─────────────────────────────────────────────────────
// Seedovi 1-40 × 5 režima × 3 simbola = 600 slučajeva. Režimi su odabrani da pokriju
// sve grane: trend gore/dolje, visoka volatilnost (ADX soft zona), tihi trend.
// Provjereno da matrica stvarno pogađa LONG, SHORT, MOMENTUM i NEUTRAL (vidi
// "pokrivenost" u ispisu) — da test ne bi tiho degradirao u "sve je NEUTRAL".
const REGIMES = [
  { name: "up",        drift:  0.0040, vol: 0.020 },
  { name: "down",      drift: -0.0040, vol: 0.020 },
  { name: "choppy",    drift:  0.0000, vol: 0.035 },
  { name: "slow-up",   drift:  0.0015, vol: 0.012 },
  { name: "slow-down", drift: -0.0015, vol: 0.012 },
];
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "TAOUSDT"]; // TE_COMBO minSig 5 / 5 / 4
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

const r4 = (x) => (typeof x === "number" && isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

// cfg varijante — samo u bogatom načinu. Pokrivaju bustove koji su bili uzrok nalaza #1
// (vikend se ne može staviti u cfg jer dolazi iz sata, zato je sat zamrznut na srijedu
// i bustovi se testiraju kroz chill/inval/wyckoff koji ISTO diraju MIN_CONFIRM_*).
const CFG_VARIANTS = [
  ["plain",      {}],
  ["chill",      { _chillMode: true }],
  ["inval",      { _invalBoost: true }],
  ["wyckoffSOS", { _wyckoffSosPending: true }],
  ["override3",  { _minSigOverride: 3 }],
];

// Zone razine namjerno blizu zadnje cijene, da zone-confluence gate ne odbije sve
// unaprijed — inače bi PBK grane ostale nepokrivene.
function zonesFor(candles) {
  const last = candles[candles.length - 1].close;
  return {
    _pwl: last * 0.994, _pwh: last * 1.006,
    _dailyEma10: last * 0.998, _dailyEma20: last * 0.997,
    _monthlyOpen: last * 0.995, _monthlyHigh: last * 1.004, _monthlyLow: last * 0.99,
    _weeklyOpen: last * 1.002, _yearlyOpen: last * 0.97, _fridayClose: last * 1.001,
  };
}

function runMatrix() {
  const rows = {};
  const coverage = {};
  let threw = 0;
  for (const seed of SEEDS) {
    for (const reg of REGIMES) {
      const candles = makeCandles(seed, reg.drift, reg.vol);
      const zones = RICH ? zonesFor(candles) : null;
      for (const sym of SYMBOLS) {
        const variants = RICH ? CFG_VARIANTS : [["", null]];
        for (const [cname, cfg] of variants) {
          const key = RICH ? `${seed}|${reg.name}|${sym}|${cname}` : `${seed}|${reg.name}|${sym}`;
          let out;
          try {
            const r = RICH
              ? analyzeRich(candles, { ...zones, ...cfg, symbol: sym, _dynAdx: 20 })
              : analyzeUltra4h(candles, sym);
            out = {
              signal: r.signal,
              bull: r.bullScore ?? null,
              bear: r.bearScore ?? null,
              mom: r.isMomentum === true,
              slPct: r4(r.slPct),
              tpPct: r4(r.tpPct),
              sigMask: r.sigMask ?? null,
            };
            // U bogatom načinu snimamo i KLASU razloga (ne cijeli string — sadrži brojeve
            // koji se mijenjaju bezopasno). Ovo hvata promjenu grane na kojoj je odbijeno.
            if (RICH && r.reason) out.why = String(r.reason).split(":")[0].trim().slice(0, 40);
            if (RICH && r._strategy) out.strat = r._strategy;
          } catch (e) {
            // ReferenceError iz obrisane varijable je TOČNO ono što ovaj test lovi —
            // zato se greška snima kao vrijednost, ne ruši run.
            threw++;
            out = { signal: `THREW:${e.name}`, message: e.message };
          }
          const label = out.mom ? `${out.signal}-MOM` : out.signal;
          coverage[label] = (coverage[label] || 0) + 1;
          rows[key] = out;
        }
      }
    }
  }
  return { rows, coverage, threw };
}

// ── 4) Golden usporedba ──────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "fixtures", "signal-golden.json");
const UPDATE = process.argv.includes("--update");

const { rows, coverage, threw } = runMatrix();
const total = Object.keys(rows).length;

console.log(`\nnačin: ${RICH ? "BOGATI (analyzeUltraForTest)" : "SIROMAŠNI (analyzeUltra4h)"}`);
console.log(`slučajeva: ${total}  |  pokrivenost: ${JSON.stringify(coverage)}`);
if (threw > 0) console.log(`⚠️  ${threw} slučajeva je bacilo grešku (snimljeno kao THREW:*)`);
if (!RICH) {
  console.log(`
⚠️  SMANJENA POKRIVENOST. NEUTRAL slučajevi se snimaju bez bullScore/bearScore, jer
   _finalizeUltra4hSignal za NEUTRAL vraća samo { signal: "NEUTRAL" }. Promjena scoringa
   koja ne prebaci stranu praga ovim testom NEĆE biti uhvaćena.
   Za punu pokrivenost dodaj u bot.js jednu liniju:
       export { analyzeUltra as analyzeUltraForTest };
   i pokreni: node test/signal-regression.mjs --update`);
}

if (UPDATE) {
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, JSON.stringify({
    _note: "Generirano s `node test/signal-regression.mjs --update`. Ne editiraj ručno.",
    _frozenClock: new RealDate(FROZEN).toISOString(),
    _cases: total,
    rows,
  }, null, 2) + "\n");
  console.log(`✅ golden fixture zapisan: ${GOLDEN}`);
  process.exit(0);
}

if (!existsSync(GOLDEN)) {
  console.error(`\n❌ nema golden fixturea (${GOLDEN}).`);
  console.error("   Pokreni jednom: node test/signal-regression.mjs --update");
  process.exit(2);
}

const golden = JSON.parse(readFileSync(GOLDEN, "utf8")).rows;
const diffs = [];
for (const key of Object.keys(rows)) {
  const a = golden[key], b = rows[key];
  if (!a) { diffs.push({ key, kind: "NOVI", to: b }); continue; }
  if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ key, kind: "PROMJENA", from: a, to: b });
}
for (const key of Object.keys(golden)) if (!rows[key]) diffs.push({ key, kind: "NESTAO", from: golden[key] });

// Greške su uvijek fail, čak i ako su u goldenu — golden ih nikad ne bi smio sadržavati.
const nowThrows = Object.entries(rows).filter(([, v]) => String(v.signal).startsWith("THREW"));
if (nowThrows.length) {
  console.error(`\n❌ signalna jezgra baca grešku u ${nowThrows.length} slučajeva:`);
  for (const [k, v] of nowThrows.slice(0, 5)) console.error(`   ${k}: ${v.signal} ${v.message}`);
  process.exit(1);
}

if (diffs.length === 0) {
  console.log(`✅ nema regresija — svih ${total} slučajeva se poklapa s goldenom.\n`);
  process.exit(0);
}

console.error(`\n❌ ${diffs.length}/${total} slučajeva se razlikuje od goldena:\n`);
const fmt = (o) => o ? `${o.signal}${o.mom ? "-MOM" : ""} bull=${o.bull} bear=${o.bear} sl=${o.slPct} tp=${o.tpPct}` : "—";
for (const d of diffs.slice(0, 25)) {
  console.error(`  [${d.kind}] ${d.key}`);
  if (d.from) console.error(`      golden: ${fmt(d.from)}`);
  if (d.to)   console.error(`      sada  : ${fmt(d.to)}`);
}
if (diffs.length > 25) console.error(`  ... i još ${diffs.length - 25}`);
console.error(`
Ako je promjena NAMJERNA (promijenjen scoring, prag ili formula):
   node test/signal-regression.mjs --update
i commitaj novi fixture zajedno s promjenom koda.
Ako NIJE — upravo si uhvatio regresiju.
`);
process.exit(1);
