// READ-ONLY: walk every committed version of the registered reader's output (backend/data/r56-cost-model-ml.json) and of
// r56-predictions.jsonl, and print, per nightly snapshot: OOS n, rankCorr, stamp-sessions by the adjudicator's resolver
// (distinct UTC dates of prediction rows carrying actualSpreadBps). Purpose: confirm the first night the registered sample
// condition (>= 300 OOS stamps AND >= 15 stamp-sessions) held, and whether the statistic cleared 0.40 on every night since.
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', '..')), OUTF = process.argv[3] || path.join(__dirname, 'r56-nightly.json');   // run: node docs/reads/2026-10-11/R56/r56-nightly.cjs
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const commits = git(['log', '--format=%h|%cI', '--reverse', '--', 'backend/data/r56-cost-model-ml.json']).trim().split('\n').map((l) => { const [h, d] = l.split('|'); return { h, d }; });
const rows = [];
for (const c of commits) {
  let m = null, sess = null, withActual = null, sessList = null;
  try { m = JSON.parse(git(['show', `${c.h}:backend/data/r56-cost-model-ml.json`])); } catch (e) { m = null; }
  try {
    const txt = git(['show', `${c.h}:backend/data/r56-predictions.jsonl`]);
    const pr = txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((r) => Number.isFinite(r.actualSpreadBps));
    sessList = [...pr.reduce((s, r) => s.add(String(r.at).slice(0, 10)), new Set())].sort();
    sess = sessList.length; withActual = pr.length;
  } catch (e) { sess = null; }
  const o = (m && m.outOfSample) || {};
  rows.push({ commit: c.h, committedAt: c.d, asOf: m && m.asOf, oosN: o.n ?? null, rankCorr: o.rankCorr ?? null, r2: o.r2 ?? null, medAbsErrBps: o.medAbsErrBps ?? null, stampSessionsResolver: sess, predictionsWithActual: withActual, frozenAt: m && m.frozen && m.frozen.fittedAt, intercept: m && m.frozen && m.frozen.intercept, barMinSessions: m && m.bar && m.bar.minSessions, barMinOos: m && m.bar && m.bar.minOosStamps, lastSess: sessList && sessList[sessList.length - 1], firstSess: sessList && sessList[0] });
}
for (const r of rows) console.log(`${r.commit} ${String(r.committedAt).slice(0, 16)} asOf ${String(r.asOf).slice(0, 16)}  oosN ${String(r.oosN).padStart(5)}  rankCorr ${r.rankCorr}  sessions(resolver) ${r.stampSessionsResolver}  first ${r.firstSess} last ${r.lastSess}  frozen ${String(r.frozenAt).slice(0, 16)} b0 ${r.intercept} bar ${r.barMinOos}/${r.barMinSessions}`);
const met = rows.filter((r) => (r.oosN || 0) >= 300 && (r.stampSessionsResolver || 0) >= 15);
const first = met[0] || null;
const since = met.filter((r) => Number.isFinite(r.rankCorr));
const summary = {
  snapshots: rows.length,
  firstMetByResolver: first,
  priorSnapshot: first ? rows[rows.indexOf(first) - 1] : null,
  nightsSinceFirstMet: since.length,
  rankCorrMinSince: since.length ? Math.min(...since.map((r) => r.rankCorr)) : null,
  rankCorrMaxSince: since.length ? Math.max(...since.map((r) => r.rankCorr)) : null,
  everyNightAtOrAbove040: since.every((r) => r.rankCorr >= 0.4),
  allSnapshotsWithOos300: (() => { const a = rows.filter((r) => (r.oosN || 0) >= 300 && Number.isFinite(r.rankCorr)); return { n: a.length, min: Math.min(...a.map((r) => r.rankCorr)), max: Math.max(...a.map((r) => r.rankCorr)) }; })(),
  allSnapshotsAnyN: (() => { const a = rows.filter((r) => Number.isFinite(r.rankCorr)); return { n: a.length, min: Math.min(...a.map((r) => r.rankCorr)), minAt: (a.slice().sort((x, y) => x.rankCorr - y.rankCorr)[0] || {}).commit, max: Math.max(...a.map((r) => r.rankCorr)) }; })(),
  frozenUnchanged: new Set(rows.filter((r) => r.frozenAt).map((r) => r.frozenAt + '|' + r.intercept)).size === 1,
  barUnchanged: new Set(rows.filter((r) => r.barMinOos != null).map((r) => r.barMinOos + '/' + r.barMinSessions)).size === 1,
};
console.log('\nSUMMARY ' + JSON.stringify(summary, null, 1));
fs.writeFileSync(OUTF, JSON.stringify({ asOf: new Date().toISOString(), rows, summary }, null, 1));
