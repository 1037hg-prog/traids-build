#!/usr/bin/env node
"use strict";
/**
 * R192 — MONTH-END INDEX-EXTENSION DEMAND BEYOND TREASURIES: FORWARD SHADOW. 2026-10-16 (backlog row 11/27).
 *
 * WHY THIS EXISTS. R192 was read once on history (2016-01..2026-08, PASS: AGG/LQD/MUB month-end window +0.191%/mo,
 * t 2.500 >= 2.356, placebo p95 0.17) and sealed. Nothing ran it forward, so the rule has produced no out-of-sample
 * evidence since. This runner records, every session, WHAT THE RULE WOULD HAVE DONE — and nothing else.
 *
 * IT PLACES NO ORDER OF ANY KIND. It holds no position and never asks a broker for one: it requires no broker
 * module and reads only daily bars (and, when it can, the exchange's session calendar). Its only writes are its own
 * JSONL (data/r192-month-end-shadow.jsonl) and the read-out JSON beside it. It never writes read-seals.json or
 * test-registry.json: R192 is SEALED and this record is NOT a second read of it. The registry's audit note stands —
 * R192 is not independent of R180 — and nothing here changes that.
 *
 * THE RULE, EXACTLY AS REGISTERED. data/test-registry.json, preregistered[id=R192]:
 *   "Exactly R180's rule and statistic (last 5 trading days' total return minus 5 x the month's other-day mean,
 *    2 bps a side) on AGG, LQD and MUB (Alpaca SIP daily, adjustment=all). Primary: the equal-weight average of the
 *    three per month. Reported: each alone, and HYG as a contrast (high yield, less index-extension-driven)."
 *   Statistic: "Per month, the pooled window excess; t over months. Placebo as R180 (random 5-day windows, 200 draws)."
 *   Bar: bar.tRequired, READ FROM THE REGISTRY AT RUN TIME so nothing here can drift from it.
 * The arithmetic is carried over character for character from the sealed read, backend/r192-bond-month-end.js, and
 * the package's selftest holds this file's `excessAt`, `lastStart`, the >= 15-return month filter, the 2 bps cost and
 * the placebo draw to that file's text AND to its behaviour on fixtures:
 *   excessAt(a, start)  window prod(1+r) - 1  -  5 x mean(the month's other returns)  -  0.0004
 *   lastStart(a)        a.length - 5                     (the month's last five sessions)
 *   month admitted      every primary fund has >= 15 daily returns that month
 *   placebo             200 draws, mulberry(192000 + k), start floor(rng() x (a.length - 4)); p95 = draws[floor(0.95 x 200)]
 *
 * FORWARD, AND ONLY FORWARD. The record starts on the session this runner first fires and never backfills: a month
 * is scored only when its FIRST session is on or after that date, so no part of the sealed sample can leak into the
 * forward sample. Months held back for that reason are named in the read-out.
 *
 * WHAT A ROW MEANS (data/r192-month-end-shadow.jsonl, append-only, one row per kind+key, never rewritten):
 *   start     the record's first row: evidence start, the rule's source file and its sha256 at build time.
 *   run       one per run: the run's ET date, the bar window actually served, and what it wrote.
 *   session   one per completed session, from each fund's own daily bar: the fund returns of the day and whether the
 *             rule WOULD HAVE BEEN LONG that session — decided from the exchange's published session calendar, the
 *             only way the answer is knowable on the day. When the calendar cannot be read the row says so
 *             (`plan.from: "unavailable"`) rather than pretending the day was decidable.
 *   month     one per completed month: the registered statistic from the month's REALIZED sessions (the registered
 *             definition: trading days are the funds' own daily bars), each fund alone, HYG as the contrast, the
 *             month's daily returns kept in the row so the read-out and the placebo can be re-derived from the
 *             record alone, and whether the calendar's window agreed with the realized one.
 *   A month that cannot be scored is written as a gap row ({ gap: true, why }) — never a guessed number.
 *
 *   node backend/r192-month-end-shadow.js            record the sessions and months that have completed (close chain)
 *   node backend/r192-month-end-shadow.js --status   read-only: the record as it stands, writes nothing
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const SL = require("./lib/shadow-ledger.js");

const D = (f) => path.join(__dirname, "data", f);
const JSONL = D("r192-month-end-shadow.jsonl"), OUT = D("r192-month-end-shadow.json");
const RULE_SOURCE = path.join(__dirname, "r192-bond-month-end.js");
const SPEC = "r192-month-end-shadow-v1";
const SYMS = ["AGG", "LQD", "MUB", "HYG"], PRIMARY = ["AGG", "LQD", "MUB"], CONTRAST = "HYG";
const COST = 0.0004;        // 2 bps a side, as registered
const WIN = 5, MIN_RETURNS = 15, DRAWS = 200, SEED_BASE = 192000;
const LOOKBACK_DAYS = 70;   // enough history to hold the previous month's last close behind the current month

// ── the arithmetic, character for character from backend/r192-bond-month-end.js ───────────────────────────────
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const excessAt = (a, start) => { const w = a.slice(start, start + 5), o = [...a.slice(0, start), ...a.slice(start + 5)]; return w.reduce((p, x) => p * (1 + x), 1) - 1 - 5 * mean(o) - COST; };
const lastStart = (a) => a.length - 5;
const f3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));
const tSafe = (a) => (a.length >= 2 && sd(a) > 0 ? tOf(a) : null);

// ── the daily returns, built exactly as the sealed read builds them ───────────────────────────────────────────
/**
 * byMonth(bars) -> { sym: { "YYYY-MM": [daily returns] } }, and the bar dates per symbol.
 * A month's first return is measured from the previous session's close, which is the previous month's last close —
 * the sealed read's own construction (`for i = 1 ... b[i].c / b[i-1].c - 1`, keyed on b[i]'s month).
 */
function byMonth(bars) {
  const byM = {}, dates = {};
  for (const s of Object.keys(bars)) {
    byM[s] = {}; dates[s] = [];
    const b = [...(bars[s] || [])].filter((x) => x && x.d && Number.isFinite(x.c) && x.c > 0).sort((p, q) => (p.d < q.d ? -1 : p.d > q.d ? 1 : 0));
    for (let i = 0; i < b.length; i++) {
      dates[s].push(b[i].d);
      if (i === 0) continue;
      const m = b[i].d.slice(0, 7);
      (byM[s][m] = byM[s][m] || []).push({ d: b[i].d, r: b[i].c / b[i - 1].c - 1 });
    }
  }
  return { byM, dates };
}
const retsOf = (byM, s, m) => (byM[s][m] || []).map((x) => x.r);
/** the months every primary fund covers with at least MIN_RETURNS returns — the registered admission test */
const admittedMonths = (byM) => Object.keys(byM[PRIMARY[0]] || {}).filter((m) => PRIMARY.every((s) => retsOf(byM, s, m).length >= MIN_RETURNS)).sort();
/** a month is complete once a later month has a bar in every primary fund */
const monthComplete = (byM, m) => PRIMARY.every((s) => Object.keys(byM[s] || {}).some((k) => k > m));

/** the registered month statistic for one month, from the realized sessions */
function scoreMonth(byM, m) {
  const each = {};
  for (const s of SYMS) {
    const a = retsOf(byM, s, m);
    if (a.length < WIN) { each[s] = null; continue; }
    const start = lastStart(a), w = a.slice(start, start + WIN), o = [...a.slice(0, start), ...a.slice(start + WIN)];
    each[s] = { sessions: a.length, windowPct: +(100 * (w.reduce((p, x) => p * (1 + x), 1) - 1)).toFixed(4), otherMeanPct: o.length ? +(100 * mean(o)).toFixed(4) : null, excess: excessAt(a, start) };
  }
  const prim = PRIMARY.map((s) => each[s] && each[s].excess).filter((x) => Number.isFinite(x));
  return { each, primary: prim.length === PRIMARY.length ? mean(prim) : null, contrast: each[CONTRAST] ? each[CONTRAST].excess : null };
}

/** the window the exchange calendar says the rule is long: the month's last five scheduled sessions */
function plannedWindow(sessions) {
  const s = [...(sessions || [])].filter(Boolean).sort();
  if (s.length < WIN + 1) return null;                       // a month with no non-window day has no statistic
  return { entryDay: s[s.length - WIN - 1], firstLongDay: s[s.length - WIN], exitDay: s[s.length - 1], window: s.slice(-WIN) };
}

/**
 * THE ROWS — pure. Everything the runner writes is decided here from the bars, the calendar it could read, the
 * run's ET date and the record so far.
 *   bars            { sym: [{ d, c }] }, SIP daily adjustment=all
 *   monthSessions   { "YYYY-MM": [session dates] } from the exchange calendar; a month missing from it is undecidable
 *   runDate         the run's ET date; only sessions strictly before it are recorded
 *   evidenceStart   the first session the forward record covers
 * -> { sessions: [row], months: [row], held: [{ key, why }] }
 */
function plan({ bars, monthSessions = {}, runDate, evidenceStart, have = new Set() }) {
  const { byM } = byMonth(bars);
  const anchor = byM[PRIMARY[0]] || {};
  const sessions = [], months = [], held = [];

  // one row per completed session, from the anchor fund's own bar dates
  const days = Object.keys(anchor).sort().flatMap((m) => anchor[m].map((x) => x.d)).filter((d) => d >= evidenceStart && d < runDate).sort();
  for (const d of days) {
    if (have.has(`session|${d}`)) continue;
    const m = d.slice(0, 7), pw = plannedWindow(monthSessions[m]);
    const funds = {};
    for (const s of SYMS) { const hit = (byM[s][m] || []).find((x) => x.d === d); funds[s] = hit ? hit.r : null; }
    const long = pw ? pw.window.includes(d) : null;
    sessions.push({ kind: "session", key: d, ym: m,
      plan: pw ? { long, from: "exchange session calendar", entryDay: pw.entryDay, firstLongDay: pw.firstLongDay, exitDay: pw.exitDay }
        : { long: null, from: "unavailable", why: `no session calendar for ${m} — whether ${d} is one of the month's last ${WIN} sessions was not decidable on the day` },
      wouldHold: long === true ? [...PRIMARY] : long === false ? [] : null,
      funds, note: long === true ? "the rule is long the three primary funds into the month-end close" : long === false ? "flat" : "undecided" });
  }

  // one row per completed month
  for (const m of Object.keys(anchor).sort()) {
    if (have.has(`month|${m}`)) continue;
    if (!monthComplete(byM, m)) { held.push({ key: m, why: "the month is not finished (no later bar yet)" }); continue; }
    const first = anchor[m][0] && anchor[m][0].d;
    if (!first || first < evidenceStart) { months.push({ kind: "month", key: m, gap: true, why: `the month's first session ${first || "?"} is before the forward record's start ${evidenceStart} — not scored: this shadow never backfills into R192's sealed sample` }); continue; }
    if (!admittedMonths(byM).includes(m)) { months.push({ kind: "month", key: m, gap: true, why: `a primary fund has fewer than ${MIN_RETURNS} daily returns in ${m} — the registered month filter excludes it` }); continue; }
    const sc = scoreMonth(byM, m), pw = plannedWindow(monthSessions[m]);
    const realized = anchor[m].slice(-WIN).map((x) => x.d);
    months.push({ kind: "month", key: m, sessions: anchor[m].length, realizedWindow: realized,
      calendarWindow: pw ? pw.window : null, calendarAgreed: pw ? JSON.stringify(pw.window) === JSON.stringify(realized) : null,
      each: Object.fromEntries(SYMS.map((s) => [s, sc.each[s] ? { ...sc.each[s], excessPct: +(100 * sc.each[s].excess).toFixed(4) } : null])),
      primary: sc.primary, primaryPct: sc.primary == null ? null : +(100 * sc.primary).toFixed(4),
      contrast: sc.contrast, contrastPct: sc.contrast == null ? null : +(100 * sc.contrast).toFixed(4),
      cost: COST, rets: Object.fromEntries(SYMS.map((s) => [s, retsOf(byM, s, m)])) });
  }
  return { sessions, months, held };
}

/**
 * THE READ-OUT — the forward statistic, re-derived from the RECORD (the month rows' own daily returns) with the
 * registered functions, so the number in the read-out and the number in the record cannot drift apart. The placebo
 * is the registered one. Reported beside the registered bar; this is a record, not a read of R192, which is sealed.
 */
function readout(rows, { bar = null, barSource = null } = {}) {
  const start = SL.startOf(rows);
  const M = rows.filter((r) => r.kind === "month" && !r.gap && r.rets), gaps = rows.filter((r) => r.kind === "month" && r.gap);
  const keys = M.map((r) => r.key).sort();
  const byKey = new Map(M.map((r) => [r.key, r]));
  /** a fund's month is usable only when that month holds a full window and at least one other day */
  const usable = (m, syms) => syms.every((s) => ((byKey.get(m).rets || {})[s] || []).length >= WIN + 1);
  const series = (syms, pick) => keys.filter((m) => usable(m, syms)).map((m) => mean(syms.map((s) => { const a = byKey.get(m).rets[s]; return excessAt(a, pick(a, m)); })));
  const primaryKeys = keys.filter((m) => usable(m, PRIMARY));
  const primary = series(PRIMARY, lastStart);
  const each = Object.fromEntries(SYMS.map((s) => { const v = series([s], lastStart); return [s, { months: v.length, meanPct: v.length ? +(100 * mean(v)).toFixed(3) : null, t: f3(tSafe(v)) }]; }));
  // the record must agree with itself: each month row's stored primary re-derived from its own returns
  const drift = primaryKeys.map((m, i) => byKey.get(m).primary).map((p, i) => (Number.isFinite(p) ? Math.abs(p - primary[i]) : NaN)).filter((x) => Number.isFinite(x));
  let placebo = null;
  if (keys.length >= 2) {
    const draws = [];
    for (let k = 0; k < DRAWS; k++) { const rng = mulberry(SEED_BASE + k); const v = series(PRIMARY, (a) => Math.floor(rng() * (a.length - 4))); const t = tSafe(v); if (t != null) draws.push(t); }
    draws.sort((a, b) => a - b);
    placebo = draws.length ? { draws: draws.length, p95: f3(draws[Math.floor(0.95 * draws.length)]), median: f3(draws[Math.floor(0.5 * draws.length)]) } : null;
  }
  const t = tSafe(primary);
  const S = rows.filter((r) => r.kind === "session");
  return { spec: SPEC, test: "R192", kind: "FORWARD SHADOW — no orders, no position, not a read of R192 (it is sealed)",
    evidenceStart: start ? start.evidenceStart : null, ruleSource: start ? start.ruleSource : null, ruleSha: start ? start.ruleSha : null,
    sessionsRecorded: S.length, longSessions: S.filter((r) => r.plan && r.plan.long === true).length, undecidedSessions: S.filter((r) => r.plan && r.plan.long === null).length,
    runs: rows.filter((r) => r.kind === "run").length,
    months: keys.length, monthsHeldOrSkipped: gaps.length, window: keys.length ? [keys[0], keys[keys.length - 1]] : null,
    primary: { months: primary.length, meanPct: primary.length ? +(100 * mean(primary)).toFixed(3) : null, t: f3(t), winPct: primary.length ? +(100 * primary.filter((x) => x > 0).length / primary.length).toFixed(0) : null },
    each, contrast: { [CONTRAST]: each[CONTRAST] }, placebo,
    recordSelfCheck: { months: drift.length, maxAbsDiffStoredVsRederived: drift.length ? +Math.max(...drift).toExponential(2) : null },
    calendarDisagreements: rows.filter((r) => r.kind === "month" && r.calendarAgreed === false).map((r) => r.key),
    bar: { tRequired: bar, source: barSource, note: "R192's registered bar, printed for comparison only: the registered read is spent, this record clears no bar and seals nothing. The registry's audit note stands — R192 is not independent of R180." } };
}

// ── the live readers (lazy-required so this file loads, and is testable, without them) ────────────────────────
/** SIP daily bars, adjustment=all, through the most recent end the plan will serve (lib/sip-fetch walks it back) */
async function defaultFetchBars(symbols, { start, end }) {
  const { fetchBarsSip } = require("./lib/sip-fetch.js");
  const r = await fetchBarsSip(symbols, { start, end, adjustment: "all", timeframe: "1Day", requireAll: true, quiet: true });
  return { bars: Object.fromEntries(symbols.map((s) => [s, ((r.bars || {})[s] || []).map((b) => ({ d: b.t.slice(0, 10), c: b.c }))])), effectiveEnd: r.effectiveEnd, walkedBack: r.walkedBack };
}
/** the exchange's scheduled sessions for the months in `yms` — read-only; null when it cannot be read */
async function defaultCalendar(yms) {
  try {
    require("dotenv").config({ path: path.join(__dirname, ".env") });
    const h = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
    const out = {};
    for (const ym of yms) {
      const [y, m] = ym.split("-").map(Number), end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${ym}-01&end=${end}`, { headers: h, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`calendar ${r.status}`);
      out[ym] = (await r.json()).map((x) => x.date);
    }
    return out;
  } catch (e) { return { __error: String(e.message || e).slice(0, 160) }; }
}
/** the registered bar, read from the registry at run time so nothing here can drift from it */
function registeredBar(dir) {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "test-registry.json"), "utf8"));
    const E = (reg.preregistered || []).find((x) => x.id === "R192");
    if (E && E.bar && Number.isFinite(E.bar.tRequired)) return { bar: E.bar.tRequired, barSource: "data/test-registry.json preregistered[R192].bar.tRequired" };
    return { bar: null, barSource: E ? "the R192 registry entry carries no bar.tRequired" : "no R192 entry in data/test-registry.json (redacted copy?)" };
  } catch (e) { return { bar: null, barSource: `data/test-registry.json could not be read (${String(e.message).slice(0, 80)})` }; }
}

const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

/** one run. deps are injected by the selftest; the defaults are the live readers and the real clock. */
async function run({ dir = D(""), jsonl = JSONL, out = OUT, now = Date.now(), ruleSource = RULE_SOURCE, fetchBars = defaultFetchBars, calendar = defaultCalendar, log = (s) => console.log(s), write = true } = {}) {
  const rows = SL.readRows(jsonl);
  const runDate = SL.etDate(now);
  const start = SL.startOf(rows);
  const opening = start ? null : SL.startRow({ test: "R192", spec: SPEC, evidenceStart: runDate, ruleSource: path.basename(ruleSource), ruleSha: SL.shaOf(ruleSource),
    note: "forward record of what R192's month-end rule would have done. No orders. The rule is read from data/test-registry.json preregistered[R192]; the arithmetic is the sealed read's." });
  const evidenceStart = start ? start.evidenceStart : runDate;

  const fetched = await fetchBars(SYMS, { start: addDays(evidenceStart, -LOOKBACK_DAYS), end: runDate });
  const bars = fetched.bars || fetched;
  const months = [...new Set(Object.values(bars).flat().map((b) => b.d.slice(0, 7)))].sort();
  const cal = (await calendar(months)) || {};
  const calErr = cal.__error || null; if (calErr) delete cal.__error;

  const have = SL.keysOf(rows); if (opening) have.add("start|R192");
  const P = plan({ bars, monthSessions: cal, runDate, evidenceStart, have });
  const runRow = { kind: "run", key: runDate, sessionsWritten: P.sessions.map((r) => r.key), monthsWritten: P.months.map((r) => r.key), held: P.held,
    barsThrough: fetched.effectiveEnd || null, barsWalkedBack: fetched.walkedBack ?? null,
    calendar: calErr ? { read: false, why: calErr } : { read: true, months: Object.keys(cal).length },
    orders: "none — this runner places no order of any kind" };

  const batch = [...(opening ? [opening] : []), ...P.sessions, ...P.months, runRow];
  const res = write ? SL.appendRows(jsonl, batch, { now }) : { appended: [], skipped: batch };
  const all = write ? SL.readRows(jsonl) : [...rows, ...batch];
  const report = readout(all, registeredBar(dir));
  if (write) writeJsonAtomic(out, { ...report, asOf: new Date(now).toISOString() });

  log(`R192 forward shadow — run ${runDate} · wrote ${P.sessions.length} session row(s), ${P.months.length} month row(s)${P.held.length ? `, held ${P.held.length}` : ""} · record: ${report.sessionsRecorded} sessions, ${report.months} scored month(s) since ${report.evidenceStart || runDate}`);
  if (report.months) log(`  primary AGG/LQD/MUB ${report.primary.meanPct}%/mo · t ${report.primary.t ?? "—"} (bar ${report.bar.tRequired ?? "—"}, comparison only) · ${CONTRAST} contrast ${report.each[CONTRAST].meanPct}%/mo`);
  if (calErr) log(`  session calendar not read (${calErr}) — those sessions are recorded as undecided, never guessed`);
  for (const h of P.held) log(`  held ${h.key}: ${h.why}`);
  return { runDate, appended: res.appended, report, rows: all };
}

module.exports = { SPEC, SYMS, PRIMARY, CONTRAST, COST, WIN, MIN_RETURNS, DRAWS, SEED_BASE, LOOKBACK_DAYS, mean, sd, tOf, tSafe, mulberry, excessAt, lastStart, byMonth, retsOf, admittedMonths, monthComplete, scoreMonth, plannedWindow, plan, readout, registeredBar, run, addDays, JSONL, OUT, RULE_SOURCE };

if (require.main === module) {
  (async () => {
    if (process.argv.includes("--status")) { const rows = SL.readRows(JSONL); console.log(JSON.stringify(readout(rows, registeredBar(D(""))), null, 1)); return; }
    await run({});
  })().catch((e) => { console.error("R192 forward shadow FAILED (nothing recorded):", e.message); process.exit(1); });
}
