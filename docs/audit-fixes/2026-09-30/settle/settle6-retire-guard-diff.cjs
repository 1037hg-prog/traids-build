#!/usr/bin/env node
/**
 * settle#6 (2026-10-01 audit) — READ-ONLY diff of the canonical retire guard: the old substring test (`registry TEXT includes tag`)
 * against the new exact/structured match (lib/reconcile.js registryNamesRetireTag). Prints every retire tag in trade_log.json, how each
 * guard treats it, the rows whose canonical status would flip, and the cleanEraLedger() headline under the new code. Writes nothing.
 *   node docs/audit-fixes/2026-09-30/settle/settle6-retire-guard-diff.cjs
 */
"use strict";
const fs = require("fs"), path = require("path");
const BK = path.join(__dirname, "..", "..", "..", "..", "backend");
const RC = require(path.join(BK, "lib", "reconcile.js"));
const crText = fs.readFileSync(path.join(BK, "data", "change-registry.json"), "utf8");
const cr = JSON.parse(crText);
const log = JSON.parse(fs.readFileSync(path.join(BK, "data", "trade_log.json"), "utf8"));
const tags = new Map();
for (const t of log) if (t && t.retired && t.retireNote) { const k = t.retired; const e = tags.get(k) || { rows: 0, signals: 0, controls: 0, sumR: 0 }; e.rows++; t.ctrl ? e.controls++ : e.signals++; e.sumR += Number.isFinite(t.rMult) ? t.rMult : 0; tags.set(k, e); }
let flips = 0;
console.log("tag".padEnd(40), "rows", "old(substring)", "new(exact)");
for (const [k, e] of tags) {
  const oldOk = crText.includes(k), newOk = RC.registryNamesRetireTag(cr, k);
  if (oldOk !== newOk) flips += e.rows;
  console.log(k.padEnd(40), String(e.rows).padStart(4), String(oldOk).padStart(14), String(newOk).padStart(10), oldOk !== newOk ? `  FLIP (${e.signals} sig / ${e.controls} ctrl, sumR ${e.sumR.toFixed(3)})` : "");
}
console.log(`rows whose retire status flips: ${flips}`);
console.log("probes under the new guard (all must be false):", ["loss", "stop", "R21", "close", "a", "x", "wing-cap", "D49", "holiday-entry"].map((p) => `${p}=${RC.registryNamesRetireTag(cr, p)}`).join(" "));
console.log("probes under the OLD guard:", ["loss", "stop", "R21", "close", "a", "x", "wing-cap", "D49", "holiday-entry"].map((p) => `${p}=${crText.includes(p)}`).join(" "));
const L = RC.cleanEraLedger();
console.log(`cleanEraLedger (new code): honoured ${JSON.stringify(L.retireTagsHonoured)} ignored ${JSON.stringify(L.retireTagsIGNORED)} retiredExcluded ${L.retiredExcluded} signals ${L.n} controls ${L.controlN} meanR ${L.meanR} controlMeanR ${L.controlMeanR} pooledEdgeR ${L.pooledEdgeR}`);
const bad = flips !== 0 || ["loss", "stop", "R21", "a"].some((p) => RC.registryNamesRetireTag(cr, p));
console.log(bad ? "RESULT: FAIL" : "RESULT: PASS — no canonical row changes status; generic words no longer pass the guard");
process.exit(bad ? 1 : 0);
