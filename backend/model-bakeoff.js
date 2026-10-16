#!/usr/bin/env node
/**
 * MODEL BAKE-OFF — fit early, trust late. (2026-08-21, operator: "we need to start applying the ML sooner")
 *
 * Every night: take every settled linear ticket of the clean era (signals, controls, shadows —
 * all arms carry the same observer vector), fit two learners WALK-FORWARD by session with a
 * one-session purge, score each held-out session with models that never saw it, and report
 * forward skill: correlation of prediction with realized R, Spearman, top-minus-bottom decile
 * spread, and a day-clustered t on the per-session correlation. The null bar comes from
 * lib/null-bar.js over the number of models compared, so the better of two cannot pose as skill.
 *
 * The fitted models are written to data/model-bakeoff.json and served by /api/bakeoff-score; the
 * board stamps obs.bakeoffRidge / obs.bakeoffGbm on every ticket at track time, version-tagged,
 * BEFORE the outcome. The weighted board discovers them at weight zero and grades them like any
 * other dial. A model never alters a trade by being fit; it earns by the board's bar.
 *
 * POWER GATE: below 5,000 rows or 40 sessions the verdict prints UNDERPOWERED and says so on the
 * stamped scores' version string. That is the honest state until late September; the fits still
 * run, the stamps still land, the forward record still accrues.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const NB = require("./lib/null-bar.js");
const L = require("./lib/gbm.js");
const D = (f) => path.join(__dirname, "data", f);
const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const POWER = { minRows: 5000, minSessions: 40 }, PURGE = 1, MIN_TRAIN_SESSIONS = 8;
const EXCLUDE = /^(modelScore|modelRank|wComposite|bakeoff)/;
const mean = L.mean;

const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
const rows = log.filter((t) => Number.isFinite(t.rMult) && t.openedAt && et(t.openedAt) >= "2026-07-20" && t.obs && t.cls !== "Options" && !/r2[145]/.test(t.id || "") && t.sleeve !== "R24-v1");
const cov = {}; for (const t of rows) for (const [k, v] of Object.entries(t.obs)) if (Number.isFinite(v) && !EXCLUDE.test(k)) cov[k] = (cov[k] || 0) + 1;
// 2026-09-24 (weekly audit 2026-09-23, ml lens): candidates pass lib/feature-manifest.js admitBoardObs() — the news-stamp family is stamped
// AFTER entry (look-ahead) and is refused here, then asserted before any fit. Feature-set amendment to the bake-off series, dated; see change-registry.
const FM = require("./lib/feature-manifest.js");
const ADMIT = FM.admitBoardObs(Object.entries(cov).filter(([, n]) => n >= rows.length * 0.3).map(([k]) => k).sort());
const FEATS = ADMIT.keep; FM.assertBoardObsAdmissible(FEATS);
const CLS = ["Equity", "Crypto", "Futures", "FX"];
const vec = (t) => [...FEATS.map((k) => Number.isFinite(t.obs[k]) ? t.obs[k] : NaN), t.dir > 0 ? 1 : -1, t.ctrl ? 1 : 0, ...CLS.map((c) => t.cls === c ? 1 : 0)];
const NAMES = [...FEATS, "dir", "isCtrl", ...CLS.map((c) => "cls:" + c)];
const X = rows.map(vec), y = rows.map((t) => t.rMult), day = rows.map((t) => et(t.openedAt));
// 2026-09-01: PRUNED per-ticket set alongside the full set (lib/ml-features.js, outcome-blind).
// Four models are now compared, so the null bar below is best-of-4, not best-of-2.
const MLF = require("./lib/ml-features.js");
const PRUNE = MLF.perTicket(rows, FEATS, (t) => et(t.openedAt));
const FEATS_T = PRUNE.keep; FM.assertBoardObsAdmissible(FEATS_T);
const vecT = (t) => [...FEATS_T.map((k) => Number.isFinite(t.obs[k]) ? t.obs[k] : NaN), t.dir > 0 ? 1 : -1, t.ctrl ? 1 : 0, ...CLS.map((c) => t.cls === c ? 1 : 0)];
const XT = rows.map(vecT);
const sessions = [...new Set(day)].sort();
const sIdx = Object.fromEntries(sessions.map((s, i) => [s, i]));

// ── walk-forward, purged ──
const pred = { ridge: new Array(rows.length).fill(null), gbm: new Array(rows.length).fill(null), ridgeTicket: new Array(rows.length).fill(null), gbmTicket: new Array(rows.length).fill(null) };
let folds = 0;
for (let k = MIN_TRAIN_SESSIONS; k < sessions.length; k++) {
  const train = rows.map((_, i) => i).filter((i) => sIdx[day[i]] <= k - 1 - PURGE);
  const test = rows.map((_, i) => i).filter((i) => sIdx[day[i]] === k);
  if (train.length < 100 || !test.length) continue;
  const rm = L.ridgeFit(X, y, train), gm = L.gbmFit(X, y, train, { rounds: 60, lr: 0.1, depth: 2 });
  const rmT = L.ridgeFit(XT, y, train), gmT = L.gbmFit(XT, y, train, { rounds: 60, lr: 0.1, depth: 2 });
  for (const i of test) {
    pred.ridge[i] = L.ridgePredict(rm, X[i]); pred.gbm[i] = L.gbmPredict(gm, X[i]);
    pred.ridgeTicket[i] = L.ridgePredict(rmT, XT[i]); pred.gbmTicket[i] = L.gbmPredict(gmT, XT[i]);
  }
  folds++;
}
const corr = (a, b) => { const n = a.length; if (n < 3) return null; const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return sa && sb ? s / Math.sqrt(sa * sb) : null; };
const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => r[i] = k); return r; };
const metrics = (p) => {
  const idx = rows.map((_, i) => i).filter((i) => p[i] != null); if (idx.length < 30) return { n: idx.length, note: "too few forward predictions" };
  const pv = idx.map((i) => p[i]), yv = idx.map((i) => y[i]);
  const r = corr(pv, yv), rho = corr(rank(pv), rank(yv));
  const ord = idx.map((i) => i).sort((a, b) => p[a] - p[b]); const dec = Math.max(1, Math.floor(ord.length / 10));
  const top = mean(ord.slice(-dec).map((i) => y[i])), bot = mean(ord.slice(0, dec).map((i) => y[i]));
  const by = {}; for (const i of idx) (by[day[i]] ||= []).push(i);
  const dayCorr = Object.values(by).map((ids) => ids.length >= 5 ? corr(ids.map((i) => p[i]), ids.map((i) => y[i])) : null).filter((v) => v != null);
  const g = mean(dayCorr), sd = dayCorr.length > 1 ? Math.sqrt(dayCorr.reduce((s, x) => s + (x - g) ** 2, 0) / (dayCorr.length - 1)) : null;
  return { n: idx.length, forwardSessions: Object.keys(by).length, r: +r.toFixed(4), spearman: +rho.toFixed(4), decileSpreadR: +(top - bot).toFixed(4), dayCorrMean: +g.toFixed(4), dayCorrT: sd > 0 ? +(g / (sd / Math.sqrt(dayCorr.length))).toFixed(2) : null, daysScored: dayCorr.length };
};
const MODELS = ["ridge", "gbm", "ridgeTicket", "gbmTicket"];
const fwd = Object.fromEntries(MODELS.map((m) => [m, metrics(pred[m])]));
const powered = rows.length >= POWER.minRows && sessions.length >= POWER.minSessions;
const best = MODELS.filter((m) => fwd[m].dayCorrT != null).sort((a, b) => fwd[b].dayCorrT - fwd[a].dayCorrT)[0];
const nullRead = best ? NB.verdict(fwd[best].dayCorrT, { variants: MODELS.length, n: fwd[best].daysScored, trials: 2000 }) : null;
const verdict = !powered ? `UNDERPOWERED — ${rows.length}/${POWER.minRows} rows, ${sessions.length}/${POWER.minSessions} sessions; fits run and stamp, nothing is trusted` : nullRead && nullRead.clears ? `FORWARD SKILL (${best}) — day-corr t ${fwd[best].dayCorrT} clears the best-of-${MODELS.length} bar ${nullRead.honestBar}` : `NO FORWARD SKILL — best ${best} day-corr t ${fwd[best]?.dayCorrT ?? "n/a"} vs bar ${nullRead?.honestBar ?? "n/a"}`;

// ── final models on everything (for stamping tomorrow's tickets) ──
const all = rows.map((_, i) => i);
const version = `bakeoff-${sessions[sessions.length - 1]}-${rows.length}${powered ? "" : "-UNDERPOWERED"}`;
writeJsonAtomic(D("model-bakeoff.json"), {
  version, trainedAt: new Date().toISOString(), rows: rows.length, sessions: sessions.length, folds, purge: PURGE, features: NAMES, featureCount: NAMES.length, power: POWER, powered,
  featuresTicket: FEATS_T, featuresHeldOut: PRUNE.heldOut, featuresRefusedPostEntry: ADMIT.removed, featureGuard: ADMIT.guardVersion, pruneRule: PRUNE.rule, modelsCompared: MODELS.length,
  forward: fwd, nullRead, verdict,
  ridge: L.ridgeFit(X, y, all), gbm: L.gbmFit(X, y, all, { rounds: 60, lr: 0.1, depth: 2 }),
  // 2026-09-04 (ML lens): the pruned per-ticket models were fitted and scored nightly since 09-01 but never written, so the dial earning a
  // forward record on the board was the UNPRUNED one — 10 of the full GBM's 26 splits are on market-level fields (sbCorr alone 9), constant
  // within a session: 1 distinct obs.bakeoffGbm across 133 tickets on 08-24. Both now stamp; the old series is untouched and comparable.
  ridgeTicket: L.ridgeFit(XT, y, all), gbmTicket: L.gbmFit(XT, y, all, { rounds: 60, lr: 0.1, depth: 2 }), featuresTicketNames: [...FEATS_T, "dir", "isCtrl", ...CLS.map((c) => "cls:" + c)],
});
console.log(`MODEL BAKE-OFF — ${rows.length} rows / ${sessions.length} sessions / ${NAMES.length} features · ${folds} walk-forward folds (purge ${PURGE}) · ${verdict}`);
for (const m of MODELS) { const f = fwd[m]; console.log(`  ${m.padEnd(6)} forward n ${f.n} · r ${f.r ?? "-"} · spearman ${f.spearman ?? "-"} · decile spread ${f.decileSpreadR ?? "-"}R · day-corr mean ${f.dayCorrMean ?? "-"} t ${f.dayCorrT ?? "-"} over ${f.daysScored ?? 0} days`); }
console.log(`  models written: ${version} → stamped on tomorrow's tickets as obs.bakeoffRidge / obs.bakeoffGbm and, pruned per-ticket, obs.bakeoffRidgeT / obs.bakeoffGbmT (weight zero on the board until earned)`);
