#!/usr/bin/env node
/**
 * R36 — reproduce the registered reader's row from the ledger, on the read night and tonight, and build the dollar table
 * from the reader's own rows. Read-only; writes only r36-diagnostics.json beside itself.
 *
 * The functions below are the registered reader's own (backend/filter-shadow-read.js: et, mean, sessionT, stat and its
 * row filter), copied line for line so that nothing new is computed. The reader itself is NOT run here because it rewrites
 * data/filter-shadows.json, which seven sibling tests share.
 *
 *   1. tonight, reader as written, on data/trade_log.json                      -> must equal filter-shadows.json filters.R36 (the adjudicator's number)
 *   2. tonight, the same rows through lib/reconcile.js cleanEraLedger()        -> is the reader's population the canonical one?
 *   3. the READ NIGHT (2026-10-07, git a732d72c8): the reader as written on that night's committed ledger
 *                                                                              -> must equal that night's committed filters.R36
 *   4. the read-night rows as they stand in tonight's ledger                   -> did any graded row change after the read night?
 *   5. dollars from the rows' own pnl (the tickets' own sizing), read night and tonight
 *
 *   node docs/reads/2026-10-11/R36/r36-diagnostics.cjs
 */
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const D = (f) => path.join(ROOT, "backend", "data", f);
const { cleanEraLedger } = require(path.join(ROOT, "backend", "lib", "reconcile.js"));
const READ_COMMIT = "a732d72c8", PREV_COMMIT = "09bf056e0";
const RE = /R36/, FROM = "2026-08-24";
const BAR = { minSessions: 30, minShadows: 60, tRequired: -2.0, interimSessions: 16, interimKillT: 2.0 };

// ---- the registered reader's own code (backend/filter-shadow-read.js) ----
const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sessionT = (rows) => {
  const by = {};
  for (const r of rows) (by[et(r.openedAt)] ||= []).push(r.rMult);
  const days = Object.keys(by).sort();
  const m = days.map((d) => mean(by[d])), k = m.length;
  const bySession = days.map((d, i) => ({ session: d, mean: +m[i].toFixed(4), n: by[d].length }));
  if (k < 2) return { t: null, sessions: k, bySession };
  const g = mean(m), sd = Math.sqrt(m.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1));
  return { t: sd > 0 ? +(g / (sd / Math.sqrt(k))).toFixed(3) : null, sessions: k, bySession, meanOfSessionMeans: +g.toFixed(4), sdOfSessionMeans: +sd.toFixed(4) };
};
const stat = (rows) => ({ n: rows.length, win: rows.length ? +(100 * rows.filter((r) => r.rMult > 0).length / rows.length).toFixed(1) : null, avgR: rows.length ? +mean(rows.map((r) => r.rMult)).toFixed(4) : null, pnl: +rows.reduce((s, r) => s + (r.pnl || 0), 0).toFixed(0), ...sessionT(rows) });
const readerRows = (log) => log.filter((r) => Number.isFinite(r.rMult) && Number.isFinite(r.pnl) && r.closedAt && r.vetoShadow).filter((r) => RE.test(r.veto || "") && et(r.openedAt) >= FROM);
const readerVerdict = (s) => { const S = s.sessions; return S < BAR.interimSessions ? `ACCRUING — ${S}/${BAR.minSessions} sessions, ${s.n}/${BAR.minShadows} shadows` : S < BAR.minSessions ? (s.t != null && s.t >= BAR.interimKillT ? `KILLED AT INTERIM — refused trades are winning (t ${s.t})` : `ACCRUING — interim at ${S}: not dead (t ${s.t})`) : (s.avgR < 0 && s.t <= BAR.tRequired && s.n >= BAR.minShadows) ? `CONFIRMED — refused trades lost (avgR ${s.avgR}, t ${s.t})` : s.t > 0 ? `DID NOT PASS — refused trades would have paid (t ${s.t}); retire` : `INCONCLUSIVE at ${S} sessions (t ${s.t}, n ${s.n})`; };
// ---------------------------------------------------------------------------

const git = (args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 29 }).toString();
const core = (s) => ({ n: s.n, win: s.win, avgR: s.avgR, pnl: s.pnl, t: s.t, sessions: s.sessions });
const same = (a, b) => ["n", "win", "avgR", "pnl", "t", "sessions"].every((k) => a[k] === b[k]);

// the dollar table: the rows' own pnl, in the order the money would have arrived (closedAt). For a refusal filter the
// tickets were NOT taken: a negative net is money the refusals kept out of the book, a positive net is money they gave up.
const dollars = (rows) => {
  const o = [...rows].sort((a, b) => a.closedAt - b.closedAt), sum = (a) => a.reduce((s, r) => s + r.pnl, 0);
  const w = o.filter((r) => r.pnl > 0), l = o.filter((r) => r.pnl < 0);
  let cum = 0, peak = 0, dd = 0, peakAt = "start", from = null, to = null, trough = 0, high = 0;
  for (const r of o) { cum += r.pnl; if (cum > peak) { peak = cum; peakAt = et(r.closedAt); } if (peak - cum > dd) { dd = peak - cum; from = peakAt; to = et(r.closedAt); } trough = Math.min(trough, cum); high = Math.max(high, cum); }
  const risk = o.map((r) => (Number.isFinite(r.rMult) && r.rMult !== 0 ? Math.abs(r.pnl / r.rMult) : null)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  return {
    tickets: o.length, net: +sum(o).toFixed(2), gains: +sum(w).toFixed(2), losses: +sum(l).toFixed(2), winners: w.length, losers: l.length, flat: o.length - w.length - l.length,
    winRatePct: o.length ? +(100 * w.length / o.length).toFixed(1) : null, avgWin: w.length ? +(sum(w) / w.length).toFixed(2) : null, avgLoss: l.length ? +(sum(l) / l.length).toFixed(2) : null,
    largestWin: w.length ? +Math.max(...w.map((r) => r.pnl)).toFixed(2) : null, largestLoss: l.length ? +Math.min(...l.map((r) => r.pnl)).toFixed(2) : null,
    worstDrawdown: +(-dd).toFixed(2), drawdownFrom: from, drawdownTo: to, lowestCumulative: +trough.toFixed(2), highestCumulative: +high.toFixed(2),
    medianDollarRiskPerTicket: risk.length ? +risk[Math.floor(risk.length / 2)].toFixed(2) : null,
    firstClose: o.length ? et(o[0].closedAt) : null, lastClose: o.length ? et(o[o.length - 1].closedAt) : null,
  };
};
const split = (rows, key) => { const g = {}; for (const r of rows) (g[key(r)] ||= []).push(r); return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, { ...core(stat(v)), dollars: (({ net, winners, losers, avgWin, avgLoss }) => ({ net, winners, losers, avgWin, avgLoss }))(dollars(v)) }])); };

// 1. tonight, reader as written
const logNow = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
const nowRows = readerRows(logNow), nowStat = stat(nowRows);
const fsNow = JSON.parse(fs.readFileSync(D("filter-shadows.json"), "utf8"));
const adj = (() => { try { return (JSON.parse(fs.readFileSync(D("adjudicator.json"), "utf8")).rows || []).find((r) => r.id === "R36") || null; } catch { return null; } })();

// 2. the same question through the canonical read
const L = cleanEraLedger();
const canonRows = [...L.signals, ...L.controls].filter((r) => r.vetoShadow && RE.test(r.veto || "") && et(r.openedAt) >= FROM);
const canonIds = new Set(canonRows.map((r) => r.id)), nowIds = new Set(nowRows.map((r) => r.id));
const dropped = nowRows.filter((r) => !canonIds.has(r.id)), added = canonRows.filter((r) => !nowIds.has(r.id));

// 3. the read night, from that night's committed ledger
const logRead = JSON.parse(git(["show", `${READ_COMMIT}:backend/data/trade_log.json`]));
const readRows = readerRows(logRead), readStat = stat(readRows);
const fsRead = JSON.parse(git(["show", `${READ_COMMIT}:backend/data/filter-shadows.json`]));
const logPrev = JSON.parse(git(["show", `${PREV_COMMIT}:backend/data/trade_log.json`]));
const prevRows = readerRows(logPrev), prevStat = stat(prevRows);
const prevSessions = new Set(prevRows.map((r) => et(r.openedAt)));
const newSessionsOnReadNight = [...new Set(readRows.map((r) => et(r.openedAt)))].filter((d) => !prevSessions.has(d)).sort();

// 4. the read-night rows as they stand tonight
const nowById = new Map(logNow.map((r) => [r.id, r]));
const changed = [], missing = [];
for (const r of readRows) { const n = nowById.get(r.id); if (!n) { missing.push(r.id); continue; } if (n.rMult !== r.rMult || n.pnl !== r.pnl || n.openedAt !== r.openedAt || n.closedAt !== r.closedAt || (n.veto || "") !== (r.veto || "") || !!n.vetoShadow !== !!r.vetoShadow) changed.push({ id: r.id, then: { rMult: r.rMult, pnl: r.pnl }, now: { rMult: n.rMult, pnl: n.pnl } }); }
const readIds = new Set(readRows.map((r) => r.id));
const postSealRows = nowRows.filter((r) => !readIds.has(r.id));
const idsUnique = (rows) => new Set(rows.map((r) => r.id)).size === rows.length && rows.every((r) => r.id != null);

const bs = readStat.bySession;
const out = {
  spec: "r36-diagnostics", madeAt: new Date().toISOString(),
  reader: "backend/filter-shadow-read.js (functions copied line for line; the reader itself not run — it rewrites the shared data/filter-shadows.json)",
  bar: { ...BAR, confirm: "avgR < 0 AND t <= -2.0 -> filter stays", retire: "t > 0 at >= 30 sessions -> ENFORCE off by hand", unit: "sessions (New York day of the ticket's open)" },
  tonight: {
    ledgerFile: "backend/data/trade_log.json", ledgerMtime: fs.statSync(D("trade_log.json")).mtime.toISOString(),
    readerAsWritten: core(nowStat), readerLine: readerVerdict(nowStat),
    filterShadowsJson: { asOf: fsNow.asOf, ...core(fsNow.filters.R36), verdict: fsNow.filters.R36.verdict },
    reproducesFilterShadowsJson: same(nowStat, fsNow.filters.R36),
    adjudicatorRow: adj && { verdict: adj.verdict, detail: adj.detail },
    meanOfSessionMeans: nowStat.meanOfSessionMeans, sdOfSessionMeans: nowStat.sdOfSessionMeans,
    sessionsWithPositiveMean: nowStat.bySession.filter((s) => s.mean > 0).length,
  },
  canonicalLedger: {
    source: L.source, epoch: L.epoch, settled: L.settled, retiredExcluded: L.retiredExcluded, retireTagsHonoured: L.retireTagsHonoured, retireTagsIgnored: L.retireTagsIGNORED,
    r36: core(stat(canonRows)), inControls: canonRows.filter((r) => r.ctrl).length, inSignals: canonRows.filter((r) => !r.ctrl).length,
    rowsTheReaderCountsThatTheCanonicalReadDrops: dropped.length, rowsOnlyInTheCanonicalRead: added.length,
    readerPopulationIsTheCanonicalPopulation: dropped.length === 0 && added.length === 0 && same(stat(canonRows), nowStat),
    r36RowsCarryingARetireTag: nowRows.filter((r) => r.retired).length,
  },
  readNight: {
    day: "2026-10-07", commit: READ_COMMIT, ledger: `git show ${READ_COMMIT}:backend/data/trade_log.json`,
    readerAsWritten: core(readStat), readerLine: readerVerdict(readStat),
    committedFilterShadows: { asOf: fsRead.asOf, ...core(fsRead.filters.R36), verdict: fsRead.filters.R36.verdict },
    reproducesCommittedRow: same(readStat, fsRead.filters.R36) && readerVerdict(readStat) === fsRead.filters.R36.verdict,
    meanOfSessionMeans: readStat.meanOfSessionMeans, sdOfSessionMeans: readStat.sdOfSessionMeans,
    sessionsWithPositiveMean: bs.filter((s) => s.mean > 0).length, sessionsWithNegativeMean: bs.filter((s) => s.mean < 0).length, sessionsFlat: bs.filter((s) => s.mean === 0).length,
    firstSession: bs[0].session, lastSession: bs[bs.length - 1].session,
    whyThePooledMeanAndTheTDiffer: "the pooled mean R weights every refused ticket equally; the registered t is on the mean of the per-session means, which weights every session equally. A few sessions with many losing refusals pull the pooled mean under zero while the average session is above it.",
    heaviestSessions: [...bs].sort((a, b) => b.n - a.n).slice(0, 5),
    sampleCondition: { sessions: { have: readStat.sessions, need: BAR.minSessions, met: readStat.sessions >= BAR.minSessions }, shadows: { have: readStat.n, need: BAR.minShadows, met: readStat.n >= BAR.minShadows } },
    nightBefore: { day: "2026-10-06", commit: PREV_COMMIT, readerAsWritten: core(prevStat), readerLine: readerVerdict(prevStat), conditionMet: prevStat.sessions >= BAR.minSessions && prevStat.n >= BAR.minShadows },
    sessionsNewOnTheReadNight: newSessionsOnReadNight,
    idsUnique: idsUnique(readRows),
    rowsChangedSince: changed.length, rowsMissingTonight: missing.length, changed: changed.slice(0, 20),
    bySession: bs,
  },
  branches: {
    confirm: { rule: "avgR < 0 AND t <= -2.0", avgRNegative: readStat.avgR < 0, tAtOrBelowMinus2: readStat.t <= BAR.tRequired, met: readStat.avgR < 0 && readStat.t <= BAR.tRequired && readStat.n >= BAR.minShadows },
    retire: { rule: "t > 0 at >= 30 sessions", tPositive: readStat.t > 0, sessionsAtLeast30: readStat.sessions >= BAR.minSessions, met: readStat.t > 0 && readStat.sessions >= BAR.minSessions },
  },
  dollars: {
    sizing: "each refused ticket at the size the board gave it (the row's own pnl and stop) — the test registered no other sizing; these tickets were REFUSED, so nothing here was earned or lost on the paper book",
    howToReadTheSign: "negative net = money the refusals kept out of the book; positive net = money they gave up",
    readNight: dollars(readRows),
    tonightPostSeal: dollars(nowRows),
    postSealRowsOnly: { tickets: postSealRows.length, ...core(stat(postSealRows)), dollars: dollars(postSealRows) },
  },
  weightlessSplitsOfTheReadNight: {
    note: "not in the registration: previews, no weight",
    byClass: split(readRows, (r) => r.cls || "?"),
    byDirection: split(readRows, (r) => (r.dir > 0 ? "long" : r.dir < 0 ? "short" : String(r.dir))),
  },
};
fs.writeFileSync(path.join(__dirname, "r36-diagnostics.json"), JSON.stringify(out, null, 1));
const { readNight: rn, ...rest } = out; const { bySession, ...rnShort } = rn;
console.log(JSON.stringify({ ...rest, readNight: rnShort }, null, 1));
console.log("per-session means on the read night:", bySession.map((s) => `${s.session.slice(5)}:${s.mean}(${s.n})`).join(" "));
console.log("written: docs/reads/2026-10-11/R36/r36-diagnostics.json");
