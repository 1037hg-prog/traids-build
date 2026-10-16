#!/usr/bin/env node
/** Registers R140 — opening-range breakout on NQ. 2026-09-21, operator: "test the opening range breakout on nq". Refuses if R140 exists.
 *  Registered AFTER the leak test on scrambled sessions (no real row read) and BEFORE the one real run. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R140")) { console.error("R140 already exists — refusing"); process.exit(2); }
const synth = [1, 2, 3].map((s) => JSON.parse(fs.readFileSync(D(`r140-orb-nq-synth-${s}.json`), "utf8")));
const noiseFloor = Object.fromEntries(Object.keys(synth[0].variants).map((k) => [k, +(synth.reduce((a, s) => a + s.variants[k].grossMeanPtsPerTrade, 0) / 3).toFixed(2)]));
const entry = {
  id: "R140",
  name: "Opening-range breakout on NQ — six fixed variants, one historical read",
  registered: "2026-09-21",
  evidenceStart: "2025-08-19",
  evidenceNote: "A historical test on the full NQ 1-minute sample we hold (Massive, 2025-08-19..2026-09-21, ~270 sessions). Registered before any real row was read; the leak test on scrambled sessions ran first. One read, sealed.",
  status: "REGISTERED 2026-09-21 — one historical read on real bars follows immediately",
  script: "backend/r140-orb-nq.js",
  parent: "R139 (ares forward) — the profile of ares' record: entries concentrated 09:30-10:30 ET, same-day exits, 36% winners, wins ~2.6x losses.",
  multiplicityFamily: "ORB-NQ — six variants: opening range 5 / 15 / 30 minutes x stop at the opposite side / the range midpoint. All six are run and the bar is best-of-6.",
  rule: "Opening range = high/low of NQ 1-minute bars 09:30 to 09:30+L ET. Signal = the FIRST 1-minute bar after the range whose close is beyond the range (long above the high, short below the low), bar starting before 12:00 ET; one trade per session. Entry at the OPEN of the next bar. Stop at the opposite side of the range or the midpoint, checked from the entry bar; exit at the stop (or that bar's open if it opened beyond). Otherwise exit at the last regular-session close. netPts = points x direction - 0.75 pt.",
  statistic: "Mean netPts per SESSION (a session with no signal counts 0), t across sessions. Unit: session.",
  bar: { fixedInAdvance: true, unit: "sessions", minSessions: 200, tRequired: 2.399, variants: 6, source: "lib/null-bar.js nullBar({variants:6, n:270, trials:20000}).p95 = 2.399" },
  leakTest: { done: "2026-09-21, before registration", method: "same pipeline on bar-shuffled sessions (each bar's shape vs the prior close kept, order shuffled within the session), seeds 1, 2, 3", result: "no variant shows a positive edge on noise; every variant-seed is negative", noiseFloorGrossPtsPerTrade: noiseFloor, note: "The pipeline carries a NEGATIVE bias on noise (about -2 to -12 gross pts per trade by variant). It cannot manufacture a false positive in the pass direction; the read must report each real variant beside its noise floor." },
  interimKill: "none — one run over a fixed sample",
  decisionRule: {
    pass: "Some variant has mean netPts per session > 0 with t >= 2.399 over >= 200 sessions, AND that variant's mean is still > 0 with one extra tick (0.25 pt) each side charged, AND its mean is > 0 in BOTH halves of the sample by date. A PASS adopts NOTHING: it earns a forward paper test on NQ/MNQ at a futures-capable venue, registered separately; funding, size and venue are the operator's.",
    fail: "Otherwise DID NOT PASS: the plain opening-range breakout is closed on this sample and no other variant (other range lengths, cutoffs, targets, filters) is to be run on it.",
  },
  readCondition: "Immediately after registration: node backend/r140-orb-nq.js (refuses unless R140 is registered).",
  knownWeaknesses: [
    "ONE YEAR: ~270 sessions of one regime (a strong Nasdaq uptrend with sharp corrections). An ORB can pass or fail on a single trend year.",
    "MOTIVATED BY A WINNER: the rule family was chosen because ares, a leaderboard survivor, trades this way. That is why the bar is best-of-6 and the halves must agree.",
    "FRONT MONTH BY VOLUME: bars are stitched to the most-traded NQ contract per day; roll days can carry a price discontinuity that is not a trade.",
    "BAR RESOLUTION: stops are filled at the stop price when a 1-minute bar trades through it; real fills on fast moves are worse. The extra-tick condition only partly covers this.",
    "SIZE IGNORED: one contract per trade; risk per trade varies with the range width, unlike ares' fixed 1% risk.",
  ],
  ip: "Our own rule, built from public knowledge of opening-range breakouts; ares' rules are not known and not used.",
  writerExists: true,
};
reg.preregistered.push(entry); reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-21", area: "R140 ORB on NQ — registered", category: "registration", breaksComparability: false, change: "R140 registered after the scrambled-session leak test and before the real read: six ORB variants on NQ 1-minute bars, best-of-6 bar t >= 2.399.", why: "Operator: 'test the opening range breakout on nq' — ares' record profile looks like a morning breakout.", doesNotEstablish: "Anything about ares' own rules.", operator: "Josh 2026-09-21" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R140"], detail: "ORB-NQ six variants, best-of-6 t>=2.399, leak test first" }) + "\n");
console.log("R140 registered · noise floor", JSON.stringify(noiseFloor));
