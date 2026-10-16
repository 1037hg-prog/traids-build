#!/usr/bin/env node
/**
 * OBSERVER SIGNAL SCREEN — do any of the stamped observers separate winners from losers?
 * 2026-08-29. Writes data/observer-signal-screen.json.
 *
 * WHY THIS, NOW.
 *
 * feature-parity-audit found 68 of 81 stamped observers have never reached a learner. The 5-year
 * model (#39) returned NO-SKILL on NINETEEN features, every one a price/volume technical — the
 * most picked-over data in finance, where zero is the expected result rather than a finding. And
 * the standing cross-tab on this board is stark: PRICE-PATTERN hypotheses have gone 0-for-35 while
 * STRUCTURAL ones — those naming a counterparty with a motive to pay — went 12-for-12.
 *
 * So the untested ground is not another price feature. It is the structural observers this board
 * has been stamping for months and has never once asked a question of: insider percentile, options
 * skew, short interest, dark-pool share, earnings surprise, measured spread.
 *
 * ═══ THIS IS A SCREEN, NOT A RESULT ═══
 *
 * It tests MANY observers at once, which is a search, and a search buys false positives at a known
 * rate. Everything here is therefore reported under three constraints:
 *
 *   1. EVERY observer tested is reported, winners and losers alike. Reporting only what survived
 *      is how a screen becomes a lie.
 *   2. The bar is BEST-OF-N from lib/null-bar.js at the ACTUAL number screened, never the naive
 *      t >= 2. With ~40 observers the honest bar is far above 2.
 *   3. SESSIONS are the unit. Tickets inside a session share that session's tape and are one
 *      observation of it. Effective N here is 26, not 1,038, whatever the ticket count says.
 *
 * Nothing that clears here is an edge. It is a CANDIDATE, and a candidate becomes evidence only by
 * being registered with a frozen rule and read forward at its own bar. The 18-of-20 curve-fit
 * graveyard in the strategy lab is what happens when a screen result is traded directly.
 *
 * ═══ WHAT IT REFUSES TO TEST ═══
 *
 *   - Model outputs (modelScore, bakeoffRidge, bakeoffGbm, wComposite): training a screen on
 *     another model's score is leakage wearing a feature's clothes.
 *   - News DIRECTION fields (newsAvg/newsPos/newsNeg/newsScore): R13 measured the naive sign
 *     running significantly AGAINST at scale — 21,254 events, net -0.708pp, t -5.856. Coverage
 *     and source diversity are admissible; direction is not.
 *   - Anything with fewer than MIN_ROWS finite values or fewer than MIN_SESSIONS sessions. A
 *     observer stamped on 20 tickets cannot answer this question and is listed as UNTESTABLE
 *     rather than given a number.
 *
 * Usage:  node backend/observer-signal-screen.js [--min-rows 120] [--min-sessions 8]
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const R = require("./lib/reconcile.js");
const D = (f) => path.join(__dirname, "data", f);

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const MIN_ROWS = arg("min-rows", 120), MIN_SESSIONS = arg("min-sessions", 8);

const FORBIDDEN = new Set(["modelScore", "bakeoffRidge", "bakeoffGbm", "wComposite",
  "newsAvg", "newsPos", "newsNeg", "newsScore", "newsRel", "newsIntensity"]);

let led;
try { led = R.cleanEraLedger(); R.assertReconciled("clean-era pooled edge", R.recomputeEdge(led), led.pooledEdgeR); }
catch (e) { console.error("RECONCILE FAILED — screening nothing: " + e.message); process.exit(1); }

const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 1 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };

const rows = led.signals.filter((t) => Number.isFinite(t.rMult) && t.obs);

// ---- which observers are testable ---------------------------------------------------------------
const cov = new Map();
for (const t of rows) for (const [k, v] of Object.entries(t.obs || {})) {
  if (FORBIDDEN.has(k) || !Number.isFinite(v)) continue;
  if (!cov.has(k)) cov.set(k, []);
  cov.get(k).push(t);
}
const testable = [], untestable = [];
for (const [k, ts] of cov) {
  const sessions = new Set(ts.map((t) => etDay(t.closedAt))).size;
  if (ts.length >= MIN_ROWS && sessions >= MIN_SESSIONS) testable.push({ k, ts, sessions });
  else untestable.push({ observer: k, rows: ts.length, sessions, why: ts.length < MIN_ROWS ? "under " + MIN_ROWS + " finite rows" : "under " + MIN_SESSIONS + " sessions" });
}
untestable.sort((a, b) => b.rows - a.rows);

// ---- the test: does the top half beat the bottom half, day-clustered? ----------------------------
const results = [];
for (const { k, ts, sessions } of testable) {
  const cut = med(ts.map((t) => t.obs[k]));
  const perDay = new Map();
  for (const t of ts) {
    const d = etDay(t.closedAt);
    if (!perDay.has(d)) perDay.set(d, { hi: [], lo: [] });
    (t.obs[k] > cut ? perDay.get(d).hi : perDay.get(d).lo).push(t.rMult);
  }
  // paired within the session: only sessions carrying BOTH arms can speak
  const diffs = [], paired = [];
  for (const [d, v] of perDay) if (v.hi.length && v.lo.length) { diffs.push(mean(v.hi) - mean(v.lo)); paired.push(d); }
  if (diffs.length < MIN_SESSIONS) { untestable.push({ observer: k, rows: ts.length, sessions, why: "only " + diffs.length + " sessions carry both arms" }); continue; }
  const hiAll = ts.filter((t) => t.obs[k] > cut), loAll = ts.filter((t) => t.obs[k] <= cut);
  results.push({
    observer: k, rows: ts.length, sessions, pairedSessions: diffs.length, splitAt: +cut.toFixed(4),
    meanRhigh: +mean(hiAll.map((t) => t.rMult)).toFixed(4),
    meanRlow: +mean(loAll.map((t) => t.rMult)).toFixed(4),
    gapR: +mean(diffs).toFixed(4),
    dayClusteredT: +tOf(diffs).toFixed(3),
    winHigh: +(100 * hiAll.filter((t) => t.pnl > 0).length / hiAll.length).toFixed(1),
    winLow: +(100 * loAll.filter((t) => t.pnl > 0).length / loAll.length).toFixed(1),
  });
}
results.sort((a, b) => Math.abs(b.dayClusteredT) - Math.abs(a.dayClusteredT));

// ---- the honest bar at the ACTUAL number screened -------------------------------------------------
let bar = null, barSource = "lib/null-bar.js unavailable — no honest bar computed, so nothing may be called a survivor";
try {
  const NB = require("./lib/null-bar.js");
  const fn = NB.nullBar || NB.default || NB;
  const n = results.length ? med(results.map((r) => r.pairedSessions)) : 20;
  const b = fn({ variants: results.length || 1, n: Math.round(n), trials: 20000 });
  bar = b && (b.bar || b.tRequired || b.p95) || null;
  barSource = "lib/null-bar.js nullBar({variants:" + results.length + ", n:" + Math.round(n) + ", trials:20000})";
} catch (e) { barSource += " (" + e.message.slice(0, 60) + ")"; }

const survivors = bar ? results.filter((r) => Math.abs(r.dayClusteredT) >= bar) : [];

const out = {
  spec: "observer-signal-screen-v1", asOf: new Date().toISOString(),
  status: "SCREEN — EXPLORATORY. Nothing here is evidence. A survivor is a CANDIDATE that becomes evidence only by being registered with a frozen rule and read forward at its own bar.",
  question: "Does any stamped observer separate winners from losers, when the board's own tickets are split at that observer's median within each session?",
  whyThisGround: "68 of 81 stamped observers have never reached a learner. #39's NO-SKILL verdict came from 19 price/volume technicals. On this board price-pattern hypotheses have gone 0-for-35 and structural ones 12-for-12.",
  unit: "SESSIONS, paired within the day. Effective N is " + (results.length ? med(results.map((r) => r.pairedSessions)) : 0) + " sessions, never the ticket count.",
  refused: { modelOutputs: "training on another model's score is leakage", newsDirection: "R13 measured the naive sign running against at scale (21,254 events, net -0.708pp, t -5.856)" },
  coverageFloor: { minRows: MIN_ROWS, minSessions: MIN_SESSIONS },
  observersScreened: results.length,
  multiplicity: { variantsSearched: results.length, bar, barSource,
    note: "Best-of-N at the ACTUAL number screened. The naive t>=2 is NOT the bar here and quoting it would be the error this file exists to avoid." },
  survivors, results, untestable,
};
writeJsonAtomic(D("observer-signal-screen.json"), out);

console.log("OBSERVER SIGNAL SCREEN — " + results.length + " observers screened over " + rows.length + " settled signal tickets");
console.log("  bar (best-of-" + results.length + "): " + (bar == null ? "UNAVAILABLE" : "|t| >= " + bar.toFixed(3)) + "   [" + barSource.slice(0, 60) + "]");
console.log("");
console.log("  observer            rows  sess   meanR hi   meanR lo      gap    day-t    win hi/lo");
for (const r of results.slice(0, 22)) {
  console.log("  " + r.observer.padEnd(20) + String(r.rows).padStart(5) + String(r.pairedSessions).padStart(6) +
    String(r.meanRhigh).padStart(11) + String(r.meanRlow).padStart(11) +
    String((r.gapR >= 0 ? "+" : "") + r.gapR).padStart(9) + String(r.dayClusteredT).padStart(9) +
    ("   " + r.winHigh + "% / " + r.winLow + "%").padEnd(16));
}
if (results.length > 22) console.log("  ... " + (results.length - 22) + " more in the JSON — ALL are reported, winners and losers alike");
console.log("\n  SURVIVORS at the best-of-" + results.length + " bar: " + (survivors.length ? survivors.map((s) => s.observer + " (t " + s.dayClusteredT + ")").join(", ") : "NONE"));
console.log("\n  " + untestable.length + " observer(s) UNTESTABLE on this sample (listed in the JSON with the reason).");
console.log("  Nothing here is evidence. A survivor is a candidate for registration, never a trade.");
console.log("written: data/observer-signal-screen.json");
