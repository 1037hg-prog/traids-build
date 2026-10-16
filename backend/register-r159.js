#!/usr/bin/env node
/** Registers R159 — Payne's Education picks, measured forward from the moment each reaches us. 2026-09-23, operator: "measure paynes
 *  picks forward". Filed BEFORE any pick has been received. Refuses if R159 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R159")) { console.error("R159 already exists — refusing"); process.exit(2); }
const BAR = 1.699;   // one-sided 95% Student t, df 29 (30 closed picks)
reg.preregistered.push({
  id: "R159", name: "Payne's Education picks — forward record at the first price we can get, vs SPY",
  registered: "2026-09-23", evidenceStart: "the first pick logged after 2026-09-23",
  evidenceNote: "Forward only. No pick had been received when this was filed. Picks arrive only if the operator subscribes (his decision) and forwards each alert; each is logged at receipt (machine clock) and mirrored on the Alpaca PAPER account.",
  status: "REGISTERED 2026-09-23 — waiting for the first pick", script: "backend/payne-picks.js",
  parent: "The Premium 'Closed Investments' table (19 picks opened April-July 2026) checked out on 2026-09-23: every price traded, +18.8% mean at stated prices vs SMH +10.3% / SPY +3.5% over the same windows — but closed positions only, 5 months, one sector boom, stated entries sometimes at the day's low. A retrospective table cannot settle it; a forward record can. Memory: payne-ebook-audit.",
  multiplicityFamily: "PAYNE-PICKS-FORWARD-1 — one member: every pick as received, no filtering by us.",
  rule: "Every pick Payne's Education issues (entry and exit alerts) is logged when received and executed on the Alpaca paper account as a market day order ($1,000 notional, whole shares; queued to the next open if the market is closed). Exits follow their exit alerts the same way. Our fills are the result; their stated prices are recorded beside ours.",
  statistic: "Per closed pick: our fill-to-fill return minus SPY's close-to-close return over the same dates (direction-adjusted). Headline: mean excess and its t across closed picks. Secondary (reported, not gating): excess vs SMH; their stated-price return vs ours (the fill gap).",
  bar: { fixedInAdvance: true, unit: "closed picks", minClosed: 30, tRequired: BAR, statistic: "one-sided t of mean excess vs SPY", source: "Student t, df 29, one-sided 95%" },
  interimKill: "none; the record keeps running after the read as a weightless log",
  decisionRule: { pass: "Mean excess vs SPY > 0 and t >= 1.699 at 30 closed picks. Earns: a second read at 60 picks against SMH, and only then any real-money discussion (operator's decision).", fail: "DID NOT PASS: the picks, as they can actually be followed, do not beat the index; the retrospective table was sector exposure and/or selective reporting." },
  readCondition: "node backend/payne-picks.js --read once 30 picks have closed.",
  expectation: "Uncertain. The retrospective table is genuinely strong but reads like sector beta in an AI/semiconductor boom; I expect the forward excess vs SPY to be positive but under the bar at 30 picks.",
  knownWeaknesses: [
    "Overlapping holding windows make picks correlated; the plain t overstates significance. The read reports it; a PASS at 30 is provisional until 60.",
    "Receipt delay: an alert forwarded hours late is executed hours late. That is the realistic cost of following by email, and it is measured, not corrected.",
    "Depends on the operator forwarding EVERY alert, losers included; a missed alert breaks the record. Each logged alert keeps its raw text.",
    "30 picks at ~4 a month is ~8 months.",
  ],
  ip: "Payne's Education alerts are paid content; the raw alert text stays in this repo and is never republished.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R159 Payne picks forward — registered", category: "registration", breaksComparability: false, change: `R159 registered before any pick exists: every Payne pick logged at receipt, mirrored on Alpaca paper, vs SPY; read at 30 closed picks, bar t >= ${BAR}.`, why: "Operator: 'measure paynes picks forward'.", doesNotEstablish: "Anything until picks arrive (requires the operator's subscription).", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R159"], detail: "Payne picks forward vs SPY" }) + "\n");
console.log(`R159 registered · read at 30 closed picks · bar t >= ${BAR}`);
