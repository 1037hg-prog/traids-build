#!/usr/bin/env node
/**
 * TRAIDS — FUTURES TESTBED (shared module)
 *
 * The standing harness distilled from tests #15/#36/#37 + the resolution check, so any new
 * pre-registered futures hypothesis is ~30 lines instead of a 200-line script. Every test
 * built on this automatically inherits:
 *   • front-month stitching by daily volume (no roll gaps, no back-month illiquidity)
 *   • honest fills: next-bar-open entries, gap-aware exits (open through a level fills at
 *     the open), stop-first inside an ambiguous bar (conservative — validated ≤0.9% of
 *     trades and ≤0.8pp of win rate vs a 1-minute walk on NQ)
 *   • the stats gauntlet: day-clustered t (two-sided p), 60/40 chronological OOS,
 *     Bonferroni across the pre-registered variant family, fixed verdict rule
 *
 * USAGE PATTERN (a complete new test):
 *   const tb = require("./futures-testbed");
 *   (async () => {
 *     const sessions = tb.sessionize(await tb.loadBars({ root: "NQ" }));
 *     const v = { name: "my hypothesis", trades: [] };
 *     for (const [date, bars] of Object.entries(sessions)) {
 *       for (let i = 1; i < bars.length; i++) {
 *         if (!mySignal(bars, i)) continue;                       // your rule here
 *         const t = tb.trade(bars, i + 1, +1, bars[i].l, bars[i].c + 10, { costPts: 0.75 });
 *         if (t) { v.trades.push({ date, ...t }); i = t.k; }
 *       }
 *     }
 *     tb.report([v], { title: "MY TEST (test #NN)" });
 *   })();
 *
 * DISCIPLINE (non-negotiable, same as always): design + variant family + verdict rule are
 * fixed BEFORE the run; the Bonferroni divisor is the size of the family you searched, not
 * the number you liked; a dead hypothesis stays dead — no post-hoc filter mining.
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
// 2026-10-02 Massive exit: no vendor key here any more — loadBars() reads the local futures store (lib/futures-bars.js).

const MCODES = ["F","G","H","J","K","M","N","Q","U","V","X","Z"];

// (2026-10-02 Massive exit: the 2026-09-16 Massive pagination fix lived here with the private client it fixed; see git history.)
const fmtET = (ns) => {
  const d = new Date(ns / 1e6);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t) => p.find(x => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
};

/**
 * Front-month-stitched bars — from the LOCAL STORE since 2026-10-02 Massive exit (lib/futures-bars.js): the Massive 1m archive
 * (2024-09-27..2026-10-02, front month by daily volume, identical bar for bar to what this function used to fetch on every nightly
 * window) extended nightly from Schwab pricehistory 1m (backend/futures-bars-append.js). Same arguments, same rows
 * { ns, date, time, o, h, l, c, v }; N-minute resolutions are built from 1m on the clock; `pages` is ignored. Unknown roots throw.
 */
async function loadBars({ root = "NQ", resolution = "5minute", lookbackDays = 760, pages = 6, quiet = false } = {}) {
  return require("./lib/futures-bars.js").loadBars({ root, resolution, lookbackDays, pages, quiet });
}

/** Group bars into { date: [bars] } within an ET time window (default RTH). */
function sessionize(bars, { start = "09:30", end = "16:00", minBars = 20 } = {}) {
  const days = {};
  for (const b of bars) if (b.time >= start && b.time < end) (days[b.date] ||= []).push(b);
  for (const d of Object.keys(days)) if (days[d].length < minBars) delete days[d];
  return days;
}

/** Aggregate n consecutive base bars into higher-TF candles (session-open aligned). Each carries endIdx into the base array. */
function aggregate(bars, n) {
  const out = [];
  for (let i = 0; i + n - 1 < bars.length; i += n) {
    const grp = bars.slice(i, i + n);
    out.push({ time: grp[0].time, endIdx: i + n - 1, o: grp[0].o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1].c, v: grp.reduce((s, b) => s + (b.v || 0), 0) });
  }
  return out;
}

/**
 * Settle one bracket trade on `bars` starting at entryIdx. Entry at bars[entryIdx].o.
 * Gap-aware, stop-first, force-flat at flatTime, last-close if nothing hits.
 * Returns { entry, exit, k, pnl, r, win } or null (bad geometry / off end of session).
 */
function trade(bars, entryIdx, dir, stop, target, { costPts = 0.75, flatTime = "15:55", minRisk = 0.5 } = {}) {
  if (entryIdx >= bars.length) return null;
  const entry = bars[entryIdx].o;
  const risk = Math.abs(entry - stop);
  if (!(risk >= minRisk)) return null;
  let exit = null, k = entryIdx;
  for (; k < bars.length; k++) {
    const b = bars[k];
    if (b.time >= flatTime) { exit = b.o; break; }
    const gapStop = dir > 0 ? b.o <= stop : b.o >= stop;
    const gapTgt = dir > 0 ? b.o >= target : b.o <= target;
    if (gapStop || gapTgt) { exit = b.o; break; }
    const hitStop = dir > 0 ? b.l <= stop : b.h >= stop;
    const hitTgt = dir > 0 ? b.h >= target : b.l <= target;
    if (hitStop) { exit = stop; break; }
    if (hitTgt) { exit = target; break; }
  }
  if (exit == null) { exit = bars[bars.length - 1].c; k = bars.length - 1; }
  const pnl = (exit - entry) * dir - costPts;
  return { entry, exit, k, pnl, r: pnl / risk, win: pnl > 0 };
}

// ── stats ──
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tOf = a => a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0;
const pOf = t => { const z = Math.abs(t); return Math.min(1, Math.exp(-0.717 * z - 0.416 * z * z)); }; // two-sided normal approx — do NOT double
const dayT = trades => { const byDay = {}; for (const t of trades) (byDay[t.date] ||= []).push(t.r); return tOf(Object.values(byDay).map(mean)); };

/**
 * The standard adjudication table. variants: [{ name, trades: [{date, r, win}] }].
 * Verdict rule (fixed): survives ⇔ full-sample p < 0.05/family AND t > 0 AND
 * OOS (last 40%, chronological) day-t > 1.96 with positive OOS mean.
 * Returns { anySurvived, rows }.
 */
function report(variants, { title = "TESTBED RUN", minN = 100, oosFrac = 0.4, familySize = null, notes = "" } = {}) {
  const N = familySize || variants.length, BONF = 0.05 / N;
  console.log(`\n  TRAIDS — ${title}`);
  if (notes) console.log(`  ${notes}`);
  console.log(`  verdict bar: Bonferroni ×${N} (p<${BONF.toFixed(4)}) + OOS day-t>1.96 with positive OOS mean\n`);
  console.log("  variant                     n      win%    avg R     PF     day-t     p        OOS avgR  OOS t   verdict");
  console.log("  " + "-".repeat(110));
  let anySurvived = false; const rows = [];
  for (const v of variants) {
    const T = v.trades;
    if (T.length < minN) { console.log(`  ${v.name.padEnd(26)} n=${T.length} — insufficient`); rows.push({ name: v.name, n: T.length, insufficient: true }); continue; }
    const rs = T.map(t => t.r), win = T.filter(t => t.win).length / T.length * 100;
    const gains = rs.filter(r => r > 0).reduce((s, r) => s + r, 0), losses = -rs.filter(r => r < 0).reduce((s, r) => s + r, 0);
    const pf = losses > 0 ? gains / losses : 99;
    const t = dayT(T), p = pOf(t);
    const oos = T.slice(Math.floor(T.length * (1 - oosFrac)));
    const oT = dayT(oos), oM = mean(oos.map(x => x.r));
    const survived = p < BONF && t > 0 && oT > 1.96 && oM > 0;
    if (survived) anySurvived = true;
    rows.push({ name: v.name, n: T.length, win, avgR: mean(rs), pf, dayT: t, p, oosAvgR: oM, oosT: oT, survived });
    console.log(`  ${v.name.padEnd(26)}${String(T.length).padStart(5)}${win.toFixed(1).padStart(8)}%${((mean(rs) >= 0 ? "+" : "") + mean(rs).toFixed(4)).padStart(9)}${pf.toFixed(2).padStart(7)}${t.toFixed(2).padStart(9)}${p.toExponential(1).padStart(10)}${((oM >= 0 ? "+" : "") + oM.toFixed(4)).padStart(10)}${oT.toFixed(2).padStart(8)}   ${survived ? "★ SURVIVES" : "not established"}`);
  }
  console.log("\n  ── PRE-REGISTERED VERDICT ──");
  console.log(anySurvived
    ? "    ★ At least one variant clears the full bar — goes to the approval queue, never straight to trading."
    : "    ✕ No variant clears the pre-registered bar — not established.");
  console.log("");
  return { anySurvived, rows };
}

module.exports = { loadBars, sessionize, aggregate, trade, report, mean, sd, tOf, pOf, dayT, fmtET };
