#!/usr/bin/env node
/** Registers R144 — the Dow-leads-the-S&P lead-lag trade. 2026-09-22, operator: "register the lead-lag test".
 *  Filed after the two pipeline controls (leak test on scrambled prices, look-ahead positive control) and BEFORE the real run. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R144")) { console.error("R144 already exists — refusing"); process.exit(2); }
const synth = JSON.parse(fs.readFileSync(D("r144-synth-1.json"), "utf8")), peek = JSON.parse(fs.readFileSync(D("r144-peek.json"), "utf8"));
const grossOf = (o) => Object.fromEntries(Object.entries(o.variants).map(([k, v]) => [k, v.grossPerSignal]));
reg.preregistered.push({
  id: "R144", name: "Dow leads, S&P follows — does the laggard converge inside 10 minutes, after cost?",
  registered: "2026-09-22", evidenceStart: "2025-08-19",
  evidenceNote: "Historical, on the ES and YM 1-minute bars we hold (Massive, 2025-08-19..2026-09-22, ~272 sessions). Registered after both pipeline controls and before the real run. One read, sealed.",
  status: "REGISTERED 2026-09-22 — one historical read follows", script: "backend/r144-leadlag.js",
  parent: "Facebook reel by '20-Minute Trader' (operator sent it 2026-09-22): whiteboard shows the Dow moving, SPY not following within 2-4 minutes, and a circled BUY on the laggard. Tested on futures (YM, ES) rather than the ETFs, which is where that relationship is actually traded.",
  multiplicityFamily: "LEADLAG-ES-YM — 6 variants: lookback W in {2,3,4} minutes x gap G in {0.05%, 0.10%}.",
  rule: "On each completed 1-minute ES bar t between 09:32 and 15:45 ET: rY = YM(t)/YM(t-W)-1, rE = ES(t)/ES(t-W)-1. LONG ES if rY-rE >= G and rY > 0; SHORT ES if rY-rE <= -G and rY < 0. Entry at the open of bar t+1, exit at the close of bar t+10, one position at a time. netPts = (exit-entry) x direction - 0.75 ES points.",
  statistic: "Per session, the mean netPts over that session's signals; t across sessions with at least one signal. Unit: session.",
  bar: { fixedInAdvance: true, unit: "sessions", minSessions: 200, tRequired: 2.419, variants: 6, source: "lib/null-bar.js nullBar({variants:6, n:250, trials:50000}).p95 = 2.419" },
  controls: {
    leakTest: { done: "2026-09-22, before registration", method: "bar shapes shuffled within each day, INDEPENDENTLY per instrument, which destroys the cross-instrument relationship", grossPtsPerSignal: grossOf(synth), reading: "clean — gross per signal sits within +/-0.08 ES points of zero in all six variants; the only loss on noise is the cost we charge" },
    positiveControl: { done: "2026-09-22", method: "--peek: the same machinery fed YM's NEXT W minutes instead of its last W (look-ahead by design)", grossPtsPerSignal: grossOf(peek), reading: "lights up hard (net 1.9-3.6 pts per session, t 18-25), so the measurement CAN detect convergence when it exists. A null on the real run therefore means the market, not the instrument." },
  },
  interimKill: "none — one run over a fixed sample",
  decisionRule: {
    pass: "A variant with >= 200 sessions carrying signals, a positive mean, t >= 2.419, and both halves positive. It adopts NOTHING: a PASS earns a forward paper test at a futures venue, registered separately, because 1-minute entries are exactly where our measured costs bite.",
    fail: "Otherwise DID NOT PASS: the lead-lag convergence trade is closed on this sample, and no other lookback, gap, hold or instrument pair is to be run on it.",
  },
  readCondition: "Immediately after registration: node backend/r144-leadlag.js.",
  expectation: "I expect it not to pass. ES and YM are the two most arbitraged instruments in the world and the relationship is contested at microsecond scale; a gap that survives 2-4 minutes at 1-minute resolution is usually the data, not the market. The positive control exists so that a null cannot be blamed on the measurement.",
  knownWeaknesses: [
    "BAR CLOSES, NOT QUOTES: entries are taken at the next bar's open, which a retail order may not get on a fast move. The 0.75-point charge is a stand-in for that.",
    "ONE YEAR, ONE REGIME: ~272 sessions of a trending market.",
    "FRONT MONTH BY VOLUME: roll days can put a price discontinuity in either series.",
    "NO STOP: the rule holds a fixed 10 minutes. A stop would change the distribution, and choosing one after seeing the result is exactly what the family bar exists to prevent.",
    "THE REEL IS ABOUT SPY, NOT ES: futures are the cleaner test of the same relationship, but it is not literally his instrument, and the ETF version carries different costs.",
  ],
  ip: "Ours; a publicly posted idea measured on our own data.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-22", area: "R144 ES/YM lead-lag — registered", category: "registration", breaksComparability: false, change: "R144 registered after a scrambled-price leak test and a look-ahead positive control, before the real read: 6 variants, best-of-6 bar t >= 2.419.", why: "Operator: 'register the lead-lag test' after a reel claiming the Dow leads the S&P by 2-4 minutes.", doesNotEstablish: "Anything about the ETF version (SPY/DIA) or about the reel's own results.", operator: "Josh 2026-09-22" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R144"], detail: "ES/YM lead-lag, 6 variants, leak test + positive control recorded, expectation: not to pass" }) + "\n");
console.log("R144 registered");
