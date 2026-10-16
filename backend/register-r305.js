#!/usr/bin/env node
/** Registers R305 — R299's expiration-weekend effect in our own short-premium book (operator 2026-10-01: "yes" to "set up the R299 timing
 *  twin on the R21 wings"). No outcome has been computed: the only look at the marks before registration counted eligible wings per window
 *  (20 call / 13 put on 09-17 -> 09-21; 22 / 10 on 09-24 -> 09-28), never a price change. The marks start 2026-09-11, so the September pair
 *  has no control window; evidence starts with the October 2026 expiration. Bar = nullBar({variants:2, n:12}).p95. Refuses if the id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ID = "R305", TODAY = "2026-10-01", CELLS = 2, N = 12;
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === ID)) { console.error(`${ID} exists — refusing`); process.exit(2); }
const b = +nullBar({ variants: CELLS, n: N, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: ID, registered: TODAY, name: "R299 in our own book: do R21's short wings gain more over the monthly-expiration weekend than over the weekend before?",
  status: `REGISTERED ${TODAY} — forward from the 2026-10 expiration; writer live (close chain); no new trades`, script: "backend/r305-opex-wing-twin.js",
  parent: "R299 (sealed PASS 2026-10-01: short delta-hedged ATM next-month single-stock calls, Thu-before-expiration -> Mon-after, beat the same structure a week earlier by +27.3 bps, t 2.226 vs 2.05; refuters 2/3 not refuted; not tradeable alone at +1.6 bps net). Operator 2026-10-01 'yes' to testing it as timing for the R21 wings.",
  multiplicityFamily: "R299-TRANSFER — R305 alone; 2 cells (CALL wings, PUT wings), best-of-2.",
  evidenceStart: "2026-10 monthly expiration (Fri 2026-10-16; windows E 10-15 -> 10-19, C 10-08 -> 10-12)",
  rule: "Population: every R21 wing (live and R21 shadows) in data/wing-marks.jsonl. Window E = the last session before the monthly expiration (third Friday) close -> the first session after it close; window C = the same weekdays one week earlier (sessions found from the marks themselves, so a holiday shifts to the adjacent session). A wing enters a window if it has an RTH mark on both end dates and expires AFTER the window's end date. dR = (last RTH mid on the start date - last RTH mid on the end date) / spread width (strikes parsed from the OCC symbols); positive = the short wing gained. Per cell (CALL wings, PUT wings) and expiration: D = mean dR(E) - mean dR(C), only when each window has >= 5 wings of that cell. No orders, no new positions: it reads marks the book already records.",
  statistic: "Per cell: one-sample t of D over monthly expirations from 2026-10 (unit: expirations). Best-of-2 cells; positive direction only.",
  unit: "monthly expirations", nExpected: N,
  controls: { pairing: "window C (one week earlier, same weekdays) is the control inside every observation", liveOnly: "D on live wings only (shadows excluded) reported beside", counts: "wings per window per cell reported" },
  bar: { fixedInAdvance: true, unit: "monthly expirations", tRequired: b, variants: CELLS, source: `nullBar({variants:${CELLS}, n:${N}, trials:20000}).p95 = ${b}` },
  interimKill: "none (observation only; it trades nothing)",
  decisionRule: {
    pass: "PASS if either cell's t >= bar with a positive mean over the first 12 expirations. Proposes an R21 timing rule (favour holding short wings across the monthly-expiration weekend) as a registered OP proposal — the operator's call; nothing changes in the sleeve automatically.",
    fail: "DID NOT PASS: R299's effect does not show in the wings we sell; R299 stays a single-stock finding with no use in this book.",
  },
  knownWeaknesses: [
    "Slow: one observation per month, so the read is about September 2027.",
    "R299 measured ATM next-month delta-hedged calls; R21 sells un-hedged 25-delta weekly verticals, so the dR also carries the underlying's weekend move. Pairing against the prior weekend removes the average weekend effect but not this weekend's market move; that is noise, not bias.",
    "Composition differs between E and C (different wings are open each week); it is the same program's book, not the same positions.",
    "Mid marks, not fills; the cost of acting on a timing rule is not in this statistic.",
    "If R21 stops opening wings (the 2026-09-30 audit noted R21-v1 is past its 400-wing entry stop), the windows starve below 5 wings and the test stalls; the output shows wings per window.",
  ],
  readCondition: "--read once at 12 measured expirations per cell; seals in read-seals.json.",
  writerExists: true, writerNote: "backend/r305-opex-wing-twin.js written and selftested 2026-10-01 (5 known answers); nightly in the close chain; first row written at registration (0 expirations).",
  ip: "ours (R299 is public research; R21 is ours)",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R305 R299 transfer to the R21 wings", category: "registration", breaksComparability: false, change: `Registered R305 forward from the 2026-10 expiration: expiration-weekend minus prior-weekend gain of R21 short wings (wing marks, no trades), CALL/PUT cells, best-of-2 bar ${b} over 12 expirations. Writer backend/r305-opex-wing-twin.js in the close chain.`, why: "Operator 2026-10-01: 'yes'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-01" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "register", tests: [ID], family: "R299-TRANSFER" }) + "\n");
console.log(`${ID} registered · bar ${b} (expirations, best-of-${CELLS}) · ${reg.preregistered.length} preregistered`);
