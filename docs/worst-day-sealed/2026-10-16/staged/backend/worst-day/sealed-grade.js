#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED LEDGER — THE GRADER. It scores the rows that have MATURED and says nothing about the ones that have not.
 *
 * IT GRADES NOTHING UNTIL THE CHECKER PASSES. sealed-check.js runs first on the whole ledger. One late row, one broken link, one
 * row that does not match its tip, and this refuses outright: a score computed over rows that might have been written after the fact
 * is worse than no score, because it looks like one.
 *
 * MATURITY. A row matures when the bar file holds the session it names AND the session before it, so the close-to-close total return
 * of forDate can be computed. Nothing else makes a row mature; a row is never dropped for being wrong.
 *
 * THE OUTCOME. y = 1 when forDate's total return is at or below the threshold the row itself stated at its decision close (`thr`),
 * which is the nearest-rank 5th percentile of the trailing 1,260 sessions as of that close — dataset.js's label, fixed in the row
 * before the session opened. The grader does not recompute the threshold from today's data: that would let a later window move an
 * old row's bar. It does re-read the decision bar and REFUSES TO GRADE any row whose stated asOfAdj no longer matches the bar file
 * (`disputed`): the row and the bars disagree, which is a data problem to look at, not a score to publish.
 *
 * THE SCORES, all of them stated, none of them selected after the fact:
 *   BRIER        mean (p - y)^2 over matured rows. Lower is better. Reported beside two forecasts that need no model:
 *                  always-5%   p = 0.05 every day (the target is a 5% event by construction, so this is the honest null)
 *                  climatology p = the realised worst-day rate over the matured rows themselves (an IN-SAMPLE null, and said to be)
 *                skill = 1 - Brier / Brier(always-5%). Positive means the model beat "always 5%" over these rows.
 *   DECOMPOSITION  Murphy's: Brier = reliability - resolution + uncertainty, on the calibration bins below. reliability is the miss
 *                of the calibration table (lower better), resolution is how far the bins move from the base rate (higher better),
 *                uncertainty is the base rate's own variance. The identity is asserted, not assumed.
 *   CALIBRATION  the table: fixed bins, stated here before any row was graded. Per bin: how many rows, the mean stated probability,
 *                the realised rate, and the gap. A bin with few rows says so; nothing is smoothed and no bin is merged.
 *   STORM TABLE  the same per storm state (calm / watch / storm): rows, mean p, realised rate.
 *
 * WHAT A SCORE OVER A FEW DOZEN ROWS IS WORTH: very little. A 5% event needs hundreds of sessions before a Brier difference means
 * anything (forward-power.js sized exactly this: at 63 sessions the median window holds 3 worst days). The output carries
 * `enoughToRead`, false until MIN_MATURED rows and MIN_WORST worst days are in, and the words to go with it. It is a scoreboard, not
 * a verdict.
 *
 *   node backend/worst-day/sealed-grade.js                   grade the live ledger against the training bars; write the JSON
 *   node backend/worst-day/sealed-grade.js --dry             the same, printed, nothing written
 *   node backend/worst-day/sealed-grade.js --ledger <f> --bars <f> --out <f>
 *   node backend/worst-day/sealed-grade.js --selftest        known answers on a synthetic ledger; writes only under a temp dir
 * Exit 0 graded · 1 failed · 2 usage or a file cannot be read · 3 REFUSED (the ledger does not pass its checker).
 */
const path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const SL = require("./sealed-ledger.js");
const SC = require("./sealed-check.js");
const NM = require("./nightly-model.js");

const P0 = 0.05;                                                     // the no-skill forecast: the target is a 5% event by construction
const BINS = [[0, 0.02], [0.02, 0.05], [0.05, 0.10], [0.10, 0.20], [0.20, 0.40], [0.40, 1.0]];   // fixed before any row was graded
const MIN_MATURED = 252, MIN_WORST = 20;                             // below this the table is printed and called too thin to read
const DEFAULT_OUT = path.join(__dirname, "..", "data", "worst-day", "sealed-grade.json");

const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null);
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null);
const r6 = (x) => (Number.isFinite(x) ? +x.toFixed(6) : null);
/** which fixed bin a probability falls in: [lo, hi), the last bin closed at 1 */
function binOf(p) { for (let k = 0; k < BINS.length; k++) { const [lo, hi] = BINS[k]; if (p >= lo && (p < hi || (k === BINS.length - 1 && p <= hi))) return k; } return -1; }

/**
 * Match every ledger row to the bars and say what happened to it.
 * Returns { matured: [{row, y, ret, barIndex}], pending: [...], disputed: [...] }
 */
function mature(rows, bars, { tol = 1e-9 } = {}) {
  const S = NM.series(bars), idx = new Map(S.d.map((d, i) => [d, i]));
  const matured = [], pending = [], disputed = [];
  for (const row of rows) {
    const i = idx.has(row.forDate) ? idx.get(row.forDate) : -1;
    const j = idx.has(row.asOfDate) ? idx.get(row.asOfDate) : -1;
    if (j < 0) { disputed.push({ row, why: `the bars hold no session ${row.asOfDate}, the close this row says it was decided at` }); continue; }
    if (Math.abs(S.adj[j] - row.asOfAdj) > tol * Math.max(1, Math.abs(row.asOfAdj))) { disputed.push({ row, why: `the row states the ${row.asOfDate} adjusted close as ${row.asOfAdj}, the bars say ${S.adj[j]}` }); continue; }
    if (i < 0) { pending.push({ row, why: `the bars do not reach ${row.forDate}` }); continue; }
    if (i === 0 || !Number.isFinite(S.r[i])) { pending.push({ row, why: `${row.forDate} has no session before it in the bars, so its close-to-close return cannot be computed` }); continue; }
    if (i !== j + 1) { disputed.push({ row, why: `${row.forDate} is bar ${i} and ${row.asOfDate} is bar ${j}: they are not consecutive sessions in the bars` }); continue; }
    matured.push({ row, ret: S.r[i], y: S.r[i] <= row.thr ? 1 : 0, barIndex: i });
  }
  return { matured, pending, disputed };
}

/** the whole scoreboard over matured rows */
function score(matured) {
  const N = matured.length;
  const blank = { n: 0, worst: 0, baseRate: null, brier: null, brierAlways5pct: null, brierClimatology: null, skillVsAlways5pct: null, skillVsClimatology: null,
    decomposition: null, calibration: BINS.map(([lo, hi]) => ({ from: lo, to: hi, n: 0, meanP: null, rate: null, gap: null })), storm: SL.STORM_STATES.map((s) => ({ storm: s, n: 0, meanP: null, worst: 0, rate: null })) };
  if (!N) return blank;
  let sy = 0, b = 0, b0 = 0;
  for (const m of matured) { sy += m.y; b += (m.row.p - m.y) ** 2; b0 += (P0 - m.y) ** 2; }
  const ybar = sy / N; b /= N; b0 /= N;
  let bc = 0; for (const m of matured) bc += (ybar - m.y) ** 2; bc /= N;

  const cal = BINS.map(([lo, hi]) => ({ from: lo, to: hi, n: 0, sumP: 0, sumY: 0 }));
  for (const m of matured) { const k = binOf(m.row.p); if (k < 0) throw new Error(`p ${m.row.p} of row ${m.row.seq} falls in no bin`); cal[k].n++; cal[k].sumP += m.row.p; cal[k].sumY += m.y; }
  let rel = 0, res = 0;
  for (const c of cal) { if (!c.n) continue; const pb = c.sumP / c.n, yb = c.sumY / c.n; rel += c.n * (pb - yb) ** 2; res += c.n * (yb - ybar) ** 2; }
  rel /= N; res /= N;
  const unc = ybar * (1 - ybar);
  // Murphy's identity holds only when the forecast is read through the same bins; within a bin p varies, so the within-bin spread is
  // the remainder. It is reported rather than hidden, and it is 0 when every row in a bin states the same probability.
  const remainder = b - (rel - res + unc);

  const storm = SL.STORM_STATES.map((s) => {
    const g = matured.filter((m) => m.row.storm === s), w = g.reduce((a, m) => a + m.y, 0);
    return { storm: s, n: g.length, meanP: g.length ? r6(g.reduce((a, m) => a + m.row.p, 0) / g.length) : null, worst: w, rate: g.length ? r6(w / g.length) : null };
  });
  return {
    n: N, worst: sy, baseRate: r6(ybar),
    brier: r6(b), brierAlways5pct: r6(b0), brierClimatology: r6(bc),
    skillVsAlways5pct: r6(1 - b / b0), skillVsClimatology: bc > 0 ? r6(1 - b / bc) : null,
    decomposition: { reliability: r6(rel), resolution: r6(res), uncertainty: r6(unc), withinBinRemainder: r6(remainder), identityHolds: Math.abs(remainder) < 1e-9 },
    calibration: cal.map((c) => ({ from: c.from, to: c.to, n: c.n, meanP: c.n ? r6(c.sumP / c.n) : null, rate: c.n ? r6(c.sumY / c.n) : null, gap: c.n ? r6(c.sumP / c.n - c.sumY / c.n) : null, worst: c.sumY })),
    storm,
  };
}

/** the whole run. Returns { code, result, out, lines }. */
function run({ ledgerFile = SC.DEFAULT_LEDGER, barsFile = require("./nightly-forecast.js").DEFAULT_BARS, outFile = DEFAULT_OUT, dry = false, now = Date.now(), holidays = SC.HOLIDAYS, log = (s) => console.log(s), writeJson = writeJsonAtomic } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  let bars;
  try { bars = NM.readBars(barsFile); } catch (e) { say(`the bars cannot be read: ${barsFile} — ${e.message}`); return { code: 2, result: "no-bars", lines }; }
  const v = SC.checkFile(ledgerFile, { now, holidays });
  say(SC.report(v));
  if (!v.ok) { say("GRADED NOTHING — the ledger is refused by its own checker. A score over rows that may not have been sealed is worse than no score."); return { code: 3, result: "refused", lines, check: v }; }
  const rows = SL.readLedger(ledgerFile).rows;
  const M = mature(rows, bars);
  const S = score(M.matured);
  const enough = S.n >= MIN_MATURED && S.worst >= MIN_WORST;
  const out = {
    spec: "worst-day-sealed-grade-v1", asOf: new Date(now).toISOString(), command: "node backend/worst-day/sealed-grade.js",
    ledger: { file: path.relative(path.join(__dirname, "..", ".."), ledgerFile).replace(/\\/g, "/"), rows: rows.length, first: rows.length ? rows[0].forDate : null, last: rows.length ? rows[rows.length - 1].forDate : null, tipHash: rows.length ? rows[rows.length - 1].hash : null },
    bars: { file: path.relative(path.join(__dirname, "..", ".."), barsFile).replace(/\\/g, "/"), sessions: bars.length, first: bars.length ? bars[0].d : null, last: bars.length ? bars[bars.length - 1].d : null },
    sealCheck: { passed: v.ok, checks: v.checks.map((c) => ({ id: c.id, ok: c.ok })) },
    maturity: { matured: M.matured.length, pending: M.pending.length, disputed: M.disputed.length,
      maturedFrom: M.matured.length ? M.matured[0].row.forDate : null, maturedTo: M.matured.length ? M.matured[M.matured.length - 1].row.forDate : null,
      disputedRows: M.disputed.map((x) => ({ seq: x.row.seq, forDate: x.row.forDate, why: x.why })),
      pendingRows: M.pending.slice(0, 10).map((x) => ({ seq: x.row.seq, forDate: x.row.forDate, why: x.why })) },
    definitions: { p0: P0, label: "y = 1 when forDate's close-to-close total return is at or below the row's own stated thr (the nearest-rank 5th percentile of the trailing window at the decision close)", bins: BINS, brier: "mean (p - y)^2", skill: "1 - Brier / Brier(always-5%)", decomposition: "Murphy: Brier = reliability - resolution + uncertainty, read through the fixed bins; withinBinRemainder is what the bins cannot see" },
    score: S,
    enoughToRead: enough,
    reading: enough ? `${S.n} matured rows with ${S.worst} worst days. Read the calibration table before the skill number: a Brier difference on a 5% event is a small number over any span.`
      : `TOO THIN TO READ: ${S.n} matured row(s) and ${S.worst} worst day(s); the bar set in advance is ${MIN_MATURED} rows and ${MIN_WORST} worst days. Every number below is printed so it can be watched accumulate, not so it can be believed.`,
  };
  say(renderTable(out));
  if (dry) { say(`DRY — nothing written (it would have gone to ${outFile}).`); return { code: 0, result: "dry", lines, out }; }
  writeJson(outFile, out);
  say(`written ${outFile}`);
  return { code: 0, result: "graded", lines, out };
}

function renderTable(o) {
  const S = o.score, L = [];
  L.push(`GRADE — ${o.maturity.matured} matured of ${o.ledger.rows} row(s) (${o.maturity.pending} pending, ${o.maturity.disputed} disputed)${o.maturity.maturedFrom ? `, ${o.maturity.maturedFrom} .. ${o.maturity.maturedTo}` : ""}`);
  for (const d of o.maturity.disputedRows) L.push(`  DISPUTED row ${d.seq} (${d.forDate}): ${d.why}`);
  if (!S.n) { L.push("  nothing has matured yet — no score."); L.push(o.reading); return L.join("\n"); }
  L.push(`  worst days ${S.worst} of ${S.n} (${(100 * S.baseRate).toFixed(2)}%)   Brier ${S.brier}   always-5% ${S.brierAlways5pct}   climatology (in-sample) ${S.brierClimatology}`);
  L.push(`  skill vs always-5% ${(100 * S.skillVsAlways5pct).toFixed(2)}%   reliability ${S.decomposition.reliability}  resolution ${S.decomposition.resolution}  uncertainty ${S.decomposition.uncertainty}  within-bin ${S.decomposition.withinBinRemainder}`);
  L.push("  CALIBRATION          rows   mean p   realised   gap");
  for (const c of S.calibration) L.push(`    ${(`${c.from.toFixed(2)}-${c.to.toFixed(2)}`).padEnd(18)} ${String(c.n).padStart(5)}   ${c.meanP === null ? "    -" : c.meanP.toFixed(4)}    ${c.rate === null ? "    -" : c.rate.toFixed(4)}   ${c.gap === null ? "    -" : (c.gap >= 0 ? "+" : "") + c.gap.toFixed(4)}`);
  L.push("  STORM STATE          rows   mean p   realised");
  for (const s of S.storm) L.push(`    ${s.storm.padEnd(18)} ${String(s.n).padStart(5)}   ${s.meanP === null ? "    -" : s.meanP.toFixed(4)}    ${s.rate === null ? "    -" : s.rate.toFixed(4)}`);
  L.push(`  ${o.reading}`);
  return L.join("\n");
}

module.exports = { run, mature, score, binOf, renderTable, P0, BINS, MIN_MATURED, MIN_WORST, DEFAULT_OUT };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes("--selftest")) { process.exitCode = require("./sealed-selftest.js").run(["sealed-grade"]); return; }
  const usage = (why) => { console.error(`${why}\nusage: node backend/worst-day/sealed-grade.js [--dry] [--ledger <f>] [--bars <f>] [--out <f>]\n       node backend/worst-day/sealed-grade.js --selftest\nNothing was done.`); process.exit(2); };
  let dry = false, ledgerFile = SC.DEFAULT_LEDGER, barsFile = require("./nightly-forecast.js").DEFAULT_BARS, outFile = DEFAULT_OUT;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--dry") dry = true;
    else if (a[i] === "--ledger") { ledgerFile = a[++i] || usage("--ledger needs a path"); }
    else if (a[i] === "--bars") { barsFile = a[++i] || usage("--bars needs a path"); }
    else if (a[i] === "--out") { outFile = a[++i] || usage("--out needs a path"); }
    else usage(`unknown argument ${a[i]}`);
  }
  let r; try { r = run({ ledgerFile: path.resolve(ledgerFile), barsFile: path.resolve(barsFile), outFile: path.resolve(outFile), dry }); } catch (e) { console.error(`sealed-grade FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
