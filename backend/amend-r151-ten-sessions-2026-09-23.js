#!/usr/bin/env node
/** R151 pre-evidence amendment (2026-09-23): the operator's read point — 10 sessions. Refuses to run twice or after any R151 row exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R151");
if ((t.amendments || []).some((a) => a.id === "ten-sessions-2026-09-23")) { console.error("already amended"); process.exit(2); }
if (fs.existsSync(D("r151-ledger.jsonl")) && fs.readFileSync(D("r151-ledger.jsonl"), "utf8").trim()) { console.error("R151 has evidence rows — an amendment now would be post-evidence; refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 1, n: 10, trials: 50000 }).p95.toFixed(3);
(t.amendments ||= []).push({ id: "ten-sessions-2026-09-23", date: "2026-09-23", preEvidence: true, operator: "Josh 2026-09-23: 'evaluate at 10 sessions; paper trade test; but the level doesn't matter'",
  what: `Read after the 10th session (2026-09-24 .. 2026-10-07, read after that day's close). No minimum trade count. Bar re-drawn for n = 10 sessions: ${BAR} (was 1.699 at 30). The 15-session interim kill is removed (the read comes first). Size stays $1,000 per entry.`,
  powerNote: "Disclosed to the operator before the change: at ~3 trades a session, a true +0.6%/trade edge would typically read near t 0.6 at 10 sessions against a ~1.8 bar, so a real edge will most likely read DID NOT PASS. A fail at 10 sessions is therefore weak evidence against RSI-2; a pass would be strong evidence for it.",
  afterRead: "The three arms keep trading after the sealed read as a WEIGHTLESS forward record (same runner, same ledger) for the operator's funding decision; that record never re-reads R151." });
t.bar = { ...t.bar, minSessions: 10, minTrades: 0, tRequired: BAR, source: `lib/null-bar.js nullBar({variants:1, n:10, trials:50000}).p95 = ${BAR} (amended 2026-09-23 from n=30)`, readAfter: "2026-10-07 close" };
t.interimKill = "none (amended 2026-09-23: the 10-session read comes before the former 15-session kill)";
t.readCondition = "After the close of 2026-10-07 (the 10th session from 2026-09-24): node backend/r151-read.js --seal (run nightly by the close chain; it refuses until then and seals once).";
t.decisionRule.pass = `Arm A mean per-trade return > 0 and session t >= ${BAR} over the 10 sessions. A PASS is the first TRAIDS result measured on a broker's own fills; it adopts nothing — sizing and any live money are the operator's decision.`;
t.decisionRule.fail = "Otherwise DID NOT PASS at 10 sessions. Because 10 sessions is under-powered (see powerNote), a fail does not close the RSI-2 line by itself; the weightless forward record continues and the operator decides.";
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R151 read point amended to 10 sessions", category: "amendment", breaksComparability: false, change: `Read after 2026-10-07; bar ${BAR}; no trade minimum; arms continue weightless after the read.`, why: "Operator's decision.", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "amend-pre-evidence", test: "R151", detail: `read at 10 sessions, bar ${BAR}` }) + "\n");
console.log(`R151 amended: read after 2026-10-07 close, bar ${BAR}`);
