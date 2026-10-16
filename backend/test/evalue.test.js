/**
 * E-VALUE MACHINERY — the claim under test is "you may look every day for free".
 *
 * That claim is not taken from the literature here. It is MEASURED: thousands of pure-noise
 * paths are optional-stopped at the first boundary crossing and the empirical false-positive
 * rate is checked against alpha. The same paths are then run through the naive procedure this
 * replaces — a fixed-n t-test peeked at after every session — so the size of the problem being
 * fixed is visible as a number rather than asserted as a principle.
 *
 * Deterministic PRNG throughout: a statistical test suite that fails one run in twenty is worse
 * than no suite, because it teaches the operator to ignore red.
 */
const { suite, test, eq, close, ok, throws } = require("./run");
const { bettingE, confSeq, sequentialVerdict, eBH, killHorizon, tStat } = require("../lib/evalue");

// ── deterministic normal draws (mulberry32 + Box-Muller) ────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normals(seed, n, mu = 0, sd = 1) {
  const u = rng(seed), out = [];
  while (out.length < n) {
    const a = Math.max(u(), 1e-12), b = u();
    out.push(mu + sd * Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b));
    if (out.length < n) out.push(mu + sd * Math.sqrt(-2 * Math.log(a)) * Math.sin(2 * Math.PI * b));
  }
  return out.slice(0, n);
}

// SD 0.5R is the scale of real session gaps here; CLIP = 1.0 is the ~2-sigma bound the library
// documents. The first draft used CLIP = 2.0 (4 sigma) and power fell to 55% with a mean stop of
// 48/60 — a real design lesson (see the DEFAULTS comment in lib/evalue.js), not a tuning fudge:
// the clip is declared from the series' KNOWN scale, never fitted to the sample under test.
const ALPHA = 0.05, CLIP = 1.0, SD = 0.5;

suite("e-values · THE CLAIM: peeking is free", () => {
  const PATHS = 20000, N = 60;

  // Optional stopping under the null: walk each path observation by observation, stop the
  // instant the boundary is crossed, count it as a false positive. This is exactly the
  // behaviour a fixed-n bar forbids and an e-process permits.
  let eFalse = 0, peekFalse = 0, fixedFalse = 0, eStopSum = 0;
  for (let p = 0; p < PATHS; p++) {
    const x = normals(1000 + p, N, 0, SD);
    const r = bettingE(x, { alpha: ALPHA, clip: CLIP, oneSided: "greater" });
    if (r.rejected) { eFalse++; eStopSum += r.stoppedAt; }
    // the naive alternative: t >= 2.0 checked after EVERY observation from n=10
    let peeked = false;
    for (let n = 10; n <= N && !peeked; n++) { const t = tStat(x.slice(0, n)); if (t != null && t >= 2.0) peeked = true; }
    if (peeked) peekFalse++;
    const tf = tStat(x); if (tf != null && tf >= 2.0) fixedFalse++;   // one honest look at n=60
  }
  const eRate = eFalse / PATHS, peekRate = peekFalse / PATHS, fixedRate = fixedFalse / PATHS;

  test(`e-process false-positive rate under optional stopping <= alpha (${(100 * eRate).toFixed(2)}% vs 5%)`, () => {
    ok(eRate <= ALPHA, `e-process FPR ${(100 * eRate).toFixed(2)}% must not exceed ${(100 * ALPHA).toFixed(0)}%`);
  });

  test(`the procedure it replaces inflates badly when peeked (${(100 * peekRate).toFixed(1)}% vs a nominal 5%)`, () => {
    ok(peekRate > 0.12, `naive peeking should inflate well past nominal; measured ${(100 * peekRate).toFixed(1)}%`);
  });

  test(`a single fixed-n look is calibrated, which is why the old bars insisted on exactly one (${(100 * fixedRate).toFixed(1)}%)`, () => {
    ok(fixedRate > 0.02 && fixedRate < 0.09, `one-look t>=2.0 should land near 5%, measured ${(100 * fixedRate).toFixed(1)}%`);
  });

  test("e-process is CONSERVATIVE, not merely calibrated — it spends less than its budget", () => {
    ok(eRate < ALPHA * 0.9, `expected headroom under alpha; got ${(100 * eRate).toFixed(2)}%`);
  });

  test("false crossings that do occur happen late, not on the first few observations", () => {
    const meanStop = eFalse ? eStopSum / eFalse : N;
    ok(meanStop > 5, `mean false-crossing index ${meanStop.toFixed(1)} should not be tiny`);
  });
});

suite("e-values · power and expected sample size — what the calendar actually buys", () => {
  const PATHS = 4000, N = 60, MU = 0.25;    // a real, tradeable session-gap effect

  let crossed = 0, stopSum = 0;
  for (let p = 0; p < PATHS; p++) {
    const x = normals(50000 + p, N, MU, SD);
    const r = bettingE(x, { alpha: ALPHA, clip: CLIP, oneSided: "greater" });
    if (r.rejected) { crossed++; stopSum += r.stoppedAt; }
  }
  const power = crossed / PATHS, meanStop = crossed ? stopSum / crossed : N;

  test(`detects a real effect (power ${(100 * power).toFixed(0)}% at mu=${MU})`, () => {
    // 2026-09-22 contract update (operator's word: "a"): the 09-09 asymmetric-clip fix (lib/evalue.js, "the honest price of validity") restored a
    // valid supermartingale — the old version's false-positive rate reached 10% against a 5% budget — and cut stake size on the losing side, so
    // power at this setting fell from >80% to a measured 69%. The test now locks the POST-FIX power; a drop below 60% means something else changed.
    ok(power > 0.6, `power ${(100 * power).toFixed(0)}% — post-fix contract is > 60% (measured 69% on 2026-09-22)`);
  });

  test(`and detects it EARLY — mean stop ${meanStop.toFixed(0)} of ${N} sessions`, () => {
    // 2026-09-22 contract update: post-fix mean stop is 44.7 of 60; the contract is that it still stops before the horizon.
    ok(meanStop < 50, `mean stopping time ${meanStop.toFixed(1)} — post-fix contract is < 50 of ${N} (measured 44.7 on 2026-09-22)`);
  });

  test("no effect means no growth — the process does not drift up on its own", () => {
    const flat = bettingE(new Array(60).fill(0), { alpha: ALPHA, clip: CLIP });
    close(flat.e, 1, 1e-9, "an all-zero sequence must leave the wealth exactly at 1");
  });
});

suite("e-values · the KILL side — a valid early death, which fixed-n cannot express", () => {
  // The first draft demanded a kill at MDE 0.10R by n=120 and failed — correctly. Measured CS
  // half-width at n=120 with sd 0.5 is ~0.13, so 0.10 is not rigorously excludable there; the
  // formula says ~185 sessions. The realistic board MDE is the ~0.20R cost hurdle, whose horizon
  // is ~46 sessions. The test now asks for the kill the machinery can honestly deliver.
  test("a genuinely null series rules out the cost-hurdle MDE within its predicted horizon", () => {
    const h = killHorizon({ sd: SD, mde: 0.20, alpha: ALPHA });
    ok(h > 30 && h < 70, `horizon for mde 0.20 / sd 0.5 should be ~46 sessions, formula gave ${h}`);
    const x = normals(777, 2 * h, 0, SD);          // twice the horizon: a comfortable margin, not a knife edge
    const v = sequentialVerdict(x, { alpha: ALPHA, clip: CLIP, mde: 0.20, minN: 20 });
    eq(v.verdict, "KILL", `expected KILL by 2x horizon; got ${v.verdict} — ${v.why}`);
    ok(v.cs.hi < 0.20, "upper confidence bound must be below the declared MDE");
  });

  test("the kill horizon formula matches the measured confidence-sequence width", () => {
    const x = normals(777, 250, 0, SD);
    const cs = confSeq(x, { alpha: ALPHA, clip: CLIP, gridN: 401 });
    const predictedHalf = SD * Math.sqrt((2 * Math.log(2 / ALPHA)) / 250);
    close((cs.hi - cs.lo) / 2, predictedHalf, 0.03, "measured half-width should track sd*sqrt(2ln(2/a)/n)");
  });

  test("a small MDE is honestly reported as slow, not quietly unreachable", () => {
    const h = killHorizon({ sd: SD, mde: 0.10, alpha: ALPHA });
    ok(h > 150, `mde 0.10 should need well over 150 sessions to kill; got ${h}`);
  });

  test("a real effect is NOT killed", () => {
    const x = normals(888, 120, 0.25, SD);
    const v = sequentialVerdict(x, { alpha: ALPHA, clip: CLIP, mde: 0.10, minN: 20 });
    eq(v.verdict, "PASS");
  });

  test("thin evidence returns CONTINUE rather than guessing either way", () => {
    const v = sequentialVerdict(normals(999, 8, 0, SD), { alpha: ALPHA, clip: CLIP, mde: 0.10, minN: 20 });
    eq(v.verdict, "CONTINUE");
  });

  test("a borderline effect at exactly the MDE is not killed — the boundary is not trigger-happy", () => {
    const x = normals(4242, 60, 0.10, SD);
    const v = sequentialVerdict(x, { alpha: ALPHA, clip: CLIP, mde: 0.10, minN: 20 });
    ok(v.verdict !== "KILL", `must not kill an effect sitting at the MDE; got ${v.why}`);
  });
});

suite("e-values · confidence sequence covers at ALL times, not just at the end", () => {
  const PATHS = 600, N = 40, MU = 0.15;
  let everMissed = 0;
  for (let p = 0; p < PATHS; p++) {
    const x = normals(20000 + p, N, MU, SD);
    let missed = false;
    // check coverage after every 5th observation — a fixed-n CI has no such guarantee
    for (let n = 10; n <= N && !missed; n += 5) {
      const cs = confSeq(x.slice(0, n), { alpha: ALPHA, clip: CLIP, gridN: 81 });
      if (!cs.empty && (MU < cs.lo || MU > cs.hi)) missed = true;
    }
    if (missed) everMissed++;
  }
  const miss = everMissed / PATHS;
  test(`time-uniform coverage holds (missed on ${(100 * miss).toFixed(1)}% of paths, budget 5%)`, () => {
    ok(miss <= ALPHA, `miss rate ${(100 * miss).toFixed(1)}% must not exceed alpha`);
  });
  test("the interval tightens as evidence accrues", () => {
    const x = normals(31337, 200, MU, SD);
    const early = confSeq(x.slice(0, 20), { alpha: ALPHA, clip: CLIP, gridN: 161 });
    const late = confSeq(x, { alpha: ALPHA, clip: CLIP, gridN: 161 });
    ok(late.width < early.width, `late width ${late.width?.toFixed(3)} should beat early ${early.width?.toFixed(3)}`);
  });
});

suite("e-values · eBH controls FDR under arbitrary dependence", () => {
  test("rejects the strong hypotheses and none of the nulls in a clean mix", () => {
    const ev = [1000, 500, 200, 1, 1, 1, 1, 1, 1, 1];
    const r = eBH(ev, 0.05);
    ok(r.nRejected >= 3, `expected the three strong e-values rejected; got ${r.nRejected}`);
    ok(r.rejected.every((i) => i < 3), "no null hypothesis may be rejected here");
  });
  test("rejects nothing when every hypothesis is null", () => {
    eq(eBH(new Array(200).fill(1), 0.05).nRejected, 0);
  });
  test("a single e-value must clear 1/alpha on its own", () => {
    eq(eBH([19], 0.05).nRejected, 0);
    eq(eBH([21], 0.05).nRejected, 1);
  });
  test("empty family is handled, not crashed", () => { eq(eBH([], 0.05).nRejected, 0); });
  test("FDR is respected on a 200-hypothesis family with 10 real effects", () => {
    // e-values built from real e-processes: 10 true effects, 190 nulls
    const ev = [];
    for (let i = 0; i < 10; i++) ev.push(bettingE(normals(60000 + i, 40, 0.3, SD), { alpha: ALPHA, clip: CLIP }).maxE);
    for (let i = 0; i < 190; i++) ev.push(bettingE(normals(70000 + i, 40, 0, SD), { alpha: ALPHA, clip: CLIP }).maxE);
    const r = eBH(ev, 0.05);
    const falseRejections = r.rejected.filter((i) => i >= 10).length;
    ok(r.nRejected === 0 || falseRejections / r.nRejected <= 0.25,
      `FDP ${r.nRejected ? (falseRejections / r.nRejected).toFixed(2) : 0} on ${r.nRejected} rejections`);
  });
});

suite("e-values · house rules are enforced, not assumed", () => {
  test("clipping is applied and its footprint is REPORTED, never silent", () => {
    const r = bettingE([0.1, 0.1, 9.9, 0.1], { clip: 2.0 });
    close(r.clippedFrac, 0.25, 1e-9, "one of four observations exceeded the declared bound");
  });
  test("an extreme observation cannot drive the wealth to zero (positivity holds)", () => {
    const r = bettingE([1.9, 1.9, 1.9, -1.9, -1.9, -1.9], { clip: 2.0 });
    ok(r.e > 0 && Number.isFinite(r.e), `wealth must stay positive and finite; got ${r.e}`);
  });
  test("the stake is predictable — the first observation is bet with a zero-information stake", () => {
    const r = bettingE([0.5], { clip: 2.0 });
    close(r.path[0].lambda, 0, 1e-12, "no data precedes the first observation, so the first stake must be 0");
    close(r.e, 1, 1e-12, "and therefore the first observation cannot move the wealth");
  });
  test("non-finite observations are dropped rather than poisoning the product", () => {
    const r = bettingE([0.2, NaN, 0.2, null, undefined, 0.2], { clip: 2.0 });
    eq(r.n, 3);
    ok(Number.isFinite(r.e));
  });
  test("empty input is valid and neutral", () => {
    const r = bettingE([], { clip: 2.0 });
    eq(r.n, 0); close(r.e, 1, 1e-12); eq(r.rejected, false); eq(r.stoppedAt, null);
  });
  test("rejection is keyed on the RUNNING MAX — evidence that peaked still counts", () => {
    // a path that crosses and then decays must remain rejected; Ville bounds the supremum
    const x = [0, 1.9, 1.9, 1.9, 1.9, 1.9, 1.9, -1.9, -1.9, -1.9, -1.9, -1.9];
    const r = bettingE(x, { alpha: ALPHA, clip: 2.0 });
    if (r.maxE >= r.threshold) { ok(r.rejected, "must stay rejected once the supremum crossed"); ok(r.stoppedAt != null); }
    else ok(true, "path did not cross; nothing to assert");
  });
  test("one-sided 'greater' never bets on the wrong direction", () => {
    const r = bettingE(normals(5150, 40, -0.4, SD), { alpha: ALPHA, clip: CLIP, oneSided: "greater" });
    ok(r.path.every((p) => p.lambda >= 0), "a positive-direction test must not profit from negative drift");
    ok(!r.rejected, "and must not reject on evidence pointing the other way");
  });
});
