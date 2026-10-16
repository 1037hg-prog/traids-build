/**
 * GAP-AWARE SIZING — size so an ordinary overnight gap costs 1R, not 4R.
 *
 * THE DEFECT, demonstrated three separate times on 2026-08-28 alone. Position size is currently
 * qty = riskDollars / stopDist, which assumes the stop holds. A stop is a promise the market
 * keeps only while it is open. PYPL was sized to risk $250 and lost $1,038 — 4.16R — because it
 * gapped 13.57% overnight against a stop 3.3% away. Across the clean era: 18 gap-resolved
 * tickets, 18 losses, 0 gains, -$16,078, against a whole-book P&L of +$2,648.
 *
 * WHAT THIS DOES NOT CLAIM. It does not predict gaps and does not avoid them. It changes only
 * the DENOMINATOR: for a position that will be held through a close, the effective risk distance
 * is the worse of the stop distance and a realistic adverse overnight gap, so the size is set
 * against the risk actually being taken rather than the risk nominally intended.
 *
 *     effectiveStopDist = max(stopDist, gapPct_p95 x entry)
 *     qty               = riskDollars / effectiveStopDist
 *
 * The p95 is measured per symbol from its own overnight gaps (prior close -> next open) over a
 * trailing window, with a per-class floor so a quiet name is not sized as though gaps cannot
 * happen. Symbols without enough history fall back to the class floor — never to "no gap risk".
 *
 * THE COST IS REAL AND IS NOT HIDDEN. Smaller size on gap-prone names means smaller WINNERS on
 * those same names. Any read of this must report both tails; backend/gap-sizing-retro.js does.
 * A rule that only ever shows you the losses it prevented is a sales pitch.
 *
 * INTRADAY POSITIONS ARE UNAFFECTED. If a ticket is closed before the session ends it never
 * carries gap risk, so applying a gap denominator to it would shrink size for nothing. The
 * caller passes holdsOvernight; when false this returns the stop distance unchanged.
 */
const FLOOR_MULT = Number(process.env.GAP_FLOOR_MULT || 1);
const CLASS_FLOOR_PCT = {   // minimum assumed adverse overnight move, by class
  Equity: 0.03,             // 3% — an ordinary earnings-free equity gap
  Crypto: 0.05,             // 5% — 24/7 but jumps between our marks
  Futures: 0.02,
  FX: 0.01,
  Options: 0,               // defined risk: the debit IS the max loss, nothing to widen
};

/** p95 adverse overnight gap for one symbol, as a fraction of price. Null if not computable. */
function gapP95(bars, { lookback = 120, dir = 1, pct = 0.95 } = {}) {
  if (!Array.isArray(bars) || bars.length < 30) return null;
  const w = bars.slice(-lookback);
  const gaps = [];
  for (let i = 1; i < w.length; i++) {
    const prevClose = w[i - 1].c, open = w[i].o;
    if (!(prevClose > 0) || !(open > 0)) continue;
    const move = (open - prevClose) / prevClose;
    const adverse = dir > 0 ? -move : move;     // adverse for a long is a gap DOWN
    if (Number.isFinite(adverse)) gaps.push(Math.max(0, adverse));
  }
  if (gaps.length < 20) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(pct * (gaps.length - 1))];
}

/**
 * effectiveStopDist(...) -> { dist, basis, gapPct }
 * `bars` optional; without it the class floor is used, which is the safe direction.
 */
function effectiveStopDist({ cls, entry, stopDist, dir = 1, bars = null, holdsOvernight = true }) {
  if (!(stopDist > 0) || !(entry > 0)) return { dist: stopDist, basis: "unchanged — bad inputs", gapPct: null };
  if (!holdsOvernight) return { dist: stopDist, basis: "intraday — no gap risk", gapPct: null };
  const floor = (CLASS_FLOOR_PCT[cls] ?? 0.03) * FLOOR_MULT;
  if (floor === 0) return { dist: stopDist, basis: "defined risk — debit is the max loss", gapPct: 0 };
  const measured = gapP95(bars, { dir, pct: Number(process.env.GAP_PCTL || 0.95) });
  const gapPct = Math.max(floor, measured ?? 0);
  const gapDist = gapPct * entry;
  return gapDist > stopDist
    ? { dist: gapDist, basis: measured !== null && measured > floor ? "measured p95 gap" : "class floor", gapPct }
    : { dist: stopDist, basis: "stop is wider than the gap estimate", gapPct };
}

/** qty under gap-aware sizing. Same signature shape as the existing sizer plus bars/holdsOvernight. */
function sizeQty({ riskDollars, cls, entry, stopDist, dir = 1, bars = null, holdsOvernight = true }) {
  const e = effectiveStopDist({ cls, entry, stopDist, dir, bars, holdsOvernight });
  return { qty: e.dist > 0 ? riskDollars / e.dist : 0, effectiveStopDist: e.dist,
    shrinkFactor: e.dist > 0 ? stopDist / e.dist : 1, basis: e.basis, gapPct: e.gapPct };
}

module.exports = { gapP95, effectiveStopDist, sizeQty, CLASS_FLOOR_PCT };
