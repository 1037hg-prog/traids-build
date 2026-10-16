#!/usr/bin/env node
/** R152 pre-read amendment (2026-09-23): the statistic becomes a daily strategy-return series. Refuses twice or post-read. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R152");
if ((t.amendments || []).some((a) => a.id === "daily-series-2026-09-23")) { console.error("already amended"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R152 || fs.existsSync(D("r152-tv-top-strategies.json"))) { console.error("R152 already read — refusing"); process.exit(2); }
(t.amendments ||= []).push({ id: "daily-series-2026-09-23", date: "2026-09-23", preEvidence: true,
  what: "Statistic changed from 'per month, the mean net return of trades entered' to a STRATEGY RETURN SERIES: each trade contributes its daily position returns (entry -> daily closes -> exit, telescoping exactly to exit/entry; half the 0.10% round trip on the entry day, half on the exit day); a member's daily return is the mean across its open positions; its monthly return is the sum of its daily returns (0 in months with no position); t = Newey-West lag 1 across all 129 months 2016-01..2026-09. Floor, leak test (arithmetic drift-free) and positive control are computed on the same series. minMonths now counts months with any exposure. Bar unchanged.",
  why: "Controls v1 failed: on drift-free noise BBRSI-LONG (t 2.73, 2.41), MACD-STOCH (2.43, 3.36), STOCH-RSI (2.44, 2.61) and RSI-DIV (2.37) cleared t 2 and the drift-kept floors were absurd (+36.7%/month, -33.1%/month). These members signal rarely and hold for months to years; a per-trade mean treats a two-year hold and a two-day hold alike, so the statistic is dominated by holding length and extreme tails and its t is not reliable. A time-weighted return series is the standard statistic for a strategy and is well behaved on noise.",
  evidenceSeen: "Controls outputs on scrambled prices and the winners-only look-ahead subset only; no unfiltered real statistic." });
t.statistic = "Per member, a daily strategy-return series (amended 2026-09-23): mean return across open positions each day, summed per calendar month (0 without exposure); t = Newey-West lag 1 across the 129 months.";
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R152 amendment — daily strategy-return statistic", category: "amendment", breaksComparability: false, change: "Per-trade monthly mean replaced by a time-weighted daily return series.", why: "Long-hold members made the per-trade statistic heavy-tailed; noise cleared t 2.", operator: "assistant, disclosed to Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-read", test: "R152", detail: "daily strategy-return series" }) + "\n");
console.log("R152 amended (daily series), pre-read");
