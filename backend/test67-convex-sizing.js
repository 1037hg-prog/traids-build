#!/usr/bin/env node
/**
 * #67 — CONVEX SIZING. The writer this test never had. (2026-09-09)
 *
 * Registered 2026-08-28, evidence from 2026-08-29, and nothing has ever written a row for it. This
 * is that writer. It implements the registered rule verbatim and changes NOTHING about live sizing —
 * it is a shadow that recomputes what the same tickets would have returned under correlation-weighted
 * stakes, and reports the per-session dollar difference.
 *
 * THE RULE, quoted from the registry and implemented literally:
 *   Per session, order tickets by openedAt. For each, nPriorCorrelated = tickets ALREADY OPEN that
 *   share a factor-group token (lib/enforcement-gates.js groupTokens) AND point the same direction;
 *   an opposing ticket is a hedge and never counts. Weight w = 1/sqrt(1 + nPriorCorrelated), floored
 *   at 0.25, capped at 1.0. Weights are RENORMALISED per session so TOTAL PLANNED RISK EQUALS the
 *   flat book's — this is a reallocation, not a de-risking, and the runner EXITS NON-ZERO if that
 *   identity ever breaks. The conviction multiplier is wired in and PINNED AT 1.0, because sizing up
 *   requires a score with measured forward skill and the daily board has none.
 *
 * STATISTIC: per-session dollar difference (convex minus flat), day-clustered t.
 * BAR: 30 forward sessions, day-clustered t >= 2.0. One pre-specified form — exponent 0.5 from the
 * independent-bets argument, floor 0.25, nothing tuned on the ledger. A grid search over exponents
 * or floors would owe a best-of-N bar and the registry field would have to be updated BEFORE the read.
 *
 * WHY THE IDENTITY CHECK IS A HARD EXIT AND NOT A WARNING. If total planned risk drifts below the
 * flat book's, the "improvement" is just a smaller book in a losing period, and it would read as
 * sizing skill. The renormalisation is the whole design; a version of this that quietly de-risks
 * measures something else entirely. So it refuses to write rather than write a flattering number.
 *
 * COVERAGE IS PARTIAL AND DISCLOSED. groupTokens returns nothing for Options (no factor model for a
 * spread) and for futures outside the known complexes. Those tickets get w = 1.0 and are reported as
 * ungrouped — they are in the book but cannot be correlation-weighted, so the test is really asking
 * about the 44% of tickets that carry a group.
 *
 * Usage: node backend/test67-convex-sizing.js
 */
const fs = require("fs"), path = require("path");
const R = require("./lib/reconcile.js");
const { groupTokens } = require("./lib/enforcement-gates.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const D = (f) => path.join(__dirname, "data", f);
const EXPONENT = 0.5, FLOOR = 0.25, CAP = 1.0, CONVICTION = 1.0;   // frozen; nothing here is searched

const REG = (() => { const r = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
  for (const v of Object.values(r)) if (Array.isArray(v)) { const t = v.find((x) => x && String(x.id) === "67"); if (t) return t; } })();
if (!REG || !REG.bar) { console.error("#67 not registered with a bar — refusing"); process.exit(1); }
const EV = REG.evidenceStart, B = REG.bar;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : null; };
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const L = R.cleanEraLedger();
const rows = (L.signals || []).filter((t) =>
  Number.isFinite(t.rMult) && t.rMult !== 0 && Number.isFinite(t.pnl) && Number.isFinite(t.openedAt) && etDay(t.openedAt) >= EV);

const byDay = {};
for (const t of rows) (byDay[etDay(t.openedAt)] ||= []).push(t);
const days = Object.keys(byDay).sort();

const sessions = [];
for (const d of days) {
  const g = [...byDay[d]].sort((a, b) => a.openedAt - b.openedAt);
  let ungrouped = 0;
  const rec = g.map((t) => {
    const toks = groupTokens(t);
    if (!toks.length) ungrouped++;
    // "already open" is literal: opened earlier AND not yet closed when this one opened
    const nPrior = toks.length ? g.filter((o) =>
      o !== t && o.openedAt < t.openedAt && (!Number.isFinite(o.closedAt) || o.closedAt > t.openedAt) &&
      (o.dir >= 0 ? 1 : -1) === (t.dir >= 0 ? 1 : -1) &&
      groupTokens(o).some((x) => toks.includes(x))).length : 0;
    const wRaw = Math.min(CAP, Math.max(FLOOR, CONVICTION / Math.pow(1 + nPrior, EXPONENT)));
    return { t, risk: Math.abs(t.pnl / t.rMult), wRaw, nPrior };
  });

  const flatRisk = rec.reduce((s, x) => s + x.risk, 0);
  const wRisk = rec.reduce((s, x) => s + x.risk * x.wRaw, 0);
  if (!(flatRisk > 0) || !(wRisk > 0)) continue;
  const k = flatRisk / wRisk;                                   // renormalise: reallocation, never de-risking
  const convexRisk = rec.reduce((s, x) => s + x.risk * x.wRaw * k, 0);
  if (Math.abs(convexRisk - flatRisk) > 1e-6 * Math.max(1, flatRisk)) {
    console.error(`#67 REFUSING TO WRITE — the planned-risk identity broke on ${d}: convex $${convexRisk.toFixed(2)} vs flat $${flatRisk.toFixed(2)}.`);
    console.error("  The renormalisation IS the rule; a version that de-risks measures a smaller book, not better sizing.");
    process.exit(1);
  }
  const flatPnl = rec.reduce((s, x) => s + x.t.rMult * x.risk, 0);
  const convexPnl = rec.reduce((s, x) => s + x.t.rMult * x.risk * x.wRaw * k, 0);
  sessions.push({ session: d, tickets: g.length, ungrouped, plannedRiskUsd: Math.round(flatRisk),
    maxPriorCorrelated: Math.max(0, ...rec.map((x) => x.nPrior)),
    flatUsd: Math.round(flatPnl), convexUsd: Math.round(convexPnl), diffUsd: +(convexPnl - flatPnl).toFixed(2) });
}

const diffs = sessions.map((s) => s.diffUsd);
const t = diffs.length >= 2 ? tOf(diffs) : null;
const need = B.minSessions ?? 30, tReq = 2.0;

let verdict;
if (sessions.length >= need && t != null)
  verdict = t >= tReq && mean(diffs) > 0
    ? `CONFIRMED — convex sizing beats flat by $${mean(diffs).toFixed(0)} per session, day-clustered t ${r4(t)} on ${sessions.length} sessions (bar ${tReq}). Routes to the operator as a proposed risk-policy change, never an automatic adoption.`
    : `NOT CONFIRMED — $${mean(diffs).toFixed(0)} per session, t ${r4(t)} on ${sessions.length} sessions (bar ${tReq}). Flat sizing stands and the rule is retired.`;
else verdict = `ACCRUING — ${sessions.length}/${need} sessions${t == null ? "" : ` (mean $${mean(diffs).toFixed(0)}/session, t ${r4(t)})`}`;

const totalUngrouped = sessions.reduce((s, x) => s + x.ungrouped, 0), totalTix = sessions.reduce((s, x) => s + x.tickets, 0);
const out = { spec: "test67-convex-sizing-v1", test: "67", asOf: new Date().toISOString(), evidenceStart: EV, bar: B,
  form: { exponent: EXPONENT, floor: FLOOR, cap: CAP, conviction: CONVICTION, note: "frozen at registration; nothing tuned on the ledger" },
  plannedRiskIdentity: "enforced per session — the runner exits non-zero rather than writing a de-risked book",
  coverage: { tickets: totalTix, ungrouped: totalUngrouped, groupedPct: totalTix ? +(100 * (1 - totalUngrouped / totalTix)).toFixed(1) : null,
    note: "groupTokens returns nothing for Options and for futures outside the known complexes; those carry w=1.0 and cannot be correlation-weighted" },
  sessions: sessions.length, meanDiffUsd: diffs.length ? +mean(diffs).toFixed(2) : null, t: r4(t),
  positiveSessions: diffs.filter((x) => x > 0).length, rows: sessions, verdict,
  dailyClock: { sessions: sessions.length, estimate: diffs.length ? +mean(diffs).toFixed(2) : null, unit: "dollars per session, convex minus flat, at identical planned risk" } };
writeJsonAtomic(D("test67-convex-sizing.json"), out);

console.log(`#67 convex sizing — ${verdict}`);
console.log(`   ${totalTix} tickets over ${sessions.length} sessions · ${out.coverage.groupedPct}% carry a factor group · planned risk identical by construction`);
for (const s of sessions.slice(-6)) console.log(`   ${s.session}  ${String(s.tickets).padStart(3)} tix  maxPrior ${s.maxPriorCorrelated}  flat $${String(s.flatUsd).padStart(6)}  convex $${String(s.convexUsd).padStart(6)}  diff ${s.diffUsd >= 0 ? "+" : ""}$${s.diffUsd}`);
