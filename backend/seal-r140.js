#!/usr/bin/env node
/** Seals R140's one historical read (2026-09-21). */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const r = JSON.parse(fs.readFileSync(D("r140-orb-nq.json"), "utf8")); if (!/^(PASS|DID NOT PASS)/.test(r.verdict || "")) { console.error("no verdict in the store"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R140) { console.error("already sealed"); process.exit(2); }
const best = Object.entries(r.variants).sort((a, b) => b[1].t - a[1].t)[0];
const verdict = `${r.verdict} — best of six ${best[0]}: ${best[1].meanNetPtsPerSession} net pts/session, t ${best[1].t} (bar 2.399), halves ${best[1].halves.first} / ${best[1].halves.second}; four of six variants negative; ${r.coverage.sessions} sessions ${r.coverage.first}..${r.coverage.last}`;
seals.tests.R140 = { sealedOn: "2026-09-21", sessions: r.coverage.sessions, unit: "sessions", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R140"); t.status = "READ 2026-09-21 — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R140", verdict: r.verdict, t: best[1].t }) + "\n");
console.log("sealed:", verdict);
