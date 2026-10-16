#!/usr/bin/env node
/** R308 dated amendment (2026-10-01, operator: "run it") — PRE-EVIDENCE: no model has been scored on real data; only the synthetic leak
 *  control ran. The registered leak gate (|t| < 2 on ONE synthetic seed, two-sided, gross vs net unstated) was badly specified by the
 *  registrar: on structure-free paths the models never call a crest and hold to the 48 h cap, so the gate measured hold-48 noise and failed
 *  on the NEGATIVE side (LOGIT gross t -2.31, GBM -2.16), while a real look-ahead leak shows as a large POSITIVE edge (~ +24 in the
 *  planted-leak selftest). The amendment is disclosed as made AFTER that one-seed failure; it is a correction of the control, and it adds a
 *  stricter real-data gate (must beat hold-48). Refuses if R308 is sealed or already has this amendment. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R308");
if (!t) throw new Error("no R308"); const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {}).R308) throw new Error("R308 sealed — amendment illegal");
if ((t.amendments || []).some((a) => a.field === "controls.leakTest")) throw new Error("already amended");
const was = t.controls.leakTest;
t.controls.leakTest = "AMENDED 2026-10-01 (pre-evidence): the full pipeline on 20 synthetic seeds (each coin's hourly returns demeaned then randomly permuted). A LEAK is a POSITIVE edge. Gate passes when, for each cell (LOGIT, GBM), the median across seeds of the GROSS cell t is <= +1.0 and at most 2 of 20 seeds exceed +2.0, AND the same two conditions hold for the per-day model-minus-HOLD48 gap t. Model-minus-FADE on synthetic data is reported only. Gross is used for the cells because the 0.50% cost makes every net t negative on zero-edge paths.";
t.controls.vsHOLD48 = "AMENDED 2026-10-01: paired per-day difference against simply holding each trade to the 48 h cap, on the same trades — the model must beat it (mean > 0) to PASS (a stricter gate added with the leak-control fix).";
t.decisionRule.pass = "PASS only if the better cell's net t >= bar AND it beats the shuffled-label p95 AND it beats FADE on the paired difference (mean > 0) AND it beats HOLD48 on the paired difference (mean > 0) AND both halves are positive AND the amended 20-seed leak gate was clean. A PASS proposes a forward paper test (operator's call).";
(t.amendments ||= []).push({ date: "2026-10-01", preEvidence: true, field: "controls.leakTest", was,
  becomes: t.controls.leakTest + " PLUS a new real-data gate: beat HOLD48 (mean paired difference > 0).",
  why: "The single-seed two-sided gate measured hold-48 noise on structure-free paths and failed on the negative side (t -2.31 / -2.16), which cannot indicate look-ahead (a planted leak gives about +24). The builder's post-hoc 12-seed check came out clean on 11 of 12. Disclosed: this amendment follows that one-seed failure; no real-data model score has been computed. Operator 2026-10-01 'run it'.",
  firstLeakRun: "backend/data/training/r308/leak-test.json (kept)" });
t.status = "REGISTERED 2026-10-01 (leak-gate amendment 2026-10-01, pre-evidence) — historical, read once; builder assigned";
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-10-01", area: "registry — R308 leak-gate amendment", category: "registration", breaksComparability: false, change: "R308 pre-evidence amendment: leak control becomes a 20-seed one-sided (positive = leak) gate on gross cell t and model-minus-HOLD48 t; new real-data gate 'beat HOLD48'. Disclosed as following the single-seed negative-side failure (t -2.31/-2.16); no real-data score computed.", why: "Operator 2026-10-01: 'run it'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-01" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-evidence", tests: ["R308"], detail: "leak gate -> 20-seed one-sided + beat HOLD48" }) + "\n");
console.log("R308 amended · amendments", t.amendments.length);
