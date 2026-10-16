#!/usr/bin/env node
/** Registers R323 — "copy the Hyperliquid leaderboard" (operator 2026-10-03, after the Invo copy-trading app: "test it"). FORWARD only:
 *  a historical version would rank today's survivors. Built on backend/hyperliquid-whales-record.js (daily since 2026-09-24: the full
 *  leaderboard's pnl/roi windows + open positions of the 100 largest accounts). The recorder's snapshots so far have never been analysed
 *  for this; evidence still starts after registration. Refuses if R323 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f), TODAY = "2026-10-03", N = 90;
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R323")) { console.error("R323 exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 1, n: N, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R323", registered: TODAY,
  name: "Copy the Hyperliquid leaderboard — hold the net positions of the top-20 traders by trailing 30-day ROI, refreshed at each daily snapshot, vs random traders",
  status: `REGISTERED ${TODAY} — forward; evidence from the 2026-10-05 snapshot; builder assigned`, script: "backend/r323-hl-copy-leaders.js",
  parent: "Operator 2026-10-03 sent invoapp.com (Invo: one-tap copy trading of Hyperliquid leaderboard traders, 25-30x leverage, 'win streaks'), then 'test it'. Priors: R188/R211 (AlphaInsider leaderboards, luck-adjusted) DID NOT PASS — rankings were luck; R195 (Hyperliquid funding extremes) DID NOT PASS. Operator's 09-21 question: piggyback heavy-hitter crypto traders.",
  multiplicityFamily: "HL-COPY — R323 alone; one rule (top 20, 30-day ROI, daily refresh) fixed here; fade-the-leaders and other cuts reported only.",
  evidenceStart: "the first complete recorder snapshot on or after 2026-10-05 (UTC); snapshots dated earlier are excluded",
  rule: [
    "SNAPSHOT: each complete data/hyperliquid-whales/<UTC day>.json (leaderboard windows + clearinghouseState positions of the top 100 accounts by account value). Snapshot time = its recordedAt.",
    "LEADERS at snapshot s: among accounts WITH recorded positions in s and account value >= $1,000,000, the 20 with the highest month (30-day) ROI as published in s (ties by month pnl). Known at s by construction.",
    "COPY BOOK at s: for each coin, w_c = mean over the 20 leaders of sign(szi) x min(|positionValue| / accountValue, 1) (unlevered share of each leader's equity; a leader with no position in c contributes 0); then scale the book to gross exposure 1 (sum |w_c| = 1; flat if no positions).",
    "EXECUTION (quote-priced, no orders): the book is entered at the Hyperliquid mid price 60 minutes after recordedAt (the copy delay) and held until the next snapshot's entry time; per-coin returns from Hyperliquid public candles (perp mid/close), funding over the hold charged/credited at the published hourly funding rates on the book's side; COST 0.045% per side on turnover (Hyperliquid taker) plus 0.02% slippage.",
    "A snapshot day with no complete snapshot is a gap (no position, never back-filled).",
  ].join(" "),
  statistic: "Unit: SNAPSHOT INTERVAL (about one day; weekdays only while the recorder runs in the home close chain, every day once it runs on the droplet). Mean net copy-book return per interval; Newey-West t (lag 5). Win rate beside it.",
  unit: "snapshot intervals", nExpected: N,
  controls: {
    randomTraders: "the same procedure with 20 accounts drawn at random from the snapshot's position-recorded accounts that are NOT leaders (account value >= $1M), 500 draws per interval, same costs; the copy book's mean must beat the random-trader p95 — the luck test that sank R188/R211.",
    benchmarks: "BTC and ETH perp held long over the same intervals; an equal-weight long of the coins the leaders hold — reported.",
    fade: "the negative of the copy book (fade the leaders) — reported.",
    calibration: "whole-rule false-pass on >= 60 no-edge constructions (leader labels permuted among position-recorded accounts) must be <= 5% before the read, else the read is held for a dated pre-evidence amendment.",
  },
  bar: { fixedInAdvance: true, unit: "snapshot intervals", tRequired: BAR, variants: 1, statistic: "Newey-West t, lag 5 (calibrated by the runner)", source: `nullBar({variants:1, n:${N}}).p95 = ${BAR}` },
  interimKill: "At 45 intervals: NW t <= -2.0 -> stop (kill only).",
  decisionRule: {
    pass: `PASS only if >= ${N} intervals AND mean net > 0 AND NW t >= ${BAR} AND the random-trader p95 is beaten AND the mean beats BTC buy-and-hold over the same intervals. A PASS proposes a small paper copy sleeve (operator's call; perps/leverage and venue access are his decisions).`,
    fail: "DID NOT PASS: following Hyperliquid's leaderboard does not beat luck after costs and the copy delay; recorded and closed.",
    cannotMeasure: "CANNOT MEASURE if fewer than 60 complete snapshots exist by 2027-02-01, or Hyperliquid's public endpoints change so positions cannot be recorded.",
  },
  knownWeaknesses: [
    "Daily snapshots copy STANDING positions with up to a day's delay; Invo-style real-time copying of each trade is not tested (an hourly leader-position recorder on the droplet could test it later as a separate registration).",
    "Positions are recorded only for the 100 largest accounts by value, so leaders are chosen within that set, not the whole board.",
    "Unlevered copying: the leaders' 25-30x leverage is not replicated, by design (it would turn a measurement into a ruin test).",
    "Weekday-only snapshots until the recorder moves to the droplet; weekend moves fall inside Friday's interval.",
    "Quote-priced at mid plus a modelled cost; real fills on Hyperliquid or elsewhere would differ.",
  ],
  readCondition: `--read once at >= ${N} intervals after selftest and calibration.`,
  writerExists: false, writerNote: "runner built by a reviewed workflow 2026-10-03; it reads the existing recorder's files, adds Hyperliquid candles/funding (public), and runs in the close chain after the recorder",
  ip: "Ours: public on-chain data.",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R323 copy the Hyperliquid leaderboard (forward)", category: "registration", breaksComparability: false, change: `Registered R323 forward: top-20 by 30-day ROI among the recorder's position accounts (>= $1M), unlevered net book scaled to gross 1, entered 60 min after each daily snapshot, quote-priced with taker cost + funding; random-trader control; bar ${BAR} at ${N} intervals; interim kill at 45.`, why: "Operator 2026-10-03: 'test it' (Invo copy trading).", doesNotEstablish: "Any result.", operator: "Josh 2026-10-03" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R323"], family: "HL-COPY" }) + "\n");
console.log(`R323 registered · bar ${BAR} at ${N} intervals`);
