#!/usr/bin/env node
/** Seals R156's one read. Run once, straight after node backend/r156-qqe-ssl-wae-oos.js --read. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const r = JSON.parse(fs.readFileSync(D("r156-qqe-ssl-wae-oos.json"), "utf8")); if (!r.read) { console.error("not a read"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R156) { console.error("already sealed"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R156"), v = r.result;
const verdict = `${r.verdict} — ${v.trades} out-of-sample trades, ${v.meanPctPerMonth}% per month (drift-kept floor ${r.floor}), t_NW ${v.tNW} vs member bar ${r.memberBar}; halves ${v.firstHalfPct}/${v.secondHalfPct}; win ${v.winRatePct}%; compounded ${v.compoundedPct}% vs BTC buy-and-hold ${r.btcBuyHoldPct}%.`;
seals.tests.R156 = { sealedOn: new Date().toISOString().slice(0, 10), months: 53, unit: "months", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R156", verdict: r.verdict, t: v.tNW }) + "\n");
console.log("sealed: " + verdict);
