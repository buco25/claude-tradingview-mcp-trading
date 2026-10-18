/**
 * Nalaz #34: parcijalni izlaz na TP-u mora u CSV ići s količinom i notionalom
 * ZATVORENOG dijela, i s naknadom na tom notionalu.
 *
 * Bez mreže i bez trgovanja — `partialExitRow` je čista funkcija. `bot.js` je siguran za
 * import (`_isMain` guard), ali DATA_DIR se ipak postavlja na temp da ništa ne piše u repo.
 */
import { join } from "path";
process.env.DATA_DIR ||= join(process.env.TMPDIR || "/tmp", "partial-exit-row-test");

const { partialExitRow } = await import("../bot.js");

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) fail++; };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ── LONG: izlaz iznad ulaza = dobit ─────────────────────────────────────────
{
  const r = partialExitRow({ side: "LONG", entryPrice: 100, quantity: 10, totalUSD: 1000 }, 110, 2.5);
  ok(near(r.quantity, 2.5), `LONG: quantity je ZATVORENI dio (2.5), ne cijela pozicija — ${r.quantity}`);
  ok(near(r.totalUSD, 250), `LONG: totalUSD je notional zatvorenog dijela (2.5 × 100 = 250) — ${r.totalUSD}`);
  ok(near(r.pnl, 25), `LONG: bruto P&L = (110 − 100) × 2.5 = 25 — ${r.pnl}`);
  ok(near(r.fee, 250 * 0.0006 * 2), `LONG: fee na 250, ne na 1000 — ${r.fee.toFixed(4)}`);
}

// ── SHORT: izlaz ispod ulaza = dobit (predznak se okreće) ───────────────────
{
  const r = partialExitRow({ side: "SHORT", entryPrice: 100, quantity: 10, totalUSD: 1000 }, 90, 2.5);
  ok(near(r.pnl, 25), `SHORT: bruto P&L = (100 − 90) × 2.5 = 25 — ${r.pnl}`);
}

// ── predznak kad cijena ide protiv trejda (ne bi se smjelo dogoditi na TP-u, ali
//    funkcija ne smije tiho pretvoriti gubitak u dobit) ─────────────────────
{
  const l = partialExitRow({ side: "LONG",  entryPrice: 100 }, 95,  1);
  const s = partialExitRow({ side: "SHORT", entryPrice: 100 }, 105, 1);
  ok(near(l.pnl, -5), `LONG protiv smjera daje NEGATIVAN P&L — ${l.pnl}`);
  ok(near(s.pnl, -5), `SHORT protiv smjera daje NEGATIVAN P&L — ${s.pnl}`);
}

// ── neispravan ulaz → null, pozivatelj ne piše redak ───────────────────────
{
  ok(partialExitRow({ side: "LONG", entryPrice: 100 }, 110, 0) === null, "qty 0 → null");
  ok(partialExitRow({ side: "LONG", entryPrice: 0 }, 110, 1) === null, "entryPrice 0 → null");
  ok(partialExitRow(null, 110, 1) === null, "pos null → null");
  ok(partialExitRow({ side: "LONG", entryPrice: 100 }, undefined, 1) === null, "exitPrice undefined → null");
}

// ── pod kojim je nalaz #34 nastao: puni notional bi dao 4× veću naknadu ────
{
  const r = partialExitRow({ side: "LONG", entryPrice: 100, totalUSD: 1000 }, 110, 2.5);
  const feeNaPunom = 1000 * 0.0006 * 2;
  ok(r.fee < feeNaPunom, `fee zatvorenog dijela ($${r.fee.toFixed(2)}) < fee na punom notionalu ($${feeNaPunom.toFixed(2)})`);
}

console.log(fail === 0 ? "\nSVE PROSLO" : `\n${fail} PAD(OVA)`);
process.exit(fail === 0 ? 0 : 1);
