#!/usr/bin/env node
/** R152 pre-read amendment 3 (2026-09-23): per-member empirical null bars. Refuses twice or post-read. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R152");
if ((t.amendments || []).some((a) => a.id === "empirical-null-2026-09-23")) { console.error("already amended"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R152 || fs.existsSync(D("r152-tv-top-strategies.json"))) { console.error("R152 already read — refusing"); process.exit(2); }
t.amendments.push({ id: "empirical-null-2026-09-23", date: "2026-09-23", preEvidence: true,
  what: "Leak test and bar replaced by a per-member EMPIRICAL NULL: each member is run on 10 arithmetic drift-free scrambles; its bar = the family bar (unchanged) + max(0, its mean t on noise). Gross-leak check: no member's mean noise t may reach 2. Floor (drift-kept) and positive control unchanged.",
  why: "Controls v3 (open positions marked) left one of 22 drift-free runs over 2 (MACD-STOCH seed 2, t 2.08). Six-seed diagnostic: MACD-STOCH 0.24/2.08/1.99/0.55/1.65/1.63 and BBRSI-LONG 0.99/1.98/0.17/1.92/1.06/2.50 — a systematic tilt of about +1.4 on noise for these rare-signal, long-hold members, while equal-weight buy-and-hold on the same scrambles reads exactly t 0 (the null itself is drift-free). The tilt is structural to how those rules hold positions on noise, not a look-ahead (which would read far higher); charging each member its own noise level is the standard remedy (as R146's empirical null).",
  evidenceSeen: "Scrambled-price runs and diagnostics only; no unfiltered real statistic." });
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R152 amendment 3 — per-member empirical null", category: "amendment", breaksComparability: false, change: "Each member's bar = family bar + its mean t on 10 drift-free scrambles.", why: "Rare-signal members tilt positive on noise (about +1.4) for structural reasons.", operator: "assistant, disclosed to Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-read", test: "R152", detail: "amendment 3: per-member empirical null" }) + "\n");
console.log("R152 amendment 3 recorded");
