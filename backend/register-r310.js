#!/usr/bin/env node
/** Registers R310 — the Quantified Strategies RSI(5) dip-buy from a Facebook carousel (operator 2026-10-02: "test it"). The rule is the
 *  reel's own (slides 2-3), taken verbatim, so the bar is single-variant. DISCLOSED before registration: a weightless reproduction on SPY
 *  1993-2026 (docs/reels/2026-10-02-qs-rsi5/check.cjs) — 90 trades, 91% win, +1.37%/trade, 2016+ 29 trades +0.73% t 2.35 — so SPY is
 *  excluded from the gated population; and R150 (RSI-2, a close cousin) sealed PASS on the same 100 names over the same years.
 *  Filed BEFORE any bar of the gated universe was fetched for this rule. Refuses if R310 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ID = "R310", TODAY = "2026-10-02", N = 129;
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === ID)) { console.error(`${ID} exists — refusing`); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return m / Math.sqrt(v / n); }
const rng = mulberry(310), T = 50000, mx = [];
for (let t = 0; t < T; t++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); mx.push(nwT(s)); }
mx.sort((a, b) => a - b); const nwBar = +mx[Math.floor(0.95 * T)].toFixed(3), iidBar = +nullBar({ variants: 1, n: N, trials: 20000 }).p95.toFixed(3);
const BAR = Math.max(nwBar, iidBar);
const ETFS = ["QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"];
reg.preregistered.push({
  id: ID, registered: TODAY,
  name: "Quantified Strategies' RSI(5) dip-buy (Facebook carousel, slides 2-3) — daily, R151's universe without SPY, 2016-2026",
  status: `REGISTERED ${TODAY} — historical, read once; builder assigned`, script: "backend/r310-qs-rsi5.js",
  parent: "Operator 2026-10-02 sent a Quantified Strategies carousel ('THE RSI ENTRY RULES' / 'THE TRADING RULES'), then 'test it'. Same family as R150's RSI-2 member (sealed PASS 2026-09-23, t_NW 2.562 vs 2.523 on the 100 names 2016+) and R151 (RSI-2 forward on Alpaca paper, read after the 2026-10-07 close).",
  origin: "Quantified Strategies (public social post). The rule text below is our mechanical reading; the creator's material is not republished.",
  multiplicityFamily: "RSI-DIP — R150 RSI-2 (sealed), R151 (forward), R310. R310 is ONE rule with every parameter taken verbatim from the reel (RSI length 5, 30, three declines, 60 three days ago, SMA200, exit cross of 50), so the bar is single-variant; nothing is searched.",
  evidenceStart: "historical: entries 2016-01-01..2026-09-30 (bars from 2015-01-01 for the 200-day warm-up); exits through the last complete daily bar",
  rule: [
    `UNIVERSE (gated): the 100 names in data/r147-universe.json + ${ETFS.join(" ")} (R151's list without SPY — SPY was looked at first, see knownWeaknesses). Alpaca SIP daily bars, adjustment "all" (as R150).`,
    "RSI(5) = Wilder's RSI, length 5, on daily closes.",
    "ENTRY at the close of day t when ALL FOUR hold, using bars <= t only: (1) RSI5[t] < 30; (2) RSI5 down for the third day in a row: RSI5[t] < RSI5[t-1] < RSI5[t-2] < RSI5[t-3]; (3) RSI5[t-3] < 60; (4) close[t] > SMA200[t]. Long only; one position per symbol at a time (a signal while already long is ignored).",
    "EXIT at the close of the first day u > t where RSI5 crosses above 50: RSI5[u] > 50 AND RSI5[u-1] <= 50. No stop, no time cap (as published).",
    "COST: 0.10% round trip per trade (R150's). Trades still open at the last bar are reported, not counted.",
  ].join(" "),
  statistic: "Unit: calendar MONTH of entry. Per month, the mean net % return of trades entered that month (every symbol pooled); headline t = Newey-West (lag 1) over months, as R150. Win rate reported beside it.",
  unit: "months", nExpected: N,
  controls: {
    placebo: "MATCHED RANDOM ENTRY (the reel's real claim is that the dip timing beats simply being long a stock above its 200-day): for each real trade, a random day of the SAME symbol in the SAME calendar month with close > SMA200 and no entry signal (widen to +-1 month if none), held the SAME number of trading days, same 0.10% cost; 500 draws. The observed mean of the monthly series must beat the placebo p95. The paired real-minus-placebo difference is reported.",
    nextOpen: "EXECUTION ROBUSTNESS: the same signals filled at the NEXT open and exited at the open after the exit signal; its mean net per month must be > 0 (sign only). Guards the same-close signal-and-fill assumption.",
    halves: "first and second half of the months; both must be positive.",
    leakTest: "drift-free bar shuffle within each symbol (seeds 1, 2), R149/R150 design: t_NW < 2 on both, else CANNOT MEASURE.",
    positiveControl: "trades whose own realised net is positive (outcome look-ahead): t_NW >= 3, else CANNOT MEASURE.",
    reported: "ETF-only subset (survivorship-free); SPY 2016+ (in-sample, labelled); cost at 0.20%; overlap with R150's RSI-2 long signals (share of R310 entries on a symbol-day where RSI-2 also fires, and R310 trades with no RSI-2 position open) — what R310 adds beyond RSI-2; hold-length distribution; share of symbol-days in the market; per year.",
  },
  bar: { fixedInAdvance: true, unit: "months", tRequired: BAR, variants: 1, statistic: "Newey-West t, lag 1",
    source: `max of (a) NW(lag 1) t on zero-mean iid noise, n=${N}, 50,000 trials, seed 310, p95 = ${nwBar} and (b) nullBar({variants:1, n:${N}}).p95 = ${iidBar}` },
  interimKill: "none (single historical read)",
  decisionRule: {
    pass: `PASS only if >= 100 trades over >= 36 months AND mean net per month > 0 AND t_NW >= ${BAR} AND the matched-random placebo p95 is beaten AND both halves are positive AND the next-open mean is > 0 AND the leak test and the positive control passed. A PASS adopts nothing: it proposes an R310 arm on R151's paper runner (signal at ~15:40 ET, market-on-close) — the operator's call.`,
    fail: "DID NOT PASS: the reel's rule does not beat random above-200-day entries on this universe after costs; closed here — no re-run with other RSI lengths, thresholds or exits on these data.",
    cannotMeasure: "CANNOT MEASURE if fewer than 100 trades or 36 months, or the leak test or the positive control fails.",
  },
  knownWeaknesses: [
    "SPY was examined before registration (weightless reproduction, 2026-10-02): the rule worked on SPY 1993-2026 (90 trades, 91% win, +1.37%/trade) and had decayed since 2016 (+0.73%, t 2.35). SPY is excluded from the gate for that reason, but the result shaped the expectation.",
    "R150's RSI-2 passed on the same 100 names and years; the two rules buy many of the same dips, so a PASS here partly repeats that evidence. The overlap is reported so the increment is visible.",
    "Survivorship: the 100 names are today's (r147 universe), which flatters buying dips in long-run winners; the ETF-only subset is reported as the survivorship-free check.",
    "Signal and fill at the same close is the published rule but not literally tradeable; the next-open gate and R151's 15:40 ET forward arm address it.",
    "No stop and no time cap: rare long holds in a falling stock carry the tail; the hold distribution is reported.",
    "Dip-buys cluster in market selloffs; month clustering with Newey-West handles the correlation, and effective N is months, not trades.",
    "adjustment 'all' bars include dividends, which nudges RSI on ex-dates; R150 used the same convention.",
  ],
  readCondition: "--read once, after --selftest passes its known answers and the controls run (leak test + positive control) passes; seals in read-seals.json.",
  writerExists: false, writerNote: "runner written by a builder agent on 2026-10-02 from R150's harness pattern; CANNOT MEASURE is a legitimate outcome",
  ip: "Ours: a public rule measured on our own data.",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R310 QS RSI(5) dip-buy", category: "registration", breaksComparability: false, change: `Registered R310 before any gated bar was fetched: Quantified Strategies RSI(5) rule verbatim (RSI5<30, 3 declines, <60 three days ago, close>SMA200; exit RSI5 crosses 50), R151 universe minus SPY, 2016-2026, close fills, 0.10% RT, month-of-entry NW t, bar ${BAR} (single rule); gates: matched random-entry placebo, next-open > 0, halves, leak test, positive control. SPY preview disclosed.`, why: "Operator 2026-10-02: 'test it'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-02" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: [ID], family: "RSI-DIP" }) + "\n");
console.log(`${ID} registered · bar t_NW >= ${BAR} (NW sim ${nwBar}, iid ${iidBar}; months, single rule) · ${reg.preregistered.length} preregistered`);
