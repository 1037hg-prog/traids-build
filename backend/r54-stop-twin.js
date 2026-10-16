#!/usr/bin/env node
/**
 * R54 — THE STOP-WIDTH TWIN (registered 2026-08-25, twins from 2026-08-26).
 *
 * Cost in R is round-trip spread divided by stop distance, so a tighter stop mechanically
 * multiplies cost in R without changing anything about the signal. The board's equity stop runs
 * ~4.6% of price against a measured round-trip spread of ~0.23%, giving ~0.07R of cost per row
 * where gross edge is approximately zero. R54 asks whether the stop is set where it is for a
 * reason or by inheritance.
 *
 * THE TWIN: every Trend / Mean-Reversion / Ensemble signal in EQUITY and CRYPTO entered on or
 * after 2026-08-26, identical in symbol, direction, entry and timing, with ONE difference — the
 * stop distance is multiplied by 1.5x and size is scaled DOWN so dollar risk is held constant.
 * FX and Futures are excluded by the registration: their gross edge is already negative
 * (-0.0607R and -0.1136R) and a conclusion already negative gross of costs cannot be reversed by
 * any cost assumption.
 *
 * HOW THE TWIN IS RESOLVED, and where it honestly cannot be.
 * Let S be the origin stop distance, A = |mae| the adverse price excursion, r the origin rMult.
 *   origin NOT stopped (close/target/time/manual)  ->  A < S <= 1.5S, so the twin did not stop
 *                                                      either. Same exit price, wider denominator:
 *                                                      twin gross R = r / 1.5.
 *   origin STOPPED and A >= 1.5S                   ->  the move ran through the wider stop too.
 *                                                      twin gross R = -1.0.
 *   origin STOPPED and A < 1.5S                    ->  UNRESOLVED. The twin survived a stop the
 *                                                      origin did not, and what the price did
 *                                                      AFTER the origin was closed is not in the
 *                                                      ledger. This is recorded as unresolved and
 *                                                      contributes NO observation. It is never
 *                                                      guessed at, and the unresolved fraction is
 *                                                      printed every run — a twin that is mostly
 *                                                      unresolved is not a measurement.
 *
 * COST, per the registration, from each ticket's OWN obs.spreadBps and never a class median:
 *   costR  = (spreadBps / 100) / stopPct           on the origin
 *   costR' = costR / 1.5                            on the twin — the wider stop is the whole lever
 * A row with no stamped spread has NO cost attribution and is EXCLUDED from the graded population
 * rather than filled in from a class figure. That count is reported; it is currently how every
 * crypto row lands, because obs.spreadBps is stamped on equities only.
 *
 * STATISTIC (frozen): D = net-of-cost R(1.5x twin) − net-of-cost R(live 1.0x stop), one D per
 * matched signal, collapsed to EPISODES via lib/reconcile.js and then day-clustered on the entry
 * session. Effective N is episodes, never tickets.
 *
 * BAR: 60 paired episodes across >=15 sessions, t >= 1.68 (p95 honest bar, 1 variant). INTERIM at
 * 30 episodes is KILL-ONLY at t <= -2. ONE fixed multiplier is registered, not a swept range — a
 * sweep over 1.25/1.5/2/3x would be a search whose honest bar rises faster than the effect.
 *
 * WHAT THIS CANNOT DO, stated because the arithmetic already bounds it: to zero out equity cost
 * the stop would have to widen from 4.6% to about 31% of price. A 1.5x multiplier can shrink the
 * leak by roughly a third, not close it. R54 is a measurable lever on the SIZE of the leak,
 * explicitly not a fix for the SIGN of the edge.
 *
 * Output: data/r54-stop-twin.json
 */
const path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const rc = require("./lib/reconcile.js");
const { mean, clusteredT, etDay } = require("./lib/clustered.js");

const D = (f) => path.join(__dirname, "data", f);
const OUT = D("r54-stop-twin.json");
const EVIDENCE_START = "2026-08-26";
const MULT = 1.5;                                              // registered; editing it is a NEW id
const CLASSES = new Set(["Equity", "Crypto"]);
const STRATEGIES = new Set(["Trend", "Mean-Reversion", "Ensemble"]);
const STOPPED = /^(stop|gap-stop)$/;
const BAR = { minEpisodes: 60, minSessions: 15, tRequired: 1.68, interimEpisodes: 30, interimKillT: -2 };

const entryDay = (t) => etDay(t.openedAt);
const eligible = (t) => t.openedAt && entryDay(t) >= EVIDENCE_START && CLASSES.has(t.cls)
  && STRATEGIES.has(t.strategy) && t.stopDist > 0 && t.entry > 0 && Number.isFinite(t.rMult);

/** costR on the origin, from the ticket's own stamp. Null when unstamped — never substituted. */
const originCostR = (t) => {
  const bps = t.obs && t.obs.spreadBps;
  if (!Number.isFinite(bps)) return null;
  const stopPct = 100 * t.stopDist / t.entry;
  return stopPct > 0 ? (bps / 100) / stopPct : null;
};

/** Resolve one twin. Returns { d, twinGross, resolved, why }. */
function resolve(t, cost) {
  /**
   * mae IS ALREADY IN R (fixed 2026-08-27, review finding).
   * This read it as a price magnitude and compared it against MULT * stopDist dollars. The
   * settle path stamps mae as (entry - low) / stopDist — R multiples of the stop — and the
   * board UI reads `mae >= 1` as "hit the -1R stop"; real stopped rows confirm it (TRV
   * stopDist $12.29 mae 1.052; HOMB stopDist $0.809 mae 1.408 — it clusters just above 1.0
   * whatever the dollar stop is). Comparing R against dollars meant the registered rule
   * "twin stopped iff adverse excursion >= 1.5x stop" was decided by the symbol's PRICE
   * LEVEL: cheap names never cleared it, expensive ones always did. The rule is unchanged;
   * this is the unit it was always written in.
   */
  const A = Number.isFinite(t.mae) && t.mae > 0 ? t.mae : 0;     // mae is in R multiples of the stop
  const originNet = t.rMult - cost;
  if (STOPPED.test(String(t.reason || ""))) {
    if (A >= MULT) {
      const twinNet = -1.0 - cost / MULT;
      return { resolved: true, twinGross: -1.0, d: twinNet - originNet, why: `origin stopped, adverse ${A.toFixed(2)}x also cleared ${MULT}x` };
    }
    return { resolved: false, twinGross: null, d: null, why: `origin stopped at 1.0x but adverse only reached ${A.toFixed(2)}x — the ${MULT}x twin survived and its later path is not in the ledger` };
  }
  const twinGross = t.rMult / MULT;
  const twinNet = twinGross - cost / MULT;
  return { resolved: true, twinGross, d: twinNet - originNet, why: "origin exited without stopping; same exit price, wider denominator" };
}

(() => {
  const L = rc.cleanEraLedger();
  rc.assertReconciled("clean-era pooled edge", rc.recomputeEdge(L), L.pooledEdgeR);

  const candidates = L.signals.filter(eligible);
  const uncosted = candidates.filter((t) => originCostR(t) == null);
  const costed = candidates.filter((t) => originCostR(t) != null);

  const twins = [];
  for (const t of costed) {
    const cost = originCostR(t);
    const r = resolve(t, cost);
    twins.push({ id: t.id, sym: t.sym, cls: t.cls, strategy: t.strategy, entryDate: entryDay(t),
      openedAt: t.openedAt, closedAt: t.closedAt, dir: t.dir, reason: t.reason,
      // mae is already R over the stop — dividing by stopDist again printed 0.09x for a
      // fully stopped trade (same unit bug as resolve(), fixed 2026-08-27).
      originR: +t.rMult.toFixed(4), costR: +cost.toFixed(4), maeOverStop: Number.isFinite(t.mae) ? +Math.max(0, t.mae).toFixed(3) : null,
      twinGrossR: r.twinGross == null ? null : +r.twinGross.toFixed(4), d: r.d == null ? null : +r.d.toFixed(4),
      resolved: r.resolved, why: r.why });
  }
  const resolved = twins.filter((x) => x.resolved);
  const unresolvedPct = twins.length ? +(100 * (twins.length - resolved.length) / twins.length).toFixed(1) : 0;

  // ---- episodes first, then cluster on the entry session --------------------------------------
  // rMult is set to D so lib/reconcile.js `episodes()` collapses the twins on its own frozen key.
  const eps = rc.episodes(resolved.map((x) => ({ ...x, rMult: x.d })));
  const stat = clusteredT(eps, (e) => etDay(e.openedAt), (e) => e.rMult);

  let verdict;
  if (eps.length < BAR.interimEpisodes) {
    verdict = `ACCRUING — ${eps.length}/${BAR.minEpisodes} paired episodes across ${stat.k}/${BAR.minSessions} sessions (${resolved.length} resolved twins, ${unresolvedPct}% unresolved)`;
  } else if (stat.t != null && stat.t <= BAR.interimKillT) {
    verdict = `KILLED AT INTERIM — the wider stop is costing money (mean D ${stat.mean}R, t ${stat.t} at ${eps.length} episodes)`;
  } else if (eps.length < BAR.minEpisodes || stat.k < BAR.minSessions) {
    verdict = `ACCRUING — ${eps.length}/${BAR.minEpisodes} paired episodes across ${stat.k}/${BAR.minSessions} sessions · interim at ${eps.length}: not dead (t ${stat.t ?? "n/a"})`;
  } else if (stat.t != null && stat.t >= BAR.tRequired) {
    verdict = `PASS — the ${MULT}x stop beats the inherited one (mean D ${stat.mean}R/episode, t ${stat.t}, ${stat.k} sessions). A proposed stop-width amendment for the SUCCESSOR spec, never an edit to a live sleeve mid-flight.`;
  } else {
    verdict = `DID NOT PASS — mean D ${stat.mean ?? "n/a"}R/episode, t ${stat.t ?? "n/a"} against ${BAR.tRequired} across ${stat.k} sessions. The stop is not the lever; the cost problem must be attacked at the spread, not the denominator.`;
  }

  /**
   * 2026-09-10 (test-triage COUNT NOT EXPOSED fix). R54's bar carries BOTH minEpisodes:60 and
   * minSessions:15 — test-triage.js's field-priority resolver (backend/test-triage.js:133) matches
   * "minSessions" first, so 15 SESSIONS is the count the triage tool compares against, not the 60
   * paired episodes the verdict text leads with. dailyClock.sessions is therefore stat.k, the
   * count of entry sessions carrying the registered day-clustered statistic — exactly what the
   * verdict already reports as "X/15 sessions". estimate is stat.mean, the registered statistic
   * (mean D per episode). bySession is stat.keys/means, one row per entry session.
   */
  const dailyClock = {
    sessions: stat.k,
    estimate: stat.mean,
    unit: "entry sessions since evidenceStart (stop-width paired episode D) — paired episodes (the other bar field, 60) reported separately as episodes",
    episodes: eps.length,
  };
  const bySession = (stat.keys || []).map((k, i) => ({ session: k, mean: stat.means[i] }));

  const state = {
    spec: "R54-stop-width-twin-v1", registered: "2026-08-25", evidenceStart: EVIDENCE_START,
    multiplier: MULT, classes: [...CLASSES], strategies: [...STRATEGIES], bar: BAR,
    asOf: new Date().toISOString(), dailyClock, bySession,
    population: { candidates: candidates.length, costed: costed.length,
      uncostedExcluded: uncosted.length,
      uncostedNote: "no obs.spreadBps stamp — excluded rather than filled in from a class median, per the registration. Crypto currently carries no stamp at all.",
      twins: twins.length, resolved: resolved.length, unresolvedPct,
      episodes: eps.length, sessions: stat.k,
      ticketToEpisodeInflation: eps.length ? +(resolved.length / eps.length).toFixed(2) : null },
    result: { meanD: stat.mean, tClustered: stat.t, sessions: stat.k, episodes: eps.length,
      meanOriginNetR: resolved.length ? +mean(resolved.map((x) => x.originR - x.costR)).toFixed(4) : null,
      meanTwinNetR: resolved.length ? +mean(resolved.map((x) => x.twinGrossR - x.costR / MULT)).toFixed(4) : null,
      meanCostRSaved: resolved.length ? +mean(resolved.map((x) => x.costR - x.costR / MULT)).toFixed(4) : null },
    twins, verdict,
  };
  writeJsonAtomic(OUT, state);

  console.log(`R54 STOP-WIDTH TWIN — ${MULT}x stop, dollar risk held constant. Evidence from ${EVIDENCE_START}.`);
  console.log(`  candidates ${candidates.length} · costed ${costed.length} · UNCOSTED EXCLUDED ${uncosted.length} (no own spread stamp)`);
  console.log(`  twins ${twins.length} · resolved ${resolved.length} · ${unresolvedPct}% unresolved (origin stopped, ${MULT}x twin survived)`);
  console.log(`  episodes ${eps.length}/${BAR.minEpisodes} across ${stat.k}/${BAR.minSessions} sessions · mean D ${stat.mean ?? "n/a"}R · t ${stat.t ?? "n/a"} vs ${BAR.tRequired}`);
  console.log(`  cost saved by the wider denominator: ${state.result.meanCostRSaved ?? "n/a"}R/row`);
  console.log(`  ${verdict}`);
  console.log("written: r54-stop-twin.json");
})();
