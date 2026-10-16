#!/usr/bin/env node
/**
 * R94 — R7's LONG-ONLY SUCCESSOR. Registered 2026-09-03, evidence from 2026-09-04.
 *
 * WHY A SUCCESSOR AND NOT A RE-READ. R7 cleared its registered primary bar on 2026-09-03 (cohort A,
 * +3d, market-relative, day-clustered t 2.45 vs 2.0). Reading the same rows by side afterwards showed
 * the effect lives on the BUY calls (h3 +0.647%, h5 +1.33% t 3.10) while SELL calls are flat to
 * negative (h3 -0.135%, t -0.25). R7's registration says a re-tune means abandoning R7 and registering
 * R8; the id R8 was long since taken, so this is R94. Same collector, same settled rows, a FRESH
 * evidence window, and the two things the R7 read owed but had not registered:
 *   - a best-of-N bar: two sides x three horizons were examined to find "long-only, +3d", so the bar is
 *     the best-of-6 p95 from lib/null-bar.js at 20 days (registry: bar.tRequired);
 *   - a WITHIN-DAY DIRECTION-SHUFFLE NULL: per day, the BUY/SELL labels are permuted across that day's
 *     directional rows (the day's long tilt and the universe's excess return are preserved), and the
 *     observed day-clustered t must sit above the null's 95th percentile. On R7's own rows this null
 *     had p 0.169 at +3d — the pooled result was mostly "63% long on a universe that beat SPY" — and
 *     p 0.019 / 0.000 at +1d / +5d. R94 registers it, so it is a bar and not a post-hoc caveat.
 *
 * READ-ONLY on the collector's data. Writes data/r94-long-only.json. Excludes any settled day before
 * the evidence start. Nothing trades on this.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const NB = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const all = []; for (const k of Object.keys(reg)) if (Array.isArray(reg[k])) all.push(...reg[k]);
const T = all.find((x) => String(x.id) === "R94");
if (!T || !T.bar) { console.error("R94 not registered — refusing to grade against nothing"); process.exit(1); }
const EV = T.evidenceStart, BAR = T.bar;
const j = JSON.parse(fs.readFileSync(D("r7-scanner-shadow.json"), "utf8"));
const S = j.settled || {};
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const tOf = (a) => { const k = a.length; if (k < 2) return null; const g = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1)); return sd > 0 ? g / (sd / Math.sqrt(k)) : null; };
const r = (x, d = 3) => x == null ? null : +Number(x).toFixed(d);
const days = Object.keys(S).filter((d) => d >= EV).sort();

function cell(h, side) {
  const dm = [], n = { calls: 0 };
  for (const d of days) { const c = S[d]["h" + h]; if (!c) continue; const rows = c.rows.filter((x) => x.dir !== 0 && Number.isFinite(x.alpha) && (side == null || Math.sign(x.dir) === side)); if (!rows.length) continue; dm.push(mean(rows.map((x) => x.alpha))); n.calls += rows.length; }
  return { days: dm.length, calls: n.calls, meanAlphaPct: r(mean(dm)), t: r(tOf(dm), 2), dayMeans: dm };
}
function shuffleNull(h, draws = 3000) {
  const perDay = [];
  for (const d of days) { const c = S[d]["h" + h]; if (!c) continue; const rows = c.rows.filter((x) => x.dir !== 0 && Number.isFinite(x.alpha)); if (rows.length) perDay.push(rows.map((x) => ({ dir: Math.sign(x.dir), raw: x.alpha * x.dir }))); }
  if (perDay.length < 2) return null;
  // observed statistic = the LONG-ONLY day-clustered t; null = same statistic after permuting the day's labels
  const longT = (rowsByDay, dirsByDay) => tOf(rowsByDay.map((rows, k) => { const v = rows.map((x, i) => dirsByDay[k][i] > 0 ? x.raw : null).filter((x) => x != null); return v.length ? mean(v) : null; }).filter((x) => x != null));
  const obs = longT(perDay, perDay.map((rows) => rows.map((x) => x.dir)));
  const ts = []; let ge = 0;
  for (let k = 0; k < draws; k++) {
    const dirs = perDay.map((rows) => { const d = rows.map((x) => x.dir); /* null draw: permutation of observed directions within the day — never a price */ for (let i = d.length - 1; i > 0; i--) { const q = Math.floor(Math.random() * (i + 1)); [d[i], d[q]] = [d[q], d[i]]; } return d; });
    const t = longT(perDay, dirs); if (t == null) continue; ts.push(t); if (t >= obs) ge++;
  }
  ts.sort((a, b) => a - b);
  return { observedT: r(obs, 2), p: r(ge / ts.length, 4), p95: r(ts[Math.floor(ts.length * 0.95)], 2), draws: ts.length };
}
const primary = cell(3, 1), h1 = cell(1, 1), h5 = cell(5, 1), sellRef = cell(3, -1), allRef = cell(3, null);
const nul = days.length >= 5 ? shuffleNull(3) : null;
const met = primary.days >= BAR.minDays && primary.calls >= BAR.minBuyCalls;
let verdict;
if (!met) verdict = `ACCRUING — ${primary.days}/${BAR.minDays} days, ${primary.calls}/${BAR.minBuyCalls} BUY calls`;
else if (primary.t >= BAR.tRequired && nul && nul.p <= BAR.shufflePMax) verdict = "PASS — long-only calls beat the best-of-6 bar AND the within-day shuffle null";
else verdict = `DID NOT PASS — t ${primary.t} vs ${BAR.tRequired}; shuffle p ${nul ? nul.p : "n/a"} vs ${BAR.shufflePMax}`;
const out = { spec: "r94-v1", test: "R94", evidenceStart: EV, asOf: new Date().toISOString(), daysSettled: days.length, bar: BAR,
  primary: { endpoint: "cohort A · BUY calls only · +3d · market-relative · day-clustered", ...primary, dayMeans: undefined }, secondary: { h1: { ...h1, dayMeans: undefined }, h5: { ...h5, dayMeans: undefined } },
  reference: { sellH3: { ...sellRef, dayMeans: undefined }, allH3: { ...allRef, dayMeans: undefined } }, shuffleNull: nul, verdict, contract: "PAPER, observe-only. Nothing trades on this; a PASS proposes a long-only stamp variant for the operator's decision.",
  // 2026-09-10 (coverage-mechanic): dailyClock exposes the bar's own unit (days, per BAR.minDays) so the
  // triage clock reads accrual directly. primary.days is ALREADY the count of settled days >= EV (the
  // evidence start) that contributed a BUY-call row -- not a whole-history count. The bar also requires
  // minBuyCalls and a passing shuffle-null p, both surfaced alongside rather than folded into one number.
  dailyClock: { sessions: primary.days, estimate: primary.t, unit: `days (day-clustered t of BUY-call market-relative +3d alpha; bar also requires >=${BAR.minBuyCalls} BUY calls, currently ${primary.calls}, AND shuffle-null p<=${BAR.shufflePMax}, currently ${nul ? nul.p : "n/a"})`, sessionMeans: primary.dayMeans.map((x) => r(x, 4)) },
};
fs.writeFileSync(D("r94-long-only.json"), JSON.stringify(out, null, 1));
console.log(`R94 long-only — ${verdict}  (days ${primary.days}, BUY calls ${primary.calls}, mean ${primary.meanAlphaPct}%, t ${primary.t}${nul ? `, shuffle p ${nul.p}` : ""})`);
