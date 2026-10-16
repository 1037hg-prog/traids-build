#!/usr/bin/env node
/**
 * PM1 GRADER — writer built 2026-09-11 (11 NO-WRITER triage pass, PM1 had no writer at all).
 *
 * RULE (test-registry.json preregistered id PM1, verbatim, summarized). TWO LIMBS.
 *
 * LIMB A (descriptive, NO BAR): unit = ONE PLAN-DAY, a session for which a sealed allocation plan
 * exists in portfolio-manager-plans.jsonl before that session's regular-hours open. Statistic =
 * |actual gross1RPct - planned target gross1RPct| (an allocation-DISTANCE, never a return claim).
 * Reported at every read with n stated; never a pass/fail. minPlanDays: 20 (reporting threshold
 * only, not a clear/fail gate).
 *
 * LIMB B (the ONE bar-bearing claim): unit = ONE SESSION with >=1 settled agent-book ticket opened
 * by portfolio-manager AND >=5 settled main-book signal rows (min-day-size guard). B_d = mean rMult
 * of ALL settled main-book signal rows that day (cleanEraLedger()). A_d = mean rMult of
 * portfolio-manager's settled agent-book tickets that day. D_d = A_d - B_d, paired within the day.
 * Bar: t >= 1.724 (nullBar, variants=1, n=20) over >= 20 qualifying sessions.
 *
 * WHAT WAS MISSING. backend/pm-factor-hedge.js opens MECHANICAL-arm tickets on the agent book —
 * that is intake, not grading. Nothing ever joined the seat's settled agent-book tickets against
 * the main-book benchmark on the same day, computed D_d, or reported a plan-day/session count in
 * the dailyClock shape test-triage.js reads. This file is that grader. It changes no directive and
 * holds no authority (PM1's own text: a cleared read is evidence the operator may weigh, never an
 * automatic unlock).
 *
 * MECHANICAL VS DISCRETIONARY, ENFORCED. Rows in agent-book-ledger.jsonl stamped meta.arm ===
 * "mechanical-factor-cap" measure the RULE (short the sector ETF of the largest R53 breach), not
 * the seat's judgment (close-chain.cjs's own wiring comment says these "MUST be read separately").
 * Limb B's primary D_d therefore uses DISCRETIONARY portfolio-manager tickets only (meta.arm not
 * "mechanical-factor-cap"). The mechanical arm's own D_d is computed and reported alongside as a
 * labelled diagnostic, never pooled into the primary and never graded against PM1's bar.
 *
 * LIMB A, SCHEMA HONESTLY BOUNDED. portfolio-manager-plans.jsonl's section1_targetGrossPlannedRisk
 * schema drifted across the 17 sealed rows: early plans (08-28, 08-31, 09-03) carry a numeric
 * target.gross1RPct; later plans (09-04 on) replaced it with a PROSE ceiling field
 * (gross1RPct_ceiling, e.g. "Do NOT authorize growth above today's actual") carrying no single
 * number. Inventing a number by parsing that prose would be guessing, not measuring, so divergence
 * is computed ONLY for plan-days whose target is a finite number; every other plan-day is counted
 * in plansArchived and reported as "descriptive-only, ceiling stated in prose, no numeric target
 * this format" rather than silently dropped or force-fit. The "actual" half of the pairing is read
 * from the NEXT full plan sealed on the targeted session itself (planDay_{i+1} === targetSession_i),
 * i.e. that plan's own currentActual snapshot, taken at its own seal time (after that session's
 * close) — the only actual-gross1RPct-after-the-target-session figure this file has on disk.
 *
 * NO LOOK-AHEAD. Limb B only counts a session once its tickets have SETTLED in cleanEraLedger() /
 * agent-book-ledger.jsonl. Limb A only pairs a plan's target against a LATER plan's actual snapshot,
 * never the same plan's own currentActual (which predates the target it is being checked against).
 *
 * Usage: node backend/pm1-grade.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const RC = require("./lib/reconcile.js");
const { tOf } = require("./lib/null-bar.js");

const REG = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const T = (REG.preregistered || []).find((t) => String(t.id) === "PM1");
const T_REQUIRED = (T && T.bar && T.bar.tRequired) || 1.724;
const MIN_PLAN_DAYS = (T && T.bar && T.bar.minPlanDays_limbA) || 20;
const MIN_SESSIONS = (T && T.bar && T.bar.minQualifyingSessions_limbB) || 20;
const MIN_ROWS_PER_DAY = (T && T.bar && T.bar.minSettledRowsPerDay_mainBook) || 5;
const EVIDENCE_START_B = "2026-08-31"; // registered date; first settled PM agent-book ticket strictly after

const rdl = (f) => { try { return fs.readFileSync(D(f), "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// ───────────────────────── LIMB A — plan vs actual, descriptive, no bar ─────────────────────────
const plans = rdl("portfolio-manager-plans.jsonl").filter((p) => p.section1_targetGrossPlannedRisk);
plans.sort((a, b) => String(a.planDay).localeCompare(String(b.planDay)));
const byPlanDay = new Map(plans.map((p) => [p.planDay, p]));

const limbARows = plans.map((p) => {
  const s1 = p.section1_targetGrossPlannedRisk;
  const targetPct = s1.target && Number.isFinite(s1.target.gross1RPct) ? s1.target.gross1RPct : null;
  if (targetPct == null) {
    return { planDay: p.planDay, targetSession: p.targetSession, status: "DESCRIPTIVE-ONLY — ceiling stated in prose, no single numeric target in this plan's schema", divergence: null };
  }
  const next = byPlanDay.get(p.targetSession);
  if (!next || !next.section1_targetGrossPlannedRisk || !Number.isFinite(next.section1_targetGrossPlannedRisk.currentActual?.gross1RPct)) {
    return { planDay: p.planDay, targetSession: p.targetSession, status: "PENDING — no sealed plan yet carries a currentActual snapshot for the targeted session", divergence: null };
  }
  const actualPct = next.section1_targetGrossPlannedRisk.currentActual.gross1RPct;
  const divergence = +Math.abs(actualPct - targetPct).toFixed(3);
  return { planDay: p.planDay, targetSession: p.targetSession, status: "MEASURED", targetPct, actualPct, divergence };
});
const limbAMeasured = limbARows.filter((r) => r.status === "MEASURED");

// ───────────────────── LIMB B — PM agent-book tickets vs main book, bar-bearing ─────────────────────
const L = RC.cleanEraLedger();
const dayOf = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const isMainPop = (t) => !t.ctrlRand && !t.vetoShadow && !t.sleeve;
const mainByDay = new Map();
for (const t of L.signals.filter(isMainPop)) {
  const d = dayOf(t.closedAt);
  if (!mainByDay.has(d)) mainByDay.set(d, []);
  mainByDay.get(d).push(t);
}

const agentRows = rdl("agent-book-ledger.jsonl").filter((t) => t.agent === "portfolio-manager" && Number.isFinite(t.closedAt) && Number.isFinite(t.rMult));
const agentDiscretionary = agentRows.filter((t) => !(t.meta && t.meta.arm === "mechanical-factor-cap"));
const agentMechanical = agentRows.filter((t) => t.meta && t.meta.arm === "mechanical-factor-cap");

function gradeArm(rows, label) {
  const byDay = new Map();
  for (const t of rows) {
    if (t.closedAt < Date.parse(EVIDENCE_START_B + "T00:00:00-04:00")) continue;
    const d = dayOf(t.closedAt);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  const out = [];
  for (const [d, pmTickets] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const mainRows = mainByDay.get(d) || [];
    if (mainRows.length < MIN_ROWS_PER_DAY) { out.push({ day: d, status: `NOT GRADED — ${mainRows.length} settled main-book signal row(s), need ${MIN_ROWS_PER_DAY}`, nPm: pmTickets.length }); continue; }
    const A_d = mean(pmTickets.map((t) => t.rMult));
    const B_d = mean(mainRows.map((t) => t.rMult));
    out.push({ day: d, status: "GRADED", nPm: pmTickets.length, nMain: mainRows.length, A_d: +A_d.toFixed(4), B_d: +B_d.toFixed(4), D_d: +(A_d - B_d).toFixed(4) });
  }
  const graded = out.filter((r) => r.status === "GRADED");
  const Ds = graded.map((r) => r.D_d);
  const t = Ds.length >= 2 ? tOf(Ds) : null;
  const meanD = Ds.length ? +mean(Ds).toFixed(4) : null;
  return { label, rows: out, graded: graded.length, meanD, t: t == null ? null : +t.toFixed(3) };
}

const limbBDiscretionary = gradeArm(agentDiscretionary, "discretionary (PRIMARY)");
const limbBMechanical = gradeArm(agentMechanical, "mechanical-factor-cap (diagnostic only, not graded)");

let verdictB;
if (agentDiscretionary.length === 0) verdictB = `NOT STARTED — 0 settled discretionary portfolio-manager agent-book tickets since ${EVIDENCE_START_B} (${agentMechanical.length} mechanical-arm settle(s) exist separately, not graded here).`;
else if (limbBDiscretionary.graded === 0) verdictB = `ACCRUING — 0 of ${MIN_SESSIONS} graded sessions (${agentDiscretionary.length} discretionary ticket(s) settled, none on a day with >=${MIN_ROWS_PER_DAY} settled main-book rows).`;
else verdictB = `ACCRUING — ${limbBDiscretionary.graded} of ${MIN_SESSIONS} graded sessions, mean D ${limbBDiscretionary.meanD}, t ${limbBDiscretionary.t == null ? "n/a" : limbBDiscretionary.t} vs bar ${T_REQUIRED}.`;

const verdictA = limbAMeasured.length === 0
  ? `DESCRIPTIVE — 0 of ${limbARows.length} sealed plan-day(s) yield a numeric divergence (schema carries a prose ceiling instead of a number on the rest).`
  : `DESCRIPTIVE — ${limbAMeasured.length} of ${limbARows.length} sealed plan-day(s) yield a numeric divergence, mean ${(+mean(limbAMeasured.map((r) => r.divergence))).toFixed(2)} pts (n stated; no pass/fail — limb A carries no bar).`;

const out = {
  spec: "PM1 grader v1",
  registered: "2026-08-31",
  asOf: new Date().toISOString(),
  bar: { tRequired: T_REQUIRED, minPlanDays_limbA: MIN_PLAN_DAYS, minQualifyingSessions_limbB: MIN_SESSIONS, minSettledRowsPerDay_mainBook: MIN_ROWS_PER_DAY },
  limbA: { evidenceStart: "2026-08-28 (descriptive history)", plansArchived: limbARows.length, measured: limbAMeasured.length, rows: limbARows, verdict: verdictA },
  limbB: { evidenceStart: EVIDENCE_START_B, primary: limbBDiscretionary, mechanicalDiagnostic: limbBMechanical, verdict: verdictB },
  bySession: limbBDiscretionary.rows.filter((r) => r.status === "GRADED").map((r) => ({ session: r.day, mean: r.D_d })),
  dailyClock: { sessions: limbBDiscretionary.graded, estimate: limbBDiscretionary.t, unit: "sessions" },
  verdict: `LIMB A: ${verdictA} | LIMB B (bar-bearing): ${verdictB}`,
};

writeJsonAtomic(D("pm1-grade.json"), out);
console.log(`PM1 GRADER — ${out.verdict}`);
