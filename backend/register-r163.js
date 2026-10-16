#!/usr/bin/env node
/** Registers R163 — six published intraday patterns on 30-minute bars, discovery 2017-2021, sealed holdout 2022-2026. 2026-09-23,
 *  operator's ordered list item #3. Filed BEFORE any control or statistic. Refuses if R163 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R163")) { console.error("R163 already exists — refusing"); process.exit(2); }
reg.preregistered.push({ id: "R163", name: "Published intraday patterns (6) — 30-minute bars, 100 liquid names + 15 ETFs, discovery 2017-2021, sealed holdout 2022-2026",
  registered: "2026-09-23", evidenceStart: "2017-01 (discovery); 2022-01 (holdout, sealed)", status: "REGISTERED 2026-09-23 — controls, discovery, one holdout read", script: "backend/r163-intraday.js",
  evidenceNote: "Historical. Alpaca SIP 30-minute bars (regular hours) from 2016 — intraday history reaches back far further than the 1-minute limit assumed earlier. Registered before any statistic.",
  parent: "Operator's ordered plan item #3 (intraday patterns).", multiplicityFamily: "INTRADAY-6 at discovery (screen mean > 0, t >= 1.5); holdout family = k carried, best-of-k NW bar sealed at discovery.",
  rule: "INTRAMOM (Gao-Han-Li-Zhou), INTRAMOM_SPY (the paper's own), ORB30, VWAPREV (0.5% from VWAP at 11:30), GAPFADE (|gap| > 1%), PERIODICITY (Heston-Korajczyk-Sadka, 5-session lookback, quintiles) — exact definitions in the script header. Cost 0.05% per round trip per position.",
  statistic: "Per session mean net return across positions; Newey-West t lag 5.", bar: { fixedInAdvance: true, unit: "sessions", discoveryScreen: "net mean > 0 AND NW t >= 1.5", holdout: "net mean > 0, NW t >= best-of-k, both halves positive", tRequired: "sealed at discovery" },
  controls: { leakTest: "shuffled-session outcomes: every pattern |gross t| < 2", positiveControl: "position = sign(outcome): gross t >= 5" }, interimKill: "none",
  decisionRule: { pass: "A clearing pattern earns a forward paper test on Alpaca (intraday orders) — nothing traded on a backtest.", fail: "DID NOT PASS: the published intraday patterns do not survive 2022-2026 net of a 5 bp round trip in liquid US names." },
  readCondition: "--controls, --discovery, --holdout once.", expectation: "I expect INTRAMOM on SPY to be the likeliest survivor (it is the best-documented) and PERIODICITY to be wiped out by cost; most gap/ORB/VWAP rules fail.",
  knownWeaknesses: ["Universe is today's 100 most-traded names (survivor) + ETFs; time-series intraday effects are less exposed to survivorship than cross-sectional ones.", "30-minute granularity: entries/exits at half-hour boundaries, not the exact published minute.", "Cost 5 bps round trip is optimistic for mid caps and pessimistic for SPY."], writerExists: true });
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8")); cr.push({ date: "2026-09-23", area: "R163 intraday patterns — registered", category: "registration", breaksComparability: false, change: "R163 registered before any statistic: 6 intraday patterns on 30-minute bars, discovery 2017-21, sealed holdout 2022-26.", why: "Operator's ordered plan, item #3.", doesNotEstablish: "Anything at 1-minute resolution.", operator: "Josh 2026-09-23" }); writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R163"], detail: "intraday x6" }) + "\n");
console.log("R163 registered");
