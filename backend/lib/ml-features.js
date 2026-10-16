/**
 * ML FEATURES — which observers carry PER-TICKET information, decided by structure, never by outcome.
 * 2026-09-01, operator's decision ("1 2 3"): prune the feature set.
 *
 * THE DEFECT THIS FIXES. The nightly learners (ml-daily.js, model-bakeoff.js) take every observer
 * with >= 30% coverage as a feature: 43 of them tonight. Measured on the model rows, 22 of the 43
 * have ONE distinct value per session — vix, y10, curve, gold20, oil20, btc20, breadth50, credit20,
 * regimeId, rv20, spyVs50, mktGap, sbCorr, hygSpy20, btcCorr20, econSent, macroDaysOut, stampLagMin,
 * econNews, polSent, polNews, y10chg20. Their within-session variance share is 0.000 to 0.026.
 *
 * Those are market-level fields. Inside a session every ticket carries the same value, so across
 * 2,177 rows they contribute 28 data points each — one per session — while consuming a coefficient
 * (two, in the ridge: value + missing indicator) and a split candidate in every tree. With 28
 * sessions that is not a feature, it is a session fixed effect the model cannot possibly learn and
 * will happily overfit. The tell was in the diagnostic: nine of them share an identical
 * within-session rho of -0.115 (t -2.7) — the same coverage set, the same class-mix artifact, no
 * information about which ticket to take.
 *
 * THE RULE, AND WHY IT IS OUTCOME-BLIND. A feature is PER-TICKET if
 *     within-session variance share >= MIN_WITHIN   (default 0.50)
 *     AND median distinct values per session >= MIN_DISTINCT   (default 2)
 *     AND coverage >= the learner's own bar (30%)
 * Nothing about rMult enters the selection. Choosing features by their correlation with the target
 * would be a search, and every downstream model read would then owe a best-of-N bar it could never
 * clear. Structure is knowable without looking at a single outcome.
 *
 * WHAT HAPPENS TO THE MARKET-LEVEL FIELDS. They are not deleted. They belong to a SESSION-level
 * model — one row per session — which at 28 sessions cannot be fitted honestly. They are reported
 * here as `heldOut` with the session count that would make them fittable, and the regime work
 * (market-regime-archivist, bear gauge) is where they already live.
 *
 * The learners keep fitting the FULL set alongside the pruned set. The two are reported side by
 * side so the change is additive and the pruned models' forward record starts tonight, comparable
 * to the full models' record that already exists.
 */
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

const MIN_WITHIN = 0.5, MIN_DISTINCT = 2;

/** Per-feature structure on a row set. `etDay(t)` gives the session key; `feats` the candidate list. */
function structure(rows, feats, etDay) {
  const out = [];
  for (const k of feats) {
    const bySess = {};
    for (const t of rows) if (t.obs && Number.isFinite(t.obs[k])) (bySess[etDay(t)] ||= []).push(t.obs[k]);
    const all = Object.values(bySess).flat();
    if (!all.length) { out.push({ feat: k, n: 0, withinShare: null, medDistinctPerSession: 0, perTicket: false }); continue; }
    const gm = mean(all);
    const tot = all.reduce((s, x) => s + (x - gm) ** 2, 0);
    let within = 0; const distinct = [];
    for (const xs of Object.values(bySess)) { const m = mean(xs); within += xs.reduce((s, x) => s + (x - m) ** 2, 0); distinct.push(new Set(xs).size); }
    distinct.sort((a, b) => a - b);
    const medDistinct = distinct[Math.floor(distinct.length / 2)];
    const withinShare = tot > 0 ? within / tot : 0;
    out.push({ feat: k, n: all.length, sessions: Object.keys(bySess).length, withinShare: +withinShare.toFixed(3), medDistinctPerSession: medDistinct,
      perTicket: withinShare >= MIN_WITHIN && medDistinct >= MIN_DISTINCT });
  }
  return out;
}

/** The pruned list: features that vary within a session. Same coverage bar as the caller's full list. */
function perTicket(rows, feats, etDay) {
  const st = structure(rows, feats, etDay);
  const keep = st.filter((s) => s.perTicket).map((s) => s.feat).sort();
  const heldOut = st.filter((s) => !s.perTicket).map((s) => s.feat).sort();
  return { keep, heldOut, structure: st, rule: { MIN_WITHIN, MIN_DISTINCT, outcomeBlind: true,
    why: "within-session variance share and distinct-values-per-session are computable without any outcome; selecting on correlation with rMult would be a search and would owe a best-of-N bar" } };
}

module.exports = { structure, perTicket, MIN_WITHIN, MIN_DISTINCT };
