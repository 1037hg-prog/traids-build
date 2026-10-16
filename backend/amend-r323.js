#!/usr/bin/env node
/** R323 pre-evidence amendment (2026-10-04; first evidence snapshot = the 2026-10-05 recorder run). Two fixes found by the 2026-10-03
 *  build/review/repair round, both the registrar's design errors:
 *   1. LUCK GATE: the registered random-trader p95 did not hold the copy book's concentration or direction (a two-coin no-skill book beat it
 *      ~40% of the time); replaced by the COIN-RELABEL p95 (the copy book's own weights and signs on random coins of the held universe,
 *      500 persistent draws, same costs); random traders reported only. Calibration: coin-relabel pseudo-book, whole rule 5.8% on the
 *      pre-evidence practice run (noise around 5%); the evidence-mode calibration must be <= 5% before the read.
 *   2. LEADERS: ranked by 30-day DOLLAR pnl (the leaderboard default), ties by 30-day ROI — month ROI among >= $1M accounts ran 1x..41,864x
 *      (deposits, not skill), and the recorder now records positions for the top 100 by 30-day pnl (>= $1M) as well as the 100 largest.
 *  Also: the read grades the FIRST 90 intervals only, once. Refuses if R323 is sealed or already amended. No R323 statistic computed. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R323"); if (!t) throw new Error("no R323");
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {}).R323) throw new Error("R323 sealed");
if ((t.amendments || []).some((a) => a.luckGate)) throw new Error("already amended");
if (fs.existsSync(D("r323-ledger.jsonl")) && fs.readFileSync(D("r323-ledger.jsonl"), "utf8").trim()) throw new Error("ledger has rows — evidence may have begun");
const now = new Date().toISOString(); if (now >= "2026-10-05T19:00:00Z") throw new Error("too close to / after the first evidence snapshot — not pre-evidence");
const was = { rule: t.rule, randomTraders: t.controls.randomTraders, calibration: t.controls.calibration, pass: t.decisionRule.pass };
t.rule = t.rule.replace("the 20 with the highest month (30-day) ROI as published in s (ties by month pnl)", "the 20 with the highest 30-day DOLLAR pnl as published in s (ties by 30-day ROI) [AMENDED 2026-10-04, pre-evidence: was month ROI]");
if (t.rule === was.rule) throw new Error("rule text pattern not found");
t.controls.luckGate = "AMENDED 2026-10-04 (pre-evidence): COIN RELABEL — 500 persistent draws per interval: the copy book's own weights and signs placed on random distinct coins of the snapshot's held universe (BTC, ETH and every coin an eligible account holds), same entry/exit/costs/funding; the copy book's mean must beat the relabel p95. Holds the book's concentration and direction (the house rule: a null must hold direction).";
t.controls.randomTraders = "REPORTED ONLY (amended 2026-10-04): " + was.randomTraders;
t.controls.calibration = "AMENDED 2026-10-04: whole-rule false pass on the coin-relabel pseudo-book construction (each relabel draw graded against the other 499) over the FIRST 90 evidence intervals must be <= 5% before the read, else the read is held.";
t.decisionRule.pass = t.decisionRule.pass.replace("the random-trader p95 is beaten", "the COIN-RELABEL p95 is beaten (amended 2026-10-04)") + " The read grades the FIRST 90 intervals only, once.";
(t.amendments ||= []).push({ date: "2026-10-04", at: now, preEvidence: true, by: "assistant (registrar's design fix; operator's 'test it' 2026-10-03)", luckGate: "coin-relabel-p95", calibration: "coin-relabel-pseudo-book-v1", leaders: "month-pnl",
  field: "rule (LEADERS) / controls.randomTraders / controls.luckGate / controls.calibration / decisionRule.pass", was,
  why: "R323 review 2026-10-03: (1) the registered random-trader p95 is not a luck test for the concentrated book this rule produces — on the real 10-02 books a no-skill two-coin book beat it on ~40% of synthetic paths (whole rule 4-10%); the coin-relabel p95 alone is ~5%; (2) 'top 20 by month ROI' collapsed to 2 whale accounts because positions were recorded only for the 100 largest accounts, and month ROI among >= $1M accounts ran 1x..41,864x (deposits). Fix: rank by 30-day dollar pnl and record those accounts' positions (recorder patched 2026-10-04). No R323 statistic has been computed; evidence starts with the 2026-10-05 snapshot.",
  files: "backend/r323-hl-copy-leaders.js (leadersOf by month pnl; backup docs/r323/r323-hl-copy-leaders.pre-pnlrank.js); backend/hyperliquid-whales-record.js (positions for the top 100 by 30-day pnl >= $1M; backup docs/r323/hyperliquid-whales-record.pre-pnlpositions.js)" });
t.status = "REGISTERED 2026-10-03 (pre-evidence amendment 2026-10-04: coin-relabel luck gate, leaders by 30-day pnl) — forward; evidence from the 2026-10-05 snapshot; runner built and reviewed"; t.writerExists = true;
reg.asOf = now; writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-10-04", area: "registry — R323 pre-evidence amendment + recorder change", category: "registration", breaksComparability: false, change: "R323: luck gate random-trader p95 -> coin-relabel p95 (random traders reported); leaders ranked by 30-day dollar pnl (was ROI, distorted by deposits); read grades the first 90 intervals once. hyperliquid-whales-record.js additionally records positions for the top 100 by 30-day pnl (>= $1M) — additive; positionsRule field added.", why: "R323 build/review 2026-10-03 found both defects before any evidence; operator 2026-10-03 'test it'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-03" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: now, kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-evidence", tests: ["R323"], detail: "coin-relabel luck gate; leaders by 30-day pnl; recorder records pnl leaders' positions" }) + "\n");
console.log("R323 amended (pre-evidence) at", now);
