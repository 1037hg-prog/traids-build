#!/usr/bin/env node
/** R149 pre-read amendment 3 (2026-09-23): the leak test's drift-free scrambles remove ARITHMETIC drift, not log drift. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R149");
if ((t.amendments || []).some((a) => a.id === "arith-drift-2026-09-23")) { console.error("already amended"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R149 || fs.existsSync(D("r149-tv-family.json"))) { console.error("R149 already read — refusing"); process.exit(2); }
t.amendments.push({ id: "arith-drift-2026-09-23", date: "2026-09-23", preEvidence: true,
  what: "The leak test's drift-free scrambles now set the ARITHMETIC mean bar return to zero (mean gross return = 1) instead of the log mean.",
  why: "Controls v3 failed again on ONE-PCT-WEEK seed 1 (t 2.23). A zero LOG drift leaves an arithmetic drift of about sigma^2/2 per bar — roughly 8%/yr on TQQQ's 15-minute volatility — which a long-only strategy collects on noise. Diagnostic on six seeds with arithmetic drift removed: t 1.51, 0.01, 0.74, -0.57, -0.47, -0.10 (centred on zero); with log drift removed they were 2.27, 0.12, 1.82, -0.31, 0.90, 0.38. The floor (drift-kept) is unchanged.",
  evidenceSeen: "Scrambled-price controls and diagnostics only; no unfiltered real statistic." });
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R149 amendment 3 — arithmetic drift-free null", category: "amendment", breaksComparability: false, change: "Leak-test scrambles demeaned in arithmetic, not log, terms.", why: "Volatility drag left a positive arithmetic drift that long-only members harvested on noise.", operator: "assistant, disclosed to Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-read", test: "R149", detail: "amendment 3: arithmetic drift-free leak null" }) + "\n");
console.log("R149 amendment 3 recorded");
