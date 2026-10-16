#!/usr/bin/env node
/** Seals R143's one read (2026-09-22). */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const r = JSON.parse(fs.readFileSync(D("r143-iv-percentile.json"), "utf8")); if (!r.read) { console.error("not a read"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R143) { console.error("already sealed"); process.exit(2); }
const best = Object.entries(r.variants).sort((a, b) => (b[1].t ?? -9) - (a[1].t ?? -9))[0];
const short = Object.entries(r.variants).filter(([, v]) => v.episodes < 40).map(([k, v]) => `${k} ${v.episodes}`);
const verdict = `${r.verdict} — best of four ${best[0]}: cheap-IV names ran ${best[1].meanGapVolPts} vol pts hotter than the rest, t ${best[1].t} against a bar of 2.296, halves ${best[1].halves.first}/${best[1].halves.second}. 965 observations, 10 names, 100 grid dates (345 name-days dropped for want of invertible option prices). UNDER-POWERED TOO: three of four variants fell short of the 40-episode sample condition (${short.join(", ")}), so this is "not shown", not "shown absent". Leak test clean: labels shuffled within each name gave t 0.39 / 0.02 / 0.23 (52-obs window, bottom 20%).`;
seals.tests.R143 = { sealedOn: "2026-09-22", sessions: best[1].episodes, unit: "episodes", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R143"); t.status = "READ 2026-09-22 — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R143", verdict: r.verdict, bestT: best[1].t }) + "\n");
console.log("sealed:", verdict);
