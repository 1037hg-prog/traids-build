#!/usr/bin/env node
/** Registers R274 — OPPORTUNISTIC insider purchases (Cohen, Malloy & Pomorski 2012, "Decoding Inside Information", J. Finance).
 *  Operator 2026-09-27: "test the insider buying signal ourselves". R137 (cluster buys, 2019-2025) is SEALED DID NOT PASS and its seal
 *  forbids variants of the CLUSTER rule on that sample; this is a different published mechanism (the insider's own trading-calendar
 *  history), so it is registered as a new member of the insider family with a best-of-2 bar that counts R137. Written before any
 *  signal list or price was built. Refuses if R274 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R274")) { console.error("R274 exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 2, n: 48, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R274", name: "Opportunistic insider purchases (Cohen-Malloy-Pomorski) — do open-market buys by insiders who break their own trading calendar beat small caps the next month?",
  registered: "2026-09-27", evidenceStart: "2022-01-01", status: "REGISTERED 2026-09-27 — historical, read once; backend/r274-insider-opportunistic.js (--signals outcome-free, then --read)", script: "backend/r274-insider-opportunistic.js",
  parent: "Operator 2026-09-27 after the Seeking Alpha review (Insiders Forum / Insider Idea Engine): test insider buying ourselves. Source paper: Cohen, Malloy & Pomorski (2012).",
  multiplicityFamily: "INSIDER-1 — R137 (cluster buys, sealed DID NOT PASS) + R274; best-of-2 bar.",
  rule: [
    "Data: SEC Form 3/4/5 bulk data sets data/sec-insider/2019q1..2025q4 (already on disk). Original Form 4 only; reporting owner an Officer or Director; non-derivative common/ordinary stock rows.",
    "Insider trades for CLASSIFICATION: open-market purchases (P, acquired) and sales (S, disposed), price and shares > 0, any issuer, keyed by reporting-owner CIK, dated by TRANSACTION date.",
    "Classification at the start of calendar year Y (Y = 2022..2025): an insider is CLASSIFIABLE if they have >= 1 classification trade in EACH of Y-3, Y-2, Y-1. ROUTINE if some calendar month contains a trade in all three of those years; otherwise OPPORTUNISTIC. Unclassifiable insiders are excluded (as in the paper).",
    "SIGNAL: a filing (Form 4, filed in month m of year Y) by an OPPORTUNISTIC insider containing open-market purchases (P) totalling >= $10,000 at that issuer. Stock s is in month m's opportunistic-buy list if >= 1 such filing.",
    "TRADE: equal-weight every listed stock; buy at the OPEN of the first trading day of month m+1, sell at the CLOSE of its last trading day. Alpaca SIP daily bars, adjustment=all. 20 bps round trip charged per name per month. Signal months 2022-01..2025-11.",
  ],
  statistic: "Monthly portfolio return minus IWM (small-cap benchmark) over the same open-to-close window; one-sample t over months. Raw portfolio return reported first.",
  controls: { timing: "Month-shuffled baseline: the same tickers assigned random months within 2022-01..2025-11 (1,000 draws), same per-month counts — captures the universe's own small/micro-cap drift. PASS needs t >= bar AND mean excess above the shuffle p95.", paperControl: "ROUTINE-insider purchase portfolio built the same way, reported beside (CMP's own contrast; not graded)." },
  bar: { fixedInAdvance: true, unit: "months", tRequired: BAR, variants: 2, source: `nullBar({variants:2, n:48, trials:20000}).p95 = ${BAR}` },
  minimumSample: "If fewer than 36 signal months each hold >= 5 priced names, the verdict is INCONCLUSIVE (underpowered), not a pass or fail.",
  secondary: "SPY-relative excess; opportunistic SALES portfolio (short side, reported); all-insider purchases; penalised lens counting names with no price history as -30%.",
  interimKill: "none (single historical read)", readCondition: "read once after --signals has written the outcome-free list.",
  decisionRule: { pass: "Candidate forward test from the live EDGAR feed (insider-edgar.js) — registration and any sizing are the operator's call.", fail: "Insider buying closed for public Form 4 data (R137 + R274)." },
  expectation: "LOW-MED: the paper's effect (~0.8%/month value-weighted, 1986-2007) is well known and may have decayed; the 3-year history requirement leaves only 2022-2025 in our data.",
  knownWeaknesses: ["Only 4 signal years (2022-2025), because classification needs 3 prior years and our bulk files start in 2019.", "Equal-weight and micro-cap heavy; the paper's headline was value-weighted.", "Alpaca lacks bars for many delisted names (survivorship flatters the primary; the penalised lens shows the other bound).", "Insiders identified by CIK; multi-issuer insiders pool their trades as in the paper."],
  ip: "ours (public data, published method)", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-27", area: "R274 opportunistic insider purchases — registered", category: "registration", breaksComparability: false, change: `Cohen-Malloy-Pomorski routine/opportunistic split on SEC Form 4 bulk data, signals 2022-2025, next-month vs IWM, bar ${BAR} (family INSIDER-1 incl. R137)`, why: "Operator: test insider buying ourselves.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-27" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R274"], detail: `opportunistic insider buys, bar ${BAR}` }) + "\n");
console.log(`R274 registered · bar ${BAR}`);
