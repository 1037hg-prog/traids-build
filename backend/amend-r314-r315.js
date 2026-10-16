#!/usr/bin/env node
/** Records the R314 and R315 PRE-EVIDENCE amendments proposed by the 2026-10-02 build/review/repair round (texts in
 *  docs/server/r314-amendment.json and r315-amendment.json, written by the repairers with full calibration in their `why`).
 *  R314: placebo gate p95 -> p97.5 (registered rule false-passed 5.9% of no-edge block shuffles > the registered 5% limit).
 *  R315: calendar halves -> bond-month halves (the registered first half was decided by 3 bond months of 1922; established from the
 *  frozen signal's shape only). No real statistic of either rule has been computed. Operator 2026-10-02: "test whats outstanding".
 *  Applies the `becomes` texts to the entry fields named and appends the amendment. Refuses if sealed, read, or already amended. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), DOC = (f) => path.join(__dirname, "..", "docs", "server", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
const OUT = { R314: "r314-btc-funding-extremes.json", R315: "r315-fed-model.json" };
for (const id of ["R314", "R315"]) {
  const t = reg.preregistered.find((x) => x.id === id); if (!t) throw new Error("no " + id);
  if ((seals.tests || {})[id]) throw new Error(id + " sealed — amendment illegal");
  if (fs.existsSync(D(OUT[id])) && JSON.parse(fs.readFileSync(D(OUT[id]), "utf8")).read) throw new Error(id + " already read — amendment illegal");
  if ((t.amendments || []).some((a) => Array.isArray(a.runnerGates))) throw new Error(id + " already amended");
  const a = JSON.parse(fs.readFileSync(DOC(id.toLowerCase() + "-amendment.json"), "utf8"));
  if (a.preEvidence !== true || !Array.isArray(a.runnerGates)) throw new Error(id + " amendment malformed");
  const b = a.becomes || {};
  if (b.placebo) t.controls.placebo = b.placebo;
  if (b.halves) t.controls.halves = b.halves;
  if (b.reported) t.controls.reported = b.reported;
  if (b.pass) t.decisionRule.pass = b.pass;
  if (b["knownWeaknesses[1]"] && Array.isArray(t.knownWeaknesses)) t.knownWeaknesses[1] = b["knownWeaknesses[1]"];
  (t.amendments ||= []).push(a);
  t.status = `${t.status.split(" (")[0]} (pre-evidence amendment 2026-10-02: ${a.runnerGates.join(", ")}) — historical, read once; runner built and reviewed`;
  t.writerExists = true;
}
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-10-02", area: "registry — R314/R315 pre-evidence amendments", category: "registration", breaksComparability: false,
  change: "R314: random-hold placebo gate p95 -> p97.5 (registered rule false-passed 5.9% of 2,000 no-edge block shuffles; p97.5 3.65-4.1% across constructions). R315: calendar halves -> bond-month halves (the Fed-Model switch holds bonds in 394 of 1,862 months, 3 of them before 1949, so the registered first-half gate was three 1922 months); Shiller-file interpolation look-ahead disclosed in knownWeaknesses; E(m-6) variant reported.",
  why: "Build/review/repair round 2026-10-02; calibration on no-edge data before any read. Operator 2026-10-02: 'test whats outstanding'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-02" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-evidence", tests: ["R314", "R315"], detail: "R314 placebo:p975; R315 halves:bond-month-count" }) + "\n");
console.log("R314 + R315 amended (pre-evidence)");
