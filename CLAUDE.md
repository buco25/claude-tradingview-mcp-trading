# CLAUDE.md

Upute za Claude Code sesije na ovom repou. **Ovo je bot koji trguje pravim novcem na Bitgetu.**

## Prvo i najvažnije

1. **Nikad ne importaj `dashboard.js` u testu ili skriptu.** Na module-levelu diže HTTP server
   i kroz 15 s zove `runUltra4hStrategy()` — import bi **stvarno trgovao**.
   `bot.js` je siguran za import: ima `_isMain` guard, pa se `run()` pali samo kad je
   `bot.js` entry point (`process.argv[1]`). Jedini modul-level efekt je `loadSlCooldown()`
   (lokalni file read) i `mkdirSync(DATA_DIR)` — zato u testovima postavi
   `DATA_DIR` na temp dir da nikad ne piše u repo.

2. **Ne pokreći bota da "provjeriš" promjenu.** `npm start` / `node dashboard.js` /
   `node bot.js` plasiraju stvarne ordere. Za provjeru koristi regresijski test niže.

3. **`node --check` NE hvata nedefinirane varijable.** Hvata samo sintaksu. Nakon brisanja
   koda uvijek dodatno provjeri da nijedan obrisani identifikator nije ostao referenciran
   (stripaj komentare i stringove pa grepaj), i pokreni regresijski test.

4. **Sat utječe na signal.** `analyzeUltra` čita `new Date().getUTCDay()` i subotom/nedjeljom
   diže prag za +2 signala (`_weekendBoost`). Svaki test MORA zamrznuti sat, inače prolazi
   radnim danom a pada vikendom. Audit 04.10. je to otkrio na teži način.

## Testovi

```bash
node test/signal-regression.mjs            # regresija signalne jezgre (bez mreže, bez trgovanja)
node test/signal-regression.mjs --update   # prihvati trenutno stanje kao novi golden
```

Nakon **namjerne** promjene scoringa ili pragova test će pasti — to je točka. Pregledaj diff,
pa ako je promjena željena pokreni `--update` i commitaj novi fixture **zajedno** s promjenom
koda, da PR pokazuje što se stvarno promijenilo.

Test radi u "siromašnom" načinu jer `analyzeUltra` nije exportan. Jedna linija u `bot.js`
prebacuje ga u puni način (snima `bullScore`/`bearScore` i za NEUTRAL, prolazi kroz cfg
varijante s bustovima):

```js
export { analyzeUltra as analyzeUltraForTest };
```

## Arhitektura signala — što gdje živi

- `bot.js` → `analyzeUltra(candles, cfg)` je **jedini pravi** izračun signala.
  12 signala u `sigs` nizu, ali score broji samo indekse iz `TE_COMBO = [0,2,3,4,5,6,9,10]`
  (8 signala). **CVD (1), FVG (7), OB (8) i MDIV (11) ne ulaze u score nijednog simbola** —
  MDIV je bonus-only po dizajnu, ostala tri su naslijeđeni mrtvi slotovi.
- Pragovi: `MIN_CONFIRM_LONG/SHORT = _comboBase + max(vikend, chill, invalidacija, Wyckoff)`.
  Bustovi se **ne zbrajaju** — uzima se MAX aktivnog razloga. Momentum grana koristi
  `MOM_MIN_LONG/SHORT`, koji od 04.10. prate iste pragove.
- `dashboard.js` → `scanSymbol()` je **druga implementacija istog scoringa**, samo za prikaz.
  Formule su 04.10. usklađene s `bot.js` (slaganje 98.3% na 7 200 sintetičkih uzoraka), ali
  duplikat ostaje i **može se ponovno raziđeti**. Mijenjaš li signal u `bot.js`, provjeri i
  `scanSymbol`. Pravo rješenje je izvući izračun u `bot.js` i zvati ga iz dashboarda.
- Ulazni gate-ovi za 4H su u `evaluateU4hGates` — **jedini izvor istine**, dijele ga stvarni
  ulaz (`runUltra4hStrategy`) i dashboard badge (`previewU4hGates`). Mijenjaj filtere TAMO.

## Dnevne svijeće

Koristi **`granularity=1Dutc`**, ne `1D`. Bitgetov `1D` nije poravnat na UTC i daje drugu
dnevnu granicu. Sve u repou je na `1Dutc` od 04.10. (nalaz #7).

## Što je neauditirano

Audit 04.10. (issue #17) pokrio je **samo signalni/gate put**. Neauditirano je ostalo ono što
najdirektnije dira novac:

- izvršni put: `placeBitGetOrder`, `setupSymbol`, `getSafeLeverage`, `closeBitGetOrder`
- izlaz/monitoring: `softExitMonitor`, `checkPortfolioPositions`, `applyTrail`,
  `partialClosePosition`, `moveSLtoBreakEven`, `addToPyramid`
- sinkronizacija s Bitgetom: `syncPositionsFromBitget`, `ownBitgetQty`, `_otherStrategiesQty`
- računica: `getPortfolioEquity`, `fetchBitgetClosedPnl`, CSV pisanje/čitanje
- auth na dashboardu

Vidi `docs/AUDIT-2026-10-04.md` za nalaze i otvorene odluke.

## Konvencije

- Komentari i commit poruke su na hrvatskom, kao i ostatak repoa.
- Promjena koja mijenja **koji se tradeovi uzimaju** je promjena strategije, ne bug-fix.
  Takve idu kroz tjedni audit i uz eksplicitnu odluku vlasnika — ne tiho uz popravak.
- Pri brisanju mrtvog koda ostavi komentar **zašto** je bio mrtav; nekoliko nalaza iz audita
  su bili "napola uklonjeni" od prije, pa je trag bio presudan.
