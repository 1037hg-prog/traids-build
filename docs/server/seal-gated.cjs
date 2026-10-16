#!/usr/bin/env node
/** Seals one gated read (R313-R315 pattern): node seal-gated.cjs <backend dir> <ID> <output json name> ["note"]
 *  Re-derives the verdict from the runner's gate booleans and the REGISTRY bar: PASS only if every gate is true AND verdictScript
 *  says PASS; CANNOT MEASURE if the script says so. Refuses if already sealed, not read, or the bar disagrees with the registry. */
const fs = require("fs"), path = require("path"); const [BK0, ID, OUTF, NOTE] = process.argv.slice(2); const BK = BK0 && path.resolve(BK0);   // 2026-10-08: a relative "backend" resolved as a module name
if (!BK || !ID || !OUTF) throw new Error("usage: <backend dir> <ID> <output json name> [note]");
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js")); const D = (f) => path.join(BK, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === ID); if (!t) throw new Error("no " + ID);
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {})[ID]) throw new Error(ID + " already sealed");
const o = JSON.parse(fs.readFileSync(D(OUTF), "utf8")); if (!o.read) throw new Error("no read output in " + OUTF);
const bar = Number(o.bar && typeof o.bar === "object" ? o.bar.tRequired : o.bar); if (Math.abs(bar - Number(t.bar.tRequired)) > 1e-9) throw new Error(`bar mismatch: output ${bar} vs registry ${t.bar.tRequired}`);
const g = o.gates || {}, failed = Object.entries(g).filter(([, v]) => v !== true).map(([k]) => k), vs = String(o.verdictScript || "");
let verdict = /^CANNOT/.test(vs) ? "CANNOT MEASURE" : failed.length === 0 && /^PASS/.test(vs) ? "PASS" : "DID NOT PASS";
const pick = (k) => (o[k] == null ? null : typeof o[k] === "number" ? +o[k].toFixed(4) : o[k]);
const head = { unit: o.unit || t.unit, n: pick("n") ?? pick("months") ?? pick("trades"), trades: pick("trades"), tNet: pick("tNet"), meanNet: pick("meanNet"), winRatePct: pick("winRatePct") };
const text = `${verdict} — failed gate(s): ${failed.join(", ") || "none"}; bar ${t.bar.tRequired}; ${JSON.stringify(head)}; script said: ${vs.slice(0, 160)}${NOTE ? " · Note: " + NOTE : ""}`;
seals.tests[ID] = { sealedOn: new Date().toISOString().slice(0, 10), unit: head.unit, verdict: text }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = `SEALED ${new Date().toISOString().slice(0, 10)} — ${text}`; t.writerExists = true; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict, failed, tNet: head.tNet, bar: t.bar.tRequired }) + "\n");
console.log(`${ID} sealed: ${text}`);
