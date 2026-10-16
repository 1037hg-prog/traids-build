/**
 * TRAIDS — post-mortem analysis library. Canonical compute for the /api/postmortem
 * endpoint (which the Edge Ledger's Lessons panel polls after every settle) and the
 * richer CLI report (backend/trade-postmortem.js).
 *
 * DESIGN RULE: this measures; it never decides. "Every trade gets smarter" means every
 * settle advances these evidence meters — a rule CHANGE only happens when a
 * pre-registered trigger fires, and then via the approval queue, never silently.
 */
const CLEAN_EPOCH = new Date("2026-07-10T00:00:00").getTime();
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const summarize = (set) => {
  const r = set.map(t => t.rMult);
  return { n: r.length, win: r.length ? +(r.filter(v => v > 0).length / r.length * 100).toFixed(1) : null,
           avgR: r.length ? +mean(r).toFixed(3) : null, totR: +r.reduce((s, v) => s + v, 0).toFixed(2) };
};

function analyze(log) {
  const all = (log || []).filter(t => Number.isFinite(t.rMult));
  const clean = all.filter(t => t.closedAt >= CLEAN_EPOCH);
  const dirty = all.filter(t => t.closedAt < CLEAN_EPOCH);

  // exit anatomy (clean era — the era that counts)
  const exits = {};
  for (const t of clean) { const k = t.reason || "?"; (exits[k] = exits[k] || []).push(t); }
  const exitRows = Object.entries(exits).map(([k, set]) => ({ reason: k, ...summarize(set) })).sort((a, b) => b.n - a.n);

  // ── CANDIDATE 1 — exit rule: 1R take-profit vs 2R ride. RESOLVED 2026-07-14 by
  // backend/lesson-replay.js: 52,325 paired historical trades say 2R-RIDE WINS
  // (gap −0.0052R, day-clustered t = −4.60, CI excludes zero). The forward +0.042R
  // at n=24 was noise. NO RULE CHANGE. The meter keeps running purely as a monitor —
  // if forward data ever contradicts history at scale, we'd want to know.
  const abClean = clean.filter(t => Number.isFinite(t.rMultTP));
  const abAll   = all.filter(t => Number.isFinite(t.rMultTP));
  const gap = set => set.length ? +mean(set.map(t => t.rMultTP - t.rMult)).toFixed(4) : null;
  const cand1 = {
    name: "Exit rule: take profit at 1R (vs ride to 2R)",
    trigger: "RESOLVED by replay — keep 2R ride",
    resolved: "REJECTED — 52,325 historical paired trades favor riding to 2R (t = −4.60). Forward flicker was noise.",
    nClean: abClean.length, nNeeded: 100,
    gapClean: gap(abClean), gapAllHistory: gap(abAll),
    replayGap: -0.0052, replayN: 52325,
  };

  // ── CANDIDATE 2 — 5-day run-up entry filter. RESOLVED 2026-07-14 by the same replay:
  // the high-run-up bucket actually did marginally BETTER (+0.0079R vs low bucket) —
  // the opposite sign to the forward flicker. NO FILTER. Monitor only.
  const obs = clean.filter(t => t.obs && t.obs.revRet5 != null);
  let cand2 = {
    name: "Entry filter: skip/penalize after a 5-day run-up",
    trigger: "RESOLVED by replay — no filter",
    resolved: "REJECTED — across 52,325 trades, run-ups did NOT hurt (gap +0.0079R, wrong sign vs the hypothesis).",
    nClean: obs.length, nNeeded: 100, gapClean: null, replayGap: +0.0079, replayN: 52325,
  };
  if (obs.length >= 10) {
    const sorted = [...obs].sort((a, b) => a.obs.revRet5 - b.obs.revRet5);
    const lo = sorted.slice(0, Math.floor(sorted.length / 3)), hi = sorted.slice(-Math.floor(sorted.length / 3));
    cand2.gapClean = +(mean(hi.map(t => t.rMult)) - mean(lo.map(t => t.rMult))).toFixed(3);   // negative = run-ups hurt
  }

  // ── CANDIDATE 3 (NEW, from the replay's excursion data) — the trade STRUCTURE itself.
  // Only 0.6% of 1-day holds ever touch +2R and 5.3% touch +1R: the target is nearly
  // unreachable and the stop nearly untouched, so ~95% of trades are really just
  // "enter at close, exit at next close" — the R framework is decoration on a daily
  // directional bet. The open question is whether a LONGER HOLD lets the structure work.
  const withE = clean.filter(t => Number.isFinite(t.mfe));
  const cand3 = {
    name: "Trade structure: is the 2R target reachable at all?",
    trigger: "replay hold-period sweep (queued) + live MFE distribution at n ≥ 100",
    nClean: withE.length, nNeeded: 100,
    gapClean: withE.length ? +(withE.filter(t => t.mfe >= 2).length / withE.length * 100).toFixed(1) : null,
    note: "% of live trades whose best excursion reached +2R. Replay says 0.6% on a 1-day hold.",
  };

  // concentration (clean era)
  const byDay = {};
  for (const t of clean) { const d = new Date(t.closedAt).toDateString(); (byDay[d] = byDay[d] || []).push(t.rMult); }
  const days = Object.keys(byDay).length;

  return {
    asOf: new Date().toISOString(),
    total: all.length,
    clean: summarize(clean),
    preFix: summarize(dirty),
    exitRows,
    candidates: [cand1, cand2, cand3],
    control: (() => {                       // signal vs control (clean era)
      const sig = clean.filter(t => !t.ctrl).map(t => t.rMult);
      const ctl = clean.filter(t => t.ctrl).map(t => t.rMult);
      return { nSignal: sig.length, nControl: ctl.length,
               signalAvgR: sig.length ? +mean(sig).toFixed(4) : null,
               controlAvgR: ctl.length ? +mean(ctl).toFixed(4) : null,
               edge: (sig.length && ctl.length) ? +(mean(sig) - mean(ctl)).toFixed(4) : null };
    })(),
    concentration: { trades: clean.length, days, perDay: days ? +(clean.length / days).toFixed(1) : null },
  };
}

module.exports = { analyze, CLEAN_EPOCH };
