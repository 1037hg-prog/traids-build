#!/usr/bin/env node
/** Seals R163's read. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const h = JSON.parse(fs.readFileSync(D("r163-holdout.json"), "utf8")), d = JSON.parse(fs.readFileSync(D("r163-discovery.json"), "utf8"));
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R163) { console.error("already sealed"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R163");
const disc = Object.entries(d.results).map(([k, v]) => `${k} ${v.netBpsPerDay}bps/day net (gross ${v.grossBpsPerDay}) t ${v.tNW}`).join("; ");
const verdict = `${h.verdict} — discovery 2017-2021 carried 0 of 6: ${disc}. Every pattern was ~zero or negative GROSS; a 5 bp round trip sinks all of them. Holdout context (weightless): ${Object.entries(h.contextAll).map(([k, v]) => k + " " + v.netBpsPerDay + " t" + v.tNW).join("; ")}.`;
seals.tests.R163 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "sessions", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R163", verdict: h.verdict }) + "\n");
console.log("sealed: " + verdict.slice(0, 400));
