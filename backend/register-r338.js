#!/usr/bin/env node
/** Registers R338 — the Treasury auction cycle on the FULL tenor ladder. Operator 2026-10-07: "register it".
 *  Written BEFORE any auction or ETF data for the gated population was fetched (no TreasuryDirect pull, no Schwab pull).
 *  Origin: the 2026-10-07 ensemble read — Plan E's risk is two bets (TSY overlay 51.1% of variance, crypto 25.6%), nothing in
 *  99 library streams hedges its worst days, and the only cleared streams orthogonal to it are too small to size. R184's
 *  existing 10y/30y auction-cycle stream is rho -0.002 to Plan E and -0.001 to its TSY leg, so this mechanism is additive by
 *  construction IF it pays. This is the third-leg candidate.
 *  NEW GATE, from the same night's read-across: ALPHA VS HOLDING THE INSTRUMENT is a gate, not a reported line. Six of the
 *  shop's positives (R214, R152-DAVIN, R187/R189, R302, R227, R313's own audit) weaken or die once compared against holding
 *  the asset instead of against zero or a random entry. R338 pays that comparison up front.
 *  Refuses if the id exists. */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f), TODAY = "2026-10-07";

const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const all = [...(reg.tests || []), ...(reg.preregistered || [])];
if (all.some((t) => t.id === "R338")) { console.error("R338 exists — refusing"); process.exit(2); }

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a, L = 1) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * c / n; } return m / Math.sqrt(v / n); }
/** honest bar: max(Newey-West lag-1 simulation, iid nullBar), both at the declared family size */
const barAt = (n, seed, variants) => {
  const rng = mulberry(seed), T = 20000, mx = [];
  for (let k = 0; k < T; k++) { let b = -Infinity; for (let v = 0; v < variants; v++) { const s = []; for (let i = 0; i < n; i++) s.push(rng() * 2 - 1); b = Math.max(b, nwT(s, 1)); } mx.push(b); }
  mx.sort((a, b) => a - b);
  const nw = +mx[Math.floor(0.95 * T)].toFixed(3), iid = +nullBar({ variants, n, trials: 20000 }).p95.toFixed(3);
  return { t: Math.max(nw, iid), nw, iid };
};
// unit = auction WEEK cluster; ~30 auction weeks a year over ~24 usable years ~= 700 clusters. Family = 4 tenor buckets.
const b338 = barAt(700, 338, 4);

const MAP = "2y+3y -> SHY | 5y+7y -> IEI | 10y -> IEF | 20y+30y -> TLT";

reg.preregistered.push({
  id: "R338", registered: TODAY,
  name: "Treasury auction cycle on the full tenor ladder — short the matching-duration ETF into every nominal coupon auction and long out of it, 2002-2026",
  status: `REGISTERED ${TODAY} — historical, read once; builder assigned`,
  script: "backend/r338-auction-ladder.js",
  writerExists: false,
  ip: "Ours: public data only (TreasuryDirect auction results, Schwab daily bars). No vendor material.",
  parent: "Ensemble read 2026-10-07 (backend/data/strategy-library/plan-e-correlation-2026-10-07.json): Plan E's TSY leg is 51.1% of its variance and its crypto leg 25.6%; R180/R192 are the TSY leg itself (rho 1.000/0.933, rising to 0.651 on Plan E's worst days), not diversifiers; the best satellite basket the library can build moves Plan E's Sharpe by +0.108 against a 0.582 SE. MOTIVATION, DISCLOSED AND WEIGHTLESS: R184 (auction cycle, 10y/30y only, 257 events) DID NOT PASS at the test level (t 0.53) but reported a secondary 'short-pre' cell at t 2.354. That cell is counted inside this family as an examined variant; it is NOT evidence for R338.",
  multiplicityFamily: "AUCTION-CYCLE — members: the four tenor buckets (" + MAP + ") plus R184's disclosed short-pre cell. The primary statistic POOLS the buckets and still pays the best-of-4 bar, which is strictly conservative.",
  evidenceStart: "historical, not yet fetched: auctions 2002-07-01..2026-09-30 (each bucket from its ETF's first full year — SHY/IEF/TLT list July 2002, IEI January 2007). No TreasuryDirect or Schwab data for this population has been pulled as of registration.",
  rule: `POPULATION: every US Treasury nominal coupon auction (2y, 3y, 5y, 7y, 10y, 20y, 30y) in TreasuryDirect's auction-results feed, original issues and reopenings alike, over the window above. TIPS, FRNs and bills are excluded. INSTRUMENT MAP (fixed): ${MAP}. TRADE, per auction: PRE LEG short the mapped ETF at the close of the second session before auction day (T-2) and cover at the auction-day close (T0); POST LEG long at the auction-day close (T0) and sell at the close of the second session after (T+2). Both legs are taken for every auction; the auction's net is the sum of the two legs' net returns. Sessions are Schwab daily bars; if a leg's session is missing, that auction is dropped and counted. COST: 2 basis points per side crossing (8 bps per auction over the four fills) plus 1 basis point per calendar day of short borrow on the PRE leg. Positions are equal-weight by dollar notional, one unit per auction.`,
  statistic: "Unit: AUCTION WEEK cluster (every auction settling in the same Monday-Friday week is one observation; the Treasury routinely auctions 2y/5y/7y in one week and 3y/10y/30y in another). Per cluster, the mean net return across that week's auctions, all buckets pooled. Headline t = Newey-West lag 1 over the cluster series. Per-bucket means reported beside it, never as the headline.",
  unit: "auction-week clusters", nExpected: 700,
  controls: {
    placebo: "SHIFTED-CALENDAR PLACEBO: the identical two-leg construction anchored on a pseudo-auction date drawn from the same calendar year but in a week containing NO coupon auction, same bucket mix, same costs, 500 draws. GATE: observed cluster mean > placebo p95 AND the Newey-West t of the paired difference (real minus matched placebo) >= the bar.",
    holdBenchmark: "ALPHA VS HOLDING THE INSTRUMENT (gate, not a reported line — 2026-10-07 lesson): the same capital simply long the mapped ETF across the identical T-2..T+2 window. GATE: the Newey-West t of (strategy minus hold) over clusters >= the bar. A strategy that merely captures duration drift fails here.",
    nonAuctionWeeks: "NON-AUCTION-WEEK CONTROL: the same construction on every week with no coupon auction; GATE: |t| < 2 (it must be a flat line, or the construction itself is generating the result).",
    halves: "clusters split at 2014-06-30; both halves' means > 0.",
    cost2x: "the same trades at twice the cost model (4 bps per side, 2 bps per day borrow): cluster mean > 0.",
    leakTest: "auction dates shuffled WITHIN calendar year (keeps the seasonal and rate environment, destroys the link to the auction itself), >= 200 shuffles: the whole decision rule's false-pass rate must be <= 5%, else the read is HELD for an amendment; plus a single-shuffle |t_NW| < 2.",
    positiveControl: "auctions whose own realised net was > 0: t_NW >= 3, else CANNOT MEASURE.",
    reported: "each tenor bucket separately; PRE and POST legs separately; the R184 10y/30y subpopulation alone (so the motivating cell can be seen in context); original issues vs reopenings; auction size as a covariate; the 2009-2014 and 2020-2021 quantitative-easing eras excluded; bid-to-cover and tail as covariates; the result at zero cost.",
  },
  bar: { fixedInAdvance: true, unit: "auction-week clusters", tRequired: b338.t, variants: 4, statistic: "Newey-West t, lag 1", source: `max(NW lag-1 sim n=700 seed 338 variants 4 p95 ${b338.nw}, nullBar variants 4 n=700 p95 ${b338.iid})` },
  interimKill: "none (single historical read). No partial read is permitted: the file is read once, after the controls run.",
  decisionRule: {
    pass: `PASS only if >= 300 auction-week clusters AND cluster mean net > 0 AND t_NW >= ${b338.t} AND the shifted-calendar placebo gate clears AND the hold-the-instrument gate clears AND the non-auction-week control is flat AND both halves > 0 AND the 2x-cost mean > 0 AND the leak calibration is <= 5% AND the positive control passed. A PASS proposes a forward paper arm sized as a candidate THIRD LEG beside Plan E (20-30% of risk budget) — the operator's call, never automatic.`,
    fail: "DID NOT PASS: the auction concession is not harvestable through duration ETFs after costs on 2002-2026 data; the mechanism is closed at this implementation and the third-leg search moves to the next candidate.",
    cannotMeasure: "CANNOT MEASURE if < 300 clusters, if TreasuryDirect coverage gaps exceed 5% of auctions, or if the leak test or positive control fails.",
  },
  knownWeaknesses: [
    "The ETF era starts mid-2002 and IEI only in 2007, so the headline n is below the ~2,300 auctions the raw calendar offers; the 2y/3y and 5y/7y buckets are shorter than the 10y.",
    "R184 tested the 10y/30y subpopulation and DID NOT PASS at the test level; its short-pre cell at t 2.354 is the motivation for this test and is counted in the family. If the pooled result is carried entirely by that subpopulation, this is a re-read of a seen cell and must be reported as such.",
    "Duration ETFs across buckets are highly correlated, so the four buckets are far from four independent bets; the auction-week cluster unit is the control for that and the bar is still paid at variants 4.",
    "The Federal Reserve was the dominant buyer in 2009-2014 and 2020-2021, which could create or destroy the concession; an era-excluded read is reported but the primary includes those years.",
    "TLT's duration is much longer than a 20y auction's and SHY's much shorter than a 3y's; the map is a liquidity choice, not a duration match.",
    "The PRE leg requires borrow on every auction; borrow was cheap and available for these ETFs historically, but the 1 basis point per day charge is a model, not a measurement.",
    "The 20y tenor was reintroduced in 2020, so that bucket mixes a 2002-2009 history with a 2020+ one.",
    "Settlement-date versus auction-date conventions differ by tenor; the rule anchors on AUCTION date, and any auction whose results were published after the session close is dropped and counted.",
  ],
  readCondition: "--read once, after --selftest passes and every control above has run (shifted-calendar placebo, hold benchmark, non-auction-week control, leak calibration <= 5%, positive control). The read is sealed the same day through the read-test ritual.",
});

reg.asOf = new Date().toISOString();
writeJsonAtomic(D("test-registry.json"), reg);

const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({
  date: TODAY,
  area: "registry — R338 Treasury auction cycle, full tenor ladder",
  category: "registration",
  breaksComparability: false,
  change: `Registered before any TreasuryDirect or Schwab data for the population was fetched. Bar ${b338.t} on auction-week clusters at variants 4 (family = four tenor buckets plus R184's disclosed short-pre cell). NEW: alpha-vs-holding-the-instrument is a GATE here, not a reported line.`,
  why: "Operator 2026-10-07: 'register it' — the third-leg candidate. Plan E is two bets (TSY 51.1% of variance, crypto 25.6%); nothing in 99 library streams hedges its worst days; R184's auction stream is rho -0.002 to Plan E.",
  doesNotEstablish: "Any result. R184 remains DID NOT PASS; its short-pre cell is motivation, counted in this family, and is not evidence.",
  operator: "Josh 2026-10-07",
});
writeJsonAtomic(D("change-registry.json"), cr);

fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R338"] }) + "\n");

console.log(`registered R338 — bar ${b338.t} (NW sim ${b338.nw}, nullBar ${b338.iid}), unit auction-week clusters, variants 4`);
