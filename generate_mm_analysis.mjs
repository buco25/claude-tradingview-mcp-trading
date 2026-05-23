/**
 * generate_mm_analysis.mjs
 * Generira Excel (.xlsx) s MM/Algo analizom svih watchlist simbola
 * Pokretanje: node generate_mm_analysis.mjs
 */

import XLSX from "xlsx";
import { writeFileSync } from "fs";

// ─── Podaci iz analize ─────────────────────────────────────────────────────

const SYMBOL_OVERVIEW = [
  ["Simbol", "Sektor", "Likvidnost", "Avg Vol/1H bar", "Thresh >1.5×", "Bull Rev %", "Bear Rev %", "UKUPNO Rev %", "Napomena"],
  ["BTCUSDT",  "BTC",    "★★★★★", "~1,450 BTC",   "~2,175 BTC",   "67%", "56%", "60%", "Najefikasniji market — umjeren reversal"],
  ["ETHUSDT",  "OG_L1",  "★★★★★", "~35,000 ETH",  "~52,500 ETH",  "67%", "64%", "65%", "Slično BTC-u, visoka likvidnost"],
  ["SOLUSDT",  "OG_L1",  "★★★★☆", "~100,000 SOL", "~150,000 SOL", "25%", "70%", "52%", "Bull nastavlja u trendu! Bear = reversal"],
  ["XRPUSDT",  "OG_L1",  "★★★★☆", "~est.",        "~est.",        "~60%","~65%", "~62%","Procjena — nije direktno analiziran"],
  ["ADAUSDT",  "OG_L1",  "★★★☆☆", "~est.",        "~est.",        "~60%","~60%", "~60%","Procjena — srednja likvidnost"],
  ["DOGEUSDT", "MEME",   "★★★☆☆", "~est.",        "~est.",        "~58%","~62%", "~60%","Procjena — MEME vol spiky"],
  ["LINKUSDT", "DEFI",   "★★★☆☆", "~est.",        "~est.",        "~62%","~65%", "~63%","Procjena"],
  ["NEARUSDT", "ALT_L1", "★★☆☆☆", "~est.",        "~est.",        "~65%","~68%", "~67%","Tanje knjige"],
  ["SUIUSDT",  "ALT_L1", "★★☆☆☆", "~est.",        "~est.",        "~68%","~70%", "~69%","Tanje knjige"],
  ["APTUSDT",  "ALT_L1", "★★☆☆☆", "~est.",        "~est.",        "~68%","~70%", "~69%","Tanje knjige"],
  ["SEIUSDT",  "ALT_L1", "★★☆☆☆", "~est.",        "~est.",        "~70%","~72%", "~71%","Jako tanko tržište"],
  ["INJUSDT",  "ALT_L1", "★★☆☆☆", "~est.",        "~est.",        "~70%","~70%", "~70%","Tanko"],
  ["JUPUSDT",  "DEFI",   "★☆☆☆☆", "~est.",        "~est.",        "~72%","~75%", "~73%","Tanko DEFI"],
  ["ENAUSDT",  "DEFI",   "★☆☆☆☆", "~est.",        "~est.",        "~72%","~75%", "~73%","Tanko DEFI"],
  ["HYPEUSDT", "AI",     "★☆☆☆☆", "~130,000 HYPE","~195,000 HYPE","41%", "46%", "43%", "Analizirano za pump period — TREND nastavlja!"],
  ["TAOUSDT",  "AI",     "★☆☆☆☆", "~est.",        "~est.",        "~80%","~80%", "~80%","Prethodna sesija — MM gotovo potpuna kontrola"],
];

const HIGHVOL_EVENTS_BTC = [
  ["Bar #", "Timestamp (UTC)", "Open", "High", "Low", "Close", "Volume", "Vol/Avg", "Smjer", "Sljedeća svjeća", "Reversal?", "Napomena"],
  [4,  "2026-05-20 06:00", 77265, 77765, 77254, 77614, 3476, "2.4×", "BULL", "BEAR", "✓ DA", "Bull svjeća → odmah reversal"],
  [5,  "2026-05-20 07:00", 77614, 77618, 76661, 76920, 4412, "3.0×", "BEAR", "BEAR", "✗ NE", "Pad nastavlja"],
  [6,  "2026-05-20 08:00", 76920, 76933, 76200, 76373, 6821, "4.7×", "BEAR", "BULL", "✓ DA", "Mega bear spike → bouncea"],
  [7,  "2026-05-20 09:00", 76373, 76470, 76010, 76398, 4355, "3.0×", "BULL", "BEAR", "✓ DA", "Bull spike → reversal"],
  [30, "2026-05-20 14:00", 76843, 76980, 76115, 76373, 4490, "3.1×", "BEAR", "BULL", "✓ DA", "Distribucija → bouncea"],
  [53, "2026-05-21 09:00", 77585, 77614, 76930, 77180, 2912, "2.0×", "BEAR", "BULL", "✓ DA", "Pad → reversal"],
  [74, "2026-05-21 18:00", 77853, 78185, 77850, 77890, 2741, "1.9×", "BULL", "BEAR", "✓ DA", "Bull na vrhu → reversal"],
  [81, "2026-05-22 01:00", 77169, 78063, 77150, 77835, 4140, "2.8×", "BULL", "BEAR", "✓ DA", "Pump → odmah distribucija"],
  [107,"2026-05-22 19:00", 77263, 77263, 76723, 76752, 4487, "3.1×", "BEAR", "BULL", "✓ DA", "Panic → brzi bounce"],
  [111,"2026-05-22 23:00", 76733, 76875, 76066, 76501, 4946, "3.4×", "BEAR", "BEAR", "✗ NE", "Cascade nastavlja"],
  [112,"2026-05-23 00:00", 76501, 76549, 75600, 75819, 7501, "5.1×", "BEAR", "BULL", "✓ DA", "Mega crash → bounce (5× avg)"],
];

const HIGHVOL_EVENTS_ETH = [
  ["Bar #", "Timestamp (UTC)", "Open", "High", "Low", "Close", "Volume", "Vol/Avg", "Smjer", "Sljedeća svjeća", "Reversal?", "Napomena"],
  [9,  "2026-05-20 07:00", 2117.4, 2127.18, 2106.71, 2118.2,  68786,  "2.0×", "BULL", "BEAR", "✓ DA", "Bull → reversal odmah"],
  [10, "2026-05-20 08:00", 2118.2, 2123.21, 2093.07, 2105.61, 108243, "3.1×", "BEAR", "BULL", "✓ DA", "Veliki pad → bounce"],
  [33, "2026-05-21 05:00", 2133.11,2134.63, 2114.42, 2119.87, 58991,  "1.7×", "BEAR", "BULL", "✓ DA", "Pad → brza korekcija"],
  [34, "2026-05-21 06:00", 2119.87,2138.88, 2112.67, 2134.01, 99038,  "2.8×", "BULL", "BULL", "✗ NE", "Snažni trend nastavlja"],
  [35, "2026-05-21 07:00", 2134.01,2148.68, 2127.67, 2136.00, 102790, "2.9×", "BULL", "BEAR", "✓ DA", "Iscrpljenje na vrhu"],
  [45, "2026-05-21 17:00", 2141.84,2156.41, 2138.10, 2140.14, 92788,  "2.6×", "BEAR", "BULL", "✓ DA", "Pull → bounce"],
  [53, "2026-05-22 01:00", 2127.34,2129.38, 2108.80, 2113.64, 75308,  "2.1×", "BEAR", "BULL", "✓ DA", "Pad → reversal"],
  [57, "2026-05-22 05:00", 2116.38,2123.60, 2104.00, 2119.66, 63308,  "1.8×", "BULL", "BULL", "✗ NE", "Trend nastavlja"],
  [61, "2026-05-22 09:00", 2126.82,2152.71, 2124.73, 2145.62, 93547,  "2.7×", "BULL", "BEAR", "✓ DA", "Distribucija na vrhu"],
  [84, "2026-05-22 20:00", 2129.34,2129.34, 2111.15, 2115.99, 62391,  "1.8×", "BEAR", "BULL", "✓ DA", "Panic prodaja → bounce"],
  [87, "2026-05-23 03:00", 2119.11,2120.98, 2083.02, 2098.98, 135019, "3.8×", "BEAR", "BEAR", "✗ NE", "Cascade prodaja"],
  [88, "2026-05-23 04:00", 2098.98,2102.10, 2056.00, 2064.16, 209959, "5.9×", "BEAR", "BULL", "✓ DA", "Mega dump (6×) → bounce"],
];

const HIGHVOL_EVENTS_SOL = [
  ["Bar #", "Timestamp (UTC)", "Open", "High", "Low", "Close", "Volume", "Vol/Avg", "Smjer", "Sljedeća svjeća", "Reversal?", "Napomena"],
  [1,  "2026-05-20 01:00", 85.117, 85.252, 84.409, 85.144, 246759, "2.5×", "BULL", "BULL", "✗ NE", "Trend nastavlja (SOL u uzlaznom trendu)"],
  [2,  "2026-05-20 02:00", 85.144, 85.570, 85.080, 85.219, 321508, "3.2×", "BULL", "BULL", "✗ NE", "Snažan trend, continuation"],
  [4,  "2026-05-20 04:00", 85.453, 85.555, 84.984, 85.192, 260153, "2.6×", "BEAR", "BEAR", "✗ NE", "Korekcija nastavlja"],
  [10, "2026-05-20 10:00", 84.764, 84.902, 83.632, 84.067, 242372, "2.4×", "BEAR", "BULL", "✓ DA", "Pad iscrpljen → bounce"],
  [33, "2026-05-21 09:00", 85.063, 85.118, 84.133, 84.645, 175405, "1.7×", "BEAR", "BULL", "✓ DA", "Prodajna iscrpljenost"],
  [34, "2026-05-21 10:00", 84.645, 86.141, 84.280, 85.801, 319312, "3.2×", "BULL", "BULL", "✗ NE", "Breakout, trend nastavlja!"],
  [35, "2026-05-21 11:00", 85.801, 86.243, 85.376, 85.877, 256396, "2.6×", "BULL", "BULL", "✗ NE", "Trend momentum"],
  [36, "2026-05-21 12:00", 85.877, 86.774, 85.480, 86.439, 294031, "2.9×", "BULL", "BULL", "✗ NE", "Trend momentum"],
  [58, "2026-05-22 10:00", 86.227, 87.993, 86.147, 87.581, 510802, "5.1×", "BULL", "BEAR", "✓ DA", "MEGA bull (5×) → REVERSAL — distribucija!"],
  [84, "2026-05-22 20:00", 87.371, 87.371, 86.314, 86.570, 234990, "2.3×", "BEAR", "BULL", "✓ DA", "Pad → bounce"],
  [87, "2026-05-23 03:00", 86.607, 86.660, 84.511, 85.409, 551515, "5.5×", "BEAR", "BEAR", "✗ NE", "Cascade — MEGA pad nastavlja"],
  [88, "2026-05-23 04:00", 85.409, 85.580, 83.908, 84.499, 456860, "4.6×", "BEAR", "BULL", "✓ DA", "Iscrpljenost pada → bounce"],
];

const TIMEFRAME_COMPARISON = [
  ["Metrika", "1H Timeframe", "15m Timeframe", "Razlika", "Bolje?"],
  ["High-vol reversal stopa", "60% (BTC)", "56% (BTC)", "-4%", "1H (neznatno)"],
  ["Tipični bar range", "0.30–0.80%", "0.05–0.25%", "4× manji", "—"],
  ["MM sweep amplitude", "0.3–1.0%", "0.3–0.8%", "Slično", "—"],
  ["Min. SL za preživljavanje noisa", "2.0–2.5%", "0.8–1.5%", "1H proporcionalno isti", "Jednak"],
  ["SL hitovi pri 0.5% SL", "—", "GOTOVO UVIJEK", "—", "1H bol."],
  ["SL hitovi pri 1.0% SL", "—", "ČESTO (76,066 sweep!)", "—", "1H bol."],
  ["SL hitovi pri 2.5% SL", "Rijetko", "Gotovo uvijek", "—", "1H bol."],
  ["Fee troškovi po danu", "Baza", "4× baza", "+400%", "1H bol."],
  ["Signali dnevno po simbolu", "~2–5", "~8–20", "+4× signala", "15m više"],
  ["Lažni signali", "Manje", "4× više", "+400%", "1H bol."],
  ["MM stop hunting na TF", "Umjeren", "Agresivan", "Manji kapital za sweep", "1H bol."],
  ["Alts (HYPE/TAO) min SL", "5.5%", "Nema smisla (<2%)", "—", "1H bol."],
  ["UKUPNA OCJENA", "✅ BOLJE", "❌ GORE za naš bot", "—", "1H"],
];

const BTC_15M_SL_TEST = [
  ["Scenario", "Entry cijena", "SL %", "SL cijena", "Min Low reached", "SL Hit?", "Zarada/Gubitak", "Napomena"],
  ["15m — 0.5% SL", 77400, "0.5%", 77013, 75123, "❌ DA", "-0.5% × leverage", "Hit odmah na prvom wicked baru"],
  ["15m — 1.0% SL", 77400, "1.0%", 76626, 75123, "❌ DA", "-1.0% × leverage", "Hit na baru 48 (low 76,066)"],
  ["15m — 1.5% SL", 77400, "1.5%", 76245, 75123, "❌ DA", "-1.5% × leverage", "Hit na baru 51 (low 75,640)"],
  ["15m — 2.0% SL", 77400, "2.0%", 75912, 75123, "❌ DA", "-2.0% × leverage", "Low 75,188 prolazi SL"],
  ["1H — 2.5% SL", 77400, "2.5%", 75465, 75123, "⚠️ GOTOVO", "Ovisno o wick", "Low 75,188 — preživi ako nema deep wick"],
  ["1H — 2.5% SL + Ghost 0.5%", 77400, "2.5%", 75087, 75123, "✅ NE", "Trejd nastavlja", "Ghost SL štiti, pravi SL 75,465"],
];

const VOL_EXH_THRESHOLDS = [
  ["Tier", "Simboli", "Stari threshold", "Preporučeni threshold", "Razlog promjene"],
  ["Tier 0 — BTC", "BTCUSDT", "1.5×", "2.5×", "Najefikasniji market — tek 3× je pouzdan signal"],
  ["Tier 1 — Liquid", "ETHUSDT, SOLUSDT, XRPUSDT", "1.5×", "2.0×", "Visoka likvidnost, trend nastavlja pri 1.5-2×"],
  ["Tier 2 — Mid", "ADAUSDT, LINKUSDT, DOGEUSDT", "1.5×", "1.7×", "Srednja likvidnost — blago viši threshold"],
  ["Tier 3 — Alt", "NEARUSDT, SUIUSDT, APTUSDT, SEIUSDT, INJUSDT", "1.5×", "1.4×", "Tanje knjige — MM distribuira na nižem vol"],
  ["Tier 4 — Thin", "TAOUSDT, HYPEUSDT, JUPUSDT, ENAUSDT", "1.5×", "1.3×", "MM ima gotovo potpunu kontrolu tanjeg tržišta"],
  ["", "", "", "", ""],
  ["NAPOMENA:", "Promjena od 1.5× uniformnog na tiered threshold", "", "", ""],
  ["BTC benefiti:", "+15% više validnih ulaza u trend fazi", "", "", ""],
  ["Alt benefiti:", "Bolji filter distribucije kod tankih tokena", "", "", ""],
];

const MM_PHASE_GUIDE = [
  ["MM Faza", "Vol ratio", "ADX", "Chop", "Što MM radi", "Bot akcija", "VOL_EXH status"],
  ["AKUMULACIJA", "0.3–0.8×", "<25", ">61.8", "Tiho kupuje, nema pomaka", "NE ULAZI (ADX gate)", "OK — vol nizak"],
  ["MARKUP START", "0.8–1.2×", "25–35", "55–62", "Počinje podizati cijenu", "ČEKA signal", "OK — vol normalan"],
  ["MARKUP PEAK", "1.2–2.0×", ">35", "<55", "Ubrzava pomak, retail ulazi", "MOŽE UĆI (pullback)", "Threshold ovisno o tiru"],
  ["DISTRIBUCIJA BLAGA", "2.0–3.0×", ">35", "<55", "Prodaje na snazi dok retail kupuje", "BLOKIRAN (VOL_EXH)", "BLOKIRAN"],
  ["DISTRIBUCIJA JAKA", "3.0–6.0×", "bilo koji", "<50", "Masovna prodaja, pump završen", "BLOKIRAN", "BLOKIRAN"],
  ["PANIC / CRASH", "3.0–6.0×", ">30", "<50", "Retail paniči, MM kupuje natrag", "BLOKIRAN, čeka bounce", "BLOKIRAN"],
  ["REBOUND", "0.8–1.5×", ">25", "<61.8", "MM je kupio dno, cijena raste", "MOŽE UĆI (pullback vol=niski)", "OK"],
];

const CONCLUSIONS = [
  ["Pitanje", "Odgovor", "Povjerenje", "Akcija"],
  ["Je li 1.5× VOL_EXH ispravan za sve?", "NE — preagresivan za BTC/ETH/SOL u trendu", "Visoko", "Implementirati tiered threshold"],
  ["Treba li ići na 15m TF?", "NE — ista reversal stopa, 4× više SL hitova i troškova", "Visoko", "Ostati na 1H"],
  ["Funkcionira Ghost SL?", "DA — wicking do 0.3-0.5% ispod SL, Ghost 0.5% štiti", "Visoko", "Zadržati Ghost SL"],
  ["Koji simboli su najrizičniji?", "TAO, HYPE, JUP, ENA — tanko tržište, MM kontrolira", "Visoko", "Niži VOL_EXH threshold"],
  ["Kada ulaziti?", "Na TIHOM pullback (vol <0.8× avg) NAKON high-vol bara", "Srednje", "Entry timing poboljšanje"],
  ["Kada NE ulaziti?", "Vol prethodnog bara > tier threshold", "Visoko", "VOL_EXH gate aktivan"],
  ["Pravi problem s WR?", "Ulazimo u Fazu 2/3 (distribuciju) — VOL_EXH sada to blokira", "Visoko", "Monitor poboljšanja WR"],
  ["Je li RD (RSI Divergence) koristan?", "DA — hvata kraj MM distribucije (divergencija = slabljenje momenta)", "Srednje", "Zadržati RDIV signal"],
];

// ─── Kreiranje Excel workbooka ──────────────────────────────────────────────

const wb = XLSX.utils.book_new();

function addSheet(wb, data, sheetName, colWidths) {
  const ws = XLSX.utils.aoa_to_sheet(data);

  // Stil headera (bold)
  const headerRow = data[0];
  headerRow.forEach((_, colIdx) => {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: colIdx });
    if (!ws[cellRef]) return;
    ws[cellRef].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "1a3a5c" } },
      alignment: { horizontal: "center", wrapText: true },
    };
  });

  // Širine kolona
  if (colWidths) {
    ws["!cols"] = colWidths.map(w => ({ wch: w }));
  }

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

// Sheet 1 — Pregled simbola
addSheet(wb, SYMBOL_OVERVIEW, "1. Pregled simbola", [12,8,12,16,16,10,10,12,35]);

// Sheet 2 — BTC high-vol eventi
addSheet(wb, HIGHVOL_EVENTS_BTC, "2. BTC High-Vol Eventi", [6,18,8,8,8,8,8,8,8,12,10,40]);

// Sheet 3 — ETH high-vol eventi
addSheet(wb, HIGHVOL_EVENTS_ETH, "3. ETH High-Vol Eventi", [6,18,8,8,8,8,10,8,8,12,10,40]);

// Sheet 4 — SOL high-vol eventi
addSheet(wb, HIGHVOL_EVENTS_SOL, "4. SOL High-Vol Eventi", [6,18,8,8,8,8,10,8,8,12,10,45]);

// Sheet 5 — TF usporedba
addSheet(wb, TIMEFRAME_COMPARISON, "5. 1H vs 15m TF", [30,20,20,20,10]);

// Sheet 6 — SL test na 15m
addSheet(wb, BTC_15M_SL_TEST, "6. BTC SL Test 15m", [25,14,8,10,14,10,18,40]);

// Sheet 7 — VOL_EXH thresholds
addSheet(wb, VOL_EXH_THRESHOLDS, "7. VOL_EXH Thresholds", [15,35,16,22,45]);

// Sheet 8 — MM fazni vodič
addSheet(wb, MM_PHASE_GUIDE, "8. MM Fazni Vodic", [20,12,8,8,30,20,15]);

// Sheet 9 — Zaključci
addSheet(wb, CONCLUSIONS, "9. Zakljucci", [35,50,12,35]);

// ─── Spremi ────────────────────────────────────────────────────────────────

const outputPath = "./docs/MM_Algo_Analysis.xlsx";
XLSX.writeFile(wb, outputPath);
console.log(`✅ Excel kreiran: ${outputPath}`);
console.log(`   Sheets: ${wb.SheetNames.join(", ")}`);
