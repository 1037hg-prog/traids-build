/**
 * RISK MODEL FIT — nightly fitter for volatility-scaled sizing of board signal tickets. 2026-09-24.
 * Operator (Josh) 2026-09-24: "go on 1" — point ML at what is predictable (risk), starting with
 * volatility-scaled sizing. Serving side: backend/lib/risk-size.js riskSizeMult(p).
 *
 * WHAT IT PREDICTS. The DISPERSION of a ticket's outcome in R — not its sign. Risk is direction-free,
 * so controls (random-direction tickets on the same names) are legitimate training rows alongside
 * signals; an isControl indicator absorbs any level difference and is 0 when a signal is scored.
 *
 * MODEL CHOICE (declared before any fold was read; GBM is reported as a comparison only):
 *   target  y = ln(|rMult| + 0.05), centred        — a log-scale estimator of spread. |rMult|^2 would
 *            let the handful of -4R gap-throughs dominate a 5,000-row fit; the log is robust to them.
 *   learner ridge (lib/gbm.js ridgeFit, lambda 50, standardised inputs + a missing indicator per input)
 *            — 21 inputs, closed form, no tuning loop, nothing to overfit that a λ does not already damp.
 *   scale   predSd = kappa * exp(yMean + ridge), kappa set so mean predSd^2 = mean rMult^2 in training
 *            (display only: mult = ref/predSd, and ref comes from the same model, so kappa cancels).
 *
 * INPUTS — all knowable at the entry timestamp; list and vintage in lib/risk-size.js FEATURE_DOC. obs keys
 * pass lib/feature-manifest.js admitBoardObs() and assertBoardObsAdmissible() before any fit.
 *
 * WALK-FORWARD, by OPEN session (lib/session.js openSession). For test session k the model is fitted on rows
 * opened in sessions < k-1 (one-session purge) AND closed before the first ticket of session k opened — so
 * the fold only sees outcomes that had actually landed. Skill = per-session Spearman of predicted sd vs
 * realised |rMult| on SIGNAL tickets, session-clustered t over sessions.
 *
 * WEIGHTLESS PREVIEW. For every signal ticket in a test session, the multiplier riskSizeMult() gives under
 * that fold's model and a ref taken from the prior 10 sessions' signals: applied (pnl x mult) vs flat (pnl)
 * dollars, per-session sd, worst-5-session sum, clamp counts. rMult is size-invariant; size moves dollars only.
 *
 * WRITES data/risk-model.json ONLY (atomic). Reads the ledger ONLY via lib/reconcile.js cleanEraLedger().
 * Usage: node backend/risk-model-fit.js [--no-gbm] [--quiet]
 */
const path = require("path");
const crypto = require("crypto");
const { cleanEraLedger, assertReconciled } = require("./lib/reconcile.js");
const { openSession } = require("./lib/session.js");
const { ridgeFit, gbmFit, gbmPredict } = require("./lib/gbm.js");
const FM = require("./lib/feature-manifest.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const RS = require("./lib/risk-size.js");

const OUT = path.join(__dirname, "data", "risk-model.json");
const EPS = 0.05, LAMBDA = 50, PURGE = 1, MIN_TRAIN_SESSIONS = 10, REF_SESSIONS = 10, MIN_TRAIN_ROWS = 300, MIN_SESSION_N = 8;
const ARGS = new Set(process.argv.slice(2));
const QUIET = ARGS.has("--quiet"), DO_GBM = !ARGS.has("--no-gbm");
const log = (...a) => { if (!QUIET) console.log(...a); };

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sdev = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null);
function ranks(a) { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2; i = j + 1; } return r; }
function pearson(a, b) { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da > 0 && db > 0 ? n / Math.sqrt(da * db) : NaN; }
const spearman = (a, b) => pearson(ranks(a), ranks(b));
const tOf = (xs) => { const k = xs.length, s = sdev(xs); return k >= 2 && s > 0 ? mean(xs) / (s / Math.sqrt(k)) : NaN; };

// ---------------------------------------------------------------- guard + ledger
const admit = FM.admitBoardObs(RS.OBS_KEYS);
if (admit.removed.length) throw new Error(`risk-model-fit: board guard removed ${admit.removed.join(", ")} — lib/risk-size.js OBS_KEYS must not name them`);
const guard = FM.assertBoardObsAdmissible(admit.keep);

const L = cleanEraLedger();
const settledRows = [...L.signals, ...L.controls];
assertReconciled("settled rows (signals+controls) read by risk-model-fit", settledRows.length, L.settled);
const rows = settledRows.filter((t) => RS.CLASSES.includes(t.cls) && Number.isFinite(t.rMult) && t.openedAt > 0 && t.closedAt > 0).map((t) => ({
  t, x: RS.vectorOf(t), y: Math.log(Math.abs(t.rMult) + EPS), absR: Math.abs(t.rMult), sess: openSession(t), isSig: !t.ctrl,
}));
const sessions = [...new Set(rows.map((r) => r.sess))].sort();
const sIdx = new Map(sessions.map((s, i) => [s, i]));
rows.forEach((r) => { r.k = sIdx.get(r.sess); });
const X = rows.map((r) => r.x), Y = rows.map((r) => r.y);
log(`risk-model-fit · ${rows.length} rows (${rows.filter((r) => r.isSig).length} signals, ${rows.filter((r) => !r.isSig).length} controls) · ${sessions.length} open sessions ${sessions[0]}..${sessions[sessions.length - 1]} · options excluded (${settledRows.filter((t) => t.cls === "Options").length})`);

// ---------------------------------------------------------------- learners
function fitRidge(idx, cols) {
  const Xs = cols ? X.map((x) => cols.map((c) => x[c])) : X;
  const yMean = mean(idx.map((i) => Y[i]));
  const yc = Y.map((y) => y - yMean);
  const ridge = ridgeFit(Xs, yc, idx, { lambda: LAMBDA });
  const lin = (x) => RS.ridgeLin(ridge, cols ? cols.map((c) => x[c]) : x);
  const kappa = Math.sqrt(mean(idx.map((i) => rows[i].t.rMult ** 2)) / mean(idx.map((i) => Math.exp(2 * (yMean + lin(X[i]))))));
  return { ridge, yMean, kappa, predSd: (x) => kappa * Math.exp(yMean + lin(x)) };
}
function fitGbm(idx) {
  const yMean = mean(idx.map((i) => Y[i]));
  const m = gbmFit(X, Y.map((y) => y - yMean), idx, { rounds: 60, lr: 0.1, depth: 2 });
  return { predSd: (x) => Math.exp(yMean + gbmPredict(m, x)) };
}
const CLS_COLS = [0, 1, 2]; // cls:Crypto, cls:FX, cls:Futures — the "is it just the asset class?" baseline

// ---------------------------------------------------------------- walk-forward
const folds = [];
const oos = { ridge: [], cls: [], gbm: [] }; // per-session rho
const pooled = []; // {pred, predCls, absR, r, pnl, mult, sess, cls, why}
for (let k = MIN_TRAIN_SESSIONS; k < sessions.length; k++) {
  const test = rows.map((r, i) => (r.k === k ? i : -1)).filter((i) => i >= 0);
  if (!test.length) continue;
  const firstOpen = Math.min(...test.map((i) => rows[i].t.openedAt));
  const train = rows.map((r, i) => (r.k < k - PURGE && r.t.closedAt < firstOpen ? i : -1)).filter((i) => i >= 0);
  if (train.length < MIN_TRAIN_ROWS) continue;
  const M = fitRidge(train), Mc = fitRidge(train, CLS_COLS), Mg = DO_GBM ? fitGbm(train) : null;
  // ref: prior REF_SESSIONS sessions' signal tickets, scored by THIS fold's model (features only — no outcomes read)
  const refPool = rows.filter((r) => r.isSig && r.k >= k - REF_SESSIONS && r.k < k && Number.isFinite(r.t.obs && r.t.obs.revRet5)).map((r) => M.predSd(r.x));
  const ref = median(refPool);
  const doc = { version: `fold-${sessions[k]}`, features: RS.FEATURE_NAMES, model: { ridge: M.ridge, yMean: M.yMean, kappa: M.kappa }, refPredSd: ref };
  const sig = test.filter((i) => rows[i].isSig);
  const p = sig.map((i) => M.predSd(X[i])), pc = sig.map((i) => Mc.predSd(X[i])), pg = Mg ? sig.map((i) => Mg.predSd(X[i])) : null;
  const a = sig.map((i) => rows[i].absR);
  if (sig.length >= MIN_SESSION_N) {
    oos.ridge.push(spearman(p, a)); oos.cls.push(spearman(pc, a)); if (pg) oos.gbm.push(spearman(pg, a));
  }
  sig.forEach((i, j) => {
    const t = rows[i].t, rs = RS.riskSizeMult(t, { doc });
    pooled.push({ pred: p[j], predCls: pc[j], predGbm: pg ? pg[j] : null, absR: rows[i].absR, r: t.rMult, pnl: t.pnl, mult: rs.mult, why: rs.why, sess: rows[i].sess, cls: t.cls });
  });
  folds.push({ session: sessions[k], train: train.length, testSignals: sig.length, ref: r4(ref), refN: refPool.length });
}
const skill = (xs) => { const v = xs.filter(Number.isFinite); return { sessions: v.length, meanRho: r4(mean(v)), t: r4(tOf(v)), positiveSessions: v.filter((x) => x > 0).length }; };
const quint = (key) => { const s = [...pooled].filter((q) => Number.isFinite(q[key])).sort((a, b) => a[key] - b[key]); const n = s.length, out = []; for (let d = 0; d < 5; d++) { const b = s.slice(Math.floor((d * n) / 5), Math.floor(((d + 1) * n) / 5)); out.push({ q: d + 1, n: b.length, meanPredSd: r4(mean(b.map((x) => x[key]))), meanAbsR: r4(mean(b.map((x) => x.absR))), rmsR: r4(Math.sqrt(mean(b.map((x) => x.r ** 2)))) }); } return out; };
const oosSkill = {
  unit: "per-session Spearman(predSd, realised |rMult|) on SIGNAL tickets, walk-forward by open session, t clustered by session",
  primary: { model: "ridge-full", ...skill(oos.ridge), pooledRho: r4(spearman(pooled.map((q) => q.pred), pooled.map((q) => q.absR))), quintiles: quint("pred") },
  baselineClassOnly: { model: "ridge cls one-hot only", ...skill(oos.cls), pooledRho: r4(spearman(pooled.map((q) => q.predCls), pooled.map((q) => q.absR))) },
  gbmComparison: DO_GBM ? { model: "gbm depth2 x60 (comparison, not selected)", ...skill(oos.gbm), pooledRho: r4(spearman(pooled.map((q) => q.predGbm), pooled.map((q) => q.absR))) } : null,
  withinEquityPooledRho: r4((() => { const e = pooled.filter((q) => q.cls === "Equity"); return spearman(e.map((q) => q.pred), e.map((q) => q.absR)); })()),
  oosSignals: pooled.length,
};

// ---------------------------------------------------------------- preview (weightless)
function book(key) {
  const bySess = {}; for (const q of pooled) bySess[q.sess] = (bySess[q.sess] || 0) + key(q);
  const v = Object.values(bySess), sorted = [...v].sort((a, b) => a - b);
  return { totalUsd: Math.round(v.reduce((s, x) => s + x, 0)), sessions: v.length, sessionSdUsd: Math.round(sdev(v)), worst5SessionsUsd: Math.round(sorted.slice(0, 5).reduce((s, x) => s + x, 0)), meanOverSd: r4(mean(v) / sdev(v)) };
}
const withPnl = pooled.filter((q) => Number.isFinite(q.pnl));
const mMean = mean(pooled.map((q) => q.mult));
const rBook = (key) => { const bySess = {}; for (const q of pooled) bySess[q.sess] = (bySess[q.sess] || 0) + key(q); const v = Object.values(bySess); return { sumR: r4(v.reduce((s, x) => s + x, 0)), sessionSdR: r4(sdev(v)), worst5R: r4([...v].sort((a, b) => a - b).slice(0, 5).reduce((s, x) => s + x, 0)) }; };
const whyCounts = {}; for (const q of pooled) whyCounts[q.why.startsWith("missing") || q.why.startsWith("no ") ? "failOpen:" + q.why : q.why] = (whyCounts[q.why.startsWith("missing") || q.why.startsWith("no ") ? "failOpen:" + q.why : q.why] || 0) + 1;
const preview = {
  note: "WEIGHTLESS. Each signal ticket in a walk-forward test session, sized by riskSizeMult() under the model fitted on prior sessions only. Flat = the pnl actually booked (which already carries every existing sizing rule). Applied = pnl x mult. Normalised = applied / mean(mult), i.e. the same average gross as flat.",
  tickets: pooled.length, ticketsWithPnl: withPnl.length,
  mult: { mean: r4(mMean), median: r4(median(pooled.map((q) => q.mult))), clampLow: pooled.filter((q) => q.why === "clamped low").length, clampHigh: pooled.filter((q) => q.why === "clamped high").length, failOpen: pooled.filter((q) => q.mult === 1 && !/^scored|clamped/.test(q.why)).length, whyCounts },
  flat: book((q) => q.pnl), applied: book((q) => q.pnl * q.mult), appliedNormalised: book((q) => (q.pnl * q.mult) / mMean),
  rView: { flat: rBook((q) => q.r), appliedNormalised: rBook((q) => (q.r * q.mult) / mMean),
    ticketSdR: { flat: r4(sdev(pooled.map((q) => q.r))), appliedNormalised: r4(sdev(pooled.map((q) => (q.r * q.mult) / mMean))) } },
};

// ---------------------------------------------------------------- descriptive diagnostics (in-sample, all rows)
function groupStats(keyFn) { const m = {}; for (const r of rows) { const k = keyFn(r); if (k == null) continue; (m[k] ||= []).push(r.t.rMult); } return Object.fromEntries(Object.entries(m).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, { n: v.length, meanAbsR: r4(mean(v.map(Math.abs))), rmsR: r4(Math.sqrt(mean(v.map((x) => x * x)))) }])); }
function quintBy(cls) { const s = rows.filter((r) => r.t.cls === cls && Number.isFinite(r.x[9])).sort((a, b) => a.x[9] - b.x[9]); const n = s.length, out = []; for (let d = 0; d < 5; d++) { const b = s.slice(Math.floor((d * n) / 5), Math.floor(((d + 1) * n) / 5)); out.push({ stopPct: `${Math.exp(b[0].x[9]).toFixed(2)}-${Math.exp(b[b.length - 1].x[9]).toFixed(2)}`, n: b.length, meanAbsR: r4(mean(b.map((r) => r.absR))) }); } return out; }
const diagnostics = {
  byClass: groupStats((r) => r.t.cls), byStrategy: groupStats((r) => r.t.strategy), bySignalVsControl: groupStats((r) => (r.isSig ? "signal" : "control")),
  byDow: groupStats((r) => RS.etClock(r.t.openedAt).dow), byHourET: groupStats((r) => { const h = RS.etClock(r.t.openedAt).hour; return h < 9.5 ? "<09:30" : h < 10.5 ? "09:30-10:30" : h < 16 ? "10:30-16:00" : ">=16:00"; }),
  stopPctQuintiles: { Equity: quintBy("Equity"), Crypto: quintBy("Crypto") },
};

// ---------------------------------------------------------------- final fit (everything settled) + reference
const allIdx = rows.map((_, i) => i);
const F = fitRidge(allIdx);
const lastSess = sessions.slice(-REF_SESSIONS);
const refRows = rows.filter((r) => r.isSig && lastSess.includes(r.sess) && Number.isFinite(r.t.obs && r.t.obs.revRet5));
const refPredSd = median(refRows.map((r) => F.predSd(r.x)));
const coef = Object.fromEntries(RS.FEATURE_NAMES.map((n, f) => [n, { w: r4(F.ridge.w[f]), wMissing: r4(F.ridge.w[F.ridge.p + f]), mu: r4(F.ridge.mu[f]), sd: r4(F.ridge.sd[f]), missShare: r4(F.ridge.miss[f]) }]));
const fittedAt = new Date().toISOString();
const hash = crypto.createHash("sha1").update(RS.FEATURE_NAMES.join("|") + `|lambda${LAMBDA}|eps${EPS}`).digest("hex").slice(0, 8);
const doc = {
  version: `risk-ridge-${fittedAt.slice(0, 10)}-${hash}`, fittedAt, owner: "backend/risk-model-fit.js", servedBy: "backend/lib/risk-size.js riskSizeMult()",
  status: "WEIGHTLESS — no caller applies this multiplier until the main session integrates and registers it",
  features: RS.FEATURE_NAMES, featureDoc: RS.FEATURE_DOC, obsKeys: guard.features, guardVersion: guard.guardVersion,
  target: `ln(|rMult| + ${EPS}), centred`, clamp: RS.CLAMP, staleAfterDays: RS.STALE_MS / 86400e3,
  model: { type: "ridge", lambda: LAMBDA, ridge: F.ridge, yMean: F.yMean, kappa: F.kappa }, coefficients: coef,
  trainRows: rows.length, trainSessions: sessions.length, trainSpan: [sessions[0], sessions[sessions.length - 1]],
  refPredSd, refSessions: lastSess, refN: refRows.length,
  refNote: "median predicted sd of settled equity+crypto+fx+futures SIGNAL tickets opened in the last 10 sessions (tickets still open are not in the ledger yet)",
  oosSkill, preview, folds, diagnostics,
};
writeJsonAtomic(OUT, doc);

// ---------------------------------------------------------------- report
log(`guard ${guard.guardVersion} · obs ${guard.features.join(",")} · model ${doc.version}`);
log(`final fit: ${rows.length} rows · yMean ${r4(F.yMean)} · kappa ${r4(F.kappa)} · refPredSd ${r4(refPredSd)} (n ${refRows.length})`);
log(`\nOOS SKILL (walk-forward, ${folds.length} folds, purge ${PURGE}, signals only)`);
for (const [k, v] of Object.entries({ ridge: oosSkill.primary, classOnly: oosSkill.baselineClassOnly, gbm: oosSkill.gbmComparison })) if (v) log(`  ${k.padEnd(10)} mean rho ${v.meanRho} · t ${v.t} · sessions ${v.sessions} (${v.positiveSessions} positive) · pooled rho ${v.pooledRho}`);
log(`  within-Equity pooled rho ${oosSkill.withinEquityPooledRho}`);
log(`  quintiles (pred -> realised):`); for (const q of oosSkill.primary.quintiles) log(`    Q${q.q} n ${q.n} predSd ${q.meanPredSd} · mean|R| ${q.meanAbsR} · rmsR ${q.rmsR}`);
log(`\nPREVIEW (weightless) · ${preview.tickets} signal tickets · mult mean ${preview.mult.mean} median ${preview.mult.median} · clamp low ${preview.mult.clampLow} high ${preview.mult.clampHigh} · fail-open ${preview.mult.failOpen}`);
for (const k of ["flat", "applied", "appliedNormalised"]) { const b = preview[k]; log(`  ${k.padEnd(18)} total $${b.totalUsd} · session sd $${b.sessionSdUsd} · worst-5 $${b.worst5SessionsUsd} · mean/sd ${b.meanOverSd} (${b.sessions} sessions)`); }
log(`  R view: flat ${JSON.stringify(preview.rView.flat)} · applied/meanMult ${JSON.stringify(preview.rView.appliedNormalised)} · ticket sd R ${JSON.stringify(preview.rView.ticketSdR)}`);
log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
