#!/usr/bin/env node
/** Seals R161's holdout read. Run once, straight after node backend/r161-anomalies.js --holdout. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const h = JSON.parse(fs.readFileSync(D("r161-holdout.json"), "utf8")), d = JSON.parse(fs.readFileSync(D("r161-discovery.json"), "utf8")); if (!h.read) { console.error("not a read"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R161) { console.error("already sealed"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R161");
const carried = Object.entries(h.carried || {}).map(([k, v]) => `${k} holdout ${v.netPctPerMonth}%/mo t ${v.tNW} (halves ${v.firstHalfPct}/${v.secondHalfPct})`).join("; ");
const verdict = `${h.verdict} — discovery 2017-2021 carried ${d.carriedForward.length} of 19 (${d.carriedForward.join(", ") || "none"}); holdout bar t >= ${d.holdoutBar}: ${carried || "nothing to test"}. Low-vol, beta, MAX, IVOL, skew, seasonality and short-term reversal were negative in discovery; context (weightless): MOM12_7 was negative in discovery and +1.07%/mo t 2.55 in the holdout — the sign flips between regimes.`;
seals.tests.R161 = { sealedOn: new Date().toISOString().slice(0, 10), months: 57, unit: "months", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R161", verdict: h.verdict }) + "\n");
console.log("sealed: " + verdict);
