#!/usr/bin/env node
/** Seals the R310 read: node seal-r310.cjs <backend dir>
 *  Re-derives the verdict from the runner's gate booleans and the REGISTRY bar (never the builder's word): PASS only if every gate is
 *  true AND the runner's verdictScript says PASS; refuses if already sealed or the output was not a read. */
const fs = require("fs"), path = require("path"); const BK = process.argv[2]; if (!BK) throw new Error("usage: seal-r310.cjs <backend dir>");
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js")); const D = (f) => path.join(BK, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R310"); if (!t) throw new Error("no R310");
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R310) throw new Error("R310 already sealed");
const o = JSON.parse(fs.readFileSync(D("r310-qs-rsi5.json"), "utf8")); if (!o.read) throw new Error("no read output");
if (Number(o.bar) !== Number(t.bar.tRequired)) throw new Error(`bar mismatch: output ${o.bar} vs registry ${t.bar.tRequired}`);
const g = o.gates || {}, failed = Object.entries(g).filter(([, v]) => v !== true).map(([k]) => k);
let verdict = failed.length === 0 && /^PASS/.test(String(o.verdictScript)) ? "PASS" : "DID NOT PASS"; if (/CANNOT/.test(String(o.verdictScript))) verdict = "CANNOT MEASURE";
const r = o.reported || {}, f = (x, d = 3) => (x == null ? "n/a" : (+x).toFixed(d));
const text = `${verdict} — failed gate(s): ${failed.join(", ") || "none"}. Headline: ${o.trades} trades over ${o.months} months, net ${f(o.meanNetPctPerMonth, 4)}%/month, t_NW ${f(o.tNet)} vs bar ${t.bar.tRequired}; win ${f(o.winRatePct, 1)}%, ${f(o.meanPerTradePct, 4)}% per trade. Corrected placebo (the reel's actual claim — dip timing beats a random above-200-day entry in the same stock and month): paired +${f(o.placebo && o.placebo.corrected && o.placebo.corrected.pairedDiffMeanPctPerMonth, 4)}%/month, t ${f(o.placebo && o.placebo.corrected && o.placebo.corrected.pairedDiffT)} < bar. Drift-kept floor cleared (mean > p95; t vs p50 ${f(o.floor && o.floor.tVsP50)}). Halves ${f(o.halves && o.halves.first && o.halves.first.meanNetPctPerMonth, 4)} / ${f(o.halves && o.halves.second && o.halves.second.meanNetPctPerMonth, 4)}%/month; next-open ${f(o.nextOpen && o.nextOpen.meanNetPctPerMonth, 4)}%/month. Reported only: ETF-only ${r.etfOnly ? `${r.etfOnly.trades} trades t ${f(r.etfOnly.tNet)} ${f(r.etfOnly.meanNetPctPerMonth, 4)}%/month` : "n/a"}; ${r.rsi2Overlap ? `${(100 * r.rsi2Overlap.shareRsi2FiresOrPositionOpen).toFixed(1)}% of entries fall where R150's RSI-2 fires or is already long` : ""}; registered (uncalibrated) placebo beaten, not evidence. Gates per the pre-evidence amendment of 2026-10-02.`;
seals.tests.R310 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "months", months: o.months, verdict: text }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = `SEALED ${new Date().toISOString().slice(0, 10)} — ${text}`; t.writerExists = true; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R310", family: "RSI-DIP", verdict, failed, tNet: o.tNet, bar: t.bar.tRequired }) + "\n");
console.log(`R310 sealed: ${text}`);
