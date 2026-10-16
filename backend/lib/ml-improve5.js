/**
 * MLI-5 — GBM TOP-DECILE REFUSAL.  Minted 2026-09-04 by the daily ML pass.  SHADOW ONLY.
 *
 * THE OBSERVATION IT IS BUILT ON. The standing GBM has been reliably ANTI-predictive for three
 * consecutive reads (day-corr t -2.27 / -2.31 / -2.09; two-sided permutation p 0.005 / 0.0025 /
 * 0.005 against a day x direction null, 22 sessions). Those three reads are NOT three independent
 * observations — they are the same ~22 sessions re-read with one or two sessions added each night.
 * Treat it as ONE observation with |t| ~ 2.1.
 *
 * The ridge twins over the same rows sit at t -0.37 and -0.25 — essentially zero. A label-sign
 * defect would push BOTH learners symmetrically negative; only the two GBM variants are negative.
 * That signature is depth-2 boosting fitting session-local structure that reverses out of sample,
 * not a bug in the label. This file therefore does NOT propose inverting the model into a signal:
 * inverting a noise-chaser buys noise. It proposes the strictly weaker, strictly defensive claim —
 * that the tickets the overfit model likes MOST are the ones worth refusing.
 *
 * ONE THRESHOLD, NOT A GRID. MLI-3 was disqualified from the queue because its threshold grid was
 * scoped on the same rows the bar was later read against. The decile is fixed a priori here — it is
 * the unit modelMetrics() already reports its spread in — and exactly one number is graded. No grid
 * is printed, because printing one is how a scoped threshold sneaks back in.
 *
 * WITHIN-SESSION RANK, NOT GLOBAL. A live gate sees one day's candidates and must refuse from among
 * them. Ranking globally would let it refuse a whole quiet session, which no live gate can do.
 *
 * THE BAR IS PROSPECTIVE. The retro read below is a MOTIVATING SAMPLE and may not clear anything.
 */
const BAR = {
  id: "MLI-5-gbm-top-decile-refusal",
  minted: "2026-09-04",
  evidenceStart: "2026-09-05",       // fixed BEFORE any evidence was read
  a_liftT: 2.0,                       // per-session mean-R lift of survivors over the full book
  b_scoredSessions: 15,
  c_refusedEpisodes: 30,               // 2026-09-04: EPISODES (distinct cls|openedAt|closedAt|dir), not tickets — 62 historical refusals were 42 episodes
  d_motivationPersists: -1.5,         // GBM day-corr t must still be <= this at the read
};

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));

/**
 * @param rows      the model rows, in the same order as `pred`
 * @param pred      walk-forward OOS prediction per row (null where not forward-scored)
 * @param dayOf     row -> ET session string
 * @param gbmDayCorrT  the motivating statistic at this read
 * @param sinceDay  only sessions >= this string count as EVIDENCE; earlier ones are motivating
 */
function grade(rows, pred, dayOf, gbmDayCorrT, sinceDay) {
  const scored = rows.map((t, i) => ({ t, i })).filter((o) => pred[o.i] != null && !o.t.ctrl && Number.isFinite(o.t.rMult));
  const byDay = {};
  for (const o of scored) (byDay[dayOf(o.t)] ||= []).push(o);

  const perSession = [], refusedCells = [];
  let refusedN = 0, refusedR = 0;
  // 2026-09-04 (ML lens): the pooled cross-class daily ranking had NO ranking on 12 of 19 sessions — the GBM emitted one identical
  // score for every ticket that day, so ord.slice(-cut) was the tail of ledger insertion order (2026-08-20 refused three crypto tickets
  // all at exactly -1.00R: one basket). Now: rank WITHIN (day x class), require >= 10 rows per cell, and refuse any cell whose decile
  // boundary sits inside a tie block — recorded with its reason, never dropped silently (traids-server-v2.js:1719 shipped the same fix).
  for (const day of Object.keys(byDay).sort()) {
    const byCls = {}; for (const o of byDay[day]) (byCls[o.t.cls || "?"] ||= []).push(o);
    const cells = [], refusedKeys = [];
    for (const [cls, ids] of Object.entries(byCls)) {
      if (ids.length < 10) continue;             // a decile of <10 is one ticket; not a decile
      const ord = [...ids].sort((a, b) => pred[a.i] - pred[b.i]);
      const cut = Math.max(1, Math.round(ord.length / 10));
      const bnd = pred[ord[ord.length - cut].i], below = pred[ord[ord.length - cut - 1].i];
      if (!(Math.abs(bnd - below) > 1e-9)) { refusedCells.push({ day, cls, n: ids.length, why: "decile boundary inside a tie block — the model produced no ranking here" }); continue; }
      const refused = ord.slice(-cut), kept = ord.slice(0, ord.length - cut);
      if (!kept.length) continue;
      cells.push({ cls, n: ids.length, full: mean(ids.map((o) => o.t.rMult)), surv: mean(kept.map((o) => o.t.rMult)), refused });
      for (const o of refused) refusedKeys.push([o.t.cls, o.t.openedAt, o.t.closedAt, o.t.dir].join("|"));
      refusedN += refused.length; refusedR += refused.reduce((s, o) => s + o.t.rMult, 0);
    }
    if (!cells.length) continue;
    const lift = mean(cells.map((c) => c.surv - c.full));
    perSession.push({ day, n: cells.reduce((s, c) => s + c.n, 0), cells: cells.length, refused: cells.reduce((s, c) => s + c.refused.length, 0), refusedKeys, fullR: r4(mean(cells.map((c) => c.full))), survR: r4(mean(cells.map((c) => c.surv))), liftR: r4(lift), refusedR: r4(mean(cells.flatMap((c) => c.refused.map((o) => o.t.rMult)))) });
  }

  const ev = perSession.filter((p) => p.day >= sinceDay);
  const stat = (ps) => {
    const xs = ps.map((p) => p.liftR).filter(Number.isFinite);
    const s = sd(xs), se = s != null && xs.length ? s / Math.sqrt(xs.length) : null;
    return { sessions: xs.length, meanLiftR: r4(mean(xs)), t: se ? r4(mean(xs) / se) : null };
  };
  const motivating = stat(perSession), evidence = stat(ev);
  const evRefusedN = ev.reduce((s, p) => s + p.refused, 0);

  const checks = {
    a_liftT: { need: BAR.a_liftT, got: evidence.t, pass: evidence.t != null && evidence.t >= BAR.a_liftT },
    b_scoredSessions: { need: BAR.b_scoredSessions, got: evidence.sessions, pass: evidence.sessions >= BAR.b_scoredSessions },
    c_refusedEpisodes: { need: BAR.c_refusedEpisodes, got: new Set(ev.flatMap((p) => p.refusedKeys || [])).size, pass: new Set(ev.flatMap((p) => p.refusedKeys || [])).size >= BAR.c_refusedEpisodes },
    d_motivationPersists: { need: BAR.d_motivationPersists, got: gbmDayCorrT, pass: gbmDayCorrT != null && gbmDayCorrT <= BAR.d_motivationPersists },
  };
  const cleared = Object.values(checks).every((c) => c.pass);
  return {
    bar: BAR, checks, cleared,
    motivatingSample: { ...motivating, refusedTickets: refusedN, refusedTotalR: r4(refusedR),
      note: "sessions BEFORE evidenceStart. Motivating only — the model that produced these predictions was itself selected by having been read on these same rows." },
    evidence: { ...evidence, refusedTickets: evRefusedN, sessions_list: ev.map((p) => p.day) },
    perSession,
    effectiveN: `${evidence.sessions} evidence session(s) — NOT ${evRefusedN} refused tickets. A decile refusal removes correlated names on the same day.`,
  };
}
module.exports = { BAR, grade };
