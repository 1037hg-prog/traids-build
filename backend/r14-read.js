#!/usr/bin/env node
/**
 * R14 READ — the registered era comparison, computed on the canonical ledger. Written 2026-09-07 for the one read.
 *
 * R14 (registered 2026-08-03, enforced from the 08-03 close): HOLD OVERNIGHT — positions entered at the open settle at the NEXT
 * open, so each round trip spans one overnight session. The registered bar (test-registry.json R14.bar.grading, verbatim):
 * "paired against the pre-R14 era: mean R per settle, day-clustered, >=20 sessions under the new rule before any read. The
 * pre-registered comparison is R14-era expectancy minus the 2026-07-20..2026-08-03 intraday-only era." tRequired 2.0; kill if
 * the R14 era is WORSE at day-clustered t <= -2 (day cadence restored).
 *
 * No reader existed for this statistic: the adjudicator counted calendar sessions since 08-04 and r14-tail.js measures the
 * overnight TAIL (the circuit breaker), not the expectancy. This file is the reader. Population: canonical clean-era SIGNAL rows
 * (lib/reconcile.js cleanEraLedger — settled, retired-excluded, controls and veto shadows out), keyed by lib/session.js
 * openSession. Statistic: mean of the per-session mean R in the R14 era (sessions >= 2026-08-04) minus the same in the
 * intraday-only era (2026-07-20 .. 2026-08-03); Welch t on the two sets of session means (unit: sessions). Pooled per-settle
 * means are reported as a diagnostic because the two weightings can disagree in sign, and did.
 *
 * Read ONCE. Output data/r14-read.json; the seal lives in data/read-seals.json. Later runs recompute and are post-seal, weightless.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const rc = require("./lib/reconcile.js"), S = require("./lib/session.js");
const D = (f) => path.join(__dirname, "data", f);
const REG = (() => { const r = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); for (const k of Object.keys(r)) if (Array.isArray(r[k])) { const t = r[k].find((x) => x.id === "R14"); if (t) return t; } })();
if (!REG || !REG.bar || !Number.isFinite(REG.bar.tRequired)) { console.error("R14 not registered with a bar"); process.exit(1); }
const L = rc.cleanEraLedger();
rc.assertReconciled("clean-era pooled edge (R14 read input)", rc.recomputeEdge(L), L.pooledEdgeR);
const ERA_A = ["2026-07-20", "2026-08-03"], ERA_B_FROM = "2026-08-04";
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const vr = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
const by = {}; for (const r of L.signals) (by[S.openSession(r)] ||= []).push(r.rMult);
const days = Object.keys(by).sort();
const A = days.filter((d) => d >= ERA_A[0] && d <= ERA_A[1]), B = days.filter((d) => d >= ERA_B_FROM);
const dmA = A.map((d) => mean(by[d])), dmB = B.map((d) => mean(by[d]));
const diff = mean(dmB) - mean(dmA), se = Math.sqrt(vr(dmA) / dmA.length + vr(dmB) / dmB.length), t = diff / se;
const pooled = (ds) => { const a = ds.flatMap((d) => by[d]); return { settles: a.length, meanR: +mean(a).toFixed(4) }; };
const r4 = (x) => +x.toFixed(4);
const bar = REG.bar;
const sampleMet = B.length >= 20;
let letter;
if (!sampleMet) letter = `NOT READABLE — ${B.length}/20 sessions under the rule`;
else if (t >= bar.tRequired) letter = `CLEARED — the overnight era beats the intraday-only era by ${r4(diff)}R per session-mean at t ${t.toFixed(2)} (bar ${bar.tRequired})`;
else if (t <= -2) letter = `KILLED — the overnight era is worse at t ${t.toFixed(2)}; the registration restores the day cadence`;
else letter = `DID NOT PASS — overnight-era minus intraday-era session-mean expectancy ${r4(diff)}R at t ${t.toFixed(2)} on ${B.length} sessions vs ${A.length} (bar t >= ${bar.tRequired}); not established, not killed`;
const out = { spec: "r14-read-v1", test: "R14", asOf: new Date().toISOString(), ledger: { source: L.source, settled: L.settled, signals: L.signals.length, pooledEdgeR: L.pooledEdgeR },
  population: "canonical clean-era signal rows, keyed by open session (America/New_York)", statistic: "mean of per-session mean R, R14 era minus intraday-only era; Welch t on session means (unit: sessions)",
  eraA: { window: ERA_A, sessions: A.length, sessionMeanR: r4(mean(dmA)), pooled: pooled(A) }, eraB: { from: ERA_B_FROM, sessions: B.length, sessionMeanR: r4(mean(dmB)), pooled: pooled(B) },
  diffR: r4(diff), t: +t.toFixed(3), bar: { tRequired: bar.tRequired, killT: -2, minSessions: 20 }, sampleMet, verdict: letter,
  diagnostics: { note: "pooled per-settle means weight busy sessions more; they read the other way (era B pooled below era A) and are disclosed, not read", pooledDiffR: r4(pooled(B).meanR - pooled(A).meanR) } };
writeJsonAtomic(D("r14-read.json"), out);
console.log(`R14 — ${letter}`);
console.log(`  era A ${A.length} sessions, session-mean ${out.eraA.sessionMeanR}R (pooled ${out.eraA.pooled.meanR}R over ${out.eraA.pooled.settles}); era B ${B.length} sessions, session-mean ${out.eraB.sessionMeanR}R (pooled ${out.eraB.pooled.meanR}R over ${out.eraB.pooled.settles})`);
