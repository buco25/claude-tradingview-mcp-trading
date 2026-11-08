/**
 * Nalaz #47 (08.11.): `partialClosePosition` je koristila goli `symbol`, kojeg u njenom opsegu
 * nema — ni parametar, ni lokalnu, ni modul-level deklaraciju. U ESM modulu je to ReferenceError,
 * a kako je poziv bio unutar try/catch, funkcija je na SVAKOM pozivu tiho vracala false i
 * parcijala na TP-u se nikad nije izvrsila. Uvedeno u d0ae688, zivjelo tri tjedna.
 *
 * `node --check` ovu klasu greske NE HVATA (hvata samo sintaksu) — pise i u CLAUDE.md. Ovaj test
 * je mreza: za svaku funkciju u bot.js provjerava da identifikatori iz liste kandidata (cesti nazivi
 * parametara u ovom repou) nisu KORISTENI a nevezani. Bez mreze, bez trgovanja, bez importa bot.js.
 *
 * Aproksimacija je namjerna (nema parsera u repou), pa su stringovi/template literali/komentari
 * stripani prije provjere. Ako test lazno prijavi, ili dodaj ime u vezane ili suzi KANDIDATE —
 * ali NE gasi provjeru za `symbol`, to je nalaz #47.
 */
import { readFileSync } from "fs";

const SRC = readFileSync(new URL("../bot.js", import.meta.url), "utf8");
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

const KANDIDATI = ["symbol", "side", "qty", "pos", "pid", "price", "signal", "entry", "closePct"];

// stripa stringove, template literale i // komentare — da rijec u komentaru ne izgleda kao upotreba
const strip = (l) => l
  .replace(/\\./g, "")
  .replace(/`[^`]*`/g, "``").replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")
  .replace(/\/\/.*$/, "");

function modulLevelBindings(lines) {
  const set = new Set(["globalThis", "console", "process", "Math", "JSON", "Date", "Number", "String", "Object", "Array", "Promise", "Error", "Set", "Map", "fetch", "AbortSignal", "parseFloat", "parseInt", "isNaN", "crypto"]);
  for (const raw of lines) {
    const l = strip(raw); let m;
    if ((m = l.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) set.add(m[1]);
    if ((m = l.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) {
      // visestruki deklaratori: let a, b, c;
      const decl = l.replace(/^(?:export\s+)?(?:const|let|var)\s+/, "").split("=")[0];
      for (const n of decl.split(",")) { const t = n.trim().replace(/[{}[\]]/g, ""); if (/^[A-Za-z_$][\w$]*$/.test(t)) set.add(t); }
    }
    if ((m = l.match(/^(?:export\s+)?(?:const|let|var)\s+\{([^}]*)\}/))) for (const n of m[1].split(",")) set.add(n.trim().split(":").pop().trim());
    if ((m = l.match(/^import\s+\{([^}]*)\}/))) for (const n of m[1].split(",")) set.add(n.trim().split(/\s+as\s+/).pop());
    if ((m = l.match(/^import\s+([A-Za-z_$][\w$]*)\s+from/))) set.add(m[1]);
  }
  return set;
}

export function nadjiNevezane(src, kandidati = KANDIDATI) {
  const L = src.split("\n");
  const modul = modulLevelBindings(L);
  const out = [];
  for (let i = 0; i < L.length; i++) {
    const m = L[i].match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
    if (!m) continue;
    let end = L.length;
    for (let j = i + 1; j < L.length; j++) if (L[j] === "}") { end = j; break; }
    const tijelo = L.slice(i + 1, end + 1);
    const body = tijelo.map(strip).join("\n");
    const vezani = new Set(modul);
    for (const a of m[2].split(",")) {
      const n = a.trim().split("=")[0].trim().replace(/[{}[\]]/g, "");
      for (const part of n.split(",")) if (part.trim()) vezani.add(part.trim().split(":").pop().trim());
    }
    for (const k of kandidati) {
      if (vezani.has(k)) continue;
      // deklariran ili vezan unutar tijela (deklaracija, destrukturiranje, parametar ugnijezdene funkcije, catch, for-of)
      // `[,{\\[:]` pokriva i preimenovanje u destrukturiranju (`const { portfolio: pid } = pos`)
      if (new RegExp(`(?:const|let|var)\\s+(?:[^;=]*[,{\\[:]\\s*)?${k}\\b`).test(body)) continue;
      if (new RegExp(`\\(([^)]*\\b${k}\\b[^)]*)\\)\\s*=>`).test(body)) continue;
      if (new RegExp(`\\b${k}\\s*=>`).test(body)) continue;
      if (new RegExp(`function\\s*[\\w$]*\\s*\\(([^)]*\\b${k}\\b[^)]*)\\)`).test(body)) continue;
      if (new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${k}\\b`).test(body)) continue;
      const upotreba = new RegExp(`(?<![.\\w$])${k}(?![\\w$:])`);
      const linije = tijelo.map((l, idx) => ({ n: i + 2 + idx, l: strip(l) })).filter(x => upotreba.test(x.l));
      if (linije.length) out.push({ fn: m[1], id: k, linije: linije.map(x => x.n) });
    }
  }
  return out;
}

// ── bot.js mora biti cist ──────────────────────────────────────────────────
{
  const n = nadjiNevezane(SRC);
  ok(n.length === 0, `bot.js: nijedan kandidat nije koristen a nevezan${n.length ? " — " + n.map(x => `${x.fn}() '${x.id}' @ ${x.linije.join(",")}`).join(" | ") : ""}`);
}

// ── pozitivna kontrola: test MORA uhvatiti tocno nalaz #47 ─────────────────
{
  const bug = SRC.replace("size: fmtQty(pos.symbol, qty),", "size: fmtQty(symbol, qty),");
  ok(bug !== SRC, "kontrola: uspjelo vratiti nalaz #47 u kopiju izvora");
  const n = nadjiNevezane(bug);
  const uhvacen = n.some(x => x.fn === "partialClosePosition" && x.id === "symbol");
  ok(uhvacen, `kontrola: test hvata vraceni nalaz #47 (prijavljeno: ${n.map(x => x.fn + "/" + x.id).join(", ") || "nista"})`);
}

// ── parcijala na TP-u je UKLJUCENA (odluka vlasnika 08.11., "ukljuci parcijalu") ──
{
  const { PARTIAL_TP_ENABLED, BE_STOP_ENABLED, PARTIAL_1R_ENABLED } = await import("../bot.js");
  // Ako ovo padne, netko je flipnuo zastavicu bez odluke vlasnika: ukljucena parcijala MIJENJA
  // izlaze (25% se zatvara 0-5 min nakon originalnog TP-a, ostatak na trail), i to samo za
  // synapse_t — ULTRA-4H nije u PORTFOLIO_IDS pa ga checkPortfolioPositions ne dira.
  ok(PARTIAL_TP_ENABLED === true, "PARTIAL_TP_ENABLED je true — odluka vlasnika 08.11.");
  ok(BE_STOP_ENABLED === false && PARTIAL_1R_ENABLED === false, "BE-stop i +1R i dalje ugaseni (29.10.)");
  ok(/if \(PARTIAL_TP_ENABLED && !pos\.partialClosed/.test(SRC), "TP-HIT blok je iza zastavice");
  // Goli `symbol` je legitiman gdje JEST vezan (placeBitGetOrder parametar, addToPyramid
  // destrukturira ga iz existingPos) — zato se provjerava tocno mjesto nalaza #47.
  const pcp = SRC.slice(SRC.indexOf("async function partialClosePosition"));
  const pcpBody = pcp.slice(0, pcp.indexOf("\n}\n"));
  ok(!/fmtQty\(symbol\b/.test(pcpBody), "partialClosePosition ne koristi goli `symbol`");
  ok(/fmtQty\(pos\.symbol, qty\)/.test(pcpBody), "partialClosePosition koristi pos.symbol");
}

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
