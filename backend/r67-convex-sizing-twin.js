#!/usr/bin/env node
/**
 * R67 — CONVEX SIZING, measured against flat sizing on the same tickets. 2026-08-28.
 * Writes data/r67-convex-sizing.json.
 *
 * THE CLAIM UNDER TEST. Reallocating the SAME total planned risk away from correlated tickets and
 * toward independent ones raises dollar P&L. Not "trade less" — trade the same gross, weighted by
 * how much of each ticket is a genuinely separate bet.
 *
 * WHY THIS CAN BE MEASURED EXACTLY RATHER THAN SIMULATED. R-multiples are size-invariant:
 * rMult = pnl / riskDollars. So the P&L a ticket WOULD have produced at a different size is
 * rMult x riskConvex — arithmetic, not a fill assumption, not a backtest. Every registered test
 * on this board reads R, so a sizing change cannot move a single registered statistic; it moves
 * dollar P&L and nothing else. That is the whole reason this is a legitimate thing to ship.
 *
 * WHAT WOULD MAKE THIS DISHONEST, and is therefore not done:
 *   - Tuning the exponent or the floor on this ledger. The form is 1/sqrt(1+n) with a 0.25 floor,
 *     pre-specified from the independent-bets argument. ONE form is measured. A grid would owe a
 *     best-of-N bar and this file would have to say so.
 *   - Letting one arm win by trading smaller. Weights are renormalised per session so gross
 *     planned risk is identical; the assertion below fails the run if it is not.
 *   - Reading a retrospective as a forward result. This is the MOTIVATING sample, computed on
 *     sessions already seen. The forward twin below is the evidence, and it starts at the next
 *     session — never backfilled.
 *
 * POPULATION. Real exposure only: no controls (a paired null must keep its own sizing), no veto
 * shadows (refused, never risked), no sleeves (R21/R24/R25 carry their own registered sizing).
 *
 * Usage:  node backend/r67-convex-sizing-twin.js
 * Output: data/r67-convex-sizing.json
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const R = require("./lib/reconcile.js");
const RP = require("./lib/risk-policy.js");
const CS = require("./lib/convex-sizing.js");
const D = (f) => path.join(__dirname, "data", f);

const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tStat = (a) => (a.length > 1 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);

// ---- canonical ledger, or refuse to report ------------------------------------------------------
let led;
try { led = R.cleanEraLedger(); R.assertReconciled("clean-era pooled edge", R.recomputeEdge(led), led.pooledEdgeR); }
catch (e) { console.error("RECONCILE FAILED — reporting nothing: " + e.message); process.exit(1); }

/**
 * RECOVERING riskDollars. Settled ledger rows do not carry it — the working view keeps rMult and
 * pnl and drops the denominator. It is exactly recoverable: rMult = pnl / riskDollars, so
 * riskDollars = pnl / rMult. Rows with rMult at or near zero are DROPPED rather than divided
 * (the quotient is meaningless there and would manufacture an enormous fake stake), and the
 * number dropped is reported instead of absorbed.
 */
const EPS = 1e-6;
let droppedNearZeroR = 0;
const rows = led.signals
  .filter((t) => t && Number.isFinite(t.rMult) && Number.isFinite(t.pnl) && Number.isFinite(t.openedAt) &&
    !RP.isSleeve(t) && !t.vetoShadow && !t.ctrl)
  .map((t) => {
    if (Math.abs(t.rMult) < EPS) { droppedNearZeroR++; return null; }
    const riskDollars = Math.abs(t.pnl / t.rMult);
    if (!Number.isFinite(riskDollars) || riskDollars <= 0) { droppedNearZeroR++; return null; }
    return { ...t, riskDollars };
  })
  .filter(Boolean);

const bySession = new Map();
for (const t of rows) {
  const d = etDay(t.closedAt);
  if (!bySession.has(d)) bySession.set(d, []);
  bySession.get(d).push(t);
}

const sessions = [];
let mismatch = 0;
for (const [day, tickets] of [...bySession.entries()].sort()) {
  const sized = CS.sizeSession(tickets);
  const flatRisk = sized.reduce((s, r) => s + r.riskFlat, 0);
  const convexRisk = sized.reduce((s, r) => s + r.riskConvex, 0);
  if (Math.abs(flatRisk - convexRisk) > Math.max(1, flatRisk * 1e-6)) mismatch++;
  const flatPnl = sized.reduce((s, r) => s + (r.pnlFlat || 0), 0);
  const convexPnl = sized.reduce((s, r) => s + (r.pnlConvex || 0), 0);
  const downsized = sized.filter((r) => r.multiple < 0.999).length;
  sessions.push({
    day, n: sized.length,
    plannedRiskFlat: +flatRisk.toFixed(2), plannedRiskConvex: +convexRisk.toFixed(2),
    pnlFlat: +flatPnl.toFixed(2), pnlConvex: +convexPnl.toFixed(2),
    diff: +(convexPnl - flatPnl).toFixed(2),
    ticketsDownsized: downsized, ticketsUpsized: sized.length - downsized,
    maxCorrelatedPrior: Math.max(0, ...sized.map((r) => r.nPriorCorrelated)),
  });
}

// gross-risk identity is a CONTRACT, not a hope — say so loudly if it broke
if (mismatch) {
  console.error(`GROSS RISK IDENTITY BROKEN on ${mismatch} session(s) — the arms are not comparable. Refusing to report a verdict.`);
  process.exit(1);
}

const diffs = sessions.map((s) => s.diff);
const totFlat = sessions.reduce((s, x) => s + x.pnlFlat, 0);
const totConvex = sessions.reduce((s, x) => s + x.pnlConvex, 0);
const better = diffs.filter((d) => d > 0).length;

const out = {
  spec: "R67 — convex sizing vs flat, same gross planned risk", asOf: new Date().toISOString(),
  status: "RETROSPECTIVE / MOTIVATING — computed on sessions already seen. Not evidence.",
  rule: "w = 1/sqrt(1 + nPriorCorrelated), floored at " + CS.MIN_W + ", renormalised per session so gross planned risk is unchanged. Correlated = shares a factor-group token AND same direction. Conviction multiplier is wired but PINNED AT 1.0 until a score clears a registered bar.",
  exactness: "pnlConvex = rMult x riskConvex. R-multiples are size-invariant, so this is arithmetic, not a simulated backtest, and no registered statistic moves.",
  population: "signal arm, real exposure only — no controls, no veto shadows, no sleeves",
  sessions: sessions.length, tickets: rows.length, droppedNearZeroR,
  pnlFlat: +totFlat.toFixed(2), pnlConvex: +totConvex.toFixed(2),
  difference: +(totConvex - totFlat).toFixed(2),
  sessionsImproved: better, sessionsWorse: sessions.length - better,
  meanDiffPerSession: +mean(diffs).toFixed(2),
  dayClusteredT: +tStat(diffs).toFixed(3),
  forwardBar: {
    registerBefore: "must be registered before it enforces; this file grades the twin",
    minSessions: 30, statistic: "per-session dollar difference, day-clustered t", bar: "t >= 2.0",
    note: "The retrospective below is the motivating sample and may NEVER be quoted as the read. Forward evidence starts at the next session and is never backfilled.",
  },
  perSession: sessions,
};
writeJsonAtomic(D("r67-convex-sizing.json"), out);

const f = (x) => (x >= 0 ? "+" : "") + x.toFixed(0);
console.log("R67 — CONVEX SIZING vs FLAT (same gross planned risk, retrospective)");
console.log(`  ${rows.length} tickets over ${sessions.length} sessions · gross planned risk identical every session (asserted)`);
console.log("");
console.log("  day          n   downsized  maxCorr    flat $     convex $      diff");
for (const s of sessions) {
  console.log("  " + s.day + String(s.n).padStart(5) + String(s.ticketsDownsized).padStart(11) +
    String(s.maxCorrelatedPrior).padStart(9) + String(f(s.pnlFlat)).padStart(11) +
    String(f(s.pnlConvex)).padStart(13) + String(f(s.diff)).padStart(10));
}
console.log("");
console.log(`  TOTAL   flat ${f(totFlat)}   convex ${f(totConvex)}   difference ${f(totConvex - totFlat)}`);
console.log(`  sessions improved ${better}/${sessions.length} · mean per session ${f(mean(diffs))} · day-clustered t ${tStat(diffs).toFixed(2)}`);
console.log("");
console.log("  THIS IS THE MOTIVATING SAMPLE, NOT A READ. Forward evidence starts at the next session.");
console.log("written: data/r67-convex-sizing.json");
