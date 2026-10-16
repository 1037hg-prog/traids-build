#!/usr/bin/env node
/** R310 dated amendment (2026-10-02) — PRE-EVIDENCE: no statistic of the real R310 trades has been computed; only scrambles, bar-level
 *  data and the winners-only positive control were run. Two reviewers found the REGISTERED decision rule cannot fail: the matched
 *  placebo (same symbol, same month, the trade's own hold) draws windows that contain the trade's own dip and inherits its
 *  path-dependent hold, so it was beaten by 60/60 drift-kept and 20/20 drift-free NO-EDGE scrambles; and no gate removed per-symbol drift
 *  or survivorship, so the full registered rule returned PASS on 60/60 drift-kept scrambles. The registrar's (my) design error. The
 *  amendment adopts the calibrated set (1.7% false pass on the same 60 scrambles, leave-one-out), drops trades spanning the feed's
 *  synthetic halt bars, and restates the bar at the n the data actually give (SIP starts 2016-01-04 -> 120 months).
 *  Refuses if R310 is sealed, already read, or already carries runnerGates. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R310");
if (!t) throw new Error("no R310");
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {}).R310) throw new Error("R310 sealed — amendment illegal");
if (fs.existsSync(D("r310-qs-rsi5.json")) && JSON.parse(fs.readFileSync(D("r310-qs-rsi5.json"), "utf8")).read) throw new Error("R310 already read — amendment illegal");
if ((t.amendments || []).some((a) => Array.isArray(a.runnerGates))) throw new Error("already amended");
const ctrl = JSON.parse(fs.readFileSync(D("r310-controls.json"), "utf8"));
// the bar at the n the data give, by the registration's own method (register-r310.js: NW lag-1 t on iid noise, seed 310, 50,000 trials)
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return m / Math.sqrt(v / n); }
const N = 120, rng = mulberry(310), T = 50000, mx = []; for (let k = 0; k < T; k++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); mx.push(nwT(s)); }
mx.sort((a, b) => a - b); const BAR = +mx[Math.floor(0.95 * T)].toFixed(3);
const was = { placebo: t.controls.placebo, pass: t.decisionRule.pass, bar: t.bar.tRequired, barSource: t.bar.source, nExpected: t.nExpected };
t.controls.placebo = `AMENDED 2026-10-02 (pre-evidence): CORRECTED matched placebo — for each real trade a random day of the same symbol in the same month (widened +-1 month if none) with close > SMA200, no entry signal, no synthetic halt bar, and a window DISJOINT from the real trade's [t-3, u]; the hold is drawn from OTHER symbols' real holds (independent of this path); 0.10% cost; 500 draws. GATE: Newey-West (lag 1) t of the monthly paired difference (real minus corrected placebo) >= the bar. The registered same-month/own-hold placebo is still computed and REPORTED, labelled uncalibrated.`;
t.controls.driftFloor = `AMENDED 2026-10-02 (pre-evidence): R150's drift-kept floor — the rule run on 60 drift-KEPT within-symbol bar shuffles (no timing edge, drift and survivorship kept). GATE: real mean net per month > floor p95 AND Newey-West t of (real monthly series minus floor p50) >= the bar.`;
t.controls.haltBars = "AMENDED 2026-10-02 (pre-evidence): trades whose hold spans a synthetic halt bar of the feed (volume 0 and O=H=L=C, e.g. SMCI 2018-08..2020-01, NBIS 2022-02..2024-08) are reported, not counted — those bars are not prices.";
t.decisionRule.pass = `PASS only if >= 100 trades over >= 36 months AND mean net per month > 0 AND t_NW >= ${BAR} AND the corrected-placebo paired t >= ${BAR} AND the drift-kept floor gate clears (mean > floor p95 AND t of real minus floor p50 >= ${BAR}) AND both halves are positive AND the next-open mean is > 0 AND the leak test and the positive control passed (synthetic-halt-spanning trades excluded throughout). A PASS adopts nothing: it proposes an R310 arm on R151's successor paper runner (signal at ~15:40 ET, day market order — not market-on-close, which paper does not fill) — the operator's call.`;
t.bar.tRequired = BAR; t.bar.source = `AMENDED 2026-10-02 (pre-evidence): NW(lag 1) t on zero-mean iid noise at the n the data give, n=${N} months (Alpaca SIP starts 2016-01-04, first SMA200 2016-10-17), 50,000 trials, seed 310, p95 = ${BAR}; was ${was.bar} at n=129`;
t.nExpected = N;
(t.amendments ||= []).push({ date: "2026-10-02", preEvidence: true, field: "controls.placebo / controls.driftFloor / controls.haltBars / decisionRule.pass / bar.tRequired / nExpected", was,
  becomes: { placebo: t.controls.placebo, driftFloor: t.controls.driftFloor, haltBars: t.controls.haltBars, pass: t.decisionRule.pass, bar: BAR, nExpected: N },
  why: `Pre-read review of the runner (two independent reviewers + a final reviewer, 2026-10-02) showed the registered decision rule cannot fail: the registered placebo was beaten by every no-edge scramble (60/60 drift-kept, 20/20 drift-free) because its windows contain the trade's own dip and its hold comes from the trade's own path; and with no drift gate the FULL registered rule returned PASS on 60/60 drift-kept scrambles (t 2.95-7.94). The amended set (corrected paired placebo + drift-kept floor) false-passes 1.7% of the same 60 scrambles (leave-one-out). Floor on this cache (excl. halt-spanning): p50 ${ctrl.calibration && ctrl.calibration.floor ? JSON.stringify(ctrl.calibration.floor).slice(0, 160) : "see r310-controls.json"}. Disclosed: the registrar's design error, corrected after scramble calibration only; NO statistic of the real trades has been computed. Synthetic halt bars: 995 in the cache (NBIS 622, SMCI 349, VRT 22, XLRE 2). Operator 2026-10-02: 'test it'.`,
  runnerGates: ["placebo:corrected-paired-t", "floor:drift-kept", "trades:exclude-halt-spanning"] });
t.status = `REGISTERED 2026-10-02 (gate amendment 2026-10-02, pre-evidence) — historical, read once; runner built and reviewed`; t.writerExists = true;
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-10-02", area: "registry — R310 gate amendment (pre-evidence)", category: "registration", breaksComparability: false,
  change: `R310 pre-read amendment: the registered matched placebo (cleared by 100% of no-edge scrambles) becomes a reported line; gates become the corrected paired placebo t + R150's drift-kept floor (1.7% false pass on 60 drift-kept scrambles); trades spanning synthetic halt bars excluded; bar restated ${was.bar} -> ${BAR} at the actual n=120 months.`,
  why: "Two reviewers + a final reviewer found the registered rule could not fail; registrar's design error; no real-trade statistic computed. Operator 2026-10-02: 'test it'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-02" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-evidence", tests: ["R310"], detail: `placebo -> corrected paired t; + drift-kept floor; halt-spanning excluded; bar ${was.bar} -> ${BAR} (n 120)` }) + "\n");
console.log(`R310 amended · bar ${was.bar} -> ${BAR} · runnerGates ${JSON.stringify(t.amendments[t.amendments.length - 1].runnerGates)}`);
