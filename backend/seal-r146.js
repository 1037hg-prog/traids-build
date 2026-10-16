#!/usr/bin/env node
/** Seals R146's one read (2026-09-22). */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const r = JSON.parse(fs.readFileSync(D("r146-wings-vs-trend.json"), "utf8")); if (!r.read) { console.error("not a read"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R146) { console.error("already sealed"); process.exit(2); }
const nul = JSON.parse(fs.readFileSync(D("r146-empirical-null.json"), "utf8"));
const best = Object.entries(r.variants).sort((a, b) => Math.abs(b[1].t) - Math.abs(a[1].t))[0];
const verdict = `${r.verdict} — largest of four ${best[0]}: gap ${best[1].gapR}R (t ${best[1].t}) against an EMPIRICAL bar of ${nul.p95}; three of four gaps are negative but none is near significance and every variant flips sign between halves. 538 option tickets, 76 underlyings, 28 usable sessions, 2026-07-31..2026-09-21. The INTC case (-1.11R of wings while the stock ran 25% in a week) is an anecdote on this sample, not a pattern. METHOD NOTE: the formula bar for a best-of-4 at n=28 is 2.393, but 400 within-session rank shuffles put this statistic's own 95th percentile at ${nul.p95} and its max at ${nul.max} — small hot buckets plus heavy-tailed option R. The empirical bar was registered before the read.`;
seals.tests.R146 = { sealedOn: "2026-09-22", sessions: 28, unit: "sessions", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R146"); t.status = "READ 2026-09-22 — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R146", verdict: r.verdict }) + "\n");
console.log("sealed");
