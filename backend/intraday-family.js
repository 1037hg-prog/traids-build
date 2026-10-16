#!/usr/bin/env node
/**
 * R39 — THE INTRADAY FAMILY (manifest D4). REGISTERED 2026-08-21, evidence from 2026-08-24.
 * A third horizon: hours, inside the session, flat at 15:55. Two pre-specified rules on the roster's
 * 5-minute bars (intraday-bars.js), graded as a FAMILY with the best-of-2 null bar.
 *
 *   ORB30   opening range = high/low of the 09:30–09:55 bars (range set at 10:00). After 10:00, the
 *           first 5m CLOSE above the range high → long at the next bar's open; below the low → short.
 *           Stop = the far side of the range; target = entry ± 1.5 × range (R:R 1.5). Ranges narrower
 *           than 0.3% or wider than 3% of price are skipped (no structure / no edge in the stop).
 *   VWAPR   from 10:30, session VWAP (cumulative vw·v / v). A 5m close ≥ 1.5% above VWAP → short
 *           at the next open, target = VWAP at signal, stop = entry + 1%; ≤ 1.5% below → long.
 *   Both: one trade per name per day; path exits on the following 5m bars, gap-aware, stop-first;
 *   flat at the 15:55 open; cost = the cost model's equity spread (10 bps/side declared until
 *   measured) subtracted from every trade. R = (pnl − cost) / risk.
 *
 *   BAR  per variant: mean R > 0, day-clustered t ≥ the best-of-2 null bar (~2.4) at ≥ 30 sessions
 *        and ≥ 200 signals; interim kill-only at 16 sessions (t ≤ −2). Sealed per session. Sessions
 *        before 2026-08-24 are PREVIEW. If cleared → proposal for an intraday paper sleeve with its
 *        own sizing; never auto-funded. Declared weakness: IEX bars (thin volume) and 5-minute path
 *        resolution — intrabar ambiguity resolved stop-first, the conservative way, as everywhere here.
 * Output: data/intraday-family.json. Nightly after intraday-bars.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const NB = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("intraday-family.json"), DIR = D("intraday");
const REGISTERED = "2026-08-21", EVIDENCE_START = "2026-08-24";
const BAR = { minSessions: 30, minSignals: 200, familySize: 2, interimSessions: 16, interimKillT: -2.0 };
const COST_SIDE = (() => { try { return JSON.parse(fs.readFileSync(D("cost-model.json"), "utf8")).perClass.Equity.spreadPctSide / 100; } catch { return 0.001; } })();   // fraction of price per side
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const tOf = (a) => { const k = a.length; if (k < 2) return null; const g = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1)); return sd > 0 ? +(g / (sd / Math.sqrt(k))).toFixed(3) : null; };

// The rules live in lib/intraday-rules.js since 2026-08-23 (extracted verbatim; proven identical on the sealed
// 2026-08-21 session) so the two-year history grader runs THIS rule, not a copy. Cost binding unchanged.
const { orb30, vwapr } = require("./lib/intraday-rules.js").makeRules(COST_SIDE);

(() => {
  const st = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return { spec: "R39 intraday-family-v1", registered: REGISTERED, evidenceStart: EVIDENCE_START, bar: BAR, days: {} }; } })();
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort() : [];
  let graded = 0;
  for (const day of files) {
    if (st.days[day]) continue;   // sealed
    const J = JSON.parse(fs.readFileSync(path.join(DIR, `${day}.json`), "utf8"));
    const rows = { orb30: [], vwapr: [] };
    for (const [sym, bars] of Object.entries(J.symbols)) { if (sym === "SPY") continue;
      const a = orb30(bars); if (a && Number.isFinite(a.r)) rows.orb30.push({ sym, ...a });
      const b = vwapr(bars); if (b && Number.isFinite(b.r)) rows.vwapr.push({ sym, ...b }); }
    const summ = (rs) => ({ n: rs.length, win: rs.length ? +(100 * rs.filter((x) => x.win).length / rs.length).toFixed(1) : null, avgR: rs.length ? +mean(rs.map((x) => x.r)).toFixed(4) : null, how: rs.reduce((o, x) => (o[x.how] = (o[x.how] || 0) + 1, o), {}) });
    st.days[day] = { sealedAt: new Date().toISOString(), preview: day < EVIDENCE_START, covered: J.covered, orb30: summ(rows.orb30), vwapr: summ(rows.vwapr), trades: rows };
    graded++;
  }
  const ev = Object.entries(st.days).filter(([d]) => d >= EVIDENCE_START);
  const stats = {};
  for (const v of ["orb30", "vwapr"]) { const daily = ev.map(([, x]) => x[v].avgR).filter((x) => x != null); const n = ev.reduce((s, [, x]) => s + x[v].n, 0); stats[v] = { sessions: daily.length, n, meanDailyR: daily.length ? +mean(daily).toFixed(4) : null, t: tOf(daily), win: n ? +(ev.reduce((s, [, x]) => s + (x[v].win || 0) * x[v].n, 0) / n).toFixed(1) : null }; }
  const S = ev.length;
  const best = ["orb30", "vwapr"].filter((v) => stats[v].t != null).sort((a, b) => stats[b].t - stats[a].t)[0];
  const honest = best && S >= 5 ? NB.nullBar({ variants: BAR.familySize, n: S, trials: 2000 }) : null;
  let verdict;
  if (S < BAR.interimSessions) verdict = `ACCRUING — ${S}/${BAR.minSessions} evidence sessions`;
  else if (S < BAR.minSessions) verdict = ["orb30", "vwapr"].filter((v) => stats[v].t != null && stats[v].t <= BAR.interimKillT).map((v) => `${v} KILLED at interim`).join(", ") || `ACCRUING — interim at ${S}: none dead`;
  else { const clear = ["orb30", "vwapr"].filter((v) => stats[v].meanDailyR > 0 && stats[v].t >= honest.p95 && stats[v].n >= BAR.minSignals); verdict = clear.length ? `CLEARED (best-of-2 bar ${honest.p95}): ${clear.join(", ")} — proposal for an intraday paper sleeve` : `DID NOT PASS — neither variant clears the best-of-2 bar ${honest.p95}`; }
  Object.assign(st, { asOf: new Date().toISOString(), costSidePct: +(100 * COST_SIDE).toFixed(3), evidenceSessions: S, stats, verdict });
  const keys = Object.keys(st.days).sort(); for (const k of keys.slice(0, Math.max(0, keys.length - 120))) { st.days[k] = { ...st.days[k], trades: undefined }; }   // keep summaries, trim old trade lists
  writeJsonAtomic(OUT, st);
  const last = keys[keys.length - 1]; const L = st.days[last];
  console.log(`R39 INTRADAY FAMILY — registered ${REGISTERED}, evidence from ${EVIDENCE_START} · graded ${graded} new session(s) · ${verdict}`);
  if (L) console.log(`  ${last}${L.preview ? " (PREVIEW)" : ""}: ORB30 n ${L.orb30.n} win ${L.orb30.win}% avgR ${L.orb30.avgR} ${JSON.stringify(L.orb30.how)} · VWAPR n ${L.vwapr.n} win ${L.vwapr.win}% avgR ${L.vwapr.avgR} ${JSON.stringify(L.vwapr.how)} · cost ${(100 * COST_SIDE).toFixed(2)}%/side`);
  if (S) for (const v of ["orb30", "vwapr"]) console.log(`  ${v}: ${stats[v].sessions} sessions · ${stats[v].n} signals · win ${stats[v].win}% · mean daily R ${stats[v].meanDailyR} · t ${stats[v].t}`);
  console.log("written: intraday-family.json");
})();
