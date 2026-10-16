#!/usr/bin/env node
/**
 * INTRADAY HISTORY — the R39 family graded on two years of backfilled sessions. (2026-08-23)
 *
 * IN-SAMPLE EXPLORATION, labelled as such. R39's rules were fixed on 2026-08-21 with no backtest;
 * this runs the SAME code (lib/intraday-rules.js, proven identical on the sealed 2026-08-21 session)
 * over data/intraday-history/*.json. Because the rules have no fitted parameters, history is an
 * honest check of a pre-specified rule — but it is still history: today's roster applied to the
 * past (survivorship declared), IEX bars, and the operator saw the forward preview sessions before
 * this ran. R39's registered verdict still comes ONLY from forward sessions >= 2026-08-24.
 *
 * Reports per variant: sessions, signals, win %, mean daily R, day-clustered t, the best-of-2 null
 * bar at that session count, and a split by half-year so stability is visible, not assumed.
 *
 * Every signal row also carries FEATURES known at the signal bar (nothing after it), so the R41
 * combined model (intraday-model.js) can train on history: minutes since open, direction, the
 * setup's magnitude (ORB range % / VWAP deviation %), the name's own return to the signal, SPY's
 * return to the signal and over the prior 25 minutes, the overnight gap, the prior session's return,
 * and the signal bar's own range. Cached in data/intraday-history-family.json.
 *
 * Usage: node backend/intraday-history.js            grade any ungraded history session, print the read
 *        node backend/intraday-history.js --regrade  drop the cache and grade everything again
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const NB = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("intraday-history-family.json"), DIR = D("intraday-history");
const SPEC = "R39 history read v2 (in-sample exploration; rows carry signal-time features)";
const { FEATURES, features, sessionEdges } = require("./lib/intraday-features.js");
const COST_SIDE = (() => { try { return JSON.parse(fs.readFileSync(D("cost-model.json"), "utf8")).perClass.Equity.spreadPctSide / 100; } catch { return 0.001; } })();
const { gradeSession } = require("./lib/intraday-rules.js").makeRules(COST_SIDE);
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const tOf = (a) => { const k = a.length; if (k < 2) return null; const g = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1)); return sd > 0 ? +(g / (sd / Math.sqrt(k))).toFixed(3) : null; };
const VARS = ["orb30", "vwapr"];


const regrade = process.argv.includes("--regrade");
let st = (!regrade && fs.existsSync(OUT)) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
if (!st || st.spec !== SPEC) st = { spec: SPEC, rules: "lib/intraday-rules.js — identical to R39", features: FEATURES, days: {} };
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort() : [];
let graded = 0; const t0 = Date.now();
let prevDay = null, prevMap = null;   // previous session's per-symbol {open, close} for gap / prior-return features
for (const day of files) {
  const need = !st.days[day];
  if (!need && !files.includes(day)) continue;
  const J = JSON.parse(fs.readFileSync(path.join(DIR, `${day}.json`), "utf8"));
  if (need) {
    // the previous file on disk is the previous session (holidays were never written)
    if (prevDay !== day && prevMap === null) { const pi = files.indexOf(day) - 1; if (pi >= 0) { const P = JSON.parse(fs.readFileSync(path.join(DIR, `${files[pi]}.json`), "utf8")); prevMap = sessionEdges(P.symbols); } }
    const rows = gradeSession(J.symbols);
    const spy = J.symbols.SPY || [];
    const summ = (rs) => ({ n: rs.length, win: rs.length ? +(100 * rs.filter((x) => x.win).length / rs.length).toFixed(1) : null, avgR: rs.length ? +mean(rs.map((x) => x.r)).toFixed(4) : null, how: rs.reduce((o, x) => (o[x.how] = (o[x.how] || 0) + 1, o), {}) });
    const pack = (rs) => rs.map((x) => [x.sym, x.dir, x.sig, x.r, x.how, ...features(x, J.symbols[x.sym], spy, prevMap?.[x.sym])]);
    st.days[day] = { covered: J.covered, orb30: summ(rows.orb30), vwapr: summ(rows.vwapr), rows: { orb30: pack(rows.orb30), vwapr: pack(rows.vwapr) } };
    graded++;
  }
  prevDay = day; prevMap = sessionEdges(J.symbols);
}
const days = Object.keys(st.days).sort();
const half = (d) => d.slice(0, 4) + (d.slice(5, 7) <= "06" ? "H1" : "H2");
const stats = {};
for (const v of VARS) {
  const daily = days.map((d) => st.days[d][v].avgR).filter((x) => x != null);
  const n = days.reduce((s, d) => s + st.days[d][v].n, 0);
  const wins = days.reduce((s, d) => s + (st.days[d][v].win || 0) * st.days[d][v].n, 0);
  const byHalf = {};
  for (const d of days) { const h = half(d); (byHalf[h] ||= []).push(st.days[d][v].avgR); }
  stats[v] = { sessions: daily.length, n, win: n ? +(wins / n).toFixed(1) : null, meanDailyR: daily.length ? +mean(daily).toFixed(4) : null, t: tOf(daily),
    byHalf: Object.fromEntries(Object.entries(byHalf).sort().map(([h, a]) => [h, { sessions: a.length, meanDailyR: +mean(a).toFixed(4), t: tOf(a) }])) };
}
const S = days.length;
const bar = S >= 5 ? NB.nullBar({ variants: 2, n: S, trials: 2000 }) : null;
const read = S ? VARS.map((v) => `${v}: ${stats[v].meanDailyR > 0 && bar && stats[v].t >= bar.p95 ? "CLEARS the in-sample bar" : "does not clear"} (t ${stats[v].t} vs best-of-2 bar ${bar?.p95 ?? "n/a"})`).join(" · ") : "no sessions";
Object.assign(st, { asOf: new Date().toISOString(), inSample: true, survivorship: "today's top-1,200 roster applied to the past — declared", costSidePct: +(100 * COST_SIDE).toFixed(3), sessions: S, range: S ? [days[0], days[S - 1]] : null, stats, nullBar: bar, read });
writeJsonAtomic(OUT, st);
console.log(`R39 HISTORY (in-sample exploration) — ${S} sessions ${S ? days[0] + " → " + days[S - 1] : ""} · graded ${graded} new in ${((Date.now() - t0) / 1000).toFixed(0)}s · cost ${(100 * COST_SIDE).toFixed(2)}%/side`);
for (const v of VARS) { const x = stats[v]; console.log(`  ${v.padEnd(6)} sessions ${x.sessions} · signals ${x.n.toLocaleString()} · win ${x.win}% · mean daily R ${x.meanDailyR} · day-clustered t ${x.t}`); for (const [h, y] of Object.entries(x.byHalf)) console.log(`         ${h}: ${y.sessions} sessions · mean daily R ${y.meanDailyR} · t ${y.t}`); }
console.log(`  ${read}`);
console.log("written: intraday-history-family.json");
