// Test detectCandlePattern / candleAgainst (bot.js) — bez mreze, bez trgovanja.
// DATA_DIR na temp dir da import bot.js nikad ne pise u repo (vidi CLAUDE.md).
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "candle-test-"));

const { detectCandlePattern, candleAgainst, candleContext, CANDLE_ENGULF_MIN_ATR } = await import("../bot.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

// 20 mirnih svijeca (range 2, tijelo 1) pa dvije koje testiramo + jedna "aktivna" (n-1, ignorira se)
const calm = Array.from({ length: 20 }, (_, i) => ({ open: 100 + (i % 2), close: 101 - (i % 2) * 0, high: 102, low: 99, volume: 1 }));
const mk = (c0, c1) => [...calm, c0, c1, { open: 100, close: 100, high: 100.5, low: 99.5, volume: 0 }];
const C = (open, close, high, low) => ({ open, close, high: high ?? Math.max(open, close), low: low ?? Math.min(open, close), volume: 1 });

// ATR kalmnih svijeca je ~3 (high-low = 3), pa "jak" engulfing treba tijelo >= 0.8*ATR ≈ 2.4
// bearish engulfing: c0 bullish 100->102, c1 bearish otvara 102.5 zatvara 96 (tijelo 6.5, gutа c0)
let p = detectCandlePattern(mk(C(100, 102), C(102.5, 96)));
ok(p.name === "BEAR_ENGULF" && p.bias === -1 && p.strong, `jak BEAR_ENGULF prepoznat (${p.name}, strong=${p.strong})`);
ok(candleAgainst("LONG", p) === true,  "jak BEAR_ENGULF blokira LONG");
ok(candleAgainst("SHORT", p) === false, "jak BEAR_ENGULF NE blokira SHORT");

p = detectCandlePattern(mk(C(102, 100), C(99.5, 106)));
ok(p.name === "BULL_ENGULF" && p.bias === 1 && p.strong, `jak BULL_ENGULF prepoznat (${p.name}, strong=${p.strong})`);
ok(candleAgainst("SHORT", p) === true,  "jak BULL_ENGULF blokira SHORT");
ok(candleAgainst("LONG", p) === false,  "jak BULL_ENGULF NE blokira LONG");

// slab engulfing (tijelo malo u odnosu na ATR) — prepoznat, ali ne blokira
p = detectCandlePattern(mk(C(100, 100.4), C(100.5, 99.9)));
ok(p.name === "BEAR_ENGULF" && !p.strong, `slab BEAR_ENGULF je prepoznat ali strong=false (${p.name}, strong=${p.strong})`);
ok(candleAgainst("LONG", p) === false, "slab engulfing NE blokira");

// hammer / shooting star / doji — samo biljezenje, nikad blokada
p = detectCandlePattern(mk(C(100, 101), C(100.4, 100.8, 100.9, 97)));   // dugi donji fitilj
ok(p.name === "HAMMER" && p.bias === 1 && !p.strong, `HAMMER (${p.name})`);
ok(!candleAgainst("SHORT", p) && !candleAgainst("LONG", p), "HAMMER ne blokira nista");
p = detectCandlePattern(mk(C(100, 101), C(100.8, 100.4, 104, 100.3)));  // dugi gornji fitilj
ok(p.name === "SHOOTING_STAR" && p.bias === -1, `SHOOTING_STAR (${p.name})`);
ok(!candleAgainst("LONG", p), "SHOOTING_STAR ne blokira nista");
p = detectCandlePattern(mk(C(100, 101), C(100, 100.05, 101, 99)));
ok(p.name === "DOJI" && p.bias === 0, `DOJI (${p.name})`);

// obicna svijeca / premalo podataka / smece
p = detectCandlePattern(mk(C(100, 101), C(101, 102, 102.2, 100.8)));
ok(p.name === "", `obicna svijeca -> bez formacije (${JSON.stringify(p.name)})`);
ok(detectCandlePattern(calm.slice(0, 10)).name === "", "premalo svijeca -> bez formacije");
ok(detectCandlePattern(null).name === "" && detectCandlePattern(undefined).name === "", "null/undefined -> bez formacije");
ok(candleAgainst("LONG", null) === false && candleAgainst("LONG", undefined) === false, "candleAgainst(null) = false");

// KLJUCNO: aktivna svijeca (n-1) se ignorira — gutajuca svijeca na n-1 NE smije dati formaciju
const forming = [...calm, C(100, 102), C(100, 99), C(102.5, 90)];   // engulfing bi bio na n-1 → ignorira se
p = detectCandlePattern(forming);
ok(p.name !== "BEAR_ENGULF", `engulfing na AKTIVNOJ svijeci (n-1) se ne gleda (${JSON.stringify(p.name)})`);

// ne smije bacati ni na degeneriranim svijecama
const flat = Array.from({ length: 25 }, () => ({ open: 1, close: 1, high: 1, low: 1, volume: 0 }));
ok(detectCandlePattern(flat).name === "", "ravne svijece (range 0) -> bez formacije, bez greske");
ok(CANDLE_ENGULF_MIN_ATR === 0.8, "prag 0.8 ATR");

// ── candleContext (06.10., samo mjerenje): boja/jacina zadnje ZATVORENE svijece + pomak ulaza u ATR, u smjeru tradea ──
{
  const redStrong = mk(C(100, 102), C(102.5, 96));            // zadnja zatvorena: crvena, tijelo 6.5 >> 0.8 ATR
  let k = candleContext(redStrong, "LONG", 97);               // ulaz 1 iznad zatvaranja (96), ATR ~3
  ok(k.ctx === "RED_STRONG", "crvena jaka svijeca -> RED_STRONG (" + k.ctx + ")");
  ok(k.distAtr > 0.2 && k.distAtr < 0.5, "LONG iznad zadnjeg zatvaranja -> pozitivan pomak ~0.33 ATR (" + k.distAtr + ")");
  k = candleContext(redStrong, "LONG", 95);
  ok(k.distAtr < 0, "LONG ispod zadnjeg zatvaranja (jeftinije) -> negativan pomak (" + k.distAtr + ")");
  k = candleContext(redStrong, "SHORT", 95);
  ok(k.distAtr > 0, "SHORT ispod zadnjeg zatvaranja (jurimo pad) -> pozitivan pomak, predznak u smjeru tradea (" + k.distAtr + ")");
  k = candleContext(mk(C(100, 100.3), C(100, 100.4)), "LONG", 100.4);
  ok(k.ctx === "GREEN_WEAK" && k.distAtr === 0, "zelena slaba, ulaz na zatvaranju -> GREEN_WEAK, 0 (" + k.ctx + "," + k.distAtr + ")");
  ok(candleContext(mk(C(100, 100.4), C(100.4, 100.4, 101, 99.8)), "LONG", 100.4).ctx === "FLAT_WEAK", "doji (open=close) -> FLAT_WEAK");
  // aktivna svijeca (n-1) se ne gleda: zelena n-2, golema crvena n-1
  const f2 = [...calm, C(100, 101), C(101, 102), C(102, 90)];
  ok(candleContext(f2, "LONG", 102).ctx.startsWith("GREEN"), "aktivna svijeca (n-1) se ne gleda");
  // degenerirani ulazi: prazan zapis, nikad iznimka
  const none = k => k.ctx === "" && k.distAtr === "";
  ok(none(candleContext(null, "LONG", 1)) && none(candleContext([], "LONG", 1)) && none(candleContext(flat, "LONG", 1)), "null/prazno/ravne svijece -> prazno, bez greske");
  k = candleContext(redStrong, "LONG", undefined);
  ok(k.ctx === "RED_STRONG" && k.distAtr === "", "nepoznata ulazna cijena -> boja ostaje, pomak prazan");
  ok(candleContext(redStrong, "NEUTRAL", 97).distAtr === "", "nepoznat smjer -> pomak prazan");
}

console.log(fail ? `\n${fail} PALO` : "\nSVE PROSLO");
process.exit(fail ? 1 : 0);
