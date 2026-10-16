#!/usr/bin/env node
/** Seals R151's one read. Run once, straight after node backend/r151-read.js has written data/r151-read.json. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const r = JSON.parse(fs.readFileSync(D("r151-read.json"), "utf8")); if (!r.read) { console.error("not a read"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R151) { console.error("already sealed"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R151");
const verdict = `${r.verdict} — arm A (close): ${r.A.meanRetPct}% per trade, session t ${r.A.tSessions} against ${r.bar}, ${r.A.trades} trades over ${r.A.sessions} sessions, win ${r.A.winPct}%. Arm B (open): ${r.B.meanRetPct}% (t ${r.B.tSessions}). Arm C (limit): ${r.C.meanRetPct}%, fill rate ${r.C.fillRatePct}%. Close minus open on ${r.closeMinusOpen.pairs} shared signals: ${r.closeMinusOpen.meanDiffPct}% (t ${r.closeMinusOpen.t}). Broker rejects: ${r.rejects}. All from Alpaca paper fills.`;
seals.tests.R151 = { sealedOn: new Date().toISOString().slice(0, 10), sessions: r.A.sessions, unit: "sessions", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R151", verdict: r.verdict, t: r.A.tSessions }) + "\n");
console.log("sealed: " + verdict);
