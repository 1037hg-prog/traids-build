/**
 * R39 INTRADAY RULES — ORB30 and VWAPR, extracted VERBATIM from intraday-family.js on 2026-08-23 so
 * the two-year history grader (intraday-history.js) runs the registered rule and not a copy of it.
 * Nothing here may change without a change-registry entry: R39's sealed sessions were graded by
 * exactly this code. makeRules(costSide) binds the per-side cost (fraction of price) the caller
 * reads from the cost model, as intraday-family.js always did.
 */
function makeRules(COST_SIDE) {
  function walk(bars, i0, dir, entry, stop, target) {   // path exit from bar i0 (entry bar) onward
    for (let k = i0; k < bars.length; k++) {
      const b = bars[k];
      if (b.t >= "15:55") return { exit: b.o, how: "flat", t: b.t };
      if (dir > 0 ? b.o <= stop : b.o >= stop) return { exit: b.o, how: "gap-stop", t: b.t };
      if (dir > 0 ? b.o >= target : b.o <= target) return { exit: b.o, how: "gap-target", t: b.t };
      if (dir > 0 ? b.l <= stop : b.h >= stop) return { exit: stop, how: "stop", t: b.t };
      if (dir > 0 ? b.h >= target : b.l <= target) return { exit: target, how: "target", t: b.t };
    }
    const last = bars[bars.length - 1]; return { exit: last.c, how: "close", t: last.t };
  }
  const trade = (bars, i, dir, stop, target) => { const e = bars[i + 1]; if (!e) return null; const entry = e.o; const risk = Math.abs(entry - stop); if (!(risk > 0)) return null; const x = walk(bars, i + 1, dir, entry, stop, target); const cost = entry * COST_SIDE * 2; const pnl = (x.exit - entry) * dir - cost; return { entry, exit: x.exit, how: x.how, exitT: x.t, pts: +pnl.toFixed(4), r: +(pnl / risk).toFixed(3), win: pnl > 0 }; };

  function orb30(bars) {
    const or = bars.filter((b) => b.t >= "09:30" && b.t <= "09:55"); if (or.length < 5) return null;
    const hi = Math.max(...or.map((b) => b.h)), lo = Math.min(...or.map((b) => b.l)), rng = hi - lo, px = or[or.length - 1].c;
    if (!(rng / px >= 0.003 && rng / px <= 0.03)) return null;
    for (let i = 0; i < bars.length; i++) { const b = bars[i]; if (b.t < "10:00" || b.t >= "15:30") continue;
      if (b.c > hi) return { sig: b.t, dir: 1, ...(trade(bars, i, 1, lo, b.c + 1.5 * rng) || {}) };
      if (b.c < lo) return { sig: b.t, dir: -1, ...(trade(bars, i, -1, hi, b.c - 1.5 * rng) || {}) }; }
    return null;
  }
  function vwapr(bars) {
    let pv = 0, vv = 0;
    for (let i = 0; i < bars.length; i++) { const b = bars[i]; pv += (b.vw || b.c) * (b.v || 0); vv += b.v || 0; if (b.t < "10:30" || b.t >= "15:30" || !(vv > 0)) continue; const vwap = pv / vv; const dev = b.c / vwap - 1;
      if (dev >= 0.015) return { sig: b.t, dir: -1, dev: +(100 * dev).toFixed(2), ...(trade(bars, i, -1, bars[i + 1] ? bars[i + 1].o * 1.01 : b.c * 1.01, vwap) || {}) };
      if (dev <= -0.015) return { sig: b.t, dir: 1, dev: +(100 * dev).toFixed(2), ...(trade(bars, i, 1, bars[i + 1] ? bars[i + 1].o * 0.99 : b.c * 0.99, vwap) || {}) }; }
    return null;
  }
  /** Grade one session file's symbols map → { orb30: rows[], vwapr: rows[] } exactly as intraday-family.js does. */
  function gradeSession(symbols) {
    const rows = { orb30: [], vwapr: [] };
    for (const [sym, bars] of Object.entries(symbols)) { if (sym === "SPY") continue;
      const a = orb30(bars); if (a && Number.isFinite(a.r)) rows.orb30.push({ sym, ...a });
      const b = vwapr(bars); if (b && Number.isFinite(b.r)) rows.vwapr.push({ sym, ...b }); }
    return rows;
  }
  return { walk, trade, orb30, vwapr, gradeSession };
}
module.exports = { makeRules };
