/**
 * Nalazi #7 i #37: Bitgetove granularnosti BEZ sufiksa `utc` poravnane su na UTC+8
 * (`1D` = pon 00:00 UTC+8, `1W` = ned 16:00 UTC), pa daju druge dnevne/tjedne granice od
 * ostatka repoa. #7 je to popravio za dnevne 04.10., #37 za tjedne 18.10.
 *
 * Regresijski test signalne jezgre OVO NE MOŽE uhvatiti: on ne dohvaća mrežu, a PWH/PWL
 * ulaze kao `cfg._pwh/_pwl`. Zato ovaj test čita IZVOR i traži da nijedan dohvat svijeća
 * ne koristi ne-UTC varijantu — isti pristup kao test/watchlist.mjs.
 *
 * Bez mreže, bez importa bot.js.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

// Granularnosti koje IMAJU utc varijantu i zato se ne smiju koristiti gole.
// (1H/4H/15m/5m/1m nisu dnevne pa nemaju utc varijantu — njih se ne dira.)
const FORBIDDEN = ["1D", "1W", "1M"];

// `tools/weekly-granularity-diff.mjs` je NAMJERNO izuzet: on postoji da usporedi 1W i 1Wutc,
// pa mu je gola varijanta nuzna. Komentari se preskacu — nekoliko ih OPISUJE stari goli oblik
// (npr. "bio `granularity=1D`" uz popravak nalaza #7), sto nije poziv.
const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

for (const file of ["bot.js", "dashboard.js"]) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const lines = src.split("\n");
  for (const g of FORBIDDEN) {
    // `granularity=1D` da, `granularity=1Dutc` ne — ono iza je razlika
    const re = new RegExp(`granularity=${g}(?!utc)`);
    const hits = lines
      .map((l, i) => ({ n: i + 1, l }))
      .filter(x => !isComment(x.l) && re.test(x.l))
      .map(x => `${file}:${x.n}`);
    ok(hits.length === 0, `${file}: nema golog granularity=${g}${hits.length ? " — nađeno na " + hits.join(", ") : ""}`);
  }
}

// Pozitivna kontrola: regex stvarno hvata golu varijantu, da test ne bude lažno zelen
{
  const re = new RegExp("granularity=1W(?!utc)");
  ok(re.test("granularity=1W&limit=3"), "kontrola: regex hvata golu 1W");
  ok(!re.test("granularity=1Wutc&limit=3"), "kontrola: regex NE hvata 1Wutc");
  ok(re.test("granularity=1W\"") , "kontrola: regex hvata 1W na kraju stringa");
}

console.log(fail === 0 ? "\nSVE PROSLO" : `\n${fail} PAD(OVA)`);
process.exit(fail === 0 ? 0 : 1);
