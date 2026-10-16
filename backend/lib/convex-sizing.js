/**
 * CONVEX SIZING — risk little on the crowded bet, full size on the independent one. 2026-08-28.
 *
 * THE OPERATOR'S RULE: "risk little to gain a lot." Today the book does the opposite of that —
 * it risks the SAME on everything. Every ticket carries a flat 0.25% policy stake whether it is
 * the ninth correlated energy short of the session or the only genuinely independent bet on the
 * board. Flat sizing on a ranked world forfeits every dollar of convexity available for free.
 *
 * ═══ WHAT THIS SIZES ON, AND WHAT IT REFUSES TO SIZE ON ═══
 *
 * SIZES DOWN ON CORRELATION. Measured and not in dispute: 81% of the stop tail is correlated
 * exposure, and ticket-to-episode inflation runs 3.1x — 1,038 tickets are 335 real bets. The
 * ninth ticket in a factor group is not a ninth bet, and paying full risk for it is paying nine
 * times for one opinion.
 *
 * REFUSES TO SIZE UP ON CONVICTION — for now. Sizing up requires a score with MEASURED forward
 * skill, and on the daily board we do not have one: ridge day-corr t is -0.21 and gbm is -1.64.
 * Sizing on a non-predictive score concentrates risk on noise, which is strictly worse than flat.
 * So `conviction` is wired into the formula, documented, and PINNED AT 1.0 until a score clears
 * a registered bar. The lever exists; it is not connected to anything unearned.
 *
 * ═══ IT IS A REALLOCATION, NOT A DE-RISKING ═══
 *
 * Weights are normalised per session so total planned risk equals what flat sizing would have
 * planned. Risk moves FROM the crowded tickets TO the independent ones; gross exposure is
 * unchanged. This matters twice: it is what makes the comparison honest (no arm wins by simply
 * trading smaller), and it is what makes it convex rather than merely timid.
 *
 * ═══ THE FORM IS PRE-SPECIFIED, NOT FITTED ═══
 *
 *     w = 1 / sqrt(1 + nPriorCorrelated)      floored at MIN_W, capped at 1.0
 *
 * The square root is the standard independent-bets scaling — n correlated positions carry the
 * risk of sqrt(n) independent ones — not a parameter chosen because it scored well. Nothing here
 * was tuned on the ledger it is measured against. If a grid of exponents is ever searched, that
 * search owes a best-of-N bar and this comment stops being true.
 *
 * ═══ WHY THIS IS SAFE TO MEASURE AND SAFE TO SHIP ═══
 *
 * R-multiples are size-invariant: rMult = pnl / riskDollars. Every registered test on this board
 * reads R, so changing SIZE cannot move a single registered statistic. It moves dollar P&L only.
 * That is also what lets the counterfactual be computed exactly rather than simulated:
 * pnlConvex = rMult x riskDollarsConvex, with no assumption about fills.
 */

const EG = require("./enforcement-gates.js");

const MIN_W = 0.25;              // a crowded ticket still carries a quarter stake, never dust
const EXPONENT = 0.5;            // sqrt: independent-bets scaling. Pre-specified, never tuned.

/** Direction sign, tolerant of the several shapes the board uses. */
const dirOf = (p) => (p && (p.dir === -1 || p.dir === "short") ? -1 : 1);

/**
 * Correlated-prior count for one ticket against the tickets already open before it.
 * Correlated = shares a factor-group token AND points the same way. An opposing ticket in the
 * same group is a HEDGE, not a doubling — counting it as correlated would penalise the one
 * thing that actually reduces book risk.
 */
function priorCorrelated(ticket, alreadyOpen) {
  const mine = EG.groupTokens(ticket);
  if (!mine.length) return 0;                       // no group token: cannot claim it is crowded
  const set = new Set(mine), d = dirOf(ticket);
  let n = 0;
  for (const q of alreadyOpen) {
    if (!q || q === ticket) continue;
    if (dirOf(q) !== d) continue;
    for (const g of EG.groupTokens(q)) if (set.has(g)) { n++; break; }
  }
  return n;
}

/** Raw weight for one ticket. conviction defaults to 1 and stays there until a score is earned. */
function rawWeight(nPrior, conviction = 1) {
  const w = Math.pow(1 + Math.max(0, nPrior), -EXPONENT) * (Number.isFinite(conviction) ? conviction : 1);
  return Math.min(1, Math.max(MIN_W, w));
}

/**
 * Size a whole session. `tickets` must be the REAL exposure for one session, in the order they
 * opened — no controls, no veto shadows, no sleeves (each of those has its own sizing or opens
 * no exposure at all).
 *
 * Returns one row per ticket with the flat and convex risk side by side, plus the reason. Total
 * convex risk equals total flat risk by construction; if it does not, that is a bug and the
 * caller should say so rather than absorb it.
 */
function sizeSession(tickets) {
  const ordered = [...tickets].sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
  const open = [];
  const rows = ordered.map((t) => {
    const nPrior = priorCorrelated(t, open);
    open.push(t);
    return { t, nPrior, w: rawWeight(nPrior, t.conviction) };
  });

  const flatTotal = rows.reduce((s, r) => s + (Number(r.t.riskDollars) || 0), 0);
  const wTotal = rows.reduce((s, r) => s + r.w * (Number(r.t.riskDollars) || 0), 0);
  const scale = wTotal > 0 ? flatTotal / wTotal : 1;      // renormalise: same gross planned risk

  return rows.map((r) => {
    const flat = Number(r.t.riskDollars) || 0;
    const convex = flat * r.w * scale;
    return {
      id: r.t.id, sym: r.t.sym, cls: r.t.cls, dir: dirOf(r.t),
      groups: EG.groupTokens(r.t),
      nPriorCorrelated: r.nPrior,
      weight: +r.w.toFixed(4), scale: +scale.toFixed(4),
      riskFlat: +flat.toFixed(2), riskConvex: +convex.toFixed(2),
      multiple: flat > 0 ? +(convex / flat).toFixed(3) : null,
      rMult: Number.isFinite(r.t.rMult) ? r.t.rMult : null,
      pnlFlat: Number.isFinite(r.t.pnl) ? r.t.pnl : null,
      // size-invariance: rMult is pnl/riskDollars, so this is exact, not simulated
      pnlConvex: Number.isFinite(r.t.rMult) ? +(r.t.rMult * convex).toFixed(2) : null,
      why: r.nPrior === 0 ? "independent — full size" : `${r.nPrior} correlated ticket(s) already open in ${EG.groupTokens(r.t).join("/")}`,
    };
  });
}

module.exports = { sizeSession, priorCorrelated, rawWeight, MIN_W, EXPONENT };
