#!/usr/bin/env node
/** Seals one SCOUT-0929 read (R284-R294): node seal-scout-0929.cjs <backend dir> <ID> ["note"]
 *  Re-derives the verdict from the builder's output and the REGISTRY bar (never the builder's word): PASS only if tNet >= bar.tRequired
 *  AND the placebo is beaten AND both halves share the sign of the mean; CANNOT MEASURE if the builder says so. Writes read-seals.json,
 *  the registry status, the agent ledger. Refuses if already sealed or no output exists. */
const fs = require("fs"), path = require("path"); const [BK, ID, NOTE] = process.argv.slice(2);
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js")); const D = (f) => path.join(BK, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const t = reg.preregistered.find((x) => x.id === ID); if (!t) throw new Error("no " + ID);
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error(ID + " already sealed");
const stem = path.basename(t.script, ".js"); const f = D(stem + ".json"); if (!fs.existsSync(f)) throw new Error("no output " + f);
const o = JSON.parse(fs.readFileSync(f, "utf8")); const bar = t.bar.tRequired;
const num = (x) => (x == null || x === "" || isNaN(+x) ? null : +x);
const tNet = num(o.tNet), mean = num(o.meanNet);
const beats = o.placebo && (o.placebo.beats === true || o.placebo.beats === "true");
const h = o.halves || {}; const hv = (x) => num(x && typeof x === "object" ? (x.meanNet ?? x.meanExcessNet ?? (x.meanNetPct != null ? x.meanNetPct / 100 : null) ?? (x.meanBps != null ? x.meanBps / 1e4 : null) ?? x.mean ?? x.value) : x);
const h1 = hv(h.first), h2 = hv(h.second); const sameSign = h1 != null && h2 != null && mean != null && Math.sign(h1) === Math.sign(mean) && Math.sign(h2) === Math.sign(mean);
let verdict;
if (/CANNOT/i.test(String(o.verdictScript))) verdict = "CANNOT MEASURE";
else verdict = tNet != null && tNet >= bar && beats && sameSign ? "PASS" : "DID NOT PASS";
if (verdict === "PASS" && !/^PASS/i.test(String(o.verdictScript))) verdict = "DID NOT PASS"; // both must agree for a PASS
const text = `${verdict} — tNet ${tNet} vs bar ${bar} (${t.bar.source}); n ${o.n} ${o.unit || t.unit}; meanNet ${mean}; placebo ${beats ? "beaten" : "NOT beaten"} (p95 ${o.placebo && (o.placebo.p95 ?? o.placebo.p95Mean)}, observed ${o.placebo && o.placebo.observed}); halves ${h1} / ${h2}${sameSign ? "" : " (sign NOT stable)"}; builder said ${o.verdictScript}.${NOTE ? " Note: " + NOTE : ""}`;
seals.tests[ID] = { sealedOn: new Date().toISOString().slice(0, 10), unit: o.unit || t.unit, verdict: text }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = `SEALED ${new Date().toISOString().slice(0, 10)} — ${text}`; t.writerExists = true; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, family: "SCOUT-0929", verdict, tNet, bar }) + "\n");
console.log(`${ID} sealed: ${text}`);
