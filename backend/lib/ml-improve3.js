/**
 * ML IMPROVE — ATTEMPT #3 (2026-08-28): GATE THE COST RATIO, NOT THE SPREAD.
 *
 * WHY MLI-2 IS NOT REPEATED. The within-direction rank shadow was read on 2026-08-26, -08-27 and
 * again on -08-28 against genuinely new settlement each time, and failed on every read (latest:
 * day-corr t 0.30, one-sided p 0.3541, per-session lift t 0.54). Its code and its bar in
 * lib/ml-improve2.js are left exactly as written. It is retired to the record, not rewritten.
 *
 * WHAT THIS ATTEMPT IS, AND WHY IT AIMS AT COST.
 * The autopsy is unambiguous about where the money goes: over the clean era the book earned
 * +46.05R of DIRECTION and paid -61.63R of COST, netting -15.58R (identity holds). The signals are
 * not the problem. Cost is.
 *
 * R49 has gated cost since 2026-08-27, but it gates the NUMERATOR only: an equity ticket is refused
 * when obs.spreadBps > 100. Cost in R terms is not the spread — it is the spread measured against
 * the stop the trade is risking:
 *
 *     costR = (spreadBps / 100) / stopPct        where stopPct = 100 * stopDist / entry
 *
 * A 40bps spread against a 0.30% stop is 1.33R of cost and sails through R49 untouched. A 90bps
 * spread against a 3% stop is 0.30R and is also allowed, correctly. The two tickets are nothing
 * alike and R49 cannot tell them apart, because the denominator is not in its rule. Both terms are
 * knowable at the entry POST — stopDist and entry are set by the ticket, and obs.spreadBps is now
 * stamped on 100% of equity entries since 2026-08-25 — so a ratio gate is implementable live in
 * exactly the place R49 already sits.
 *
 * THE ATTEMPT IS THEREFORE: on top of R49, does refusing high-costR tickets raise mean R?
 * Measured as a paired per-session shadow — the kept book's session mean minus that same session's
 * whole book — so the unit of inference stays the SESSION and no session is compared to another.
 *
 * HONESTY DECLARATION — READ THIS BEFORE READING THE RESULT.
 * The threshold grid below was scoped EXPLORATORILY on 2026-08-28 before this bar was written. The
 * costR bucket means and the residual over R49 across six thresholds were read first, and only then
 * was this file written. That is bar-after-evidence and it is the one thing this apparatus exists to
 * prevent. It is recorded rather than concealed, and it carries a hard consequence:
 *
 *   THIS ATTEMPT IS NOT ELIGIBLE FOR THE PROPOSAL QUEUE ON THIS READ, WHATEVER IT SHOWS.
 *
 * proposalEligible is hard-false below. A clearing result here is a MOTIVATING SAMPLE that would
 * need a fresh forward read on sessions that did not inform the threshold. The grader is kept
 * anyway because the honest outcome of a scoped-then-graded attempt is still worth writing down,
 * and because it converts a hunch about cost into a number with a re-read date.
 *
 * THE SECOND LIMIT, WHICH MATTERS MORE THAN THE FIRST. Only 66 of 1,038 clean-era rows carry a
 * MEASURED spread (obs.spreadBps); the rest are priced off a class model or an R56 prediction. A
 * screen graded on modelled spread is partly grading the spread model. The stamped population is
 * reported separately, and while it spans fewer than 10 sessions this attempt cannot be decided on
 * measured data at all — which is itself the finding, and it comes with a date rather than a shrug.
 *
 * THE BAR, ALL FOUR JOINTLY. Three of four is a fail.
 *   (a) per-session mean-R lift of the kept book over the whole book has t >= 2.0 (house bar)
 *   (b) at least 10 scored sessions carrying both arms
 *   (c) the screen must refuse at least 20 tickets — a rule that fires on five rows is not a rule
 *   (d) the lift must survive on the STAMPED subset, or that subset must be declared undecidable
 */
const BAR3 = {
  minLiftT: 2.0,
  minScoredSessions: 10,
  minRefused: 20,
  requiresStampedConfirmation: true,
  proposalEligible: false,
  proposalIneligibleBecause:
    "The threshold grid was scoped on this same data before the bar was written. A clearing read here is a motivating sample, not prospective evidence, and may not enter the queue without a fresh forward read.",
  fixedAt: "2026-08-28, after exploratory threshold scoping — declared, not concealed",
  statedAs: "all four, jointly. Three of four is a fail.",
};

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));

/**
 * costR is NOT recomputed here. It is joined by ticket id from trade-autopsy.jsonl, which is the
 * only place the cost model lives. Re-deriving (spreadBps/100)/stopPct in a second file would give
 * this shop two cost models that agree until the day they quietly do not — the same failure mode
 * that made lib/reconcile.js the single ledger source after the same quantity was reported three
 * times on 2026-08-24 and was wrong twice.
 *
 * @param rows      clean-era settled signal rows (canonical ledger, via reconcile.cleanEraLedger)
 * @param et        ms -> ET calendar day
 * @param costById  Map ticket-id -> { costR, bps, stamped } from the autopsy
 */
function costRatioScreenShadow(rows, et, costById) {
  if (!costById || !costById.size) return { attempted: false, id: "MLI-3-cost-ratio-screen", reason: "no cost attribution available — run trade-autopsy.js first" };
  const scored = [];
  for (const t of rows) {
    if (!Number.isFinite(t.rMult) || !t.openedAt) continue;
    const c = costById.get(t.id);
    if (!c || !Number.isFinite(c.costR)) continue;
    // R49 is ALREADY ENFORCED. Grading a gate against a book that still contains the tickets R49
    // refuses credits this rule with R49's work. The population is the post-R49 book.
    if (t.cls === "Equity" && c.bps > 100) continue;
    scored.push({ day: et(t.openedAt), r: t.rMult, costR: c.costR, stamped: c.stamped, cls: t.cls });
  }
  if (scored.length < 100) return { attempted: false, id: "MLI-3-cost-ratio-screen", reason: "only " + scored.length + " rows survive R49 with a formable costR — below the 100 needed" };

  const bySess = {};
  for (const s of scored) (bySess[s.day] ||= []).push(s);

  /** paired per-session lift of the kept book over that same session's whole book */
  function lift(pop, thr) {
    const per = [], byd = {};
    for (const s of pop) (byd[s.day] ||= []).push(s);
    for (const ids of Object.values(byd)) {
      const k = ids.filter((s) => s.costR <= thr);
      if (!k.length || k.length === ids.length) continue;      // no contrast in this session
      per.push(mean(k.map((s) => s.r)) - mean(ids.map((s) => s.r)));
    }
    if (per.length < 2) return { t: null, n: per.length, mean: null, se: null };
    const s2 = sd(per), se = s2 / Math.sqrt(per.length);
    return { t: se > 0 ? mean(per) / se : null, n: per.length, mean: mean(per), se };
  }

  const GRID = [0.08, 0.10, 0.15, 0.20, 0.25];
  const grid = GRID.map((thr) => {
    const L = lift(scored, thr);
    const refused = scored.filter((s) => s.costR > thr);
    return {
      thr, refusedTickets: refused.length, refusedR: r4(refused.reduce((a, s) => a + s.r, 0)),
      refusedMeanR: r4(mean(refused.map((s) => s.r))),
      liftPerSessionMean: r4(L.mean), liftPerSessionSe: r4(L.se), liftT: r2(L.t), liftSessions: L.n,
    };
  });
  // The reported threshold is FIXED at 0.10 — it is not chosen by outcome. Picking the grid point
  // with the best t is how a grid silently becomes a result, and it would also smuggle a sixth
  // multiplicity into an attempt that is already declared ineligible for being scoped in-sample.
  const chosen = grid.find((g) => g.thr === 0.10) || grid[0];

  // ── the stamped-only subset: the same screen where the spread was MEASURED, not modelled ──
  const stampedRows = scored.filter((s) => s.stamped);
  const stampedSessions = new Set(stampedRows.map((s) => s.day)).size;
  const stampedL = stampedRows.length ? lift(stampedRows, chosen.thr) : { t: null, n: 0, mean: null };
  const stampedDecidable = stampedSessions >= BAR3.minScoredSessions && stampedL.n >= 2;

  const conds = {
    a_liftT: { need: ">= " + BAR3.minLiftT, got: chosen.liftT, pass: Number.isFinite(chosen.liftT) && chosen.liftT >= BAR3.minLiftT },
    b_scoredSessions: { need: ">= " + BAR3.minScoredSessions, got: chosen.liftSessions, pass: chosen.liftSessions >= BAR3.minScoredSessions },
    c_refusedTickets: { need: ">= " + BAR3.minRefused, got: chosen.refusedTickets, pass: chosen.refusedTickets >= BAR3.minRefused },
    d_stampedConfirmation: {
      need: "lift holds on MEASURED spread, or that subset is declared undecidable",
      got: stampedDecidable
        ? "stamped lift t " + r2(stampedL.t) + " on " + stampedL.n + " sessions"
        : "UNDECIDABLE — " + stampedRows.length + " stamped rows across " + stampedSessions + " sessions, below the " + BAR3.minScoredSessions + " needed",
      pass: stampedDecidable && Number.isFinite(stampedL.t) && stampedL.t >= BAR3.minLiftT,
    },
  };
  const cleared = Object.values(conds).every((c) => c.pass);

  return {
    attempted: true, id: "MLI-3-cost-ratio-screen", bar: BAR3,
    rule: "on top of R49, refuse any ticket whose entry-knowable costR = (spreadBps/100)/stopPct exceeds " + chosen.thr,
    population: { rowsSurvivingR49: scored.length, sessions: Object.keys(bySess).length, stampedRows: stampedRows.length, stampedSessions },
    grid, chosen,
    stamped: { rows: stampedRows.length, sessions: stampedSessions, liftT: r2(stampedL.t), liftSessions: stampedL.n, decidable: stampedDecidable },
    conditions: conds, cleared,
    survivorshipNote: "Where a spread was not stamped, the autopsy prices it off R56, whose features read universe-expanded.json — CURRENT membership. Those modelled costR values therefore inherit survivorship bias; the stamped subset does not.",
    // MLI-3 can never be queued on this read. See BAR3.proposalIneligibleBecause.
    proposalEligible: false,
    dayCorrT: null, permutationP: null,
    shadow: {
      meanRLift: chosen.liftPerSessionMean, liftT: chosen.liftT, liftSessions: chosen.liftSessions,
      droppedTickets: chosen.refusedTickets, droppedMeanR: chosen.refusedMeanR,
      costNote: "The rule only REMOVES tickets, so it adds no crossing cost. It does not model the cost of the tickets it keeps.",
    },
    effectiveN: chosen.liftSessions + " sessions carrying both arms — NOT " + chosen.refusedTickets + " refused tickets. Refusals cluster into the same wide-spread names on the same days.",
    read: cleared
      ? "clears all four conditions — but it is NOT queueable (" + BAR3.proposalIneligibleBecause + ") and needs a fresh forward read."
      : "DOES NOT CLEAR. "
        + (!conds.a_liftT.pass ? "Per-session lift t " + chosen.liftT + " is short of " + BAR3.minLiftT + ". " : "")
        + (!conds.d_stampedConfirmation.pass ? "And the measured-spread subset is " + (stampedDecidable ? "unsupportive" : "not yet decidable") + ": " + conds.d_stampedConfirmation.got + ". " : "")
        + "Gating the cost RATIO adds little on top of R49's spread gate, because R49 already refuses the fat tail of the ratio — the two rules overlap far more than the formula suggests.",
  };
}

module.exports = { costRatioScreenShadow, BAR3 };
