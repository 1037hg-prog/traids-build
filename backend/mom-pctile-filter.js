#!/usr/bin/env node
/**
 * R87 — momPctile ENTRY FILTER. Registered 2026-09-01, evidence from 2026-09-02.
 * Writes data/mom-pctile-filter.json. Shadow only — blocks nothing.
 *
 * RULE, frozen: SKIP any new ticket whose obs.momPctile <= 0.223 (the measured p20 over the 905
 * clean-era rows carrying the field). An absolute constant, never a rolling quantile — a threshold
 * recomputed each session drifts with its own population and cannot be falsified.
 *
 * STATISTIC: paired within-session gap on realised net rMult, (mean TAKE) - (mean SKIP) inside each
 * session, t across SESSIONS. A working filter makes this POSITIVE.
 *
 * BAR: paired t >= 3.216 at >= 30 sessions — best-of-26, because 26 observer fields were scanned
 * before this one was chosen. The family is the scan, not the survivor. Interim at 16 sessions is
 * KILL-ONLY at t <= -2.0.
 *
 * THE PRIOR IS AGAINST IT, AND THAT IS RECORDED RATHER THAN SOFTENED. The motivating paired gap is
 * +0.0616R at t 0.502 over 20 paired sessions, positive on 10 of 20 — a coin flip needing roughly
 * six times its motivating t to clear. It also lost the corroboration it was proposed with: the
 * movement separation seen in the equity/crypto scan does NOT reproduce on the canonical ledger,
 * where the two quintiles move almost identically (+0.547 vs +0.567 mean max-excursion) and win at
 * 45.6% vs 44.6%. One weak signal, not two.
 *
 * WHY REGISTER IT ANYWAY: it grades an existing collection stream at zero marginal cost, and a
 * third independent negative after R85 (news) and R86 (exit noise) would itself be a finding — that
 * the board's problem is neither its exits nor its observable entry features.
 *
 * EXCLUSIONS: a ticket with no finite momPctile is EXCLUDED and counted, never imputed.
 *
 * Nightly in the close chain. Trades nothing, blocks nothing, proposes nothing on its own.
 */
const fs = require("fs"), path = require("path");
const R = require("./lib/reconcile.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);

const EVIDENCE_START = "2026-09-02";
const THRESHOLD = 0.223;
const BAR = { pairedT: 3.216, minSessions: 30, interimT: -2.0, interimSessions: 16 };

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const etDay = (v) => { const ms = typeof v === "number" ? v : Date.parse(v); return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); };

const s = R.cleanEraLedger();
const all = [...(s.signals || []), ...(s.controls || [])];

let noField = 0;
const rows = [];
for (const t of all) {
  const day = t.openedDay || (t.openedAt ? etDay(t.openedAt) : null);
  if (!day || day < EVIDENCE_START || !Number.isFinite(t.rMult)) continue;
  const m = t.obs && t.obs.momPctile;
  if (!Number.isFinite(m)) { noField++; continue; }
  rows.push({ day, r: t.rMult, skip: m <= THRESHOLD });
}

const by = {};
for (const r of rows) (by[r.day] ||= { take: [], skip: [] })[r.skip ? "skip" : "take"].push(r.r);
const gaps = [], per = [];
for (const d of Object.keys(by).sort()) {
  const { take, skip } = by[d];
  if (!take.length || !skip.length) continue;          // a session needs BOTH arms to pair
  const g = mean(take) - mean(skip);
  gaps.push(g);
  per.push({ date: d, nTake: take.length, nSkip: skip.length, gap: +g.toFixed(4) });
}

let gap = null, t = null;
if (gaps.length >= 2) {
  const mu = mean(gaps);
  const sd = Math.sqrt(gaps.reduce((x, y) => x + (y - mu) ** 2, 0) / (gaps.length - 1));
  gap = +mu.toFixed(4);
  t = sd > 0 ? +(mu / (sd / Math.sqrt(gaps.length))).toFixed(3) : null;
}

const sessions = gaps.length;
const verdict = (() => {
  if (sessions >= BAR.minSessions)
    return t != null && t >= BAR.pairedT
      ? `CLEARS — paired t ${t} >= ${BAR.pairedT} at ${sessions} sessions; PROPOSED to the operator, never auto-applied`
      : `DID NOT PASS — paired t ${t} at ${sessions} sessions against ${BAR.pairedT}. Read beside R85 and R86 as the third of three registered attempts at a tradeable conditioning variable.`;
  if (sessions >= BAR.interimSessions && t != null && t <= BAR.interimT) return `KILLED at interim — t ${t}`;
  return `ACCRUING — ${sessions}/${BAR.minSessions} paired sessions (interim kill-only at ${BAR.interimSessions})`;
})();

writeJsonAtomic(D("mom-pctile-filter.json"), {
  spec: "mom-pctile-filter-v1", testId: "R87", asOf: new Date().toISOString(),
  registered: "2026-09-01", evidenceStart: EVIDENCE_START, threshold: THRESHOLD, bar: BAR,
  rule: `SKIP any ticket whose obs.momPctile <= ${THRESHOLD}.`,
  enforcement: "SHADOW ONLY — blocks nothing.",
  coverage: { scored: rows.length, excludedNoField: noField, note: "excluded and counted, never imputed" },
  sessions, pairedGapR: gap, t, perSession: per,
  takeN: rows.filter((r) => !r.skip).length, skipN: rows.filter((r) => r.skip).length,
  family: "one field registered of TWENTY-SIX scanned — the bar is best-of-26 for that reason",
  motivatingSample: "paired gap +0.0616R at t 0.502 over 20 sessions, positive on 10/20. WEIGHTLESS. The honest prior is failure.",
  readBeside: ["R85 — news-conditioned refusal", "R86 — noise-scaled ratchet"],
  verdict,
  status: "REGISTERED FORWARD TEST — paper, shadow only, nothing proposed until the bar is cleared.",
});

console.log(`\nR87 momPctile FILTER — skip <= ${THRESHOLD} · evidence from ${EVIDENCE_START} · bar paired t >= ${BAR.pairedT} at ${BAR.minSessions} sessions`);
console.log(`  scored ${rows.length} · excluded (no momPctile) ${noField} · take ${rows.filter((r) => !r.skip).length} / skip ${rows.filter((r) => r.skip).length}`);
console.log(`  ${sessions} paired session(s) · gap ${gap == null ? "n/a" : (gap >= 0 ? "+" : "") + gap + "R"} · t ${t ?? "n/a"}`);
console.log(`  ${verdict}\n  SHADOW ONLY — blocks nothing.\nwritten: data/mom-pctile-filter.json\n`);
