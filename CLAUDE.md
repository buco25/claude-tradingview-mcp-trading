# CLAUDE.md

Upute za Claude Code sesije na ovom repou. **Ovo je bot koji trguje pravim novcem na Bitgetu.**

## Radni tok — gdje se nalazi prijavljuju i gdje se popravljaju

Tjedni audit (rutina, nedjeljom) okida se u sesiji koja **ima ovaj repo i pravo pisanja**, pa se
nalaz i popravak rješavaju **na istom mjestu**. Nema prepisivanja teksta između sesija.

```
audit nađe nalaz
  → zapiše ga u docs/AUDIT-2026-10-04.md (+ komentar na GitHub issue #17)
  → vlasnik kaže "popravi #N"
  → popravak + npm test  (u sesiji koja ima repo)
  → vlasnik odobri push
```

Pravila koja to drže na mjestu:

- **Nalazi žive u `docs/AUDIT-2026-10-04.md`, ne u chatu.** Numeracija je neprekinuta kroz
  prolaze (zadnji je #18). Nikad ne počinji numeraciju od 1 i ne prijavljuj ponovno nalaz koji
  je tamo već zapisan — ako je regresirao, reci da je regresija.
- **Predaja drugoj sesiji je datoteka, ne poruka.** Ako posao preuzima druga sesija, uputa joj je
  "pročitaj `CLAUDE.md` i `docs/AUDIT-2026-10-04.md`, pa popravi #N" — ne zalijepljeni blok.
  Blok zalijepljen iz druge sesije opisuje stanje KOJE TAMO POSTOJI; ako taj commit nije pushan,
  uputa se referira na kod koji primatelj ne vidi. To se 04.10. dogodilo i zaustavilo posao.
- **Nikad ne piši uputu koja pretpostavlja nepushani commit.** Prvo push (uz odobrenje), pa uputa.
- **Način dopuštenja postavlja površina koja je pokrenula sesiju** i ne mijenja se iz chata, ni
  zastavicom ni `settings.json`-om. Kad push ili izmjena budu blokirani, **pitaj vlasnika i čekaj
  njegovo "odobravam" u ovom chatu** — to je mehanizam, ne zaobilaženje. Ne ponavljaj blokiranu
  akciju bez te riječi, i ne traži drugi put do istog ishoda.
- **Odobrenje vrijedi za jednu akciju.** "Odobravam push" za jedan commit ne pokriva sljedeći.

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

## Zašto "momentum prag +1" NE radi (probano i vraćeno 04.10.)

Pokušaj `MOM_MIN_LONG/SHORT = MIN_CONFIRM_LONG/SHORT + 1` (commit 73735e0, vraćen u f3def0d)
**ugasio je momentum u cijelosti**: u regresijskom testu momentum ulazi 468 → 0, a SHORT ukupno
258 → 31 (bot postaje gotovo samo-long). Nemoj to ponovno pokušavati s drugim pragom.

- `momBull = bullCnt + _pwhMstrBonusBull` je **podskup** `bullScore` (koji ima i Wyckoff, MDIV,
  WHALE, BMSB bonuse), pa uvijek vrijedi `momBull ≤ bullScore`.
- Pullback grana (`bullScore >= MIN_CONFIRM`) **uvijek radi `return`** — i kad zone-confluence
  odbije ulaz (vraća NEUTRAL "PBK ... blokiran"), ne propušta slučaj dalje u momentum.
- Momentum se zato izvršava samo kad je `bullScore < MIN_CONFIRM`. Svaki momentum prag
  `>= MIN_CONFIRM` je strukturno nedostižan; prag `< MIN_CONFIRM` vraća rupu iz nalaza #1
  (vikend 5/8 ulazi kao momentum, bez zone).
- Zaključak: "strožiji momentum" traži **drugačiji score** (vlastiti signal set, nalaz #2), ne
  drugačiji prag. Prije toga neka tjedni job s pravim podacima kaže isplate li se momentum
  uopće. Regresijski test je ovo uhvatio — pokreni `npm test` prije svake promjene praga.

## Leverage i likvidacija

Redoslijed okidanja mora biti **soft SL → ghost SL (+0.5%) → likvidacija**. `getSafeLeverage(slPct)`
je jedini izvor te računice; `liqDistPct(lev) = (1/lev − 0.005) × 100`.

- `rules.json` → `symbol_sltp.leverage` **nije** autoritet. `setupSymbol` ga od 04.10. (nalaz #19)
  spušta na `getSafeLeverage(slPct)` kad je veći, i nikad ne diže. Prije toga je BTC s 52× uz SL
  1.5% imao liq na 1.42% — **unutar** stopa, pa soft SL nikad nije mogao odraditi.
- Dizanje leveragea u `rules.json` ne povećava poziciju. Sizing je risk-based
  (`notional = riskAmount / slPct`), pa leverage mijenja samo zaključanu marginu. Ako želiš veću
  poziciju, dira se rizik, ne leverage.
- `slPct >= 19.5%` je strukturno neizvedivo: `getSafeLeverage` ima pod na 5×, čija je liq na
  19.5%. Takav ulaz `liqBlocksEntry` odbija (oba puta + `setupSymbol` kao zadnja mreža).

## Equity, rizik i stropovi

- **`equityForSizing(pid, startCapital)` je jedini put do equityja za sizing.** Vraća
  `{ equity, src, live }` i `src` MORA ići u log ulaza — bez toga se iz logova ne vidi po kojoj
  je osnovici trade uzet (nalaz #20 je upravo tako ostao nevidljiv).
- **`fetchBitgetEquity()` vraća objekt, ne broj.** `{ ok:true, equity:0 }` znači "račun je
  stvarno prazan" i drawdown zaštita se na tome MORA okinuti; `{ ok:false }` znači "ne znamo"
  i tek tad ide CSV procjena. Nikad ne spajaj ta dva slučaja u `null` (nalaz #21).
- **`ACCOUNT_START_CAPITAL` je jedina polazna vrijednost.** Račun je jedan. `ultra_4h` nije
  portfolio u `buildPortfolios`, pa svaki novi `startCapital` fallback mora ići kroz tu
  konstantu — ne kroz novi lokalni broj (tako je nastao nalaz #20, a `dashboard.js` je držao
  vlastitu kopiju `$1000`).
- **Stropovi na rizik, od najužeg prema najširem:** `RISK_PCT*` po tradeu →
  `MAX_PYRAMID_RISK_PCT` (5%) po simbolu → `MAX_PORTFOLIO_RISK_PCT` (20%) na sumu preko OBJE
  strategije → `MAX_OPEN_1H/4H` na broj pozicija. Dodaješ li novi ulazni put, provjeri sva
  četiri; sizing stropovi se provjeravaju **prije** `checkDailyLimit`, koji ima *side effect*
  (inkrementira dnevni brojač), pa blokiran ulaz ne smije proći kroz njega.
- **Zaštite moraju postojati na OBA puta.** `run()` (1H) i `runUltra4hStrategy` (4H) se pozivaju
  neovisno — 4H iz schedulera u `dashboard.js`. Drawdown i dnevni limit su do 04.10. postojali
  samo u `run()` (nalaz #23). Blokiraju se **novi ulazi**, nikad upravljanje postojećim
  pozicijama (izlazi i trail moraju raditi i kad su ulazi zabranjeni).

## Candle patterns (05.10.)

`detectCandlePattern(candles)` u `bot.js` je jedini izvor formacije, i čita **zatvorene** svijeće
(n-2, n-3; n-1 se još formira). Ima dvije odvojene uloge — ne miješaj ih:

- **Mjerenje:** svaki ulaz upisuje formaciju u CSV stupac `CandlePat` (indeks 22, na kraju retka).
  Ne utječe na odluku. Nakon ~100 tradeova usporedi WR po formaciji prije bilo kakve nove odluke.
- **Filter:** blokira samo **jak engulfing protiv smjera** (tijelo ≥ `CANDLE_ENGULF_MIN_ATR` × ATR14):
  LONG nakon `BEAR_ENGULF`, SHORT nakon `BULL_ENGULF`. Hammer/shooting star/doji se samo bilježe.
  Živi u `evaluateU4hGates` (4H + dashboard badge) i u `run()` iza velocity gatea (1H, s istim
  `_stratBypass` izuzećem). Isključuje se jednom konstantom `CANDLE_FILTER_ENABLED`.

Retrospektiva na 109 povijesnih ulaza (svibanj, `bitget_rebuild.csv`): filter bi blokirao 3 (1H) /
1 (4H) — inertan, uzorak premalo velik za zaključak u bilo kojem smjeru. Nova formacija **ne ide u
`analyzeUltra`/score** (to bi mijenjalo golden i signalnu jezgru); ako podaci kažu da vrijedi, ide
kroz tjedni audit uz odluku vlasnika.

## Bitget auth

`bitgetHeaders(method, path, body)` u `bot.js` je **jedino** mjesto koje sastavlja potpisane
headere, i izvezeno je za `dashboard.js`. Nikad ne sastavljaj headere ručno:

- samo taj helper dodaje `x-simulated-trading` u demo modu. Do 04.10. ga je imao samo
  `bitgetPost`, pa je uz `BITGET_DEMO=true` bot **pisao na demo a čitao živi račun** — equity,
  pozicije, fillove i zatvoreni P&L (nalaz #22).
- timestamp se izračuna i potpiše u istom pozivu, pa `ts` i `sign` ne mogu raziđeti.

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
- računica: `fetchBitgetClosedPnl`, CSV pisanje/čitanje
- auth na dashboardu

Equity put (`getPortfolioEquity`, `fetchBitgetEquity`) je auditiran 04.10. — nalazi #20–#24,
svi popravljeni.

Vidi `docs/AUDIT-2026-10-04.md` za nalaze i otvorene odluke.

## Konvencije

- Komentari i commit poruke su na hrvatskom, kao i ostatak repoa.
- Promjena koja mijenja **koji se tradeovi uzimaju** je promjena strategije, ne bug-fix.
  Takve idu kroz tjedni audit i uz eksplicitnu odluku vlasnika — ne tiho uz popravak.
- Pri brisanju mrtvog koda ostavi komentar **zašto** je bio mrtav; nekoliko nalaza iz audita
  su bili "napola uklonjeni" od prije, pa je trag bio presudan.
