#!/usr/bin/env node
/**
 * TRAIDS — SKIP-FILTER MONITOR (2026-07-23, user: "run the skip filter every 100 and
 * monitor its progress")
 *
 * NON-ACTIONABLE TELEMETRY. The pre-registered ADJUDICATION run is unchanged: GBM on the
 * observers at n≥2000 clean settles, nested CV, day-clustered OOS decile spread, skip-role
 * only, adoption ONLY via the approval queue. This monitor retrains a light version of the
 * same model at every 100-settle boundary and records the LEARNING CURVE — is out-of-sample
 * separation growing as the sample grows? It writes no rules, gates no trades, and its
 * numbers at small n are expected to be noise: THE CURVE IS THE SIGNAL, not any one point.
 *
 * Model: gradient-boosted depth-2 regression trees on obs.* features → E[R].
 * Validation: chronological day split (first 60% of DAYS train, last 40% test) — the
 * monitor's split is simpler than the adjudication run's nested CV, stated plainly.
 * Metrics: OOS decile spread (top−bottom predicted E[R]), OOS corr(pred, R), and the
 * skip simulation (drop the worst-predicted 20%: expectancy of kept vs all).
 *
 * Gating: runs only when clean-settle count has crossed a new 100 boundary since the
 * last recorded run (history in backend/data/skip-filter-progress.json). Scheduled daily;
 * self-gates to ~every 2-3 days at current fill rate.
 *
 * ONE ROW PER TICKET (2026-10-16). The ledger read below summed ROWS. Six R21 weekly wings have TWO rows
 * under ONE ticket id (loss-cap close voided for evidence, restored on the board under the same id,
 * settled at expiry by a prepend that left the voided row in place), and they carry obs, so each entered
 * this monitor's training sample TWICE: the target y, the day-level mean R and the learning curve all
 * counted them twice, and the 100-boundary gate counted rows rather than tickets and so could trip early.
 * The read now collapses to one row per ticket (lib/ticket-rows.js) before any filter. No-op on a ledger
 * where no ticket id appears twice.
 *   THIS IS TELEMETRY, NOT THE ADJUDICATION. The pre-registered adjudication run (n>=2000 clean settles,
 *   nested CV) is a different script and is NOT touched here; no rule, bar, population definition or read
 *   condition of it changes. Collapsing can only LOWER n, so the gate stays conservative: a boundary
 *   already recorded in skip-filter-progress.json is not re-run.
 *
 * Usage: node backend/skip-filter-monitor.js [--force]
 */
const fs = require("fs"), path = require("path");
const { collapseByTicket, collapseLine } = require("./lib/ticket-rows.js");
const LOG_PATH = path.join(__dirname, "data", "trade_log.json");
const PROG_PATH = path.join(__dirname, "data", "skip-filter-progress.json");
const CLEAN_EPOCH = new Date("2026-07-20T00:00:00-06:00").getTime();
// ── TWO-TIER OBSERVER DESIGN (2026-07-24 audit fix) ──────────────────────────
// The audit found 11 of 29 observers are DAY-CONSTANT: one market-wide value per scan day.
// Feeding them to a trade-level tree is a statistical trap — they cannot discriminate
// between two trades on the same day, so the only thing a split on them can learn is
// "that day was bad", i.e. day memorization. And their true sample size is DAYS: at
// n=2000 trades ≈ 50 sessions they carry ~50 observations each, not 2000, while inflating
// the apparent feature count 29-wide and the multiplicity burden with it.
//
//   TIER A — trade-level model: only features that vary BETWEEN trades within a day.
//            Validated on a day-grouped chronological split (no day spans train and test).
//   TIER B — day-level assessment: the macro block regressed against DAY-mean outcomes,
//            n = sessions, reported with its honest day-count. A day-level feature can
//            only ever earn a DAY filter ("sit this session out"), never a per-trade score.
//
// Both tiers stay logged either way; this decides what each is allowed to conclude.
// FEATURE-PARITY REPAIR (2026-08-31): feature-parity-audit.js found 68 of 81 stamped
// observers never reaching ANY learner. Of the ones ready to train on now (finite on >=15%
// of stamped tickets), 9 are trade-level and genuinely absent from this list: stochCrossAge,
// stampLagMin, macroDaysOut, bidAtEntry, askAtEntry, spreadBps, fillVsMidBps, insiderXP,
// skewRR. Added below. Three more that were ready by coverage (newsN, newsPos, newsNeg) are
// held OUT per data/vintage-quarantine.json — the 2026-08-27 news-stamp backfill priced them
// at first-available-bar for pre-existing open tickets, which fakes an edge on exactly this
// kind of fit; VQ_GUARD below is a second, defensive check so a future TRADE_KEYS edit can
// never silently reintroduce them. The remaining ~23 stamped-but-unwired observers are BELOW
// the 15% coverage floor (feature-parity.json stampedNeverTrained.needsBackfill) and are
// deliberately NOT added here — they are the honest backfill queue, not a straight add; wiring
// a near-empty column into a boosted tree in the name of "parity" would just be noise with a
// good conscience. This is a plumbing change only: same model, same validation, same n>=2000
// gate, same everything except which named columns of obs.* it is allowed to look at.
const TRADE_KEYS = ["regimeAlign", "momPctile", "revRet5", "squeeze", "rvol", "erDays", "sigAge", "shortPct", "svrZ", "newsScore", "sectorRS", "atsPct", "insiderNet90", "prevMove", "gapPct", "erSince", "erSurp", "stochCrossAge", "stampLagMin", "macroDaysOut", "bidAtEntry", "askAtEntry", "spreadBps", "fillVsMidBps", "insiderXP", "skewRR"];
// VINTAGE QUARANTINE GUARD, same pattern as weighted-board.js buildContributors(). Belt-and-
// suspenders: even if a quarantined key is ever added to TRADE_KEYS above by mistake, it is
// stripped here before admission, never silently — the run says so.
// 2026-09-29 (operator "go 1-3"): the board guard's post-entry floor (lib/feature-manifest.js) is merged in, so stampLagMin and
// macroDaysOut (news-stamp.js writes them after entry) are quarantined before the n>=2000 adjudication, same list as the bake-off learners.
const FM_BANNED = require("./lib/feature-manifest.js").boardObsBanned();
const VQ_KEYS = (() => {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "vintage-quarantine.json"), "utf8"));
    const fe = q.featureEligibility || {};
    const out = /QUARANTINED/i.test(String(fe.status)) ? new Set(fe.keys || []) : new Set();
    for (const x of FM_BANNED) out.add(x); return out;
  } catch { return new Set(FM_BANNED); }
})();
const DAY_KEYS = ["vix", "oil20", "gold20", "btc20", "polNews", "polSent", "econNews", "econSent", "y10", "y10chg20", "curve", "sbCorr"];
const OBS_KEYS = [...TRADE_KEYS, ...DAY_KEYS];   // full roster, for coverage reporting only
const MIN_DAYS_FOR_DAY_TIER = 20;                // below this, the day tier reports "insufficient"
const MIN_TEST_DAYS = 3;                         // a 1-session OOS block is day variation, not a reading

const day = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

// ── tiny gradient boosting: depth-2 regression trees, squared loss ──
function bestSplit(X, y, idx, feat) {
  const pairs = idx.filter(i => Number.isFinite(X[i][feat])).map(i => [X[i][feat], y[i]]).sort((a, b) => a[0] - b[0]);
  if (pairs.length < 20) return null;
  let sumR = pairs.reduce((s, p) => s + p[1], 0), sumL = 0, nL = 0;
  let best = null;
  for (let i = 0; i < pairs.length - 10; i++) {
    sumL += pairs[i][1]; sumR -= pairs[i][1]; nL++;
    if (i < 9 || pairs[i][0] === pairs[i + 1][0]) continue;
    const nR = pairs.length - nL;
    const gain = (sumL * sumL) / nL + (sumR * sumR) / nR;
    if (!best || gain > best.gain) best = { gain, thr: (pairs[i][0] + pairs[i + 1][0]) / 2 };
  }
  return best;
}
function buildTree(X, y, idx, depth) {
  const node = { val: mean(idx.map(i => y[i])) || 0 };
  if (depth === 0 || idx.length < 40) return node;
  let best = null;
  for (let f = 0; f < X[0].length; f++) {
    const s = bestSplit(X, y, idx, f);
    if (s && (!best || s.gain > best.gain)) best = { ...s, feat: f };
  }
  if (!best) return node;
  const L = idx.filter(i => Number.isFinite(X[i][best.feat]) && X[i][best.feat] <= best.thr);
  const R = idx.filter(i => Number.isFinite(X[i][best.feat]) && X[i][best.feat] > best.thr);
  const M = idx.filter(i => !Number.isFinite(X[i][best.feat]));         // missing → parent value
  if (L.length < 15 || R.length < 15) return node;
  node.feat = best.feat; node.thr = best.thr;
  node.left = buildTree(X, y, L, depth - 1);
  node.right = buildTree(X, y, R, depth - 1);
  node.missVal = mean(M.map(i => y[i])) ?? node.val;
  return node;
}
const treePredict = (node, x) => {
  if (node.feat == null) return node.val;
  const v = x[node.feat];
  if (!Number.isFinite(v)) return node.missVal ?? node.val;
  return treePredict(v <= node.thr ? node.left : node.right, x);
};
function gbm(X, y, idx, rounds = 80, lr = 0.1) {
  const base = mean(idx.map(i => y[i])) || 0;
  const trees = [];
  const resid = y.slice();
  for (const i of idx) resid[i] = y[i] - base;
  for (let r = 0; r < rounds; r++) {
    const t = buildTree(X, resid, idx, 2);
    if (t.feat == null) break;
    trees.push(t);
    for (const i of idx) resid[i] -= lr * treePredict(t, X[i]);
  }
  const predict = (x) => base + trees.reduce((s, t) => s + lr * treePredict(t, x), 0);
  predict.model = { base, lr, trees };                 // serializable — the shadow board scores with this
  return predict;
}

(function main() {
  const force = process.argv.includes("--force");
  let rowsInFile = []; try { rowsInFile = JSON.parse(fs.readFileSync(LOG_PATH, "utf8")); } catch {}
  // one row per ticket id, before any filter (2026-10-16): a ticket closed twice is one training row
  const collapse = collapseByTicket(rowsInFile);
  const log = collapse.rows;
  // Overnight-bucket rows (entry stamped outside 09:25–16:00 ET) are a DIFFERENT experiment
  // — tracked in the ledger, excluded from the skip-filter sample so the training horizon
  // stays homogeneous. Derived from the entry timestamp, same rule as /api/intelligence.
  const isOvernight = (t) => {
    const o = t.openedAt || 0; if (!o) return false;
    const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(o));
    return hm < "09:25" || hm >= "16:00";
  };
  const allClean = log.filter(t => t && t.closedAt >= CLEAN_EPOCH && Number.isFinite(t.rMult) && t.obs && !t.ctrl);
  const clean = allClean.filter(t => !isOvernight(t));
  const nOnx = allClean.length - clean.length;
  if (nOnx) console.log(`  (${nOnx} overnight-bucket settles excluded from the training sample — different horizon)`);
  const n = clean.length;
  let hist = []; try { hist = JSON.parse(fs.readFileSync(PROG_PATH, "utf8")); } catch {}
  const lastN = hist.length ? hist[hist.length - 1].n : 0;
  console.log(`\n  TRAIDS — SKIP-FILTER MONITOR · non-actionable learning-curve telemetry`);
  console.log(`  ledger: ${rowsInFile.length} rows · ${collapseLine(collapse)}`);
  console.log(`  clean signal settles with observers: ${n} TICKETS · last monitored at n=${lastN} · adjudication stays at n≥2000\n`);
  if (!force && Math.floor(n / 100) <= Math.floor(lastN / 100)) {
    console.log(`  Not at a new 100-boundary yet (next run at n=${(Math.floor(lastN / 100) + 1) * 100}). Nothing to do.\n`);
    return;
  }
  if (n < 100) { console.log("  Under 100 settles — first run fires at n=100.\n"); return; }

  clean.sort((a, b) => a.closedAt - b.closedAt);
  const y = clean.map(t => t.rMult);
  const days = [...new Set(clean.map(t => day(t.closedAt)))];

  // TIER A feature screen: a declared trade-level feature is only ADMITTED if it actually
  // varies within at least one day in THIS sample. Thin new observers (all their data on
  // one session) are functionally day dummies right now, and a tree splitting on one would
  // memorize that day — so they sit out until they have within-day spread. Self-checking,
  // per run, printed.
  const variesWithinADay = (k) => {
    const byDay = {};
    for (const t of clean) { const v = t.obs?.[k]; if (Number.isFinite(v)) (byDay[day(t.closedAt)] ||= new Set()).add(v); }
    return Object.values(byDay).some(s => s.size > 1);
  };
  const admitted = TRADE_KEYS.filter(k => !VQ_KEYS.has(k) && variesWithinADay(k));
  const quarantined = TRADE_KEYS.filter(k => VQ_KEYS.has(k));
  const benched = TRADE_KEYS.filter(k => !admitted.includes(k) && !quarantined.includes(k));
  console.log(`  TIER A (trade-level model): ${admitted.length} of ${TRADE_KEYS.length} declared trade features admitted`);
  if (benched.length) console.log(`    benched this run (no within-day variation yet — would act as day dummies): ${benched.join(", ")}`);
  if (quarantined.length) console.log(`    VINTAGE QUARANTINED — never admitted regardless of coverage (data/vintage-quarantine.json): ${quarantined.join(", ")}`);
  console.log(`  TIER B (day-level block): ${DAY_KEYS.length} market-wide features held out of the tree entirely — assessed against DAY means below.\n`);
  if (!admitted.length) { console.log("  No admissible trade-level features yet.\n"); return; }

  const X = clean.map(t => admitted.map(k => (t.obs && Number.isFinite(t.obs[k])) ? t.obs[k] : NaN));
  const cutDay = days[Math.floor(days.length * 0.6)];
  const trainIdx = [], testIdx = [];
  clean.forEach((t, i) => (day(t.closedAt) <= cutDay ? trainIdx : testIdx).push(i));
  if (testIdx.length < 25) { console.log("  OOS partition under 25 trades — too early for even a noisy read.\n"); return; }

  const predict = gbm(X, y, trainIdx);
  const preds = testIdx.map(i => ({ p: predict(X[i]), r: y[i] }));
  preds.sort((a, b) => a.p - b.p);
  const dec = Math.max(3, Math.floor(preds.length / 10));
  const bottom = preds.slice(0, dec), top = preds.slice(-dec);
  const spread = mean(top.map(x => x.r)) - mean(bottom.map(x => x.r));
  const mp = mean(preds.map(x => x.p)), mr = mean(preds.map(x => x.r));
  let num = 0, dp = 0, dr = 0;
  for (const x of preds) { num += (x.p - mp) * (x.r - mr); dp += (x.p - mp) ** 2; dr += (x.r - mr) ** 2; }
  const corr = dp > 0 && dr > 0 ? num / Math.sqrt(dp * dr) : 0;
  const skipN = Math.floor(preds.length * 0.2);
  const kept = preds.slice(skipN);
  const allExp = mean(preds.map(x => x.r)), keptExp = mean(kept.map(x => x.r));

  const row = { ts: Date.now(), date: day(Date.now()), n, trainN: trainIdx.length, testN: testIdx.length,
    testDays: days.length - days.indexOf(cutDay) - 1,
    oosDecileSpread: +spread.toFixed(4), oosCorr: +corr.toFixed(4),
    allExp: +allExp.toFixed(4), keptExp: +keptExp.toFixed(4), skipDelta: +(keptExp - allExp).toFixed(4) };
  // IDEMPOTENT HISTORY (fix 2026-07-24): --force reruns were APPENDING duplicate rows for the
  // same n, which would fake a longer learning curve than the data supports. One row per n,
  // last write wins — so re-running is always safe and the curve length equals real progress.
  hist = hist.filter(h => h.n !== row.n);
  hist.push(row);
  hist.sort((a, b) => a.n - b.n);
  fs.writeFileSync(PROG_PATH, JSON.stringify(hist, null, 1));

  // SHADOW-BOARD MODEL EXPORT (2026-07-24, user: "prelim intelligence board… monitor as we
  // gain data"). Persist this training's model so the scan can SCORE each new trade at
  // track time — predictions recorded BEFORE outcomes, version-stamped, building a live
  // forward record of the intelligence itself. THE GUARDRAILS: the score is stored as
  // obs.modelScore but is NEVER a training feature (OBS_KEYS controls features and
  // excludes it — no circularity); the shadow board alters NO trades; adjudication for
  // any rule change remains the pre-registered n≥2000 run via the approval queue.
  // `features` is the ADMITTED trade-level set — so the scoring endpoint (which reads this
  // list) can never score on a day-level feature, and the shadow board inherits Tier A's
  // discipline automatically.
  fs.writeFileSync(path.join(__dirname, "data", "skip-filter-model.json"),
    JSON.stringify({ version: hist.length, trainedAt: Date.now(), date: row.date, n, features: admitted, benched, dayFeatures: DAY_KEYS, model: predict.model }));
  console.log(`  model v${hist.length} exported for the shadow board — trained on ${admitted.length} trade-level features (day-level block excluded by design).`);

  console.log("  LEARNING CURVE (every ~100 settles · OOS = the last 40% of SESSIONS):");
  console.log("  date            n   train/test  OOS days   decile spread   corr   skip Δ   status");
  console.log("  " + "-".repeat(100));
  const fmtS = (v, w, d = 4) => ((v >= 0 ? "+" : "") + v.toFixed(d)).padStart(w);
  for (const h of hist) {
    // A single-session OOS is not a reading — it measures how ONE day happened to go, and a
    // decile spread computed from ~4 trades per decile swings wildly for free. Rows are kept
    // (data is data) but labeled, so no version's lucky day can pose as the model learning.
    const status = (h.testDays ?? 0) < MIN_TEST_DAYS ? `⚠ ${h.testDays ?? "?"}-session OOS — day variation, NOT a reading` : "readable";
    console.log(`  ${h.date}${String(h.n).padStart(6)}   ${String(h.trainN).padStart(5)}/${String(h.testN).padEnd(5)}${String(h.testDays ?? "?").padStart(7)}   ${fmtS(h.oosDecileSpread, 13)}${fmtS(h.oosCorr, 8, 3)}${fmtS(h.skipDelta, 9)}   ${status}`);
  }
  const latest = hist[hist.length - 1];
  if ((latest.testDays ?? 0) < MIN_TEST_DAYS) {
    console.log(`\n  ⚠ DO NOT READ THE LATEST ROW AS PROGRESS. Its out-of-sample block is ${latest.testDays} session(s):`);
    console.log(`    ~${Math.max(1, Math.floor(latest.testN / 10))} trades per decile, all sharing one day's market. A spread of ±0.5R is`);
    console.log(`    ordinary noise at that size, and it says nothing about whether the observers condition`);
    console.log(`    outcomes. The OOS block is the last 40% of sessions, so the curve becomes readable once`);
    console.log(`    the clean era has ~${Math.ceil(MIN_TEST_DAYS / 0.4)}+ sessions (${MIN_TEST_DAYS} of them out-of-sample) — roughly two more weeks.`);
  }
  console.log(`\n  READ: a REAL conditioning signal shows decile spread + skip Δ GROWING with n and staying`);
  console.log(`  positive ACROSS MULTIPLE OOS SESSIONS. Flat/sign-flipping = no signal yet (expected at`);
  console.log(`  n<500). NOTHING here changes a rule — adjudication is the pre-registered n≥2000 run.`);

  // ── TIER B — DAY-LEVEL BLOCK ────────────────────────────────────────────────
  // Each market-wide observer against the DAY's mean outcome, n = SESSIONS. This is the
  // only level at which these features have a real sample size, and the only role they can
  // earn is a day filter ("sit this session out"), decided at the adjudication — never a
  // per-trade score. Leave-one-day-out is the validation once n_days clears the bar.
  const dayRows = days.map(d => {
    const T = clean.filter(t => day(t.closedAt) === d);
    const row = { d, n: T.length, meanR: mean(T.map(t => t.rMult)) };
    for (const k of DAY_KEYS) { const v = T.map(t => t.obs?.[k]).find(Number.isFinite); row[k] = Number.isFinite(v) ? v : null; }
    return row;
  });
  console.log(`  TIER B — DAY-LEVEL ASSESSMENT (n = ${dayRows.length} session${dayRows.length === 1 ? "" : "s"}, NOT ${n} trades — this is the honest sample size for these features)`);
  console.log(`  observer        days   corr(feature, day mean R)   verdict`);
  console.log("  " + "-".repeat(78));
  for (const k of DAY_KEYS) {
    const pts = dayRows.filter(r => Number.isFinite(r[k]) && Number.isFinite(r.meanR));
    if (pts.length < 3) { console.log(`  ${k.padEnd(14)}${String(pts.length).padStart(5)}   ${"—".padStart(23)}   insufficient (need ${MIN_DAYS_FOR_DAY_TIER}+ sessions)`); continue; }
    const mx = mean(pts.map(r => r[k])), my = mean(pts.map(r => r.meanR));
    let num = 0, dx = 0, dy = 0;
    for (const r of pts) { num += (r[k] - mx) * (r.meanR - my); dx += (r[k] - mx) ** 2; dy += (r.meanR - my) ** 2; }
    const c = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
    const verdict = pts.length < MIN_DAYS_FOR_DAY_TIER ? `too few sessions (${pts.length}/${MIN_DAYS_FOR_DAY_TIER}) — noise by construction`
      : Math.abs(c) > 0.5 ? "candidate day-filter — needs leave-one-day-out + multiplicity ×12" : "no day-level relationship";
    console.log(`  ${k.padEnd(14)}${String(pts.length).padStart(5)}   ${((c >= 0 ? "+" : "") + c.toFixed(3)).padStart(23)}   ${verdict}`);
  }
  console.log(`\n  WHY THIS TIER EXISTS: these ${DAY_KEYS.length} features are constant within a session, so a`);
  console.log(`  trade-level tree can only use them to memorize days — and their true n is sessions, not`);
  console.log(`  trades (~50 by the n=2000 milestone, not 2000). Correlations above are printed for`);
  console.log(`  transparency and mean NOTHING until ${MIN_DAYS_FOR_DAY_TIER}+ sessions; the day tier is then judged with`);
  console.log(`  leave-one-day-out CV and Bonferroni across all ${DAY_KEYS.length}. Registered in the adjudication spec.\n`);
})();
