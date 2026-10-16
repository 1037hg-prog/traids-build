#!/usr/bin/env node
/** Seals R141's one read (2026-09-22). */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const r = JSON.parse(fs.readFileSync(D("r141-r13-fade.json"), "utf8")); if (!/^(PASS|DID NOT PASS)/.test(r.verdict || "")) { console.error("no verdict"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R141) { console.error("already sealed"); process.exit(2); }
const a = r.variants["0935"], b = r.variants.open;
const verdict = `${r.verdict} — the news-gap effect is REAL on the untouched holdout (matched vs the same stocks' ordinary days: 09:35 +${a.matched.meanPp}pp t ${a.matched.t}, halves ${a.matched.halves.first}/${a.matched.halves.second}; open +${b.matched.meanPp}pp t ${b.matched.t}) but NOT TRADEABLE at measured cost: net 09:35 ${a.netMeanPp}pp (t ${a.netT}), open ${b.netMeanPp}pp (t ${b.netT}); median spread at 09:35 ${r.medianSpreadBpsAt0935}bps; ${a.noQuoteEvents} of ${a.events} events had no two-sided quote and were charged 1pp. 390 days, 2025-03-03..2026-09-18. Per the rule the R13 line is closed on this holdout; no filter may be run on it.`;
seals.tests.R141 = { sealedOn: "2026-09-22", sessions: a.days, unit: "trading days", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R141"); t.status = "READ 2026-09-22 — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R141", verdict: r.verdict, matchedT: a.matched.t, netT: a.netT }) + "\n");
console.log("sealed:", verdict);
