#!/usr/bin/env node
/** Seals R155 (Delta-RSI out of sample)'s one read. Run once, straight after node backend/r155-delta-rsi-oos.js --read. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const r = JSON.parse(fs.readFileSync(D("r155-delta-rsi-oos.json"), "utf8")); if (!r.read) { console.error("not a read"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R155) { console.error("already sealed"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R155");
const best = Object.entries(r.members).sort((a, b) => (b[1].tNW ?? -9) - (a[1].tNW ?? -9))[0];
const clears = Object.entries(r.members).filter(([, v]) => v.clears).map(([k]) => k);
const verdict = `${r.verdict} — best of three ${best[0]}: ${best[1].meanNetPctPerMonth}% net per month (scrambled floor ${r.noiseFloor[best[0]]}), t_NW ${best[1].tNW} against a family bar of ${t.bar.tRequired[best[0]]} (member bars = family bar + its noise mean), ${best[1].trades} trades over ${best[1].months} months; halves ${best[1].firstHalfPct}/${best[1].secondHalfPct}; per trade ${best[1].meanNetPctPerTrade}%, win ${best[1].winRatePct}%.${clears.length ? " Clearing: " + clears.join(", ") + "." : ""} Members: ${Object.entries(r.members).map(([k, v]) => k + " t " + v.tNW).join("; ")}.`;
seals.tests.R155 = { sealedOn: new Date().toISOString().slice(0, 10), months: best[1].months, unit: "months", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R155", verdict: r.verdict, bestT: best[1].tNW }) + "\n");
console.log("sealed: " + verdict);
