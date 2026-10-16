#!/usr/bin/env node
/**
 * D49 RECONSTRUCTION — the four lost settle-days (2026-08-04..07), rebuilt from sealed backups.
 * Spec v2, revised after a 5-role × 3-model assessment panel review (2026-08-12, trail entry
 * in assessment-agents/data/assessment-trail.jsonl). Panel-driven changes vs v1:
 *   · exits book at a partial bar built from 1-MINUTE bars 09:30→09:47:59 ET (not 5-min→09:45)
 *   · crypto gets the same partial-bar treatment via Alpaca crypto minute bars
 *   · FX/futures are reconstructed on a daily-open fallback but EXCLUDED from every comparable
 *     aggregate (their own stratum; flagged rows, reported separately, never pooled)
 *   · every price fetch uses adjustment=raw — the live engine saw raw prices; adjusted bars
 *     silently rewrite history if any dividend/split landed since
 *   · per-morning counts are reconciled against the contemporaneous run log's own claims
 *
 * WHAT THIS IS: positions, entries, stops, targets and pre-outcome model scores were sealed in
 * nightly backups BEFORE any outcome existed (file dates prove it). The settle pipeline crashed
 * (D49) and the outcomes were never written. This recomputes them with the production settle
 * rule, verbatim (bar-scan strictly after entry day, stop-first, gap-fill at open, loss cap 0
 * as it was all week per git, close-fallback at scan end).
 *
 * WHAT THIS IS NOT: it never touches trade_log.json. Every row carries reconstructed:true and
 * its fidelity stratum. The output is a separate, registered, tagged cohort.
 *
 * KNOWN LIMITATIONS (stated, per panel): the known-answer test validates the MECHANISM on the
 * 08-07 book (whose 99 settles banked normally on 08-10) — it cannot validate the crashed days
 * themselves; per-session effective-N is small and the shadow evaluation's band discipline is
 * what handles that.
 *
 * Usage: node backend/reconstruct-lost-week.js   → backend/data/reconstructed-week-2026-08-04-07.json
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBars } = require("./lib/alpaca-bars");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const OUT = D("reconstructed-week-2026-08-04-07.json");
// BACKUP FILE SEMANTICS (verified 2026-08-12 by addedAt census + log reconciliation):
// backup-D is written by day D's MORNING chain and holds the PRIOR evening's book — so the
// book in backup-D was due to settle on morning D itself. backup-08-04 = 68 positions
// (66 added 08-03 + 2 options) = the "settled 65" cohort of the 08-04 run, exactly.
const BACKUP_DAYS = ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
const SETTLE_OF = { "2026-08-04": "2026-08-04", "2026-08-05": "2026-08-05", "2026-08-06": "2026-08-06", "2026-08-07": "2026-08-07" };
const LOG_CLAIMS = { "2026-08-04": 65, "2026-08-05": 81, "2026-08-06": null, "2026-08-07": null }; // from daily-run.log; null = run crashed before printing
const MIN_STOP_FRAC = 0.004, MAX_LOSS_R = 0;            // verbatim production constants (cap 0 all week, per git)
const BROKEN_NOTIONAL = 100000 * 0.20 * 2.5;            // brokenSize: account × MAX_POS_PCT × SIZE_SANITY_MULT
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const safeStopDist = (p) => Math.max(p.stopDist || 0, (p.entry || 0) * MIN_STOP_FRAC) || null;

const HDRS = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
async function cryptoBars(symbols, timeframe, start, end) {
  const out = {};
  let token = null;
  do {
    const p = new URLSearchParams({ symbols: symbols.join(","), timeframe, start, end, limit: "10000" });
    if (token) p.set("page_token", token);
    const r = await fetch(`https://data.alpaca.markets/v1beta3/crypto/us/bars?${p}`, { headers: HDRS });
    if (!r.ok) throw new Error(`crypto bars ${r.status}`);
    const j = await r.json();
    for (const [s, rows] of Object.entries(j.bars || {})) (out[s] ||= []).push(...rows);
    token = j.next_page_token || null;
  } while (token);
  for (const s in out) out[s].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  return out;
}
async function yahooDaily(symMap) { // { boardSym: yahooSym }
  const r = await fetch("http://localhost:3002/api/yahoo/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: Object.values(symMap), days: 90 }) });
  if (!r.ok) throw new Error(`yahoo batch ${r.status}`);
  const j = await r.json();
  const out = {};
  for (const [board, y] of Object.entries(symMap)) out[board] = j.data?.[y.toUpperCase()] || null;
  return out;
}
// Aggregate minute bars in [startIso, endIso) into one partial bar {o,h,l,c}; null if none.
const partial = (mins) => {
  if (!mins || !mins.length) return null;
  return { o: mins[0].o, h: Math.max(...mins.map(b => b.h)), l: Math.min(...mins.map(b => b.l)), c: mins[mins.length - 1].c };
};
// Coinbase Exchange public candles — the SAME fallback production settle adopted 2026-08-07 for
// crypto names Alpaca doesn't list. 5-min granularity (300s) keeps one request per symbol-day;
// rows priced this way carry fidelity "partial-5min-coinbase" (close lands at 13:45Z, 2-3 min
// short of the run — a stated, lesser stratum, still far above daily-open).
async function coinbaseCandles(sym, granularity, startIso, endIso) {
  const cb = sym.replace("/", "-");
  const r = await fetch(`https://api.exchange.coinbase.com/products/${cb}/candles?granularity=${granularity}&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`, { headers: { "User-Agent": "traids-reconstruct" } });
  if (!r.ok) return null;
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) return null;
  // rows: [ time, low, high, open, close, volume ], newest-first — normalize + sort ascending
  return j.map(x => ({ t: new Date(x[0] * 1000).toISOString(), l: x[1], h: x[2], o: x[3], c: x[4] })).sort((a, b) => a.t.localeCompare(b.t));
}

// ── the production settle rule, verbatim (cap disabled) ─────────────────────────────────────
function settle(p, scan) {
  const long = p.dir > 0, sd = safeStopDist(p);
  const tpLevel = p.entry + p.dir * sd;
  let exit = null, reason = null, exitTP = null, mfe = -Infinity, mae = -Infinity, barsHeld = 0, gapped = false;
  for (const b of scan) {
    barsHeld++;
    mfe = Math.max(mfe, (long ? b.h - p.entry : p.entry - b.l) / sd);
    mae = Math.max(mae, (long ? p.entry - b.l : b.h - p.entry) / sd);
    const hitStop = long ? b.l <= p.stop : b.h >= p.stop;
    const hitTgt = long ? b.h >= p.target : b.l <= p.target;
    const hitTP = long ? b.h >= tpLevel : b.l <= tpLevel;
    const g = b.o != null && (long ? b.o <= p.stop : b.o >= p.stop);
    const stopFill = g ? b.o : p.stop;
    if (exitTP == null) { if (hitStop) exitTP = stopFill; else if (hitTP) exitTP = tpLevel; }
    if (exit == null) {
      if (hitStop) { exit = stopFill; reason = g ? "gap-stop" : "stop"; gapped = g; }
      else if (hitTgt) { exit = p.target; reason = "target"; }
    }
    if (exit != null && exitTP != null) break;
  }
  const last = scan[scan.length - 1];
  if (exit == null) { exit = last.c; reason = "close"; }
  if (exitTP == null) exitTP = last.c;
  if (!isFinite(mfe)) mfe = 0; if (!isFinite(mae)) mae = 0;
  return { exit, reason, gapped, heldBars: barsHeld, mfe: +mfe.toFixed(3), mae: +(-mae).toFixed(3),
    rMult: ((exit - p.entry) * p.dir) / sd, rMultTP: ((exitTP - p.entry) * p.dir) / sd,
    pnl: (exit - p.entry) * p.dir * (p.dollarPerPoint || 0) };
}

(async () => {
  // ── 1. universe from sealed backups: last-appearance mapping ──────────────────────────────
  const books = {};
  for (const d of BACKUP_DAYS) books[d] = JSON.parse(fs.readFileSync(D(`board_positions.backup-${d}.json`), "utf8"));
  const lastSeen = new Map();   // id -> { pos, lastDay }
  for (const d of BACKUP_DAYS) for (const p of books[d]) lastSeen.set(p.id, { pos: p, lastDay: d });
  const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
  const banked = new Set((Array.isArray(log) ? log : log.log || []).map(t => t.id));

  const excl = { options: 0, banked: 0, brokenSize: 0 };
  const universe = [];
  for (const { pos: p, lastDay } of lastSeen.values()) {
    if (p.cls === "Options") { excl.options++; continue; }
    if (banked.has(p.id)) { excl.banked++; continue; }
    if (["Equity", "Crypto", "FX"].includes(p.cls) && p.dollarPerPoint > 0 && p.entry > 0 && p.dollarPerPoint * p.entry > BROKEN_NOTIONAL) { excl.brokenSize++; continue; }
    universe.push({ p, settleDay: SETTLE_OF[lastDay], lastDay });
  }
  console.log(`universe: ${universe.length} positions to reconstruct · excluded: ${JSON.stringify(excl)}`);

  // ── 2. price data, adjustment=raw everywhere ──────────────────────────────────────────────
  const eq = universe.filter(u => u.p.cls === "Equity"), cr = universe.filter(u => u.p.cls === "Crypto");
  const fx = universe.filter(u => ["FX", "Futures"].includes(u.p.cls));
  const eqSyms = [...new Set(eq.map(u => u.p.sym))];
  const { bars: eqDaily } = await fetchBars([...eqSyms, "SPY"], { start: "2026-07-28", end: "2026-08-08", adjustment: "raw", requireAll: false, quiet: true, minBars: 1 });
  const crSyms = [...new Set(cr.map(u => u.p.sym))];
  const crDaily = crSyms.length ? await cryptoBars(crSyms, "1Day", "2026-07-28", "2026-08-08") : {};
  const fxMap = {}; for (const u of fx) fxMap[u.p.sym] = u.p.cls === "FX" ? u.p.sym.replace("/", "") + "=X" : (u.p.priceSym || u.p.sym) + "=F";
  const fxDaily = fx.length ? await yahooDaily(fxMap) : {};

  // partial bars per settle morning: equities 13:30→13:48Z (09:30→09:47:59 ET), crypto 00:00Z→13:48Z
  const mornings = [...new Set(universe.map(u => u.settleDay))].sort();
  const eqPart = {}, crPart = {}, spyPart = {};
  for (const m of mornings) {
    const eqM = [...new Set(eq.filter(u => u.settleDay === m).map(u => u.p.sym))];
    const { bars } = await fetchBars([...eqM, "SPY"], { start: `${m}T13:30:00Z`, end: `${m}T13:48:00Z`, timeframe: "1Min", adjustment: "raw", requireAll: false, quiet: true, minBars: 1 });
    eqPart[m] = {}; for (const s of eqM) eqPart[m][s] = partial(bars[s]);
    spyPart[m] = partial(bars.SPY);
    const crM = [...new Set(cr.filter(u => u.settleDay === m).map(u => u.p.sym))];
    if (crM.length) {
      const cb = await cryptoBars(crM, "1Min", `${m}T00:00:00Z`, `${m}T13:48:00Z`);
      crPart[m] = {};
      for (const s of crM) {
        crPart[m][s] = partial(cb[s]);
        if (!crPart[m][s]) {   // Alpaca doesn't list it → Coinbase, the production fallback
          const cc = await coinbaseCandles(s, 300, `${m}T00:00:00Z`, `${m}T13:48:00Z`);
          if (cc) { crPart[m][s] = partial(cc); crPart[m][s].coinbase = true; }
        }
      }
    }
  }

  // ── 3. reconstruct ─────────────────────────────────────────────────────────────────────────
  const dOf = (b) => String(b.t).slice(0, 10);
  const rows = [], unpriceable = [];
  for (const { p, settleDay, lastDay } of universe) {
    const entryDay = day(p.addedAt);
    let scan = [], fidelity;
    if (p.cls === "Equity" || p.cls === "Crypto") {
      let daily = (p.cls === "Equity" ? eqDaily[p.sym] : crDaily[p.sym]) || [];
      if (!daily.length && p.cls === "Crypto") daily = (await coinbaseCandles(p.sym, 86400, "2026-07-28T00:00:00Z", "2026-08-08T00:00:00Z")) || [];
      const mids = daily.filter(b => dOf(b) > entryDay && dOf(b) < settleDay);
      const pb = (p.cls === "Equity" ? eqPart[settleDay]?.[p.sym] : crPart[settleDay]?.[p.sym]);
      if (!pb) { unpriceable.push({ id: p.id, sym: p.sym, cls: p.cls, why: "no minute bars for settle morning" }); continue; }
      scan = [...mids, pb]; fidelity = pb.coinbase ? "partial-5min-coinbase" : "partial-1min";
    } else {
      const daily = fxDaily[p.sym] || [];
      const mids = daily.filter(b => (b.t ? dOf(b) : null) > entryDay && dOf(b) < settleDay);
      const sBar = daily.find(b => dOf(b) === settleDay);
      if (!sBar || sBar.o == null) { unpriceable.push({ id: p.id, sym: p.sym, cls: p.cls, why: "no settle-day bar" }); continue; }
      scan = [...mids, { o: sBar.o, h: sBar.o, l: sBar.o, c: sBar.o }]; fidelity = "daily-open";  // open-only: the day's range wasn't knowable at 09:47
    }
    if (!scan.length) { unpriceable.push({ id: p.id, sym: p.sym, cls: p.cls, why: "empty scan" }); continue; }
    const s = settle(p, scan);
    const spyD = eqDaily.SPY || [];
    const prevSpy = [...spyD].reverse().find(b => dOf(b) < settleDay);
    const mktRet = (prevSpy && spyPart[settleDay]) ? ((spyPart[settleDay].c - prevSpy.c) / prevSpy.c) * 100 : null;
    rows.push({
      id: p.id, sym: p.sym, cls: p.cls, dir: p.dir, sizeLabel: p.sizeLabel, entry: p.entry, stopDist: p.stopDist,
      units: p.units, dollarPerPoint: p.dollarPerPoint, conf: p.conf, strategy: p.strategy, rr: p.rr, score: p.score,
      nBull: p.nBull, nBear: p.nBear, total: p.total, obs: p.obs || null, ctrl: !!p.ctrl, ctrlRand: !!p.ctrlRand,
      erDays: p.earningsInDays ?? null, openedAt: p.addedAt, closedAt: Date.parse(`${settleDay}T13:48:00Z`),
      ...s, mktRet, reconstructed: true, fidelity, provenance: { lastBackup: lastDay, settleDay, engine: "reconstruct-lost-week v2" },
    });
  }

  // ── 4. reconciliation vs the contemporaneous run log ──────────────────────────────────────
  const byMorning = {};
  for (const r of rows) byMorning[r.provenance.settleDay] = (byMorning[r.provenance.settleDay] || 0) + 1;
  console.log("\nreconciliation (reconstructed vs the run log's own claims):");
  for (const m of mornings) console.log(`  ${m}: reconstructed ${byMorning[m] || 0}${LOG_CLAIMS[m] != null ? ` · log claimed "settled ${LOG_CLAIMS[m]}"` : " · run crashed before printing a count"}`);
  if (unpriceable.length) console.log(`  unpriceable (excluded, listed in output): ${unpriceable.length}`);

  // ── 5. known-answer test: same engine on the Friday-evening book (in backup-08-10, written
  //      by Monday's morning chain) vs the 99 REAL banked Monday settles ─────────────────────
  const monBackup = JSON.parse(fs.readFileSync(D("board_positions.backup-2026-08-10.json"), "utf8"));
  const monBook = monBackup.filter(p => p.cls !== "Options" && !(["Equity", "Crypto", "FX"].includes(p.cls) && p.dollarPerPoint * p.entry > BROKEN_NOTIONAL));
  const bankedRows = (Array.isArray(log) ? log : log.log || []).filter(t => day(t.openedAt) === "2026-08-07");
  const bankedById = new Map(bankedRows.map(t => [t.id, t]));
  const monEq = [...new Set(monBook.filter(p => p.cls === "Equity").map(p => p.sym))];
  const { bars: monDaily } = await fetchBars([...monEq, "SPY"], { start: "2026-08-05", end: "2026-08-11", adjustment: "raw", requireAll: false, quiet: true, minBars: 1 });
  const { bars: monMin } = await fetchBars(monEq, { start: "2026-08-10T13:30:00Z", end: "2026-08-10T13:48:00Z", timeframe: "1Min", adjustment: "raw", requireAll: false, quiet: true, minBars: 1 });
  const monCr = [...new Set(monBook.filter(p => p.cls === "Crypto").map(p => p.sym))];
  const monCrMin = monCr.length ? await cryptoBars(monCr, "1Min", "2026-08-10T00:00:00Z", "2026-08-10T13:48:00Z") : {};
  let ka = { compared: 0, exitMae: [], rDelta: [], reasonAgree: 0 };
  for (const p of monBook) {
    const b = bankedById.get(p.id);
    if (!b) continue;
    let pb = null;
    if (p.cls === "Equity") pb = partial(monMin[p.sym]);
    else if (p.cls === "Crypto") pb = partial(monCrMin[p.sym]);
    if (!pb) continue;                                   // FX/futures + unpriceable skipped: different stratum
    const s = settle(p, [pb]);
    ka.compared++;
    ka.exitMae.push(Math.abs(s.exit - b.exit) / b.exit);
    ka.rDelta.push(s.rMult - b.rMult);
    if (s.reason === b.reason) ka.reasonAgree++;
  }
  const kaOut = {
    compared: ka.compared,
    exitMaePct: +(100 * mean(ka.exitMae)).toFixed(4),
    rMultMeanDelta: +mean(ka.rDelta)?.toFixed(5),
    rMultRmse: +Math.sqrt(mean(ka.rDelta.map(x => x * x)) || 0).toFixed(5),
    reasonAgreePct: +(100 * ka.reasonAgree / (ka.compared || 1)).toFixed(1),
  };
  console.log(`\nknown-answer (engine vs 99 real Monday settles): ${JSON.stringify(kaOut)}`);

  // ── 6. shadow-model recovery readout (production convention: MT session, ≥5 scored, top floor(n/5)) ──
  // Comparable pool = both partial strata (production's own banked crypto settles ride the same
  // Coinbase/forming-bar precision, so 5-min-coinbase is convention-matched, not degraded);
  // fidelity stays on every row so any reviewer can stratify. daily-open never enters.
  const comparable = rows.filter(r => r.fidelity.startsWith("partial") && !r.ctrl);
  const scored = comparable.filter(r => r.obs && Number.isFinite(r.obs.modelScore));
  const bySession = new Map();
  for (const t of scored) { const d = t.provenance.settleDay; (bySession.get(d) || bySession.set(d, []).get(d)).push(t); }
  const shadowSessions = [];
  for (const [d, arr] of [...bySession.entries()].sort()) {
    if (arr.length < 5) continue;
    const s = [...arr].sort((a, b) => b.obs.modelScore - a.obs.modelScore);
    const q = Math.max(1, Math.floor(s.length / 5));
    shadowSessions.push({ d, n: arr.length, gap: +(mean(s.slice(0, q).map(t => t.rMult)) - mean(s.slice(q).map(t => t.rMult))).toFixed(5) });
  }
  console.log(`\nshadow recovery: ${scored.length} scored settles across ${shadowSessions.length} session(s):`);
  for (const s of shadowSessions) console.log(`  ${s.d}  n=${s.n}  gap ${s.gap >= 0 ? "+" : ""}${s.gap}`);

  const comparableStats = { n: comparable.length, win: +(100 * comparable.filter(r => r.rMult > 0).length / (comparable.length || 1)).toFixed(1), avgR: +mean(comparable.map(r => r.rMult))?.toFixed(4), pnl: +comparable.reduce((s, r) => s + (r.pnl || 0), 0).toFixed(0) };
  const strat2 = rows.filter(r => r.fidelity === "daily-open");
  console.log(`\ncomparable stratum (partial-1min, non-control): ${JSON.stringify(comparableStats)}`);
  console.log(`daily-open stratum (FX/futures — reported separately, NEVER pooled): n=${strat2.length}, avgR ${mean(strat2.map(r => r.rMult))?.toFixed(4)}`);

  fs.writeFileSync(OUT, JSON.stringify({
    spec: "reconstruct-lost-week v2 (panel-revised 2026-08-12)",
    builtAt: new Date().toISOString(),
    conventions: {
      exits: "production settle rule verbatim; partial bar = 1Min bars aggregated 09:30–09:47:59 ET (crypto: 00:00Z–13:48Z); adjustment=raw",
      strata: { "partial-1min": "comparable with banked rows", "daily-open": "FX/futures fallback — reported separately, never pooled" },
      cap: "MAX_LOSS_R=0 (verified via git for the whole week)",
    },
    limitations: [
      "known-answer validates the mechanism on Monday-shaped settles only; the crashed days are unverifiable by construction",
      "per-session effective-N is small; the shadow evaluation's band discipline governs any read",
      "positions the watcher closed without banking (if any) are unknowable and absent",
    ],
    exclusions: excl, unpriceable, reconciliation: { claims: LOG_CLAIMS, reconstructed: byMorning },
    knownAnswer: kaOut, shadowSessions, comparableStats,
    rows,
  }, null, 1));
  console.log(`\nwritten: ${path.basename(OUT)} — ${rows.length} reconstructed rows (${comparable.length} comparable, ${strat2.length} daily-open stratum)`);
})();
