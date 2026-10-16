#!/usr/bin/env node
/** R149 pre-read amendment 2 (2026-09-23): limit orders fill only when price trades THROUGH the level. Refuses to run twice or post-read. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R149");
if ((t.amendments || []).some((a) => a.id === "limit-through-2026-09-23")) { console.error("already amended"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R149 || fs.existsSync(D("r149-tv-family.json"))) { console.error("R149 already read — refusing"); process.exit(2); }
t.amendments.push({ id: "limit-through-2026-09-23", date: "2026-09-23", preEvidence: true,
  what: "Every LIMIT order (targets, the gap-fill exit, ONE-PCT-WEEK's entry, target and breakeven) fills only when price trades through its level by 0.01% (one tick on a $100 name); a touch is not a fill. Stops unchanged. Selftest check added. Control log now prints the drift-free runs it judges.",
  why: "Controls v2 failed on one of 16 drift-free runs: ONE-PCT-WEEK seed 1, t 2.27. Diagnostic on six drift-free seeds: t 2.27, 0.12, 1.82, -0.31, 0.90, 0.38 (mean about +0.13%/month, positive in 5 of 6) — a systematic positive on zero-drift noise. Cause: the emulator, like TradingView's, fills limit orders on the touch, which is optimistic for any limit-order strategy (a touch often does not fill a queued order). This is an engine realism fix applied to every member, not to one.",
  evidenceSeen: "Controls outputs and the six-seed diagnostic on scrambled prices only; no unfiltered real statistic." });
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R149 amendment 2 — limit fills through the level", category: "amendment", breaksComparability: false, change: "Limit orders fill only on a trade-through; engine realism fix.", why: "Touch-fill optimism produced a positive on zero-drift noise for the limit-order member.", operator: "assistant, disclosed to Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-read", test: "R149", detail: "amendment 2: limit orders fill through the level" }) + "\n");
console.log("R149 amendment 2 recorded");
