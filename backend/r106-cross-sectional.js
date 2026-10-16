#!/usr/bin/env node
/**
 * R106 — CROSS-SECTIONAL SELECTION. Registered 2026-09-08, evidence from 2026-09-09.
 *
 * Can the scanner's score RANK, with market direction removed?
 *
 * Every directional result on this board confounds selection with direction. In the crypto book our longs made +0.197R and our
 * shorts -0.175R, while the COIN FLIPS made +0.176R long and -0.154R short: nearly identical. What looked like an edge was net
 * exposure times tape. A long-short book built from one score cancels market direction by construction, so what is left is
 * ranking skill or nothing.
 *
 * THE RULE, frozen before evidence and not searched here:
 *   each session, rank the scanner's fixed 100-name universe by its stamped vote (stamped BEFORE the outcome, in
 *   data/r7-scanner-shadow.json), LONG the top 10 and SHORT the bottom 10, equal count and equal dollar risk, hold 3 trading
 *   days, exit at the close. Session result = mean(long returns) - mean(short returns) - one equity round trip on each leg.
 *   K = 10 is the conventional decile; +3d is the horizon R7's own primary cleared on 2026-09-03, taken verbatim.
 *
 * BAR: 30 evidence sessions, one-sample t on session spreads >= 1.717 (single-variant p95 from lib/null-bar.js).
 * Interim kill-only at 15 sessions if t <= -2.
 *
 * The retrospective preview across K = 5/10/20 is recorded in the registry entry, is weightless, and is NOT re-read here:
 * only sessions from the evidence start count. Nothing is booked; this reads a collector that already runs.
 *
 * 2026-09-10 test-triage STALLED diagnosis (no code change to the rule): sessions/skipped both read
 * empty because the +3d ("h3") horizon has not matured for ANY day on or after evidenceStart yet — the
 * shadow settles h3 three trading sessions after the signal day, and EV (2026-09-09) is itself only a
 * few sessions old. This is the horizon's own lag, not a plumbing defect; horizonLagNote below states
 * it plainly so a STALLED read is not mistaken for a bug.
 *
 * Usage: node backend/r106-cross-sectional.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return d; } };

const REG = (() => { const r = rd("test-registry.json", {}); for (const k of Object.keys(r)) if (Array.isArray(r[k])) { const t = r[k].find((x) => x.id === "R106"); if (t) return t; } })();
if (!REG || !REG.bar) { console.error("R106 not registered with a bar — refusing to compute"); process.exit(1); }
const K = 10, HORIZON = "h3", EV = REG.evidenceStart, B = REG.bar;
const COST_LEG = ((rd("cost-model.json", {}).perClass || {}).Equity || {}).roundTripPct ?? 0.2242;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : null; };
const r3 = (x) => (x == null ? null : +x.toFixed(3));

const shadow = rd("r7-scanner-shadow.json", null);
if (!shadow || !shadow.settled) { console.error("no scanner shadow to read"); process.exit(1); }

const sessions = [], skipped = [];
// diagnostic only, never a filter: every settled day >= EV and whether it has an h3 cell yet
const evDaysStatus = Object.keys(shadow.settled).filter((d) => d >= EV).sort().map((d) => ({
  day: d, hasH3: !!(shadow.settled[d] && shadow.settled[d][HORIZON] && Array.isArray(shadow.settled[d][HORIZON].rows)) }));

for (const day of Object.keys(shadow.settled).sort()) {
  if (day < EV) continue;                                   // forward evidence only; the preview is weightless and stays in the registry
  const cell = shadow.settled[day][HORIZON];
  if (!cell || !Array.isArray(cell.rows)) continue;         // horizon not reachable yet
  const rows = cell.rows.filter((x) => Number.isFinite(x.ret) && Number.isFinite(x.vote)).sort((a, b) => b.vote - a.vote);
  if (rows.length < 2 * K) { skipped.push({ day, why: `only ${rows.length} usable names, need ${2 * K}` }); continue; }
  const longs = rows.slice(0, K), shorts = rows.slice(-K);
  const spread = mean(longs.map((x) => x.ret)) - mean(shorts.map((x) => x.ret)) - 2 * COST_LEG;
  sessions.push({ day, exitDate: cell.exitDate, n: rows.length, spreadPct: r3(spread),
    longMean: r3(mean(longs.map((x) => x.ret))), shortMean: r3(mean(shorts.map((x) => x.ret))),
    topVote: r3(longs[0].vote), bottomVote: r3(shorts[shorts.length - 1].vote) });
}

const spreads = sessions.map((s) => s.spreadPct);
const t = spreads.length >= 2 ? tOf(spreads) : null;
const n = sessions.length;
let verdict;
if (n >= B.minSessions && t != null) verdict = t >= B.tRequired && mean(spreads) > 0
  ? `PASS — mean ${r3(mean(spreads))}% per session, t ${r3(t)} on ${n} sessions (bar ${B.tRequired}). The score ranks with direction removed.`
  : `DID NOT PASS — mean ${r3(mean(spreads))}%, t ${r3(t)} on ${n} sessions (bar ${B.tRequired}). The score does not rank cross-sectionally.`;
else if (n >= B.interimSessions && t != null && t <= B.interimKillT) verdict = `KILLED at interim — t ${r3(t)} on ${n} sessions; the score ranks backwards.`;
else verdict = `ACCRUING — ${n}/${B.minSessions} sessions${t == null ? "" : ` (mean ${r3(mean(spreads))}%, t ${r3(t)})`}`;

const out = { spec: "r106-cross-sectional-v1", test: "R106", asOf: new Date().toISOString(), evidenceStart: EV,
  rule: `long top ${K} / short bottom ${K} by scanner vote, +3d hold, net of ${(2 * COST_LEG).toFixed(4)}% both legs`,
  bar: B, sessions, skipped, n,
  horizonLagNote: n === 0 && skipped.length === 0
    ? `no plumbing defect: ${evDaysStatus.length} day(s) settled on/after evidenceStart (${EV}), none has an h3 (+3 trading day) cell yet — ${evDaysStatus.map((x) => x.day).join(", ") || "none"}. h3 needs 3 trading sessions past the signal day to mature; the first R106 evidence session lands once EV's own h3 settles.`
    : null,
  meanSpreadPct: r3(mean(spreads)), t: r3(t), positiveSessions: spreads.filter((x) => x > 0).length,
  verdict,
  dailyClock: { sessions: n, estimate: r3(mean(spreads)), unit: "net long-short spread %, per session",
    detail: n ? `${spreads.filter((x) => x > 0).length}/${n} sessions positive` : "no evidence sessions yet" } };
writeJsonAtomic(D("r106-cross-sectional.json"), out);
console.log(`R106 cross-sectional — ${verdict}`);
if (out.horizonLagNote) console.log(`   ${out.horizonLagNote}`);
for (const s of sessions.slice(-5)) console.log(`   ${s.day} → ${s.exitDate}  long ${s.longMean}%  short ${s.shortMean}%  net spread ${s.spreadPct}%`);
if (skipped.length) console.log(`   ${skipped.length} session(s) skipped: ${skipped.slice(-2).map((s) => s.day + " " + s.why).join("; ")}`);
