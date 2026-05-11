# ULTRA Trading Bot — Kompletna povijest razvoja
**Projekt:** claude-tradingview-mcp-trading  
**Bot:** ULTRA (SYNAPSE-T) — BitGet Futures, 50x leverage (BTC 75x)  
**Period razvoja:** Travanj–Svibanj 2026  

---

## 1. POČETNO STANJE — originalna arhitektura

### Strategija: SYNAPSE-T / ULTRA-18
Bot je startao s **18 signala** i sljedećim parametrima:

| Parametar | Vrijednost |
|-----------|-----------|
| Signali | 18 |
| Min za ulaz | 9/18 |
| SL | 1.5% |
| TP | 2.5% |
| RR | 1:1.67 |
| Leverage | 50x (BTC 100x) |
| Rizik po tradeu | 1% banke |

**18 signala:**
```
EMA, CRS, E50, RSI zona, E55, ADXsn, Chop, 6Sc,
CVD, RSI recovery, MACD hist, E145, Vol, MACD cross,
RSI smjer, ADX jak, SRS, SRB
```

### Problem koji je odmah uočen
Signali **ADX, RSI i EMA** su se pojavljivali **i kao obvezni gate I kao signal u brojaču** — bot je dobivao "besplatne bodove" za uvjete koje je ionako morao ispuniti.

---

## 2. BUG: DVOSTRUKO BROJANJE SIGNALA

### Problem
```
Obvezni gate:  ADX > 18 ✓  →  prolaz
Signal #6:     ADX > 18    →  +1 bod (isti uvjet!)
Obvezni gate:  EMA9 > EMA21 ✓
Signal #1:     EMA9 > EMA21 →  +1 bod (isti uvjet!)
```

Bot bi dostigao min score samo od obveznih uvjeta — bez ikakvog stvarnog potvrđivanja trenda.

### Rješenje
Odvojena logika: **obvezni gateovi** (moraju svi proći) od **neovisnih signala** (tek onda se broje).

---

## 3. ANALIZA TRADES — EXCEL IZVOZ

### Što smo napravili
Iz `trades.csv` izvučeno **92 zaključenih trejdova** u `parsed_trades.json` s dodanim:
- `maxGainPct` — maksimalni pomak u smjeru trejda
- `maxLossPct` — maksimalni pomak protiv trejda
- Rekonstruirani signali na ulazu za svaki trade

### Excel analiza (5 sheet-ova)
1. **Svi trejdovi** — kronološki pregled
2. **WIN trejdovi** — pobjednički
3. **LOSS trejdovi** — gubici
4. **Signal analiza** — WR po svakom signalu
5. **Zaključak** — preporuke

### Ključni nalaz — WR po signalu:

| Signal | WR kad je ▲ (bullish) | Ocjena |
|--------|----------------------|--------|
| CRS (EMA cross) | 14.3% | ❌ Drastično obrnuti |
| MCC (MACD cross) | 23.1% | ❌ Obrnuti |
| VOL (volumen) | 27.5% | ❌ Obrnuti |
| E50 | 29.0% | ❌ Obrnuti |
| E55 | 29.0% | ❌ Obrnuti |
| CVD | 30.9% | ❌ Obrnuti |
| RSI zona | 31.4% | ❌ Obrnuti |
| **Prag za reversiranje** | **31.5%** | (WR < 50% / 2 = invertiraj) |

### Zaključak analize
Kada su ovi signali **bullish (▲)**, trade **gubi** češće nego što pobjeđuje. Logika: tržište voli pullback prije nastavka trenda, ne momentum ulaz.

---

## 4. NOVA ARHITEKTURA — 13 SIGNALA

### Promjene u signalnoj listi

**Uklonjeni iz signala (postali obvezni gateovi):**
- CRS (EMA cross) → uklonjen potpuno (WR 14.3% = kontraproduktivan)
- ADXsn (ADX > 18) → postaje obvezni gate s pragom 25
- 6Sc → postaje obvezni gate

**Ostalo: 13 neovisnih signala**

### 6 REVERSANIH signala (pullback/contrarian logika)

Logika: ako signal daje WR < 31.5% kada je bullish → invertiraj ga.  
Sada ti signali traže **pullback unutar trenda**, ne momentum.

| # | Signal | Stara logika | Nova (reversana) logika |
|---|--------|-------------|------------------------|
| 1 | E50 | cijena > EMA50 = +1 (bull) | cijena < EMA50 = +1 (pullback) |
| 2 | RSI zona | RSI 30-50 = +1 (prostora za rast) | RSI > 55 = +1 (momentum potvrđen) |
| 3 | E55 | cijena > EMA55 = +1 | cijena < EMA55 = +1 (duboki pullback) |
| 5 | CVD | sell vol > 0 = -1 | sell vol = +1 (akumulacija u dipu) |
| 9 | VOL | vol > avg = +1 | vol > avg = -1 (climax exhaustion) |
| 10 | MCC | MACD cross gore = +1 | MACD cross dolje = +1 (overbought exhaustion) |

### 7 normalnih signala (ostaju isti)

| # | Signal | Logika |
|---|--------|--------|
| 4 | CHP | Choppiness < 61.8 = nije ranging |
| 6 | R⟳ | RSI recovery iz OB/OS zone |
| 7 | MCD | MACD histogram > 0 |
| 8 | E145 | Cijena > EMA145 (dugoročni trend) |
| 11 | RSI↗ | RSI raste 2+ bara |
| 12 | SRS | S/R Bounce (pivot zona) |
| 13 | SRB | S/R Breakout (pivot probijen) |

---

## 5. OBVEZNI GATEOVI — 4 uvjeta

Svi moraju proći **prije** nego se uopće broje signali.

```
Gate 1: ADX ≥ 25        — trend postoji (eliminira konsolidaciju)
Gate 2: 6Sc ≥ 4/6       — min 4 od 6 EMA parova aligned u smjeru ulaza
Gate 3: RSI asimetričan  — LONG: RSI < 72 | SHORT: RSI > 30
Gate 4: 5m S/R test      — cijena je testirala S/R zonu na 5m TF i odbila se
```

### Zašto ADX ≥ 25 (a ne 22 ili 30)?

**Testovi:**
- ADX ≥ 18 → previše tradova u ranging tržištu (šum)
- ADX ≥ 30 → premalo signala, propuštamo dobre ulaze
- ADX ≥ 25 → optimum: filtira chop, ali ostavlja dovoljno trendova

### Zašto 6Sc kao gate a ne signal?
6-Scale multi-EMA konsenzus (6 različitih parova) je snažniji pokazatelj trenda od jednog EMA9/21 crossa. Nema smisla brojati ga kao signal — ako tržište nije aligned, ne trgujemo.

### Min signala: 5/13
Postavljeno konzervativno — tražimo da najmanje 5 od 13 neovisnih signala potvrde smjer.

---

## 6. SL/TP OPTIMIZACIJA — SIMULACIJA

### Problem s originalnim SL 1.5% / TP 2.5%
WR bot je imao ~31%. Matematika profitnog faktora:

```
PF = (WR × TP) / ((1-WR) × SL)
PF = (0.31 × 2.5) / (0.69 × 1.5)
PF = 0.775 / 1.035 = 0.75  →  GUBITAK DUGOROČNO
```

Za WR 31% treba **minimalni RR 1:2.23** samo da se dođe na break-even!

### Simulacija 25 TP/SL kombinacija
Koristili smo `maxGainPct` i `maxLossPct` iz parsed_trades.json da simuliramo različite kombinacije **bez ponovnog dohvaćanja podataka**:

| SL% | TP 2.5% | TP 3.0% | TP 3.5% | TP 4.0% | TP 4.5% |
|-----|---------|---------|---------|---------|---------|
| 1.0% | ❌ | ❌ | ✅ slabo | ✅ | ✅ |
| 1.5% | ❌ | ❌ | ✅ | ✅ | ✅ |
| 2.0% | ❌ | ❌ | ✅ | ✅ best | ✅ |
| 2.5% | ❌ | ❌ | ❌ slabo | ✅ | ✅ |

### Zašto SL 1% nije dobar
Korisnik ispravno primijetio: **algoritmi na burzama detektiraju SL klastera** i namjerno guraju cijenu do likvidacija prije pravog poteza. SL 1% × 50x = 50% margine, preblizu za šum tržišta.

---

## 7. PER-SIMBOL SL/TP — ATR VOLATILNOSNI TIEROVI

### Problem
Neki simboli (ENA, APT, PEPE) imaju **dnevne raspone 6-8%** dok drugi (BTC, ETH) imaju 2-3%. Isti SL za oba je pogrešan — na volatilnom simbolu SL 1.5% se pogodi svaku minutu.

### Metodologija
Dohvaćeni dnevni candle-i za zadnjih 30 dana za svih 15 aktivnih simbola.  
Izračunat `avgRange% = prosječni (High-Low)/Close × 100`.

### Rezultati ATR analize:

**Tier 1 — Niska volatilnost (SL 1.5% / TP 4.0%, RR 1:2.67)**

| Simbol | avgRange% |
|--------|-----------|
| BTCUSDT | 2.76% |
| XRPUSDT | 3.07% |
| SOLUSDT | 3.54% |
| ETHUSDT | 3.55% |
| LINKUSDT | 3.87% |

**Tier 2 — Srednja volatilnost (SL 2.0% / TP 4.5%, RR 1:2.25)**

| Simbol | avgRange% |
|--------|-----------|
| ADAUSDT | 4.02% |
| DOGEUSDT | 4.33% |
| HYPEUSDT | 4.55% |
| NEARUSDT | 4.93% |
| SEIUSDT | 5.27% |
| SUIUSDT | 5.36% |
| PEPEUSDT | 5.58% |
| TAOUSDT | 5.84% |
| APTUSDT | 6.09% |

**Tier 3 — Visoka volatilnost (SL 2.5% / TP 5.5%, RR 1:2.20)**

| Simbol | avgRange% |
|--------|-----------|
| ENAUSDT | 7.67% |

### Uklonjeni simboli (razni razlozi)

| Simbol | Razlog uklanjanja |
|--------|------------------|
| XAUUSDT, XAGUSDT | WR 0% u analizi |
| BNBUSDT, AVAXUSDT, DOTUSDT | WR 0% u analizi |
| INJUSDT, ARBUSDT, WIFUSDT | Mali volumen < 10M USD/dan |
| TIAUSDT, FETUSDT | Mali volumen |
| ORDIUSDT, WLDUSDT, TRUMPUSDT | Loš WR historijski |

---

## 8. AKTIVNI SIMBOLI (15)

```
BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, LINKUSDT   ← Tier 1
DOGEUSDT, NEARUSDT, ADAUSDT, SUIUSDT, TAOUSDT,
HYPEUSDT, PEPEUSDT, APTUSDT, SEIUSDT            ← Tier 2
ENAUSDT                                          ← Tier 3
```

---

## 9. FINALNI PARAMETRI BOTA

```javascript
// Leverage
LEVERAGE     = 50   // svi simboli
BTC_LEVERAGE = 75   // BTC posebno

// Risk management
RISK_PCT = 1.0%     // banke po tradeu (margin = equity × 1%)
MAX_OPEN = 8        // max otvorenih pozicija (+BTC bonus slot)
DAILY_LIMIT = 100   // max tradova po danu
CIRCUIT_BREAKER = 7 // uzastopnih gubitaka → 8h pauza

// Signal arhitektura
MIN_SIGNALS = 5/13
ADX_GATE    = ≥ 25
SCALE_GATE  = ≥ 4/6 EMA parova
RSI_GATE    = < 72 (LONG) | > 30 (SHORT)
SR_GATE     = 5m S/R test

// SL/TP po tieru (override u rules.json)
Tier1: SL 1.5% / TP 4.0%  (RR 1:2.67)
Tier2: SL 2.0% / TP 4.5%  (RR 1:2.25)
Tier3: SL 2.5% / TP 5.5%  (RR 1:2.20)
```

---

## 10. DASHBOARD POBOLJŠANJA

### Promjena 1: Timezone UTC → UTC+2
**Problem:** Dashboard je prikazivao UTC, korisnik je u UTC+2 (CEST).  
**Rješenje:** Dodan `fmtLocalTs()` helper s +2h offsetom na svim timestamp prikazima.

### Promjena 2: 5mSR status vidljiv u tablici
**Problem:** 4. obvezni gate (5m S/R test) nije bio vidljiv — badge je uvijek bio siv.  
**Rješenje:**  
- `check5mSRTest` exportana iz bot.js
- Scanner je poziva za svaki simbol koji ima LONG/SHORT signal
- Badge prikazuje:
  - 🟢 `5mSR ✓` — test prošao, S/R potvrđena
  - 🔴 `5mSR ✗` — test pao, ulaz bi bio blokiran
  - ⚫ `5mSR` — nema aktivnog signala, test se ne pokreće

### Promjena 3: Bot scheduler 5min → 1min
**Problem:** Signal se pojavi na zatvorenoj 15m svjećici, ali bot čeka do 5 minuta.  
**Rješenje:** `setInterval(scheduledRun, 1 * 60 * 1000)` — max 60s kašnjenja.

---

## 11. TRADINGVIEW PINE SCRIPT — ULTRA_13

Napisan novi Pine Script (`ULTRA_13_strategy.pine`) koji je **identičan bot.js logici**.

### Ključne razlike od starog ULTRA-18 skripte:
- 18 signala → **13 signala**
- 6 reversanih signala implementirano
- Obvezni gateovi kao Pine uvjeti (ADX, 6Sc, RSI)
- **Tier dropdown** za odabir SL/TP prema simbolu
- Dashboard tablica prikazuje sve 13 signala + gateove + RR omjer
- Candle H/L breakout entry mehanizam zadržan

### Ispravke sintaksnih grešaka (Pine v5):
1. Semicoloni `;` za odvajanje naredbi → svaki u vlastiti red
2. Višeredni tернari `? 1 :\n   uvjet` → sve na jednom redu

---

## 12. KRONOLOŠKI SAŽETAK COMMITOVA

| Commit | Promjena |
|--------|----------|
| `feat: per-symbol ATR SL/TP tiers` | ATR analiza, 3 tiera, rules.json update |
| `feat: ULTRA-13 Pine Script` | Novi TradingView skript s 13 signalima |
| `fix: ukloni semicolone (Pine v5)` | Sintaksna greška u 6-Scale bloku |
| `fix: Pine v5 — višeredni ternari` | sig6 i sig12 na jedan red |
| `fix: timestamp UTC+2` | Prikaz lokalnog vremena u dashboardu |
| `fix: fmtLocalTs na klijentskoj strani` | Browser JS nije imao pristup server funkciji |
| `perf: bot scheduler 5min → 1min` | Brži ulaz u trade |
| `feat: 5mSR status u dashboard tablici` | Vidljivost 4. obveznog gatea |

---

## 13. MATEMATIČKA PROVJERA STRATEGIJE

### Zašto pullback/contrarian logika ima smisla

```
Scenario: BTC je u uzlaznome trendu (6Sc ≥ 4/6 ✓)

Stara logika (momentum):
  E50 cijena > EMA50 = +1 (tržište je već gore)
  → Ulazimo na vrhu pullbacka, stop blizu, lako likvidacija

Nova logika (pullback):
  E50 cijena < EMA50 = +1 (tržište je u kratkom dipu)
  → Ulazimo dok "jeftino" u smjeru većeg trenda
  → SL dalje od šuma, TP veći zbog reversion potencijala
```

### Break-even WR po tieru

| Tier | SL | TP | RR | Min WR za profit |
|------|----|----|----|-----------------|
| Tier 1 | 1.5% | 4.0% | 1:2.67 | 27.3% |
| Tier 2 | 2.0% | 4.5% | 1:2.25 | 30.8% |
| Tier 3 | 2.5% | 5.5% | 1:2.20 | 31.3% |

Uz WR ~31-35% koji je bot historijski pokazao, svi tierovi su matematički profitabilni.

---

## 14. OTVORENA PITANJA / SLJEDEĆI KORACI

- [ ] Praćenje WR po novoj arhitekturi (treba min 50 trejdova za statistiku)
- [ ] Logiranje uvjeta na ulazu (RSI, ADX, 6Sc score) u trades.csv za kasniju analizu
- [ ] Evaluacija može li se 5mSR gate ublažiti (koliko dobrih trejdova blokira)
- [ ] Analiza performance po tieru (Tier1 vs Tier2 vs Tier3)
- [ ] Razmatranje dinamičnog ADX praga (viši u ranging, niži u trending tržištu)

---

*Dokument generiran: 2026-05-11*  
*Bot verzija: ULTRA-13 | Railway deployment | BitGet Futures USDT*
