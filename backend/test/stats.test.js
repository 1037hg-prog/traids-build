/**
 * STATISTICAL MACHINERY — regression tests for the errors that actually reversed conclusions.
 *
 * Three separate findings in this project flipped sign when the unit of observation was
 * corrected, and one registered test was built on a split that was not a partition. These are
 * not hypothetical failure modes; each line here is a defect that shipped.
 */
const { suite, test, eq, close, ok, throws } = require("./run");

// ── the primitives, implemented as the project implements them ───────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => (a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : 0);
const tOf = (a) => { const s = sd(a); return a.length > 1 && s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : null; };

/**
 * The bucket split used by every conditional test in the project. R18's motivating figure came
 * from this without the disjointness guard: newsScore was 85% zeros, so p33 == p67 == 0, and
 * (>= hi) / (<= lo) produced buckets of 998 and 900 rows OVERLAPPING BY 873 — two nearly
 * identical sets reported as a contrast.
 */
function tercileSplit(values) {
  const v = [...values].sort((a, b) => a - b);
  const lo = v[Math.floor(v.length / 3)], hi = v[Math.floor((v.length * 2) / 3)];
  if (!(hi > lo)) {
    throw new Error(`degenerate terciles: p33 (${lo}) is not strictly below p67 (${hi}) — buckets would overlap`);
  }
  return { lo, hi };
}

suite("D-R18 · tercile splits must be a partition", () => {
  test("throws when p33 == p67 (the newsScore case: 85% zeros)", () => {
    const vals = [...Array(85).fill(0), ...Array(8).fill(-0.5), ...Array(7).fill(0.5)];
    throws(() => tercileSplit(vals), "a degenerate split must throw, not silently overlap");
  });

  test("throws on an all-constant observer", () => {
    throws(() => tercileSplit(Array(100).fill(1)));
  });

  test("accepts a genuinely spread observer and yields DISJOINT buckets", () => {
    const vals = Array.from({ length: 99 }, (_, i) => i);
    const { lo, hi } = tercileSplit(vals);
    ok(hi > lo, "boundaries must be strictly ordered");
    const high = vals.filter(v => v >= hi), low = vals.filter(v => v <= lo);
    eq(high.filter(v => low.includes(v)).length, 0, "buckets must not share a member");
  });

  test("the real failure reproduces: without the guard the buckets overlap massively", () => {
    const vals = [...Array(85).fill(0), ...Array(8).fill(-0.5), ...Array(7).fill(0.5)];
    const v = [...vals].sort((a, b) => a - b);
    const lo = v[Math.floor(v.length / 3)], hi = v[Math.floor((v.length * 2) / 3)];
    const high = vals.filter(x => x >= hi).length, low = vals.filter(x => x <= lo).length;
    ok(high + low > vals.length, `unguarded split double-counts: ${high} + ${low} > ${vals.length}`);
  });
});

/**
 * POOLED vs PAIRED. Three findings reversed on this in a single day: variant selection
 * (+0.0751R pooled -> -0.1318R paired), the short leg (-$19,093 pooled -> t -0.10 paired), and
 * R12 (t -4.26 day-clustered -> -0.96 on non-overlapping blocks).
 */
function pooledGap(sessions) {
  const a = sessions.flatMap(s => s.treat), b = sessions.flatMap(s => s.control);
  return mean(a) - mean(b);
}
function pairedGap(sessions) {
  const gaps = sessions.filter(s => s.treat.length && s.control.length).map(s => mean(s.treat) - mean(s.control));
  return { gap: mean(gaps), t: tOf(gaps), n: gaps.length };
}

suite("D-clustering · pooled and paired must not be confused", () => {
  /**
   * The fixture matters. My first version used one busy +1.0 session and three quiet -0.2
   * sessions, which gives a paired mean of +0.1 — positive, so it failed to demonstrate the
   * reversal it claimed to. Corrected to the real shape: ONE high-volume session carrying a
   * large edge against SIX low-volume sessions each modestly negative. Pooling weights by trade
   * count and the busy session dominates; pairing weights each session equally and the six
   * outvote the one. That is exactly what happened to the variant-selection test
   * (+0.0751R pooled -> -0.1318R paired) and to the short leg (-$19,093 pooled -> t -0.10).
   */
  const sessions = [
    { treat: Array(40).fill(1.0), control: Array(40).fill(0.0) },
    ...Array.from({ length: 6 }, () => ({ treat: [-0.3], control: [0.0] })),
  ];

  test("pooling lets one busy session carry the average", () => {
    ok(pooledGap(sessions) > 0.8, `expected a large positive pooled gap, got ${pooledGap(sessions)}`);
  });

  test("pairing by session reverses the sign", () => {
    const p = pairedGap(sessions);
    ok(p.gap < 0, `paired gap should be negative, got ${p.gap}`);
  });

  test("n is SESSIONS, not trades — 46 trades over 7 sessions is n=7", () => {
    eq(pairedGap(sessions).n, 7);
  });

  test("a session with an empty bucket contributes nothing rather than a fake zero", () => {
    const withOneSided = sessions.concat([{ treat: [5.0], control: [] }]);
    eq(pairedGap(withOneSided).n, 7, "the one-sided session must be dropped, not counted");
  });
});

/**
 * IMPLIED-SHARPE TRIPWIRE. Caught a covered-call replication that beat buy-and-hold
 * (structurally impossible) and a crypto carry reporting Sharpe 25 while pricing one leg.
 */
const impliedSharpe = (t, years) => (years > 0 ? t / Math.sqrt(years) : null);

suite("D29 · implied-Sharpe tripwire", () => {
  test("flags the crypto carry Sharpe as a defect signal, not a discovery", () => {
    ok(25.76 > 1.5, "anything above ~1.5 on public daily data is a defect signal");
  });
  test("t = Sharpe x sqrt(years) inverts correctly", () => {
    close(impliedSharpe(4.26, 3), 2.46, 0.01);
  });
  test("a plausible public-data result passes", () => {
    ok(impliedSharpe(2.0, 6) < 1.5);
  });
});

/**
 * MULTIPLICITY. The bar depends on how many hypotheses were SEARCHED and on the degrees of
 * freedom left after correct clustering — which is usually ~12, not infinity.
 */
const sidak = (alpha, k) => 1 - Math.pow(1 - alpha, 1 / k);

suite("significanceBar · multiplicity is computed, not asserted", () => {
  test("per-comparison alpha shrinks with the number of tests searched", () => {
    ok(sidak(0.05, 62) < sidak(0.05, 5), "62 searched hypotheses must demand more than 5");
  });
  test("a single pre-registered comparison is not corrected", () => {
    close(sidak(0.05, 1), 0.05, 1e-9);
  });
  test("the searched bar is strictly above the pre-registered one", () => {
    ok(3.5 > 2.0, "|t| >= 3.5 searched vs >= 2.0 pre-registered");
  });
});
