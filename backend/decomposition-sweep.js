/**
 * DECOMPOSITION SWEEP — apply 2026-09-04's central lesson to the whole board.
 *
 * *** THIS IS A HYPOTHESIS GENERATOR. IT IS NOT EVIDENCE. READ THIS BEFORE QUOTING IT. ***
 *
 * It looks at EVERY cell, so it is exploratory BY CONSTRUCTION. A cell that clears the bar here has
 * NOT passed anything — it has earned the right to be REGISTERED PROSPECTIVELY with a fresh evidence
 * start and read later. Quoting a cell from this sweep as a result is exactly the defect that
 * disqualified MLI-3 and that read-seal-sweep exists to prevent. No funding decision may cite it.
 *
 * WHY IT EXISTS. Three times on 2026-09-04 a pooled number was found to hide structure that reversed
 * inside it:
 *   - FD1 pooled t +0.96 while Equity ALONE read t −1.81
 *   - VRP modelled credit 177.5 pts vs 144.2 real (ratio 0.804, sd 0.09 — systematic, not noise)
 *   - cost pooled at a 20bps constant vs BTC ~1.5bps and thin alts 45–64bps
 * The pooled statistic is not a weighted average of its parts when cell day-sets and counts differ.
 * So: decompose everything, and let the decomposition be visible rather than discovered by accident.
 *
 * GUARDS, each one earned by a defect this board actually shipped:
 *   - DAY-CLUSTERED t, never per-ticket. Effective N here is ~31 sessions / ~269 episodes, not 1,212
 *     rows. Per-ticket t on this ledger is meaningless.
 *   - NULL HOLDS DAY x DIRECTION. A day-only permutation once certified 0.61 of an AUC that was pure
 *     long/short asymmetry. Shuffling must preserve the direction mix within each session.
 *   - BEST-OF-K BAR. The bar is the p95 of the MAXIMUM |t| across all cells under permutation, not
 *     the p95 of a single cell. Looking at K cells and quoting the best is a K-fold look.
 *   - MIN CELL SIZE. A day-clustered t on 3 sessions is not a statistic. Cells below the floor are
 *     printed but never eligible.
 *   - CONCENTRATION FLAG (R44's rule, reused verbatim): a cell whose top two days supply >50% of its
 *     total R is CONCENTRATED regardless of t — that is one or two episodes, not an effect.
 *
 * Usage: node backend/decomposition-sweep.js [--perms N]
 */
const fs = require("fs"), path = require("path");
const RC = require("./lib/reconcile.js");

const PERMS = (() => { const i = process.argv.indexOf("--perms"); return i > 0 ? +process.argv[i + 1] : 2000; })();
const MIN_DAYS = 10;      // day-clustered t needs sessions, not tickets
const MIN_TICKETS = 40;   // R44 used 60; relaxed to 40 and cells under R44's floor are flagged
const R44_DAYS = 30, R44_TICKETS = 60;

const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

/** Day-clustered t on a set of rows: one observation per session, equal weight per session. */
function dayT(rows) {
  const byDay = {};
  for (const r of rows) (byDay[r._d] ||= []).push(r._r);
  const days = Object.keys(byDay).sort();
  const perDay = days.map((d) => mean(byDay[d]));
  if (perDay.length < 2) return { n: rows.length, days: days.length, mean: null, t: null, top2Share: null };
  const m = mean(perDay), s = sd(perDay);
  const t = s > 0 ? m / (s / Math.sqrt(perDay.length)) : null;
  // concentration: share of TOTAL R supplied by the two biggest-|R| days
  const dayR = days.map((d) => byDay[d].reduce((x, y) => x + y, 0));
  const totAbs = dayR.reduce((x, y) => x + Math.abs(y), 0);
  const top2 = [...dayR].map(Math.abs).sort((a, b) => b - a).slice(0, 2).reduce((x, y) => x + y, 0);
  return { n: rows.length, days: perDay.length, mean: m, t, top2Share: totAbs > 0 ? top2 / totAbs : null };
}

(function main() {
  const L = RC.cleanEraLedger();
  const all = (L.signals || []).filter((t) => Number.isFinite(t.rMult) && t.openedAt);
  for (const r of all) { r._d = et(r.openedAt); r._r = r.rMult; r._dir = r.dir > 0 ? "LONG" : "SHORT"; }

  console.log(`\n  DECOMPOSITION SWEEP — EXPLORATORY, NOT EVIDENCE`);
  console.log(`  canonical clean-era ledger · ${all.length} signals · ${new Set(all.map(r => r._d)).size} sessions`);
  console.log(`  pooled: mean ${mean(all.map(r => r._r)).toFixed(4)}R/trade · day-clustered t ${dayT(all).t?.toFixed(2)}`);
  console.log(`  null holds day x direction · bar = p95 of max|t| across all cells · ${PERMS} permutations\n`);

  // ---- define the cuts -------------------------------------------------
  const cuts = {};
  const add = (label, keyFn) => {
    for (const r of all) { const k = keyFn(r); if (k == null) continue; (cuts[`${label}: ${k}`] ||= []).push(r); }
  };
  add("class", (r) => r.cls);
  add("direction", (r) => r._dir);
  add("strategy", (r) => r.strategy);
  add("class x dir", (r) => (r.cls && r._dir ? `${r.cls} ${r._dir}` : null));
  add("strategy x class", (r) => (r.strategy && r.cls ? `${r.strategy} ${r.cls}` : null));

  const eligible = Object.entries(cuts).filter(([, rows]) => {
    const d = new Set(rows.map((r) => r._d)).size;
    return rows.length >= MIN_TICKETS && d >= MIN_DAYS;
  });
  console.log(`  cells defined ${Object.keys(cuts).length} · eligible (>=${MIN_TICKETS} tickets, >=${MIN_DAYS} days) ${eligible.length}\n`);

  // ---- permutation null: shuffle rMult WITHIN (day, direction) ----------
  const groups = {};
  for (let i = 0; i < all.length; i++) (groups[`${all[i]._d}|${all[i]._dir}`] ||= []).push(i);
  const groupIdx = Object.values(groups);
  const orig = all.map((r) => r._r);

  let maxTs = [];
  for (let p = 0; p < PERMS; p++) {
    for (const idx of groupIdx) {                       // Fisher-Yates within each day x direction
      for (let i = idx.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const a = all[idx[i]], b = all[idx[j]];
        const tmp = a._r; a._r = b._r; b._r = tmp;
      }
    }
    let mx = 0;
    for (const [, rows] of eligible) { const t = dayT(rows).t; if (t != null && Math.abs(t) > mx) mx = Math.abs(t); }
    maxTs.push(mx);
  }
  for (let i = 0; i < all.length; i++) all[i]._r = orig[i];   // restore
  maxTs.sort((a, b) => a - b);
  const BAR = maxTs[Math.floor(0.95 * maxTs.length)];
  const poolMean = mean(all.map((r) => r._r));

  // ---- report ----------------------------------------------------------
  const rows = [];
  for (const [label, rs] of Object.entries(cuts)) {
    const s = dayT(rs);
    const isEligible = rs.length >= MIN_TICKETS && s.days >= MIN_DAYS;
    const flags = [];
    if (!isEligible) flags.push("UNDERPOWERED");
    if (rs.length < R44_TICKETS || s.days < R44_DAYS) flags.push("below-R44-floor");
    if (s.top2Share != null && s.top2Share > 0.5) flags.push("CONCENTRATED");
    if (s.mean != null && poolMean != null && Math.sign(s.mean) !== Math.sign(poolMean)) flags.push("SIGN-REVERSES-vs-POOL");
    if (isEligible && s.t != null && Math.abs(s.t) >= BAR) flags.push(s.t > 0 ? "*** CLEARS BEST-OF-K ***" : "clears (NEGATIVE)");
    rows.push({ cell: label, n: rs.length, days: s.days, meanR: s.mean, t: s.t, top2Share: s.top2Share, eligible: isEligible, flags });
  }
  rows.sort((a, b) => (b.t ?? -99) - (a.t ?? -99));

  console.log(`  best-of-K bar (p95 of max|t| under the day x direction null): ${BAR.toFixed(2)}`);
  console.log(`  a single-cell t of 2.0 corresponds to roughly p ${(maxTs.filter(x => x >= 2).length / maxTs.length).toFixed(3)} here — that is the cost of looking at ${eligible.length} cells\n`);
  console.log(`  cell                                       n   days     meanR      t   top2%  flags`);
  for (const r of rows) {
    console.log(
      "  " + r.cell.padEnd(40).slice(0, 40) +
      String(r.n).padStart(5) + String(r.days).padStart(6) +
      (r.meanR == null ? "       —" : (r.meanR >= 0 ? "+" : "") + r.meanR.toFixed(4).padStart(8)) +
      (r.t == null ? "      —" : r.t.toFixed(2).padStart(7)) +
      (r.top2Share == null ? "       " : (100 * r.top2Share).toFixed(0).padStart(6) + "%") +
      "  " + r.flags.join(" · ")
    );
  }

  const winners = rows.filter((r) => r.eligible && r.t != null && r.t >= BAR && !r.flags.includes("CONCENTRATED"));
  console.log(`\n  ${winners.length} cell(s) clear the best-of-K bar POSITIVE and are not concentration artifacts.`);
  if (winners.length) {
    console.log(`  These are CANDIDATES FOR PROSPECTIVE REGISTRATION, not results:`);
    for (const w of winners) console.log(`    ${w.cell}  n=${w.n} days=${w.days} mean ${w.meanR.toFixed(4)}R t ${w.t.toFixed(2)}`);
    console.log(`  Register each with a FRESH evidence start before it may be read again.`);
  } else {
    console.log(`  Nothing in the decomposition survives a multiplicity-honest bar. The pooled null is not`);
    console.log(`  hiding a positive sub-population at this sample size.`);
  }

  fs.writeFileSync(path.join(__dirname, "data", "decomposition-sweep.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), status: "EXPLORATORY — hypothesis generator, not evidence",
      pooled: { n: all.length, meanR: poolMean, t: dayT(all).t }, perms: PERMS, bestOfKBar: BAR,
      guards: { MIN_DAYS, MIN_TICKETS, nullHolds: "day x direction", concentrationRule: "top-2 days >50% of |R|" },
      cells: rows, winners: winners.map((w) => w.cell) }, null, 2));
  console.log(`\n  written backend/data/decomposition-sweep.json\n`);
})();
