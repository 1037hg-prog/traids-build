#!/usr/bin/env node
/**
 * R343 Y1 — 10-year yield spike (>= 1.00 pt above its level 12 months earlier) -> next 6m / 12m total return of a constant-maturity
 * 10y, FRED DGS10 since 1962. Registered 2026-10-07 by backend/register-r339-r343.js; ONE pre-evidence amendment,
 * pre-build-2026-10-08 (backend/amend-r341-r343-pre-build.js): the bar at the registered minimum count, 2.479 -> 2.658.
 * THE REGISTRY ENTRY WINS — this file implements it and tunes nothing. At start-up registryChecks() asserts that every constant below
 * still appears verbatim in the registry text, and that the registry carries exactly the amendments this file implements.
 *
 *   node backend/r343-yield-spike-bonds.js --fetch       public data downloads only: FRED DGS10 + TB3MS CSV, Damodaran histretSP.html
 *        (the readCondition's known-answer source), into data/training/r343/. No broker endpoint, no order, no notification.
 *   node backend/r343-yield-spike-bonds.js --selftest    hand-built known answers + the registered CM10 known answer (Damodaran).
 *   node backend/r343-yield-spike-bonds.js --controls    OUTCOME-BLIND (N13): selftest, coverage, episode counts per cell (entry-time
 *        information only), no-look-ahead truncation test (real signals + donor paths), the scrambled-path null over the FULL pipeline
 *        and every registered gate (house leak test), a planted-edge positive control. Prints READY / NOT READY / CANNOT MEASURE and
 *        records it (code sha + data fingerprint) in data/r343-controls.json.
 *   node backend/r343-yield-spike-bonds.js --read        the ONE registered read. Refuses unless data/r343-controls.json says READY
 *        under THIS file's sha and the same data fingerprint, refuses if data/r343-read.json exists or R343 is sealed. Writes
 *        data/r343-read.json (docs/server/seal-gated.cjs fields + the $ table). Never seals.
 *   node backend/r343-yield-spike-bonds.js --read --cannot-measure
 *        OUTCOME-FREE: when --controls said CANNOT MEASURE for a REGISTERED reason only (CM10 known answer failed, or both cells
 *        < 10 episodes) with the data preconditions met, writes the registered CANNOT MEASURE record. Consumes the one read.
 *
 * RULE (registry R343.rule, quoted):
 *  "MONTH-END YIELD Y[m] = the last DGS10 observation in calendar month m. SIGNAL month m: Y[m] - Y[m-12] >= 1.00 percentage point.
 *   EPISODES: a new episode starts at a signal month preceded by >= 6 consecutive non-signal months; it runs through the following
 *   signal months. TRANCHE: each signal month m opens one long tranche at the FIRST DGS10 observation of month m+1 (the day Y[m] is
 *   published), held h months to the first observation of month m+1+h. CONSTANT-MATURITY 10y TOTAL RETURN on the first-observation
 *   grid G[k] (yield y[k], percent): each month buy a 10y par bond with coupon c = y[k-1]/100 (semiannual); at G[k] reprice at y[k]
 *   with 10 - 1/12 years left: P = 100 x [ (c/2) x (1 - (1 + y/200)^(-2T)) / (y/200) + (1 + y/200)^(-2T) ], T = 9.9167; monthly
 *   r[k] = (P - 100)/100 + c/12; TR_h = product of (1 + r[k]) over the h months - 1. EXCESS: X[m] = TR_h(m) - D_h(decade), D_h = the
 *   mean TR_h over every NON-signal month of the same calendar decade (1960s = 1962-69 ... 2020s) with a complete window. Signal
 *   months never enter D (no signal-dependent drift). Raw TR_h reported beside. COST: 2 bps per tranche round trip ($10,000 row),
 *   $20 per ZN round trip; 2x reported."
 *  STATISTIC: "Per cell (h): per EPISODE, the mean of X[m] over its signal months; headline = the mean over episodes, t = Newey-West
 *   lag 1 over the EPISODE series in start order (clustered episode-level: one observation per rate shock, never per month). The
 *   graded cell is the one with the higher t, against the best-of-2 bar."
 *  BAR 2.658 (amended), minEpisodes 10, variants 2. PASS only if >= 10 episodes AND t_NW >= 2.658 AND mean > 0 AND beats the
 *   same-decade random-month p95 AND both pre-/post-1985 halves > 0 AND leave-largest-out > 0 AND 2x cost > 0.
 *  CANNOT MEASURE "if < 10 episodes, or the CM10 reconstruction fails its known answer". readCondition: "known answer: the
 *   reconstructed CM10 annual returns 1962-2025 correlate >= 0.98 with Damodaran's published annual 10-year T-bond returns".
 *
 * IMPLEMENTATION NOTES (fixed before any outcome; each is a reading of text the registry leaves open, never a searched choice):
 *  N1 The signal is computed in integer basis points (Y_bp = round(Y x 100)): "Y[m] - Y[m-12] >= 1.00 percentage point" is
 *     Y_bp[m] - Y_bp[m-12] >= 100 exactly (two-decimal yields differ by 0.99999... in floating point). Pricing uses the values.
 *  N2 Month grid 1962-01..2026-09 (evidenceStart "FRED DGS10 daily 1962-01-02..2026-09-30"); F[m] = the first observation of
 *     month m (G), L[m] = the last observation dated <= 2026-09-30 (Y); FRED's empty / "." days are not observations.
 *  N3 Months 1962-01..1962-12 have no Y[m-12] and can never be signal months; they are NON-signal months of the 1960s ("1960s =
 *     1962-69") and enter D and the random-month pool. The first signal month in the data starts an episode.
 *  N4 Episode: a signal month starts a new episode iff there is no earlier signal month or >= 6 non-signal months lie strictly
 *     between it and the previous signal month; otherwise it joins the running episode ("runs through the following signal months").
 *  N5 A cell's episode observation = the mean over the episode's signal months whose h-month window is complete (exit G <= 2026-09);
 *     an episode with none is absent from that cell. Start order and the 1985 split use the episode's FIRST signal month.
 *  N6 Net = X - cost, cost 2 bps of tranche notional (2x = 4 bps); D is gross (a baseline, not a trade). THE GRADED CELL (the
 *     registry leaves it open; the 2026-10-08 amendment explicitly did NOT settle it — reported to the main loop): the higher NET
 *     t_NW at 1x cost (the house tNet), chosen ONCE between both cells whatever their counts; every PASS condition and the 10-episode
 *     minimum are judged on that cell (never replaced by the other); a graded cell below 10 episodes is CANNOT MEASURE (the literal
 *     decisionRule.cannotMeasure "< 10 episodes"); a 3-decimal t tie grades BOTH (PASS needs both). --read reports whether the gross
 *     t would have picked the same cell.
 *  N7 Random months (GATE): per draw, every tranche month i of the graded cell is replaced by a uniform draw, with replacement, from
 *     the non-signal months of decade(i) with a complete window; the draw's X net enters the same episode; the draw's statistic is
 *     the mean over episodes. 1,000 draws, seed mulberry(fnv1a('r343-random-months|h=<h>')); p95 = sorted[floor(0.95 x 1000)] (the
 *     registration's convention); gate: real mean > p95, unrounded.
 *  N8 Largest-contributing episode = the episode with the largest net episode mean (its removal lowers the mean most); a tie removes
 *     the earlier. Pre/post 1985: first signal month < 1985-01 -> pre, >= 1985-01 -> post; an empty half fails.
 *  N9 ZN row (REPORTED): bill return over a tranche = product over its months k of (1 + TB3MS[month of G[k-1]] / 1200) - 1 (TB3MS is
 *     a monthly-average annual discount rate, read as the rate earned that month); ZN $ = $100,000 x (TR_h - bill_h) - $20.
 *  N10 $ table: the $10,000 row on RAW TR_h (what a tranche earns), cost $2 charged at entry; drawdown on the monthly-marked sum of
 *     open tranches on the first-observation grid (registered) and on the closed-trade curve in exit order (house); losing streak in
 *     exit order. An excess-over-D $ row is reported beside (closed-trade only).
 *  N11 Known answer (readCondition): the CM10 annual return of year Y = holding from G[Jan Y] to G[Jan Y+1]; Pearson correlation with
 *     Damodaran's "US T. Bond (10-year)" column over 1962-2025 (all 64 years required) >= 0.98. Only the correlation and summary
 *     differences are printed or stored, never the per-year series.
 *  N12 Lag check (REPORTED): tranche opens at G[m+2], held h months; D recomputed on the lagged TR of non-signal months.
 *  N13 --controls is OUTCOME-BLIND: on the real series it computes entry-time information only (signals, episodes, window
 *     completeness, coverage, truncation invariance) plus the registered CM10 known answer (unconditional annual returns,
 *     summarised). No tranche TR, X, D or random-month draw is computed on real data before --read; the random-month p95 is computed
 *     once inside --read under the code sha locked by --controls.
 *  N14 House leak test (register-test skill; not a registered R343 gate): 200 scrambled paths — the real months' (within-month,
 *     month-boundary) log-yield-change blocks drawn iid WITH replacement and demeaned, mulberry(343000 + r) — through the FULL
 *     pipeline and every registered gate. READY needs the median |net t| < 2 in each cell AND the full-rule false-PASS rate <= 5%
 *     (the bar's nominal size). REPORTED beside: the core false-pass (t >= bar AND mean > 0); the same null X aggregated per MONTH
 *     (every tranche weight 1) and first-signal-month-only (one tranche per episode), and corr(episode length, episode mean), which
 *     locate any bias; the former permuted (without-replacement) donor's numbers. A failure is NOT a verdict: it is reported for
 *     the main loop (dated pre-evidence amendment or acceptance) and the test is not read. DISCLOSED: the first --controls run
 *     (2026-10-08 ~11:18 MT, code sha 1b3fa8f5) used blocks permuted WITHOUT replacement; a permutation fixes the endpoint (a
 *     bridge, i.e. built-in mean reversion), so it was replaced by the iid draw — the house's with-replacement donor convention.
 *  N15 Positive control: 50 scrambled paths, mulberry(343500 + r), with a planted excess return of +0.75% in every CM10 month that
 *     falls inside some signal month's 12-month window (signals from the unplanted path, so the plant cannot move them). The same 50
 *     paths are also run UNPLANTED (matched seeds, same random-month seeds). Critical value = max(3, the p95 of the graded-cell net t
 *     over N14's 200 null paths; an undefined t counts as -Infinity, i.e. never rejects). READY needs the planted median graded t >=
 *     that critical value AND the unplanted (matched) median graded t < it (the gate must reject a zero plant). It checks that the
 *     statistic separates a planted edge from its own null at the null's 5% size, not this test's power.
 *     DISCLOSED (2026-10-08 fixer, outcome-blind, synthetic paths only): the first gate was "planted median graded t >= 3"; on the
 *     same 50 seeds with a ZERO plant it gave median graded t 3.1515 and 20/50 full-rule PASS (reviewer scripts/poscontrol-zero.js),
 *     i.e. it passed with no edge because the N14 null itself sits above 3 — replaced by the null-relative critical value above.
 *  N16 Selftest coverage (2026-10-08 fixer, after a mutation review caught 11 of 22 seeded bugs slipping through): CM10 on moving
 *     yields (coupon from y[k-1], T = 9.9167), bill timing, first/last observation per month, decade of the signal month at a decade
 *     boundary, random months straddling a decade and p95 != median, the strict random-month gate, and an end-to-end hand path
 *     through analyze/cellAnalysis (F != L, an episode starting exactly 1985-01, a known largest episode, 2x cost) against an
 *     independent brute-force computation. No registered quantity changed.
 *
 * Paper research only: no orders, no broker endpoint, no notification. Network only in --fetch (public data GETs).
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic, writeTextAtomic } = require("./lib/atomic-write.js");
const { nullBar } = require("./lib/null-bar.js");

const ID = "R343";
const D = (...f) => path.join(__dirname, "data", ...f);
const TR = D("training", "r343");
const F_DGS10 = path.join(TR, "DGS10.csv"), F_TB3MS = path.join(TR, "TB3MS.csv"), F_DAM = path.join(TR, "damodaran-tbond.json"), F_META = path.join(TR, "fetch-meta.json");
const CONTROLS = D("r343-controls.json"), OUTF = D("r343-read.json"), SELFTEST_REC = path.join(TR, "selftest.json");
const argv = process.argv.slice(2);
const MODE = ["--selftest", "--controls", "--read", "--fetch"].find((m) => argv.includes(m)) || null;
/** every dated amendment this file implements (registryChecks refuses if the registry carries any other) */
const KNOWN_AMENDMENTS = ["pre-build-2026-10-08"];

// ── constants (each asserted against the registry text by registryChecks) ─────────────────────────────────────────────────────
const SPIKE_BP = 100, GAP_MIN = 6, HS = [6, 12], T_LEFT = 9.9167;
const COST = 0.0002, COST2X = 0.0004, POS_USD = 10000, POS_COST_USD = 2, ZN_FACE = 100000, ZN_RT_USD = 20;
const BASE_YEAR = 1962, LAST_YM = "2026-09", WINDOW_END = "2026-09-30", FIRST_OBS = "1962-01-02", SPLIT_YM = "1985-01";
const MIN_EP = 10, BAR = 2.658, VARIANTS = 2, DRAWS = 1000, BAR_SEED = 343, BAR_TRIALS = 20000;
const CORR_MIN = 0.98, KA_FROM = 1962, KA_TO = 2025;
const LEAK_REPS = 200, LEAK_SEED0 = 343000, LEAK_MED_MAX = 2, FPR_MAX = 0.05;
const POS_REPS = 50, POS_SEED0 = 343500, POS_DELTA = 0.0075, POS_WINDOW = 12, POS_T = 3;
const URL_FRED = (id) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
const URL_DAM = "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html";
const DAM_COL = "US T. Bond (10-year)";

// ── small utilities ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** the registration's generator (backend/register-r339-r343.js), verbatim */
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function fnv1a(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
/** the registration's nwT (register-r339-r343.js), verbatim — used only to reproduce the bar */
function nwTReg(a, L = 1) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * c / n; } return m / Math.sqrt(v / n); }
/** the same formula, guarded: n < 3 or non-positive variance -> NaN (fails every gate closed) */
function nwT(a, L = 1) {
  const n = a.length; if (n < 3) return NaN;
  const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n;
  for (let l = 1; l <= L; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * c / n; }
  return v > 0 ? m / Math.sqrt(v / n) : NaN;
}
const sortNum = (a) => Array.from(a).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
const sortInf = (a) => Array.from(a).map((x) => (Number.isFinite(x) ? x : Infinity)).sort((x, y) => x - y);
const sortNegInf = (a) => Array.from(a).map((x) => (Number.isFinite(x) ? x : -Infinity)).sort((x, y) => x - y);   // an undefined t cannot pass / reject
const pIdx = (s, q) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN);   // the registration's p95 convention
const median = (s) => (s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN);
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null), r6 = (x) => (Number.isFinite(x) ? +x.toFixed(6) : null), r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const codeSha = () => crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function shuffle(a, rng) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const x = a[i]; a[i] = a[j]; a[j] = x; } return a; }
function pearson(x, y) { const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; } return sxy / Math.sqrt(sxx * syy); }

// ── month grid ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ymIndex = (ym) => (+ym.slice(0, 4) - BASE_YEAR) * 12 + (+ym.slice(5, 7) - 1);
const ymOf = (i) => `${BASE_YEAR + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const M_ALL = ymIndex(LAST_YM) + 1;   // 1962-01 .. 2026-09
const decadeOf = (i) => Math.floor((BASE_YEAR + Math.floor(i / 12)) / 10) * 10;

// ── registry ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function registryEntry() {
  const reg = readJson(D("test-registry.json"));
  const t = (reg.preregistered || []).find((x) => x.id === ID) || (reg.tests || []).find((x) => x.id === ID);
  if (!t) throw new Error("R343 not in the registry");
  return t;
}
/** every constant this file uses must still be the registry's own text (drift -> refuse). */
function registryChecks(t) {
  const fails = [], need = (hay, s, where) => { if (!String(hay || "").includes(s)) fails.push(`${where}: "${s}"`); };
  const rule = String(t.rule || "");
  need(rule, "Y[m] = the last DGS10 observation in calendar month m", "rule");
  need(rule, "SIGNAL month m: Y[m] - Y[m-12] >= 1.00 percentage point", "rule");
  need(rule, "a new episode starts at a signal month preceded by >= 6 consecutive non-signal months; it runs through the following signal months", "rule");
  need(rule, "opens one long tranche at the FIRST DGS10 observation of month m+1", "rule");
  need(rule, "held h months to the first observation of month m+1+h", "rule");
  need(rule, "coupon c = y[k-1]/100 (semiannual)", "rule");
  need(rule, "P = 100 x [ (c/2) x (1 - (1 + y/200)^(-2T)) / (y/200) + (1 + y/200)^(-2T) ], T = 9.9167", "rule");
  need(rule, "r[k] = (P - 100)/100 + c/12", "rule");
  need(rule, "TR_h = product of (1 + r[k]) over the h months - 1", "rule");
  need(rule, "X[m] = TR_h(m) - D_h(decade), D_h = the mean TR_h over every NON-signal month of the same calendar decade (1960s = 1962-69 ... 2020s) with a complete window", "rule");
  need(rule, "Signal months never enter D", "rule");
  need(rule, "COST: 2 bps per tranche round trip ($10,000 row), $20 per ZN round trip; 2x reported.", "rule");
  need(t.multiplicityFamily, "horizon h in {6, 12} months", "multiplicityFamily");
  need(t.statistic, "per EPISODE, the mean of X[m] over its signal months; headline = the mean over episodes, t = Newey-West lag 1 over the EPISODE series in start order", "statistic");
  need(t.statistic, "The graded cell is the one with the higher t, against the best-of-2 bar.", "statistic");
  const c = t.controls || {};
  need(c.randomMonthsSameDecade, "every signal month replaced by a random non-signal month of the same calendar decade, regrouped into the same episodes; 1,000 draws; real mean > the draws' p95", "controls.randomMonthsSameDecade");
  need(c.prePost1985, "episodes split by start month at 1985-01-01; both halves' means > 0", "controls.prePost1985");
  need(c.leaveLargestOut, "with the single largest-contributing episode removed, the mean stays > 0", "controls.leaveLargestOut");
  need(c.cost2x, "mean > 0 at 2x cost", "controls.cost2x");
  need(c.reported, "first-signal-month-only entries (one tranche per episode); entry one month later (lag check); each episode alone; the ZN excess-return row", "controls.reported");
  const b = t.bar || {};
  if (b.tRequired !== BAR || b.minEpisodes !== MIN_EP || b.variants !== VARIANTS || b.unit !== "episodes" || b.fixedInAdvance !== true) fails.push(`bar fields (tRequired ${b.tRequired}, minEpisodes ${b.minEpisodes}, variants ${b.variants}, unit ${b.unit})`);
  need(b.method, "seeds 343 / 100343", "bar.method");
  const dr = t.decisionRule || {};
  need(dr.pass, "PASS only if >= 10 episodes AND the graded cell's t_NW >= 2.658 AND mean > 0 AND it beats the same-decade random-month p95 AND both pre- and post-1985 halves > 0 AND leave-largest-out > 0 AND 2x cost > 0", "decisionRule.pass");
  need(dr.cannotMeasure, "CANNOT MEASURE if < 10 episodes, or the CM10 reconstruction fails its known answer", "decisionRule.cannotMeasure");
  need(t.readCondition, "the reconstructed CM10 annual returns 1962-2025 correlate >= 0.98 with Damodaran's published annual 10-year T-bond returns", "readCondition");
  need(t.evidenceStart, "FRED DGS10 daily 1962-01-02..2026-09-30 and TB3MS", "evidenceStart");
  const sz = ((t.dollarTable || {}).sizing || []).join(" ");
  need(sz, "$10,000 per tranche (one tranche per signal month, unlevered, cost $2 per round trip)", "dollarTable.sizing");
  need(sz, "drawdown on the monthly-marked sum of open tranches", "dollarTable.sizing");
  need(sz, "1 ZN per tranche: $100,000 face x (TR_h - the 3-month bill return over the same months from FRED TB3MS) - $20", "dollarTable.sizing");
  if (t.unit !== "episodes") fails.push(`unit ${t.unit}`);
  const keys = (t.amendments || []).map((x) => x && x.key);
  if (keys.length !== KNOWN_AMENDMENTS.length || keys.some((k, i) => k !== KNOWN_AMENDMENTS[i])) fails.push(`amendments: registry has [${keys.join(", ")}], this runner implements [${KNOWN_AMENDMENTS.join(", ")}]`);
  if (!/^REGISTERED 2026-10-07 \(pre-evidence amendments: 2026-10-08 pre-build\)/.test(String(t.status || "")) && !/^SEALED \d{4}-\d{2}-\d{2} /.test(String(t.status || ""))) fails.push(`status: ${String(t.status).slice(0, 90)}`);
  return fails;
}

// ── data ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function parseFredCsv(id, text) {
  const lines = String(text || "").trim().split(/\r?\n/), head = (lines[0] || "").split(",");
  if (head.length !== 2 || head[1].trim() !== id) throw new Error(`not a FRED CSV for ${id} (first line: ${String(lines[0] || "").slice(0, 60)})`);
  const rows = lines.slice(1).map((l) => l.split(",")).filter((x) => x.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(x[0]) && x[1].trim() !== "." && x[1].trim() !== "" && Number.isFinite(+x[1])).map((x) => ({ d: x[0], v: +x[1] }));
  if (!rows.length) throw new Error(`FRED ${id}: CSV parsed to zero values`);
  for (let i = 1; i < rows.length; i++) if (!(rows[i].d > rows[i - 1].d)) throw new Error(`FRED ${id}: dates not strictly ascending at ${rows[i].d}`);
  return rows;
}
/** Damodaran histretSP.html -> { header, returns: { year: decimal } } for the "US T. Bond (10-year)" column (N11) */
function parseDamodaran(html) {
  const rows = [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()));
  const header = rows.find((r) => r[0] === "Year" && r.includes(DAM_COL));
  if (!header) throw new Error(`Damodaran: no header row with "${DAM_COL}"`);
  const col = header.indexOf(DAM_COL), returns = {};
  for (const r of rows) {
    if (!/^(19|20)\d\d$/.test(r[0])) continue;
    const m = /^(-?\d+(?:\.\d+)?)%$/.exec(r[col] || ""); if (!m) throw new Error(`Damodaran ${r[0]}: unparsable "${r[col]}"`);
    if (returns[r[0]] !== undefined) throw new Error(`Damodaran: year ${r[0]} twice`);
    returns[r[0]] = +m[1] / 100;
  }
  return { header, column: col, returns };
}
function loadData() {
  const missing = [F_DGS10, F_TB3MS, F_DAM].filter((f) => !fs.existsSync(f));
  if (missing.length) return { ok: false, problems: [`not fetched (run --fetch): ${missing.map((f) => path.relative(path.join(__dirname, ".."), f)).join(", ")}`] };
  const dgsAll = parseFredCsv("DGS10", fs.readFileSync(F_DGS10, "utf8"));
  const dgs = dgsAll.filter((r) => r.d >= `${BASE_YEAR}-01-01` && r.d <= WINDOW_END);
  const tbAll = parseFredCsv("TB3MS", fs.readFileSync(F_TB3MS, "utf8"));
  const tb3 = new Float64Array(M_ALL).fill(NaN);
  for (const r of tbAll) { const i = ymIndex(r.d.slice(0, 7)); if (i >= 0 && i < M_ALL) tb3[i] = r.v; }
  const dj = readJson(F_DAM), dam = {}; for (const [y, v] of Object.entries(dj.returns || {})) dam[+y] = v;
  const fp = crypto.createHash("sha256");
  fp.update(`DGS10|${dgs.length}|`); for (const r of dgs) fp.update(`${r.d}=${r.v};`);
  fp.update(`TB3MS|`); for (let i = 0; i < M_ALL; i++) fp.update(`${i}=${tb3[i]};`);
  fp.update(`DAM|`); for (let y = KA_FROM; y <= KA_TO; y++) fp.update(`${y}=${dam[y]};`);
  return { ok: true, dgs, tb3, dam, fingerprint: fp.digest("hex"), dgsLastAll: dgsAll[dgsAll.length - 1].d };
}
/** daily rows -> month arrays (N2): F/Fd first observation, L/Ld last observation, nObs */
function monthsFromDaily(rows, nMonths = M_ALL) {
  const F = new Float64Array(nMonths).fill(NaN), L = new Float64Array(nMonths).fill(NaN), Fd = new Array(nMonths).fill(null), Ld = new Array(nMonths).fill(null), nObs = new Int32Array(nMonths);
  let prev = "";
  for (const r of rows) {
    if (!(r.d > prev)) throw new Error(`daily rows not ascending at ${r.d}`); prev = r.d;
    const i = ymIndex(r.d.slice(0, 7)); if (i < 0 || i >= nMonths) continue;
    if (nObs[i] === 0) { F[i] = r.v; Fd[i] = r.d; }
    L[i] = r.v; Ld[i] = r.d; nObs[i]++;
  }
  return { n: nMonths, F, L, Fd, Ld, nObs };
}

// ── the registered machinery ──────────────────────────────────────────────────────────────────────────────────────────────────
/** N1: Y_bp[m] - Y_bp[m-12] >= 100 */
const isSignalBp = (Lm, L12) => { const a = Math.round(Lm * 100), b = Math.round(L12 * 100); return Number.isFinite(a) && Number.isFinite(b) && a - b >= SPIKE_BP; };
function signalsOf(L) { const n = L.length, s = new Uint8Array(n); for (let i = 12; i < n; i++) if (isSignalBp(L[i], L[i - 12])) s[i] = 1; return s; }
/** N4 */
function episodesOf(sig) { const eps = []; let prev = -1; for (let i = 0; i < sig.length; i++) { if (!sig[i]) continue; if (prev < 0 || i - prev - 1 >= GAP_MIN) eps.push([i]); else eps[eps.length - 1].push(i); prev = i; } return eps; }
/** the rule's price: P = 100 x [ (c/2) x (1 - (1 + y/200)^(-2T)) / (y/200) + (1 + y/200)^(-2T) ] */
function priceOf(c, y, T = T_LEFT) { const i = y / 200, df = Math.pow(1 + i, -2 * T); return 100 * ((c / 2) * (1 - df) / i + df); }
/** r[k] = (P - 100)/100 + c/12 on the first-observation grid; r[0] undefined */
function cm10Returns(F) { const n = F.length, r = new Float64Array(n).fill(NaN); for (let k = 1; k < n; k++) { const c = F[k - 1] / 100; r[k] = (priceOf(c, F[k]) - 100) / 100 + c / 12; } return r; }
/** TR_h for the tranche of month i: opens at G[i+1+lag], closes at G[i+1+lag+h] -> product of (1 + r[j]), j = i+2+lag .. i+1+lag+h */
function compoundArray(r, h, lag = 0) { const n = r.length, out = new Float64Array(n).fill(NaN); for (let i = 0; i < n; i++) { const a = i + 2 + lag, b = i + 1 + lag + h; if (b > n - 1) continue; let p = 1; for (let j = a; j <= b; j++) p *= 1 + r[j]; out[i] = p - 1; } return out; }
/** N9: bill rate for the hold G[j-1] -> G[j] = TB3MS[j-1] / 1200 */
function billMonthly(tb3) { const n = tb3.length, b = new Float64Array(n).fill(NaN); for (let j = 1; j < n; j++) b[j] = tb3[j - 1] / 1200; return b; }
/** D_h per decade over NON-signal months with a complete window, and the same months as the random-month pool (N3, N7) */
function decadeBase(sig, TRa) {
  const sum = new Map(), cnt = new Map(), pool = new Map();
  for (let i = 0; i < TRa.length; i++) {
    if (sig[i] || !Number.isFinite(TRa[i])) continue;
    const d = decadeOf(i); sum.set(d, (sum.get(d) || 0) + TRa[i]); cnt.set(d, (cnt.get(d) || 0) + 1); if (!pool.has(d)) pool.set(d, []); pool.get(d).push(i);
  }
  const Dm = new Map(); for (const [d, s] of sum) Dm.set(d, s / cnt.get(d));
  return { D: Dm, pool, cnt };
}
const excessOf = (TRa, base) => TRa.map((v, i) => (Number.isFinite(v) && base.D.has(decadeOf(i)) ? v - base.D.get(decadeOf(i)) : NaN));
/** N5: per-episode mean of (val - cost) over the episode's months with a defined value */
function cellOf(eps, val, cost) {
  const obs = [];
  for (const e of eps) { const ms = e.filter((i) => Number.isFinite(val[i])); if (!ms.length) continue; obs.push({ start: e[0], end: e[e.length - 1], signalMonths: e.length, months: ms, v: mean(ms.map((i) => val[i])) - cost }); }
  const s = obs.map((o) => o.v);
  return { obs, n: obs.length, tranches: obs.reduce((a, o) => a + o.months.length, 0), mean: mean(s), t: nwT(s) };
}
/** N7 */
function randomMonths(obs, X, base, cost, seedLabel, draws = DRAWS) {
  const rng = mulberry(fnv1a(seedLabel)), out = new Float64Array(draws);
  for (let d = 0; d < draws; d++) {
    let tot = 0;
    for (const o of obs) { let s = 0; for (const i of o.months) { const pool = base.pool.get(decadeOf(i)) || []; s += pool.length ? X[pool[Math.floor(rng() * pool.length)]] : NaN; } tot += s / o.months.length - cost; }
    out[d] = obs.length ? tot / obs.length : NaN;
  }
  const s = sortInf(out);   // an undefined draw sorts as +Infinity (fail-closed)
  return { draws, seedLabel, p95: pIdx(s, 0.95), median: median(s), finiteDraws: Array.from(out).filter(Number.isFinite).length };
}
/** one cell's registered quantities on a month path (N5-N8) */
function cellAnalysis(h, sig, eps, r, o = {}) {
  const TRa = compoundArray(r, h, 0), base = decadeBase(sig, TRa), X = excessOf(TRa, base);
  const c1 = cellOf(eps, X, COST), c2 = cellOf(eps, X, COST2X), split = ymIndex(SPLIT_YM);
  const pre = c1.obs.filter((q) => q.start < split).map((q) => q.v), post = c1.obs.filter((q) => q.start >= split).map((q) => q.v);
  let li = -1; c1.obs.forEach((q, k) => { if (li < 0 || q.v > c1.obs[li].v) li = k; });
  const llo = c1.obs.filter((_, k) => k !== li).map((q) => q.v);
  const rm = o.randomMonths ? randomMonths(c1.obs, X, base, COST, `${o.seedPrefix || "r343-random-months"}|h=${h}`, o.draws || DRAWS) : null;
  return { h, TRa, base, X, c1, mean2x: c2.mean, t2x: c2.t, preMean: mean(pre), postMean: mean(post), nPre: pre.length, nPost: post.length, lloMean: mean(llo), largest: li >= 0 ? c1.obs[li] : null, rm };
}
function analyze(mo, o = {}) {
  const sig = signalsOf(mo.L), eps = episodesOf(sig), r = o.r || cm10Returns(mo.F);
  return { sig, eps, r, cells: HS.map((h) => cellAnalysis(h, sig, eps, r, o)) };
}
function cellGates(c, selftestOK, bar = BAR) {
  return {
    selftestPassed: selftestOK === true,
    minEpisodes: c.c1.n >= MIN_EP,
    tAtLeastBar: c.c1.t >= bar,
    meanNetPositive: c.c1.mean > 0,
    beatsRandomMonthsP95: !!c.rm && Number.isFinite(c.rm.p95) && c.c1.mean > c.rm.p95,
    prePost1985BothPositive: c.preMean > 0 && c.postMean > 0,
    leaveLargestOutPositive: c.lloMean > 0,
    cost2xPositive: c.mean2x > 0,
  };
}
/** N6: graded = higher NET t (3-decimal tie -> both); CANNOT MEASURE (selftest / graded < 10 episodes) before PASS / DID NOT PASS */
function gradedOf(cells) {
  const ts = cells.map((c) => c.c1.t), f = ts.map((x) => Number.isFinite(x));
  if (f[0] && f[1]) return +ts[0].toFixed(3) === +ts[1].toFixed(3) ? [0, 1] : [ts[0] > ts[1] ? 0 : 1];
  if (f[0] || f[1]) return [f[0] ? 0 : 1];
  return [cells[0].c1.n >= cells[1].c1.n ? 0 : 1];
}
function assembleVerdict(cells, selftestOK, bar = BAR) {
  const graded = gradedOf(cells), per = cells.map((c) => cellGates(c, selftestOK, bar));
  const gates = {}; for (const k of Object.keys(per[0])) gates[k] = graded.every((g) => per[g][k] === true);
  const cannot = [];
  if (selftestOK !== true) cannot.push("selftest / CM10 known answer");
  for (const g of graded) if (!(cells[g].c1.n >= MIN_EP)) cannot.push(`< ${MIN_EP} episodes (h=${cells[g].h}: ${cells[g].c1.n})`);
  const failed = Object.entries(gates).filter(([, v]) => v !== true).map(([k]) => k);
  const head = graded.map((g) => { const c = cells[g]; return `graded cell h=${c.h}m: net t_NW ${r4(c.c1.t)} vs bar ${bar}, mean net excess ${r4(100 * c.c1.mean)}% per episode, ${c.c1.n} episodes (${c.c1.tranches} tranches)`; }).join(" AND ");
  const verdictScript = cannot.length ? `CANNOT MEASURE — ${head}; because: ${cannot.join("; ")}` : failed.length === 0 ? `PASS — ${head}; every registered gate true` : `DID NOT PASS — ${head}; failed: ${failed.join(", ")}`;
  const verdict = cannot.length ? "CANNOT MEASURE" : failed.length === 0 ? "PASS" : "DID NOT PASS";
  return { graded, gates, perCell: per, verdict, verdictScript };
}

// ── the registration's bar, verbatim (reported at the actual n at --read; reproduced at n 10 in --selftest) ───────────────────────
function barAt(n, seed = BAR_SEED, variants = VARIANTS) {
  const rng = mulberry(seed), mx = [];
  for (let k = 0; k < BAR_TRIALS; k++) { let b = -Infinity; for (let v = 0; v < variants; v++) { const s = []; for (let i = 0; i < n; i++) s.push(rng() * 2 - 1); b = Math.max(b, nwTReg(s, 1)); } mx.push(b); }
  mx.sort((a, b) => a - b);
  const nw = +mx[Math.floor(0.95 * BAR_TRIALS)].toFixed(3);
  const iid = +nullBar({ variants, n, trials: BAR_TRIALS, rng: mulberry(seed + 100000) }).p95.toFixed(3);
  return { t: Math.max(nw, iid), nw, iid, n, seed, variants };
}

// ── $ table (N10) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** tranches: [{ i, open, close, tr, x, bill }]; r / bmo monthly arrays on the grid. kind: 'usd10k' | 'zn1' | 'usd10kExcess' */
function dollarTable(tranches, r, bmo, kind) {
  const pnlOf = (q) => (kind === "zn1" ? ZN_FACE * (q.tr - q.bill) - ZN_RT_USD : kind === "usd10kExcess" ? POS_USD * q.x - POS_COST_USD : POS_USD * q.tr - POS_COST_USD);
  const rows = tranches.map((q) => ({ ...q, pnl: pnlOf(q) })).sort((a, b) => a.close - b.close || a.open - b.open || a.i - b.i);
  let net = 0, gains = 0, losses = 0, wins = 0, loss = 0, scratch = 0, streak = 0, worstStreak = 0, eq = 0, peak = 0, dd = 0, worst = Infinity;
  for (const q of rows) {
    net += q.pnl; if (q.pnl < worst) worst = q.pnl;
    if (q.pnl > 0) { gains += q.pnl; wins++; streak = 0; } else if (q.pnl < 0) { losses += q.pnl; loss++; streak++; if (streak > worstStreak) worstStreak = streak; } else { scratch++; streak = 0; }
    eq += q.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq;
  }
  // monthly-marked sum of open tranches (registered for the $10,000 row; the same construction for ZN); cost charged at entry
  let ddM = null, peakOpen = 0;
  if (kind !== "usd10kExcess" && rows.length) {
    const k0 = Math.min(...rows.map((q) => q.open)), k1 = Math.max(...rows.map((q) => q.close)), E = new Float64Array(k1 - k0 + 1);
    for (const q of rows) {
      let cr = 1, cb = 1;
      for (let k = q.open; k <= k1; k++) {
        if (k > q.open && k <= q.close) { cr *= 1 + r[k]; cb *= 1 + (kind === "zn1" ? bmo[k] : 0); }
        const mark = k >= q.close ? q.pnl : kind === "zn1" ? ZN_FACE * (cr - cb) - ZN_RT_USD : POS_USD * (cr - 1) - POS_COST_USD;
        E[k - k0] += mark;
      }
    }
    let pk = 0; ddM = 0; for (let k = 0; k < E.length; k++) { if (E[k] > pk) pk = E[k]; if (pk - E[k] > ddM) ddM = pk - E[k]; }
    for (let k = k0; k <= k1; k++) { const c = rows.filter((q) => q.open <= k && k < q.close).length; if (c > peakOpen) peakOpen = c; }
  }
  const n = rows.length, riskEach = kind === "zn1" ? ZN_FACE : POS_USD;
  return {
    sizing: kind === "zn1" ? "1 ZN per tranche: $100,000 face x (TR_h - TB3MS bill return over the same months) - $20 (N9); '$ risked' = $100,000 face (no stop) plus the worst tranche loss"
      : kind === "usd10kExcess" ? "REPORTED: $10,000 x X (excess over the decade baseline D_h) - $2 per tranche; closed-trade curve only"
      : "$10,000 per tranche on RAW TR_h, unlevered, cost $2 per round trip charged at entry; '$ risked' = $10,000 notional per tranche",
    trades: n, riskPerTradeMean: n ? riskEach : null, riskPerTradeMax: n ? riskEach : null, riskTotal: n * riskEach, worstTrancheLoss: r2(n ? worst : NaN),
    netPnl: r2(net), grossGains: r2(gains), grossLosses: r2(losses), wins, losses: loss, scratches: scratch, avgWin: r2(wins ? gains / wins : NaN), avgLoss: r2(loss ? losses / loss : NaN),
    worstDrawdownMonthlyMarked: ddM === null ? null : r2(ddM), worstDrawdownClosedTrade: r2(dd), longestLosingStreak: worstStreak, peakSimultaneousOpenTranches: kind === "usd10kExcess" ? null : peakOpen,
    order: "closed-trade curve and streak in exit order (exit month, then entry month)",
  };
}
function tranchesOf(cell, h, billArr) { const out = []; for (const o of cell.c1.obs) for (const i of o.months) out.push({ i, open: i + 1, close: i + 1 + h, tr: cell.TRa[i], x: cell.X[i], bill: billArr ? billArr[i] : NaN }); return out; }

// ── no-look-ahead (truncation invariance) ─────────────────────────────────────────────────────────────────────────────────────
/** For every month m: signals and episode membership of months <= m recomputed from ONLY the daily rows dated <= Ld[m] must equal
 *  the full-data result; every tranche's entry observation is dated strictly after its signal's information date. */
function truncationCheck(rows, mo, sigFn = signalsOf) {
  const sigF = sigFn(mo.L), epsF = episodesOf(sigF), epF = new Int32Array(mo.n).fill(-1); epsF.forEach((e, k) => e.forEach((i) => { epF[i] = k; }));
  const bad = []; let p = 0, checked = 0;
  for (let m = 12; m < mo.n; m++) {
    const cut = mo.Ld[m]; while (p < rows.length && rows[p].d <= cut) p++;
    const tr = monthsFromDaily(rows.slice(0, p), m + 1), s = sigFn(tr.L), e = episodesOf(s), ep = new Int32Array(m + 1).fill(-1); e.forEach((q, k) => q.forEach((i) => { ep[i] = k; }));
    for (let i = 0; i <= m; i++) if (s[i] !== sigF[i] || ep[i] !== epF[i]) { bad.push(`${ymOf(i)} (cut ${cut})`); break; }
    if (sigF[m] && m + 1 < mo.n && !(mo.Fd[m + 1] > mo.Ld[m])) bad.push(`entry ${mo.Fd[m + 1]} not after ${mo.Ld[m]}`);
    checked++;
    if (bad.length > 5) break;
  }
  return { checked, mismatches: bad.length, examples: bad.slice(0, 5), pass: bad.length === 0 && checked === mo.n - 12 };
}
/** the same on a month path (donors): signals of months <= m from L[0..m] only */
function truncationCheckMonthly(L) {
  const sigF = signalsOf(L), epsF = episodesOf(sigF), epF = new Int32Array(L.length).fill(-1); epsF.forEach((e, k) => e.forEach((i) => { epF[i] = k; }));
  for (let m = 12; m < L.length; m++) { const s = signalsOf(L.slice(0, m + 1)), e = episodesOf(s), ep = new Int32Array(m + 1).fill(-1); e.forEach((q, k) => q.forEach((i) => { ep[i] = k; })); for (let i = 0; i <= m; i++) if (s[i] !== sigF[i] || ep[i] !== epF[i]) return false; }
  return true;
}

// ── donor (scrambled) paths, N14 / N15 ────────────────────────────────────────────────────────────────────────────────────────
/** N14: iid month blocks drawn WITH replacement (the house donor convention, r345 makeDonors), demeaned: no drift and no bridge,
 *  so a path's future is unpredictable from its past by construction */
function donorPath(mo, rng) {
  const n = mo.n, a = new Float64Array(n - 1), b = new Float64Array(n - 1);
  let tot = 0; for (let i = 0; i < n - 1; i++) { a[i] = Math.log(mo.L[i] / mo.F[i]); b[i] = Math.log(mo.F[i + 1] / mo.L[i]); tot += a[i] + b[i]; }
  const mu = tot / (n - 1) / 2, F = new Float64Array(n), L = new Float64Array(n);
  F[0] = mo.F[0];
  for (let i = 0; i < n; i++) { const k = Math.floor(rng() * (n - 1)); L[i] = F[i] * Math.exp(a[k] - mu); if (i < n - 1) F[i + 1] = L[i] * Math.exp(b[k] - mu); }
  return { n, F, L };
}
/** the former N14 donor (first --controls run 2026-10-08 ~11:18 MT): blocks permuted WITHOUT replacement. Kept for the disclosure:
 *  a permutation fixes the path's endpoint (a bridge), which builds mean reversion into the "null". Not used by any gate. */
function donorPathPermuted(mo, rng) {
  const n = mo.n, a = new Float64Array(n), b = new Float64Array(n - 1);
  for (let i = 0; i < n; i++) a[i] = Math.log(mo.L[i] / mo.F[i]);
  for (let i = 0; i < n - 1; i++) b[i] = Math.log(mo.F[i + 1] / mo.L[i]);
  const idx = shuffle(Array.from({ length: n - 1 }, (_, i) => i), rng), F = new Float64Array(n), L = new Float64Array(n);
  F[0] = mo.F[0];
  for (let i = 0; i < n; i++) { const k = i < n - 1 ? idx[i] : n - 1; L[i] = F[i] * Math.exp(a[k]); if (i < n - 1) F[i + 1] = L[i] * Math.exp(b[k]); }
  return { n, F, L };
}
/** full-rule outcome on a path (synthetic: selftest true) */
function fullRule(mo, seedPrefix, o = {}) {
  const A = analyze(mo, { randomMonths: true, seedPrefix, draws: o.draws || DRAWS, r: o.r }), v = assembleVerdict(A.cells, true);
  return { A, v };
}

// ── selftest (known answers) ──────────────────────────────────────────────────────────────────────────────────────────────────
function knownAnswerCM10(data) {
  if (!data || !data.ok) return { pass: false, reason: data ? data.problems.join("; ") : "no data" };
  const mo = monthsFromDaily(data.dgs), r = cm10Returns(mo.F), ours = [], theirs = [], missing = [];
  for (let Y = KA_FROM; Y <= KA_TO; Y++) {
    const a = (Y - BASE_YEAR) * 12; let p = 1, ok = a + 12 <= mo.n - 1;
    for (let j = a + 1; ok && j <= a + 12; j++) { if (!Number.isFinite(r[j])) ok = false; else p *= 1 + r[j]; }
    const d = data.dam[Y];
    if (!ok || !Number.isFinite(d)) { missing.push(Y); continue; }
    ours.push(p - 1); theirs.push(d);
  }
  const corr = ours.length >= 3 ? pearson(ours, theirs) : NaN, diffs = ours.map((x, i) => x - theirs[i]);
  return { years: ours.length, expectedYears: KA_TO - KA_FROM + 1, from: KA_FROM, to: KA_TO, corr: r6(corr), threshold: CORR_MIN, meanDiff: r6(mean(diffs)), meanAbsDiff: r6(mean(diffs.map(Math.abs))), maxAbsDiff: r6(Math.max(...diffs.map(Math.abs))), missingYears: missing,
    pass: corr >= CORR_MIN && missing.length === 0 && ours.length === KA_TO - KA_FROM + 1, source: `Damodaran histretSP "${DAM_COL}" column` };
}
function selftest(data) {
  const checks = {}, eq = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  // (1) the rule's price is par when the yield equals the coupon, for any T
  checks.priceParAtCoupon = [0.02, 0.05, 0.08, 0.15].every((c) => eq(priceOf(c, 100 * c), 100) && eq(priceOf(c, 100 * c, 10), 100));
  // (2) a hand-computed price: c 5%, y 6%, T 9.9167 -> i 0.03, 2T 19.8334, DF = 1.03^-19.8334 = 0.556409 -> P = 92.6068; the same by
  //     the rearranged identity P = 100 x [ (c/2)/i + (1 - (c/2)/i) x DF ]
  const pk = priceOf(0.05, 6), alt = 100 * (0.025 / 0.03 + (1 - 0.025 / 0.03) * Math.pow(1.03, -19.8334));
  checks.priceKnownAnswer = Math.abs(pk - 92.6068) < 5e-4 && eq(pk, alt, 1e-12);
  // (3) sanity: a 10y par bond's price sensitivity near 5% is ~7.8 per 1.00 pt
  const dur = (priceOf(0.05, 4.99) - priceOf(0.05, 5.01)) / 0.02; checks.durationSane = dur > 7.5 && dur < 8.1;
  // (4) flat yields: r[k] = c/12 exactly; TR_6 = (1 + 0.05/12)^6 - 1; the last h months' windows are incomplete
  { const F = new Float64Array(20).fill(5), r = cm10Returns(F), tr = compoundArray(r, 6);
    checks.flatYieldReturn = eq(r[1], 0.05 / 12, 1e-12) && eq(tr[0], Math.pow(1 + 0.05 / 12, 6) - 1, 1e-12) && Number.isFinite(tr[20 - 1 - 1 - 6]) && !Number.isFinite(tr[20 - 1 - 6]) && Number.isNaN(r[0]); }
  // (5) tranche timing: TR of month i uses r[i+2..i+1+h] (opens at G[i+1]); lag 1 uses r[i+3..i+2+h]
  //     r[1] (the hold G[0] -> G[1], before month 0's tranche opens at G[1]) is never used by month 0
  { const r = new Float64Array(12).fill(0); r[0] = NaN; r[1] = 0.5; r[2] = 0.10; r[3] = 0.20; const t0 = compoundArray(r, 2, 0), t1 = compoundArray(r, 2, 1);
    checks.trancheTiming = eq(t0[0], 1.1 * 1.2 - 1, 1e-12) && eq(t0[1], 0.20, 1e-12) && eq(t0[2], 0, 1e-15) && eq(t1[0], 0.20, 1e-12) && eq(t1[1], 0, 1e-15) && !Number.isFinite(t0[9]) && Number.isFinite(t0[8]); }
  // (5b) CM10 on MOVING yields: coupon from the PREVIOUS observation, reprice at T = 9.9167. F = [5, 6, 6, 5.5]; expected by the
  //      rearranged identity P = 100 x [ (c/2)/i + (1 - (c/2)/i) x (1 + i)^(-2T) ] (independent of priceOf): r[1] = P(.05, 6)/100 - 1
  //      + .05/12 = -0.0697652 (a coupon from the current yield gives +0.005; T = 10 gives -0.0702207); r[2] = .06/12 (par);
  //      r[3] = P(.06, 5.5)/100 - 1 + .06/12
  { const P = (c, y) => { const i = y / 200; return 100 * ((c / 2) / i + (1 - (c / 2) / i) * Math.pow(1 + i, -2 * 9.9167)); };
    const r = cm10Returns(Float64Array.from([5, 6, 6, 5.5]));
    checks.cm10MovingYields = Number.isNaN(r[0]) && eq(r[1], (P(0.05, 6) - 100) / 100 + 0.05 / 12, 1e-12) && Math.abs(r[1] + 0.0697652) < 1e-6
      && eq(r[2], 0.06 / 12, 1e-12) && eq(r[3], (P(0.06, 5.5) - 100) / 100 + 0.06 / 12, 1e-12); }
  // (5c) bill timing (N9): the hold G[j-1] -> G[j] earns TB3MS of month j-1 / 1200; compounded over a tranche like TR
  { const b = billMonthly(Float64Array.from([12, 24, 36, 48])), cb = compoundArray(b, 2, 0);
    checks.billTiming = Number.isNaN(b[0]) && eq(b[1], 0.01, 1e-12) && eq(b[2], 0.02, 1e-12) && eq(b[3], 0.03, 1e-12) && eq(cb[0], 1.02 * 1.03 - 1, 1e-12); }
  // (5d) month arrays (N2): F = the FIRST observation of the month (the grid G), L = the LAST (Y[m]); a month without observations is empty
  { const mo = monthsFromDaily([{ d: "1962-01-02", v: 4.0 }, { d: "1962-01-15", v: 4.1 }, { d: "1962-01-31", v: 4.2 }, { d: "1962-02-01", v: 4.3 }, { d: "1962-04-30", v: 4.4 }], 4);
    checks.monthFirstLast = mo.F[0] === 4.0 && mo.L[0] === 4.2 && mo.Fd[0] === "1962-01-02" && mo.Ld[0] === "1962-01-31" && mo.nObs[0] === 3 && mo.F[1] === 4.3 && mo.L[1] === 4.3 && mo.nObs[1] === 1
      && Number.isNaN(mo.F[2]) && Number.isNaN(mo.L[2]) && mo.nObs[2] === 0 && mo.L[3] === 4.4 && mo.Ld[3] === "1962-04-30"; }
  // (6) the signal in basis points (N1): every two-decimal pair exactly 1.00 apart is a signal (in floating point some such differences
  //     fall below 1, e.g. 5.07 - 4.07 or 7.31 - 6.31); 0.99 apart is not; fewer than 13 months has no signal
  { const pairs = []; for (let a = 100; a <= 1500; a++) pairs.push([a / 100, (a + 100) / 100]);
    const floatMisses = pairs.filter(([a, b]) => b - a < 1).length;
    const allBp = pairs.every(([a, b]) => { const L = new Float64Array(13).fill(a); L[12] = b; return signalsOf(L)[12] === 1; });
    const L2 = new Float64Array(13).fill(4.07); L2[12] = 5.06;
    // the comparison is with EXACTLY 12 months earlier: L[0] = 4, L[1..12] = 5 -> month 12 signals (vs month 0), not vs month 1
    const L3 = new Float64Array(14).fill(5); L3[0] = 4; const s3 = signalsOf(L3);
    checks.signalBasisPoints = allBp && floatMisses > 0 && signalsOf(L2)[12] === 0 && signalsOf(new Float64Array(12).fill(9)).every((x) => x === 0) && s3[12] === 1 && s3[13] === 0; }
  // (7) episodes (N4): signals at 20,21,23 (gap 1) -> one; 30 (6 non-signal months between) -> new; 36 (gap 5) joins it; first signal starts one
  { const s = new Uint8Array(50); for (const i of [20, 21, 23, 30, 36]) s[i] = 1; const e = episodesOf(s);
    const s2 = new Uint8Array(20); s2[13] = 1; const e2 = episodesOf(s2);
    checks.episodeGrouping = JSON.stringify(e) === JSON.stringify([[20, 21, 23], [30, 36]]) && JSON.stringify(e2) === JSON.stringify([[13]]); }
  // (8) D excludes signal months and windows that are incomplete; X = TR - D of the month's decade; decades 1962-69 / 1970s / 2020s
  { const TRa = new Float64Array(30).fill(NaN); for (let i = 0; i < 26; i++) TRa[i] = i < 13 ? 0.01 : 0.02; const sig = new Uint8Array(30); sig[3] = 1; TRa[3] = 0.50;
    const base = decadeBase(sig, TRa), X = excessOf(TRa, base), d60 = base.D.get(1960);
    // months 0..12 TR 0.01, 13..25 TR 0.02, 26..29 incomplete; month 3 a signal (TR 0.50): D(1960s) = (12 x 0.01 + 13 x 0.02) / 25
    checks.decadeBaseline = eq(d60, (12 * 0.01 + 13 * 0.02) / 25, 1e-12) && eq(X[3], 0.50 - d60, 1e-12) && !base.pool.get(1960).includes(3) && base.cnt.get(1960) === 25 && Number.isNaN(X[27])
      && decadeOf(ymIndex("1969-12")) === 1960 && decadeOf(ymIndex("1970-01")) === 1970 && decadeOf(ymIndex("2026-09")) === 2020 && ymOf(ymIndex("1985-01")) === "1985-01" && M_ALL === 777; }
  // (8b) X uses the decade of the SIGNAL month, never of the window's exit: 1969-12 (index 95, window ends in 1970) is TR - D(1960s)
  { const TRa = new Float64Array(130).fill(NaN); for (let i = 0; i < 120; i++) TRa[i] = i < 96 ? 0.01 : 0.03; const sig = new Uint8Array(130); sig[95] = 1; sig[100] = 1; TRa[95] = 0.5; TRa[100] = 0.5;
    const base = decadeBase(sig, TRa), X = excessOf(TRa, base);
    checks.decadeOfSignalMonth = eq(base.D.get(1960), 0.01, 1e-12) && eq(base.D.get(1970), 0.03, 1e-12) && eq(X[95], 0.49, 1e-12) && eq(X[100], 0.47, 1e-12) && eq(X[94], 0, 1e-12) && eq(X[96], 0, 1e-12); }
  // (9) the registration's Newey-West lag-1 t: [1,2,3,4,5] -> mean 3, v = 2 + 2 x 0.5 x 4/5 = 2.8, t = 3 / sqrt(2.8/5) = 4.008919
  checks.nwKnownAnswer = Math.abs(nwT([1, 2, 3, 4, 5]) - 4.008919) < 1e-6 && Math.abs(nwTReg([1, 2, 3, 4, 5]) - nwT([1, 2, 3, 4, 5])) < 1e-15 && Number.isNaN(nwT([1, 2])) && Number.isNaN(nwT([2, 2, 2]));
  // (10) cell aggregation: episode mean of (X - cost); months with undefined X drop; an episode with none drops
  { const X = new Float64Array(10).fill(NaN); X[1] = 0.03; X[2] = 0.01; X[5] = -0.02; const c = cellOf([[1, 2, 3], [5], [8, 9]], X, COST);
    checks.cellAggregation = c.n === 2 && c.tranches === 3 && eq(c.obs[0].v, 0.02 - COST, 1e-12) && eq(c.obs[1].v, -0.02 - COST, 1e-12) && eq(c.mean, 0 - COST, 1e-12); }
  // (11) random months: draws come only from the same decade's pool; an all-zero pool gives p95 = -cost exactly
  { const X = new Float64Array(150).fill(0), base = { pool: new Map([[1960, [0, 1, 2]], [1970, [100]]]) }; X[100] = 0.07;
    const obsA = [{ months: [5, 6] }, { months: [101] }], rmA = randomMonths(obsA, X, base, COST, "selftest");
    const base0 = { pool: new Map([[1960, [0, 1, 2]]]) }, rm0 = randomMonths([{ months: [5] }, { months: [7, 8] }], X, base0, COST, "selftest0");
    // an episode whose months straddle a decade (1969-12, 1970-01) draws each month from ITS OWN decade's pool: every draw (0 + 0.07)/2
    const rmB = randomMonths([{ months: [95, 96] }], X, base, COST, "selftestB");
    // p95 is the 95th percentile, not the median: pool X = k/100 over 96 months, one one-month episode; expected by replaying the seeded
    // stream independently: sorted[floor(0.95 x 1000)] and the median of the same draws
    const XQ = new Float64Array(96), poolQ = []; for (let k = 0; k < 96; k++) { XQ[k] = k / 100; poolQ.push(k); }
    const rmQ = randomMonths([{ months: [10] }], XQ, { pool: new Map([[1960, poolQ]]) }, COST, "selftestQ");
    const rq = mulberry(fnv1a("selftestQ")), dq = []; for (let d = 0; d < DRAWS; d++) dq.push(poolQ[Math.floor(rq() * poolQ.length)] / 100 - COST); dq.sort((a, b) => a - b);
    checks.randomMonthsMachinery = eq(rmA.p95, (0 + 0.07) / 2 - COST, 1e-12) && eq(rmA.median, (0 + 0.07) / 2 - COST, 1e-12) && eq(rm0.p95, -COST, 1e-12) && rmA.finiteDraws === DRAWS
      && eq(rmB.p95, 0.035 - COST, 1e-12) && eq(rmB.median, 0.035 - COST, 1e-12)
      && eq(rmQ.p95, dq[Math.floor(0.95 * DRAWS)], 1e-12) && eq(rmQ.median, (dq[DRAWS / 2 - 1] + dq[DRAWS / 2]) / 2, 1e-12) && rmQ.p95 - rmQ.median > 0.3; }
  // (12) gates and verdict assembly on mock cells (the 1985 split, leave-largest-out and 2x cost are computed by cellAnalysis and
  //      checked end to end in (16)); the random-month gate is strict: a mean EQUAL to the p95 does not beat it
  { const mk = (n, t, mean, p95, pre, post, llo, m2) => ({ h: 6, c1: { n, t, mean, tranches: n, obs: [] }, rm: { p95 }, preMean: pre, postMean: post, lloMean: llo, mean2x: m2 });
    const atP95 = cellGates(mk(12, 3.0, 0.02, 0.02, 0.01, 0.03, 0.015, 0.0198), true), aboveP95 = cellGates(mk(12, 3.0, 0.02, 0.0199999, 0.01, 0.03, 0.015, 0.0198), true);
    const good = mk(12, 3.0, 0.02, 0.005, 0.01, 0.03, 0.015, 0.0198), weak = mk(12, 1.0, 0.01, 0.005, 0.01, 0.01, 0.01, 0.0098);
    const vP = assembleVerdict([good, { ...weak, h: 12 }], true), vF = assembleVerdict([{ ...good, c1: { ...good.c1, t: 3.0 }, preMean: -0.01 }, { ...weak, h: 12 }], true);
    const vC = assembleVerdict([{ ...good, c1: { ...good.c1, n: 9 } }, { ...weak, h: 12 }], true), vS = assembleVerdict([good, { ...weak, h: 12 }], false);
    // vT: a 3-decimal tie grades both (the second fails leave-largest-out -> DID NOT PASS); vO: the higher-t cell fails the random-month
    // gate and is NOT replaced by the other cell, which would have passed (N6)
    const vT = assembleVerdict([good, { ...good, h: 12, c1: { ...good.c1, t: 3.0004 }, lloMean: -0.001 }], true), vO = assembleVerdict([{ ...weak, c1: { ...weak.c1, t: 3.5 }, rm: { p95: 0.02 } }, { ...good, h: 12 }], true);
    checks.gatesAndVerdict = vP.verdict === "PASS" && vP.graded[0] === 0 && /^PASS/.test(vP.verdictScript) && vF.verdict === "DID NOT PASS" && vF.gates.prePost1985BothPositive === false
      && vC.verdict === "CANNOT MEASURE" && /< 10 episodes/.test(vC.verdictScript) && vS.verdict === "CANNOT MEASURE" && vT.graded.length === 2 && vT.verdict === "DID NOT PASS"
      && vO.graded[0] === 0 && vO.verdict === "DID NOT PASS" && Object.keys(vP.gates).length === 8 && atP95.beatsRandomMonthsP95 === false && aboveP95.beatsRandomMonthsP95 === true; }
  // (13) the $ table on hand tranches (N10): r = [-, .01, -.02, .01, .01, -.03, .02], h 2; tranches at i 0, 1, 3
  { const r = Float64Array.from([NaN, 0.01, -0.02, 0.01, 0.01, -0.03, 0.02]), bm = new Float64Array(7).fill(0);
    const tq = [0, 1, 3].map((i) => ({ i, open: i + 1, close: i + 3, tr: (1 + r[i + 2]) * (1 + r[i + 3]) - 1, x: 0, bill: 0 }));
    const d = dollarTable(tq, r, bm, "usd10k"), z = dollarTable(tq, r, bm, "zn1");
    checks.dollarTable = d.trades === 3 && d.netPnl === -13 && d.grossGains === 199 && d.grossLosses === -212 && d.wins === 1 && d.losses === 2 && d.avgWin === 199 && d.avgLoss === -106
      && d.worstDrawdownClosedTrade === 108 && d.worstDrawdownMonthlyMarked === 300 && d.longestLosingStreak === 1 && d.peakSimultaneousOpenTranches === 2 && d.riskTotal === 30000 && d.worstTrancheLoss === -108
      && z.netPnl === -130 && z.riskTotal === 300000; }
  // (14) the registration's bar reproduces the registry bar at the minimum count (n 10, seed 343): NW 2.658, iid 2.268 -> 2.658
  { const b = barAt(MIN_EP); checks.registeredBarReproduced = b.t === BAR && b.nw === 2.658 && b.iid === 2.268; }
  // (15) the truncation test has teeth: a signal that peeks one month ahead (L[i+1]) is caught; the honest one passes
  { const rows = []; for (let i = 0; i < 40; i++) { const ym = ymOf(i), v = 4 + (i >= 20 && i < 24 ? 0.6 * (i - 19) : i >= 24 ? 2.4 : 0); rows.push({ d: `${ym}-03`, v }, { d: `${ym}-27`, v: v + 0.01 }); }
    const mo = monthsFromDaily(rows, 40), leaky = (L) => { const n = L.length, s = new Uint8Array(n); for (let i = 12; i < n; i++) if (isSignalBp(i + 1 < n ? L[i + 1] : L[i], L[i - 12])) s[i] = 1; return s; };
    checks.truncationHasTeeth = truncationCheck(rows, mo).pass === true && truncationCheck(rows, mo, leaky).pass === false && truncationCheckMonthly(mo.L) === true; }
  // (16) THE FULL PIPELINE on a hand path (analyze -> cellAnalysis, both cells) against an independent brute-force computation.
  //      F flat at 4 (a signal computed on F finds nothing); L = 5.2 in 1979-12 + 1980-01 (one episode straddling a decade),
  //      1985-01 (an episode starting EXACTLY at the split -> post) and 1995-06; r hand-built: +0.10 in the 1995-06 tranche's first
  //      month (the known largest episode), -0.05 in the 1985-01 tranche's first month, +0.02 in 1975-06 (so D(1970s) != D(1980s)).
  //      Checks: signals / episodes, per-episode net means, cell mean and t, pre/post-1985 counts and means, the largest episode and
  //      leave-largest-out mean, the 2x-cost mean.
  { const n = M_ALL, F = new Float64Array(n).fill(4), L = new Float64Array(n).fill(4), sigIdx = ["1979-12", "1980-01", "1985-01", "1995-06"].map(ymIndex);
    for (const i of sigIdx) L[i] = 5.2;
    const r = new Float64Array(n).fill(0); r[0] = NaN; r[sigIdx[3] + 2] = 0.10; r[sigIdx[2] + 2] = -0.05; r[ymIndex("1975-06")] = 0.02;
    const A = analyze({ n, F, L }, { r }), dec = (i) => 10 * Math.floor((1962 + Math.floor(i / 12)) / 10);
    const okCell = (h, k) => {
      const c = A.cells[k], TRb = (i) => { if (i + 1 + h > n - 1) return NaN; let p = 1; for (let j = i + 2; j <= i + 1 + h; j++) p *= 1 + r[j]; return p - 1; };
      const Db = {}; for (let i = 0; i < n; i++) { const v = TRb(i); if (sigIdx.includes(i) || !Number.isFinite(v)) continue; (Db[dec(i)] = Db[dec(i)] || []).push(v); }
      const Xb = (i) => TRb(i) - mean(Db[dec(i)]);
      const v = [mean([Xb(sigIdx[0]), Xb(sigIdx[1])]) - COST, Xb(sigIdx[2]) - COST, Xb(sigIdx[3]) - COST];
      return c.h === h && c.c1.n === 3 && c.c1.tranches === 4 && v.every((x, q) => eq(c.c1.obs[q].v, x, 1e-12)) && eq(c.c1.mean, mean(v), 1e-12) && eq(c.c1.t, nwT(v), 1e-9)
        && c.nPre === 1 && c.nPost === 2 && eq(c.preMean, v[0], 1e-12) && eq(c.postMean, (v[1] + v[2]) / 2, 1e-12)
        && !!c.largest && c.largest.start === sigIdx[3] && eq(c.lloMean, (v[0] + v[1]) / 2, 1e-12) && eq(c.mean2x, mean(v) - (COST2X - COST), 1e-12)
        && Math.abs(mean(Db[1970]) - mean(Db[1980])) > 1e-4 && v[2] > v[0] && v[0] > v[1];
    };
    // and a level STEP: one 1.2 pt step at month 20 -> signal months 20..31 (12 of them) form one episode
    const Fs = new Float64Array(60), Ls = new Float64Array(60); for (let i = 0; i < 60; i++) { Fs[i] = 4; Ls[i] = i < 20 ? 4 : 5.2; }
    const As = analyze({ n: 60, F: Fs, L: Ls });
    checks.pipelineHandPath = A.sig.reduce((a, x) => a + x, 0) === 4 && sigIdx.every((i) => A.sig[i] === 1) && JSON.stringify(A.eps) === JSON.stringify([[sigIdx[0], sigIdx[1]], [sigIdx[2]], [sigIdx[3]]])
      && okCell(6, 0) && okCell(12, 1) && As.eps.length === 1 && As.eps[0][0] === 20 && As.eps[0].length === 12 && As.cells[0].c1.n === 1 && As.cells[1].c1.n === 1; }
  // (17) THE REGISTERED KNOWN ANSWER (readCondition): CM10 annual returns 1962-2025 vs Damodaran, corr >= 0.98
  const ka = knownAnswerCM10(data); checks.knownAnswerCM10 = ka.pass === true;
  const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
  return { pass: failed.length === 0, failed, checks, knownAnswer: ka, codeChecksPass: failed.filter((k) => k !== "knownAnswerCM10").length === 0 };
}

// ── --controls (OUTCOME-BLIND, N13) ───────────────────────────────────────────────────────────────────────────────────────────
function coverageOf(data, mo) {
  const empty = []; for (let i = 0; i < mo.n; i++) if (!(mo.nObs[i] > 0)) empty.push(ymOf(i));
  const tbMissing = []; for (let i = 0; i < M_ALL; i++) if (!Number.isFinite(data.tb3[i])) tbMissing.push(ymOf(i));
  const damMissing = []; for (let y = KA_FROM; y <= KA_TO; y++) if (!Number.isFinite(data.dam[y])) damMissing.push(y);
  const first = data.dgs[0].d, last = data.dgs[data.dgs.length - 1].d, minObs = Math.min(...Array.from(mo.nObs));
  const ok = { everyMonthHasObservations: empty.length === 0, firstObservation1962_01_02: first === FIRST_OBS, reachesSeptember2026: last >= "2026-09-24" && last <= WINDOW_END, tb3Complete: tbMissing.length === 0, damodaranComplete: damMissing.length === 0, positiveYields: data.dgs.every((r) => r.v > 0) };
  return { ok, all: Object.values(ok).every(Boolean), months: mo.n, observations: data.dgs.length, first, last, minObsPerMonth: minObs, emptyMonths: empty.slice(0, 10), tb3Missing: tbMissing.slice(0, 10), damodaranMissing: damMissing, feedLastBeyondWindow: data.dgsLastAll };
}
/** entry-time information only: signals, episodes, window completeness (N13) */
function episodeCounts(mo) {
  const sig = signalsOf(mo.L), eps = episodesOf(sig);
  const cells = HS.map((h) => { const ok = (i) => i + 1 + h <= mo.n - 1; const inCell = eps.filter((e) => e.some(ok)); return { h, episodes: inCell.length, tranches: inCell.reduce((a, e) => a + e.filter(ok).length, 0), minMet: inCell.length >= MIN_EP, pre1985: inCell.filter((e) => e[0] < ymIndex(SPLIT_YM)).length, post1985: inCell.filter((e) => e[0] >= ymIndex(SPLIT_YM)).length }; });
  return { signalMonths: sig.reduce((a, x) => a + x, 0), episodesAll: eps.length, episodes: eps.map((e) => ({ start: ymOf(e[0]), end: ymOf(e[e.length - 1]), signalMonths: e.length })), cells };
}
function controls(t) {
  const data = loadData(), computedAt = new Date().toISOString();
  if (!data.ok) return { test: ID, status: "NOT READY", ready: false, notReadyBecause: data.problems.map((x) => `DATA (operational, not a verdict): ${x}`), cannotMeasureReasons: [], dataPreconditions: { fetched: false }, codeSha: codeSha(), dataFingerprint: null, computedAt };
  log("R343 --controls: selftest (incl. the registered CM10 known answer)");
  const st = selftest(data), mo = monthsFromDaily(data.dgs), cov = coverageOf(data, mo), epc = episodeCounts(mo);
  log(`  coverage ${cov.all ? "complete" : "INCOMPLETE"}; ${epc.signalMonths} signal months in ${epc.episodesAll} episodes`);
  // no look-ahead: real signals (entry-time information) + donor paths
  const trunc = truncationCheck(data.dgs, mo);
  log(`  truncation invariance on the real series: ${trunc.checked} months, ${trunc.mismatches} mismatches`);
  // N14 scrambled-path null, full pipeline + every registered gate
  const L = { tNet: [[], []], graded: [], fullPass: 0, corePass: 0, cannot: 0, eps: [], meanNet: [[], []], truncOK: 0, truncChecked: 0, perMonth: [[], []], firstOnly: [[], []], firstOnlyT: [[], []], lenCorr: [[], []] };
  const gradedT = (A, v) => Math.max(...v.graded.map((i) => A.cells[i].c1.t));   // NaN if a graded cell's t is undefined
  const lenCorrOf = (obs) => { const x = obs.map((o) => o.signalMonths), y = obs.map((o) => o.v); return x.length >= 3 ? pearson(x, y) : NaN; };
  for (let rep = 1; rep <= LEAK_REPS; rep++) {
    const dp = donorPath(mo, mulberry(LEAK_SEED0 + rep)), { A, v } = fullRule(dp, `r343-leak|${rep}`);
    A.cells.forEach((c, k) => {
      L.tNet[k].push(c.c1.t); L.meanNet[k].push(c.c1.mean);
      L.perMonth[k].push(mean(c.c1.obs.flatMap((o) => o.months).map((i) => c.X[i])) - COST);
      const fo = cellOf(A.eps.map((e) => [e[0]]), c.X, COST); L.firstOnly[k].push(fo.mean); L.firstOnlyT[k].push(fo.t); L.lenCorr[k].push(lenCorrOf(c.c1.obs));
    });
    L.eps.push(A.eps.length); L.graded.push(gradedT(A, v));
    if (v.verdict === "PASS") L.fullPass++; else if (v.verdict === "CANNOT MEASURE") L.cannot++;
    const g = v.graded.map((i) => A.cells[i]); if (g.every((c) => c.c1.t >= BAR && c.c1.mean > 0 && c.c1.n >= MIN_EP)) L.corePass++;
    if (rep <= 20) { L.truncChecked++; if (truncationCheckMonthly(dp.L)) L.truncOK++; }
  }
  // the former permuted donor (disclosure only; decides nothing)
  const PM = { fullPass: 0, t: [[], []] };
  for (let rep = 1; rep <= LEAK_REPS; rep++) { const { A, v } = fullRule(donorPathPermuted(mo, mulberry(LEAK_SEED0 + rep)), `r343-leak|${rep}`); if (v.verdict === "PASS") PM.fullPass++; A.cells.forEach((c, k) => PM.t[k].push(c.c1.t)); }
  const leakCells = HS.map((h, k) => { const s = sortNum(L.tNet[k]); const medAbs = median(sortInf(L.tNet[k].map(Math.abs))); return { h, medianAbsNetT: r4(medAbs), gatePass: medAbs < LEAK_MED_MAX, netT_p5: r4(pIdx(s, 0.05)), netT_median: r4(median(s)), netT_p95: r4(pIdx(s, 0.95)), meanNet_median: r6(median(sortNum(L.meanNet[k]))), undefinedT: L.tNet[k].filter((x) => !Number.isFinite(x)).length,
    reportedOnly: { perMonthPooledMeanNet_median: r6(median(sortNum(L.perMonth[k]))), firstSignalMonthOnlyMeanNet_median: r6(median(sortNum(L.firstOnly[k]))), firstSignalMonthOnlyT_median: r4(median(sortNum(L.firstOnlyT[k]))), corrEpisodeLengthVsEpisodeMean_median: r4(median(sortNum(L.lenCorr[k]))), formerPermutedDonorNetT_median: r4(median(sortNum(PM.t[k]))) } }; });
  const fullFPR = L.fullPass / LEAK_REPS, coreFPR = L.corePass / LEAK_REPS;
  const leakOK = leakCells.every((c) => c.gatePass) && fullFPR <= FPR_MAX;
  log(`  scrambled null: ${LEAK_REPS} paths; full-rule false PASS ${L.fullPass}, core ${L.corePass}, CANNOT MEASURE ${L.cannot}; median |t| ${leakCells.map((c) => c.medianAbsNetT).join(" / ")}`);
  // N15 positive control: planted +0.75% in every CM10 month inside some signal month's 12-month window (signals from the unplanted path);
  // the same paths UNPLANTED (matched seeds); critical value = max(POS_T, the N14 null's p95 graded t)
  const nullGradedP95 = pIdx(sortNegInf(L.graded), 0.95), posCrit = Math.max(POS_T, nullGradedP95);
  const P = { t: [[], []], graded: [], pass: 0, zeroGraded: [], zeroPass: 0, lift: [], hits: 0 };
  for (let rep = 1; rep <= POS_REPS; rep++) {
    const dp = donorPath(mo, mulberry(POS_SEED0 + rep)), sig = signalsOf(dp.L), r0 = cm10Returns(dp.F), r = Float64Array.from(r0), lit = new Uint8Array(dp.n);
    for (let i = 0; i < dp.n; i++) if (sig[i]) for (let j = i + 2; j <= i + 1 + POS_WINDOW && j < dp.n; j++) lit[j] = 1;
    for (let j = 1; j < dp.n; j++) if (lit[j]) r[j] += POS_DELTA;
    const { A, v } = fullRule(dp, `r343-positive|${rep}`, { r }), Z = fullRule(dp, `r343-positive|${rep}`, { r: r0 });
    const gp = gradedT(A, v), gz = gradedT(Z.A, Z.v);
    A.cells.forEach((c, k) => P.t[k].push(c.c1.t)); P.graded.push(gp); P.zeroGraded.push(gz);
    if (Number.isFinite(gp) && Number.isFinite(gz)) P.lift.push(gp - gz);
    if (Number.isFinite(gp) && gp >= posCrit) P.hits++;
    if (v.verdict === "PASS") P.pass++; if (Z.v.verdict === "PASS") P.zeroPass++;
  }
  const posMed = median(sortNegInf(P.graded)), zeroMed = median(sortNegInf(P.zeroGraded));
  const posOK = Number.isFinite(posCrit) && posMed >= posCrit && zeroMed < posCrit;
  log(`  positive control: ${POS_REPS} planted paths, median graded t ${r4(posMed)} vs critical value ${r4(posCrit)} (null p95 ${r4(nullGradedP95)}); unplanted (matched) median ${r4(zeroMed)}; full-rule PASS planted ${P.pass}/${POS_REPS}, unplanted ${P.zeroPass}/${POS_REPS}`);
  // READY logic (N13-N15): registered CANNOT MEASURE reasons vs house gates vs data
  const dataProblems = [];
  if (!cov.all) dataProblems.push(`coverage: ${Object.entries(cov.ok).filter(([, v]) => !v).map(([k]) => k).join(", ")}`);
  const cannotMeasure = [];
  if (!st.knownAnswer.pass) cannotMeasure.push(`CM10 known answer: corr ${st.knownAnswer.corr} (need >= ${CORR_MIN}), years ${st.knownAnswer.years}/${st.knownAnswer.expectedYears}${st.knownAnswer.reason ? `, ${st.knownAnswer.reason}` : ""}`);
  if (epc.cells.every((c) => !c.minMet)) cannotMeasure.push(`< ${MIN_EP} episodes in both cells (${epc.cells.map((c) => `h=${c.h}: ${c.episodes}`).join(", ")})`);
  const house = [];
  if (!st.codeChecksPass) house.push(`selftest code checks failed: ${st.failed.filter((k) => k !== "knownAnswerCM10").join(", ")}`);
  if (!trunc.pass) house.push(`look-ahead: ${trunc.mismatches} truncation mismatches (${trunc.examples.join("; ")})`);
  if (L.truncOK !== L.truncChecked) house.push(`look-ahead on donor paths: ${L.truncChecked - L.truncOK} of ${L.truncChecked} failed`);
  if (!leakOK) house.push(`scrambled-path null (N14): ${leakCells.filter((c) => !c.gatePass).map((c) => `h=${c.h} median|t| ${c.medianAbsNetT} >= 2`).join("; ") || "median |t| ok"}; full-rule false-PASS ${L.fullPass}/${LEAK_REPS} = ${r4(fullFPR)} (limit ${FPR_MAX})`);
  if (!posOK) house.push(`positive control (N15): planted median graded t ${r4(posMed)} ${posMed >= posCrit ? ">=" : "<"} critical value ${r4(posCrit)} (max(${POS_T}, N14 null p95 graded t ${r4(nullGradedP95)})); unplanted matched median ${r4(zeroMed)} ${zeroMed < posCrit ? "<" : ">="} it`);
  const status = dataProblems.length ? "NOT READY" : cannotMeasure.length ? "CANNOT MEASURE" : house.length ? "NOT READY" : "READY";
  const notes = [];
  const counts = epc.cells.map((c) => c.episodes);
  if (counts.some((x) => x >= MIN_EP) && counts.some((x) => x < MIN_EP)) notes.push(`N6 binds: one cell is below ${MIN_EP} episodes (${epc.cells.map((c) => `h=${c.h}: ${c.episodes}`).join(", ")}); if it carries the higher t the read is CANNOT MEASURE under N6 (the registry leaves this open)`);
  else notes.push(`N6's minimum-count reading is moot for the count: both cells have ${counts.every((x) => x >= MIN_EP) ? ">=" : "<"} ${MIN_EP} episodes (${epc.cells.map((c) => `h=${c.h}: ${c.episodes}`).join(", ")}); the 'higher t' reading (net at 1x cost, chosen once) still applies`);
  return {
    test: ID, status, ready: status === "READY",
    notReadyBecause: [...dataProblems.map((x) => `DATA (operational, not a verdict): ${x}`), ...cannotMeasure.map((x) => `CANNOT MEASURE (registered): ${x}`), ...house.map((x) => `HOUSE GATE (not a verdict; reported to the main loop): ${x}`)],
    cannotMeasureReasons: cannotMeasure, dataPreconditions: { fetched: true, coverageComplete: cov.all }, houseGateFailures: house, notes,
    codeSha: codeSha(), dataFingerprint: data.fingerprint, computedAt,
    outcomeBlind: "N13: no tranche TR, X, D or random-month draw was computed on the real series; real data entered only as signals/episodes/window counts, coverage, truncation invariance and the registered CM10 known answer (summarised)",
    selftest: { pass: st.pass, failed: st.failed, nChecks: Object.keys(st.checks).length, codeChecksPass: st.codeChecksPass, knownAnswerCM10: st.knownAnswer },
    coverage: cov, episodes: epc,
    noLookAhead: { real: trunc, donorPaths: { checked: L.truncChecked, pass: L.truncOK } },
    scrambledNull: { reportedConstruction: "N14: real month blocks (within-month log change, month-boundary log change) drawn iid with replacement, demeaned; full pipeline and every registered gate (random months 1,000 draws per cell per path)", replications: LEAK_REPS, seeds: `mulberry(${LEAK_SEED0} + r); random months fnv1a('r343-leak|<r>|h=<h>')`, gate: leakOK, fullRuleFalsePasses: L.fullPass, fullRuleFalsePassRate: r4(fullFPR), formerPermutedDonorFullRuleFalsePasses: PM.fullPass, coreFalsePasses: L.corePass, coreFalsePassRate: r4(coreFPR), cannotMeasurePaths: L.cannot, episodesPerPath: { median: median(sortNum(L.eps)), p5: pIdx(sortNum(L.eps), 0.05), p95: pIdx(sortNum(L.eps), 0.95) }, cells: leakCells },
    positiveControl: { construction: `N15: +${POS_DELTA} per CM10 month inside any signal month's ${POS_WINDOW}-month window, on ${POS_REPS} scrambled paths (mulberry(${POS_SEED0} + r)); the same paths unplanted (matched seeds); critical value max(${POS_T}, N14 null p95 graded t, undefined t = -Infinity)`, gate: posOK,
      medianGradedT: r4(posMed), criticalValue: r4(posCrit), nullGradedTP95: r4(nullGradedP95), nullGradedTMedian: r4(median(sortNegInf(L.graded))), unplantedMatchedMedianGradedT: r4(zeroMed), medianLiftPlantedMinusUnplanted: r4(median(sortNum(P.lift))),
      plantedPathsAtOrAboveCritical: P.hits, medianTByCell: HS.map((h, k) => ({ h, medianT: r4(median(sortNegInf(P.t[k]))) })), fullRulePasses: P.pass, unplantedFullRulePasses: P.zeroPass, replications: POS_REPS,
      formerGateReportedOnly: { rule: `planted median graded t >= ${POS_T} (replaced 2026-10-08, see N15)`, planted: posMed >= POS_T, unplanted: zeroMed >= POS_T } },
  };
}

// ── --read (the ONE registered read) ──────────────────────────────────────────────────────────────────────────────────────────
const SEAL_NOTE = "docs/server/seal-gated.cjs <backend> R343 r343-read.json: re-derives the verdict from gates + verdictScript and compares o.bar with bar.tRequired (2.658). The read-test ritual seals it the same day (readCondition); this runner never seals.";
function cannotMeasureRecord(t, ctl, data) {
  return { read: true, test: ID, readAt: new Date().toISOString(), codeSha: codeSha(), dataFingerprint: data.fingerprint, outcomesComputed: false, bar: BAR, barField: "bar.tRequired", sealNote: SEAL_NOTE,
    unit: "episodes", n: null, trades: null, tNet: null, meanNet: null, winRatePct: null, gradedCell: null,
    gates: { selftestPassed: ctl.selftest.knownAnswerCM10.pass === true && ctl.selftest.codeChecksPass === true, minEpisodes: ctl.episodes.cells.some((c) => c.minMet) },
    verdictScript: `CANNOT MEASURE — no tranche return computed; because: ${ctl.cannotMeasureReasons.join("; ")} (registered decisionRule.cannotMeasure, decided by --controls ${ctl.computedAt})`,
    controls: { computedAt: ctl.computedAt, episodes: ctl.episodes.cells, knownAnswerCM10: ctl.selftest.knownAnswerCM10 } };
}
function readOnce(t, ctl, data) {
  const st = selftest(data); if (!st.pass) throw new Error(`selftest no longer passes (${st.failed.join(", ")}) — re-run --controls (nothing written)`);
  const mo = monthsFromDaily(data.dgs);
  const A = analyze(mo, { randomMonths: true });
  const v = assembleVerdict(A.cells, st.pass);
  const bm = billMonthly(data.tb3);
  const rep = A.cells.map((c) => {
    const h = c.h, tr = cellOf(A.eps, c.TRa, COST), first = cellOf(A.eps.map((e) => [e[0]]), c.X, COST);
    const lagTR = compoundArray(A.r, h, 1), lagBase = decadeBase(A.sig, lagTR), lagX = excessOf(lagTR, lagBase), lag = cellOf(A.eps, lagX, COST);
    const bill = compoundArray(bm, h, 0), zn = Float64Array.from(c.TRa, (x, i) => x - bill[i]), znc = cellOf(A.eps, zn, ZN_RT_USD / ZN_FACE);
    const gross = cellOf(A.eps, c.X, 0);
    return {
      h, episodes: c.c1.n, tranches: c.c1.tranches, meanNet: r6(c.c1.mean), meanNetPct: r4(100 * c.c1.mean), tNet: r4(c.c1.t), meanGross: r6(gross.mean), tGross: r4(gross.t), meanNet2x: r6(c.mean2x), tNet2x: r4(c.t2x),
      winRatePct: r2(c.c1.n ? (100 * c.c1.obs.filter((q) => q.v > 0).length) / c.c1.n : NaN),
      randomMonths: c.rm ? { p95: r6(c.rm.p95), p95Exact: c.rm.p95, median: r6(c.rm.median), draws: c.rm.draws, finiteDraws: c.rm.finiteDraws, seed: `mulberry(fnv1a('${c.rm.seedLabel}'))` } : null,
      prePost1985: { preMean: r6(c.preMean), nPre: c.nPre, postMean: r6(c.postMean), nPost: c.nPost },
      leaveLargestOut: { removed: c.largest ? { start: ymOf(c.largest.start), meanNet: r6(c.largest.v) } : null, meanRest: r6(c.lloMean) },
      decadeBaselineD: Object.fromEntries([...c.base.D].map(([d, x]) => [`${d}s`, { D: r6(x), nonSignalMonths: c.base.cnt.get(d) }])),
      gates: v.perCell[A.cells.indexOf(c)],
      reported: {
        rawTR: { meanNet: r6(tr.mean), tNet: r4(tr.t), episodes: tr.n, note: "no decade adjustment (registered 'raw TR_h reported beside')" },
        firstSignalMonthOnly: { meanNet: r6(first.mean), tNet: r4(first.t), episodes: first.n },
        entryOneMonthLater: { meanNet: r6(lag.mean), tNet: r4(lag.t), episodes: lag.n, note: "N12: D recomputed on the lagged windows" },
        znExcessOverBills: { meanNetOfZnCost: r6(znc.mean), tNet: r4(znc.t), episodes: znc.n, note: "N9: TR_h - TB3MS bill return, $20 per $100,000 face" },
        eachEpisode: c.c1.obs.map((q) => ({ start: ymOf(q.start), end: ymOf(q.end), signalMonths: q.signalMonths, tranchesInCell: q.months.length, meanNetExcess: r6(q.v), meanRawTR: r6(mean(q.months.map((i) => c.TRa[i]))), meanZnExcess: r6(mean(q.months.map((i) => zn[i]))) })),
      },
      _tranches: tranchesOf(c, h, bill),
    };
  });
  const g = v.graded, G = rep[g[0]], tGrossPick = rep[0].tGross > rep[1].tGross ? 0 : 1;
  const barN = barAt(Math.max(3, G.episodes));
  const money = (k) => ({ usd10k: dollarTable(rep[k]._tranches, A.r, bm, "usd10k"), zn1: dollarTable(rep[k]._tranches, A.r, bm, "zn1"), usd10kExcess: dollarTable(rep[k]._tranches, A.r, bm, "usd10kExcess") });
  const out = {
    read: true, test: ID, readAt: new Date().toISOString(), codeSha: codeSha(), dataFingerprint: data.fingerprint,
    bar: BAR, barField: "bar.tRequired", sealNote: SEAL_NOTE,
    unit: "episodes", n: G.episodes, trades: G.tranches, tNet: G.tNet, meanNet: G.meanNet, winRatePct: G.winRatePct,
    gradedCell: g.map((k) => `h=${rep[k].h}m`).join(" + "), gates: v.gates, verdictScript: v.verdictScript,
    gradedCellReading: { rule: "N6 (registry leaves it open; NOT settled by the 2026-10-08 amendment): higher NET t at 1x cost, chosen once; every gate and the 10-episode minimum on that cell; graded < 10 -> CANNOT MEASURE; 3-decimal tie grades both", grossTWouldPick: `h=${rep[tGrossPick].h}m`, sameAsNet: g.length === 2 || tGrossPick === g[0] },
    barAtActualN: { reportedOnly: true, decidesNothing: true, ...barN, note: "the registration's method at the graded cell's actual episode count (bar.method: reported beside the contract bar 2.658)" },
    cells: rep.map(({ _tranches, ...x }) => x),
    unitsNote: "meanNet / tNet are excess total return over h months per episode (decimal: 0.01 = 1%), net of 2 bps per tranche",
    knownAnswerCM10: st.knownAnswer,
    controls: { computedAt: ctl.computedAt, scrambledNull: { gate: ctl.scrambledNull.gate, fullRuleFalsePassRate: ctl.scrambledNull.fullRuleFalsePassRate, coreFalsePassRate: ctl.scrambledNull.coreFalsePassRate, cells: ctl.scrambledNull.cells }, positiveControl: { gate: ctl.positiveControl.gate, medianGradedT: ctl.positiveControl.medianGradedT, criticalValue: ctl.positiveControl.criticalValue, unplantedMatchedMedianGradedT: ctl.positiveControl.unplantedMatchedMedianGradedT }, noLookAhead: ctl.noLookAhead.real.pass },
    dollarTable: { convention: t.dollarTable.convention, gradedCell: money(g[0]), ...(g.length === 2 ? { secondGradedCell: money(g[1]) } : { otherCellReportedOnly: money(1 - g[0]) }) },
  };
  return out;
}

// ── --fetch (public data downloads only) ──────────────────────────────────────────────────────────────────────────────────────
async function fetchAll() {
  fs.mkdirSync(TR, { recursive: true });
  const meta = { fetchedAt: new Date().toISOString(), by: "r343-yield-spike-bonds.js --fetch (public data GETs)", files: {} };
  for (const [id, f] of [["DGS10", F_DGS10], ["TB3MS", F_TB3MS]]) {
    const res = await fetch(URL_FRED(id), { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`FRED ${id}: HTTP ${res.status}`);
    const text = await res.text(), rows = parseFredCsv(id, text);
    writeTextAtomic(f, text);
    meta.files[path.basename(f)] = { url: URL_FRED(id), bytes: Buffer.byteLength(text), sha256: sha256(text), rows: rows.length, first: rows[0].d, last: rows[rows.length - 1].d };
    log(`fetched ${id}: ${rows.length} values ${rows[0].d}..${rows[rows.length - 1].d}`);
  }
  const res = await fetch(URL_DAM, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Damodaran: HTTP ${res.status}`);
  const html = await res.text(), p = parseDamodaran(html), years = Object.keys(p.returns).map(Number).sort((a, b) => a - b);
  writeJsonAtomic(F_DAM, { source: "Aswath Damodaran, Historical Returns on Stocks, Bonds and Bills (histretSP.html)", url: URL_DAM, fetchedAt: meta.fetchedAt, htmlSha256: sha256(html), htmlBytes: Buffer.byteLength(html), column: DAM_COL, columnIndex: p.column, header: p.header, years: [years[0], years[years.length - 1]], returns: p.returns });
  meta.files[path.basename(F_DAM)] = { url: URL_DAM, htmlBytes: Buffer.byteLength(html), htmlSha256: sha256(html), years: years.length, first: years[0], last: years[years.length - 1] };
  writeJsonAtomic(F_META, meta);
  log(`fetched Damodaran "${DAM_COL}": ${years.length} years ${years[0]}..${years[years.length - 1]} (values not printed)`);
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function printControls(c) {
  console.log(`\n=== R343 --controls: ${c.status} ===`);
  if (c.notReadyBecause.length) console.log(`  because: ${c.notReadyBecause.join(" | ")}`);
  if (!c.selftest) return;
  console.log(`  code sha ${c.codeSha.slice(0, 16)}  data fingerprint ${String(c.dataFingerprint).slice(0, 16)}`);
  const ka = c.selftest.knownAnswerCM10;
  console.log(`  selftest: ${c.selftest.pass ? "PASS" : "FAIL"} (${c.selftest.nChecks} checks${c.selftest.failed.length ? `; failed ${c.selftest.failed.join(", ")}` : ""}); CM10 known answer corr ${ka.corr} over ${ka.years} years ${ka.from}-${ka.to} (need >= ${ka.threshold}; mean |diff| ${ka.meanAbsDiff}, max |diff| ${ka.maxAbsDiff})`);
  console.log(`  coverage: ${c.coverage.all ? "complete" : "INCOMPLETE"} — ${c.coverage.observations} DGS10 values ${c.coverage.first}..${c.coverage.last} in ${c.coverage.months} months (min ${c.coverage.minObsPerMonth}/month); ${JSON.stringify(c.coverage.ok)}`);
  console.log(`  episodes (entry-time information): ${c.episodes.signalMonths} signal months, ${c.episodes.episodesAll} episodes; ${c.episodes.cells.map((x) => `h=${x.h}: ${x.episodes} episodes / ${x.tranches} tranches (pre-1985 ${x.pre1985}, post ${x.post1985}; min ${MIN_EP} met ${x.minMet})`).join("; ")}`);
  console.log(`    starts: ${c.episodes.episodes.map((e) => `${e.start}(${e.signalMonths})`).join(" ")}`);
  console.log(`  no look-ahead: real ${c.noLookAhead.real.checked} months, ${c.noLookAhead.real.mismatches} mismatches (pass ${c.noLookAhead.real.pass}); donor paths ${c.noLookAhead.donorPaths.pass}/${c.noLookAhead.donorPaths.checked}`);
  const s = c.scrambledNull;
  console.log(`  scrambled-path null (N14, ${s.replications} paths): gate ${s.gate}; full-rule false PASS ${s.fullRuleFalsePasses} (${s.fullRuleFalsePassRate}); core (t>=bar & mean>0) ${s.coreFalsePasses} (${s.coreFalsePassRate}); CANNOT MEASURE paths ${s.cannotMeasurePaths}; episodes/path median ${s.episodesPerPath.median} [${s.episodesPerPath.p5}, ${s.episodesPerPath.p95}]`);
  console.log(`    former permuted donor (disclosure, decides nothing): full-rule false PASS ${s.formerPermutedDonorFullRuleFalsePasses}/${s.replications}`);
  for (const x of s.cells) console.log(`    h=${x.h}: reported only — per-MONTH pooled mean net ${x.reportedOnly.perMonthPooledMeanNet_median}; first-signal-month-only mean net ${x.reportedOnly.firstSignalMonthOnlyMeanNet_median} (median t ${x.reportedOnly.firstSignalMonthOnlyT_median}); median corr(episode length, episode mean) ${x.reportedOnly.corrEpisodeLengthVsEpisodeMean_median}; former permuted donor median t ${x.reportedOnly.formerPermutedDonorNetT_median}`);
  for (const x of s.cells) console.log(`    h=${x.h}: median |net t| ${x.medianAbsNetT} (< 2: ${x.gatePass}); net t p5/median/p95 ${x.netT_p5}/${x.netT_median}/${x.netT_p95}; median mean net ${x.meanNet_median}; undefined t ${x.undefinedT}`);
  const p = c.positiveControl;
  console.log(`  positive control (N15): gate ${p.gate}; planted median graded t ${p.medianGradedT} vs critical value ${p.criticalValue} (max(${POS_T}, N14 null p95 graded t ${p.nullGradedTP95}; null median ${p.nullGradedTMedian})); unplanted matched median ${p.unplantedMatchedMedianGradedT}; median lift ${p.medianLiftPlantedMinusUnplanted}; planted paths >= critical ${p.plantedPathsAtOrAboveCritical}/${p.replications}`);
  console.log(`    by cell ${p.medianTByCell.map((x) => `h=${x.h} ${x.medianT}`).join(", ")}; full-rule PASS planted ${p.fullRulePasses}/${p.replications}, unplanted ${p.unplantedFullRulePasses}/${p.replications}; former gate (median >= ${POS_T}, reported only): planted ${p.formerGateReportedOnly.planted}, unplanted ${p.formerGateReportedOnly.unplanted}`);
  for (const n of c.notes) console.log(`  note: ${n}`);
  console.log(`  => R343 ${c.status}`);
}
async function main() {
  if (!MODE) { console.log("usage: --fetch | --selftest | --controls | --read [--cannot-measure]"); process.exit(2); }
  const t = registryEntry(), rc = registryChecks(t);
  if (rc.length) { console.error(`R343 registry text drifted from this runner — refusing:\n  ${rc.join("\n  ")}`); process.exit(2); }
  if (MODE === "--fetch") return fetchAll();
  if (MODE === "--selftest") {
    const data = loadData(), st = selftest(data);
    for (const [k, v] of Object.entries(st.checks)) console.log(`  ${v === true ? "ok  " : "FAIL"} ${k}`);
    const ka = st.knownAnswer; console.log(`  CM10 known answer: ${ka.reason ? ka.reason : `corr ${ka.corr} over ${ka.years}/${ka.expectedYears} years ${ka.from}-${ka.to} (need >= ${ka.threshold}); mean diff ${ka.meanDiff}, mean |diff| ${ka.meanAbsDiff}, max |diff| ${ka.maxAbsDiff}`}`);
    fs.mkdirSync(TR, { recursive: true });
    writeJsonAtomic(SELFTEST_REC, { test: ID, ranAt: new Date().toISOString(), codeSha: codeSha(), dataFingerprint: data.ok ? data.fingerprint : null, pass: st.pass, failed: st.failed, checks: st.checks, knownAnswerCM10: ka });
    console.log(`R343 selftest: ${st.pass ? "PASS" : "FAIL"} (${Object.keys(st.checks).length} checks${st.failed.length ? `; failed: ${st.failed.join(", ")}` : ""})`);
    process.exit(st.pass ? 0 : 1);
  }
  if (MODE === "--controls") {
    log("R343 --controls (outcome-blind)");
    const c = controls(t);
    writeJsonAtomic(CONTROLS, c);
    printControls(c);
    return;
  }
  // --read
  if (fs.existsSync(OUTF)) { console.error(`R343 already read (${path.basename(OUTF)} exists) — read once`); process.exit(2); }
  const seals = fs.existsSync(D("read-seals.json")) ? readJson(D("read-seals.json")) : {};
  if (seals.tests && seals.tests[ID]) { console.error("R343 is sealed — refusing"); process.exit(2); }
  const ctl = fs.existsSync(CONTROLS) ? readJson(CONTROLS) : null;
  if (!ctl) { console.error("no --controls record — run --controls first"); process.exit(2); }
  if (ctl.codeSha !== codeSha()) { console.error(`--controls was recorded under code sha ${String(ctl.codeSha).slice(0, 12)}, this file is ${codeSha().slice(0, 12)} — re-run --controls`); process.exit(2); }
  const data = loadData();
  if (!data.ok || data.fingerprint !== ctl.dataFingerprint) { console.error("data fingerprint differs from the --controls run (or data missing) — re-run --controls (nothing computed)"); process.exit(2); }
  if (ctl.status === "CANNOT MEASURE") {
    if (!argv.includes("--cannot-measure")) { console.error(`--controls says CANNOT MEASURE under the registered rule: ${ctl.cannotMeasureReasons.join("; ")}\n  To record that verdict (outcome-free; consumes the one read) re-run with --cannot-measure. Nothing written.`); process.exit(2); }
    const rec = cannotMeasureRecord(t, ctl, data); writeJsonAtomic(OUTF, rec);
    console.log(`R343: ${rec.verdictScript}\n  written ${path.relative(path.join(__dirname, ".."), OUTF)} — seal through the read-test ritual`); return;
  }
  if (argv.includes("--cannot-measure")) { console.error(`--cannot-measure refused: --controls status is ${ctl.status}`); process.exit(2); }
  if (ctl.status !== "READY") { console.error(`--controls says ${ctl.status}: ${ctl.notReadyBecause.join(" | ")} — nothing computed`); process.exit(2); }
  log("R343 --read: the ONE registered read");
  const out = readOnce(t, ctl, data);
  writeJsonAtomic(OUTF, out);
  console.log(`R343: ${out.verdictScript}`);
  console.log(`  gates: ${JSON.stringify(out.gates)}`);
  console.log(`  bar at the actual n (reported only): ${JSON.stringify(out.barAtActualN)}`);
  console.log(`  $ table (graded cell): ${JSON.stringify(out.dollarTable.gradedCell)}`);
  console.log(`  written ${path.relative(path.join(__dirname, ".."), OUTF)} — seal through the read-test ritual (see sealNote)`);
}
if (require.main === module) main().catch((e) => { console.error("R343 runner error:", e && e.stack ? e.stack : e); process.exit(1); });
module.exports = { analyze, priceOf, cm10Returns, compoundArray, signalsOf, episodesOf, decadeBase, excessOf, cellOf, randomMonths, assembleVerdict, cellGates, dollarTable, nwT, barAt, selftest, truncationCheck, donorPath, billMonthly, monthsFromDaily };
