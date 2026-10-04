#!/usr/bin/env node
/**
 * Koliko često je pod minimalnog notionala stvarno pogodio? (audit nalaz #14)
 *
 * ZAŠTO
 * `runUltra4hStrategy` i `run()` dižu notional na minimum NAKON svih makro size
 * multiplikatora (vikend ×0.5, chill ×0.7, day-range ×0.6, SP500, F&G, DXY). Kad se pod
 * upali, vrati natrag sve što su oni smanjili — stvarni rizik tad prelazi `riskAmount`.
 * Pitanje je je li to rubni slučaj ili se događa redovito. Bez te brojke nema smisla
 * birati prag za preskakanje takvih ulaza; izbor napamet je upravo ono što je kod
 * "momentum prag +1" otišlo po zlu.
 *
 * KORIŠTENJE
 *   node tools/min-notional-report.mjs
 *   DATA_DIR=/app/data node tools/min-notional-report.mjs
 *
 * Čita samo lokalne CSV-ove. Ne zove nijedan API, ne dira pozicije, ne pokreće bota.
 *
 * ŠTO MOŽE, A ŠTO NE
 * CSV ne bilježi NAMJERAVANI rizik (riskAmount prije multiplikatora), pa se točan množitelj
 * ne može rekonstruirati unatrag — može se samo vidjeti koji su ulazi sjedili na podu i koliki
 * im je bio stvarni rizik u dolarima. Od 04.10. taj množitelj ide u log pri svakom ulazu
 * ("[MIN] ... Nx namjere"), pa ubuduće postoji izravno.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : ".");
const FLOOR = 40;                 // ULTRA4H_MIN_NOTIONAL i isti broj u run()
const NEAR = 0.75;                // tolerancija u $ za "sjedi na podu"

// CSV_HEADERS iz bot.js — Notes je u navodnicima pa treba pravi parser, ne split(",")
function parseCsv(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const head = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = []; let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) { vals.push(cur); cur = ""; }
      else cur += ch;
    }
    vals.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, (vals[i] ?? "").trim()]));
  }).filter(r => r.Symbol);
}

const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };

function analyse(pid) {
  const rows = parseCsv(join(DATA_DIR, `trades_${pid}.csv`));
  if (rows === null) return { pid, missing: true };

  // Samo ULAZNI retci (izlazni imaju CLOSE_LONG/CLOSE_SHORT)
  const entries = rows.filter(r => r.Side === "LONG" || r.Side === "SHORT");
  const out = [];
  let skippedNoSl = 0;
  for (const r of entries) {
    const notional = num(r["Total USD"]);
    const price = num(r.Price);
    const sl = num(r.SL);
    if (notional === null || !price) continue;
    // Stari retci (do ~05/2026) imaju SL = 0 jer se tada SL nije upisivao u CSV. Bez njega
    // slPct ispadne 100% i "rizik" postane cijeli notional — to je rušilo median i max
    // (vidjeno: max $522 na računu od ~$300). Takvi se preskaču i broje odvojeno.
    if (sl === null || sl <= 0) { skippedNoSl++; continue; }
    const slPct = Math.abs(price - sl) / price * 100;
    if (!(slPct > 0) || slPct >= 50) { skippedNoSl++; continue; }  // neispravan SL
    out.push({
      date: r.Date, time: r["Time (UTC)"], symbol: r.Symbol, side: r.Side,
      mode: r.EntryMode || "?", weekend: r.Weekend === "true", night: r.Night === "true",
      notional, slPct, risk: notional * slPct / 100,
      atFloor: Math.abs(notional - FLOOR) <= NEAR,
    });
  }
  return { pid, entries: out, skippedNoSl };
}

const pct = (a, b) => b ? (100 * a / b).toFixed(1) + "%" : "—";
const money = (x) => "$" + x.toFixed(2);

console.log(`\nDATA_DIR: ${DATA_DIR}   (pod = $${FLOOR}, tolerancija ±$${NEAR})`);

let anyData = false;
for (const pid of ["ultra_4h", "synapse_t"]) {
  const res = analyse(pid);
  console.log(`\n${"─".repeat(64)}\n${pid}`);
  if (res.missing) { console.log("  nema trades_" + pid + ".csv u DATA_DIR"); continue; }
  const { entries, skippedNoSl } = res;
  if (!entries.length) { console.log("  nema upotrebljivih ulaznih redaka"); continue; }
  anyData = true;

  const onFloor = entries.filter(e => e.atFloor);
  console.log(`  ulaza: ${entries.length}  |  na podu: ${onFloor.length} (${pct(onFloor.length, entries.length)})`);
  if (skippedNoSl) console.log(`  preskočeno ${skippedNoSl} starih redaka bez ispravnog SL-a (rizik se iz njih ne može izračunati)`);

  const risks = entries.map(e => e.risk).sort((a, b) => a - b);
  const med = risks[Math.floor(risks.length / 2)];
  console.log(`  rizik po ulazu: median ${money(med)}  min ${money(risks[0])}  max ${money(risks[risks.length - 1])}`);

  if (!onFloor.length) {
    console.log("  → pod nije pogodio nijednom. Nalaz #14 je ovdje teorijski; dovoljan je log.");
    continue;
  }
  const fr = onFloor.map(e => e.risk);
  const frMed = fr.slice().sort((a, b) => a - b)[Math.floor(fr.length / 2)];
  console.log(`  rizik NA PODU: median ${money(frMed)}  max ${money(Math.max(...fr))}`);
  console.log(`  od toga vikend: ${onFloor.filter(e => e.weekend).length}  |  noć: ${onFloor.filter(e => e.night).length}`);
  console.log("\n  ulazi koji su sjedili na podu:");
  console.log("  datum       vrijeme   simbol        strana  mode   notional   SL%    rizik$");
  for (const e of onFloor.slice(-25)) {
    console.log(`  ${e.date}  ${e.time}  ${e.symbol.padEnd(12)}  ${e.side.padEnd(6)}  ${e.mode.padEnd(5)}  ${money(e.notional).padStart(8)}  ${e.slPct.toFixed(2).padStart(5)}  ${money(e.risk).padStart(7)}`);
  }
  if (onFloor.length > 25) console.log(`  ... i još ${onFloor.length - 25} starijih`);
}

if (!anyData) {
  console.log(`\nNema CSV-ova u ${DATA_DIR}. Na Railwayu pokreni s DATA_DIR=/app/data.`);
  process.exit(0);
}

console.log(`
${"─".repeat(64)}
KAKO ČITATI

Udio "na podu" blizu 0%  → nalaz #14 je rubni slučaj; dovoljan je log koji je dodan 04.10.
Udio osjetno iznad 0%    → vrijedi odlučiti preskače li se ulaz kad pod digne rizik iznad
                           namjere više od faktora K. Pogledaj "rizik NA PODU" naspram
                           ~1.5% equityja (RISK_PCT): koliko je puta veći, toliko je K
                           morao biti da ga uhvati.

CSV ne bilježi namjeravani rizik prije multiplikatora, pa točan množitelj ovdje nije
izračunljiv unatrag. Od 04.10. ide u log pri svakom ulazu: "[MIN] ... Nx namjere".
`);
