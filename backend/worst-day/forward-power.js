#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY PREDICTOR, forward-test design: if a sealed nightly forecast had been graded over N sessions starting at each past date, how
 * often would it have cleared its bar, and how often would a forecast with NO timing have cleared it? IN-SAMPLE / WALK-FORWARD
 * EXPLORATORY: it sizes a FORWARD test, it is not evidence for one. Read-only on the repo; no network; no registry write.
 * Writes backend/data/worst-day/forward-power.json through lib/atomic-write.js.
 *   node backend/worst-day/forward-power.js
 *
 * FORECASTS  pB = the logistic of run.js (15 inputs, lambda 10, refit each January, out of sample 2005-2026), reused through wf.js
 *            pV = the same learner on ONE input (20-day realised vol): "vol is high now" turned into a probability, same folds
 *            p0 = 0.05 every day: the no-skill forecast (the target is a 5% event by construction)
 *            flags = run.js's causal flags (score at or above the 90th percentile of the model's own training scores); rule (a) as built
 * THREE WAYS TO GRADE (all three reported; none tuned)
 *   BRIER    the squared miss between the stated chance and what happened, per session
 *            d1 = (p0 - y)^2 - (pB - y)^2  positive = the model beat "always 5%";  d2 = (pV - y)^2 - (pB - y)^2  positive = it beat vol alone
 *   EXCESS   x = flag x (y - 0.05): worst days on flagged days beyond the 5% that chance gives
 *            both as the t of the mean of 21-session block sums (about a month: storms cluster inside months, so the block is the unit),
 *            bar = lib/null-bar.js p95 at one pre-specified variant and that number of blocks
 *   ROTATION worst days caught by the flags against the same flags slid to every other position inside the window (21 sessions or more
 *            away, wrapping round); clears when at most 5% of the slid positions catch as many (and at least one is caught)
 * NO-TIMING CONTROL  the model's own forecasts taken from a year or more away (20 fixed shifts per window): same values, no timing
 * WINDOWS    N = 63, 126, 252, 504, 756 sessions, a new window every 21 sessions across the 5,477 out-of-sample days (windows overlap: the
 *            shares describe the past, they are not independent trials)
 * GATE       a read needs something to grade: at least 20 flagged sessions and at least 5 worst days in the window (GATE_FLAGS, GATE_WORST);
 *            a window short of either would read CANNOT MEASURE, not DID NOT PASS. Fixed here before the split below was looked at.
 * TRIED      3 grading methods, 2 rivals, 5 window lengths, 1 block size, 3 flag sets, 1 gate; nothing selected on outcome.
 */
const path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const { nullBar } = require("../lib/null-bar.js");
const L = require("./lib.js");
const WF = require("./wf.js");
const OUT = path.join(__dirname, "..", "data", "worst-day", "forward-power.json");
const fin = Number.isFinite, r2 = (x) => (fin(x) ? +x.toFixed(2) : null), r3 = (x) => (fin(x) ? +x.toFixed(3) : null), r5 = (x) => (fin(x) ? +x.toFixed(5) : null);
const t0 = Date.now(), SEED = 20261011, P0 = 0.05, BLOCK = 21, GATE_FLAGS = 20, GATE_WORST = 5;

const ctx = WF.makeCtx(), { D, O, K, tYear } = ctx;
const Yv = WF.labelsO(ctx, D.y);
const wB = WF.walk(ctx, D.X, ctx.yArr, { gbm: false });
const Xv = D.X.map((row) => [row[1]]);                                   // one input: ln of 20-day realised vol
const wV = WF.walk(ctx, Xv, ctx.yArr, { gbm: false, volCol: 0 });
const pB = wB.scoreO.b, pV = wV.scoreO.b;

// reproduction gate: the walk here must be run.js's walk
const rep = WF.evalScore(ctx, pB, Yv), repV = WF.evalScore(ctx, wB.scoreO.v, Yv);
if (Math.abs(rep.share - 37.13) > 0.01 || Math.abs(rep.hit - 18.43) > 0.01) throw new Error(`walk does not reproduce run.js: ${rep.share} / ${rep.hit}`);
if (Math.abs(repV.share - 34.19) > 0.01) throw new Error(`vol benchmark does not reproduce run.js: ${repV.share}`);

const FLAG = {
  b: Uint8Array.from(O, (i, k) => (pB[k] >= wB.THR.b[tYear(i)] ? 1 : 0)),                  // logistic, causal threshold
  v: Uint8Array.from(O, (i, k) => (wB.scoreO.v[k] >= wB.THR.v[tYear(i)] ? 1 : 0)),         // 20-day vol alone, causal threshold
  a: Uint8Array.from(O, (i) => (D.flagA[i] === 1 ? 1 : 0)),                                // rule of thumb
};
const cnt = (f) => { let F = 0, C = 0; for (let k = 0; k < K; k++) if (f[k]) { F++; if (Yv[k]) C++; } return { flagged: F, caught: C }; };
const flagCheck = { b: cnt(FLAG.b), v: cnt(FLAG.v), a: cnt(FLAG.a), runJsWrote: "b 494 / 97, v 404 / 78, a 861 / 140" };
if (flagCheck.b.flagged !== 494 || flagCheck.b.caught !== 97 || flagCheck.v.flagged !== 404 || flagCheck.v.caught !== 78 || flagCheck.a.flagged !== 861 || flagCheck.a.caught !== 140) throw new Error("flags do not reproduce run.js: " + JSON.stringify(flagCheck));

const y = Float64Array.from(Yv), d1 = new Float64Array(K), d2 = new Float64Array(K), dV = new Float64Array(K);
let bs0 = 0, bsB = 0, bsV = 0;
for (let k = 0; k < K; k++) { const e0 = (P0 - y[k]) ** 2, eB = (pB[k] - y[k]) ** 2, eV = (pV[k] - y[k]) ** 2; d1[k] = e0 - eB; d2[k] = eV - eB; dV[k] = e0 - eV; bs0 += e0; bsB += eB; bsV += eV; }
bs0 /= K; bsB /= K; bsV /= K;
const excess = (f) => Float64Array.from(f, (v, k) => v * (y[k] - P0));
const X = { b: excess(FLAG.b), v: excess(FLAG.v), a: excess(FLAG.a) };
const xBV = Float64Array.from(X.b, (v, k) => v - X.v[k]);

function blockT(get, N) { const m = Math.floor(N / BLOCK), v = new Array(m).fill(0); for (let b = 0; b < m; b++) for (let j = 0; j < BLOCK; j++) v[b] += get(b * BLOCK + j); const mu = L.mean(v), sdv = L.sd(v); return sdv > 0 ? mu / (sdv / Math.sqrt(m)) : 0; }
function rotationP(flagAt, s, N) {           // flags slid inside the window against the window's own outcomes
  const pos = []; for (let j = 0; j < N; j++) if (y[s + j]) pos.push(j);
  const caughtAt = (sh) => { let c = 0; for (const j of pos) if (flagAt((j + sh) % N)) c++; return c; };
  const obs = caughtAt(0); let ge = 0, n = 0; for (let sh = BLOCK; sh <= N - BLOCK; sh++) { n++; if (caughtAt(sh) >= obs) ge++; }
  return { obs, p: (1 + ge) / (1 + n) };
}
const q = (a, p) => { const s = a.slice().sort((x, z) => x - z); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const sum = (a, s = 0, e = a.length) => { let t = 0; for (let k = s; k < e; k++) t += a[k]; return t; };

// dollars for the two paper twins (run.js's own cost rules: 3 bp a side on the change in position, 1 bp per calendar day short, $100,000)
const NOT = 100000, SIDE = 0.0003, BORROW = 0.0001;
const r1 = Float64Array.from(O, (i) => D.r[i + 1]), cd = Float64Array.from(O, (i) => L.dayNum(D.d[i + 1]) - L.dayNum(D.d[i]));
function pnl(posOf) { const out = new Float64Array(K); let prev = 0; for (let k = 0; k < K; k++) { const p = posOf(k); out[k] = p * r1[k] - SIDE * Math.abs(p - prev) - (p < 0 ? BORROW * (-p) * cd[k] : 0); prev = p; } return out; }
const pFull = pnl(() => NOT), pHalf = pnl((k) => (FLAG.b[k] ? NOT / 2 : NOT)), pShort = pnl((k) => (FLAG.b[k] ? -NOT : 0));
const YEARS = (L.dayNum(D.d[O[K - 1] + 1]) - L.dayNum(D.d[O[0]]) + 1) / 365.25;
const dollarsCheck = { fullPerYearUsd: r2(sum(pFull) / YEARS), halfPerYearUsd: r2(sum(pHalf) / YEARS), shortPerYearUsd: r2(sum(pShort) / YEARS), runJsWrote: { full: 12152.14, half: 11024.87, short: -2590.71 } };
dollarsCheck.matchesRunJs = Math.abs(dollarsCheck.fullPerYearUsd - 12152.14) < 0.01 && Math.abs(dollarsCheck.halfPerYearUsd - 11024.87) < 0.01 && Math.abs(dollarsCheck.shortPerYearUsd + 2590.71) < 0.01;
if (!dollarsCheck.matchesRunJs) throw new Error("twin dollars do not reproduce run.js: " + JSON.stringify(dollarsCheck));

const rng = WF.mulberry(SEED + 21), SHIFTS = Array.from({ length: 20 }, () => 252 + Math.floor(rng() * (K - 504)));
const windows = {};
for (const N of [63, 126, 252, 504, 756]) {
  const m = Math.floor(N / BLOCK), bar = nullBar({ variants: 1, n: m, trials: 20000, rng: WF.mulberry(SEED + N) }).p95;
  const starts = []; for (let s = 0; s + N <= K; s += BLOCK) starts.push(s);
  const W = starts.length, pct = (x, n = W) => r2(100 * x / n);
  const c = { brier5: 0, brierVol: 0, brierVolPos: 0, volBrier5: 0, exB: 0, exV: 0, exA: 0, exBV: 0, exBVpos: 0, rotB: 0, rotV: 0, rotA: 0, nBrier5: 0, nExB: 0, nRotB: 0, nN: 0, gateFail: 0, gateOkPass: 0, gateOkNot: 0, nGateOkPass: 0 };
  const tB5 = [], tBV = [], tExB = [], worst = [], flagged = [], caught = [], halfDiff = [], shortUsd = [], lossFull = [], lossHalf = [];
  for (const s of starts) {
    const a = blockT((j) => d1[s + j], N), b = blockT((j) => d2[s + j], N); tB5.push(a); tBV.push(b);
    if (a >= bar) c.brier5++; if (b >= bar) c.brierVol++; if (b > 0) c.brierVolPos++; if (blockT((j) => dV[s + j], N) >= bar) c.volBrier5++;
    const eB = blockT((j) => X.b[s + j], N); tExB.push(eB);
    if (eB >= bar) c.exB++; if (blockT((j) => X.v[s + j], N) >= bar) c.exV++; if (blockT((j) => X.a[s + j], N) >= bar) c.exA++;
    const eBV = blockT((j) => xBV[s + j], N); if (eBV >= bar) c.exBV++; if (eBV > 0) c.exBVpos++;
    let rotBPass = false;
    for (const m2 of ["b", "v", "a"]) { const r = rotationP((j) => FLAG[m2][s + j], s, N); if (r.obs >= 1 && r.p <= 0.05) { c["rot" + m2.toUpperCase()]++; if (m2 === "b") rotBPass = true; } }
    let Wd = 0, F = 0, C = 0, lf = 0, lh = 0; for (let k = s; k < s + N; k++) { if (y[k]) { Wd++; lf += pFull[k]; lh += pHalf[k]; } if (FLAG.b[k]) { F++; if (y[k]) C++; } }
    if (F < GATE_FLAGS || Wd < GATE_WORST) c.gateFail++; else if (rotBPass) c.gateOkPass++; else c.gateOkNot++;
    worst.push(Wd); flagged.push(F); caught.push(C); halfDiff.push(sum(pHalf, s, s + N) - sum(pFull, s, s + N)); shortUsd.push(sum(pShort, s, s + N));
    if (Wd) { lossFull.push(lf / Wd); lossHalf.push(lh / Wd); }
    // no-timing control: the model's own forecasts and flags taken from a year or more away, graded on this window's outcomes
    for (const sh of SHIFTS) {
      c.nN++;
      if (blockT((j) => { const k = s + j, pr = pB[(k + sh) % K]; return (P0 - y[k]) ** 2 - (pr - y[k]) ** 2; }, N) >= bar) c.nBrier5++;
      if (blockT((j) => { const k = s + j; return FLAG.b[(k + sh) % K] * (y[k] - P0); }, N) >= bar) c.nExB++;
      const r = rotationP((j) => FLAG.b[(s + j + sh) % K], s, N); if (r.obs >= 1 && r.p <= 0.05) { c.nRotB++; let Fn = 0; for (let j = 0; j < N; j++) Fn += FLAG.b[(s + j + sh) % K]; if (Fn >= GATE_FLAGS && Wd >= GATE_WORST) c.nGateOkPass++; }
    }
  }
  windows[N] = {
    sessions: N, blocks: m, barT: r3(bar), windows: W, expectedWorstDaysAtBaseRate: r2(N * Yv.reduce((a, v) => a + v, 0) / K),
    brier: { logisticVsAlways5pctPassPct: pct(c.brier5), logisticVsVolAlonePassPct: pct(c.brierVol), logisticVsVolAlonePositivePct: pct(c.brierVolPos), volAloneVsAlways5pctPassPct: pct(c.volBrier5), noTimingPassPct: pct(c.nBrier5, c.nN), medianTVsAlways5pct: r3(q(tB5, 0.5)), medianTVsVolAlone: r3(q(tBV, 0.5)) },
    excessHits: { logisticPassPct: pct(c.exB), volAlonePassPct: pct(c.exV), ruleOfThumbPassPct: pct(c.exA), logisticMinusVolAlonePassPct: pct(c.exBV), logisticMinusVolAlonePositivePct: pct(c.exBVpos), noTimingPassPct: pct(c.nExB, c.nN), medianT: r3(q(tExB, 0.5)), p10T: r3(q(tExB, 0.1)), p90T: r3(q(tExB, 0.9)) },
    rotation: { logisticPassPct: pct(c.rotB), volAlonePassPct: pct(c.rotV), ruleOfThumbPassPct: pct(c.rotA), noTimingPassPct: pct(c.nRotB, c.nN) },
    rotationWithGate: { gate: `at least ${GATE_FLAGS} flagged sessions and at least ${GATE_WORST} worst days`, cannotMeasurePct: pct(c.gateFail), passPct: pct(c.gateOkPass), didNotPassPct: pct(c.gateOkNot), noTimingPassPct: pct(c.nGateOkPass, c.nN) },
    worstDaysInWindow: { min: Math.min(...worst), p10: q(worst, 0.1), median: q(worst, 0.5), p90: q(worst, 0.9), max: Math.max(...worst), windowsWithFewerThan5Pct: pct(worst.filter((x) => x < 5).length), windowsWithNonePct: pct(worst.filter((x) => x === 0).length) },
    flaggedDaysInWindow: { min: Math.min(...flagged), p10: q(flagged, 0.1), median: q(flagged, 0.5), p90: q(flagged, 0.9), max: Math.max(...flagged), windowsWithNoFlagPct: pct(flagged.filter((x) => x === 0).length), windowsWithFewerThan20Pct: pct(flagged.filter((x) => x < 20).length) },
    worstDaysCaughtInWindow: { median: q(caught, 0.5), p90: q(caught, 0.9), windowsWithNoneCaughtPct: pct(caught.filter((x) => x === 0).length) },
    twinHalfSizeMinusFullUsd: { median: r2(q(halfDiff, 0.5)), p10: r2(q(halfDiff, 0.1)), p90: r2(q(halfDiff, 0.9)), windowsAheadOfFullPct: pct(halfDiff.filter((x) => x > 0).length), windowsExactlyEqualPct: pct(halfDiff.filter((x) => x === 0).length), windowsBehindFullPct: pct(halfDiff.filter((x) => x < 0).length),
      avgLossOnAWorstDayFullUsd: r2(L.mean(lossFull)), avgLossOnAWorstDayHalfUsd: r2(L.mean(lossHalf)) },
    twinShortOnFlaggedUsd: { median: r2(q(shortUsd, 0.5)), p10: r2(q(shortUsd, 0.1)), p90: r2(q(shortUsd, 0.9)), windowsPositivePct: pct(shortUsd.filter((x) => x > 0).length), windowsZeroPct: pct(shortUsd.filter((x) => x === 0).length), windowsNegativePct: pct(shortUsd.filter((x) => x < 0).length) },
  };
}

// the whole out-of-sample span read once (260 blocks)
const KB = Math.floor(K / BLOCK) * BLOCK, barWhole = nullBar({ variants: 1, n: KB / BLOCK, trials: 20000, rng: WF.mulberry(SEED + 7) }).p95;
const whole = { blocks: KB / BLOCK, barT: r3(barWhole), brierLogisticVsAlways5pctT: r3(blockT((j) => d1[j], KB)), brierVolAloneVsAlways5pctT: r3(blockT((j) => dV[j], KB)), brierLogisticVsVolAloneT: r3(blockT((j) => d2[j], KB)),
  excessHitsLogisticT: r3(blockT((j) => X.b[j], KB)), excessHitsVolAloneT: r3(blockT((j) => X.v[j], KB)), excessHitsRuleOfThumbT: r3(blockT((j) => X.a[j], KB)), excessHitsLogisticMinusVolAloneT: r3(blockT((j) => xBV[j], KB)) };
// flagged against not flagged, whole span (the two-level forecast the nightly row would state)
const two = {}; for (const m2 of ["b", "v", "a"]) { const f = cnt(FLAG[m2]); two[m2] = { flaggedDays: f.flagged, worstOnFlagged: f.caught, flaggedRatePct: r2(100 * f.caught / f.flagged), otherDays: K - f.flagged, worstOnOther: 272 - f.caught, otherRatePct: r2(100 * (272 - f.caught) / (K - f.flagged)) }; }
// the latest 252 out-of-sample sessions, as an example of what one read would have looked like
const lastS = K - 252, last = { from: D.d[O[lastS] + 1], to: D.d[O[K - 1] + 1], brierTVsAlways5pct: r3(blockT((j) => d1[lastS + j], 252)), brierTVsVolAlone: r3(blockT((j) => d2[lastS + j], 252)), excessHitsT: r3(blockT((j) => X.b[lastS + j], 252)), rotationP: r3(rotationP((j) => FLAG.b[lastS + j], lastS, 252).p) };
{ let Wd = 0; const f = { b: [0, 0], v: [0, 0], a: [0, 0] }; for (let k = lastS; k < K; k++) { if (y[k]) Wd++; for (const m2 of ["b", "v", "a"]) if (FLAG[m2][k]) { f[m2][0]++; if (y[k]) f[m2][1]++; } }
  Object.assign(last, { worstDays: Wd, logisticFlagged: f.b[0], logisticCaught: f.b[1], volAloneFlagged: f.v[0], volAloneCaught: f.v[1], ruleFlagged: f.a[0], ruleCaught: f.a[1], halfMinusFullUsd: r2(sum(pHalf, lastS, K) - sum(pFull, lastS, K)), shortOnFlaggedUsd: r2(sum(pShort, lastS, K)) }); }

const out = {
  spec: "worst-day-forward-power-v3", asOf: new Date().toISOString(), command: "node backend/worst-day/forward-power.js",
  status: "IN-SAMPLE / WALK-FORWARD EXPLORATORY. It sizes a forward test from past walk-forward forecasts; it is not evidence for the test. The forward model would be FROZEN; these forecasts were refit each January.",
  reproduction: { logisticTopDecile: { sharePct: r2(rep.share), hitPct: r2(rep.hit) }, volAloneTopDecile: { sharePct: r2(repV.share), hitPct: r2(repV.hit) }, runJsWrote: "37.13 / 18.43 and 34.19 / 16.97", flags: flagCheck, dollars: dollarsCheck },
  oos: { days: K, worstDays: Yv.reduce((a, v) => a + v, 0), first: D.d[O[0] + 1], last: D.d[O[K - 1] + 1], years: r2(YEARS) },
  definitions: { p0: P0, brier: "d1 = (0.05 - y)^2 - (pLogistic - y)^2; d2 = (pVolAlone - y)^2 - (pLogistic - y)^2", excessHits: "x = flag x (y - 0.05)", block: `${BLOCK} consecutive sessions, summed`, blockStatistic: "t of the mean block sum", bar: "lib/null-bar.js p95, variants 1, n = blocks, 20,000 trials, seeded",
    rotation: `flags slid ${BLOCK}..N-${BLOCK} sessions inside the window, wrapping; clears at p <= 0.05 with at least one worst day caught`, noTiming: "the model's own forecasts and flags from 252 or more sessions away, 20 fixed shifts per window", windowStep: `${BLOCK} sessions (windows overlap)` },
  brierWholeSpan: { always5pct: r5(bs0), volAlone: r5(bsV), logistic: r5(bsB), logisticSkillVsAlways5pctPct: r2(100 * (1 - bsB / bs0)), volAloneSkillVsAlways5pctPct: r2(100 * (1 - bsV / bs0)), logisticSkillVsVolAlonePct: r2(100 * (1 - bsB / bsV)) },
  wholeSpanAsOneRead: whole, flaggedAgainstNotFlagged: two, windows, latest252SessionsExample: last,
  tried: { gradingMethods: 3, rivals: 2, windowLengths: 5, blockSizes: 1, flagSets: 3, gates: 1, note: "nothing selected on outcome; the one-input vol logistic is one extra fitted benchmark beyond run.js's five scored predictors" },
  elapsedSec: r2((Date.now() - t0) / 1000),
};
writeJsonAtomic(OUT, out);
console.log(JSON.stringify(out, null, 1));
