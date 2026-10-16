#!/usr/bin/env node
/**
 * R85 — THE NEWS-CONDITIONED REFUSAL GATE. Registered 2026-08-31, evidence from 2026-09-01.
 * Writes data/news-gate.json. The news-trader seat's first gradeable rule.
 *
 * RULE, frozen: REFUSE (shadow only, never block) any new ticket whose obs.newsScore <= 0.
 * The threshold is an absolute constant — the measured p20 over the 507 clean-era rows carrying
 * the field — and is NEVER a rolling quantile. A threshold recomputed each session drifts with its
 * own population and cannot be falsified.
 *
 * STATISTIC: paired within-session gap on realised net rMult, (mean ALLOWED) - (mean REFUSED),
 * computed inside each session, t across SESSIONS. A working gate makes this POSITIVE. Sessions are
 * the unit; ticket counts are never sample sizes here, and on this rule in particular the session
 * count is what disqualified four rival fields during the scan.
 *
 * BAR: paired t >= 2.859 at >= 30 sessions — best-of-12, because TWELVE news fields were examined
 * in backend/news-gate-scan.js before one was chosen. The family is the scan, not this file.
 * Interim at 16 sessions is KILL-ONLY at t <= -2.0.
 *
 * EXCLUSIONS, stated because they shape the population: a ticket with no finite newsScore is
 * EXCLUDED and counted — never imputed, never assigned zero. Coverage measured at 24.1%, so this
 * gate is silent on roughly three of four tickets and the paired statistic runs on a minority of
 * each session. That is a limitation of the rule, not a defect of the runner.
 *
 * READ IT BESIDE R13 AND R20. R20 found scheduled macro overnights indistinguishable from ordinary
 * ones (t 0.08). R13 found buying pre-market-news gappers loses at t -5.86 net, but its whole
 * margin sits inside an unmeasured cost assumption. This is the third and last news attempt on this
 * board; a third negative is a real answer, not a failure.
 *
 * Nightly in the close chain. Trades nothing, blocks nothing, proposes nothing on its own.
 */
const fs = require("fs"), path = require("path");
const R = require("./lib/reconcile.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);

const EVIDENCE_START = "2026-09-01";
const THRESHOLD = 0;                                   // fixed in advance: measured p20 of newsScore
const BAR = { pairedT: 2.859, minSessions: 30, interimT: -2.0, interimSessions: 16 };

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

const led = R.cleanEraLedger();
const all = [...(led.signals || []), ...(led.controls || [])];

let noScore = 0;
const rows = [];
for (const t of all) {
  const day = t.openedDay || (t.openedAt ? new Date(t.openedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : null);
  if (!day || day < EVIDENCE_START) continue;
  if (!Number.isFinite(t.rMult)) continue;
  const s = t.obs && t.obs.newsScore;
  if (!Number.isFinite(s)) { noScore++; continue; }      // excluded and COUNTED, never imputed
  rows.push({ day, r: t.rMult, refused: s <= THRESHOLD });
}

// ── paired within-session gap ──
const by = {};
for (const r of rows) (by[r.day] ||= { allowed: [], refused: [] })[r.refused ? "refused" : "allowed"].push(r.r);
const gaps = [], per = [];
for (const d of Object.keys(by).sort()) {
  const { allowed, refused } = by[d];
  if (!allowed.length || !refused.length) continue;      // a session needs BOTH arms to pair
  const g = mean(allowed) - mean(refused);
  gaps.push(g);
  per.push({ date: d, nAllowed: allowed.length, nRefused: refused.length, gap: +g.toFixed(4) });
}

let gap = null, t = null;
if (gaps.length >= 2) {
  const mu = mean(gaps);
  const sd = Math.sqrt(gaps.reduce((s, x) => s + (x - mu) ** 2, 0) / (gaps.length - 1));
  gap = +mu.toFixed(4);
  t = sd > 0 ? +(mu / (sd / Math.sqrt(gaps.length))).toFixed(3) : null;
}

const sessions = gaps.length;
const verdict = (() => {
  if (sessions >= BAR.minSessions)
    return t != null && t >= BAR.pairedT
      ? `CLEARS — paired t ${t} >= ${BAR.pairedT} at ${sessions} sessions; PROPOSED to the operator as a live refusal, never auto-applied`
      : `DID NOT PASS — paired t ${t} at ${sessions} sessions against a bar of ${BAR.pairedT}. Read beside R13 and R20: a third independent negative says news carries nothing tradeable on this board.`;
  if (sessions >= BAR.interimSessions && t != null && t <= BAR.interimT)
    return `KILLED at interim — t ${t} <= ${BAR.interimT}`;
  return `ACCRUING — ${sessions}/${BAR.minSessions} paired sessions (interim kill-only at ${BAR.interimSessions})`;
})();

const out = {
  spec: "news-gate-v1", testId: "R85", asOf: new Date().toISOString(),
  registered: "2026-08-31", evidenceStart: EVIDENCE_START, bar: BAR,
  rule: `REFUSE (shadow only) any new ticket whose obs.newsScore <= ${THRESHOLD}.`,
  threshold: { value: THRESHOLD, fixedInAdvance: true, source: "measured p20 of newsScore over 507 clean-era rows, backend/data/news-gate-scan.json", neverRolling: true },
  seat: "news-trader",
  enforcement: "SHADOW ONLY — blocks nothing, changes no live entry.",
  coverage: { rowsInWindow: rows.length + noScore, scored: rows.length, excludedNoScore: noScore,
    note: "excluded and counted, never imputed. Scan measured 24.1% coverage; this gate is silent on the rest." },
  sessions, pairedGapR: gap, t, perSession: per,
  allowedN: rows.filter((r) => !r.refused).length, refusedN: rows.filter((r) => r.refused).length,
  family: "one field registered of TWELVE examined (backend/news-gate-scan.js) — the bar is best-of-12 for that reason",
  readBeside: ["R13 — dead on cost, not on statistics", "R20 — scheduled macro overnights, t 0.08"],
  verdict,
  status: "REGISTERED FORWARD TEST — paper, shadow only, nothing proposed until the bar is cleared.",
};
writeJsonAtomic(D("news-gate.json"), out);

console.log(`\nR85 NEWS GATE — refuse newsScore <= ${THRESHOLD} · evidence from ${EVIDENCE_START} · bar paired t >= ${BAR.pairedT} at ${BAR.minSessions} sessions`);
console.log(`  scored ${rows.length} ticket(s) · excluded (no newsScore) ${noScore} · allowed ${out.allowedN} / refused ${out.refusedN}`);
console.log(`  ${sessions} paired session(s) · gap ${gap == null ? "n/a" : (gap >= 0 ? "+" : "") + gap + "R"} · t ${t ?? "n/a"}`);
console.log(`  ${verdict}`);
console.log("  SHADOW ONLY — blocks nothing.\nwritten: data/news-gate.json\n");
