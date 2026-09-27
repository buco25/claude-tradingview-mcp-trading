# Fix spec — Signal/Gate Code Audit (27.09.2026)

**Izvor:** GitHub issue #7 (`Signal/Gate Code Audit - 2026-09-27`), nalazi 1–4 + 11.
**Za koga:** agent koji primjenjuje popravke. Ovaj dokument je samodostatan — ne treba čitati issue.
**Repo:** `buco25/claude-tradingview-mcp-trading` · svi putevi su relativni na korijen repoa.

---

## ⚠️ Prije nego počneš — ovo je LIVE bot koji trguje pravim novcem

1. **Ne pokreći bota, ne zovi Bitget/Bybit API, ne otvaraj/zatvaraj pozicije.** Zadatak je čisto uređivanje koda.
2. **Radi na branchu**, ne na `main`. Predloženo ime: `fix/signal-gate-audit-2609`.
3. **Dva odvojena commita** (vidi "Plan commitova" na kraju). Fix 1 mijenja *kada* strategija skenira, pa mora biti zasebno da ga se može vratiti bez diranja ostalog.
4. **Ne mijenjaj ni jedan prag, konstantu ili formulu osim onih doslovno navedenih ispod.** Svaki nalaz je bug u smislu "kod radi nešto različito od onoga što njegov vlastiti komentar/naziv/caller implicira" — ne tuning.
5. **Ne diraj `docs/`, `rules.json`, `*.csv`, `*.json` state fajlove, `.pine` fajlove ni backtestove.** Mijenja se **samo `bot.js`**.
6. Nakon svake izmjene pokreni `node --check bot.js`. Na kraju i `node --check dashboard.js` (ne mijenjamo ga, ali provjeri da nisi slučajno razbio import).

---

## Kontekst arhitekture (treba ti za razumijevanje fixeva)

Tri stvari koje nisu očite iz naziva:

- **`synapse_t` nije 15m strategija.** `pDef.timeframe` je `"15m"` samo da `shouldRunNow()` okida svakih 15 min; stvarna analiza ide na **1H** svijećama (`bot.js` ~6717: `const candleTf = pDef.strategy === "synapse_t" ? "1H" : pDef.timeframe;`).
- **`ULTRA-4H` (`pid = "ultra_4h"`) dijeli `analyzeUltra` s glavnim botom**, preko `analyzeUltra4hFull` → `analyzeUltraPullback` → `analyzeUltra`. Zato svaki bug u `analyzeUltra` udara na obje strategije.
- **`_finalizeUltra4hSignal` je "uski grlić"** između `analyzeUltra` i ULTRA-4H ulazne logike: gradi **novi objekt s fiksnom listom polja**, pa svako polje koje `analyzeUltra` postavi a ono ne prepiše — tiho se izgubi. Fixevi 2 i 11 su oba instanca toga.

---

## FIX 1 — ULTRA-4H ulazni scan se izvršava do 5× po 4H svijeći

### Što je krivo

`runUltra4hStrategy()` štiti sekciju novih ulaza s:

```js
if (!shouldRunNow(ULTRA4H_TF, utcNow.getUTCHours(), utcNow.getUTCMinutes())) return;
```

`shouldRunNow("4H", h, m)` vraća `utcMin < 5 && utcHour % 4 === 0` (`bot.js` ~2202). Taj 5-minutni prozor je opravdan u vlastitom komentaru funkcije **za caller koji se zove svakih 5 minuta** ("Prozor od 5 min garantira da svaki 5-min bot run uvijek pogodi svaki TF... Dokaz: za step=5 i prozor=5, u svakom TF-bloku postoji točno jedan run s min%TF < 5").

Ali `runUltra4hStrategy()` se zove **svakih 60 sekundi** iz `dashboard.js` (~5085, `setInterval(..., 60 * 1000)`). Dakle u 00:00, 00:01, 00:02, 00:03, 00:04 uvjet je istinit — ulazna sekcija se izvrti **5×**.

To je u direktnoj kontradikciji s dva komentara u istoj funkciji:
- `bot.js` ~6078: `// ── 2) Novi ulazi — samo na zatvaranju 4H svijeće`
- `bot.js` ~6009: `// Zove se SAMO na ulaznom skeniranju (jednom na 4h svijecu), ne na monitoringu.`

**Posljedica:** `let _newEntriesThisU4hScan = 0;` (`bot.js` ~6122) se reinicijalizira pri **svakom** pozivu, pa rate-limit `MAX_NEW_ENTRIES_PER_SCAN = 2` postaje efektivno **10 novih pozicija po 4H svijeći**. Incident koji je već zapisan u kodu na ~6153 — *"zato je 23.09. u 4 minute otvorio 8 istovremenih LONG pozicija"* — poklapa se s ovim prozorom točno (8 pozicija ≈ 4 prolaza × 2). Tada je to pripisano nedostatku same-dir capa; same-dir cap je u međuvremenu dodan, ali **5× ponavljanje scana nije popravljeno**.

### Izmjena

**1a.** Dodaj module-level varijablu. Umetni **odmah nakon** linije:

```js
const ULTRA4H_RSI_SHORT_MIN = 30;  // ne ulazi SHORT ako je RSI(14) ispod ovoga
```

ovo:

```js
// 27.09. (audit nalaz #1): shouldRunNow("4H") vraca true za CIJELI prozor utcMin<5, sto je
// single-fire samo za 5-minutnog callera (vidi "Dokaz" komentar u shouldRunNow). ULTRA-4H se
// zove svakih 60s (dashboard.js setInterval), pa je ulazna sekcija isla 5× po svijeci i
// MAX_NEW_ENTRIES_PER_SCAN=2 je efektivno bio 10/svijeca (vidi incident 23.09. nize).
// Bucket = indeks 4H bloka; ulazni scan se izvrsava tocno jednom po bloku.
let _lastU4hEntryBucket = null;
```

**1b.** Zamijeni:

```js
  // ── 2) Novi ulazi — samo na zatvaranju 4H svijeće ─────────────────────────
  const utcNow = new Date();
  if (!shouldRunNow(ULTRA4H_TF, utcNow.getUTCHours(), utcNow.getUTCMinutes())) return;
```

s:

```js
  // ── 2) Novi ulazi — samo na zatvaranju 4H svijeće ─────────────────────────
  const utcNow = new Date();
  if (!shouldRunNow(ULTRA4H_TF, utcNow.getUTCHours(), utcNow.getUTCMinutes())) return;
  // 27.09. (audit nalaz #1): vlastiti once-per-candle guard — shouldRunNow-ov 5-min prozor
  // nije dovoljan na 60s kadenci, vidi _lastU4hEntryBucket. Bucket se "potrosi" ODMAH, prije
  // cap provjera nize: ako capovi blokiraju, ponavljanje scana u istoj svijeci nista ne
  // mijenja (capovi se u te 4 minute nece otvoriti), a rate-limit mora ostati 2/svijeca.
  const _u4hBucket = Math.floor(Date.now() / (4 * 60 * 60 * 1000));
  if (_lastU4hEntryBucket === _u4hBucket) return;
  _lastU4hEntryBucket = _u4hBucket;
```

### Napomene / granični slučajevi

- Guard je **in-memory**, namjerno. Restart procesa unutar istog 5-minutnog prozora dopustio bi još jedan scan. To je prihvatljivo: znatno manje rizično od uvođenja novog state fajla na disku, a prozor je 5 min u 4 h. **Ne dodavaj file-based persistenciju** bez da pitaš vlasnika repoa.
- `Math.floor(Date.now() / 4h)` poravnava se na UTC 4H granice jer je Unix epoch 00:00 UTC — isti blokovi koje `utcHour % 4 === 0` cilja. Ne koristi `utcNow.getUTCHours()` za bucket; `Date.now()` je jednostavniji i ne trpi od prijelaza dana.
- **Sekcija 1 (monitoring/invalidacija) mora ostati na 60s** — ne pomiči guard iznad nje. Guard ide isključivo oko sekcije 2.

### Verifikacija

- `node --check bot.js` prolazi.
- Pročitaj funkciju i potvrdi: petlja invalidacije (`for (const pos of loadPositions(ULTRA4H_PID))`) je **iznad** guarda, `const rules = JSON.parse(...)` i sve ispod je **ispod**.
- Potvrdi da `_lastU4hEntryBucket` nije deklariran unutar funkcije (mora preživjeti pozive).

---

## FIX 2 — ULTRA-4H uzima PUNI rizik na soft-zone ulazima koje glavni bot prepolovi

### Što je krivo

`analyzeUltra` označava ulaze propuštene kroz ADX-soft ili MOM-soft zonu s `_halfSize` — na 6 mjesta: `bot.js` 3364, 3380, 3438, 3443, 3452, 3457. Semantika je eksplicitna u komentaru na ~3447: *"score tek 1 ispod MOM_MIN → ne blokiraj, uđi na pola rizika umjesto potpunog blocka"*.

`run()` to poštuje (`bot.js` ~7620):

```js
const _softSizeMult = result._halfSize ? 0.5 : 1;
let tradeSize  = (riskAmount / (slPct / 100)) * _totalMult * _softSizeMult;
```

`_finalizeUltra4hSignal` **ne prenosi `_halfSize`**, i `runUltra4hStrategy` ga nigdje ne čita. Rezultat: ULTRA-4H ulaz kroz soft zonu ide na **puni `RISK_PCT`** — obrnuto od onoga za što je ta grana napravljena.

### Izmjena

**2a.** U `_finalizeUltra4hSignal`, u **oba** return objekta dodaj `_halfSize` (i `_strategy`, vidi FIX 11 — radi ih u istom potezu).

Zamijeni:

```js
  if (result.signal === "LONG") {
    return { signal: "LONG", price, sl: price - slDist, tp: price + slDist * ULTRA4H_RR, slPct, tpPct, bullScore: result.bullScore, bearScore: result.bearScore, isMomentum: result.isMomentum === true, sigMask: result.sigMask ?? null };
  }
  return { signal: "SHORT", price, sl: price + slDist, tp: price - slDist * ULTRA4H_RR, slPct, tpPct, bullScore: result.bullScore, bearScore: result.bearScore, isMomentum: result.isMomentum === true, sigMask: result.sigMask ?? null };
```

s:

```js
  // 27.09. (audit nalaz #2 i #11): _halfSize i _strategy su se tiho gubili jer ova funkcija
  // gradi NOVI objekt s fiksnom listom polja. Posljedice su bile: (a) ULTRA-4H je soft-zone
  // ulaze sizeao na PUNI rizik dok ih run() prepolovi (vidi _softSizeMult u run()), i (b)
  // entryMode je za zonske setupe uvijek padao na MOM/PBK jer sig._strategy nije postojao.
  if (result.signal === "LONG") {
    return { signal: "LONG", price, sl: price - slDist, tp: price + slDist * ULTRA4H_RR, slPct, tpPct, bullScore: result.bullScore, bearScore: result.bearScore, isMomentum: result.isMomentum === true, sigMask: result.sigMask ?? null, _halfSize: result._halfSize === true, _strategy: result._strategy ?? null };
  }
  return { signal: "SHORT", price, sl: price + slDist, tp: price - slDist * ULTRA4H_RR, slPct, tpPct, bullScore: result.bullScore, bearScore: result.bearScore, isMomentum: result.isMomentum === true, sigMask: result.sigMask ?? null, _halfSize: result._halfSize === true, _strategy: result._strategy ?? null };
```

**2b.** Primijeni ga na sizing u `runUltra4hStrategy`. Zamijeni:

```js
      notional *= _macroSizeMult4;
```

s:

```js
      notional *= _macroSizeMult4;
      // 27.09. (audit nalaz #2): ADX/MOM soft-zone ulaz → pola rizika, isto kao run()
      // (_softSizeMult ~7620). Primjenjuje se ODVOJENO, nakon makro multiplikatora, jer
      // halvira konacan iznos i ne smije se utopiti u njih.
      if (sig._halfSize === true) {
        notional *= 0.5;
        console.log(`  🟡 [ULTRA-4H][SOFT] ${symbol} — ADX/MOM soft-zone ulaz → pozicija ×0.5 (pola rizika)`);
      }
```

### Napomene

- **Zadrži poredak.** `notional *= 0.5` mora biti **nakon** `notional *= _macroSizeMult4` i **prije** `_minNotional` clampa (`if (notional < _minNotional) notional = _minNotional;`). Tako `ULTRA4H_MIN_NOTIONAL` ostaje zadnja riječ, isto kao u `run()`.
- **Ne dodavaj 0.5 floor na `_macroSizeMult4`.** `run()` ima taj floor (`Math.max(_rawMult, 0.5)`), ULTRA-4H ga nema — to je zasebna razlika između strategija i **nije** dio ovog zadatka.
- `result._halfSize === true` (a ne `?? false`) je namjerno: `analyzeUltra` ga postavlja na `_adxSoft` koji može biti `false`, i ne postavlja ga uopće na zonskim granama.

### Verifikacija

- `grep -c "_halfSize" bot.js` → **13 linija** nakon fixa (prije: 10). Raspored: 6 u `analyzeUltra` (3364, 3380, 3438, 3443, 3452, 3457), 2 nova u `_finalizeUltra4hSignal`, 1 nova u ULTRA-4H sizing bloku, i 4 postojeće u `run()` (7620, 7623, 7670 `entryMode`, 7680 scan log).
- `node --check bot.js` prolazi.

---

## FIX 3 — oba loss-streak cooldowna čitaju timestamp bez vremena, pa istječu prerano

### Što je krivo

CSV header (`bot.js` ~4627) je:

```
Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net P&L,SL,TP,Order ID,Mode,Portfolio,Notes,SigMask,EntryMode,BTCRegime1H,BTCRegime4H,Night,Weekend
```

Dakle `cols[0]` = **samo datum** (`2026-09-27`), a vrijeme je u `cols[1]`. Ostatak koda to spaja korektno — npr. `bot.js` ~5774 (`checkCircuitBreaker`) i ~4060 (`autoFixCsvFromBitget`) koriste ``new Date(`${cols[0]}T${cols[1]}Z`)``.

Ali `getSymbolSideLossStreak` i `getDirLossStreak` rade `new Date(cols[0]).getTime()`, što daje **ponoć UTC tog dana** — do 24 h prije stvarnog izlaska.

**Posljedice:**
- `getDirLossStreak`: blokada je `count >= DIR_STREAK_MAX && Date.now() - lastTs < DIR_COOLDOWN_MS` gdje je `DIR_COOLDOWN_MS = 4h`. Pošto je `lastTs` ponoć, `Date.now() - lastTs` je već > 4 h za svaki gubitak zatvoren nakon 04:00 UTC → **gate "3 uzastopna SL-a istog smjera → smjer blokiran 4h" (call site ~7031) je mrtav veći dio dana.**
- `getSymbolSideLossStreak`: prozor je 24 h, pa se skraćuje za do 24 h. Gubitak u 23:00 prestaje blokirati u 00:30 sljedeći dan (1.5 h kasnije), umjesto za 24 h. Call site ~7041.

### Izmjena

Dvije identične jednolinijske zamjene. **Oba mjesta izgledaju gotovo isto — pazi da napraviš oba**, razlikuju se po komentaru na `break` liniji i po `blocked` izrazu ispod.

**3a. U `getSymbolSideLossStreak`** (blok bez komentara na `break`, `blocked` koristi `count >= 2`), zamijeni:

```js
      if (pnl >= 0) break;
      count++;
      if (!lastTs) lastTs = new Date(cols[0]).getTime() || 0;
    }
    const blocked = count >= 2 && Date.now() - lastTs < 24 * 60 * 60 * 1000;
```

s:

```js
      if (pnl >= 0) break;
      count++;
      // 27.09. (audit nalaz #3): bilo new Date(cols[0]) — cols[0] je SAMO datum, vrijeme je
      // u cols[1], pa je lastTs bio ponoc UTC (do 24h prije stvarnog izlaska) i 24h prozor
      // ispod se skracivao za toliko. Isti spoj koji koriste checkCircuitBreaker i autoFix.
      if (!lastTs) lastTs = new Date(`${cols[0]}T${cols[1] || "00:00:00"}Z`).getTime() || 0;
    }
    const blocked = count >= 2 && Date.now() - lastTs < 24 * 60 * 60 * 1000;
```

**3b. U `getDirLossStreak`** (blok s komentarom `// win tog smjera prekida niz`, `blocked` koristi `DIR_STREAK_MAX`), zamijeni:

```js
      if (pnl >= 0) break;                       // win tog smjera prekida niz
      count++;
      if (!lastTs) lastTs = new Date(cols[0]).getTime() || 0;
    }
    const blocked = count >= DIR_STREAK_MAX && Date.now() - lastTs < DIR_COOLDOWN_MS;
```

s:

```js
      if (pnl >= 0) break;                       // win tog smjera prekida niz
      count++;
      // 27.09. (audit nalaz #3): bilo new Date(cols[0]) — samo datum, pa je lastTs bio ponoc
      // UTC i 4h DIR_COOLDOWN_MS je istekao za svaki SL zatvoren nakon 04:00 UTC → gate je
      // bio mrtav veci dio dana. Isti spoj koji koriste checkCircuitBreaker i autoFix.
      if (!lastTs) lastTs = new Date(`${cols[0]}T${cols[1] || "00:00:00"}Z`).getTime() || 0;
    }
    const blocked = count >= DIR_STREAK_MAX && Date.now() - lastTs < DIR_COOLDOWN_MS;
```

### Napomene

- `|| "00:00:00"` fallback je za povijesne retke iz starijeg formata kojima `cols[1]` može biti prazan — tada se ponaša kao prije, što je ispravno degradiranje.
- `|| 0` na kraju **zadrži** — čuva od `NaN` na pokvarenom retku.
- **Ne mijenjaj `DIR_STREAK_MAX`, `DIR_COOLDOWN_MS`, ni `count >= 2`.** Ovo je fix čitanja timestampa, ne pragova. Očekuj da će nakon ovog fixa oba cooldowna **stvarno blokirati** češće nego prije — to je namjena, ne regresija.

### Verifikacija

- `grep -n "new Date(cols\[0\])" bot.js` → **mora vratiti 0 rezultata.**
- `grep -c 'T\${cols\[1\]' bot.js` → treba porasti za 2.
- `node --check bot.js` prolazi.

---

## FIX 4 — `MOM_MIN` ignorira `_minSigOverride` i sve minSig boostove

### Što je krivo

Pullback grana `analyzeUltra` računa prag tako da uzme bazu i **digne** je za aktivne "oprez" boostove (`bot.js` ~3151–3155):

```js
const _comboBase = cfg._minSigOverride ?? _combo?.minSig ?? minSig;
const MIN_CONFIRM      = _comboBase + Math.max(_weekendBoost, _chillBoost);
const MIN_CONFIRM_LONG  = _comboBase + Math.max(_weekendBoost, _chillBoost, _invalBoost, _wyckoffLongBoost);
const MIN_CONFIRM_SHORT = _comboBase + Math.max(_weekendBoost, _chillBoost, _wyckoffShortBoost);
```

Momentum grana koristi golo:

```js
const MOM_MIN = _combo?.minSig ?? 5;
```

**Dvije posljedice, obje tihe:**

1. **`_minSigOverride` ne stiže do momentum grane.** To polje je dodano u prošlom auditu (nalaz #5) baš zato što je `cfg.minSig` bio no-op; bounce mode ga postavlja na 3 (`bot.js` ~6746: `{ ...pDef.params, _minSigOverride: 3 }`). Pullback grana ga čita, momentum ne.
2. **Nijedan boost ne vrijedi za MOMENTUM ulaz** — ni vikend `+2`, ni CHILL `+1`, ni BTC-invalidacija `+1`, ni Wyckoff SOS/SOW-pending `+2`. Vikend momentum ulaz prolazi na neboostanoj bazi, a MOM soft grana (~3450) prima čak `MOM_MIN - 1`. To je direktno protiv post-mortema zbog kojeg je vikend boost uveden (`bot.js` ~3138: *"svi likvidirani ulazi bili subotnji minimalni 5/8"*).

Komentar jednu liniju iznad — *"Viši prag (MOM_MIN) jer su momentum ulazi rizičniji od pullback ulaza"* — je **neistinit**: `MOM_MIN` je jednak pullback **bazi**, i strogo je niži od `MIN_CONFIRM_LONG`/`_SHORT` kad je ijedan boost aktivan.

### Izmjena

Zamijeni:

```js
  // Viši prag (MOM_MIN) jer su momentum ulazi rizičniji od pullback ulaza.
  const MOM_MIN = _combo?.minSig ?? 5;  // = combo minSig (4/5 za optimizirane simbole)
```

s:

```js
  // 27.09. (audit nalaz #4): bilo `_combo?.minSig ?? 5` — golo, pa (a) bounce-mode
  // _minSigOverride nikad nije stizao do momentum grane (isti bug koji je 21.09. popravljen
  // SAMO za pullback, vidi _comboBase), i (b) NIJEDAN oprez-boost (vikend +2, CHILL +1,
  // BTC-invalidacija +1, Wyckoff pending +2) nije vrijedio za MOMENTUM ulaz — vikend
  // momentum je prolazio na neboostanoj bazi, protiv post-morterna zbog kojeg je vikend
  // boost i uveden. Sad dijeli istu bazu i isti max-boost obrazac kao MIN_CONFIRM.
  // NAPOMENA: stari komentar je tvrdio "visi prag jer su momentum ulazi rizicniji" — to
  // nije bilo tocno ni prije (MOM_MIN == pullback baza), a nije ni sad. Ako se zeli STVARNO
  // visi prag za momentum, to je promjena scoringa i ide kroz zaseban zahtjev.
  const MOM_MIN = _comboBase + Math.max(_weekendBoost, _chillBoost);
```

I u istom bloku zamijeni stari (netočni) komentar iznad — zamijeni:

```js
  // Isti 13 signala ali 6 reversanih vraćamo u originalnu (trend-following) logiku.
```

s:

```js
  // NAPOMENA (27.09. audit nalaz #5, NIJE popravljeno u ovom zadatku): ovaj komentar je
  // tvrdio "Isti 13 signala ali 6 reversanih" — momSigs je u stvarnosti 12 elemenata i
  // ELEMENT-ZA-ELEMENT identican nizu `sigs` gore (nista nije invertirano). Momentum grana
  // se od pullback grane razlikuje samo time sto ISPUSTA bonuse (Wyckoff/MDIV/whale/BMSB)
  // i zone-confluence gate. Je li inverzija ikad bila namjera — otvoreno pitanje za vlasnika.
```

### Napomene

- `_comboBase`, `_weekendBoost` i `_chillBoost` su **već u scopeu** na tom mjestu (deklarirani ~3135–3151, momentum grana je ~3390). Ne premještaj deklaracije.
- Koristi **`MIN_CONFIRM` obrazac** (`max(_weekendBoost, _chillBoost)`), **ne** `MIN_CONFIRM_LONG`/`_SHORT`. `MOM_MIN` je jedna vrijednost za oba smjera, a smjerni boostovi (`_invalBoost`, `_wyckoffLongBoost`, `_wyckoffShortBoost`) nisu simetrični pa bi zahtijevali razdvajanje `MOM_MIN` na dvije varijable i mijenjanje 4 `if`-a + 2 reason stringa. To je veći zahvat i **nije** dio ovog zadatka — ako procijeniš da treba, prijavi to kao zapažanje, ne radi ga.
- `MOM_SOFT_BAND` (`= 1`) ostaje netaknut; on se odnosi na `MOM_MIN` pa se automatski pomiče s njim.
- Očekivana promjena ponašanja: **manje momentum ulaza vikendom i u CHILL modu**, i bounce mode sad stvarno spušta momentum prag na 3. Oboje je namjena.

### Verifikacija

- `grep -n "MOM_MIN" bot.js` → deklaracija + 4 `if`-a (~3436, 3441, 3450, 3455) + 2 reason stringa (~3453, 3458) + `whyNot` (~3480) + komentar na ~128. Nijedan `if` se ne mijenja.
- `node --check bot.js` prolazi.
- Pročitaj `_comboBase` deklaraciju i potvrdi da je **iznad** nove `MOM_MIN` linije.

---

## FIX 11 — ULTRA-4H ne može zapisati SWEEP/RANGE `entryMode`

**Već je pokriven izmjenom 2a** (`_strategy: result._strategy ?? null`). Ovdje samo objašnjenje zašto, da ne ispadne da je slučajno dodano.

`bot.js` ~6283 piše:

```js
mode: "LIVE", entryMode: sig._strategy ?? (sig.isMomentum ? "MOM" : "PBK"),
```

ali `sig` dolazi iz `_finalizeUltra4hSignal`, koji `_strategy` nije prenosio → uvijek `undefined` → zonski ULTRA-4H ulaz se logira kao `MOM`/`PBK`. Isti problem je za 15m putanju riješen commitom `2ac4d8b`; tamo (`bot.js` ~7670) se čita `result._strategy` sa sirovog rezultata i radi ispravno.

`VA-REV` nije pogođen — gated je s `_enableVaRev` koji postavlja samo 15m fallback poziv.

**Ništa dodatno ne treba mijenjati na ~6283** — taj izraz je ispravan, samo mu je ulaz bio prazan.

---

## Plan commitova

**Commit 1** — `fix: soft-zone half-risk, loss-streak timestamp i MOM_MIN boostovi (audit #2/#3/#4/#11)`

Sadrži FIX 2, FIX 3, FIX 4 (i FIX 11 kroz 2a). Sve mehaničko, bez promjene *kada* se kod izvršava.

**Commit 2** — `fix: ULTRA-4H ulazni scan jednom po 4H svijeci, ne 5× (audit #1)`

Sadrži samo FIX 1. Zasebno da se može revertirati bez diranja ostalog, i da se po logovima vidi promjena kadence.

Oba commita moraju završiti s:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014pQYbQucLpFNuKhzE2idFK
```

**Ne otvaraj PR** ako vlasnik to izričito ne zatraži. Push na branch, prijavi diff.

---

## Završna provjera prije predaje

```bash
node --check bot.js
node --check dashboard.js
git diff --stat            # očekivano: samo bot.js
grep -n "new Date(cols\[0\])" bot.js    # očekivano: 0 rezultata
grep -c "_halfSize" bot.js              # očekivano: 13 (prije fixa: 10)
```

Ako `git diff --stat` pokaže bilo koji fajl osim `bot.js` (i ovog spec fajla, ako ga commitaš) — nešto je otišlo po zlu, stani i prijavi.

---

## NE RADITI u ovom zadatku

Iz issue #7, svjesno odgođeno. Navedeno da ne bi "usput popravio" nešto što traži odluku vlasnika:

| Nalaz | Gdje | Zašto ne sad |
|---|---|---|
| #5 `momSigs` je identična kopija `sigs` | `bot.js` 3395-3412 | Treba odluka je li inverzija bila namjera. Fix 4 samo ispravlja komentar da ne laže. |
| #6 SWEEP SL koristi 192-bar minimum, ne impuls low | `bot.js` 3180, 3193 | Promjena ulazne logike — traži odluku koliko barova čini "impuls". |
| #7 "48h" LHUNT prozor je 8 dana na 1H / 32 dana na 4H | `bot.js` 3008-3011 | Ispravan fix je TF-svjestan prozor, što je redizajn potpisa `analyzeUltra`. |
| #8–10 dashboard `scanSymbol` se razišao od `bot.js` (LHUNT 8 vs 192 bara, FVG bez 61.8% fiba, PWHL bez sweep uvjeta) | `dashboard.js` 632-633, 566-567, 526-531 | Ne utječe na trgovanje, samo na preview. Zaseban zadatak. |
| #12 zonske grane ne vraćaju `sigMask` | `bot.js` 3186, 3197, 3218, 3229, 3263, 3281 | Možda namjerno (te grane ne broje combo signale). Treba potvrdu. |
| #13 zastarjeli brojevi u komentarima | `bot.js` 7074-7076, 3065, 6276, 1140 | Higijena, nema utjecaja na izvršavanje. |
| #14 mrtav kod (`sig17sr`, `sig18bk`, `ema200`, `chop`, `synapseTSig`, legacy `pending`) | `bot.js` 2764-2775 i dr. | Higijena. |
| #15 `VOL_EXH_TIERS_D` duplikat | `dashboard.js` 56-63 | Trenutno sinkroniziran, nije pokvaren. |
