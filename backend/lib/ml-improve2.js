/**
 * ML IMPROVE — ATTEMPT #2 (2026-08-26): RANK WITHIN DIRECTION, NOT ACROSS IT.
 *
 * WHY MLI-1 IS NOT REPEATED. The equity-only structural ridge failed on 2026-08-25 (day-corr t
 * -1.79, p 0.0998) and again on 2026-08-26 (t -1.71, p 0.0998), on a ledger that gained no new
 * settled rows in between. A third identical read of unchanged data is not an attempt. Its code and
 * its bar in lib/ml-improve.js are left exactly as they were written rather than retro-fitted —
 * while re-reading it, a defect did surface (its condition (a) compared |t| against |t|, so a
 * NEGATIVE day-correlation could in principle have satisfied it), but it never did satisfy it, no
 * proposal was ever written off that path, and moving a bar after the evidence is the one thing this
 * apparatus is built to prevent. It is recorded, not rewritten.
 *
 * WHAT THIS ATTEMPT IS. Measured on the model rows this run: longs average +0.0548R, shorts
 * -0.0930R, the within-day long-minus-short gap is +0.1735R (t 1.72 over 22 sessions), and every one
 * of those 22 sessions carries BOTH directions. Any model with `dir` in its design matrix can post a
 * day-clustered correlation off that single fact alone. But a board that has already chosen its
 * direction gains nothing from being told the choice back. The narrower, actually actionable
 * question is: HOLDING DIRECTION FIXED, does the standing ridge rank tickets within a session?
 *
 * The shadow rule is one a live board could run at the open: inside each session, inside each
 * direction, drop the bottom half by predicted R. It never needs a later cross-section, it never
 * reverses a direction call, and it only ever REMOVES tickets — so it adds no crossing cost, and any
 * lift is net of the cost the dropped tickets were already paying.
 *
 * THE BAR IS FIXED HERE, IN CODE, BEFORE THE EVIDENCE IS READ. All three must hold:
 *   (a) one-sided permutation p < 0.05 on the within-direction day-clustered correlation, against a
 *       null shuffled within DAY x DIRECTION — the long/short asymmetry stays in the null, so it
 *       cannot be sold back as skill; and the correlation itself must be POSITIVE
 *   (b) the per-session mean-R lift of the kept book over the whole book has t >= 2.0 — this shop's
 *       standing significance bar, on the SESSION as the unit of observation
 *   (c) at least 10 scored sessions
 * Two of three is a fail. Clearing makes it a PROPOSAL for the operator, never a board change.
 */
const BAR2 = {
  permutationP_oneSided: 0.05,
  minLiftT: 2.0,
  minScoredSessions: 10,
  nullShuffle: "day x direction",
  fixedAt: "2026-08-26, before any result was computed",
  statedAs: "all three, jointly. Two of three is a fail.",
};

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));
const corr = (a, b) => {
  const n = a.length; if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return sa && sb ? s / Math.sqrt(sa * sb) : null;
};

/**
 * @param rows  model-eligible rows, indexed identically to `pred`
 * @param et    ms -> ET calendar day
 * @param pred  the standing pooled ridge's out-of-sample predictions (null where a row was not scored)
 */
function withinDirectionRankShadow(rows, et, pred) {
  if (!pred) return { attempted: false, reason: "no standing model predictions supplied" };
  const idx = rows.map((_, i) => i).filter((i) => pred[i] != null);
  if (idx.length < 100) return { attempted: false, reason: `only ${idx.length} out-of-sample predictions — below the 100 needed` };

  const y = rows.map((t) => t.rMult);
  const day = rows.map((t) => et(t.openedAt));
  const dir = rows.map((t) => (t.dir > 0 ? 1 : -1));

  // Strata are (session, direction). The SESSION remains the unit of inference: per-direction
  // correlations are averaged INSIDE a session first, then a t is taken across sessions. The long
  // leg and the short leg of one day are the same day's tape; counting them as two observations is
  // the effective-N inflation this shop has already been burned by three times.
  const strata = {};
  for (const i of idx) (strata[day[i] + "|" + dir[i]] ||= []).push(i);
  const bySess = {};
  for (const i of idx) (bySess[day[i]] ||= []).push(i);

  /** mean within-direction correlation per session -> {t, n, mean, perSession} */
  function withinDirCorr(labels) {
    const per = [];
    for (const [d, ids] of Object.entries(bySess)) {
      const cs = [];
      for (const s of [1, -1]) {
        const g = ids.filter((i) => dir[i] === s);
        if (g.length < 5) continue;                      // a 4-ticket leg cannot carry a correlation
        const c = corr(g.map((i) => pred[i]), g.map((i) => labels[i]));
        if (c != null) cs.push(c);
      }
      if (cs.length) per.push({ day: d, c: r4(mean(cs)), legs: cs.length, n: ids.length });
    }
    if (per.length < 2) return { t: null, n: per.length, mean: null, perSession: per };
    const cs = per.map((p) => p.c), s = sd(cs), se = s / Math.sqrt(cs.length);
    return { t: se > 0 ? mean(cs) / se : null, n: cs.length, mean: mean(cs), perSession: per };
  }
  const real = withinDirCorr(y);

  // ── null: labels shuffled within DAY x DIRECTION, so the long/short gap survives into the null ──
  let seed = 20260826, ge = 0; const nullTs = [];
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let tr = 0; tr < 400; tr++) {
    const sh = y.slice();
    for (const ids of Object.values(strata)) {
      const vals = ids.map((i) => y[i]);
      for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
      ids.forEach((i, k) => { sh[i] = vals[k]; });
    }
    const nt = withinDirCorr(sh).t;
    if (nt != null) { nullTs.push(nt); if (nt >= (real.t ?? 0)) ge++; }  // upper tail: skill has a sign
  }
  const pval = nullTs.length ? (ge + 1) / (nullTs.length + 1) : null;
  const sortedNull = [...nullTs].sort((a, b) => a - b);
  const t95 = sortedNull.length ? sortedNull[Math.min(sortedNull.length - 1, Math.floor(sortedNull.length * 0.95))] : null;

  // ── the shadow book: keep the top half by prediction INSIDE each (session, direction) ──
  const keep = new Set();
  for (const ids of Object.values(strata)) {
    const ord = [...ids].sort((a, b) => pred[b] - pred[a]);
    for (const i of ord.slice(0, Math.max(1, Math.floor(ord.length / 2)))) keep.add(i);
  }
  const winPct = (a) => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : null);
  const bookR = idx.map((i) => y[i]);
  const keptR = [...keep].map((i) => y[i]);
  const dropR = idx.filter((i) => !keep.has(i)).map((i) => y[i]);
  // per-session difference, kept minus that session's whole book — the honest unit again
  const perSessDiff = Object.values(bySess).map((ids) => {
    const k = ids.filter((i) => keep.has(i));
    return k.length && ids.length ? mean(k.map((i) => y[i])) - mean(ids.map((i) => y[i])) : null;
  }).filter(Number.isFinite);
  const dsd = sd(perSessDiff), dse = dsd != null ? dsd / Math.sqrt(perSessDiff.length) : null;
  const liftT = dse > 0 ? mean(perSessDiff) / dse : null;

  const shadow = {
    bookTickets: idx.length, bookMeanR: r4(mean(bookR)), bookWinPct: r2(winPct(bookR)),
    keptTickets: keep.size, keptMeanR: r4(mean(keptR)), keptWinPct: r2(winPct(keptR)),
    droppedTickets: dropR.length, droppedMeanR: r4(mean(dropR)), droppedWinPct: r2(winPct(dropR)),
    meanRLift: r4(mean(keptR) - mean(bookR)), winPctLift: r2(winPct(keptR) - winPct(bookR)),
    liftPerSessionMean: r4(mean(perSessDiff)), liftPerSessionSe: r4(dse),
    liftT: r2(liftT), liftSessions: perSessDiff.length,
    costNote: "The rule only REMOVES tickets, so it adds no crossing cost; a positive lift is net of the cost the dropped tickets were already paying. It does NOT model the cost of the tickets it keeps.",
  };

  const conds = {
    a_permutationP_oneSided: {
      need: `< ${BAR2.permutationP_oneSided} and day-corr t > 0`,
      got: `p ${r4(pval)}, t ${r2(real.t)}`,
      pass: pval != null && pval < BAR2.permutationP_oneSided && (real.t ?? 0) > 0,
    },
    b_liftT: { need: `>= ${BAR2.minLiftT}`, got: r2(liftT), pass: Number.isFinite(liftT) && liftT >= BAR2.minLiftT },
    c_scoredSessions: { need: `>= ${BAR2.minScoredSessions}`, got: real.n, pass: real.n >= BAR2.minScoredSessions },
  };
  const cleared = Object.values(conds).every((c) => c.pass);

  return {
    attempted: true, id: "MLI-2-within-direction-rank", bar: BAR2, cleared, conditions: conds,
    rowsScored: idx.length, strataCount: Object.keys(strata).length,
    dayCorrMean: r4(real.mean), dayCorrT: r2(real.t), scoredSessions: real.n,
    permutationP: r4(pval), permutationSided: "one (upper tail)", nullT95: r2(t95), nullTrials: nullTs.length,
    perSession: real.perSession,
    shadow,
    effectiveN: `${real.n} scored sessions — NOT ${idx.length} tickets, and NOT ${Object.keys(strata).length} (session, direction) strata. The session is the observation.`,
    read: cleared
      ? "CLEARS the pre-set bar — proposal written to alpha-hunt-queue.json for the operator to register. Not enforced, not registered, and one clean-era pass is a MOTIVATING SAMPLE, not a validated edge."
      : `DOES NOT clear. ${Object.entries(conds).filter(([, c]) => !c.pass).map(([k]) => k).join(", ")} failed. Recorded so the attempt is not silently repeated.`,
  };
}

module.exports = { withinDirectionRankShadow, BAR2 };
