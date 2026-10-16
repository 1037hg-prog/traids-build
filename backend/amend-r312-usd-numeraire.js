#!/usr/bin/env node
/**
 * R312 — dated PRE-EVIDENCE amendment (2026-10-11): record the pre-read decision the runner has been holding for since 2026-10-02
 * (backend/data/r312-controls.json: "the return numeraire is undecided"). The registered formula for a SHORT-foreign month,
 * F/S1 - 1, is the long-USD return measured in the FOREIGN currency; it exceeds what a short 6E / 6B / 6S future earns in USD by
 * (1 - x)^2 / x every month. The test's own claim is "what an FX forward/future earns" for a dollar account, so the return is
 * taken in USD: short foreign = 1 - S1/F, long foreign unchanged (S1/F - 1). The two companion tokens are the review's proposed
 * set of 2026-10-02 and were calibrated outcome-blind by the runner (scrambles and nulls only; no real statistic has been printed:
 * its dry read is on a scramble, and data/r312-read.json does not exist).
 * runnerGates: ["return:usd-numeraire", "placebo:same-cost", "leak:registered-else-uip-null"] — the runner reads these tokens.
 *   node backend/amend-r312-usd-numeraire.js --dry     prints the amendment, writes nothing
 *   node backend/amend-r312-usd-numeraire.js           writes it (refused 13:50-15:50 MT on a trading day)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), DRY = process.argv.includes("--dry"), KEY = "return-usd-numeraire-2026-10-11";
const extra = process.argv.slice(2).filter((a) => a !== "--dry"); if (extra.length) { console.error(`REFUSED: unknown argument ${extra[0]}`); process.exit(2); }
const P = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const today = `${P.year}-${P.month}-${P.day}`, hm = `${P.hour === "24" ? "00" : P.hour}:${P.minute}`, weekend = P.weekday === "Sat" || P.weekday === "Sun";
if (today !== "2026-10-11") { console.error(`REFUSED: this amendment is dated 2026-10-11 and today is ${today} MT`); process.exit(2); }
if (!DRY && !weekend && hm >= "13:50" && hm < "15:50") { console.error(`REFUSED: ${hm} MT is inside the close chain's registry window`); process.exit(2); }
if (fs.readdirSync(path.join(__dirname, "data")).some((f) => /^r312-read/i.test(f))) { console.error("REFUSED: an r312-read* file exists — not pre-evidence"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {}).R312) { console.error("REFUSED: R312 is sealed"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R312");
if (!t) { console.error("REFUSED: no R312"); process.exit(2); }
if ((t.amendments || []).some((a) => a.key === KEY || (a.runnerGates || []).length)) { console.error("REFUSED: R312 already carries a runnerGates amendment"); process.exit(2); }
const snapshot = JSON.stringify(t);
const amendment = {
  date: "2026-10-11", key: KEY, preEvidence: true,
  field: "rule: the RETURN of a short-foreign month; controls: the placebo's cost and the leak precondition",
  was: "short foreign (long USD) = (S[m-1]/S[m]) x (1 + rUS/1200) / (1 + rF/1200) - 1, i.e. F/S1 - 1: the long-USD return measured in the FOREIGN currency; placebo = random direction at its own turnover cost; leak precondition = the registered shuffle alone",
  becomes: "return:usd-numeraire — short foreign = 1 - S1/F, the USD profit per USD of notional that a short 6E / 6B / 6S future earns; long foreign unchanged (S1/F - 1); the 12-month trend filter compounds these returns. placebo:same-cost — the random-direction placebo is charged the OBSERVED cost series, so it differs from the rule in direction only; the observed mean must exceed its 95th percentile. leak:registered-else-uip-null — the read precondition is the registered leak test (|t| < 2); if it fails while the no-edge-null leak test (seed 1, the USD-fair null) passes, that is the registered shuffle's known construction bias and the read proceeds; if both fail the read is held for code review.",
  why: "The registered short-side formula overstates every short month by (1 - x)^2 / x relative to the USD result of the futures position the test says it measures; the operator's account is in dollars. The same-cost placebo isolates the one thing the rule claims (direction). The registered shuffle keeps the real rate income, so its t centres near +0.5 with no premium at all: it measures carry, not a leak. Outcome-blind calibration by the runner under this set (2026-10-11 controls run): whole-rule false pass 0.3% (permutation), 0.8% (with replacement), 1.5% (sign-flip) against a 7.5% tolerance; registered leak t 1.098, USD-fair leak t -0.954, positive control passes.",
  unchanged: ["data sources and fills", "the three currencies and the pool", "direction and dead zone, the 12-month trend filter and its timing", "cost", "the bar 1.682 (the stricter registry value stands; the seeded recomputation gives 1.665)", "the statistic (Newey-West t, lag 1, months)", "the decision rule and the forward futures record"],
  disclosed: "UNDER-POWERED, known before the read: a carry premium equal to the rate gap passes this rule on about 9-14% of simulated histories, so a DID NOT PASS cannot tell 'no premium' from 'premium too small for 26 years of three correlated legs'. The read is taken anyway because it is registered; the verdict will say this.",
  runnerGates: ["return:usd-numeraire", "placebo:same-cost", "leak:registered-else-uip-null"],
  recordedBy: "assistant (main loop), recording the 2026-10-02 review's proposed set; operator's standing instruction 2026-09-26 to decide research-process choices and report them; no real statistic seen",
};
if (DRY) { console.log(JSON.stringify(amendment, null, 1)); console.log("\nDRY — nothing written"); process.exit(0); }
const reg2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t2 = reg2.preregistered.find((x) => x.id === "R312");
if (JSON.stringify(t2) !== snapshot) { console.error("REFUSED: R312 changed between read and write"); process.exit(2); }
(t2.amendments = t2.amendments || []).push(amendment);
t2.status = `${String(t2.status)} (pre-evidence amendments: 2026-10-11 return-usd-numeraire)`;
reg2.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg2);
const c = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
c.push({ id: "r312-amend-return-usd-numeraire-2026-10-11", date: "2026-10-11", recordedAt: Date.now(), area: "registry — R312 US-vs-Europe rate carry (pre-evidence amendment: USD-numeraire return, same-cost placebo, leak precondition)", category: "registration", breaksComparability: false, change: amendment.becomes, why: amendment.why });
writeJsonAtomic(D("change-registry.json"), c);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-evidence", tests: ["R312"], key: KEY, runnerGates: amendment.runnerGates }) + "\n");
console.log(`R312 amended (pre-evidence) ${KEY}; status: ${String(t2.status).slice(0, 200)}`);
