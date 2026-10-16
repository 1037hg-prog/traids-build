#!/usr/bin/env node
"use strict";
/**
 * R275 — RELEASE-DAY FILTER ON THE OPTION SLEEVES: FORWARD SHADOW. 2026-10-16 (backlog row 11/27).
 *
 * WHY THIS EXISTS. R275 was read once and sealed on history (V1 0DTE release sessions vs other sessions, Welch t;
 * V2 weekly wings exposed minus unexposed within a session, one-sample t; one-sided bar t <= -2.006). Nothing ran it
 * forward, so from the day it sealed the filter has produced no new evidence at all. This runner records, every
 * session, WHAT THE FILTER WOULD HAVE DONE to the two short-premium sleeves — and nothing else.
 *
 * IT PLACES NO ORDER OF ANY KIND. It holds no position, touches no board, no ledger and no broker: it requires no
 * broker module, opens no socket, and its only write is its own JSONL (data/r275-release-shadow.jsonl) and the
 * read-out JSON beside it. It never writes read-seals.json or test-registry.json: R275 is SEALED and this record is
 * NOT a second read of it. The forward numbers below are a record, not a verdict, and they clear no bar.
 *
 * THE RULE, EXACTLY AS REGISTERED. R275's registry entry is reduced to its id in this clean copy
 * (`{"id":"R275","screenRedacted":true}`), so the rule text here is taken from the sealed read itself,
 * backend/r275-release-filter.js, whose own header names data/test-registry.json as the authority. The two
 * decision expressions are carried over character for character and the package's selftest holds them to the sealed
 * file's text AND to its behaviour on fixtures:
 *
 *   release session   types.some((k) => EV[k].has(d))                               — CPI, NFP or FOMC dated d
 *   wing exposed      (d > r.d || (k === "FOMC" && d === r.d)) && d <= r.expiry      — a release after entry (an
 *                                                                                     FOMC on the entry day counts)
 *                                                                                     and on or before expiry
 *   event dates       data/macro-calendar.json, read as the sealed file reads it (a string, or .date, or .d)
 *   V1 statistic      per session the MEAN R of that session's 0DTE tickets; Welch t of release sessions' means
 *                     against other sessions' means
 *   V2 statistic      per ENTRY session, mean R of the exposed wings minus mean R of the unexposed wings; plain
 *                     one-sample t over the sessions that have both
 *   bar               one-sided, t <= -2.006 (reported for comparison only — the registered read is spent)
 *
 * THE ONE FORWARD ADAPTATION, STATED RATHER THAN BURIED. The sealed read measured archives: r116's 0DTE replay rows
 * and r21's wing replay rows. Forward there are no replays, so the population is the live sleeves those archives
 * replay — the board's own tickets, strategy "R25-0dte" (V1) and "R21-premium" (V2), as backend/options-news-shadow.js
 * already reads them. A ticket's R is the ledger's rMult, which for these sleeves is net P&L over riskDollars, the
 * defined max loss (backend/options-settle.js) — the same quantity the replays called pnl / maxLoss. Control twins
 * (ctrl / ctrlRand) are not trades and are excluded. Nothing else about the rule changes.
 *
 * WHAT A ROW MEANS (data/r275-release-shadow.jsonl, append-only, one row per kind+key, never rewritten):
 *   start        the record's first row: evidence start, the rule's source file and its sha256 at build time.
 *   run          one per run: the run's ET date and what it wrote. The proof the shadow fired that night.
 *   session      one per session with sleeve activity, written the first run AFTER that session has ended:
 *                the release classification, the 0DTE cell (tickets, mean R, P&L, and `wouldSkip` — the filter's
 *                decision for the day), the wings OPENED that session with the filter's verdict on each
 *                (`wouldDecline`), and the wings that SETTLED that session.
 *   wing-cell    one per ENTRY session, written once every wing entered that session has settled: the V2 cell
 *                (mean exposed R, mean unexposed R, their difference).
 *   A session the macro calendar does not cover is written as a gap row ({ gap: true, why }) — never classified
 *   from a guess, and never silently left out.
 *
 * LAG, BY DESIGN. A session is recorded on the first run strictly after it ends, so the night's settles are already
 * in the ledger. A 0DTE ticket still unsettled then holds its session back for at most SETTLE_GRACE_DAYS; after that
 * the row is written with what settled and the unsettled ids named in it, so the record never stalls and never
 * quietly drops a ticket.
 *
 *   node backend/r275-release-shadow.js            record the sessions that have ended since the last run (close chain)
 *   node backend/r275-release-shadow.js --status   read-only: the record as it stands, writes nothing
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const SL = require("./lib/shadow-ledger.js");

const D = (f) => path.join(__dirname, "data", f);
const JSONL = D("r275-release-shadow.jsonl"), OUT = D("r275-release-shadow.json");
const RULE_SOURCE = path.join(__dirname, "r275-release-filter.js");
const SPEC = "r275-release-shadow-v1";
const TYPES = ["CPI", "NFP", "FOMC"];
const SLEEVE_V1 = "R25-0dte", SLEEVE_V2 = "R21-premium";
const BAR = 2.006;                 // the sealed read's one-sided bar, reported for comparison only
const SETTLE_GRACE_DAYS = 7;       // a 0DTE ticket unsettled this long after entry is a defect, not a trade

// ── the statistics, character for character from backend/r275-release-filter.js ────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const vr = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
const tOne = (a) => (a.length > 2 ? mean(a) / Math.sqrt(vr(a) / a.length) : null);
const welch = (a, b) => (a.length > 1 && b.length > 1 ? (mean(a) - mean(b)) / Math.sqrt(vr(a) / a.length + vr(b) / b.length) : null);
const f = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

// ── the rule, character for character from backend/r275-release-filter.js (EV is a parameter here so the rule can
//    be tested; the decision expressions themselves are untouched) ───────────────────────────────────────────────
/** the event-date sets, as the sealed read builds them: a string, or .date, or .d; `from`/`to` bound the window */
const releaseSets = (cal, { from = "0000-01-01", to = "9999-12-31" } = {}) => {
  const dates = (k) => new Set(((cal || {})[k] || []).map((x) => (typeof x === "string" ? x : x.date || x.d)).filter((d) => d && d >= from && d <= to));
  return Object.fromEntries(TYPES.map((k) => [k, dates(k)]));
};
/** is session d a release session? */
const anyRelease = (EV, d, types = TYPES) => types.some((k) => EV[k].has(d));
/** which of CPI/NFP/FOMC fall on d */
const releaseTypesOn = (EV, d, types = TYPES) => types.filter((k) => EV[k].has(d));
/** is wing r (entered r.d, expiring r.expiry) exposed to a release? */
const exposedTo = (EV, r, types = TYPES) => { for (const k of types) for (const d of EV[k]) { if ((d > r.d || (k === "FOMC" && d === r.d)) && d <= r.expiry) return true; } return false; };
/** the releases that expose wing r, named so a row says why it was declined */
const exposingReleases = (EV, r, types = TYPES) => { const out = []; for (const k of types) for (const d of EV[k]) { if ((d > r.d || (k === "FOMC" && d === r.d)) && d <= r.expiry) out.push(`${d} ${k}`); } return out.sort(); };
/** the span of sessions the calendar can classify: outside it, a session is a gap, never a guess */
const calendarCover = (EV) => { const all = TYPES.flatMap((k) => [...EV[k]]).sort(); return { from: all[0] || null, to: all[all.length - 1] || null, events: all.length }; };

// ── the population: the two live short-premium sleeves ────────────────────────────────────────────────────────
const asArray = (j) => (Array.isArray(j) ? j : (j && (j.trades || j.rows || j.positions)) || (j && Object.values(j).find(Array.isArray)) || []);
/**
 * normalise the board's option tickets into the rows the rule reads. Closed rows win over open ones with the same
 * id (a settled ticket is the fuller record). A ticket with no entry timestamp, and any control twin, is dropped.
 */
function sleeveTickets({ tradeLog = [], board = [] } = {}) {
  const all = [...asArray(tradeLog).map((t) => ({ ...t, _state: "closed" })), ...asArray(board).map((t) => ({ ...t, _state: "open" }))];
  const seen = new Set(), out = [];
  for (const t of all) {
    if (!t || (t.strategy !== SLEEVE_V1 && t.strategy !== SLEEVE_V2)) continue;
    if (t.ctrl || t.ctrlRand) continue;                                   // a control twin is not a trade
    const openedAt = t.openedAt || t.addedAt; if (!openedAt) continue;
    const id = t.id == null ? null : String(t.id); if (id == null) continue;
    if (seen.has(id)) continue; seen.add(id);
    const settled = t._state === "closed" && Number.isFinite(t.rMult) && Number.isFinite(t.pnl);
    out.push({
      id, sleeve: t.strategy, sym: t.sym || null, state: t._state,
      d: SL.etDate(+openedAt),                                            // the entry SESSION — the rule's `r.d`
      expiry: (t.obs && t.obs.optExpiry) || t.optExpiry || null,          // the rule's `r.expiry`
      settledOn: settled && t.closedAt ? SL.etDate(+t.closedAt) : null,
      R: settled ? +t.rMult : null,                                       // rMult = pnl / riskDollars = pnl / maxLoss
      pnl: settled ? +t.pnl : null,
    });
  }
  return out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.id < b.id ? -1 : 1));
}

const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

/**
 * THE SESSION ROWS AND THE V2 CELLS — pure. Everything the runner writes is decided here from
 * (the tickets, the event sets, the run's ET date, the record so far).
 *   tickets        from sleeveTickets()
 *   EV             from releaseSets()
 *   runDate        the run's ET date; only sessions strictly before it are recorded
 *   evidenceStart  the first session the forward record covers
 *   have           the (kind|key) pairs already in the record
 * -> { sessions: [row], cells: [row], held: [{ session, why }] }
 */
function plan({ tickets, EV, runDate, evidenceStart, have = new Set(), grace = SETTLE_GRACE_DAYS }) {
  const cover = calendarCover(EV);
  const inScope = (d) => d >= evidenceStart && d < runDate;
  const zero = tickets.filter((t) => t.sleeve === SLEEVE_V1), wings = tickets.filter((t) => t.sleeve === SLEEVE_V2);
  const days = [...new Set([...zero.map((t) => t.d), ...wings.map((t) => t.d), ...wings.map((t) => t.settledOn).filter(Boolean)])].filter(inScope).sort();

  const sessions = [], held = [];
  for (const d of days) {
    if (have.has(`session|${d}`)) continue;
    const z = zero.filter((t) => t.d === d);
    const unsettled = z.filter((t) => t.R == null);
    if (unsettled.length && dayDiff(d, runDate) < grace) { held.push({ session: d, why: `${unsettled.length} 0DTE ticket(s) not settled yet (grace ${grace}d)` }); continue; }
    if (!cover.from || d < cover.from || d > cover.to) {
      sessions.push({ kind: "session", key: d, gap: true, why: cover.events ? `data/macro-calendar.json covers ${cover.from}..${cover.to}, not ${d} — the release-day filter cannot classify this session` : "data/macro-calendar.json holds no CPI/NFP/FOMC dates — the release-day filter cannot classify any session" });
      continue;
    }
    const types = releaseTypesOn(EV, d), isRelease = anyRelease(EV, d);
    const done = z.filter((t) => t.R != null);
    const opened = wings.filter((t) => t.d === d).map((w) => { const ex = exposedTo(EV, w); return { id: w.id, sym: w.sym, expiry: w.expiry, exposed: ex, wouldDecline: ex, exposingReleases: ex ? exposingReleases(EV, w) : [] }; });
    const settledWings = wings.filter((t) => t.settledOn === d).map((w) => ({ id: w.id, entry: w.d, expiry: w.expiry, exposed: exposedTo(EV, w), R: w.R, pnl: w.pnl }));
    sessions.push({
      kind: "session", key: d, release: { isRelease, types },
      v1: { sleeve: SLEEVE_V1, tickets: z.length, settled: done.length, meanR: done.length ? mean(done.map((t) => t.R)) : null, pnl: done.length ? done.reduce((a, t) => a + t.pnl, 0) : null,
        wouldSkip: isRelease, ...(unsettled.length ? { unsettledIds: unsettled.map((t) => t.id), unsettledNote: `recorded after the ${grace}-day grace with these tickets still open; they are NOT in meanR` } : {}) },
      v2: { sleeve: SLEEVE_V2, opened, settled: settledWings },
    });
  }

  const cells = [];
  const entryDays = [...new Set(wings.map((t) => t.d))].filter(inScope).sort();
  for (const d of entryDays) {
    if (have.has(`wing-cell|${d}`)) continue;
    const g = wings.filter((t) => t.d === d);
    if (g.some((w) => w.R == null)) { held.push({ session: d, why: `${g.filter((w) => w.R == null).length} wing(s) entered ${d} have not settled` }); continue; }
    if (!cover.from || d < cover.from || d > cover.to) continue;                     // the session row already says it is a gap
    const e = g.filter((w) => exposedTo(EV, w)), u = g.filter((w) => !exposedTo(EV, w));
    cells.push({ kind: "wing-cell", key: d, exposed: e.length, unexposed: u.length,
      meanExposedR: e.length ? mean(e.map((w) => w.R)) : null, meanUnexposedR: u.length ? mean(u.map((w) => w.R)) : null,
      diff: e.length && u.length ? mean(e.map((w) => w.R)) - mean(u.map((w) => w.R)) : null,
      exposedPnl: e.reduce((a, w) => a + w.pnl, 0), unexposedPnl: u.reduce((a, w) => a + w.pnl, 0),
      ids: { exposed: e.map((w) => w.id), unexposed: u.map((w) => w.id) } });
  }
  return { sessions, cells, held };
}

/**
 * THE READ-OUT — the forward statistic, computed from the RECORD (the JSONL), not from the ledger: the record is
 * the evidence. V1 is the sealed read's Welch t over session means; V2 its one-sample t over per-entry-session
 * differences. Both are reported beside the sealed bar; neither is a read of R275, which is spent.
 */
function readout(rows) {
  const start = SL.startOf(rows);
  const S = rows.filter((r) => r.kind === "session" && !r.gap), gaps = rows.filter((r) => r.kind === "session" && r.gap);
  const withR = S.filter((r) => r.v1 && r.v1.meanR != null);
  const rel = withR.filter((r) => r.release.isRelease), oth = withR.filter((r) => !r.release.isRelease);
  const V1 = { sessions: withR.length, releaseSessions: rel.length, otherSessions: oth.length,
    releaseMeanR: rel.length ? f(mean(rel.map((r) => r.v1.meanR))) : null, otherMeanR: oth.length ? f(mean(oth.map((r) => r.v1.meanR))) : null,
    diff: rel.length && oth.length ? f(mean(rel.map((r) => r.v1.meanR)) - mean(oth.map((r) => r.v1.meanR))) : null,
    t: f(welch(rel.map((r) => r.v1.meanR), oth.map((r) => r.v1.meanR)), 3),
    releasePnl: f(rel.reduce((a, r) => a + (r.v1.pnl || 0), 0), 2), otherPnl: f(oth.reduce((a, r) => a + (r.v1.pnl || 0), 0), 2),
    sleeveMeanR_all: withR.length ? f(mean(withR.map((r) => r.v1.meanR))) : null, sleeveMeanR_skippingRelease: oth.length ? f(mean(oth.map((r) => r.v1.meanR))) : null };
  const C = rows.filter((r) => r.kind === "wing-cell"), both = C.filter((r) => r.diff != null);
  const V2 = { cells: C.length, sessionsWithBoth: both.length,
    exposedWings: C.reduce((a, r) => a + r.exposed, 0), unexposedWings: C.reduce((a, r) => a + r.unexposed, 0),
    meanDiff: both.length ? f(mean(both.map((r) => r.diff))) : null, t: f(tOne(both.map((r) => r.diff)), 3),
    exposedPnl: f(C.reduce((a, r) => a + (r.exposedPnl || 0), 0), 2), unexposedPnl: f(C.reduce((a, r) => a + (r.unexposedPnl || 0), 0), 2) };
  const declined = S.reduce((a, r) => a + ((r.v2 && r.v2.opened) || []).filter((w) => w.wouldDecline).length, 0);
  const openedAll = S.reduce((a, r) => a + ((r.v2 && r.v2.opened) || []).length, 0);
  return { spec: SPEC, test: "R275", kind: "FORWARD SHADOW — no orders, no position, not a read of R275 (it is sealed)",
    evidenceStart: start ? start.evidenceStart : null, ruleSource: start ? start.ruleSource : null, ruleSha: start ? start.ruleSha : null,
    sessionsRecorded: S.length, gapSessions: gaps.length, runs: rows.filter((r) => r.kind === "run").length,
    wouldHaveSkipped: { releaseSessions: S.filter((r) => r.v1.wouldSkip).length, wingsDeclined: declined, wingsSeen: openedAll },
    V1, V2, bar: { oneSided: -BAR, note: `R275's sealed bar was t <= -${BAR}. It is printed here for comparison only: the registered read is spent and this record clears no bar and seals nothing.` } };
}

// ── the runner ────────────────────────────────────────────────────────────────────────────────────────────────
const rdJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

/** one run. deps are injected by the selftest; the defaults are the live files and the real clock. */
function run({ dir = D(""), jsonl = JSONL, out = OUT, now = Date.now(), ruleSource = RULE_SOURCE, log = (s) => console.log(s), write = true, grace = SETTLE_GRACE_DAYS } = {}) {
  const P = (f) => path.join(dir, f);
  const rows = SL.readRows(jsonl);
  const runDate = SL.etDate(now);
  const start = SL.startOf(rows);
  const opening = start ? null : SL.startRow({ test: "R275", spec: SPEC, evidenceStart: runDate, ruleSource: path.basename(ruleSource), ruleSha: SL.shaOf(ruleSource),
    note: "forward record of what R275's release-day filter would have done. No orders. R275's registry entry is redacted in the clean copy; the rule text comes from the sealed read named above." });
  const evidenceStart = start ? start.evidenceStart : runDate;

  const cal = rdJson(P("macro-calendar.json"));
  const EV = releaseSets(cal);
  const tickets = sleeveTickets({ tradeLog: rdJson(P("trade_log.json")), board: rdJson(P("board_positions.json")) });
  const have = SL.keysOf(rows);
  if (opening) have.add(`start|R275`);
  const { sessions, cells, held } = plan({ tickets, EV, runDate, evidenceStart, have, grace });
  const runRow = { kind: "run", key: runDate, sessionsWritten: sessions.map((r) => r.key), cellsWritten: cells.map((r) => r.key), held,
    tickets: { [SLEEVE_V1]: tickets.filter((t) => t.sleeve === SLEEVE_V1).length, [SLEEVE_V2]: tickets.filter((t) => t.sleeve === SLEEVE_V2).length },
    calendar: calendarCover(EV), orders: "none — this runner places no order of any kind" };

  const batch = [...(opening ? [opening] : []), ...sessions, ...cells, runRow];
  const res = write ? SL.appendRows(jsonl, batch, { now }) : { appended: [], skipped: batch };
  const all = write ? SL.readRows(jsonl) : [...rows, ...batch];
  const report = readout(all);
  if (write) writeJsonAtomic(out, { ...report, asOf: new Date(now).toISOString() });

  log(`R275 forward shadow — run ${runDate} · wrote ${sessions.length} session row(s), ${cells.length} wing cell(s)${held.length ? `, held ${held.length}` : ""} · record: ${report.sessionsRecorded} sessions since ${report.evidenceStart || runDate}`);
  log(`  V1 0DTE   release ${report.V1.releaseSessions} vs other ${report.V1.otherSessions} sessions · diff ${report.V1.diff ?? "—"}R · t ${report.V1.t ?? "—"} (bar ${-BAR}, comparison only)`);
  log(`  V2 wings  ${report.V2.sessionsWithBoth} session(s) with both · meanDiff ${report.V2.meanDiff ?? "—"}R · t ${report.V2.t ?? "—"} · the filter would have declined ${report.wouldHaveSkipped.wingsDeclined}/${report.wouldHaveSkipped.wingsSeen} wings`);
  for (const h of held) log(`  held ${h.session}: ${h.why}`);
  return { runDate, appended: res.appended, report, rows: all };
}

module.exports = { SPEC, TYPES, BAR, SLEEVE_V1, SLEEVE_V2, SETTLE_GRACE_DAYS, mean, vr, tOne, welch, releaseSets, anyRelease, releaseTypesOn, exposedTo, exposingReleases, calendarCover, sleeveTickets, plan, readout, run, JSONL, OUT, RULE_SOURCE };

if (require.main === module) {
  const status = process.argv.includes("--status");
  try {
    if (status) {
      const rows = SL.readRows(JSONL), r = readout(rows);
      console.log(JSON.stringify(r, null, 1));
    } else run({});
  } catch (e) { console.error("R275 forward shadow FAILED (nothing recorded):", e.message); process.exit(1); }
}
