#!/usr/bin/env node
/**
 * R39 — the read's numbers, reproduced from the registered reader's own sealed sessions. READ-ONLY on backend/data.
 * Writes r39-diagnostics.json beside this file.
 *   node docs/reads/2026-10-11/R39/r39-diagnostics.cjs [repo root]
 *
 * 1. THE STATISTIC, the reader's formula line for line (backend/intraday-family.js): per variant, the session's average R is the
 *    mean of that session's trade R; the statistic is the mean of the per-session averages and its t (mean / (sd / sqrt(k)), sd with
 *    k-1) over the evidence sessions (>= 2026-08-24). Computed at the registered interim look (first 16 sessions), at the registered
 *    read (first 30) and on everything graded so far, and compared with the reader's own stored stats.
 * 2. THE BAR: lib/null-bar.js best-of-2, as the reader calls it (variants 2, n = sessions, 2000 trials, unseeded) — the spread of
 *    that draw over repeated calls, and a 200,000-trial value, at n = 30 and at today's n.
 * 3. THE READER'S INPUTS: the cost per side each session was graded at (inferred from the reader's own rows:
 *    cost = ((exit - entry) x dir - pts) / (2 x entry)), and every evidence session re-graded from the persisted bars
 *    (backend/data/intraday/<day>.json) with the registered rule code (backend/lib/intraday-rules.js) at that cost: signals, win
 *    rate and average R must come back as sealed.
 * 4. DOLLARS from the reader's own rows. R39 registered NO dollar sizing (it grades in R; sizing was to be registered only for a
 *    cleared variant). Two plain views: one share per signal (the row's own `pts`, net of cost), and $100 risked per signal
 *    (row R x $100). Worst drawdown = largest peak-to-trough fall of the cumulative session totals, sessions in order, peak from $0.
 * 5. WEIGHTLESS, not in the registration: the same sessions graded at zero cost (how much of the loss is the cost).
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "..", ".."));
const BK = path.join(ROOT, "backend"), D = (f) => path.join(BK, "data", f);
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js"));
const NB = require(path.join(BK, "lib", "null-bar.js"));
const { makeRules } = require(path.join(BK, "lib", "intraday-rules.js"));
const VARS = ["orb30", "vwapr"], BAR = { minSessions: 30, minSignals: 200, interimSessions: 16, interimKillT: -2.0, familySize: 2 };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const tOf = (a) => { const k = a.length; if (k < 2) return null; const g = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1)); return sd > 0 ? +(g / (sd / Math.sqrt(k))).toFixed(3) : null; };   // the reader's tOf
const r2 = (x) => (x == null ? null : +x.toFixed(2)), r4 = (x) => (x == null ? null : +x.toFixed(4));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

const M = JSON.parse(fs.readFileSync(D("intraday-family.json"), "utf8"));
const evDays = Object.keys(M.days).filter((d) => d >= M.evidenceStart).sort();
if (evDays.some((d) => !M.days[d].trades)) throw new Error("a session's trade rows are trimmed — the dollar table cannot be built from the reader's rows");

// ---- 1. the statistic ---------------------------------------------------------------------------------------------------
function statAt(k) {
  const days = evDays.slice(0, k), out = { sessions: days.length, from: days[0], to: days[days.length - 1] };
  for (const v of VARS) {
    const daily = days.map((d) => M.days[d][v].avgR).filter((x) => x != null), n = days.reduce((s, d) => s + M.days[d][v].n, 0);
    out[v] = { sessions: daily.length, n, meanDailyR: r4(mean(daily)), t: tOf(daily), win: n ? +(days.reduce((s, d) => s + (M.days[d][v].win || 0) * M.days[d][v].n, 0) / n).toFixed(1) : null,
      sessionsPositive: daily.filter((x) => x > 0).length, bestSessionR: Math.max(...daily), worstSessionR: Math.min(...daily) };
  }
  return out;
}
const atInterim = statAt(BAR.interimSessions), atRead = statAt(BAR.minSessions), atAll = statAt(evDays.length);
const storedAgrees = VARS.every((v) => ["sessions", "n", "meanDailyR", "t", "win"].every((k) => M.stats[v][k] === atAll[v][k])) && M.evidenceSessions === evDays.length;

// ---- 2. the bar ---------------------------------------------------------------------------------------------------------
function barAt(n) {
  const draws = []; for (let i = 0; i < 200; i++) draws.push(NB.nullBar({ variants: BAR.familySize, n, trials: 2000 }).p95);
  const big = NB.nullBar({ variants: BAR.familySize, n, trials: 200000 });
  const shareAbove24 = big._sorted.filter((x) => x >= 2.4).length / big._sorted.length;
  return { n, asTheReaderDrawsIt: { calls: 200, trials: 2000, p95Min: +Math.min(...draws).toFixed(3), p95Median: +median(draws).toFixed(3), p95Max: +Math.max(...draws).toFixed(3) },
    at200000Trials: { p95: +big.p95.toFixed(3), p99: +big.p99.toFixed(3) }, chanceOfBestOf2AtOrAbove2_4Pct: +(100 * shareAbove24).toFixed(2) };
}
const bar30 = barAt(BAR.minSessions), barAll = barAt(evDays.length);

// ---- 3. cost per session, and the re-grade from the persisted bars -------------------------------------------------------
const perSession = [];
let regradeOk = true;
const gross = { orb30: [], vwapr: [] };
for (const d of evDays) {
  const x = M.days[d], rows = [...x.trades.orb30, ...x.trades.vwapr].filter((t) => t.entry >= 20);
  const c = median(rows.map((t) => ((t.exit - t.entry) * t.dir - t.pts) / (2 * t.entry)));
  const cost = +c.toFixed(6);                                           // the cost model's spreadPctSide carries 4 decimals in percent
  const J = JSON.parse(fs.readFileSync(D(path.join("intraday", d + ".json")), "utf8"));
  const G = makeRules(cost).gradeSession(J.symbols), G0 = makeRules(0).gradeSession(J.symbols);
  const row = { day: d, sealedAt: x.sealedAt, covered: x.covered, costSidePct: +(100 * cost).toFixed(4) };
  for (const v of VARS) {
    const rs = G[v], re = { n: rs.length, win: rs.length ? +(100 * rs.filter((t) => t.win).length / rs.length).toFixed(1) : null, avgR: rs.length ? +mean(rs.map((t) => t.r)).toFixed(4) : null };
    const same = re.n === x[v].n && re.win === x[v].win && re.avgR === x[v].avgR;
    if (!same) regradeOk = false;
    const g0 = G0[v].length ? mean(G0[v].map((t) => t.r)) : null; gross[v].push(g0);
    row[v] = { sealed: { n: x[v].n, win: x[v].win, avgR: x[v].avgR }, regraded: re, same, grossAvgR: r4(g0), how: x[v].how };
  }
  perSession.push(row);
}
const costs = perSession.map((s) => s.costSidePct);

// ---- 4. dollars from the reader's own rows --------------------------------------------------------------------------------
function dollars(days, v, usdOf) {
  let net = 0, gains = 0, losses = 0, wins = 0, losers = 0, flat = 0, cum = 0, peak = 0, dd = 0, ddDay = null; const sess = [];
  for (const d of days) {
    let s = 0;
    for (const t of M.days[d].trades[v]) { const u = usdOf(t); s += u; if (u > 0) { gains += u; wins++; } else if (u < 0) { losses += u; losers++; } else flat++; }
    net += s; cum += s; if (cum > peak) peak = cum; if (peak - cum > dd) { dd = peak - cum; ddDay = d; } sess.push(s);
  }
  const n = wins + losers + flat;
  return { trades: n, net: r2(net), gains: r2(gains), losses: r2(losses), wins, losers, flat, winRatePct: n ? +(100 * wins / n).toFixed(1) : null, avgWin: wins ? r2(gains / wins) : null, avgLoss: losers ? r2(losses / losers) : null,
    perSessionAvg: r2(net / days.length), sessionsUp: sess.filter((s) => s > 0).length, sessionsDown: sess.filter((s) => s < 0).length, bestSession: r2(Math.max(...sess)), worstSession: r2(Math.min(...sess)), worstDrawdown: r2(-dd), worstDrawdownTroughDay: ddDay };
}
const views = { oneSharePerSignal: (t) => t.pts, hundredDollarsRiskedPerSignal: (t) => 100 * t.r, inR: (t) => t.r };
const table = (days) => Object.fromEntries(VARS.map((v) => [v, Object.fromEntries(Object.entries(views).map(([k, f]) => [k, dollars(days, v, f)]))]));
const dollarsRead = table(evDays.slice(0, BAR.minSessions)), dollarsAll = table(evDays);

// ---- 5. weightless: zero cost ----------------------------------------------------------------------------------------------
const grossAt = (k) => Object.fromEntries(VARS.map((v) => { const a = gross[v].slice(0, k).filter((x) => x != null); return [v, { sessions: a.length, meanDailyR: r4(mean(a)), t: tOf(a), sessionsPositive: a.filter((x) => x > 0).length }]; }));

const out = {
  generatedAt: new Date().toISOString(), by: "docs/reads/2026-10-11/R39/r39-diagnostics.cjs", state: "backend/data/intraday-family.json", stateAsOf: M.asOf,
  evidence: { start: M.evidenceStart, sessions: evDays.length, first: evDays[0], last: evDays[evDays.length - 1], previewSessionsExcluded: Object.keys(M.days).filter((d) => d < M.evidenceStart) },
  statistic: { atInterimLook: atInterim, atRegisteredRead: atRead, everythingGraded: atAll, readerStoredStats: M.stats, storedStatsReproduced: storedAgrees,
    interimKilled: VARS.filter((v) => atInterim[v].t != null && atInterim[v].t <= BAR.interimKillT),
    signalsFloorMetAtRead: VARS.every((v) => atRead[v].n >= BAR.minSignals) },
  bar: { registryText: "best-of-2 null bar from lib/null-bar.js (~2.4 at 30 sessions)", atRead: bar30, today: barAll },
  readerInputs: { everySessionReproducedFromThePersistedBars: regradeOk, costSidePct: { min: Math.min(...costs), median: median(costs), max: Math.max(...costs), distinct: [...new Set(costs)].length },
    coveredNames: { min: Math.min(...perSession.map((s) => s.covered)), max: Math.max(...perSession.map((s) => s.covered)) }, perSession },
  dollars: { sizingNote: "R39 registered no dollar sizing. oneSharePerSignal = the reader's own pts (net of cost) on one share; hundredDollarsRiskedPerSignal = row R x $100; inR = the rows' R.", readSessions: dollarsRead, everythingGraded: dollarsAll },
  weightless: { note: "not in the registration: the same sessions and rules graded at ZERO cost", atRegisteredRead: grossAt(BAR.minSessions), everythingGraded: grossAt(evDays.length) },
};
writeJsonAtomic(path.join(__dirname, "r39-diagnostics.json"), out);
const show = (s) => VARS.map((v) => `${v}: ${s[v].sessions} sessions, ${s[v].n} signals, mean daily R ${s[v].meanDailyR}, t ${s[v].t}, win ${s[v].win}%, sessions positive ${s[v].sessionsPositive}`).join("\n    ");
console.log(`R39 — evidence ${evDays[0]} .. ${evDays[evDays.length - 1]}, ${evDays.length} sessions; reader's stored stats reproduced: ${storedAgrees}`);
console.log(`  interim look (first 16, to ${atInterim.to}):\n    ${show(atInterim)}\n    killed at t <= -2: ${out.statistic.interimKilled.join(", ") || "none"}`);
console.log(`  registered read (first 30, to ${atRead.to}):\n    ${show(atRead)}`);
console.log(`  everything graded (${evDays.length}, to ${atAll.to}):\n    ${show(atAll)}`);
console.log(`  bar at 30: reader's draw ${JSON.stringify(bar30.asTheReaderDrawsIt)}; 200k trials ${JSON.stringify(bar30.at200000Trials)}; chance best-of-2 >= 2.4: ${bar30.chanceOfBestOf2AtOrAbove2_4Pct}%`);
console.log(`  bar at ${evDays.length}: reader's draw ${JSON.stringify(barAll.asTheReaderDrawsIt)}; 200k trials ${JSON.stringify(barAll.at200000Trials)}`);
console.log(`  cost per side by session: ${JSON.stringify(out.readerInputs.costSidePct)}; covered names ${JSON.stringify(out.readerInputs.coveredNames)}`);
console.log(`  every session reproduced from the persisted bars at its own cost: ${regradeOk}`);
for (const s of perSession) if (!s.orb30.same || !s.vwapr.same) console.log("   MISMATCH", s.day, JSON.stringify({ orb30: s.orb30, vwapr: s.vwapr }).slice(0, 400));
for (const [lab, T] of [["read sessions (30)", dollarsRead], ["everything graded", dollarsAll]]) for (const v of VARS) for (const k of Object.keys(views)) console.log(`  ${lab} · ${v} · ${k}: ${JSON.stringify(T[v][k])}`);
console.log(`  weightless, zero cost — at 30: ${JSON.stringify(out.weightless.atRegisteredRead)}; all: ${JSON.stringify(out.weightless.everythingGraded)}`);
