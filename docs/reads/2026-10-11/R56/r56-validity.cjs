// READ-ONLY validity checks for the R56 read (weightless; none of these is the registered statistic).
//  A. Is the realised spread an independent observation, or could it be the model's own number written back?
//  B. Do predictions STAMPED AT THE TIME (r56-predictions.jsonl, written by r56-apply.js with that night's universe file)
//     rank realised spread as well as the reader's recomputed predictions (which use today's universe-expanded.json)?
//  C. What does the pairId de-duplication drop?
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', '..')), OUTF = process.argv[3] || path.join(__dirname, 'r56-validity.json');   // run: node docs/reads/2026-10-11/R56/r56-validity.cjs
const D = (f) => path.join(ROOT, 'backend', 'data', f);
const FEATS = ['logDollarVol', 'logPrice', 'logRank', 'atrPct', 'volRatio'];
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const uni = JSON.parse(fs.readFileSync(D('universe-expanded.json'), 'utf8'));
const rank = new Map(uni.names.map((n, i) => [n.sym, i + 1])), vol = new Map(uni.names.map((n) => [n.sym, n.medDollarVol]));
const log = JSON.parse(fs.readFileSync(D('trade_log.json'), 'utf8'));
const board = (() => { try { const b = JSON.parse(fs.readFileSync(D('board_positions.json'), 'utf8')); return Array.isArray(b) ? b : (b.positions || b.rows || []); } catch { return []; } })();
const model = JSON.parse(fs.readFileSync(D('r56-cost-model-ml.json'), 'utf8')).frozen;
const fitEnd = Date.parse(model.fittedAt);
function featuresOf(t) {
  const r = rank.get(t.sym), v = vol.get(t.sym);
  const atrPct = Number.isFinite(t.obs?.atr14) && t.entry > 0 ? 100 * t.obs.atr14 / t.entry : (t.stopDist > 0 && t.entry > 0 ? 100 * t.stopDist / t.entry : null);
  const vr = Number.isFinite(t.obs?.volRatio) ? t.obs.volRatio : (Number.isFinite(t.obs?.rvol) ? t.obs.rvol : null);
  const f = { logDollarVol: v > 0 ? Math.log10(v) : null, logPrice: t.entry > 0 ? Math.log10(t.entry) : null, logRank: r > 0 ? Math.log10(r) : null, atrPct, volRatio: vr };
  for (const k of FEATS) if (!Number.isFinite(f[k])) return null; return f;
}
const predict = (f) => model.intercept + FEATS.reduce((s, k) => s + model.weights[k] * ((f[k] - model.mu[k]) / model.sg[k]), 0);
const seen = new Map(), rows = [], dropped = [];
for (const t of [...log, ...board]) {
  if (!t || t.cls !== 'Equity' || !Number.isFinite(t.obs?.spreadBps) || !(t.obs.spreadBps > 0)) continue;
  const key = t.pairId ?? t.id; if (key != null) { if (seen.has(key)) { dropped.push({ t, kept: seen.get(key) }); continue; } seen.set(key, t); }
  const f = featuresOf(t); if (!f) continue;
  rows.push({ t, at: t.addedAt || t.openedAt, f, p: predict(f), y: Math.log10(t.obs.spreadBps), bps: t.obs.spreadBps });
}
const oos = rows.filter((r) => (r.at || 0) > fitEnd);
const avgRank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const o = new Array(arr.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const r = (i + j) / 2; for (let k = i; k <= j; k++) o[idx[k][1]] = r; i = j + 1; } return o; };
const pearson = (x, y) => { const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null; };
const spear = (x, y) => x.length < 3 ? null : +pearson(avgRank(x), avgRank(y)).toFixed(4);
const res = { asOf: new Date().toISOString(), label: 'WEIGHTLESS validity checks — not the registered statistic', oosN: oos.length };

// A. independence of the realised spread
const obsKeys = {}; for (const r of oos) for (const k of Object.keys(r.t.obs || {})) if (/spread|quote|bid|ask|nbbo|src|source/i.test(k)) obsKeys[k] = (obsKeys[k] || 0) + 1;
const srcVals = {}; for (const r of oos) { const o = r.t.obs || {}; const s = o.spreadSrc ?? o.spreadSource ?? o.quoteSrc ?? o.spreadFrom ?? o.src ?? '(no source field)'; srcVals[String(s)] = (srcVals[String(s)] || 0) + 1; }
const predBps = (r) => Math.pow(10, r.p);
const valCount = new Map(); for (const r of oos) valCount.set(r.bps, (valCount.get(r.bps) || 0) + 1);
res.A_realisedSpread = {
  obsFieldsNamedLikeAQuote: obsKeys, sourceFieldValues: srcVals,
  equalsRecomputedPredictionWithin0p05bps: oos.filter((r) => Math.abs(predBps(r) - r.bps) < 0.05).length,
  distinctRealisedValues: valCount.size,
  mostRepeatedRealisedValues: [...valCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, n]) => `${v}bps x${n}`),
};
// B. stamped-at-the-time predictions
const preds = new Map(fs.readFileSync(D('r56-predictions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { const o = JSON.parse(l); return [o.id, o]; } catch { return null; } }).filter(Boolean));
const both = oos.filter((r) => preds.has(r.t.id)).map((r) => ({ r, s: preds.get(r.t.id) }));
const stampedBeforeOpen = both.filter((x) => Date.parse(x.s.at) < x.r.at).length;
res.B_stampedPredictions = {
  predictionsOnFile: preds.size, oosRowsWithAStampedPrediction: both.length, oosRowsWithout: oos.length - both.length,
  spearman_stampedPrediction_vs_realised: spear(both.map((x) => x.s.predictedSpreadBps), both.map((x) => x.r.bps)),
  spearman_recomputedPrediction_vs_realised_sameRows: spear(both.map((x) => x.r.p), both.map((x) => x.r.y)),
  spearman_stamped_vs_recomputed: spear(both.map((x) => x.s.predictedSpreadBps), both.map((x) => predBps(x.r))),
  medianAbsDiffStampedVsRecomputedBps: (() => { const d = both.map((x) => Math.abs(x.s.predictedSpreadBps - predBps(x.r))).sort((a, b) => a - b); return d.length ? +d[Math.floor(d.length / 2)].toFixed(2) : null; })(),
  realisedSpreadAlreadyOnTheTicketWhenPredictionWasStamped: both.filter((x) => Number.isFinite(x.s.actualSpreadBps)).length,
  stampedActualEqualsLedgerActual: both.filter((x) => Number.isFinite(x.s.actualSpreadBps) && Math.abs(x.s.actualSpreadBps - x.r.bps) < 1e-9).length,
  note: 'the spread is an ENTRY stamp, so it usually exists when the nightly prediction is written; out-of-sample here means the coefficients were frozen before the ticket existed, not that the prediction preceded the quote',
};
// C. what the pairId de-duplication drops
const dOos = dropped.filter((d) => ((d.t.addedAt || d.t.openedAt) || 0) > fitEnd);
res.C_dedupe = {
  droppedAll: dropped.length, droppedAfterFreeze: dOos.length,
  droppedSameSymbolAsKept: dOos.filter((d) => d.t.sym === d.kept.sym).length,
  droppedDifferentSymbol: dOos.filter((d) => d.t.sym !== d.kept.sym).length,
  droppedSameSpreadAsKept: dOos.filter((d) => d.t.obs.spreadBps === d.kept.obs.spreadBps).length,
  keyIsPairId: dOos.filter((d) => d.t.pairId != null).length, keyIsId: dOos.filter((d) => d.t.pairId == null).length,
  keptIsCtrl: dOos.filter((d) => d.kept.ctrl).length, droppedIsCtrl: dOos.filter((d) => d.t.ctrl).length,
};
// with the dropped different rows put back (one stamp per ticket id instead of per pair): weightless
const seenId = new Set(), rowsById = [];
for (const t of [...log, ...board]) {
  if (!t || t.cls !== 'Equity' || !Number.isFinite(t.obs?.spreadBps) || !(t.obs.spreadBps > 0)) continue;
  if (t.id != null) { if (seenId.has(t.id)) continue; seenId.add(t.id); }
  const f = featuresOf(t); if (!f) continue; const at = t.addedAt || t.openedAt; if (!((at || 0) > fitEnd)) continue;
  rowsById.push({ p: predict(f), y: Math.log10(t.obs.spreadBps) });
}
res.C_dedupe.spearmanOneStampPerTicketId = { n: rowsById.length, rho: spear(rowsById.map((r) => r.p), rowsById.map((r) => r.y)) };
// D. the freeze-day 'stamp-session' the adjudicator's resolver counts: are any of its stamps out-of-sample?
{ const all = [...preds.values()], dayOf = (r) => String(r.at).slice(0, 10), fd = String(model.fittedAt).slice(0, 10);
  const day = all.filter((r) => dayOf(r) === fd && Number.isFinite(r.actualSpreadBps)), op = (r) => (typeof r.openedAt === 'number' ? r.openedAt : Date.parse(r.openedAt));
  res.D_freezeDaySession = { day: fd, predictionsWithARealisedSpread: day.length, stampedAt: [...new Set(day.map((r) => String(r.at).slice(0, 16)))], ticketsOpenedAfterTheFreeze: day.filter((r) => op(r) > fitEnd).length, ticketsOpenedAtOrBeforeTheFreeze: day.filter((r) => op(r) <= fitEnd).length,
    resolverSessions: new Set(all.filter((r) => Number.isFinite(r.actualSpreadBps)).map(dayOf)).size, note: 'a session whose stamps are all on tickets opened before the freeze holds no out-of-sample evidence' }; }
fs.writeFileSync(OUTF, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
