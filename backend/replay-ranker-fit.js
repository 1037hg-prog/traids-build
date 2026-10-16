#!/usr/bin/env node
/**
 * REPLAY RANKER — FIT (2026-09-24, operator Josh approved items 2+3). Weightless research; trades nothing, registers nothing.
 *
 * DATA. backend/board-replay.js replays the board's own equity scan (src/App.jsx functions, extracted) over 2024-01 .. 2026-09 and
 * settles every synthetic ticket under the board's next-open rule. Population here = the cap-kept signal tickets (what the board
 * would have shown), settled. Gated on the known-answer check (data/board-replay/fidelity.json): the fit refuses to run if the
 * best variant reproduced < 60% of the real clean-era signal tickets.
 *
 * TARGET. y = rMult - mean(rMult of that session's tickets). Most of a ticket's raw R is the day's market move, the same for every
 * ticket that shares a direction; no ticket-level input can know it. Demeaning removes the session level and leaves the part a
 * RANKER can hope to see. R is GROSS (no spread/commission/slippage in the replay).
 *
 * INPUTS. Only what the board knows at the scan: the observer keys it stamps from bars, filtered through lib/feature-manifest.js
 * admitBoardObs + assertBoardObsAdmissible (the post-entry news family can never enter), plus the ticket's own scan fields
 * (dir, strategy, conf, score, nBull/nBear/total, stop distance as % of entry) and direction-signed copies of the directional
 * observers. The vector builder is lib/replay-ranker.js vectorOf — shared with the scorer so training and serving cannot drift.
 *
 * VALIDATION. Walk-forward by session: test blocks are calendar months; each is scored by models fit only on sessions ending
 * EMBARGO sessions before the block (labels resolve by the next open, and the board's signals persist for days — 5 sessions of
 * purge covers both). Ridge (lib/gbm.js ridgeFit) and a small GBM (gbmFit, depth 2). Statistic = R171's: per session, sort by
 * score, top half minus bottom half mean rMult (>= 4 tickets, odd middle dropped); plain t over sessions; out-of-sample years
 * reported separately. Controls: within-session score shuffle (must read |t| < 2) and a peek ranker on the realised R (must clear).
 * Bar: lib/null-bar.js best-of-2 (two learners were tried).
 *
 * PREVIEW (item 4, weightless). Models fit on replay sessions ending EMBARGO sessions before 2026-07-20 score the REAL clean-era
 * signal tickets from their actual obs at entry; same top-minus-bottom statistic per session.
 *
 *   node backend/replay-ranker-fit.js [--pit]   (--pit: only rows whose name was inside the point-in-time top-1,500 liquidity set)
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const LRN = require("./lib/gbm.js"), FM = require("./lib/feature-manifest.js"), NB = require("./lib/null-bar.js"), RR = require("./lib/replay-ranker.js");
const D = (f) => path.join(__dirname, "data", f);
const VERSION = "replay-ranker-v1", EMBARGO = 5, MIN_TRAIN = 120, MIN_PER_SESSION = 4, GBM_CAP = 40000;
const PIT = process.argv.includes("--pit"), PREVIEW_FROM = "2026-07-20";

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const tOf = (a) => { if (a.length < 3) return null; const m = mean(a), v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); return v > 0 ? m / Math.sqrt(v / a.length) : null; };
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── fidelity gate ──
const fid = JSON.parse(fs.readFileSync(D("board-replay/fidelity.json"), "utf8"));
const fidBest = fid.variants[fid.bestVariant].signals.matchRatePct;
if (!(fidBest >= 60)) { console.error(`replay-ranker-fit: fidelity ${fidBest}% < 60% — the replay is not the board; refusing to train.`); process.exit(2); }
const meta = JSON.parse(fs.readFileSync(D("board-replay/replay-meta.json"), "utf8"));

// ── features ──
const OBS_CANDIDATES = ["regimeAlign", "momPctile", "revRet5", "squeeze", "rvol", "prevMove", "gapPct", "stochCrossAge", "macdCrossAge", "roc10", "stochK", "pctFrom20"];
const adm = FM.admitBoardObs(OBS_CANDIDATES); FM.assertBoardObsAdmissible(adm.keep);
const SIGNED = ["momPctile", "revRet5", "prevMove", "gapPct", "roc10", "stochK", "pctFrom20"].filter((k) => adm.keep.includes(k));
const FEATURES = ["dir", ...RR.STRATS.map((s) => "st:" + s), "m:conf", "m:score", "m:nBull", "m:nBear", "m:total", "m:stopPct", ...adm.keep.map((k) => "o:" + k), ...SIGNED.map((k) => "dx:" + k)];
const metaOf = (t) => ({ dir: t.dir, strategy: t.st, conf: t.conf, score: t.score, nBull: t.nBull, nBear: t.nBear, total: t.total, stopPct: t.stopPct });

// ── data ──
const rows = [];
for (const f of fs.readdirSync(D("board-replay")).filter((f) => /^replay-\d{4}\.jsonl$/.test(f)).sort())
  for (const line of fs.readFileSync(D("board-replay/" + f), "utf8").split("\n")) { if (!line) continue; const t = JSON.parse(line); if (t.capKept && Number.isFinite(t.r) && (!PIT || t.pitLiquid)) rows.push(t); }
const bySess = new Map(); for (const t of rows) (bySess.get(t.d) || bySess.set(t.d, []).get(t.d)).push(t);
for (const [d, a] of bySess) if (a.length < 2) bySess.delete(d);
const sessions = [...bySess.keys()].sort(), sIdx = new Map(sessions.map((d, i) => [d, i]));
const R = [], X = [], Y = [], SI = [];
for (const d of sessions) { const a = bySess.get(d), m = mean(a.map((t) => t.r)); for (const t of a) { R.push(t); X.push(RR.vectorOf(t.obs, metaOf(t), FEATURES)); Y.push(t.r - m); SI.push(sIdx.get(d)); } }
// winsorize the demeaned target at its 0.5% / 99.5% quantiles for FITTING only (declared): lib/gbm.js stops boosting the first time the
// best root split isolates < 15 rows, which a handful of |R| > 5 gap tickets otherwise trigger within a few rounds. Scoring is untouched.
const YW = (() => { const q = Y.slice().sort((a, b) => a - b), lo = q[Math.floor(0.005 * q.length)], hi = q[Math.floor(0.995 * q.length)]; return Y.map((y) => Math.max(lo, Math.min(hi, y))); })();
console.log(`REPLAY RANKER — ${sessions.length} sessions · ${R.length} tickets${PIT ? " (pitLiquid only)" : ""} · ${FEATURES.length} features (${adm.removed.length} obs keys removed by the board guard)`);

// ── walk-forward ──
const months = [...new Set(sessions.map((d) => d.slice(0, 7)))];
const oos = { ridge: new Float64Array(R.length).fill(NaN), gbm: new Float64Array(R.length).fill(NaN) };
const rng = mulberry(20260924);
const idxBySess = sessions.map(() => []); SI.forEach((s, i) => idxBySess[s].push(i));
const folds = [];
for (const mo of months) {
  const test = sessions.filter((d) => d.slice(0, 7) === mo), first = sIdx.get(test[0]), trainEnd = first - EMBARGO;
  if (trainEnd < MIN_TRAIN) continue;
  const tr = []; for (let s = 0; s < trainEnd; s++) tr.push(...idxBySess[s]);
  const t0 = Date.now();
  const rm = LRN.ridgeFit(X, YW, tr);
  const trG = tr.length > GBM_CAP ? tr.filter(() => rng() < GBM_CAP / tr.length) : tr;
  const gm = LRN.gbmFit(X, YW, trG);
  for (const d of test) for (const i of idxBySess[sIdx.get(d)]) { oos.ridge[i] = LRN.ridgePredict(rm, X[i]); oos.gbm[i] = LRN.gbmPredict(gm, X[i]); }
  folds.push({ month: mo, trainSessions: trainEnd, trainRows: tr.length, testSessions: test.length, sec: +((Date.now() - t0) / 1000).toFixed(1) });
  process.stdout.write(`  fold ${mo}: train ${trainEnd} sessions / ${tr.length} rows · ${((Date.now() - t0) / 1000).toFixed(1)}s\r`);
}
console.log("");

// ── R171 statistic ──
function gapSeries(scoreOf, pick = () => true) {
  const out = [];
  for (let s = 0; s < sessions.length; s++) {
    const a = idxBySess[s].filter((i) => pick(i) && Number.isFinite(scoreOf(i))).map((i) => ({ s: scoreOf(i), r: R[i].r }));
    if (a.length < MIN_PER_SESSION) continue;
    a.sort((x, y) => y.s - x.s); const h = Math.floor(a.length / 2);
    out.push({ session: sessions[s], n: a.length, gap: mean(a.slice(0, h).map((x) => x.r)) - mean(a.slice(a.length - h).map((x) => x.r)) });
  }
  return out;
}

/** Diagnostic (not the R171 statistic): rank WITHIN session x direction, so the day's market move cannot enter the gap through a
 *  long/short split of the halves. Session value = mean of the per-direction gaps that have >= MIN_PER_SESSION tickets. */
function gapWithinDir(items) {   // items: [{session, dir, s, r}]
  const by = {}; for (const x of items) ((by[x.session] ||= { "1": [], "-1": [] })[x.dir > 0 ? "1" : "-1"]).push(x);
  const out = [];
  for (const d of Object.keys(by).sort()) { const g = []; let n = 0;
    for (const a of Object.values(by[d])) { if (a.length < MIN_PER_SESSION) continue; a.sort((x, y) => y.s - x.s); const h = Math.floor(a.length / 2); g.push(mean(a.slice(0, h).map((x) => x.r)) - mean(a.slice(a.length - h).map((x) => x.r))); n += a.length; }
    if (g.length) out.push({ session: d, n, gap: mean(g) }); }
  return out;
}
const itemsOf = (sc) => R.map((t, i) => ({ session: t.d, dir: t.dir, s: sc[i], r: t.r })).filter((x) => Number.isFinite(x.s));
const summ = (ser) => { const g = ser.map((x) => x.gap), t = tOf(g); return { sessions: ser.length, tickets: ser.reduce((s, x) => s + x.n, 0), meanGapR: ser.length ? +mean(g).toFixed(4) : null, t: t == null ? null : +t.toFixed(3), honestBar: ser.length >= 3 ? +NB.nullBar({ variants: 2, n: ser.length, trials: 4000, rng: mulberry(ser.length) }).p95.toFixed(3) : null }; };
const byYear = (ser) => Object.fromEntries([...new Set(ser.map((x) => x.session.slice(0, 4)))].map((y) => [y, summ(ser.filter((x) => x.session.startsWith(y)))]));
const shuffled = (arr) => { const r2 = mulberry(171), bySessionScores = new Map(); const out = new Float64Array(arr.length).fill(NaN);
  for (let s = 0; s < sessions.length; s++) { const ii = idxBySess[s].filter((i) => Number.isFinite(arr[i])), v = ii.map((i) => arr[i]); for (let k = v.length - 1; k > 0; k--) { const j = Math.floor(r2() * (k + 1)); [v[k], v[j]] = [v[j], v[k]]; } ii.forEach((i, k) => { out[i] = v[k]; }); }
  return out; };
const results = {};
for (const m of ["ridge", "gbm"]) {
  const ser = gapSeries((i) => oos[m][i]), sh = shuffled(oos[m]);
  results[m] = { overall: summ(ser), byYear: byYear(ser), shuffle: summ(gapSeries((i) => sh[i])),
    byStrategy: Object.fromEntries(RR.STRATS.map((st) => [st, summ(gapSeries((i) => oos[m][i], (i) => R[i].st === st))])),
    pitLiquidOnly: summ(gapSeries((i) => oos[m][i], (i) => R[i].pitLiquid === true)),
    withinDirection: summ(gapWithinDir(itemsOf(oos[m]))), withinDirectionShuffle: summ(gapWithinDir(itemsOf(sh))),
    ratchetR: summ((() => { const out = []; for (let s = 0; s < sessions.length; s++) { const a = idxBySess[s].filter((i) => Number.isFinite(oos[m][i]) && Number.isFinite(R[i].rRatchet)).map((i) => ({ s: oos[m][i], r: R[i].rRatchet })); if (a.length < MIN_PER_SESSION) continue; a.sort((x, y) => y.s - x.s); const h = Math.floor(a.length / 2); out.push({ session: sessions[s], n: a.length, gap: mean(a.slice(0, h).map((x) => x.r)) - mean(a.slice(a.length - h).map((x) => x.r)) }); } return out; })()) };
}
const oosSessions = gapSeries((i) => oos.ridge[i]).length;
const peek = summ(gapSeries((i) => (Number.isFinite(oos.ridge[i]) ? R[i].r : NaN)));
const primary = (results.gbm.overall.t ?? -9) > (results.ridge.overall.t ?? -9) ? "gbm" : "ridge";
const bar = results[primary].overall.honestBar;
for (const m of ["ridge", "gbm"]) console.log(`  ${m}: within-dir ${results[m].withinDirection.meanGapR}R t ${results[m].withinDirection.t} (shuffle t ${results[m].withinDirectionShuffle.t}) · pit ${results[m].pitLiquidOnly.meanGapR}R t ${results[m].pitLiquidOnly.t} · ratchet ${results[m].ratchetR.meanGapR}R t ${results[m].ratchetR.t}`);
for (const m of ["ridge", "gbm"]) console.log(`  ${m}: OOS ${results[m].overall.sessions} sessions · top-bottom ${results[m].overall.meanGapR}R · t ${results[m].overall.t} (bar ${results[m].overall.honestBar}) · shuffle t ${results[m].shuffle.t} · by year ${Object.entries(results[m].byYear).map(([y, v]) => `${y} ${v.meanGapR}R t${v.t}`).join(", ")}`);
console.log(`  peek control t ${peek.t}`);

// ── final models (all sessions) ──
const all = R.map((_, i) => i);
const finalRidge = LRN.ridgeFit(X, YW, all), allG = all.length > GBM_CAP ? all.filter(() => rng() < GBM_CAP / all.length) : all, finalGbm = LRN.gbmFit(X, YW, allG);

// ── preview on the REAL clean-era signal tickets (weightless) ──
const rc = require("./lib/reconcile.js"), S = require("./lib/session.js");
const L = rc.cleanEraLedger();
const real = L.signals.filter((t) => t.cls === "Equity" && RR.STRATS.includes(t.strategy) && Number.isFinite(t.rMult) && t.obs);
const pvEnd = sessions.findIndex((d) => d >= PREVIEW_FROM) - EMBARGO;
const pvIdx = []; for (let s = 0; s < pvEnd; s++) pvIdx.push(...idxBySess[s]);
const pvRidge = LRN.ridgeFit(X, YW, pvIdx), pvIdxG = pvIdx.length > GBM_CAP ? pvIdx.filter(() => rng() < GBM_CAP / pvIdx.length) : pvIdx, pvGbm = LRN.gbmFit(X, YW, pvIdxG);
const realMeta = (t) => { const stop0 = Number.isFinite(t.obs.actStopOrig) ? Math.abs(t.entry - t.obs.actStopOrig) : t.stopDist; return { dir: t.dir, strategy: t.strategy, conf: t.conf, score: t.score, nBull: t.nBull, nBear: t.nBear, total: t.total, stopPct: 100 * stop0 / t.entry }; };
function previewFor(mdl, kind) {
  const bs = {}, items = [];
  for (const t of real) { const x = RR.vectorOf(t.obs, realMeta(t), FEATURES), s = kind === "ridge" ? LRN.ridgePredict(mdl, x) : LRN.gbmPredict(mdl, x); if (!Number.isFinite(s)) continue; (bs[S.openSession(t)] ||= []).push({ s, r: t.rMult }); items.push({ session: S.openSession(t), dir: t.dir, s, r: t.rMult }); }
  const ser = [];
  for (const d of Object.keys(bs).sort()) { const a = bs[d]; if (a.length < MIN_PER_SESSION) continue; a.sort((x, y) => y.s - x.s); const h = Math.floor(a.length / 2); ser.push({ session: d, n: a.length, gap: mean(a.slice(0, h).map((x) => x.r)) - mean(a.slice(a.length - h).map((x) => x.r)) }); }
  const sm = summ(ser); sm.withinDirection = summ(gapWithinDir(items)); sm.honestBar = ser.length >= 3 ? +NB.nullBar({ variants: 2, n: ser.length, trials: 4000, rng: mulberry(7) }).p95.toFixed(3) : null; return sm;
}
const coverage = Object.fromEntries(adm.keep.map((k) => [k, +(100 * real.filter((t) => Number.isFinite(t.obs[k])).length / real.length).toFixed(0)]));
const preview = { note: "WEIGHTLESS. Models fit on replay sessions ending " + EMBARGO + " sessions before " + PREVIEW_FROM + " score the real clean-era Equity signal tickets (scanner strategies) from their actual obs at entry. Missing obs → the learner's missing path (ridge: mean-imputed; gbm: node value).",
  tickets: real.length, trainedThrough: sessions[pvEnd - 1], ridge: previewFor(pvRidge, "ridge"), gbm: previewFor(pvGbm, "gbm"), obsCoveragePct: coverage };
console.log(`  PREVIEW real tickets: ridge ${preview.ridge.meanGapR}R t ${preview.ridge.t} over ${preview.ridge.sessions} sessions · gbm ${preview.gbm.meanGapR}R t ${preview.gbm.t}`);

const out = { spec: VERSION, version: `${VERSION}-${sessions[sessions.length - 1]}${PIT ? "-pit" : ""}`, builtAt: new Date().toISOString(), guardVersion: adm.guardVersion, featureGuard: { candidates: OBS_CANDIDATES, removed: adm.removed },
  weightless: true, features: FEATURES, primary, primaryChosenBy: "higher overall walk-forward t of the two learners — a best-of-2 selection, hence the best-of-2 bar", trainedThrough: sessions[sessions.length - 1],
  target: "rMult - mean(rMult of the session's cap-kept replay tickets); GROSS R (no costs modelled); winsorized at its 0.5/99.5% quantiles for fitting only", gbmTrees: finalGbm.trees.length,
  dataset: { replaySpec: meta.spec, scanSourceHash: meta.scanSourceHash, feed: meta.feed, mode: meta.mode, from: sessions[0], to: sessions[sessions.length - 1], sessions: sessions.length, tickets: R.length, pitOnly: PIT, fidelityBest: `${fid.bestVariant} ${fidBest}%` },
  validation: { scheme: `walk-forward, monthly test blocks, expanding train, embargo ${EMBARGO} sessions, min train ${MIN_TRAIN} sessions; gbm train rows subsampled to <= ${GBM_CAP}`, statistic: "R171: per session top half minus bottom half mean rMult by score (>= 4 tickets); plain t over sessions", folds: folds.length, oosSessions, honestBarBestOf2: bar },
  oos: results, controls: { peek, shufflePass: ["ridge", "gbm"].every((m) => results[m].shuffle.t == null || Math.abs(results[m].shuffle.t) < 2), peekPass: peek.t != null && peek.t >= (bar || 2) },
  preview, models: { ridge: finalRidge, gbm: finalGbm } };
writeJsonAtomic(D(PIT ? "replay-ranker-pit.json" : "replay-ranker.json"), out, { pretty: 0 });
console.log(`wrote data/${PIT ? "replay-ranker-pit.json" : "replay-ranker.json"} (primary ${primary})`);
