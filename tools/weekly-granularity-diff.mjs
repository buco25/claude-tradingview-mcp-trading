#!/usr/bin/env node
/**
 * Nalaz #37: koliko se PWH/PWL razlikuju između `granularity=1W` i `1Wutc`.
 *
 * ZAŠTO
 * `analyzeUltraPullback` čita tjedne svijeće na `1W` (Bitget: pon 00:00 UTC+8 = ned 16:00 UTC),
 * a novi tjedni Supertrend na `1Wutc` (pon 00:00 UTC). Fazni pomak granica je 8 h, ali oba
 * potrošača čitaju `data[len - 2]` ("tjedan prije onog koji se formira"), pa u prozoru
 * ned 16:00 - pon 00:00 UTC biraju tjedne CIJELI TJEDAN razlike. `_pwh`/`_pwl` ulaze u
 * `sigs[4]` koji je u `TE_COMBO` (score) i u `_pwhMstrBonusBull` — dakle u signalnu jezgru.
 *
 * KORIŠTENJE
 *   node tools/weekly-granularity-diff.mjs
 *
 * Samo javni Bitget GET-ovi (svijeće), bez autentikacije, bez naloga, ne dira pozicije.
 * Zahtijeva da je `api.bitget.com` u dopuštenim domenama okoline.
 *
 * Mjereno 18.10. na 5 simbola / ~11 tjedana: izvan prozora median razlike 0.000% (p90 0.47%),
 * unutar prozora median 2.37% (p90 16.0%, max 63.4%). Vidi docs/AUDIT-2026-10-04.md, nalaz #37.
 */
// Simulira ono što analyzeUltraPullback radi (data[len-2] = prethodni dovršeni tjedan),
// ali za SVAKI sat zadnjih N tjedana, na oba granularitета. Samo javni GET-ovi.
const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];
const WEEK = 7 * 86400e3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function weekly(sym, gran) {
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=${gran}&limit=60`;
  const d = await (await fetch(url)).json();
  if (d.code !== "00000") throw new Error(`${sym} ${gran}: ${d.code} ${d.msg}`);
  return d.data.map(c => ({ t: +c[0], h: +c[2], l: +c[3] })).sort((a, b) => a.t - b.t);
}
// "prethodni dovršeni tjedan" u trenutku now, točno kako kod bira (len-2 nad ascending nizom
// koji završava svijećom koja se formira)
const prevWeekAt = (cs, now) => {
  const idx = cs.findIndex(c => c.t <= now && now < c.t + WEEK);   // svijeća koja se formira
  return idx >= 1 ? cs[idx - 1] : null;
};

const rows = [];
for (const sym of SYMS) {
  const a = await weekly(sym, "1W");      await sleep(150);
  const b = await weekly(sym, "1Wutc");   await sleep(150);
  const from = Math.max(a[0].t, b[0].t) + 2 * WEEK, to = Date.now();
  for (let now = from; now < to; now += 3600e3) {
    const pa = prevWeekAt(a, now), pb = prevWeekAt(b, now);
    if (!pa || !pb) continue;
    const sameWeek = Math.abs(pa.t - pb.t) < WEEK / 2;
    rows.push({ sym, now, sameWeek, dh: (pa.h / pb.h - 1) * 100, dl: (pa.l / pb.l - 1) * 100 });
  }
}

const stat = (xs) => {
  const s = xs.slice().sort((x, y) => x - y), n = s.length;
  const abs = xs.map(Math.abs).sort((x, y) => x - y);
  return { n, medAbs: abs[Math.floor(n / 2)], p90abs: abs[Math.floor(n * 0.9)], maxAbs: abs[n - 1] };
};
const inW = rows.filter(r => !r.sameWeek), out = rows.filter(r => r.sameWeek);
console.log(`uzoraka (sat x simbol): ${rows.length}   simbola: ${SYMS.length}`);
console.log(`  isti tjedan:      ${out.length}  (${(out.length / rows.length * 100).toFixed(1)}%)`);
console.log(`  CIJELI tjedan razlike: ${inW.length}  (${(inW.length / rows.length * 100).toFixed(1)}%)\n`);
for (const [label, set] of [["IZVAN 8h prozora (isti tjedan)", out], ["UNUTAR 8h prozora (razliciti tjedni)", inW]]) {
  if (!set.length) { console.log(label + ": nema uzoraka\n"); continue; }
  const h = stat(set.map(r => r.dh)), l = stat(set.map(r => r.dl));
  console.log(label + `  (n=${set.length})`);
  console.log(`  |PWH| razlika:  median ${h.medAbs.toFixed(3)}%   p90 ${h.p90abs.toFixed(3)}%   max ${h.maxAbs.toFixed(2)}%`);
  console.log(`  |PWL| razlika:  median ${l.medAbs.toFixed(3)}%   p90 ${l.p90abs.toFixed(3)}%   max ${l.maxAbs.toFixed(2)}%\n`);
}
const nz = rows.filter(r => Math.abs(r.dh) > 0.001 || Math.abs(r.dl) > 0.001);
console.log(`sati u kojima se PWH ILI PWL razlikuju iznad 0.001%: ${nz.length} / ${rows.length} (${(nz.length / rows.length * 100).toFixed(1)}%)`);
