#!/usr/bin/env node
/** Pre-evidence amendment to R280 (2026-09-28): the SPY monthly source moves from Alpha Vantage TIME_SERIES_MONTHLY_ADJUSTED to the
 *  local Yahoo feed (:3002 /api/yahoo/SPY/history interval=1mo, adjClose = dividend-adjusted month-end close, from 2003-07). Reason: the
 *  AV key hit its daily limit on the --selftest's first call; no R280 outcome had been computed. Refuses if R280 is sealed. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R280) { console.error("R280 sealed — amendments are illegal now"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const t = reg.preregistered.find((x) => x.id === "R280"); if (!t) { console.error("no R280"); process.exit(2); }
if ((t.amendments || []).some((a) => a.id === "spy-source-yahoo")) { console.log("already amended"); process.exit(0); }
t.rule[1] = "SPY monthly total return: local Yahoo feed (:3002 /api/yahoo/SPY/history, interval=1mo), dividend-adjusted month-end close (adjClose), month-end to month-end. Cash: FRED DTB3 monthly mean /12.";
(t.amendments = t.amendments || []).push({ id: "spy-source-yahoo", date: "2026-09-28", preEvidence: true, change: "SPY source AV TIME_SERIES_MONTHLY_ADJUSTED -> Yahoo 1mo adjClose via :3002", why: "AV daily limit reached before any R280 outcome was computed." });
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend", tests: ["R280"], detail: "pre-evidence: SPY source -> Yahoo 1mo" }) + "\n");
console.log("R280 amended (pre-evidence): SPY source -> Yahoo");
