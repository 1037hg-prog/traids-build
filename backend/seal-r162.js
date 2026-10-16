#!/usr/bin/env node
/** Seals R162's holdout read. Run once, straight after --holdout. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const h = JSON.parse(fs.readFileSync(D("r162-holdout.json"), "utf8")), d = JSON.parse(fs.readFileSync(D("r162-discovery.json"), "utf8")); if (!h.read) { console.error("not a read"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R162) { console.error("already sealed"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R162");
const best = Object.entries(h.carried).sort((a, b) => b[1].t - a[1].t)[0];
const verdict = `${h.verdict} — discovery carried ${d.carriedForward.length} of 84; holdout bar t >= ${d.holdoutBar}; best holdout ${best[0]} ${best[1].meanR}R/session t ${best[1].t} (halves ${best[1].firstHalfR}/${best[1].secondHalfR}). 10 of 12 carried stayed slightly positive (+0.002..+0.012R) but none near the bar; wide far-OTM verticals (0.10-0.20 delta, 5 strikes) were small positives in both years — biased UP by per-spread crossing.`;
seals.tests.R162 = { sealedOn: new Date().toISOString().slice(0, 10), sessions: best[1].sessions, unit: "sessions", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R162", verdict: h.verdict }) + "\n");
console.log("sealed: " + verdict);
