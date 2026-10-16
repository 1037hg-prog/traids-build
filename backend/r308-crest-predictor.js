#!/usr/bin/env node
/**
 * R308 — CREST PREDICTOR: a walk-forward model decides when an R307 crypto surge trade has peaked, and exits.
 * Registered 2026-10-01 in backend/data/test-registry.json — the registry wins over anything written in this file.
 *
 * QUESTION. R307's surge entries lose after the 0.50% round trip with every mechanical exit (sealed DID NOT PASS, t -6.1..-7.0;
 * exits bail at 5-7 h). Can a model trained only on EARLIER trades tell, hour by hour, that the crest has passed — and exit well
 * enough to beat the cost? Two cells (LOGIT, GBM), best-of-2, exit threshold fixed at 0.5.
 *
 * RULE (frozen; every parameter from the registration, none tuned here)
 *   TRADES    exactly R307's surge entries: backend/r307-ride-the-wave.js entriesOf() on series built by its mkSeries() from its
 *             candle cache (training/r307; BTC/ETH training/r306); same 32 coins; long at the surge hour's close; 48 h hard cap;
 *             0.50% round trip.
 *   LABEL     (training only) at hour h = 1..47 of a trade, y = 1 iff no later close inside the 48 h window exceeds the close at h.
 *   FEATURES  13, at hour h, all from bars <= h (N4). Standardised with training-set statistics only.
 *   MODELS    LOGIT = L2-regularised logistic regression, lambda 1.0; GBM = gradient-boosted depth-2 trees, 200 rounds,
 *             learning rate 0.05, min 50 rows per leaf. Plain Node.
 *   WALK-FWD  for each test year Y in 2021..2026: train on every trade whose 48 h window closed before Jan 1 of Y (expanding from
 *             2019); freeze the model for all of Y.
 *   POLICY    from h = 1, exit at the close of the first hour whose predicted P(crest passed) >= 0.5; otherwise at the 48 h cap.
 *   STATISTIC per UTC day with entries: mean net trade return under the model's exits (day clustering, as R307); one-sample t
 *             over days 2021-01..2026-09; best-of-2 cells; bar = registry bar.tRequired (1.981).
 *   DECISION  (AMENDED 2026-10-01, pre-evidence — registry amendments[0]) PASS iff better cell net t >= bar AND it beats the
 *             shuffled-label p95 AND it beats FADE on the paired day difference (mean > 0) AND it beats HOLD48 on the paired day
 *             difference (mean > 0) AND both halves positive AND the amended 20-seed leak gate was clean. CANNOT MEASURE iff the
 *             amended leak gate is not clean, or fewer than 300 out-of-sample days with trades.
 *
 *   node backend/r308-crest-predictor.js --selftest [--synthetic]  known answers (+ real-data probes unless --synthetic)
 *   node backend/r308-crest-predictor.js --leak                    selftest, then the AMENDED 20-seed leak gate (N16)
 *                                                                  -> training/r308/leak-test-amended.json (once; the first single-seed
 *                                                                  run's training/r308/leak-test.json is kept as history, never rewritten);
 *                                                                  a gate that is not clean writes the CANNOT MEASURE output and stops
 *   node backend/r308-crest-predictor.js --read                    the ONE registered read: selftest + a clean AMENDED leak file written by
 *                                                                  THIS script version (sha256) are required; refuses if sealed or if the
 *                                                                  output holds anything but the superseded first-run CANNOT MEASURE (N17)
 *
 * NOTES (implementation choices fixed before any synthetic-leak or real result was computed)
 *  N1  Trades are R307's verbatim: the same caches loaded the R307 way (one grid 2019-01-01T00..2026-09-30T23, Coinbase-omitted hours
 *      are no-trade hours: carried close, volume 0 — R307 N1), r307 entriesOf() for the surge rule and the 1-per-24 h spacing, entries
 *      whose 48 h cap lies beyond the pull dropped (R307 N8). Reproduction against the SEALED R307 output (entries, window trades,
 *      FADE n / trades / mean / t) is a selftest check, so a drift in the shared code cannot pass silently.
 *  N2  Decision hours h = 1..47 (k = t + h). The close at h is the carried close lc[k] (R307 N1/N7: a no-trade hour exits at its carried
 *      close, as R307's FADE does). The 48 h cap exits at lc[t+48]. Hold = h hours. Return = exit / entry - 1; net = gross - 0.0050.
 *  N3  Label y(h) = 1 iff max(lc[t+h+1 .. t+48]) <= lc[t+h] ("exceeds" is strict: a later EQUAL close does not un-pass the crest).
 *      Labels are computed for every trade but enter ONLY the training rows; at test time they are used only to report calibration.
 *  N4  Features at k = t + h, every input from bars <= k (proved by the truncate-the-future probe in the selftest):
 *       0 retSinceEntry     lc[k] / entry - 1
 *       1 drawdownFromHigh  lc[k] / HWM - 1, HWM = highest close over t..k (the entry close included; strict > updates)
 *       2 hoursSinceEntry   h
 *       3 hoursSinceHigh    k - (hour the HWM was set; the entry hour if never exceeded)
 *       4 volVsMedian7d     vol0[k] / median of vol0[k-168..k-1] (R307's trailing 7-day median, inputs <= k-1)
 *       5 vol3VsEntryVol    mean(vol0[k-2..k]) / vol0[t]
 *       6 sd6VsSd7d         sample SD of the 6 hourly returns ret[k-5..k] / R307's trailing 168 h return SD at k (ret[k-168..k-1])
 *       7 closeVsMean24     lc[k] / mean(lc[k-23..k]) - 1
 *       8 rsi14             hourly RSI(14), house lib/indicators.js rsi() (Wilder) on carried closes from the coin's first candle
 *       9 refRetSinceEntry  BTC lc[k] / BTC lc[t] - 1 (BTC's own trades use ETH)
 *      10 surgeSigma        ret[t] / R307's sdr[t] (the surge hour's return in sigma units; constant within a trade)
 *      11 utcHour           UTC hour of day of bar k (bar start)
 *      12 weekday           UTC weekday of bar k (0 = Sunday)
 *  N5  Standardisation per training set: mean and population SD over the finite training values; a non-finite value (a zero
 *      median, a missing reference) becomes the training mean (0 after standardising); counts reported. SD 0 -> 1.
 *  N6  LOGIT: minimise sum(log-loss) + (lambda/2)||w||^2, lambda = 1.0 (the C = 1/lambda convention), intercept unpenalised,
 *      Newton/IRLS with step halving, to a max step < 1e-10.
 *  N7  GBM: Friedman's binomial-deviance boosting (R gbm 'bernoulli'): F0 = log-odds of the training base rate; each round fits a
 *      depth-2 regression tree to the gradient y - p by exact greedy squared-error reduction over every distinct threshold (x <= thr
 *      goes left), every leaf >= 50 rows, a split taken only if its gain > 1e-12; leaf value = one Newton step sum(y-p) / sum(p(1-p));
 *      shrinkage 0.05; 200 rounds; no subsampling (deterministic). P = 1 / (1 + exp(-F)).
 *  N8  Walk-forward: the window of a trade closes at the close of bar t+48, i.e. t0 + (t+49) h; model Y trains on trades whose window
 *      close is STRICTLY before Y-01-01T00:00Z (asserted per year, every run); it is applied to trades whose entry day (UTC date of
 *      the surge bar, R307 N9) is in Y and inside 2021-01-01..2026-09-30.
 *  N9  Policy threshold inclusive (P >= 0.5). Better cell = higher net t (tie: LOGIT).
 *  N10 Shuffled-label control: 100 draws (registered >= 50), seed 308308 + d; Fisher-Yates within each trade's 47 labels (all trades),
 *      then the full walk-forward refit of BOTH models, same features, same policy, same statistic; p95 nearest-rank (R307's pctile);
 *      the observed cell mean must be STRICTLY above it.
 *  N11 vs FADE: per trade (model net - R307 FADE net) on the same trades (cost cancels), day means, t over days; the gate is mean > 0.
 *  N12 Halves: the out-of-sample days sorted; first floor(n/2) days vs the rest; both mean nets must be > 0.
 *  N13 (SUPERSEDED 2026-10-01 by the registry's pre-evidence amendment — see N16; kept verbatim as the record of the first run,
 *      whose output is backend/data/training/r308/leak-test.json, script sha256 450223cf…6c66, archived beside it as
 *      r308-crest-predictor.first-leak-run.js.txt)
 *      LEAK TEST — two disclosed readings of the registered control, fixed here before any synthetic or real number was computed:
 *      (a) synthetic paths: each coin's hourly SIMPLE returns over its candle hours are DEMEANED, then the hour-bars are randomly
 *          permuted as whole units (return, volume, bar shape; a no-trade hour moves as a no-trade hour) and the price path rebuilt
 *          from the first candle. Demeaning makes every path a martingale, so any exit that does not see the future has zero
 *          expected gross return. Without it the permuted paths keep each coin's ARITHMETIC drift (positive for any volatile coin,
 *          E[r] ~ log drift + sigma^2/2), which rewards a longer hold and could fail the gate with no leak present.
 *      (b) the two cell gates read the GROSS (cost-free) day t: the 0.50% cost puts every cell's NET t far below -2 on any
 *          zero-edge path, so a net |t| < 2 gate could never be met by a leak-free pipeline. The model-minus-FADE gap is cost-free
 *          by construction (same cost on both legs).
 *      Gate: |t| < 2 for LOGIT gross, GBM gross, LOGIT-FADE and GBM-FADE (a t that cannot be formed fails closed). One seeded draw
 *      (308001; coin i uses seed + 1009 i). Net t, and the literal NOT-demeaned permutation, are reported beside — never gated.
 *      Shuffled-label draws are not part of the leak gate and are not run on synthetic paths.
 *  N14 Maker scenario: the same exits at 0.30% round trip (reported, not gated). BTC+ETH only, per year, calibration (OOS rows,
 *      10 probability bins, Brier, AUC; exit precision = share of model exits where the crest had in fact passed), feature
 *      importance (LOGIT standardised coefficients by year; GBM summed split gain by year) — all reported, not gated.
 *  N15 Research only — no orders anywhere in this file. Writes only backend/data/r308-crest-predictor.json and
 *      backend/data/training/r308/leak-test-amended.json (leak-test.json, the first run, is read, never written).
 *  N16 AMENDED LEAK GATE (registry controls.leakTest, amended 2026-10-01 pre-evidence; implemented exactly, fixed here before the
 *      amended gate or any real-data model score was computed):
 *      paths   N13(a)'s generator unchanged: each coin's hourly simple returns demeaned, hour-bars permuted as whole units.
 *      seeds   20 fixed seeds 308001 + s, s = 0..19 (coin i uses seed + 1009 i, as N13). s = 0 is the first run's seed (its
 *              negative-side result is kept in the 20, not dropped); s = 1..19 have never been run. The builder's post-hoc diagnostic
 *              used 308001 + 7777 s (s = 1..12) — deliberately NOT reused, so the gate's outcome was not known in advance.
 *      stats   per seed, per cell (LOGIT, GBM): (1) the GROSS cell day t; (2) the per-day model-minus-HOLD48 gap t (per trade model
 *              net - HOLD48 net, day means, t over days; cost cancels). HOLD48 = the same trade held to the 48 h cap (exit at the
 *              carried close lc[t+48], the policy's own cap leg).
 *      gate    a LEAK is a POSITIVE edge. For each of the four statistics: median across the 20 seeds <= +1.0 AND at most 2 of 20
 *              seeds > +2.0. Clean iff all four pass.
 *      fail-closed  a t that cannot be formed counts as +Infinity (above +2, and it lifts the median) — EXCEPT the one case where
 *              it is not unknown: every per-day gap is exactly 0 (the model reproduced HOLD48 on every trade), which is recorded as
 *              t = 0 with identicalToHOLD48 = true.
 *      reported only  model-minus-FADE gap t per seed and its median; net cell t; HOLD48 and FADE gross t; the literal NOT-demeaned
 *              permutation on seed 308001 (as in the first run).
 *  N17 READ ONCE under the amendment: --read refuses if R308 is sealed, if training/r308/leak-test-amended.json is missing, not clean,
 *      or written by another script version, or if backend/data/r308-crest-predictor.json exists and is anything other than the
 *      first run's CANNOT MEASURE output (identified by its leakTest.ranAt / scriptSha256 matching leak-test.json and no readAt).
 *      The read overwrites that superseded output once; the written output carries readAt, so a second read refuses. --leak refuses
 *      if leak-test-amended.json already exists (one amended gate run). Real-data control vs HOLD48: N11's paired difference with
 *      HOLD48 in place of FADE; the PASS gate is mean > 0.
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { mean, sd, tOf } = require("./lib/clustered.js");
const { rsi } = require("./lib/indicators.js");
const W = require("./r307-ride-the-wave.js");   // { features, mkSeries, entriesOf, exitsAt, crestAt, dayStats, decide, analyze } — no main when required

const D = (f) => path.join(__dirname, "data", f);
const TRAIN307 = D("training/r307"), TRAIN306 = D("training/r306"), WORK = D("training/r308");
const OUT = D("r308-crest-predictor.json"), LEAK = path.join(WORK, "leak-test.json"), R307_OUT = D("r307-ride-the-wave.json");
const LEAK2 = path.join(WORK, "leak-test-amended.json");          // N16: the amended 20-seed gate (LEAK = the superseded first run, read-only)
const FIRST_LEAK_SHA = "450223cf871327b93ee2e762e0ebae98d62275328a6a95f245ef0e42d9836c66";
const ID = "R308";
const REGS = require("./data/test-registry.json").preregistered || [];
const REG = REGS.find((x) => x.id === ID), REG307 = REGS.find((x) => x.id === "R307");
if (!REG || !REG307) throw new Error("R308 / R307 not found in test-registry.json preregistered");
const BAR = REG.bar.tRequired;
const COINS = (() => {
  const m = /2026-10-01\s+—\s+([A-Z][A-Z ]+[A-Z])\s+—\s+priced/.exec(REG307.rule);
  if (!m) throw new Error("R307 universe not parseable from the registry rule text");
  const c = m[1].trim().split(/\s+/);
  if (c.length !== 32 || new Set(c).size !== 32) throw new Error(`universe must be 32 distinct coins, got ${c.length}`);
  return c;
})();
const REF_OF = (coin) => (coin === "BTC" ? "ETH" : "BTC");

const HOUR = 3600000, DAY = 86400000;
const PULL0 = Date.UTC(2019, 0, 1), PULL1 = Date.UTC(2026, 8, 30, 23), NGRID = (PULL1 - PULL0) / HOUR + 1;
const CAP_H = 48, H_MAX = 47, COST_RT = 0.005, MAKER_RT = 0.003, THRESH = 0.5;
const LAMBDA = 1.0, ROUNDS = 200, LR = 0.05, MIN_LEAF = 50;
const TEST_YEARS = [2021, 2022, 2023, 2024, 2025, 2026], WIN0 = "2021-01-01", WIN1 = "2026-09-30";
const MIN_DAYS = 300, SHUF_DRAWS = 100, SEED = 308308, LEAK_SEED = 308001, LEAK_T = 2;
const LEAK_SEEDS = Array.from({ length: 20 }, (_, s) => LEAK_SEED + s);   // N16: 308001..308020
const LEAK_MEDIAN_MAX = 1.0, LEAK_EXCEED_T = 2.0, LEAK_EXCEED_MAX = 2;      // N16: median <= +1.0 AND at most 2 of 20 seeds > +2.0
const MODELS = ["LOGIT", "GBM"];
const FEATS = ["retSinceEntry", "drawdownFromHigh", "hoursSinceEntry", "hoursSinceHigh", "volVsMedian7d", "vol3VsEntryVol", "sd6VsSd7d",
  "closeVsMean24", "rsi14", "refRetSinceEntry", "surgeSigma", "utcHour", "weekday"];
const P = FEATS.length;
const mode = ["--selftest", "--leak", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const f = (x, k = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(k));
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pctile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : null; };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const softplus = (x) => (x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x)));
const scriptSha = () => crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");

// ════════════════════════════════════════════════════════════════════════════════ SERIES (R307's, plus RSI)
function prep(S) {
  S.rsi = new Float64Array(S.n).fill(NaN);
  if (S.first >= 0) { const r = rsi(Array.from(S.lc.subarray(S.first))); for (let j = 0; j < r.length; j++) if (r[j] != null) S.rsi[S.first + j] = r[j]; }
  return S;
}
function readListing() { const p = path.join(TRAIN307, "_listing.json"); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {}; }
function loadCoin(coin) {
  const dir = coin === "BTC" || coin === "ETH" ? TRAIN306 : TRAIN307, bars = new Array(NGRID).fill(null);
  for (let y = 2019; y <= 2026; y++) {
    const file = path.join(dir, `${coin}-USD-${y}.json`);
    if (!fs.existsSync(file)) throw new Error(`missing cache ${file} — run r307 --fetch`);
    for (const [t, o, h, l, c, v] of JSON.parse(fs.readFileSync(file, "utf8")).rows) { const i = (t - PULL0) / HOUR; if (!Number.isInteger(i) || i < 0 || i >= NGRID) continue; bars[i] = { o, h, l, c, v }; }
  }
  return prep(W.mkSeries(bars, PULL0, coin));
}
function loadReal() {
  const listing = readListing(), series = {};
  for (const coin of COINS) { const L = listing[coin]; if (coin === "BTC" || coin === "ETH" || (L && L.status === "listed")) { const S = loadCoin(coin); if (S.first >= 0) series[coin] = S; } }
  return series;
}
function barsOf(S, upto) { const b = new Array(upto + 1).fill(null); for (let i = 0; i <= upto; i++) if (S.has[i]) b[i] = { o: S.o[i], h: S.h[i], l: S.l[i], c: S.c[i], v: S.v[i] }; return b; }
const truncate = (S, k) => prep(W.mkSeries(barsOf(S, k), S.t0, S.coin));      // every bar > k deleted

// ════════════════════════════════════════════════════════════════════════════════ FEATURES + LABEL
function featureRow(S, R, t, h, out = new Float64Array(P), o = 0) {
  const k = t + h, E = S.c[t], lc = S.lc;
  let H = E, kH = t; for (let j = t + 1; j <= k; j++) if (lc[j] > H) { H = lc[j]; kH = j; }
  out[o] = lc[k] / E - 1;
  out[o + 1] = lc[k] / H - 1;
  out[o + 2] = h;
  out[o + 3] = k - kH;
  out[o + 4] = S.med[k] > 0 ? S.vol0[k] / S.med[k] : NaN;
  out[o + 5] = S.vol0[t] > 0 ? (S.vol0[k - 2] + S.vol0[k - 1] + S.vol0[k]) / 3 / S.vol0[t] : NaN;
  let m = 0; for (let j = k - 5; j <= k; j++) m += S.ret[j]; m /= 6;
  let q = 0; for (let j = k - 5; j <= k; j++) q += (S.ret[j] - m) ** 2;
  out[o + 6] = S.sdr[k] > 0 ? Math.sqrt(q / 5) / S.sdr[k] : NaN;
  let a = 0; for (let j = k - 23; j <= k; j++) a += lc[j];
  out[o + 7] = lc[k] / (a / 24) - 1;
  out[o + 8] = S.rsi[k];
  out[o + 9] = R ? R.lc[k] / R.lc[t] - 1 : NaN;
  out[o + 10] = S.sdr[t] > 0 ? S.ret[t] / S.sdr[t] : NaN;
  const d = new Date(S.t0 + k * HOUR); out[o + 11] = d.getUTCHours(); out[o + 12] = d.getUTCDay();
  return out;
}
function labelOf(S, t, h) { const k = t + h, c = S.lc[k]; for (let j = k + 1; j <= t + CAP_H; j++) if (S.lc[j] > c) return 0; return 1; }

function buildTrades(series, featureFn = featureRow) {
  const trades = [], perCoin = {}; let dropped = 0;
  for (const coin of COINS) {
    const S = series[coin]; if (!S) continue;
    const R = series[REF_OF(coin)] || null; if (R && R.t0 !== S.t0) throw new Error("reference series off-grid");
    const E = W.entriesOf(S); let k = 0;
    for (const t of E) {
      if (t + CAP_H > S.n - 1) { dropped++; continue; }
      const X = new Float64Array(H_MAX * P), y = new Uint8Array(H_MAX), pth = new Float64Array(CAP_H + 1);
      for (let h = 1; h <= H_MAX; h++) { featureFn(S, R, t, h, X, (h - 1) * P); y[h - 1] = labelOf(S, t, h); }
      for (let j = 0; j <= CAP_H; j++) pth[j] = S.lc[t + j];
      const day = isoDay(S.t0 + t * HOUR);
      trades.push({ coin, t, day, year: +day.slice(0, 4), windowClose: S.t0 + (t + CAP_H + 1) * HOUR, entry: S.c[t], path: pth, X, y, fade: W.exitsAt(S, t).FADE, crest: W.crestAt(S, t) });
      k++;
    }
    perCoin[coin] = { entries: E.length, trades: k };
  }
  return { trades, dropped, perCoin };
}

// ════════════════════════════════════════════════════════════════════════════════ WALK-FORWARD DESIGN (per test year)
function prepareYears(trades) {
  return TEST_YEARS.map((Y) => {
    const Y0 = Date.UTC(Y, 0, 1);
    const train = trades.filter((x) => x.windowClose < Y0), test = trades.filter((x) => x.year === Y && x.day >= WIN0 && x.day <= WIN1);
    let maxClose = -Infinity; for (const x of train) if (x.windowClose > maxClose) maxClose = x.windowClose;
    if (train.length && !(maxClose < Y0)) throw new Error(`walk-forward leak: model ${Y} trains on a window closing ${new Date(maxClose).toISOString()}`);
    const nTr = train.length * H_MAX, nTe = test.length * H_MAX, mu = new Float64Array(P), sdv = new Float64Array(P);
    const nonFinite = { train: new Array(P).fill(0), test: new Array(P).fill(0) };
    for (let fi = 0; fi < P; fi++) {
      let s = 0, m = 0; for (const x of train) for (let h = 0; h < H_MAX; h++) { const v = x.X[h * P + fi]; if (Number.isFinite(v)) { s += v; m++; } }
      mu[fi] = m ? s / m : 0;
      let q = 0; for (const x of train) for (let h = 0; h < H_MAX; h++) { const v = x.X[h * P + fi]; if (Number.isFinite(v)) q += (v - mu[fi]) ** 2; }
      sdv[fi] = m && q > 0 ? Math.sqrt(q / m) : 1;
    }
    const fill = (set, n, which) => {
      const Xc = Array.from({ length: P }, () => new Float64Array(n));
      set.forEach((x, a) => { for (let h = 0; h < H_MAX; h++) for (let fi = 0; fi < P; fi++) { const v = x.X[h * P + fi]; if (Number.isFinite(v)) Xc[fi][a * H_MAX + h] = (v - mu[fi]) / sdv[fi]; else nonFinite[which][fi]++; } });
      return Xc;
    };
    const Xc = fill(train, nTr, "train"), Xt = fill(test, nTe, "test");
    const order = Xc.map((x) => { const o = new Uint32Array(x.length); for (let i = 0; i < o.length; i++) o[i] = i; return o.sort((a, b) => x[a] - x[b] || a - b); });
    const sorted = Xc.map((x, fi) => { const s = new Float64Array(x.length), o = order[fi]; for (let j = 0; j < s.length; j++) s[j] = x[o[j]]; return s; });
    return { Y, Y0, train, test, nTr, nTe, Xc, Xt, order, sorted, mu, sd: sdv, nonFinite, maxTrainWindowClose: train.length ? new Date(maxClose).toISOString() : null };
  });
}

// ════════════════════════════════════════════════════════════════════════════════ MODELS (plain Node)
function solve(A, b, q) {
  const M = []; for (let r = 0; r < q; r++) { const row = new Float64Array(q + 1); for (let c = 0; c < q; c++) row[c] = A[r * q + c]; row[q] = b[r]; M.push(row); }
  for (let c = 0; c < q; c++) {
    let piv = c; for (let r = c + 1; r < q; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c]; if (!(Math.abs(d) > 1e-300)) throw new Error("singular Hessian");
    for (let r = 0; r < q; r++) { if (r === c) continue; const fct = M[r][c] / d; if (!fct) continue; for (let k = c; k <= q; k++) M[r][k] -= fct * M[c][k]; }
  }
  const x = new Float64Array(q); for (let r = 0; r < q; r++) x[r] = M[r][q] / M[r][r]; return x;
}
function logitGrad(b, Xc, y, n, lambda) {
  const p = Xc.length, q = p + 1, g = new Float64Array(q);
  for (let i = 0; i < n; i++) { let e = b[0]; for (let j = 0; j < p; j++) e += b[j + 1] * Xc[j][i]; const r = sigmoid(e) - y[i]; g[0] += r; for (let j = 0; j < p; j++) g[j + 1] += r * Xc[j][i]; }
  for (let a = 1; a < q; a++) g[a] += lambda * b[a];
  return g;
}
/** L2 logistic regression: minimise sum(log-loss) + (lambda/2)||w||^2, intercept unpenalised (N6) */
function fitLogit(Xc, y, n, lambda = LAMBDA) {
  const p = Xc.length, q = p + 1, b = new Float64Array(q), z = new Float64Array(q); z[0] = 1;
  let pos = 0; for (let i = 0; i < n; i++) pos += y[i];
  const br = Math.min(1 - 1e-9, Math.max(1e-9, pos / n)); b[0] = Math.log(br / (1 - br));
  const objective = (bb) => { let L = 0; for (let i = 0; i < n; i++) { let e = bb[0]; for (let j = 0; j < p; j++) e += bb[j + 1] * Xc[j][i]; L += y[i] ? softplus(-e) : softplus(e); } let pen = 0; for (let j = 1; j < q; j++) pen += bb[j] * bb[j]; return L + 0.5 * lambda * pen; };
  let obj = objective(b), it = 0;
  for (; it < 100; it++) {
    const g = new Float64Array(q), H = new Float64Array(q * q);
    for (let i = 0; i < n; i++) {
      let e = b[0]; for (let j = 0; j < p; j++) { z[j + 1] = Xc[j][i]; e += b[j + 1] * z[j + 1]; }
      const pr = sigmoid(e), w = pr * (1 - pr), r = pr - y[i];
      for (let a = 0; a < q; a++) { g[a] += r * z[a]; const wa = w * z[a]; for (let c = a; c < q; c++) H[a * q + c] += wa * z[c]; }
    }
    for (let a = 1; a < q; a++) { g[a] += lambda * b[a]; H[a * q + a] += lambda; }
    for (let a = 0; a < q; a++) for (let c = 0; c < a; c++) H[a * q + c] = H[c * q + a];
    const d = solve(H, g, q);
    let st = 1, nb = null, no = Infinity;
    for (let k = 0; k < 40; k++) { nb = b.map((x, a) => x - st * d[a]); no = objective(nb); if (no <= obj + 1e-9 * Math.max(1, Math.abs(obj))) break; st /= 2; }
    let mx = 0; for (let a = 0; a < q; a++) mx = Math.max(mx, Math.abs(st * d[a]));
    b.set(nb); obj = no;
    if (mx < 1e-10) break;
  }
  const g = logitGrad(b, Xc, y, n, lambda);
  return { b: Array.from(b), iters: it + 1, gradNorm: Math.sqrt(g.reduce((s, x) => s + x * x, 0)), objective: obj };
}
function predictLogit(m, Xt, n) { const p = Xt.length, out = new Float64Array(n); for (let i = 0; i < n; i++) { let e = m.b[0]; for (let j = 0; j < p; j++) e += m.b[j + 1] * Xt[j][i]; out[i] = sigmoid(e); } return out; }

/** binomial-deviance gradient boosting with depth-2 trees (N7). order/sorted: per-feature ascending index / value arrays. */
function fitGBM(Xc, order, sorted, y, n, { rounds = ROUNDS, lr = LR, minLeaf = MIN_LEAF } = {}) {
  const p = Xc.length;
  let pos = 0; for (let i = 0; i < n; i++) pos += y[i];
  const br = Math.min(1 - 1e-9, Math.max(1e-9, pos / n)), F0 = Math.log(br / (1 - br));
  const F = new Float64Array(n).fill(F0), g = new Float64Array(n), hs = new Float64Array(n), side = new Uint8Array(n), leafOf = new Uint8Array(n);
  const trees = [], gain = new Float64Array(p), splits = new Int32Array(p); let minLeafRows = Infinity;
  for (let r = 0; r < rounds; r++) {
    let G = 0;
    for (let i = 0; i < n; i++) { const pr = sigmoid(F[i]); g[i] = y[i] - pr; hs[i] = pr * (1 - pr); G += g[i]; }
    let bf = -1, bt = 0, bg = 1e-12; const g0 = (G * G) / n;
    for (let fi = 0; fi < p; fi++) {
      const o = order[fi], xs = sorted[fi]; let SL = 0;
      for (let j = 0; j < n - 1; j++) {
        SL += g[o[j]]; const nl = j + 1;
        if (nl < minLeaf) continue; if (n - nl < minLeaf) break;
        if (!(xs[j + 1] > xs[j])) continue;
        const SR = G - SL, gn = (SL * SL) / nl + (SR * SR) / (n - nl) - g0;
        if (gn > bg) { bg = gn; bf = fi; bt = (xs[j] + xs[j + 1]) / 2; }
      }
    }
    const tree = { f: bf, thr: bt, gain: bf >= 0 ? bg : 0, kids: [null, null], v: [0, 0, 0, 0] };
    if (bf < 0) {
      let Hs = 0; for (let i = 0; i < n; i++) Hs += hs[i];
      const v = G / (Hs + 1e-12); tree.v = [v, v, v, v]; for (let i = 0; i < n; i++) F[i] += lr * v; trees.push(tree); minLeafRows = Math.min(minLeafRows, n); continue;
    }
    gain[bf] += bg; splits[bf]++;
    const xr = Xc[bf]; let G0 = 0, G1 = 0, N0 = 0, N1 = 0;
    for (let i = 0; i < n; i++) { if (xr[i] <= bt) { side[i] = 0; G0 += g[i]; N0++; } else { side[i] = 1; G1 += g[i]; N1++; } }
    let cf0 = -1, ct0 = 0, cg0 = 1e-12, cf1 = -1, ct1 = 0, cg1 = 1e-12; const b0 = (G0 * G0) / N0, b1 = (G1 * G1) / N1;
    for (let fi = 0; fi < p; fi++) {
      const o = order[fi], xs = sorted[fi]; let S0 = 0, S1 = 0, n0 = 0, n1 = 0, l0 = NaN, l1 = NaN;
      for (let j = 0; j < n; j++) {
        const i = o[j], v = xs[j];
        if (side[i]) {
          if (v > l1 && n1 >= minLeaf && N1 - n1 >= minLeaf) { const gn = (S1 * S1) / n1 + ((G1 - S1) * (G1 - S1)) / (N1 - n1) - b1; if (gn > cg1) { cg1 = gn; cf1 = fi; ct1 = (l1 + v) / 2; } }
          S1 += g[i]; n1++; l1 = v;
        } else {
          if (v > l0 && n0 >= minLeaf && N0 - n0 >= minLeaf) { const gn = (S0 * S0) / n0 + ((G0 - S0) * (G0 - S0)) / (N0 - n0) - b0; if (gn > cg0) { cg0 = gn; cf0 = fi; ct0 = (l0 + v) / 2; } }
          S0 += g[i]; n0++; l0 = v;
        }
      }
    }
    const kids = [cf0 >= 0 ? { f: cf0, thr: ct0, gain: cg0 } : null, cf1 >= 0 ? { f: cf1, thr: ct1, gain: cg1 } : null];
    for (const k of kids) if (k) { gain[k.f] += k.gain; splits[k.f]++; }
    const Gs = [0, 0, 0, 0], Hs = [0, 0, 0, 0], Ns = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) { const s = side[i], c = kids[s], l = s * 2 + (c && Xc[c.f][i] > c.thr ? 1 : 0); leafOf[i] = l; Gs[l] += g[i]; Hs[l] += hs[i]; Ns[l]++; }
    for (let l = 0; l < 4; l++) tree.v[l] = Ns[l] ? Gs[l] / (Hs[l] + 1e-12) : 0;
    for (let s = 0; s < 2; s++) if (!kids[s]) tree.v[s * 2 + 1] = tree.v[s * 2];
    for (let l = 0; l < 4; l++) if (Ns[l]) minLeafRows = Math.min(minLeafRows, Ns[l]);
    tree.kids = kids; tree.leafRows = Ns;
    for (let i = 0; i < n; i++) F[i] += lr * tree.v[leafOf[i]];
    trees.push(tree);
  }
  return { F0, lr, trees, gain: Array.from(gain), splits: Array.from(splits), minLeafRows, trainF: F };
}
function predictGBMraw(m, Xt, n) {
  const F = new Float64Array(n).fill(m.F0);
  for (const tr of m.trees) {
    if (tr.f < 0) { for (let i = 0; i < n; i++) F[i] += m.lr * tr.v[0]; continue; }
    const xr = Xt[tr.f], k0 = tr.kids[0], k1 = tr.kids[1];
    for (let i = 0; i < n; i++) { const s = xr[i] <= tr.thr ? 0 : 1, c = s ? k1 : k0; F[i] += m.lr * tr.v[s * 2 + (c && Xt[c.f][i] > c.thr ? 1 : 0)]; }
  }
  return F;
}
function predictGBM(m, Xt, n) { const F = predictGBMraw(m, Xt, n); for (let i = 0; i < n; i++) F[i] = sigmoid(F[i]); return F; }

// ════════════════════════════════════════════════════════════════════════════════ POLICY + PIPELINE
function policyLeg(x, probs, off) {
  let h = CAP_H, reason = "cap";
  for (let j = 1; j <= H_MAX; j++) if (probs[off + j - 1] >= THRESH) { h = j; reason = "model"; break; }
  const px = x.path[h], gross = px / x.entry - 1;
  return { k: x.t + h, hold: h, px, gross, net: gross - COST_RT, reason };
}
function walkForward(years, labels, { collect = false } = {}) {
  const legs = new Map(), info = [];
  for (const yp of years) {
    if (!yp.nTr) throw new Error(`no training trades before ${yp.Y}`);
    const y = new Uint8Array(yp.nTr); yp.train.forEach((x, a) => y.set(labels(x), a * H_MAX));
    const mL = fitLogit(yp.Xc, y, yp.nTr), mG = fitGBM(yp.Xc, yp.order, yp.sorted, y, yp.nTr);
    const pL = predictLogit(mL, yp.Xt, yp.nTe), pG = predictGBM(mG, yp.Xt, yp.nTe);
    yp.test.forEach((x, a) => legs.set(x, { LOGIT: policyLeg(x, pL, a * H_MAX), GBM: policyLeg(x, pG, a * H_MAX) }));
    if (collect) { let pos = 0; for (let i = 0; i < yp.nTr; i++) pos += y[i]; info.push({ Y: yp.Y, yp, mL, mG, pL, pG, trainBaseRate: pos / yp.nTr }); }
    delete mG.trainF;
  }
  return { legs, info };
}
const legFor = (L, cost) => (cost === COST_RT ? L : { ...L, net: L.gross - cost });
function cellStats(oos, legs, m, cost = COST_RT) { return W.dayStats(oos.map((x) => ({ day: x.day, cells: { [m]: legFor(legs.get(x)[m], cost) } })), m); }
function fadeStats(oos, cost = COST_RT) { return W.dayStats(oos.map((x) => ({ day: x.day, cells: { FADE: legFor(x.fade, cost) } })), "FADE"); }
/** HOLD48 (N16/N17): the same trade held to the 48 h cap — exactly the policy's own cap leg (exit at lc[t+48]) */
function hold48Leg(x) { const px = x.path[CAP_H], gross = px / x.entry - 1; return { k: x.t + CAP_H, hold: CAP_H, px, gross, net: gross - COST_RT, reason: "cap" }; }
function hold48Stats(oos, cost = COST_RT) { return W.dayStats(oos.map((x) => ({ day: x.day, cells: { HOLD48: legFor(hold48Leg(x), cost) } })), "HOLD48"); }
function pairedVs(oos, legs, m, refLeg) {
  const s = W.dayStats(oos.map((x) => { const d = legs.get(x)[m].net - refLeg(x).net; return { day: x.day, cells: { D: { net: d, gross: d, hold: 0, reason: "diff" } } }; }), "D");
  const allZero = s.n > 0 && s.dm.every((v) => v === 0);
  return { meanDiff: s.meanNet, tDiff: s.tNet, days: s.n, trades: s.trades, shareTradesBetter: s.winRate, allDaysZero: allZero };
}
const pairedVsFade = (oos, legs, m) => pairedVs(oos, legs, m, (x) => x.fade);
const pairedVsHold48 = (oos, legs, m) => pairedVs(oos, legs, m, hold48Leg);
function permuteLabels(trades, rng) { const out = new Map(); for (const x of trades) { const a = Uint8Array.from(x.y); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)), tmp = a[i]; a[i] = a[j]; a[j] = tmp; } out.set(x, a); } return out; }

/** the whole pipeline on a set of series: trades, walk-forward, both cells, FADE, gaps, optional shuffled-label draws */
function core(series, { featureFn = featureRow, draws = 0, seed = SEED, collect = true, log = () => {} } = {}) {
  const t0 = Date.now(), T = buildTrades(series, featureFn), trades = T.trades;
  const years = prepareYears(trades);
  const oos = trades.filter((x) => x.day >= WIN0 && x.day <= WIN1 && TEST_YEARS.includes(x.year));
  const nTest = years.reduce((s, yp) => s + yp.test.length, 0);
  if (nTest !== oos.length) throw new Error(`test sets (${nTest}) do not partition the out-of-sample trades (${oos.length})`);
  log(`  trades ${trades.length} (oos ${oos.length}, dropped ${T.dropped}); years prepared ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const wf = walkForward(years, (x) => x.y, { collect });
  log(`  walk-forward fitted ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const cells = {}, gap = {}, gap48 = {}; for (const m of MODELS) { cells[m] = cellStats(oos, wf.legs, m); gap[m] = pairedVsFade(oos, wf.legs, m); gap48[m] = pairedVsHold48(oos, wf.legs, m); }
  const fade = fadeStats(oos), hold48 = hold48Stats(oos), shuf = { LOGIT: [], GBM: [] };
  for (let d = 0; d < draws; d++) {
    const perm = permuteLabels(trades, mulberry32(seed + d)), w2 = walkForward(years, (x) => perm.get(x));
    for (const m of MODELS) shuf[m].push(cellStats(oos, w2.legs, m).meanNet);
    if ((d + 1) % 10 === 0) log(`  shuffled-label draw ${d + 1}/${draws} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  return { trades, dropped: T.dropped, perCoin: T.perCoin, years, oos, wf, cells, fade, hold48, gap, gap48, shuf, seconds: (Date.now() - t0) / 1000 };
}

// ════════════════════════════════════════════════════════════════════════════════ LEAK TEST (N13)
function permuteSeries(S, rng, demean) {
  const a = S.first, n = S.n, bars = new Array(n).fill(null);
  if (a < 0) return prep(W.mkSeries(bars, S.t0, S.coin));
  const src = []; let rs = 0, rn = 0;
  for (let i = a + 1; i < n; i++) { src.push(i); if (S.has[i]) { rs += S.c[i] / S.lc[i - 1] - 1; rn++; } }
  const rbar = demean && rn ? rs / rn : 0;
  for (let i = src.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)), tmp = src[i]; src[i] = src[j]; src[j] = tmp; }
  bars[a] = { o: S.o[a], h: S.h[a], l: S.l[a], c: S.c[a], v: S.v[a] };
  let px = S.c[a];
  for (let pos = a + 1; pos < n; pos++) {
    const s = src[pos - a - 1]; if (!S.has[s]) continue;
    const r = S.c[s] / S.lc[s - 1] - 1 - rbar; if (!(1 + r > 0)) throw new Error(`${S.coin}: demeaned hourly return <= -100%`);
    px *= 1 + r; const k = px / S.c[s];
    bars[pos] = { o: S.o[s] * k, h: S.h[s] * k, l: S.l[s] * k, c: px, v: S.v[s] };
  }
  return prep(W.mkSeries(bars, S.t0, S.coin));
}
const GATE_KEYS = ["LOGIT_tGross", "GBM_tGross", "LOGIT_minus_HOLD48_t", "GBM_minus_HOLD48_t"];
/** N16 fail-closed reading of one gate t: a t that cannot be formed is +Infinity, except a gap that is exactly 0 on every day (= 0) */
const gateValue = (t, allDaysZero = false) => (t != null && Number.isFinite(t) ? t : allDaysZero ? 0 : Infinity);
/** the full pipeline on ONE synthetic draw (N13(a) generator): per-seed statistics for the N16 gate, plus the reported-only ones */
function leakSeed(series, { demean = true, seed, featureFn = featureRow, log = () => {} } = {}) {
  const syn = {}; COINS.forEach((coin, i) => { if (series[coin]) syn[coin] = permuteSeries(series[coin], mulberry32(seed + 1009 * i), demean); });
  const C = core(syn, { featureFn, draws: 0, collect: false, log });
  const cells = {}, gapVsHOLD48 = {}, gapVsFADE = {}, gate = {};
  for (const m of MODELS) {
    const s = C.cells[m]; let cap = 0; for (const x of C.oos) if (C.wf.legs.get(x)[m].reason === "cap") cap++;
    cells[m] = { tGross: f(s.tGross, 3), meanGross: f(s.meanGross, 6), tNet: f(s.tNet, 3), meanNet: f(s.meanNet, 6), days: s.n, trades: s.trades, winRate: f(s.winRate, 4), avgHoldHours: f(s.avgHoldHours, 2), capShare: f(C.oos.length ? cap / C.oos.length : null, 4) };
    const g8 = C.gap48[m], gF = C.gap[m];
    gapVsHOLD48[m] = { meanDiff: f(g8.meanDiff, 6), tDiff: f(g8.tDiff, 3), days: g8.days, identicalToHOLD48: g8.allDaysZero };
    gapVsFADE[m] = { meanDiff: f(gF.meanDiff, 6), tDiff: f(gF.tDiff, 3), days: gF.days };
    gate[`${m}_tGross`] = gateValue(s.tGross);
    gate[`${m}_minus_HOLD48_t`] = gateValue(g8.tDiff, g8.allDaysZero);
  }
  return { seed, demeaned: demean, gate, cells, gapVsHOLD48, gapVsFADE,
    HOLD48: { tGross: f(C.hold48.tGross, 3), meanGross: f(C.hold48.meanGross, 6), tNet: f(C.hold48.tNet, 3) },
    FADE: { tGross: f(C.fade.tGross, 3), tNet: f(C.fade.tNet, 3), meanGross: f(C.fade.meanGross, 6), avgHoldHours: f(C.fade.avgHoldHours, 2) },
    trades: C.trades.length, oosTrades: C.oos.length, oosDays: C.cells.LOGIT.n, seconds: f(C.seconds, 1) };
}
/** N16 gate over the per-seed rows: for each statistic, median <= +1.0 AND at most 2 seeds > +2.0; clean iff all four pass */
function leakGate(rows) {
  const stats = {};
  for (const k of GATE_KEYS) {
    const v = rows.map((r) => r.gate[k]), med = median(v), above = v.filter((t) => t > LEAK_EXCEED_T).length, unformed = v.filter((t) => t === Infinity).length;
    stats[k] = { median: Number.isFinite(med) ? f(med, 3) : med === Infinity ? "+Infinity" : null, seedsAbove2: above, seedsUnformed: unformed,
      medianOK: med != null && med <= LEAK_MEDIAN_MAX, exceedOK: above <= LEAK_EXCEED_MAX, pass: med != null && med <= LEAK_MEDIAN_MAX && above <= LEAK_EXCEED_MAX,
      perSeed: v.map((t) => (Number.isFinite(t) ? f(t, 3) : "+Infinity")) };
  }
  const reportedOnly = {};
  for (const m of MODELS) { const v = rows.map((r) => r.gapVsFADE[m].tDiff).filter((t) => t != null); reportedOnly[`${m}_minus_FADE_t`] = { median: f(median(v), 3), seedsAbove2: v.filter((t) => t > 2).length, seedsBelowMinus2: v.filter((t) => t < -2).length, formed: v.length }; }
  for (const k of ["LOGIT", "GBM"]) { const v = rows.map((r) => r.cells[k].tNet).filter((t) => t != null); reportedOnly[`${k}_tNet`] = { median: f(median(v), 3), formed: v.length }; }
  { const v = rows.map((r) => r.HOLD48.tGross).filter((t) => t != null); reportedOnly.HOLD48_tGross = { median: f(median(v), 3), seedsAbove2: v.filter((t) => t > 2).length, formed: v.length }; }
  return { clean: rows.length > 0 && GATE_KEYS.every((k) => stats[k].pass), seeds: rows.length, statistics: stats, reportedOnly,
    limits: { medianMax: LEAK_MEDIAN_MAX, exceedT: LEAK_EXCEED_T, maxSeedsAbove: LEAK_EXCEED_MAX } };
}

// ════════════════════════════════════════════════════════════════════════════════ DECISION
/** registry decisionRule (amended 2026-10-01): PASS needs t >= bar, shuffled p95 beaten, vs FADE > 0, vs HOLD48 > 0, both halves > 0, amended leak gate clean */
function decide({ leakClean, days, tNet, beats, vsFadeMean, vsHold48Mean, firstHalf, secondHalf, bar }) {
  if (leakClean !== true) return "CANNOT MEASURE — amended leak gate not clean";
  if (!(days >= MIN_DAYS)) return `CANNOT MEASURE — ${days} out-of-sample days with trades (fewer than ${MIN_DAYS})`;
  return tNet != null && tNet >= bar && beats === true && vsFadeMean != null && vsFadeMean > 0 && vsHold48Mean != null && vsHold48Mean > 0
    && firstHalf != null && secondHalf != null && firstHalf > 0 && secondHalf > 0 ? "PASS" : "DID NOT PASS";
}
function halvesOf(s) {
  const k = Math.floor(s.dm.length / 2), a = s.dm.slice(0, k), b = s.dm.slice(k);
  return { first: { meanNet: f(a.length ? mean(a) : null, 6), tNet: f(tOf(a), 3), days: a.length, from: s.days[0] || null, through: s.days[k - 1] || null },
    second: { meanNet: f(b.length ? mean(b) : null, 6), tNet: f(tOf(b), 3), days: b.length, from: s.days[k] || null, through: s.days[s.days.length - 1] || null },
    raw: [a.length ? mean(a) : null, b.length ? mean(b) : null] };
}
function auc(p, y) {
  const n = p.length, idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[a] - p[b]); let rank = 0, n1 = 0, i = 0;
  while (i < n) { let j = i; while (j + 1 < n && p[idx[j + 1]] === p[idx[i]]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) if (y[idx[k]]) { rank += r; n1++; } i = j + 1; }
  const n0 = n - n1; return n1 && n0 ? (rank - (n1 * (n1 + 1)) / 2) / (n1 * n0) : null;
}
const pub = (s) => ({ tNet: f(s.tNet, 3), meanNet: f(s.meanNet, 6), n: s.n, trades: s.trades, winRate: f(s.winRate, 4), avgHoldHours: f(s.avgHoldHours, 2),
  dayWinRate: f(s.dayWinRate, 4), meanGross: f(s.meanGross, 6), tGross: f(s.tGross, 3), meanTradeNet: f(s.meanTradeNet, 6), medianTradeNet: f(s.medianTradeNet, 6), exitReasons: s.exitReasons });
const slim = (s) => ({ tNet: f(s.tNet, 3), meanNet: f(s.meanNet, 6), days: s.n, trades: s.trades, winRate: f(s.winRate, 4), meanGross: f(s.meanGross, 6), avgHoldHours: f(s.avgHoldHours, 2) });

// ════════════════════════════════════════════════════════════════════════════════ ASSEMBLY (real read)
function assemble(C, leakRes, firstRun = null) {
  const { oos, wf, cells, fade, hold48, gap, gap48, shuf } = C;
  const better = (cells.GBM.tNet ?? -Infinity) > (cells.LOGIT.tNet ?? -Infinity) ? "GBM" : "LOGIT", B = cells[better];
  const plc = {}; for (const m of MODELS) { const d = shuf[m].filter((x) => x != null), p95 = pctile(d, 0.95); plc[m] = { p95: f(p95, 6), p50: f(pctile(d, 0.5), 6), observed: f(cells[m].meanNet, 6), beats: cells[m].meanNet != null && p95 != null && cells[m].meanNet > p95, draws: d.length }; }
  const hv = {}; for (const m of MODELS) hv[m] = halvesOf(cells[m]);
  const vs = {}; for (const m of MODELS) vs[m] = { meanDiff: f(gap[m].meanDiff, 6), tDiff: f(gap[m].tDiff, 3), days: gap[m].days, shareTradesBetter: f(gap[m].shareTradesBetter, 4) };
  const vs48 = {}; for (const m of MODELS) vs48[m] = { meanDiff: f(gap48[m].meanDiff, 6), tDiff: f(gap48[m].tDiff, 3), days: gap48[m].days, shareTradesBetter: f(gap48[m].shareTradesBetter, 4), identicalToHOLD48: gap48[m].allDaysZero };
  const maker = {}; for (const m of MODELS) { const s = cellStats(oos, wf.legs, m, MAKER_RT); maker[m] = { tNet: f(s.tNet, 3), meanNet: f(s.meanNet, 6), winRate: f(s.winRate, 4), days: s.n }; }
  const fm = fadeStats(oos, MAKER_RT); maker.FADE = { tNet: f(fm.tNet, 3), meanNet: f(fm.meanNet, 6), winRate: f(fm.winRate, 4), days: fm.n };
  const hm = hold48Stats(oos, MAKER_RT); maker.HOLD48 = { tNet: f(hm.tNet, 3), meanNet: f(hm.meanNet, 6), winRate: f(hm.winRate, 4), days: hm.n }; maker.roundTrip = MAKER_RT;
  const be = oos.filter((x) => x.coin === "BTC" || x.coin === "ETH"), btcEthOnly = { coins: ["BTC", "ETH"] };
  for (const m of MODELS) { btcEthOnly[m] = slim(cellStats(be, wf.legs, m)); const g = pairedVsFade(be, wf.legs, m); btcEthOnly[m].vsFADE = { meanDiff: f(g.meanDiff, 6), tDiff: f(g.tDiff, 3) }; const g8 = pairedVsHold48(be, wf.legs, m); btcEthOnly[m].vsHOLD48 = { meanDiff: f(g8.meanDiff, 6), tDiff: f(g8.tDiff, 3) }; }
  btcEthOnly.FADE = slim(fadeStats(be)); btcEthOnly.HOLD48 = slim(hold48Stats(be));
  const perYear = {};
  for (const inf of wf.info) {
    const ty = oos.filter((x) => x.year === inf.Y), row = { trainTrades: inf.yp.train.length, trainRows: inf.yp.nTr, trainBaseRate: f(inf.trainBaseRate, 4), trainWindowClosedBy: inf.yp.maxTrainWindowClose, testTrades: ty.length };
    for (const m of MODELS) row[m] = slim(cellStats(ty, wf.legs, m)); row.FADE = slim(fadeStats(ty)); row.HOLD48 = slim(hold48Stats(ty)); perYear[inf.Y] = row;
  }
  // calibration on OOS rows (labels used only here, after the fact)
  const calibration = {};
  for (const m of MODELS) {
    const pr = [], yy = []; let fired = 0, firedCrest = 0, sumAtExit = 0;
    for (const inf of wf.info) { const p = m === "LOGIT" ? inf.pL : inf.pG; inf.yp.test.forEach((x, a) => { for (let h = 0; h < H_MAX; h++) { pr.push(p[a * H_MAX + h]); yy.push(x.y[h]); } const L = wf.legs.get(x)[m]; if (L.reason === "model") { fired++; firedCrest += x.y[L.hold - 1]; sumAtExit += p[a * H_MAX + L.hold - 1]; } }); }
    const bins = []; for (let b = 0; b < 10; b++) { const lo = b / 10, hi = (b + 1) / 10; let n = 0, sp = 0, sy = 0; for (let i = 0; i < pr.length; i++) if (pr[i] >= lo && (pr[i] < hi || (b === 9 && pr[i] <= 1))) { n++; sp += pr[i]; sy += yy[i]; } bins.push({ lo, hi, n, meanPred: f(n ? sp / n : null, 4), realised: f(n ? sy / n : null, 4) }); }
    let br = 0; for (let i = 0; i < pr.length; i++) br += (pr[i] - yy[i]) ** 2;
    calibration[m] = { rows: pr.length, baseRateOOS: f(mean(yy), 4), meanPredicted: f(mean(pr), 4), brier: f(br / pr.length, 5), brierOfBaseRate: f(mean(yy) * (1 - mean(yy)), 5), auc: f(auc(pr, yy), 4), bins,
      modelExits: fired, exitPrecision: f(fired ? firedCrest / fired : null, 4), meanPredAtExit: f(fired ? sumAtExit / fired : null, 4) };
  }
  calibration.note = "OOS rows = every hour h=1..47 of every out-of-sample trade; realised = share whose crest had passed (the label, known only after the fact); exitPrecision = share of model exits taken after the crest had in fact passed";
  // feature importance
  const coefByYear = {}, gainByYear = {}, gainTot = new Array(P).fill(0), splitTot = new Array(P).fill(0), absCoef = new Array(P).fill(0);
  for (const inf of wf.info) {
    coefByYear[inf.Y] = Object.fromEntries(FEATS.map((n, i) => [n, f(inf.mL.b[i + 1], 4)])); coefByYear[inf.Y].intercept = f(inf.mL.b[0], 4);
    const gs = inf.mG.gain.reduce((s, x) => s + x, 0); gainByYear[inf.Y] = Object.fromEntries(FEATS.map((n, i) => [n, f(gs ? inf.mG.gain[i] / gs : null, 4)]));
    for (let i = 0; i < P; i++) { gainTot[i] += inf.mG.gain[i]; splitTot[i] += inf.mG.splits[i]; absCoef[i] += Math.abs(inf.mL.b[i + 1]) / wf.info.length; }
  }
  const gT = gainTot.reduce((s, x) => s + x, 0);
  const featureImportance = {
    LOGIT: { meanAbsStdCoef: Object.fromEntries(FEATS.map((n, i) => [n, f(absCoef[i], 4)])), coefByYear, note: "coefficients on training-standardised features (log-odds per training SD); + raises P(crest passed)" },
    GBM: { gainShare: Object.fromEntries(FEATS.map((n, i) => [n, f(gT ? gainTot[i] / gT : null, 4)])), splits: Object.fromEntries(FEATS.map((n, i) => [n, splitTot[i]])), gainShareByYear: gainByYear, note: "squared-error reduction on the boosting gradient, summed over all trees and all six yearly models" },
  };
  // crest diagnostics
  const crest = {};
  for (const m of [...MODELS, "FADE"]) {
    const L = (x) => (m === "FADE" ? x.fade : wf.legs.get(x)[m]), up = oos.filter((x) => x.crest.peakGain > 0);
    const before = up.filter((x) => L(x).hold < x.crest.peakHour).length, at = up.filter((x) => L(x).hold === x.crest.peakHour).length;
    crest[m] = { tradesPeakAboveEntry: up.length, shareExitBeforePeak: f(up.length ? before / up.length : null, 4), shareExitAtPeak: f(up.length ? at / up.length : null, 4), shareExitAfterPeak: f(up.length ? (up.length - before - at) / up.length : null, 4),
      medianCaptureOfPeak: f(median(up.map((x) => L(x).gross / x.crest.peakGain)), 4), medianHoldHours: median(oos.map((x) => L(x).hold)), shareHold1h: f(oos.filter((x) => L(x).hold === 1).length / oos.length, 4), shareCap48h: f(oos.filter((x) => L(x).hold === CAP_H).length / oos.length, 4) };
  }
  const perCoin = {}; for (const coin of COINS) { const tc = oos.filter((x) => x.coin === coin); perCoin[coin] = { trades: tc.length }; if (tc.length) for (const m of [...MODELS]) perCoin[coin][m] = slim(cellStats(tc, wf.legs, m)); }
  const trainCheck = wf.info.map((inf) => ({ Y: inf.Y, yearStart: new Date(inf.yp.Y0).toISOString(), latestTrainingWindowClose: inf.yp.maxTrainWindowClose, ok: inf.yp.maxTrainWindowClose == null || Date.parse(inf.yp.maxTrainWindowClose) < inf.yp.Y0 }));
  const nonFinite = {}; for (const inf of wf.info) nonFinite[inf.Y] = { train: Object.fromEntries(FEATS.map((n, i) => [n, inf.yp.nonFinite.train[i]]).filter(([, v]) => v)), test: Object.fromEntries(FEATS.map((n, i) => [n, inf.yp.nonFinite.test[i]]).filter(([, v]) => v)) };
  const verdictScript = decide({ leakClean: leakRes.clean, days: B.n, tNet: B.tNet, beats: plc[better].beats, vsFadeMean: gap[better].meanDiff, vsHold48Mean: gap48[better].meanDiff, firstHalf: hv[better].raw[0], secondHalf: hv[better].raw[1], bar: BAR });
  const ptx = (x) => (x == null ? "n/a" : (100 * x).toFixed(3) + "%");
  return {
    id: ID, name: REG.name, asOf: new Date().toISOString(), script: "backend/r308-crest-predictor.js", scriptSha256: scriptSha(), statistic: REG.statistic, unit: "days", window: `${WIN0}..${WIN1} (out of sample, walk-forward by year)`,
    tNet: f(B.tNet, 3), meanNet: f(B.meanNet, 6), n: B.n, cell: better, winRate: f(B.winRate, 4), dayWinRate: f(B.dayWinRate, 4), trades: B.trades, avgHoldHours: f(B.avgHoldHours, 2), meanGross: f(B.meanGross, 6), tGross: f(B.tGross, 3),
    bar: { tRequired: BAR, variants: REG.bar.variants, source: REG.bar.source },
    cells: Object.fromEntries(MODELS.map((m) => [m, pub(cells[m])])),
    reference: { FADE: { ...pub(fade), note: "R307's best mechanical exit on the same out-of-sample trades (paired control)" },
      HOLD48: { ...pub(hold48), note: "every trade held to the 48 h cap, same trades (amended paired control, N16/N17)" } },
    placebo: { p95: plc[better].p95, p50: plc[better].p50, observed: plc[better].observed, beats: plc[better].beats, draws: plc[better].draws, cell: better, seed: SEED,
      kind: "shuffled labels (N10): labels permuted within each trade (all 47 hours), both models refitted by the same walk-forward; mean daily net of the same cell", byCell: plc },
    halves: { first: hv[better].first, second: hv[better].second, cell: better, split: "out-of-sample days sorted, first floor(n/2) vs the rest", bothPositive: hv[better].raw[0] > 0 && hv[better].raw[1] > 0 },
    halvesByCell: Object.fromEntries(MODELS.map((m) => [m, { first: hv[m].first, second: hv[m].second, bothPositive: hv[m].raw[0] > 0 && hv[m].raw[1] > 0 }])),
    vsFADE: { ...vs[better], cell: better, byCell: vs, note: "per trade model net minus R307 FADE net on the same trades, day means, t over days (cost cancels)" },
    vsHOLD48: { ...vs48[better], cell: better, byCell: vs48, note: "AMENDED gate: per trade model net minus HOLD48 net (same trade held to the 48 h cap), day means, t over days (cost cancels); PASS needs mean > 0" },
    leakTest: leakRes,
    leakTestFirstRun: firstRun,
    makerCost030: maker, btcEthOnly, perYear, calibration, featureImportance, crest, perCoin,
    diagnostics: { tradesAll: C.trades.length, tradesOOS: oos.length, entriesDroppedNoExit: C.dropped, trainCheck, nonFiniteFeatureValues: nonFinite,
      logitIters: Object.fromEntries(wf.info.map((i) => [i.Y, i.mL.iters])), logitGradNorm: Object.fromEntries(wf.info.map((i) => [i.Y, f(i.mL.gradNorm, 10)])), gbmMinLeafRows: Object.fromEntries(wf.info.map((i) => [i.Y, i.mG.minLeafRows])), runSeconds: f(C.seconds, 1) },
    verdictScript,
    verdictReasons: { better, tNetVsBar: `${f(B.tNet, 3)} vs ${BAR}`, passT: B.tNet != null && B.tNet >= BAR, shuffledBeaten: plc[better].beats, vsFADEPositive: gap[better].meanDiff > 0, vsHOLD48Positive: gap48[better].meanDiff > 0, halvesBothPositive: hv[better].raw[0] > 0 && hv[better].raw[1] > 0, leakClean: leakRes.clean, oosDays: B.n },
    costModel: "0.50% round trip per trade (Alpaca crypto taker 0.25%/side), gross beside net; maker scenario 0.30% reported",
    notes: [
      "Implementation choices N1-N15 are fixed in the header of backend/r308-crest-predictor.js and were written before any synthetic-leak or real result was computed; N16-N17 (the amended leak gate, HOLD48 control, read-once guard) were written after the first single-seed leak run and before the amended gate or any real-data model score was computed.",
      "AMENDMENT (registry amendments[0], 2026-10-01, pre-evidence): the first single-seed two-sided leak run (training/r308/leak-test.json, kept as leakTestFirstRun) failed on the NEGATIVE side (LOGIT gross t -2.314, GBM -2.157) and wrote a CANNOT MEASURE output; it is SUPERSEDED by the amended 20-seed one-sided gate (training/r308/leak-test-amended.json, leakTest here). The amendment follows that failure and is disclosed as such; the real data had not been scored by the models when it was made.",
      `Win rate beside the mean: ${better} trade win rate ${B.winRate == null ? "n/a" : (100 * B.winRate).toFixed(1) + "%"}; HOLD48 on the same trades mean ${ptx(hold48.meanNet)}/day, win ${hold48.winRate == null ? "n/a" : (100 * hold48.winRate).toFixed(1) + "%"}; model minus HOLD48 ${ptx(gap48[better].meanDiff)}/day (t ${f(gap48[better].tDiff, 3)}).`,
      `Headline: ${better} mean ${ptx(B.meanNet)}/day net, win rate ${B.winRate == null ? "n/a" : (100 * B.winRate).toFixed(1) + "%"} (FADE on the same trades ${ptx(fade.meanNet)}/day, win ${fade.winRate == null ? "n/a" : (100 * fade.winRate).toFixed(1) + "%"}), t ${f(B.tNet, 3)} vs bar ${BAR}.`,
      "Win rate = share of trades with net > 0 (beside the mean); dayWinRate = share of entry-days with a positive mean net.",
      "Leak test (N16, amended): 20 seeds of demeaned, permuted hourly-return paths (martingale); a leak is a POSITIVE edge; for each cell the median of the GROSS t <= +1.0 and at most 2 of 20 seeds > +2.0, and the same for the model-minus-HOLD48 gap t; model-minus-FADE, net t and the literal not-demeaned permutation are reported only.",
      "Trades reproduce R307 exactly (selftest check against the sealed R307 output); R307's survivorship (today's coin list) carries over and flatters any long-surge result.",
      "No-trade hours (Coinbase omitted the hour) are decision hours at their carried close, as in R307 N1/N7.",
      "Research only; no orders.",
    ],
  };
}

// ════════════════════════════════════════════════════════════════════════════════ SELFTEST
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function synthXY(n, sv, fy) { const r = mulberry32(sv), Xc = Array.from({ length: P }, () => new Float64Array(n)), y = new Uint8Array(n), row = new Array(P); for (let i = 0; i < n; i++) { for (let j = 0; j < P; j++) { row[j] = gauss(r); Xc[j][i] = row[j]; } y[i] = r() < fy(row) ? 1 : 0; } return { Xc, y, n }; }
function sortPrep(Xc) { const order = Xc.map((x) => { const o = new Uint32Array(x.length); for (let i = 0; i < o.length; i++) o[i] = i; return o.sort((a, b) => x[a] - x[b] || a - b); }); return { order, sorted: Xc.map((x, j) => Float64Array.from(order[j], (i) => x[i])) }; }
function rwBars(N, sv, miss = 0.03) { const r = mulberry32(sv), b = []; let p = 100; for (let i = 0; i < N; i++) { const o = p; p *= 1 + (r() - 0.5) * 0.02; b.push(i > 0 && r() < miss ? null : { o, h: Math.max(o, p) * (1 + r() * 0.003), l: Math.min(o, p) * (1 - r() * 0.003), c: p, v: 5 + r() * 20 }); } return b; }
function synthCoin(name, sv) {     // R307's selftest generator: noise + rare +4% jumps on 8x volume, full grid
  const rng = mulberry32(sv), bars = []; let p = 100;
  for (let i = 0; i < NGRID; i++) { const jump = rng() < 0.004, r = (rng() - 0.5) * 0.01 + (jump ? 0.04 : 0), o = p; p *= 1 + r; bars.push(rng() < 0.01 ? null : { o, h: Math.max(o, p) * (1 + rng() * 0.002), l: Math.min(o, p) * (1 - rng() * 0.002), c: p, v: (jump ? 8 : 1) * (5 + rng() * 5) }); }
  return prep(W.mkSeries(bars, PULL0, name));
}
const sameNum = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

function selftest({ real = true, series = null } = {}) {
  let fail = 0; const chk = (name, ok, extra = "") => { console.log(`  ${ok ? "OK  " : "FAIL"} ${name} ${extra}`); if (!ok) fail++; };
  const t00 = Date.now();
  // ---- 0. registry
  console.log(`  registry: bar ${BAR} (variants ${REG.bar.variants}); ${COINS.length} coins; LOGIT lambda ${LAMBDA}; GBM depth 2 x ${ROUNDS} rounds lr ${LR} minLeaf ${MIN_LEAF}; threshold ${THRESH}; cap ${CAP_H} h; cost ${COST_RT}; shuffles ${SHUF_DRAWS}`);
  chk("registry: R308 bar 1.981 best-of-2, this script, 32 coins from R307's universe", BAR === 1.981 && REG.bar.variants === 2 && REG.script === "backend/r308-crest-predictor.js" && COINS.length === 32 && COINS[0] === "BTC" && COINS[31] === "ONDO");
  const need = ["h = 1..47", "lambda 1.0", "depth-2", "200 rounds", "learning rate 0.05", "min 50 rows per leaf", ">= 0.5", "48 h", "0.50% round trip", "2021..2026", "before Jan 1 of Y"];
  chk("registry rule text carries every frozen parameter used here", need.every((s) => REG.rule.includes(s)), `(missing: ${need.filter((s) => !REG.rule.includes(s)).join(", ") || "none"})`);
  chk("registry controls: >= 50 shuffled-label permutations (here 100); min 300 days", /\(>= 50 permutations\)/.test(REG.controls.learnedNothing) && SHUF_DRAWS >= 50 && /fewer than 300/.test(REG.decisionRule.cannotMeasure));
  {
    const LT = REG.controls.leakTest || "", A0 = (REG.amendments || []).find((a) => a.field === "controls.leakTest");
    const needL = ["AMENDED 2026-10-01 (pre-evidence)", "20 synthetic seeds", "demeaned then randomly permuted", "A LEAK is a POSITIVE edge", "GROSS cell t is <= +1.0", "at most 2 of 20 seeds exceed +2.0", "model-minus-HOLD48 gap t", "Model-minus-FADE on synthetic data is reported only"];
    chk("registry amendment: leak gate = 20 seeds, median gross t <= +1.0, <= 2 of 20 above +2.0, same for model-minus-HOLD48; FADE gap reported only", needL.every((x) => LT.includes(x)) && LEAK_SEEDS.length === 20 && new Set(LEAK_SEEDS).size === 20 && LEAK_MEDIAN_MAX === 1.0 && LEAK_EXCEED_T === 2.0 && LEAK_EXCEED_MAX === 2, `(missing: ${needL.filter((x) => !LT.includes(x)).join(" | ") || "none"})`);
    chk("registry amendment: dated, pre-evidence, first leak run kept; vsHOLD48 control present; decision rule requires beating HOLD48 and the amended gate", !!A0 && A0.date === "2026-10-01" && A0.preEvidence === true && /leak-test\.json/.test(A0.firstLeakRun || "") && /mean > 0/.test(REG.controls.vsHOLD48 || "") && /beats HOLD48 on the paired difference \(mean > 0\)/.test(REG.decisionRule.pass) && /amended 20-seed leak gate was clean/.test(REG.decisionRule.pass) && /beats FADE on the paired difference \(mean > 0\)/.test(REG.decisionRule.pass));
    chk("amended seeds: 308001..308020, disjoint from the post-hoc diagnostic's 308001 + 7777 s (s = 1..12)", LEAK_SEEDS[0] === 308001 && LEAK_SEEDS[19] === 308020 && Array.from({ length: 12 }, (_, i) => 308001 + 7777 * (i + 1)).every((x) => !LEAK_SEEDS.includes(x)));
  }

  // ---- 1. label definition (known answers)
  const flat = (N) => { const b = []; for (let i = 0; i < N; i++) b.push({ o: 100, h: 100.5, l: 99.5, c: 100, v: 10 }); return b; };
  const withPath = (closes, { missing = [] } = {}) => { const b = flat(300); closes.forEach((c, j) => { const k = 201 + j, p = b[k - 1].c; b[k] = { o: p, h: Math.max(p, c), l: Math.min(p, c), c, v: 10 }; }); for (const k of missing) b[k] = null; return prep(W.mkSeries(b)); };
  const p1 = [101, 103, 102, 103, 100, ...Array(43).fill(99)], p2 = [...p1.slice(0, 47), 99.5];
  {
    const S1 = withPath(p1), y1 = []; for (let h = 1; h <= H_MAX; h++) y1.push(labelOf(S1, 200, h));
    chk("label: path 101,103,102,103,100,99.. -> y = 0,1,0,1,1..1 (a later EQUAL close does not un-pass the crest)", y1.join("") === "0101" + "1".repeat(43), `(${y1.join("")})`);
    const S2 = withPath(p2), y2 = []; for (let h = 1; h <= H_MAX; h++) y2.push(labelOf(S2, 200, h));
    chk("label: last close 99.5 -> y = 0,1,0,1,1,0..0 (h=47 looks only at h=48)", y2.join("") === "01011" + "0".repeat(42), `(${y2.join("")})`);
    const S3 = withPath(p1, { missing: [203] }), y3 = []; for (let h = 1; h <= 4; h++) y3.push(labelOf(S3, 200, h));
    chk("label: a no-trade hour carries the prior close (h=3 -> 103) -> y = 0,1,1,1", y3.join("") === "0111" && S3.lc[203] === 103, `(${y3.join("")})`);
    const a4 = featureRow(S1, null, 200, 4), a5 = featureRow(S1, null, 200, 5);
    chk("features: h=4 at 103 -> ret 3%, drawdown 0, hoursSinceHigh 2 (an equal close does not reset the high)", Math.abs(a4[0] - 0.03) < 1e-12 && a4[1] === 0 && a4[2] === 4 && a4[3] === 2);
    chk("features: h=5 at 100 -> ret 0, drawdown 100/103-1, hoursSinceHigh 3; no reference -> NaN", a5[0] === 0 && Math.abs(a5[1] - (100 / 103 - 1)) < 1e-15 && a5[3] === 3 && Number.isNaN(a5[9]));
  }
  // ---- 2. every feature against an independent recomputation from the raw bars (gaps included)
  {
    const b = rwBars(700, 41), rb = rwBars(700, 42, 0), S = prep(W.mkSeries(b)), R = prep(W.mkSeries(rb));
    const lcI = (bb, i) => { for (let j = i; j >= 0; j--) if (bb[j]) return bb[j].c; return NaN; }, v0 = (i) => (b[i] ? b[i].v : 0), rI = (i) => lcI(b, i) / lcI(b, i - 1) - 1;
    const rng = (a, z) => { const o = []; for (let j = a; j <= z; j++) o.push(j); return o; };
    const indep = (t, h) => {
      const k = t + h, E = b[t].c; let H = E, kH = t; for (let j = t + 1; j <= k; j++) if (lcI(b, j) > H) { H = lcI(b, j); kH = j; }
      const med = median(rng(k - 168, k - 1).map(v0)), sdK = sd(rng(k - 168, k - 1).map(rI)), sdT = sd(rng(t - 168, t - 1).map(rI)), r6 = sd(rng(k - 5, k).map(rI));
      const m24 = mean(rng(k - 23, k).map((j) => lcI(b, j)));
      const cl = rng(0, k).map((j) => lcI(b, j)); let ag = 0, al = 0, rs = NaN;
      for (let i = 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0); if (i <= 14) { ag += g / 14; al += l / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; } if (i >= 14) rs = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
      const dt = new Date(PULL0 + k * HOUR);
      return [lcI(b, k) / E - 1, lcI(b, k) / H - 1, h, k - kH, v0(k) / med, (v0(k - 2) + v0(k - 1) + v0(k)) / 3 / v0(t), r6 / sdK, lcI(b, k) / m24 - 1, rs, lcI(rb, k) / lcI(rb, t) - 1, rI(t) / sdT, dt.getUTCHours(), dt.getUTCDay()];
    };
    let bad = 0, cnt = 0; const worst = new Array(P).fill(0);
    for (const t of [300, 333, 401, 452, 520, 600]) { if (!b[t]) continue; for (const h of [1, 2, 5, 17, 30, 47]) { const a = featureRow(S, R, t, h), e = indep(t, h); cnt++; for (let j = 0; j < P; j++) { const d = Math.abs(a[j] - e[j]) / Math.max(1e-9, Math.abs(e[j])); worst[j] = Math.max(worst[j], d); if (!(d < 1e-9)) bad++; } } }
    chk(`features: all 13 equal an independent recomputation from raw bars (${cnt} hours, gaps included)`, bad === 0 && cnt >= 30, `(${bad} diffs; worst rel ${Math.max(...worst).toExponential(1)})`);
    // ---- 3. truncate-the-future probe (synthetic), plus proof the probe catches a look-ahead
    const r = mulberry32(7); let diff = 0, leakSeen = 0, probes = 0;
    const leaky = (S_, R_, t, h, out = new Float64Array(P), o = 0) => { featureRow(S_, R_, t, h, out, o); out[o] = S_.lc[t + h + 1] / S_.c[t] - 1; return out; };
    for (let k = 0; k < 40; k++) {
      const t = 250 + Math.floor(r() * 350); if (!b[t]) continue; const h = 1 + Math.floor(r() * 47), K = t + h; probes++;
      const St = truncate(S, K), Rt = truncate(R, K), A = featureRow(S, R, t, h), Bt = featureRow(St, Rt, t, h);
      for (let j = 0; j < P; j++) if (!sameNum(A[j], Bt[j])) diff++;
      const LA = leaky(S, R, t, h), LB = leaky(St, Rt, t, h); if (!sameNum(LA[0], LB[0])) leakSeen++;
    }
    chk(`truncate-the-future: every feature at (t,h) unchanged when every bar > t+h is deleted (${probes} probes)`, diff === 0 && probes >= 30, `(${diff} diffs)`);
    chk("truncate-the-future probe has power: a feature reading the close at h+1 is caught on every probe", leakSeen === probes, `(${leakSeen}/${probes})`);
  }
  // ---- 4. walk-forward boundary
  {
    const r = mulberry32(9), fake = [], Y0 = Date.UTC(2022, 0, 1);
    const mk = (wc) => { const day = isoDay(wc - (CAP_H + 1) * HOUR); return { coin: "SYN", t: 0, day, year: +day.slice(0, 4), windowClose: wc, entry: 100, path: new Float64Array(49).fill(100), X: Float64Array.from({ length: H_MAX * P }, () => r()), y: Uint8Array.from({ length: H_MAX }, () => (r() < 0.5 ? 1 : 0)), fade: { net: 0 } }; };
    for (let i = 0; i < 700; i++) fake.push(mk(Date.UTC(2019, 0, 10) + i * 4 * DAY + 7 * HOUR));
    const A = mk(Y0 - HOUR), Bx = mk(Y0); fake.push(A, Bx);
    const ys = prepareYears(fake), y22 = ys.find((x) => x.Y === 2022), y23 = ys.find((x) => x.Y === 2023);
    chk("walk-forward: a window closing 1 h before 2022-01-01 trains model 2022; one closing AT midnight does not (it trains 2023)", y22.train.includes(A) && !y22.train.includes(Bx) && y23.train.includes(A) && y23.train.includes(Bx));
    let ok = true; for (const yp of ys) { const brute = fake.filter((x) => x.windowClose < yp.Y0); if (brute.length !== yp.train.length || yp.train.some((x) => !(x.windowClose < yp.Y0))) ok = false; if (yp.test.some((x) => x.year !== yp.Y)) ok = false; }
    chk("walk-forward: every year's training set == brute-force {window close < Jan 1 of Y}; tests only that year's entries", ok);
    const late = fake.filter((x) => x.year === 2021 && x.windowClose >= Date.UTC(2022, 0, 1));
    chk("walk-forward: late-December 2021 entries whose window runs into 2022 are tested in 2021 and train only model 2023", late.length > 0 && ys.every((yp) => yp.train.every((x) => x.windowClose < yp.Y0)) && late.every((x) => !y22.train.includes(x) && y23.train.includes(x)), `(${late.length} such)`);
    const Xs = ys.find((x) => x.Y === 2024), muOK = Xs.mu.every((m, j) => Math.abs(m - mean(Xs.train.flatMap((x) => Array.from({ length: H_MAX }, (_, h) => x.X[h * P + j])))) < 1e-12);
    chk("standardisation uses training rows only (mean recomputed from the training trades)", muOK);
  }
  // ---- 5. LOGIT
  {
    const A = synthXY(40000, 5, (x) => sigmoid(0.3 + 1.2 * x[0] - 0.8 * x[5])), m = fitLogit(A.Xc, A.y, A.n);
    const truth = [0.3, 1.2, 0, 0, 0, 0, -0.8, 0, 0, 0, 0, 0, 0, 0]; let worst = 0; for (let j = 0; j < truth.length; j++) worst = Math.max(worst, Math.abs(m.b[j] - truth[j]));
    chk("LOGIT recovers a planted signal (b0 0.3, x0 +1.2, x5 -0.8, rest 0) within 0.07", worst < 0.07, `(worst ${worst.toFixed(4)}, iters ${m.iters})`);
    chk("LOGIT converged to the penalised optimum (gradient norm < 1e-6)", m.gradNorm < 1e-6, `(${m.gradNorm.toExponential(2)})`);
    const Bt = synthXY(20000, 6, (x) => sigmoid(0.3 + 1.2 * x[0] - 0.8 * x[5])), a = auc(predictLogit(m, Bt.Xc, Bt.n), Bt.y);
    chk("LOGIT out-of-sample AUC on the planted signal > 0.75", a > 0.75, `(${a.toFixed(4)})`);
    const N1 = synthXY(20000, 8, () => 0.5), N2 = synthXY(20000, 10, () => 0.5), a0 = auc(predictLogit(fitLogit(N1.Xc, N1.y, N1.n), N2.Xc, N2.n), N2.y);
    chk("LOGIT on pure noise: out-of-sample AUC within 0.5 +/- 0.02", Math.abs(a0 - 0.5) < 0.02, `(${a0.toFixed(4)})`);
    const one = { Xc: [Float64Array.from({ length: 4 }, (_, i) => i)], y: Uint8Array.from([0, 1, 0, 1]) }, m1 = fitLogit(one.Xc, one.y, 4, 1.0), g1 = logitGrad(m1.b, one.Xc, one.y, 4, 1.0);
    chk("LOGIT: lambda/2 ||w||^2 penalty, intercept free: gradient zero including the penalty term", Math.abs(g1[0]) < 1e-9 && Math.abs(g1[1]) < 1e-9);
  }
  // ---- 6. GBM
  {
    const n = 200, x0 = Float64Array.from({ length: n }, (_, i) => i), yS = Uint8Array.from({ length: n }, (_, i) => (i >= 100 ? 1 : 0)), sp = sortPrep([x0]);
    const m = fitGBM([x0], sp.order, sp.sorted, yS, n, { rounds: 1 }), t0 = m.trees[0], pr = predictGBM(m, [x0], n);
    chk("GBM round 1 on a step: F0 0, root split 99.5, no child split (zero gain), Newton leaves -2 / +2, F = -/+0.1", m.F0 === 0 && t0.f === 0 && t0.thr === 99.5 && !t0.kids[0] && !t0.kids[1] && Math.abs(t0.v[0] + 2) < 1e-9 && Math.abs(t0.v[2] - 2) < 1e-9 && Math.abs(pr[0] - sigmoid(-0.1)) < 1e-12 && Math.abs(pr[199] - sigmoid(0.1)) < 1e-12);
    const yM = Uint8Array.from({ length: n }, (_, i) => (i >= 190 ? 1 : 0)), mM = fitGBM([x0], sp.order, sp.sorted, yM, n, { rounds: 5 });
    chk("GBM min 50 rows per leaf: a 10-row tail cannot be isolated (every leaf >= 50 rows)", mM.minLeafRows >= 50 && mM.trees.every((t) => t.f < 0 || (t.thr >= 49.5 && t.thr <= 149.5)), `(minLeafRows ${mM.minLeafRows}, root thr ${mM.trees[0].thr})`);
    const A = synthXY(30000, 11, (x) => (x[2] > 0.3 ? 0.85 : 0.15) * (x[7] > 0 ? 1 : 0.9)), spA = sortPrep(A.Xc), mA = fitGBM(A.Xc, spA.order, spA.sorted, A.y, A.n);
    const gs = mA.gain.reduce((s, v) => s + v, 0), top = mA.gain.indexOf(Math.max(...mA.gain));
    const Bt = synthXY(20000, 12, (x) => (x[2] > 0.3 ? 0.85 : 0.15) * (x[7] > 0 ? 1 : 0.9)), pB = predictGBM(mA, Bt.Xc, Bt.n); let acc = 0; for (let i = 0; i < Bt.n; i++) acc += (pB[i] >= 0.5 ? 1 : 0) === Bt.y[i] ? 1 : 0; acc /= Bt.n;
    chk("GBM recovers a planted threshold (x2 > 0.3): top gain feature x2 (> 60% of gain), OOS accuracy >= 0.81 (Bayes ~0.84)", top === 2 && mA.gain[2] / gs > 0.6 && acc >= 0.81, `(share ${(mA.gain[2] / gs).toFixed(3)}, acc ${acc.toFixed(4)})`);
    let dmax = 0; const raw = predictGBMraw(mA, A.Xc, A.n); for (let i = 0; i < A.n; i++) dmax = Math.max(dmax, Math.abs(raw[i] - mA.trainF[i]));
    chk("GBM prediction path == training path (same trees reproduce the fitted scores)", dmax < 1e-9, `(${dmax.toExponential(1)})`);
    chk("GBM: 200 rounds, every leaf >= 50 rows on the planted data", mA.trees.length === 200 && mA.minLeafRows >= 50);
    const N1 = synthXY(20000, 13, () => 0.5), spN = sortPrep(N1.Xc), N2 = synthXY(20000, 14, () => 0.5), a0 = auc(predictGBM(fitGBM(N1.Xc, spN.order, spN.sorted, N1.y, N1.n), N2.Xc, N2.n), N2.y);
    chk("GBM on pure noise: out-of-sample AUC within 0.5 +/- 0.02", Math.abs(a0 - 0.5) < 0.02, `(${a0.toFixed(4)})`);
  }
  // ---- 7. exit policy and the cap
  {
    const x = { t: 1000, entry: 100, path: Float64Array.from({ length: 49 }, (_, j) => 100 + j * 0.1) }, pr = new Float64Array(H_MAX).fill(0.2);
    pr[2] = 0.5; const L1 = policyLeg(x, pr, 0);
    chk("policy: first P >= 0.5 at h=3 (inclusive) -> exit at the close of h=3", L1.hold === 3 && L1.k === 1003 && L1.px === x.path[3] && L1.reason === "model" && Math.abs(L1.net - (x.path[3] / 100 - 1 - 0.005)) < 1e-15);
    const pr2 = new Float64Array(H_MAX).fill(0.4999999), L2 = policyLeg(x, pr2, 0);
    chk("policy: never >= 0.5 -> the 48 h cap at the close of t+48", L2.hold === 48 && L2.px === x.path[48] && L2.reason === "cap");
    const pr3 = new Float64Array(2 * H_MAX).fill(0.1); pr3[H_MAX] = 0.9; const L3 = policyLeg(x, pr3, H_MAX), L4 = policyLeg(x, pr3, 0);
    chk("policy: row offset respected (h=1 for the second trade; the first trade caps)", L3.hold === 1 && L4.hold === 48);
    const pr5 = new Float64Array(H_MAX).fill(0.1); pr5[46] = 0.7; chk("policy: h=47 can exit; h=48 is the cap, not a model decision", policyLeg(x, pr5, 0).hold === 47);
    chk("maker scenario: net = gross - 0.30%", Math.abs(legFor(L1, MAKER_RT).net - (L1.gross - 0.003)) < 1e-15);
  }
  // ---- 8. day clustering (R307's dayStats) and the paired gap
  {
    const L = (net) => ({ net, gross: net + 0.005, hold: 1, reason: "x" });
    const tr = [{ day: "2021-01-01", cells: { M: L(0.01) } }, { day: "2021-01-01", cells: { M: L(0.03) } }, { day: "2021-01-02", cells: { M: L(-0.01) } }, { day: "2021-01-03", cells: { M: L(0.04) } }];
    const s = W.dayStats(tr, "M"), dm = [0.02, -0.01, 0.04], m = mean(dm);
    chk("day clustering: 4 trades -> 3 days, mean of day means, t over days, trade win rate 0.75", s.n === 3 && s.trades === 4 && Math.abs(s.meanNet - m) < 1e-15 && Math.abs(s.tNet - tOf(dm)) < 1e-12 && s.winRate === 0.75);
    const xs = [{ day: "d1", fade: L(0.0) }, { day: "d1", fade: L(0.02) }, { day: "d2", fade: L(0.01) }, { day: "d3", fade: L(-0.02) }], lg = new Map();
    const mv = [0.01, 0.01, 0.0, 0.01]; xs.forEach((x, i) => lg.set(x, { LOGIT: L(mv[i]) }));
    const g = pairedVsFade(xs, lg, "LOGIT"), dd = [(0.01 + 0.01) / 2 - (0 + 0.02) / 2, 0 - 0.01, 0.01 + 0.02];
    chk("paired vs FADE: day mean of (model - FADE) per trade, t over days", Math.abs(g.meanDiff - mean(dd)) < 1e-15 && Math.abs(g.tDiff - tOf(dd)) < 1e-12 && g.days === 3);
    const xh = [{ day: "d1", t: 0, entry: 100, path: Float64Array.from({ length: 49 }, (_, j) => (j === 48 ? 101 : 100)) }, { day: "d1", t: 0, entry: 100, path: Float64Array.from({ length: 49 }, (_, j) => (j === 48 ? 99 : 100)) }, { day: "d2", t: 0, entry: 100, path: Float64Array.from({ length: 49 }, (_, j) => (j === 48 ? 102 : 100)) }], lh = new Map();
    const mh = [0.02, -0.03, 0.0]; xh.forEach((x, i) => lh.set(x, { LOGIT: L(mh[i]) }));
    const h48 = hold48Leg(xh[0]), g8 = pairedVsHold48(xh, lh, "LOGIT"), d8 = [((0.02 - (0.01 - 0.005)) + (-0.03 - (-0.01 - 0.005))) / 2, 0.0 - (0.02 - 0.005)];
    chk("HOLD48 leg = exit at path[48] (lc[t+48]), hold 48, net = gross - 0.50%; paired day difference vs HOLD48, t over days", h48.hold === 48 && h48.px === 101 && Math.abs(h48.gross - 0.01) < 1e-15 && Math.abs(h48.net - 0.005) < 1e-15 && Math.abs(g8.meanDiff - mean(d8)) < 1e-15 && Math.abs(g8.tDiff - tOf(d8)) < 1e-12 && g8.days === 2 && g8.allDaysZero === false);
    const lz = new Map(); xh.forEach((x) => lz.set(x, { LOGIT: hold48Leg(x) })); const gz = pairedVsHold48(xh, lz, "LOGIT");
    chk("HOLD48: a model that always caps is identical to HOLD48 -> every day 0, t not formed (null), allDaysZero flagged", gz.meanDiff === 0 && gz.tDiff === null && gz.allDaysZero === true);
    const hs = halvesOf({ dm: [1, 2, 3, 4, 5], days: ["a", "b", "c", "d", "e"] });
    chk("halves: 5 days -> first 2, second 3 (by day count)", hs.first.days === 2 && hs.second.days === 3 && hs.raw[0] === 1.5 && hs.raw[1] === 4);
  }
  // ---- 9. decision rule
  {
    const base = { leakClean: true, days: 1000, tNet: 2.0, beats: true, vsFadeMean: 0.001, vsHold48Mean: 0.001, firstHalf: 0.001, secondHalf: 0.002, bar: 1.981 };
    chk("decision: all hurdles -> PASS", decide(base) === "PASS");
    chk("decision: t 1.980 -> DID NOT PASS", decide({ ...base, tNet: 1.98 }) === "DID NOT PASS");
    chk("decision: shuffled p95 not beaten -> DID NOT PASS", decide({ ...base, beats: false }) === "DID NOT PASS");
    chk("decision: FADE not beaten (gap 0) -> DID NOT PASS", decide({ ...base, vsFadeMean: 0 }) === "DID NOT PASS");
    chk("decision: a half at 0 -> DID NOT PASS", decide({ ...base, firstHalf: 0 }) === "DID NOT PASS");
    chk("decision (amended): HOLD48 not beaten (gap 0, negative, or missing) -> DID NOT PASS", decide({ ...base, vsHold48Mean: 0 }) === "DID NOT PASS" && decide({ ...base, vsHold48Mean: null }) === "DID NOT PASS" && decide({ ...base, vsHold48Mean: -0.001 }) === "DID NOT PASS");
    chk("decision (amended): leak gate not clean -> exactly 'CANNOT MEASURE — amended leak gate not clean'", decide({ ...base, leakClean: false }) === "CANNOT MEASURE — amended leak gate not clean" && decide({ ...base, leakClean: undefined }) === "CANNOT MEASURE — amended leak gate not clean");
    chk("decision: leak not clean -> CANNOT MEASURE; 299 days -> CANNOT MEASURE; 300 measurable", decide({ ...base, leakClean: false }).startsWith("CANNOT MEASURE") && decide({ ...base, days: 299 }).startsWith("CANNOT MEASURE") && decide({ ...base, days: 300 }) === "PASS");
  }
  // ---- 10. shuffled labels: within-trade permutation, seeded
  {
    const r = mulberry32(3), tr = Array.from({ length: 50 }, () => ({ y: Uint8Array.from({ length: H_MAX }, () => (r() < 0.4 ? 1 : 0)) }));
    const A = permuteLabels(tr, mulberry32(77)), Bm = permuteLabels(tr, mulberry32(77)), Cm = permuteLabels(tr, mulberry32(78));
    const sum = (a) => a.reduce((s, v) => s + v, 0);
    chk("shuffle: each trade keeps its own label multiset; seeded = reproducible; a different seed differs; originals untouched", tr.every((x) => sum(A.get(x)) === sum(x.y)) && tr.every((x) => A.get(x).join() === Bm.get(x).join()) && tr.some((x) => A.get(x).join() !== Cm.get(x).join()) && tr.some((x) => A.get(x).join() !== x.y.join()));
  }
  // ---- 10b. amended leak gate aggregator (N16): known answers
  {
    const row = (a, b, c, d) => ({ gate: { LOGIT_tGross: a, GBM_tGross: b, LOGIT_minus_HOLD48_t: c, GBM_minus_HOLD48_t: d }, gapVsFADE: { LOGIT: { tDiff: 0 }, GBM: { tDiff: 0 } }, cells: { LOGIT: { tNet: -5 }, GBM: { tNet: -5 } }, HOLD48: { tGross: 0 } });
    const base = Array.from({ length: 20 }, (_, i) => row(-1 + i * 0.1, 0, 0, 0));        // median of LOGIT gross = mean of -0.1 and 0.0 = -0.05
    chk("leak gate: 20 quiet seeds -> clean; median computed over the 20 seeds", leakGate(base).clean === true && leakGate(base).statistics.LOGIT_tGross.median === -0.05, `(${leakGate(base).statistics.LOGIT_tGross.median})`);
    const neg = base.map(() => row(-3, -3, -3, -3));
    chk("leak gate is one-sided: every seed at t -3 -> clean (a negative edge is not a leak)", leakGate(neg).clean === true);
    const three = base.map((r, i) => (i < 3 ? row(2.5, 0, 0, 0) : r)), two = base.map((r, i) => (i < 2 ? row(2.5, 0, 0, 0) : r));
    chk("leak gate: 3 of 20 seeds above +2.0 -> NOT clean; 2 of 20 -> clean; exactly +2.0 is not 'above'", leakGate(three).clean === false && leakGate(two).clean === true && leakGate(base.map((r, i) => (i < 5 ? row(2.0, 0, 0, 0) : r))).clean === true);
    const medHi = base.map((r, i) => row(0, 0, i < 9 ? 0 : 1.2, 0)), medEq = base.map((r, i) => row(0, 0, i < 9 ? 0 : 1.0, 0));
    chk("leak gate: HOLD48-gap median +1.2 (> +1.0) -> NOT clean; median exactly +1.0 -> clean", leakGate(medHi).clean === false && leakGate(medEq).clean === true, `(${leakGate(medHi).statistics.LOGIT_minus_HOLD48_t.median})`);
    const unf = base.map((r, i) => (i < 3 ? row(0, Infinity, 0, 0) : r));
    chk("leak gate fails closed: 3 unformed t (+Infinity) -> NOT clean; gateValue(null) = +Inf, gateValue(null, allDaysZero) = 0; no seeds -> NOT clean", leakGate(unf).clean === false && gateValue(null) === Infinity && gateValue(null, true) === 0 && gateValue(1.5) === 1.5 && leakGate([]).clean === false);
  }
  // ---- 11. leak-test generator
  {
    const S = prep(W.mkSeries(rwBars(3000, 21, 0.05))), Sp = permuteSeries(S, mulberry32(5), true), Sl = permuteSeries(S, mulberry32(5), false);
    const rets = (X) => { const a = []; for (let i = X.first + 1; i < X.n; i++) if (X.has[i]) a.push(X.c[i] / X.lc[i - 1] - 1); return a; };
    const r0 = rets(S), rd = rets(Sp), rl = rets(Sl), m0 = mean(r0), s0 = [...r0].sort((a, b) => a - b), sl = [...rl].sort((a, b) => a - b), sd_ = [...rd].sort((a, b) => a - b);
    chk("leak generator (literal): the multiset of hourly returns and of no-trade hours is preserved", sl.length === s0.length && sl.every((v, i) => Math.abs(v - s0[i]) < 1e-12) && Sl.n === S.n && [...Sl.has].reduce((a, b) => a + b, 0) === [...S.has].reduce((a, b) => a + b, 0));
    chk("leak generator (demeaned): returns = original - mean, mean ~ 0, order differs, bars valid", sd_.every((v, i) => Math.abs(v - (s0[i] - m0)) < 1e-12) && Math.abs(mean(rd)) < 1e-15 && rd.some((v, i) => Math.abs(v - (r0[i] - m0)) > 1e-12) && [...Array(Sp.n).keys()].every((i) => !Sp.has[i] || (Sp.h[i] >= Math.max(Sp.o[i], Sp.c[i]) * (1 - 1e-12) && Sp.l[i] <= Math.min(Sp.o[i], Sp.c[i]) * (1 + 1e-12) && Sp.c[i] > 0)));
  }
  // ---- 12. end to end on synthetic coins over the full grid: shape, invariants, and the leak gate's power
  {
    const t1 = Date.now(), series = { BTC: synthCoin("BTC", 11), ETH: synthCoin("ETH", 22), SOL: synthCoin("SOL", 33), ONDO: synthCoin("ONDO", 44) };
    const C = core(series, { draws: 2, collect: true });
    const allLegs = C.oos.every((x) => { const L = C.wf.legs.get(x); return L && MODELS.every((m) => L[m].hold >= 1 && L[m].hold <= 48 && L[m].k === x.t + L[m].hold); });
    chk("pipeline: every out-of-sample trade has both legs, hold 1..48, exit at t+hold", allLegs && C.oos.length > 300, `(${C.oos.length} oos trades, ${C.cells.LOGIT.n} days)`);
    chk("pipeline: cells share days/trades; FADE == R307 exitsAt on the same series", C.cells.LOGIT.n === C.cells.GBM.n && C.cells.LOGIT.trades === C.fade.trades && C.oos.every((x) => { const e = W.exitsAt(series[x.coin], x.t).FADE; return e.k === x.fade.k && e.net === x.fade.net; }));
    chk("pipeline: every year trains only on windows closed before its start", C.years.every((yp) => yp.train.every((x) => x.windowClose < yp.Y0)));
    chk("pipeline: shuffled-label draws produce one mean per cell per draw", C.shuf.LOGIT.length === 2 && C.shuf.GBM.length === 2 && C.shuf.GBM.every((v) => Number.isFinite(v)));
    const out = assemble(C, { clean: true, note: "selftest" }, { note: "selftest first run" });
    const needOut = ["tNet", "meanNet", "n", "unit", "cell", "cells", "placebo", "halves", "vsFADE", "vsHOLD48", "leakTest", "leakTestFirstRun", "makerCost030", "btcEthOnly", "perYear", "calibration", "featureImportance", "verdictScript", "notes", "winRate"];
    chk("output: every field the seal script parses is present", needOut.every((k) => k in out) && MODELS.every((m) => ["tNet", "meanNet", "n", "trades", "winRate", "avgHoldHours"].every((k) => k in out.cells[m])) && ["p95", "observed", "beats", "draws"].every((k) => k in out.placebo) && ["first", "second"].every((k) => ["meanNet", "tNet", "days"].every((j) => j in out.halves[k])) && ["meanDiff", "tDiff", "days"].every((k) => k in out.vsFADE) && ["meanDiff", "tDiff", "days"].every((k) => k in out.vsHOLD48), `(missing ${needOut.filter((k) => !(k in out)).join(",") || "none"})`);
    chk("pipeline: HOLD48 stats on the same days/trades; one HOLD48 gap per cell over the same days", C.hold48.n === C.cells.LOGIT.n && C.hold48.trades === C.cells.LOGIT.trades && MODELS.every((m) => C.gap48[m].days === C.cells[m].n));
    const honest = leakSeed(series, { demean: true, seed: 5 }), leaky = leakSeed(series, { demean: true, seed: 5, featureFn: (S, R, t, h, o, off) => { featureRow(S, R, t, h, o, off); o[off] = labelOf(S, t, h); return o; } });
    const hs = honest.gate, ls = leaky.gate, fmt = (g) => JSON.stringify(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, f(v, 3) ?? String(v)])));
    chk("leak gate on martingale synthetic paths, honest features: all four gate t below +3.5 (sanity, one seed)", GATE_KEYS.every((k) => hs[k] < 3.5), `(${fmt(hs)})`);
    chk("leak gate has power: the label smuggled in as a feature -> gross t AND model-minus-HOLD48 t >= +2 on the seed, and the 20-seed gate is NOT clean", GATE_KEYS.every((k) => ls[k] >= 2) && leakGate(Array(20).fill(leaky)).clean === false, `(${fmt(ls)})`);
    console.log(`  (synthetic end-to-end ${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  }

  // ---- real data: R307 reproduction, truncate-the-future on real coins, feature coverage
  if (real) {
    const t2 = Date.now(), sr = series || loadReal();
    chk("real: all 32 coins load from the R307/R306 caches", COINS.every((c) => sr[c]), `(${Object.keys(sr).length})`);
    const T = buildTrades(sr), r7 = JSON.parse(fs.readFileSync(R307_OUT, "utf8"));
    const win = T.trades.filter((x) => x.day >= WIN0 && x.day <= WIN1), fs7 = fadeStats(win);
    chk("real: entries reproduce sealed R307 (entries incl. dropped, dropped, window trades, 2019-20 trades)", T.trades.length + T.dropped === r7.diagnostics.entriesAll && T.dropped === r7.diagnostics.entriesDroppedNoExit && win.length === r7.diagnostics.tradesWindow && T.trades.filter((x) => x.day < WIN0).length === r7.diagnostics.tradesDiscovery,
      `(${T.trades.length + T.dropped}/${r7.diagnostics.entriesAll}, ${T.dropped}, ${win.length}/${r7.diagnostics.tradesWindow})`);
    chk("real: FADE on the window trades == sealed R307 FADE cell (days, trades, mean, t)", fs7.n === r7.cells.FADE.n && fs7.trades === r7.cells.FADE.trades && f(fs7.meanNet, 6) === r7.cells.FADE.meanNet && f(fs7.tNet, 3) === r7.cells.FADE.tNet, `(${fs7.n} ${fs7.trades} ${f(fs7.meanNet, 6)} ${f(fs7.tNet, 3)})`);
    const rng = mulberry32(308); let diff = 0, probes = 0;
    for (const coin of ["BTC", "SOL", "DOGE", "XTZ"]) {
      const S = sr[coin], R = sr[REF_OF(coin)], tc = T.trades.filter((x) => x.coin === coin);
      for (let k = 0; k < 6 && tc.length; k++) {
        const x = tc[Math.floor(rng() * tc.length)], h = 1 + Math.floor(rng() * H_MAX), K = x.t + h; probes++;
        const A = x.X.subarray((h - 1) * P, h * P), Bt = featureRow(truncate(S, K), truncate(R, K), x.t, h);
        for (let j = 0; j < P; j++) if (!sameNum(A[j], Bt[j])) diff++;
      }
    }
    chk(`real: truncate-the-future on BTC/SOL/DOGE/XTZ trades — features unchanged when every bar > t+h (coin AND reference) is deleted (${probes} probes)`, diff === 0 && probes === 24, `(${diff} diffs)`);
    const nf = new Array(P).fill(0); let rows = 0; for (const x of T.trades) for (let i = 0; i < x.X.length; i++) { if (!Number.isFinite(x.X[i])) nf[i % P]++; if (i % P === 0) rows++; }
    console.log(`  real: ${rows} trade-hours; non-finite feature values ${JSON.stringify(Object.fromEntries(FEATS.map((n, i) => [n, nf[i]]).filter(([, v]) => v)))}`);
    chk("real: every feature finite on >= 99% of trade-hours", nf.every((v) => v / rows < 0.01));
    console.log(`  (real-data checks ${((Date.now() - t2) / 1000).toFixed(1)}s)`);
  }
  console.log(fail ? `SELFTEST FAILED (${fail})` : `SELFTEST PASSED (${((Date.now() - t00) / 1000).toFixed(1)}s)`);
  return fail === 0;
}

// ════════════════════════════════════════════════════════════════════════════════ LEAK (synthetic, before the read) — AMENDED (N16)
function sealed() { const s = fs.existsSync(D("read-seals.json")) ? JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")) : {}; return !!(s.tests && (s.tests[ID] || s.tests[ID.slice(1)])); }
const relOf = (p) => path.relative(path.join(__dirname, ".."), p).split(path.sep).join("/");
/** the first single-seed leak run (training/r308/leak-test.json): read-only history, identified by the archived script's sha256 */
function firstRunLeak() {
  if (!fs.existsSync(LEAK)) throw new Error(`the first leak run's file ${LEAK} is missing — it is kept as history and must not be removed`);
  const lk = JSON.parse(fs.readFileSync(LEAK, "utf8"));
  if (lk.scriptSha256 !== FIRST_LEAK_SHA || lk.clean !== false) throw new Error("training/r308/leak-test.json is not the recorded first run (sha256 / clean mismatch) — refusing");
  return lk;
}
/** N17: what the output file holds now — "none", "firstRun" (the superseded first-run CANNOT MEASURE, read never run) or "other" */
function outState(first) {
  if (!fs.existsSync(OUT)) return { state: "none" };
  const o = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const isFirst = !o.readAt && o.leakTest && o.leakTest.scriptSha256 === FIRST_LEAK_SHA && o.leakTest.ranAt === first.ranAt && typeof o.verdictScript === "string" && o.verdictScript.startsWith("CANNOT MEASURE — the synthetic leak test was not clean");
  return { state: isFirst ? "firstRun" : "other", out: o };
}
function firstRunRecord(first, prior) {
  const { literalDiagnostic, ...gate1 } = first;
  return { status: "SUPERSEDED by the registry's dated pre-evidence amendment of 2026-10-01 (amendments[0], field controls.leakTest) — kept as history, never gated again",
    file: relOf(LEAK), scriptArchive: "backend/data/training/r308/r308-crest-predictor.first-leak-run.js.txt (sha256 " + FIRST_LEAK_SHA + ")",
    ...gate1, literalDiagnostic,
    supersededOutput: prior && prior.state === "firstRun" ? { verdictScript: prior.out.verdictScript, asOf: prior.out.asOf, postHocDiagnostic: prior.out.leakSeedDiagnostic ? "backend/data/training/r308/leak-seed-diagnostic.json (12 seeds 308001 + 7777 s; not gated)" : null } : null };
}
const gateOut = (g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Number.isFinite(v) ? f(v, 3) : "+Infinity"]));
function leak() {
  if (sealed()) throw new Error(`${ID} is sealed — the leak gate belongs before the read`);
  const first = firstRunLeak(), prior = outState(first);
  if (prior.state === "other") throw new Error(`${ID}: the output file holds something other than the superseded first-run CANNOT MEASURE (${prior.out.verdictScript}) — the amended gate belongs before the read`);
  if (fs.existsSync(LEAK2)) throw new Error(`${ID}: the amended leak gate has already run once (${LEAK2}) — one run only`);
  const t0 = Date.now(), series = loadReal();
  console.log(`  loaded ${Object.keys(series).length} coins in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!selftest({ real: true, series })) throw new Error("selftest failed — no leak test");
  console.log(`AMENDED LEAK GATE (N16): ${LEAK_SEEDS.length} seeds ${LEAK_SEEDS[0]}..${LEAK_SEEDS[LEAK_SEEDS.length - 1]}, demeaned + permuted hourly returns per coin; a leak = a POSITIVE edge`);
  const rows = [];
  for (const seed of LEAK_SEEDS) {
    const r = leakSeed(series, { demean: true, seed }); rows.push(r);
    console.log(`  seed ${seed}: ${JSON.stringify(gateOut(r.gate))} | vsFADE L ${r.gapVsFADE.LOGIT.tDiff} G ${r.gapVsFADE.GBM.tDiff} | hold L ${r.cells.LOGIT.avgHoldHours}h G ${r.cells.GBM.avgHoldHours}h | ${r.seconds}s`);
  }
  const gate = leakGate(rows);
  for (const k of GATE_KEYS) { const g = gate.statistics[k]; console.log(`  ${k}: median ${g.median} (<= ${LEAK_MEDIAN_MAX}: ${g.medianOK}), seeds > +${LEAK_EXCEED_T}: ${g.seedsAbove2} (<= ${LEAK_EXCEED_MAX}: ${g.exceedOK}) -> ${g.pass ? "pass" : "FAIL"}`); }
  console.log("LEAK (reported only): literal permutation, NOT demeaned, seed " + LEAK_SEED);
  const literal = leakSeed(series, { demean: false, seed: LEAK_SEED });
  console.log("  literal " + JSON.stringify(gateOut(literal.gate)));
  const res = { id: ID, kind: "AMENDED synthetic leak gate (N16; registry controls.leakTest amended 2026-10-01, pre-evidence)", ranAt: new Date().toISOString(), scriptSha256: scriptSha(), clean: gate.clean,
    rule: REG.controls.leakTest, seeds: LEAK_SEEDS, coinSeed: "coin i uses seed + 1009 i", generator: "N13(a): each coin's hourly simple returns demeaned, hour-bars permuted as whole units, price rebuilt from the first candle",
    seedChoice: "308001 + s, s = 0..19: s = 0 is the first run's seed (kept, not dropped); s = 1..19 never run before; the post-hoc diagnostic's seeds (308001 + 7777 s) deliberately not reused",
    failClosed: "a t that cannot be formed counts as +Infinity, except a model-minus-HOLD48 gap that is exactly 0 on every day (= 0, flagged identicalToHOLD48)",
    statistics: gate.statistics, limits: gate.limits, reportedOnly: gate.reportedOnly, seedsRun: gate.seeds,
    perSeed: rows.map((r) => ({ ...r, gate: gateOut(r.gate) })),
    literalDiagnostic: { note: "literal reading (returns permuted, NOT demeaned), seed 308001 — reported, never gated", ...literal, gate: gateOut(literal.gate) },
    supersedes: { file: relOf(LEAK), ranAt: first.ranAt, scriptSha256: first.scriptSha256, clean: first.clean, gateStatistics: first.gateStatistics, note: "single-seed two-sided |t| < 2 gate; failed on the NEGATIVE side; superseded by the 2026-10-01 pre-evidence amendment" } };
  fs.mkdirSync(WORK, { recursive: true }); writeJsonAtomic(LEAK2, res);
  console.log(`${ID} amended leak gate: ${gate.clean ? "CLEAN" : "NOT CLEAN"} — wrote ${LEAK2}`);
  if (gate.clean) { console.log(`  the read is now permitted once: node backend/r308-crest-predictor.js --read`); return; }
  const failing = GATE_KEYS.filter((k) => !gate.statistics[k].pass), nc = null, NR = "not computed — the real read was not run (amended leak gate not clean)";
  const out = { id: ID, name: REG.name, asOf: new Date().toISOString(), script: "backend/r308-crest-predictor.js", scriptSha256: res.scriptSha256, statistic: REG.statistic, unit: "days", window: `${WIN0}..${WIN1} (out of sample, walk-forward by year)`,
    tNet: nc, meanNet: nc, n: 0, cell: nc, winRate: nc, trades: 0, bar: { tRequired: BAR, variants: REG.bar.variants, source: REG.bar.source },
    cells: Object.fromEntries(MODELS.map((m) => [m, { tNet: nc, meanNet: nc, n: 0, trades: 0, winRate: nc, avgHoldHours: nc }])),
    placebo: { p95: nc, observed: nc, beats: nc, draws: 0, note: NR }, halves: { first: { meanNet: nc, tNet: nc, days: 0 }, second: { meanNet: nc, tNet: nc, days: 0 }, note: NR },
    vsFADE: { meanDiff: nc, tDiff: nc, days: 0, note: NR }, vsHOLD48: { meanDiff: nc, tDiff: nc, days: 0, note: NR },
    leakTest: res, leakTestFirstRun: firstRunRecord(first, prior),
    makerCost030: Object.fromEntries(MODELS.map((m) => [m, { tNet: nc, meanNet: nc }])), btcEthOnly: { note: NR }, perYear: { note: NR }, calibration: { note: NR }, featureImportance: { note: NR },
    verdictScript: "CANNOT MEASURE — amended leak gate not clean",
    notes: [`The amended 20-seed leak gate (N16) failed on: ${failing.map((k) => `${k} median ${gate.statistics[k].median}, ${gate.statistics[k].seedsAbove2} of ${gate.seeds} seeds > +${LEAK_EXCEED_T}`).join("; ")} (limits: median <= +${LEAK_MEDIAN_MAX}, at most ${LEAK_EXCEED_MAX} seeds > +${LEAK_EXCEED_T}). Per the amended registration the read is CANNOT MEASURE; the real data was never scored by the models.`,
      "The first single-seed run (training/r308/leak-test.json, leakTestFirstRun) is superseded by the 2026-10-01 pre-evidence amendment and kept as history.",
      "Research only; no orders."] };
  writeJsonAtomic(OUT, out); console.log(`${ID}: ${out.verdictScript}\n  wrote ${OUT}`);
}

// ════════════════════════════════════════════════════════════════════════════════ READ (once, under the amended gate — N17)
function read() {
  if (sealed()) throw new Error(`${ID} is sealed — read-once`);
  const first = firstRunLeak(), prior = outState(first);
  if (prior.state === "other") throw new Error(`${ID} already read (or the amended gate wrote CANNOT MEASURE) — read-once: ${prior.out.verdictScript}`);
  if (!fs.existsSync(LEAK2)) throw new Error("no amended leak-gate file — run --leak first");
  const lk = JSON.parse(fs.readFileSync(LEAK2, "utf8")), sha = scriptSha();
  if (lk.scriptSha256 !== sha) throw new Error("the amended leak gate was run by a different version of this script — no read");
  if (lk.clean !== true) throw new Error("the amended leak gate was not clean — the verdict is CANNOT MEASURE (written by --leak)");
  const t0 = Date.now(), series = loadReal();
  console.log(`  loaded ${Object.keys(series).length} coins in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!selftest({ real: true, series })) throw new Error("selftest failed — no read");
  const C = core(series, { draws: SHUF_DRAWS, seed: SEED, collect: true, log: console.log });
  if (!C.years.every((yp) => yp.train.every((x) => x.windowClose < yp.Y0))) throw new Error("walk-forward invariant broken — no write");
  if (fs.existsSync(OUT) && outState(first).state !== prior.state) throw new Error("the output file changed during the read — no write");
  const out = assemble(C, lk, firstRunRecord(first, prior)); out.readAt = new Date().toISOString();
  out.readOnce = { readAt: out.readAt, governedBy: "registry controls.leakTest / decisionRule.pass as amended 2026-10-01 (pre-evidence)", amendedLeakGate: { file: relOf(LEAK2), ranAt: lk.ranAt, clean: lk.clean, scriptSha256: lk.scriptSha256 },
    supersedes: prior.state === "firstRun" ? `the first single-seed leak run's CANNOT MEASURE output (asOf ${prior.out.asOf}) — superseded by the amendment; this is the one real read` : "no prior output", priorOutputState: prior.state };
  writeJsonAtomic(OUT, out);
  const pc = (x) => (x == null ? "n/a" : (100 * x).toFixed(3) + "%");
  console.log(`${ID}: ${out.verdictScript}`);
  for (const m of MODELS) { const s = out.cells[m]; console.log(`  ${m}: days ${s.n} trades ${s.trades} meanNet ${pc(s.meanNet)}/day win ${s.winRate} hold ${s.avgHoldHours}h | t net ${s.tNet} (gross ${s.tGross}) | shuffled p95 ${pc(out.placebo.byCell[m].p95)} beats=${out.placebo.byCell[m].beats} | vs FADE ${pc(out.vsFADE.byCell[m].meanDiff)} t ${out.vsFADE.byCell[m].tDiff} | vs HOLD48 ${pc(out.vsHOLD48.byCell[m].meanDiff)} t ${out.vsHOLD48.byCell[m].tDiff}`); }
  console.log(`  FADE same trades: meanNet ${pc(out.reference.FADE.meanNet)} t ${out.reference.FADE.tNet}; HOLD48 meanNet ${pc(out.reference.HOLD48.meanNet)} t ${out.reference.HOLD48.tNet}; better ${out.cell} t ${out.tNet} vs bar ${BAR}; halves ${pc(out.halves.first.meanNet)} | ${pc(out.halves.second.meanNet)}`);
  console.log("  wrote " + OUT);
}

// ════════════════════════════════════════════════════════════════════════════════ MAIN
if (require.main === module) {
  try {
    if (mode === "--selftest") process.exit(selftest({ real: !process.argv.includes("--synthetic") }) ? 0 : 1);
    if (mode === "--leak") leak();
    if (mode === "--read") read();
  } catch (e) { console.error(`${ID} FAILED:`, e.stack || e.message); process.exit(1); }
}

module.exports = { featureRow, labelOf, buildTrades, prepareYears, fitLogit, predictLogit, fitGBM, predictGBM, policyLeg, walkForward, permuteSeries, leakSeed, leakGate, core, decide, FEATS };
