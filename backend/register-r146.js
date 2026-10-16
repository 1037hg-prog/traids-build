#!/usr/bin/env node
/** Registers R146 — do our option wings lose on underlyings already in a strong uptrend? 2026-09-22, operator: "test it".
 *  Filed after the empirical null (400 shuffles) and before the real read. Refuses if R146 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R146")) { console.error("R146 already exists — refusing"); process.exit(2); }
const nul = JSON.parse(fs.readFileSync(D("r146-empirical-null.json"), "utf8"));
reg.preregistered.push({
  id: "R146", name: "Option wings on hot underlyings — does our premium selling lose on stocks already trending hard?",
  registered: "2026-09-22", evidenceStart: "2026-07-31",
  evidenceNote: "Our own clean-era options book (538 signal tickets, 76 underlyings, 30 entry sessions). Registered after the empirical null and before the read. One read, sealed.",
  status: "REGISTERED 2026-09-22 — one read follows", script: "backend/r146-wings-vs-trend.js",
  parent: "Yahoo Finance 2026-09-22: Intel up 25% in five days, 314% in a year. Our only INTC tickets were option wings, net -1.11R. The question is whether that is a pattern: does the book systematically lose premium on underlyings that are already running?",
  multiplicityFamily: "WINGS-VS-TREND — 4 variants: trend measure {20-day return, price vs its 50-day average} x hot bucket {top 20%, top 10% within the session}.",
  rule: "For each clean-era Options signal ticket: compute the underlying's trend from daily closes UP TO THE PRIOR SESSION (ret20 = close(d-1)/close(d-21)-1; vsMa50 = close(d-1)/mean(close(d-50..d-1))-1). Within each entry session rank that session's tickets and call the top fraction 'hot'. Per session: mean rMult(hot) - mean rMult(rest). t across sessions with tickets on both sides. Ranking inside the session removes the market's own day.",
  statistic: "Session-clustered mean difference in rMult, hot minus rest. Unit: session. Dollars per ticket reported beside it.",
  bar: { fixedInAdvance: true, unit: "sessions", minSessions: 25, tRequired: nul.p95, twoSided: true, variants: 4,
    source: `EMPIRICAL null, not the formula: backend/r146-wings-vs-trend.js --nulls 400 shuffles the trend ranks within each session and takes the max |t| across the four variants. p95 = ${nul.p95} (median ${nul.median}, p99 ${nul.p99}, max ${nul.max}). lib/null-bar.js gives 2.393 for a best-of-4 at n=28, which UNDERSTATES this statistic: the hot bucket holds only 1-3 tickets a session and option R is heavy-tailed, so shuffled ranks reached |t| 3.29 in the first eight seeds.` },
  interimKill: "none — one read over a fixed sample",
  decisionRule: {
    pass: "|t| >= the empirical bar on a variant with >= 25 sessions and the same sign in both halves. A NEGATIVE gap establishes that wings on hot underlyings do worse, and routes to the operator as a candidate REFUSAL rule (do not sell premium on the session's hottest names), registered separately and traded by nobody until it clears. A POSITIVE gap is reported just as plainly.",
    fail: "Otherwise DID NOT PASS: the INTC case is an anecdote, not a pattern, on this sample.",
  },
  readCondition: "Immediately after registration: node backend/r146-wings-vs-trend.js.",
  expectation: "Genuinely uncertain, which is rare here. The mechanism is real (short premium on a trending name is short the trend), but 30 sessions and a hot bucket of 1-3 tickets is thin, and the empirical null shows this statistic throws |t| above 3 on shuffled data.",
  knownWeaknesses: [
    "SMALL BUCKETS: 53-105 hot tickets against 430-482 others across 28 sessions; a single wing can move a session's mean.",
    "R IS GROSS for non-options but options R carries its own denominator convention; dollars per ticket are reported beside it for that reason.",
    "ONE REGIME: 2026-07-31 to 2026-09-21 is a rising tape, which is exactly when short premium on hot names should hurt most.",
    "TREND MEASURED ON THE UNDERLYING, not on the option's own implied vol: a hot stock with rich premium is a different trade from a hot stock with cheap premium, and this test does not separate them.",
    "SURVIVORSHIP-FREE BUT SELECTION-BOUND: the population is whatever our board chose to trade, not all optionable names.",
  ],
  ip: "Ours entirely — our own book.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-22", area: "R146 wings vs trend — registered", category: "registration", breaksComparability: false, change: `R146 registered with an EMPIRICAL bar (|t| >= ${nul.p95} from 400 within-session rank shuffles) rather than the formula's 2.393, because the shuffles showed this statistic reaching |t| 3.29 by chance.`, why: "Operator: 'test it' after Intel's 25% week and our -1.11R of INTC wings.", doesNotEstablish: "Nothing yet; the read follows.", operator: "Josh 2026-09-22" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R146"], detail: `empirical bar ${nul.p95} from 400 shuffles` }) + "\n");
console.log("R146 registered · empirical bar", nul.p95);
