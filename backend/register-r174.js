#!/usr/bin/env node
/** Registers R174 — correlation-aware sizing as a SEALED TWIN. 2026-09-24, operator: "go on 1". Weightless preview (1,767 signals, 47
 *  point-in-time fits): daily P&L sd -36..-42%, worst drawdown -20%, stop tail -10.5% (only in line with gross risk -13%), but total
 *  P&L -$8.7k vs flat — nearly all of it the 08-21 crypto basket. Stamped at every entry (obs.entryML.corrShadow), graded, not applied. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R174")) { console.error("R174 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 1, n: 30, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R174", name: "Correlation sizing twin — shrink a ticket by its crowding against the open book (shadow multiplier vs flat)",
  registered: "2026-09-24", evidenceStart: "2026-09-25",
  evidenceNote: "Forward, shadow. backend/corr-factors-fit.js (nightly) fits a 10-factor PCA of 60-day daily returns (1,057 names: equities SIP, crypto Coinbase 16:00 ET, FX/futures via ETF proxies); lib/corr-size.js: crowding = sum over open signal tickets with |rho| > 0.3 of rho x dir_p x dir_j x risk_j/risk_p; mult = clamp(1/sqrt(1+max(0,crowding)), 0.5, 1). The builder chose |rho| over the sketch's rho > 0.3 (opposite-direction trades on negatively correlated names are the same bet); disclosed, near-identical preview. Weightless preview (point-in-time fits): daily P&L sd -36% by close date / -42% by open date, worst drawdown -$18.9k -> -$15.0k, stop tail -10.5%, total P&L +$517 -> -$8,202 (crypto +$12.2k -> +$1.0k; all other classes together about +$2.5k better).",
  status: "REGISTERED 2026-09-24 — shadow; the multiplier is stamped at entry, never applied", script: "backend/corr-factors-fit.js + backend/lib/corr-size.js; stamped by backend/lib/entry-ml.js (config corr: \"shadow\")",
  parent: "Operator 2026-09-24: 'go on 1-3' (item 1: correlation-aware caps — 81% of the stop tail was correlated exposure).",
  multiplicityFamily: "SIZE-TWIN-2 (single rule)",
  rule: "For each clean-era SIGNAL ticket opened on/after 2026-09-25 with obs.entryML.corrShadow finite: twin dollars = pnl x corrShadow (it only shrinks, so the twin book is smaller by design — no renormalisation).",
  statistic: "Primary: per entry session, twin P&L / twin 1R budget minus flat P&L / flat 1R budget (return on risk, so shrinking alone cannot win); t over sessions. Secondary (reported, and must hold for a pass): twin session-P&L sd / flat session-P&L sd < 0.8.",
  bar: { fixedInAdvance: true, unit: "entry sessions", minSessions: 30, tRequired: BAR, variants: 1, statistic: "t over sessions on return-on-risk difference, plus sd ratio < 0.8", source: `backend/lib/null-bar.js nullBar({variants:1, n:30, trials:20000}).p95 = ${BAR}, computed 2026-09-24 in register-r174.js` },
  interimKill: "none (shadow)",
  decisionRule: { pass: "Memo to the operator: apply it (config corr: true), with an options-contract floor. His decision.", fail: "If the sd ratio holds but return-on-risk does not, the memo says so plainly: it is variance control that costs return — applying it is the operator's call on risk appetite, not a measured edge." },
  readCondition: "30 entry sessions (~early November 2026); reader r174-read.js built before the read.",
  expectation: "I expect the secondary (variance) to hold and the primary to be near zero: the preview's cost came from one crypto basket that won.",
  knownWeaknesses: ["The first ticket into a crowded group always gets full size, so a basket's first shock is never shrunk.", "Crowding counts peers at their shadow-shrunk risk in the preview but at their actual (unshrunk) risk live while the twin is shadow — the live stamp overstates crowding relative to an applied book.", "Options spreads cannot be sized fractionally; the twin's x0.7 on a 2-lot is not executable.", "10 alt coins, NZD pairs and 3 futures are not in the fit and always get 1.", "Adjusted prices (adjustment=all) in the fit; negligible for daily-return correlation."],
  ip: "none", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R174 correlation sizing twin — registered (shadow)", category: "registration", breaksComparability: false, change: `corr-factors-fit.js nightly + lib/corr-size.js; entry-ml config corr: "shadow" stamps obs.entryML.corrShadow at entry, applies nothing. Bar ${BAR}.`, why: "Operator 2026-09-24: 'go on 1-3'. Preview: variance -36..-42%, P&L -$8.7k (one crypto basket), so shadow not live.", doesNotEstablish: "Any benefit — weightless preview.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
const cfg = JSON.parse(fs.readFileSync(D("entry-ml-config.json"), "utf8")); cfg.corr = "shadow"; cfg.note += " | 2026-09-24: corr -> shadow (R174)."; writeJsonAtomic(D("entry-ml-config.json"), cfg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R174"], detail: `corr sizing twin (shadow), bar ${BAR}` }) + "\n");
console.log(`R174 registered · bar ${BAR}; entry-ml corr -> shadow`);
