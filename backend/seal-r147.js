#!/usr/bin/env node
/** Seals R147's one read. Run once, straight after node backend/r147-earnings-momentum.js --read. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const r = JSON.parse(fs.readFileSync(D("r147-earnings-momentum.json"), "utf8")); if (!r.read) { console.error("not a read"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R147) { console.error("already sealed"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R147");
const best = Object.entries(r.variants).sort((a, b) => (b[1].tNW ?? -9) - (a[1].tNW ?? -9))[0];
const clears = Object.entries(r.variants).filter(([, v]) => v.clears).map(([k]) => k);
const verdict = `${r.verdict} — best of four ${best[0]}: qualifiers beat the other reporters by ${best[1].meanDiffPct}% a season, t_NW ${best[1].tNW} against a bar of ${t.bar.tRequired}, over ${best[1].seasons} seasons and ${best[1].qualifiers} qualifying reports; halves ${best[1].firstHalfPct}/${best[1].secondHalfPct}; qualifiers vs SPY net ${best[1].qualNetExcessPct}%.${clears.length ? " Clearing: " + clears.join(", ") + "." : ""} ${r.events} reports priced, ${r.coverage.withEarnings} of ${r.coverage.names} names with earnings history.`;
seals.tests.R147 = { sealedOn: new Date().toISOString().slice(0, 10), seasons: best[1].seasons, unit: "seasons", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R147", verdict: r.verdict, bestT: best[1].tNW }) + "\n");
console.log("sealed: " + verdict);
