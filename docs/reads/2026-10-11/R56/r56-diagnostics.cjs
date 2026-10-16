// READ-ONLY diagnostics for the R56 read. Writes ONE file: the JSON named by argv[3] (in the scratchpad).
// It replicates the registered reader's row selection line for line (backend/r56-cost-model-ml.js, unchanged since the
// freeze commit 8bbb591b) ONLY to (1) confirm the reproduction, (2) count stamp-sessions on the reader's own rows,
// (3) measure the reader-source question (raw trade_log.json vs lib/reconcile.js cleanEraLedger), (4) weightless checks.
// The registered statistic is the reader's own number; everything else printed here is labelled weightless.
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', '..')), OUTF = process.argv[3] || path.join(__dirname, 'r56-diagnostics.json');   // run: node docs/reads/2026-10-11/R56/r56-diagnostics.cjs
const BK = path.join(ROOT, 'backend');
const D = (f) => path.join(BK, 'data', f);
const { cleanEraLedger } = require(path.join(BK, 'lib', 'reconcile.js'));

const FEATS = ['logDollarVol', 'logPrice', 'logRank', 'atrPct', 'volRatio'];
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function featuresOf(t, rank, vol) {
  const r = rank.get(t.sym), v = vol.get(t.sym);
  const atrPct = Number.isFinite(t.obs?.atr14) && t.entry > 0 ? 100 * t.obs.atr14 / t.entry
    : (t.stopDist > 0 && t.entry > 0 ? 100 * t.stopDist / t.entry : null);
  const vr = Number.isFinite(t.obs?.volRatio) ? t.obs.volRatio : (Number.isFinite(t.obs?.rvol) ? t.obs.rvol : null);
  const f = { logDollarVol: v > 0 ? Math.log10(v) : null, logPrice: t.entry > 0 ? Math.log10(t.entry) : null, logRank: r > 0 ? Math.log10(r) : null, atrPct, volRatio: vr };
  for (const k of FEATS) if (!Number.isFinite(f[k])) return null;
  return f;
}
const uni = JSON.parse(fs.readFileSync(D('universe-expanded.json'), 'utf8'));
const rank = new Map(uni.names.map((n, i) => [n.sym, i + 1]));
const vol = new Map(uni.names.map((n) => [n.sym, n.medDollarVol]));
const log = JSON.parse(fs.readFileSync(D('trade_log.json'), 'utf8'));
const board = (() => { try { const b = JSON.parse(fs.readFileSync(D('board_positions.json'), 'utf8')); return Array.isArray(b) ? b : (b.positions || b.rows || []); } catch { return []; } })();
const logSet = new Set(log);
const seen = new Set(), rows = [];
let eqStamped = 0, dupSkipped = 0, featSkipped = 0;
for (const t of [...log, ...board]) {
  if (!t || t.cls !== 'Equity' || !Number.isFinite(t.obs?.spreadBps) || !(t.obs.spreadBps > 0)) continue;
  eqStamped++;
  const key = t.pairId ?? t.id; if (key != null) { if (seen.has(key)) { dupSkipped++; continue; } seen.add(key); }
  const f = featuresOf(t, rank, vol); if (!f) { featSkipped++; continue; }
  rows.push({ t, src: logSet.has(t) ? 'trade_log' : 'board', sym: t.sym, at: t.addedAt || t.openedAt, y: Math.log10(t.obs.spreadBps), spreadBps: t.obs.spreadBps, f });
}
rows.sort((a, b) => (a.at || 0) - (b.at || 0));
const out0 = JSON.parse(fs.readFileSync(D('r56-cost-model-ml.json'), 'utf8'));
const model = out0.frozen;
const predict = (f) => model.intercept + FEATS.reduce((s, k) => s + model.weights[k] * ((f[k] - model.mu[k]) / model.sg[k]), 0);
const fitEnd = Date.parse(model.fittedAt);
const oos = rows.filter((r) => (r.at || 0) > fitEnd);
// the reader's own score(), verbatim
const score = (set) => {
  if (set.length < 3) return { n: set.length, r2: null, rankCorr: null, medAbsErrBps: null };
  const p = set.map((r) => predict(r.f)), a = set.map((r) => r.y);
  const ybar = mean(a), ssTot = a.reduce((s, x) => s + (x - ybar) ** 2, 0), ssRes = a.reduce((s, x, i) => s + (x - p[i]) ** 2, 0);
  const rk = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const o = new Array(arr.length); idx.forEach(([, i], j) => o[i] = j); return o; };
  const rp = rk(p), ra = rk(a), n = set.length;
  const d2 = rp.reduce((s, x, i) => s + (x - ra[i]) ** 2, 0);
  return { n, r2: ssTot > 0 ? +(1 - ssRes / ssTot).toFixed(4) : null, rankCorr: +(1 - 6 * d2 / (n * (n * n - 1))).toFixed(4),
    medAbsErrBps: +[...set.map((r, i) => Math.abs(Math.pow(10, p[i]) - r.spreadBps))].sort((x, y) => x - y)[Math.floor(set.length / 2)].toFixed(1) };
};
// tie-corrected Spearman = Pearson on average ranks (weightless sensitivity)
const avgRank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const o = new Array(arr.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const r = (i + j) / 2; for (let k = i; k <= j; k++) o[idx[k][1]] = r; i = j + 1; } return o; };
const pearson = (x, y) => { const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null; };
const spearTie = (set) => set.length < 3 ? null : +pearson(avgRank(set.map((r) => predict(r.f))), avgRank(set.map((r) => r.y))).toFixed(4);

const res = { asOf: new Date().toISOString(), note: 'read-only diagnostics; the registered statistic is the reader\'s own outOfSample.rankCorr' };
res.readerOutput = { asOf: out0.asOf, outOfSample: out0.outOfSample, inSample: out0.inSample, verdict: out0.verdict, frozenAt: model.fittedAt, frozenN: model.n };
res.reproduction = { usableStamps: rows.length, equityStamped: eqStamped, dupSkipped, featSkippedFailClosed: featSkipped, oos: score(oos), matchesReader: JSON.stringify(score(oos)) === JSON.stringify(out0.outOfSample) };

// sessions on the reader's own rows (America/New_York date of the stamp) and on the adjudicator's source
const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
const bySess = new Map();
for (const r of oos) { const d = etDay(r.at); (bySess.get(d) || bySess.set(d, []).get(d)).push(r); }
const sessDays = [...bySess.keys()].sort();
res.sessionsReaderRows = { count: sessDays.length, first: sessDays[0], last: sessDays[sessDays.length - 1], perSessionN: Object.fromEntries(sessDays.map((d) => [d, bySess.get(d).length])) };
const preds = fs.readFileSync(D('r56-predictions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const adjSess = [...preds.filter((r) => Number.isFinite(r.actualSpreadBps)).reduce((s, r) => s.add(String(r.at).slice(0, 10)), new Set())].sort();
res.sessionsAdjudicator = { count: adjSess.length, first: adjSess[0], last: adjSess[adjSess.length - 1], predictionsOnFile: preds.length, withActual: preds.filter((r) => Number.isFinite(r.actualSpreadBps)).length };

// reader-source question: raw trade_log.json + board vs the canonical ledger
const L = cleanEraLedger();
const canonIds = new Set([...L.signals, ...L.controls].map((t) => t.id));
const canonObj = new Set([...L.signals, ...L.controls]);
const cls = { board_open: 0, log_canonical_settled: 0, log_retired_valid: 0, log_retired_flag_other: 0, log_unsettled_or_nopnl: 0, log_pre_epoch: 0, log_other: 0 };
const validTags = new Set(L.retireTagsHonoured || []);
const tag = (r) => {
  const t = r.t;
  if (r.src === 'board') return 'board_open';
  if (canonIds.has(t.id)) return 'log_canonical_settled';
  if (t.retired && validTags.has(t.retired)) return 'log_retired_valid';
  if (t.retired) return 'log_retired_flag_other';
  if (!(Number.isFinite(t.rMult) && Number.isFinite(t.pnl))) return 'log_unsettled_or_nopnl';
  return 'log_other';
};
for (const r of oos) { r.tag = tag(r); cls[r.tag]++; }
res.sourceQuestion = {
  canonical: { source: L.source, epoch: L.epoch, settled: L.settled, retiredExcluded: L.retiredExcluded, retireTagsHonoured: L.retireTagsHonoured, retireTagsIGNORED: L.retireTagsIGNORED },
  oosRowsByOrigin: cls,
  nonCanonicalExamples: oos.filter((r) => !['board_open', 'log_canonical_settled'].includes(r.tag)).slice(0, 12).map((r) => ({ id: r.t.id, sym: r.sym, tag: r.tag, day: etDay(r.at), retired: r.t.retired || null, shadow: r.t.shadow || r.t.isShadow || null, ctrl: r.t.ctrl || null, sleeve: r.t.sleeve || r.t.book || null, rMult: r.t.rMult ?? null, pnl: r.t.pnl ?? null })),
};
const canonOnly = oos.filter((r) => r.tag === 'board_open' || r.tag === 'log_canonical_settled');
const noRetired = oos.filter((r) => r.tag !== 'log_retired_valid');
res.sourceQuestion.statOnCanonicalPlusOpen = score(canonOnly);
res.sourceQuestion.statExcludingValidlyRetired = score(noRetired);
res.sourceQuestion.statSettledCanonicalOnly = score(oos.filter((r) => r.tag === 'log_canonical_settled'));

// weightless checks
const syms = new Map();
for (const r of oos) (syms.get(r.sym) || syms.set(r.sym, []).get(r.sym)).push(r);
const symRows = [...syms.entries()].map(([sym, rs]) => ({ sym, n: rs.length, p: mean(rs.map((r) => predict(r.f))), y: mean(rs.map((r) => r.y)) }));
const perSess = sessDays.map((d) => ({ d, n: bySess.get(d).length, rho: spearTie(bySess.get(d)) })).filter((x) => x.rho != null);
const rhos = perSess.map((x) => x.rho).sort((a, b) => a - b);
const half = Math.floor(oos.length / 2);
// names never seen in the fit sample
const inSample = rows.filter((r) => (r.at || 0) <= fitEnd);
const fitSyms = new Set(inSample.map((r) => r.sym));
const unseen = oos.filter((r) => !fitSyms.has(r.sym));
// within-symbol demeaned: does the model order the SAME name's wide vs tight days?
const within = []; for (const [, rs] of syms) { if (rs.length < 2) continue; const mp = mean(rs.map((r) => predict(r.f))), my = mean(rs.map((r) => r.y)); for (const r of rs) within.push([predict(r.f) - mp, r.y - my]); }
res.weightless = {
  label: 'WEIGHTLESS — not the registered statistic; sensitivity only',
  tieCorrectedSpearmanPooled: spearTie(oos),
  distinctSymbols: syms.size,
  symbolLevelSpearman: symRows.length >= 3 ? +pearson(avgRank(symRows.map((s) => s.p)), avgRank(symRows.map((s) => s.y))).toFixed(4) : null,
  perSessionSpearman: { sessions: perSess.length, min: rhos[0], median: rhos[Math.floor(rhos.length / 2)], max: rhos[rhos.length - 1], below040: perSess.filter((x) => x.rho < 0.4).map((x) => `${x.d} n${x.n} rho ${x.rho}`) },
  firstHalf: score(oos.slice(0, half)), secondHalf: score(oos.slice(half)),
  unseenSymbolsOnly: { symbols: new Set(unseen.map((r) => r.sym)).size, ...score(unseen) },
  withinSymbolSpearman: within.length >= 3 ? { n: within.length, rho: +pearson(avgRank(within.map((w) => w[0])), avgRank(within.map((w) => w[1]))).toFixed(4) } : null,
  realisedSpreadBps: (() => { const s = oos.map((r) => r.spreadBps).sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { min: s[0], p10: q(0.1), median: q(0.5), p90: q(0.9), max: s[s.length - 1], above100bps: s.filter((x) => x > 100).length }; })(),
  expensiveTail: (() => { // "is this ticket in the expensive tail" — top decile by realised vs top decile by predicted
    const n = oos.length, k = Math.floor(n / 10); const byP = [...oos].sort((a, b) => predict(b.f) - predict(a.f)).slice(0, k); const cut = [...oos].map((r) => r.spreadBps).sort((a, b) => b - a)[k - 1];
    const hit = byP.filter((r) => r.spreadBps >= cut).length; return { topDecileN: k, realisedCutBps: cut, predictedTopDecileThatAreRealisedTopDecile: hit, pct: +(100 * hit / k).toFixed(1), baseRatePct: 10 }; })(),
};
fs.writeFileSync(OUTF, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
