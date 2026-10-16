#!/usr/bin/env node
/** PRE-EVIDENCE amendment of the R284-R294 bars (2026-09-29, before any --read). Operator: "our t is usually 2".
 *  The registration charged best-of-(11 x card cells); house precedent (R276-R280, 2026-09-28) charges each card only for its OWN
 *  cells: bar = nullBar({variants: cells, n}).p95. The family-wise view (11 shots) is disclosed in the presentation instead.
 *  Refuses if any of the eleven has been sealed or has an output file. Usage: node amend-bars-0929.cjs <backend dir> */
const fs = require("fs"), path = require("path"); const BK = process.argv[2];
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js")); const { nullBar } = require(path.join(BK, "lib", "null-bar.js"));
const D = (f) => path.join(BK, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
const ids = Array.from({ length: 11 }, (_, i) => "R" + (284 + i)); const out = [];
for (const id of ids) {
  const t = reg.preregistered.find((x) => x.id === id); if (!t) throw new Error(id + " missing");
  if (seals.tests && seals.tests[id]) throw new Error(id + " already sealed — amendment illegal");
  const outFiles = fs.readdirSync(D("")).filter((f) => f.toLowerCase().startsWith(id.toLowerCase() + "-") && f.endsWith(".json"));
  const read = outFiles.filter((f) => { try { const j = JSON.parse(fs.readFileSync(D(f), "utf8")); return j && (j.verdictScript || j.tNet != null); } catch { return false; } });
  if (read.length) throw new Error(`${id} already has a read output (${read.join(", ")}) — amendment illegal`);
  const cells = Math.round(t.bar.variants / 11), n = t.nExpected; const was = t.bar.tRequired;
  const now = +nullBar({ variants: cells, n, trials: 20000 }).p95.toFixed(3);
  t.bar = { ...t.bar, tRequired: now, variants: cells, source: `nullBar({variants:${cells}, n:${n}, trials:20000}).p95 = ${now}` };
  t.multiplicityFamily = t.multiplicityFamily.replace(/best-of-11 x each card's own variants/, "each card charged for its own cells (house precedent R276-R280); the 11-shot family-wise view is disclosed at presentation").replace(/ · this card examines \d+ cells, so its bar is best-of-\d+/, cells > 1 ? ` · this card examines ${cells} cells, so its bar is best-of-${cells}` : "");
  (t.amendments ||= []).push({ date: "2026-09-29", preEvidence: true, field: "bar.tRequired", was, becomes: now, why: "Operator: 'our t is usually 2'. Registration stacked best-of-11 on top of each card's cells; house precedent (R276-R280) charges each card for its own cells only. Made before any --read (no seal, no output file)." });
  out.push(`${id} ${t.scoutKey}: ${was} -> ${now} (best-of-${cells}, n ${n})`);
}
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-29", area: "registry — SCOUT-0929 family bars", category: "registration amendment (pre-evidence)", breaksComparability: false, change: "R284-R294 bars re-set to each card's own cells (house precedent R276-R280): " + out.join("; "), why: "Operator: 'our t is usually 2'.", doesNotEstablish: "Any result; no read had occurred.", operator: "Josh 2026-09-29" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-bar-pre-evidence", tests: ids, detail: "SCOUT-0929 bars to own-cells convention before any read" }) + "\n");
console.log(out.join("\n"));
