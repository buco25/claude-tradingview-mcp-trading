// Bilježenje signala i tradeova u Supabase (projekt "bot-signali", 29.10.2026, odluka vlasnika).
//
// Pravila koja ovaj modul drže (trgovanje je važnije od bilježenja):
//  - logSignal / logTrade su SINKRONI: samo stave redak u memorijski red i vrate se. Nikad ne čekaju mrežu
//    i nikad ne bacaju, pa se smiju zvati s bilo kojeg trgovačkog puta bez await-a.
//  - Slanje je u pozadini (timer, unref): jedan POST s nizom redaka po tablici, timeout `timeoutMs`.
//  - Red je ograničen (`maxQueue` po tablici, najstariji se odbacuju) — ako je Supabase nedostupan, memorija ne raste.
//  - Bez SUPABASE_URL i SUPABASE_ANON_KEY modul je potpuni no-op (nula mrežnih poziva, nula timera).
//  - `anon` uloga ima samo INSERT (RLS politika bot_insert_only), pa se šalje `Prefer: return=minimal`.
//    `return=representation` i upsert traže SELECT/UPDATE i PAO bi na RLS-u.
//  - Ključ se nikad ne ispisuje u log.
//
// Ključevi se čitaju LIJENO (pri prvom pozivu), ne pri učitavanju modula, da dotenv/Railway varijable već postoje.

const SIGNAL_COLS = ["scan_ts", "strategy", "symbol", "signal", "bull_score", "bear_score", "is_momentum", "half_size",
  "forming", "candle_age_s", "price", "blocked", "blockers", "gates", "entered", "funding_pct", "reason"];
const TRADE_COLS = ["event", "portfolio", "symbol", "side", "data"];
const COLS = { signal_log: SIGNAL_COLS, trade_log: TRADE_COLS };

// null/undefined/"" -> null (Number(null) je 0, što bi iz "nema podatka" napravilo lažnu nulu)
const num  = v => { if (v == null || (typeof v === "string" && v.trim() === "")) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = v => (typeof v === "boolean" ? v : null);
const txt  = (v, max = 300) => (v == null ? null : String(v).slice(0, max));

// Čisti objekt za jsonb: samo konačni brojevi, stringovi, booleani, (plitki) nizovi i objekti. NaN/Infinity/undefined ispadaju.
function jsonSafe(o, depth = 0) {
  if (o == null) return null;
  if (typeof o === "number") return Number.isFinite(o) ? o : null;
  if (typeof o === "string") return o.slice(0, 500);
  if (typeof o === "boolean") return o;
  if (depth >= 3) return null;
  if (Array.isArray(o)) return o.slice(0, 50).map(x => jsonSafe(x, depth + 1));
  if (typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) { const s = jsonSafe(v, depth + 1); if (s !== null && s !== undefined) out[k] = s; }
    return out;
  }
  return null;
}

// ─── Pretvorba unosa bota u retke tablica (čiste funkcije, testirane) ────────────────────────────────────────────

// Oznaka strategije za unos iz scan loga: Supertrend piše u isti niz kao 1H, pa se prepoznaje po blokeru/razlogu.
export function scanStrategyOf(e) {
  if (e.strategy) return e.strategy;
  const b = String(e.blocker || ""), r = String(e.reason || "");
  return /^ST_/.test(b) || /^(Supertrend|ST ulaz)/.test(r) ? "ST" : "1H";
}

// Unos iz writeScanLog -> redak signal_log, ili null ako se ne bilježi (samo LONG/SHORT; NEUTRAL/SKIP/ERROR ne).
export function scanEntryToSignalRow(e, scanTs = new Date().toISOString()) {
  if (!e || (e.signal !== "LONG" && e.signal !== "SHORT")) return null;
  const entered = e.blocker === "ENTERED";
  const score = num(e.score);
  return {
    scan_ts: scanTs,
    strategy: scanStrategyOf(e),
    symbol: String(e.symbol),
    signal: e.signal,
    bull_score: num(e.bullScore) ?? (e.signal === "LONG" ? score : null),
    bear_score: num(e.bearScore) ?? (e.signal === "SHORT" ? score : null),
    is_momentum: bool(e.isMomentum),
    half_size: bool(e.halfSize),
    price: num(e.price),
    blocked: !entered && e.blocker !== "SIGNAL",
    blockers: entered || e.blocker === "SIGNAL" || !e.blocker ? [] : [txt(e.blocker, 120)],
    gates: jsonSafe({ score, rsi: num(e.rsi), adx: num(e.adx), vwapDist: num(e.vwapDist) }),
    entered,
    reason: txt(e.reason),
  };
}

// ULTRA-4H: `sig` iz analyzeUltra4hFull, `gates` iz evaluateU4hGates. Kasniji blokeri (likvidacija, equity, strop po svijeći)
// nisu ovdje — stvarni ulaz se vidi u trade_log.
export function u4hSignalRow(symbol, sig, gates, scanTs = new Date().toISOString()) {
  if (!sig || (sig.signal !== "LONG" && sig.signal !== "SHORT")) return null;
  const blockers = (gates?.blockers ?? []).map(b => txt(b?.text ?? b, 120));
  return {
    scan_ts: scanTs,
    strategy: "4H",
    symbol: String(symbol),
    signal: sig.signal,
    bull_score: num(sig.bullScore),
    bear_score: num(sig.bearScore),
    is_momentum: bool(sig.isMomentum),
    half_size: null,
    price: num(sig.price),
    blocked: gates ? gates.ok === false : null,
    blockers,
    gates: jsonSafe({ notes: (gates?.notes ?? []).map(n => String(n).trim().slice(0, 200)), candlePat: gates?.candlePat, vipSlot: gates?.vipSlot, dayRangeSizeMult: gates?.dayRangeSizeMult }),
    entered: false,
    reason: null,
  };
}

// trade_log: event ENTRY/EXIT, `data` nosi samo trgovačke podatke (nikad ključeve).
export function entryTradeRow(pid, entry) {
  return {
    event: "ENTRY", portfolio: txt(pid, 60), symbol: String(entry.symbol), side: txt(entry.signal, 10),
    data: jsonSafe({
      price: num(entry.price), sl: num(entry.sl), tp: num(entry.tp), slPct: num(entry.slPct), tpPct: num(entry.tpPct),
      tradeSize: num(entry.tradeSize), strategy: entry.strategy, entryMode: entry.entryMode || "PBK", sigMask: num(entry.sigMask),
      orderId: entry.orderId, btcRegime1h: entry.btcRegime1h, btcRegime4h: entry.btcRegime4h, candlePat: entry.candlePat,
      fundingPct: num(entry.fundingPct), ts: entry.timestamp,
    }),
  };
}

export function exitTradeRow(pid, pos, exitPrice, reason, pnl, fee) {
  return {
    event: "EXIT", portfolio: txt(pid, 60), symbol: String(pos.symbol), side: txt(pos.side, 10),
    data: jsonSafe({
      entryPrice: num(pos.entryPrice), exitPrice: num(exitPrice), sl: num(pos.sl), tp: num(pos.tp), quantity: num(pos.quantity),
      totalUSD: num(pos.totalUSD), pnl: num(pnl), fee: num(fee), net: num(pnl) != null && num(fee) != null ? num(pnl) - num(fee) : null,
      reason: txt(reason, 200), entryMode: pos.entryMode || "PBK", sigMask: num(pos.sigMask), orderId: pos.orderId,
    }),
  };
}

// ─── Red + pozadinsko slanje ─────────────────────────────────────────────────────────────────────────────────────

export function createSupabaseLogger({
  env = process.env, fetchImpl = (...a) => globalThis.fetch(...a), setTimer = setInterval, clearTimer = clearInterval,
  flushMs = 15000, timeoutMs = 4000, maxQueue = 500, batchSize = 100, maxBackoffMs = 5 * 60 * 1000,
  now = () => Date.now(), log = (...a) => console.log(...a),
} = {}) {
  const q = { signal_log: [], trade_log: [] };
  const stats = { sent: 0, dropped: 0, failed: 0, lastError: null };
  let cfg = null, timer = null, busy = false, backoffMs = 0, retryAt = 0, lastLogAt = 0, firstOkLogged = false;

  function config() {
    if (cfg) return cfg;
    const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const key = String(env.SUPABASE_ANON_KEY || "").trim();
    const off = String(env.SUPABASE_LOG_ENABLED || "").trim().toLowerCase() === "false";
    cfg = { enabled: !!url && !!key && !off && /^https?:\/\//i.test(url), url, key };
    return cfg;
  }

  function throttledLog(msg) {
    if (now() - lastLogAt < 5 * 60 * 1000) return;
    lastLogAt = now();
    try { log(msg); } catch { /* log nikad ne smije srušiti bota */ }
  }

  function enqueue(table, row) {
    try {
      if (!row || !config().enabled) return;
      const clean = {};
      for (const c of COLS[table]) if (row[c] !== undefined) clean[c] = row[c];
      const list = q[table];
      list.push(clean);
      if (list.length > maxQueue) { stats.dropped += list.length - maxQueue; list.splice(0, list.length - maxQueue); }
      if (!timer) { timer = setTimer(() => { flush().catch(() => {}); }, flushMs); timer?.unref?.(); }
    } catch { /* nikad ne baca */ }
  }

  async function post(table, rows) {
    const c = config();
    const headers = { apikey: c.key, "Content-Type": "application/json", Prefer: "return=minimal" };
    // Stari anon JWT ključ ide i kao Bearer; novi sb_publishable_ ključ NIJE JWT pa se šalje samo kao apikey.
    if (c.key.startsWith("eyJ")) headers.Authorization = `Bearer ${c.key}`;
    return fetchImpl(`${c.url}/rest/v1/${table}`, { method: "POST", headers, body: JSON.stringify(rows), signal: AbortSignal.timeout(timeoutMs) });
  }

  async function flush() {
    if (busy || !config().enabled || now() < retryAt) return;
    busy = true;
    try {
      for (const table of Object.keys(q)) {
        while (q[table].length) {
          const rows = q[table].splice(0, batchSize);
          let res;
          try { res = await post(table, rows); }
          catch (e) { res = { ok: false, status: 0, _err: e?.name === "TimeoutError" ? "timeout" : (e?.message || "greška") }; }
          if (res.ok) {
            stats.sent += rows.length; backoffMs = 0;
            if (!firstOkLogged) { firstOkLogged = true; try { log(`📡 [SUPABASE] prvi upis OK (${table}, ${rows.length} redaka)`); } catch { /* */ } }
            continue;
          }
          stats.failed += rows.length;
          stats.lastError = res._err || `HTTP ${res.status}`;
          // 4xx (shema, ključ, RLS): ponavljanje ne pomaže, batch se odbacuje. Timeout/mreža/5xx/429: vraća se na početak reda.
          const permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
          if (permanent) stats.dropped += rows.length;
          else { q[table].unshift(...rows); if (q[table].length > maxQueue) { stats.dropped += q[table].length - maxQueue; q[table].length = maxQueue; } }
          backoffMs = Math.min(maxBackoffMs, backoffMs ? backoffMs * 2 : 15000);
          retryAt = now() + backoffMs;
          throttledLog(`⚠️  [SUPABASE] upis nije uspio (${stats.lastError}${permanent ? ", batch odbačen" : ", ponavljam"}) — trgovanje nije pogođeno`);
          return;
        }
      }
    } finally { busy = false; }
  }

  return {
    logSignal: row => enqueue("signal_log", row),
    logTrade:  row => enqueue("trade_log", row),
    flush,
    status: () => ({ enabled: config().enabled, queued: q.signal_log.length + q.trade_log.length, ...stats }),
    stop: () => { if (timer) { clearTimer(timer); timer = null; } },
  };
}

const _default = createSupabaseLogger();
export const logSignal = row => _default.logSignal(row);
export const logTrade  = row => _default.logTrade(row);
export const supabaseLogStatus = () => _default.status();
