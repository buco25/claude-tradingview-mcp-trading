/**
 * Nalaz #48 (10.11.) — stvarni 1H ulazi u LIVE modu nisu ostavljali zapis "ENTERED" u scan_log/signal_log.
 * Bez mreze, bez trgovanja. IZVORNI test: cita bot.js, jer se LIVE grana ne moze izvrsiti u testu
 * (plasirala bi nalog), a regresijski test signalne jezgre scan_log uopce ne vidi.
 */
import { readFileSync } from "fs";
const SRC = readFileSync(new URL("../bot.js", import.meta.url), "utf8");
const { scanEntryToSignalRow } = await import("../supabase-log.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

// Vraca { paper, live, err } — ima li svaka grana novog 1H ulaza svoj zapis.
function provjeri(src) {
  const od = src.indexOf("// ── NOVI ulaz (nije pyramid)");
  const doo = src.indexOf("// ── Supertrend 1D/4H/1H (05.10.)", od);
  if (od < 0 || doo < 0) return null;
  const blok = src.slice(od, doo);
  const iElse = blok.indexOf("} else {", blok.indexOf("if (!_isLive) {"));
  const iCatch = blok.indexOf("} catch (err) {", iElse);
  if (iElse < 0 || iCatch < 0) return null;
  const paper = blok.slice(blok.indexOf("if (!_isLive) {"), iElse), live = blok.slice(iElse, iCatch), err = blok.slice(iCatch, iCatch + 600);
  const PUSH = "_scanLogEntries.push(_enteredScanRow)";
  return {
    def: /const _enteredScanRow = \{[^\n]*blocker: "ENTERED"/.test(blok),
    paper: paper.includes(PUSH),
    live: live.includes(PUSH) && live.indexOf(PUSH) > live.indexOf("placeBitGetOrder(") && live.indexOf(PUSH) > live.indexOf("writeEntryCsv(pid, entry)"),
    prijeTg: live.indexOf(PUSH) < live.indexOf("await tg("),
    err: /if \(!_enteredLogged\) _scanLogEntries\.push\(\{[^\n]*blocker: "ENTRY_ERROR"/.test(err),
  };
}

const r = provjeri(SRC);
ok(r !== null, "blok novog 1H ulaza je nadjen u bot.js");
if (r) {
  ok(r.def, 'redak "ENTERED" se gradi jednom (_enteredScanRow)');
  ok(r.paper, "PAPER grana upisuje ENTERED");
  ok(r.live, "LIVE grana upisuje ENTERED — nakon naloga i nakon writeEntryCsv");
  ok(r.prijeTg, "LIVE zapis je prije Telegram poruke (pad poruke ga ne pojede)");
  ok(r.err, "pad naloga ostavlja ENTRY_ERROR samo ako ENTERED nije upisan");
}

// Pozitivna kontrola: vrati #48 u kopiju izvora (makni LIVE upis) i provjeri da test to vidi.
{
  const marker = "_scanLogEntries.push(_enteredScanRow); _enteredLogged = true;   // nalaz #48";
  ok(SRC.includes(marker), "LIVE upis ima prepoznatljiv marker");
  const pokvareno = provjeri(SRC.replace(marker, "// (uklonjeno za kontrolu)"));
  ok(pokvareno && pokvareno.live === false && pokvareno.paper === true, "kontrola: bez LIVE upisa test PADA (hvata regresiju #48)");
}

// Pyramid adicija je ulaz i mora ostaviti zapis (uspjeh i neuspjeh).
{
  const od = SRC.indexOf("const pyramidResult = await addToPyramid("), doo = SRC.indexOf("continue;  // Ne prolazimo kroz normalni entry flow", od);
  const blok = od > 0 && doo > od ? SRC.slice(od, doo) : "";
  ok(/_scanLogEntries\.push\(\{[^\n]*blocker: "ENTERED"[^\n]*PYRAMID/.test(blok), "uspjela pyramid adicija upisuje ENTERED");
  ok(/_scanLogEntries\.push\(\{[^\n]*blocker: "PYRAMID_FAILED"/.test(blok), "neuspjela pyramid adicija upisuje PYRAMID_FAILED");
}

// Pretvorba u redak signal_log: ENTERED -> entered=true, blocked=false; ENTRY_ERROR -> blokiran, nije usao.
{
  const e = scanEntryToSignalRow({ symbol: "SOLUSDT", signal: "SHORT", score: 5, bearScore: 5, price: 150, blocker: "ENTERED", reason: "PBK ulaz @ 150 SL 153 TP 144" }, "T");
  ok(e && e.entered === true && e.blocked === false && e.blockers.length === 0 && e.strategy === "1H" && e.signal === "SHORT", "ENTERED -> entered=true, blocked=false, strategija 1H");
  const s = scanEntryToSignalRow({ symbol: "SOLUSDT", signal: "LONG", score: 6, price: 150, blocker: "ENTERED", reason: "SWEEP ulaz @ 150 SL 147 TP 156" }, "T");
  ok(s && s.entered === true && s.strategy === "1H" && /^SWEEP ulaz/.test(s.reason), "SWEEP ulaz ostaje 1H (nije zamijenjen sa Supertrendom) i nosi oznaku nacina");
  const x = scanEntryToSignalRow({ symbol: "SOLUSDT", signal: "LONG", score: 6, price: 150, blocker: "ENTRY_ERROR", reason: "BitGet HTTP 429" }, "T");
  ok(x && x.entered === false && x.blocked === true && x.blockers[0] === "ENTRY_ERROR", "ENTRY_ERROR -> blokiran, nije usao");
}

console.log(fail ? `\n${fail} FAIL` : "\nsve PASS");
process.exit(fail ? 1 : 0);
