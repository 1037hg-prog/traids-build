#!/usr/bin/env node
/**
 * R211 — SELECTION-LUCK FILTER. Does a luck-adjusted skill score pick AlphaInsider's next-3-month winners better than the raw
 * leaderboard? Registered 2026-09-24 (family LUCK-2: historical and forward legs read separately; one scoring rule, no variants)
 * BEFORE this file existed; rule, statistic, bar (2.112), controls and read condition are frozen in data/test-registry.json
 * (preregistered[id=R211]). Built 2026-09-24. No AlphaInsider outcome has been computed by this file.
 *
 * MACHINERY: lib/selection-luck.js (random-timing null, skill score, luck line, Storey q, sign-flip max-Sharpe null, market-relative)
 * and R188's reconstruction (r188-ai-persistence.js: classification, ledger, drift gate, price check, marking, month-end points,
 * backfill gate) — imported, not duplicated. Never calls the AlphaInsider API; prices come from R188's cache (Alpaca SIP split-
 * adjusted / Coinbase daily).
 *
 * RULE (registry, summarised): at each month-end t, strategies with >= 6 months of history (historical leg: single-symbol, R188's
 * reconstruction and drift gate). SKILL SCORE: A = 6-month return minus buy-and-hold of its asset; 500 same-asset random-timing
 * paths with the same time-in-market and switch count; pLuck = share with asset-relative >= A; z = probit(1 - pLuck) capped +/-3.5.
 * RAW SCORE: 6-month raw return. OUTCOME: next-3-month asset-relative return. STATISTIC: per month, mean outcome of the top decile
 * by z minus mean outcome of the top decile by raw; t over months, Newey-West lag 2. BAR t >= 2.112. CONTROLS: shuffle (z shuffled
 * within month, 200 draws, median |t| < 2), peek (rank by the realised outcome, must clear the bar), nullCalibration (zero-skill
 * synthetic universe, pLuck ~ uniform, KS p > 0.05).
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed):
 *  N1. Population, drift gate, price check, marking and month-end points are R188's (its header N1-N9). As in R188, >= 1 trade at or
 *      before t is required (a strategy that never traded has no timing to score; R211 says "reconstructed exactly as R188 does").
 *      History: created_at <= the t-6 point's close instant. Points needed at t-6, t and t+3; positive values at t-6 and t.
 *  N2. Daily formation series = R188's marked points strictly after the t-6 point up to and including the t point. Strategy day
 *      return v_d/v_{d-1} - 1; asset c_d/c_{d-1} - 1; POSITION carried into day d = H_{d-1} x c_{d-1} / v_{d-1} (holdings at the
 *      previous close as a fraction of value; sign = direction). A day with v_{d-1} <= 0 has no defined exposure -> strategy skipped
 *      that month (counted).
 *  N3. The null (lib N: randomTimingNull) matches time-in-market (days with non-zero carried position) and switch count (in/out
 *      changes), and ALSO the strategy's short share of in-market days and its mean |exposure| (leverage) — random timing, everything
 *      else the same. A long<->short flip without a flat day is not a "switch" (disclosed). A = R188's point-based asset-relative
 *      score (identical to compounding the daily returns). The null carries no fees; the strategy's own path does (conservative,
 *      AlphaInsider fees are <= 0.25%/side). Seeds: FNV-1a of "<id>|<t>".
 *  N4. pLuck uses mid-p for exact ties (degenerate nulls give 0.5); identical to the registered share when nothing ties.
 *  N5. Breadth: a month enters only with N >= 50 (R188's MIN_BREADTH). k = floor(N/10) for both top deciles. Sorts are descending by
 *      score with ties broken by seeded random keys (z is capped at 3.5, so ties at the cap are expected), never row order.
 *  N6. t = Newey-West lag 2, Bartlett weights, 1/T autocovariances (same estimator as R188's with lag 2).
 *  N7. Also reported per month and averaged: top-z decile minus universe mean, top-raw decile minus universe mean; the luck line
 *      (median and p95 of the best raw 6-month return among N zero-skill strategies, drawn from each member's own null, 1000 sims)
 *      against the observed best raw return; share of strategies with Storey q < 0.10 (lambda 0.5).
 *  N8. SHUFFLE (amended 2026-09-24): within each month z AND raw are each permuted among that month's names (seed 21102), statistic and NW t recomputed, 200 draws;
 *      pass = median |t| < 2 (R188 N13 reading). PEEK: the z ranking replaced by the realised outcome; NW t >= bar.
 *      NULL CALIBRATION: lib/selection-luck.test.js calibration (long/flat and 1.5x long/short universes, 400 zero-skill strategies
 *      each), both KS p > 0.05, run at read time.
 *  N9. VERDICT: gate met and >= 12 months with breadth >= 50 -> PASS if NW t >= 2.112 else DID NOT PASS, sealed only if all three
 *      controls pass. Fewer than 12 months -> INCONCLUSIVE (underpowered), sealed as such (registered) provided the null calibration
 *      passes (the read makes no claim, so shuffle/peek are reported, not required).
 *  N10. FORWARD LEG (--read-forward): refuses until 12 forward month-end snapshots (values-<day>.json within 3 days of the month-end)
 *      exist. Formation (A, positions, null) needs daily holdings, which only the timelines carry, so it uses the reconstruction up to
 *      t; the OUTCOME's strategy value comes from OUR dated snapshots (values at t and t+3), prices from the same bars. Formation ends
 *      are forward snapshots with a snapshot 3 months later. The registry's "every strategy with dated values" cannot be scored for
 *      MULTI-symbol strategies (no single asset for the random-timing null) — an amendment is needed before that read; until then
 *      the forward universe is single-symbol. Sealed under key "R211-forward".
 *  N11. --library is DESCRIPTIVE: our 73 daily strategy-library series, each made market-relative (x = r - beta x market; SPY total
 *      return for us-equity, Coinbase BTC-USD for crypto-24x7; flat days = 0 inside each window, ensemble/common.js liveMap); per-
 *      series sign-flip p (2000 sims, flips joint by date), z, Storey q; the best-of-73 luck line = max-Sharpe sign-flip null on the
 *      same series. "Clears" = market-relative Sharpe above the luck line's p95. Seals nothing; reads no AlphaInsider outcome.
 *
 *   node backend/r211-luck-filter.js --status | --selftest | --library | --read | --read-forward
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const R = require("./r188-ai-persistence.js");
const L = require("./lib/selection-luck.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R211", OUT = D("r211-luck-filter.json"), OUT_F = D("r211-luck-filter-forward.json"), LIBOUT = D("selection-luck-library.json");
const FORM = 6, HOLD = 3, SIMS = 500, DRAWS = 200, NWLAG = 2, MIN_MONTHS = 12, MIN_BREADTH = R.MIN_BREADTH, DAY = 864e5;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const quant = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };
const r4 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(4)), r6 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(6));
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
function nwT(a, lag = NWLAG) {
  const T = a.length; if (T < 3) return null; const m = mean(a), e = a.map((x) => x - m);
  let v = e.reduce((s, x) => s + x * x, 0) / T;
  for (let l = 1; l <= lag; l++) { let g = 0; for (let i = l; i < T; i++) g += e[i] * e[i - l]; v += 2 * (1 - l / (lag + 1)) * g / T; }
  return v > 0 ? m / Math.sqrt(v / T) : null;
}

// ── one strategy at one formation end (N1–N4) ────────────────────────────────────────────────────────────────────────────────────
/** Returns null (ineligible), {skip: reason}, or a scored row. valueAt(pt, me) lets the forward leg swap in our dated values. */
function scoreAt(x, ME, m, { countOnly = false, outcomeValue = null } = {}) {
  const p0 = R.pointAt(x.series, ME[m - FORM]), p1 = R.pointAt(x.series, ME[m]), p3 = R.pointAt(x.series, ME[m + HOLD]);
  if (!p0 || !p1 || !p3) return null;
  if (Date.parse(x.created) > p0.closeMs) return null;
  if (!(x.led.rows[0].t <= p1.closeMs)) return null;
  if (countOnly) return { id: x.id };
  if (!(p0.v > 0 && p1.v > 0)) return { skip: "non-positive value" };
  const i0 = x.series.indexOf(p0), i1 = x.series.indexOf(p1), s = [], r = [], pos = [];
  for (let d = i0 + 1; d <= i1; d++) {
    const a = x.series[d - 1], b = x.series[d]; if (!(a.v > 0)) return { skip: "value <= 0 inside the window" };
    s.push(b.v / a.v - 1); r.push(b.c / a.c - 1); pos.push(a.H * a.c / a.v);
  }
  if (s.length < 20) return { skip: "fewer than 20 daily points in the formation window" };
  const raw = p1.v / p0.v - 1, A = raw - (p1.c / p0.c - 1);
  const sc = L.skillScore(s, r, { positions: pos, sims: SIMS, seed: fnv(`${x.id}|${ME[m]}`), keepNull: true, assetRel: A });
  if (sc.z == null) return { skip: sc.reason };
  let v1 = p1.v, v3 = p3.v;
  if (outcomeValue) { v1 = outcomeValue(x.id, ME[m]); v3 = outcomeValue(x.id, ME[m + HOLD]); if (!(v1 > 0 && v3 > 0)) return { skip: "no dated value" }; }
  return { id: x.id, symbol: x.symbol, z: sc.z, pLuck: sc.pLuck, raw, A, out: (v3 / v1 - 1) - (p3.c / p1.c - 1), nullRaw: sc.nullRaw, inMarket: sc.inMarketFrac, switches: sc.nSwitches };
}
function panelFor(used, ME, months, opts = {}) {
  const panel = [], skips = {};
  for (const m of months) {
    const rows = [];
    for (const x of used) { const r = scoreAt(x, ME, m, opts); if (!r) continue; if (r.skip) { skips[r.skip] = (skips[r.skip] || 0) + 1; continue; } rows.push(r); }
    if (!opts.countOnly && rows.length) {   // N7 context, then drop the nulls (memory)
      const ll = L.luckLine(rows, rows.length, 1000, fnv("luck|" + ME[m])), q = L.storeyQ(rows.map((r) => r.pLuck)).q;
      rows.forEach((r, i) => { r.q = q[i]; delete r.nullRaw; });
      panel.push({ me: ME[m], rows, luckLine: { median: ll.median, p95: ll.p95 }, bestRaw: Math.max(...rows.map((r) => r.raw)), shareQ10: rows.filter((r) => r.q != null && r.q < 0.10).length / rows.length });
    } else panel.push({ me: ME[m], rows });
  }
  return { panel, skips };
}

// ── the statistic (N5–N8) ───────────────────────────────────────────────────────────────────────────────────────────────────────
function topK(rows, key, seed) {
  const rng = L.mulberry(seed), k = Math.floor(rows.length / 10);
  return rows.map((r) => ({ r, tie: rng() })).sort((a, b) => b.r[key] - a.r[key] || a.tie - b.tie).slice(0, k).map((o) => o.r);
}
function monthStat(rows, mi, scoreKey = "z") {
  if (rows.length < MIN_BREADTH) return null;
  const tz = topK(rows, scoreKey, 21101 + 2 * mi), tr = topK(rows, "raw", 21101 + 2 * mi + 1), all = mean(rows.map((r) => r.out));
  const mz = mean(tz.map((r) => r.out)), mr = mean(tr.map((r) => r.out));
  return { N: rows.length, k: tz.length, diff: mz - mr, topZvsUniverse: mz - all, topRawvsUniverse: mr - all };
}
function statistic(panel, scoreKey = "z") {
  const per = []; panel.forEach((mo, mi) => { const s = monthStat(mo.rows, mi, scoreKey); if (s) per.push({ me: mo.me, ...s }); });
  const d = per.map((p) => p.diff);
  return { months: per.length, meanDiff: d.length ? mean(d) : null, nwT: nwT(d), per };
}
function shuffledPanel(panel, rng) {
  // Amendment 2026-09-24 (pre-evidence, operator): z AND raw are each permuted independently, so the shuffled statistic is ~0 even if
  // the raw leaderboard itself predicts (a z-only shuffle leaves "universe minus top raw decile" and can fail a sound harness).
  const perm = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  return panel.map((mo) => { const z = perm(mo.rows.map((r) => r.z)), raw = perm(mo.rows.map((r) => r.raw)); return { me: mo.me, rows: mo.rows.map((r, i) => ({ ...r, z: z[i], raw: raw[i] })) }; });
}
function evaluate(panel, bar) {
  const S = statistic(panel), rng = L.mulberry(21102), shufT = [];
  for (let k = 0; k < DRAWS; k++) shufT.push(statistic(shuffledPanel(panel, rng)).nwT);
  const absT = shufT.filter((x) => x != null).map(Math.abs);
  const peek = statistic(panel.map((mo) => ({ me: mo.me, rows: mo.rows.map((r) => ({ ...r, peekScore: r.out })) })), "peekScore");
  const Q = S.per.map((p) => panel.find((mo) => mo.me === p.me)).filter((mo) => mo && mo.luckLine);
  return {
    months: S.months, meanDiff: r6(S.meanDiff), nwT: r4(S.nwT),
    topZvsUniverse: r6(S.per.length ? mean(S.per.map((p) => p.topZvsUniverse)) : null), topRawvsUniverse: r6(S.per.length ? mean(S.per.map((p) => p.topRawvsUniverse)) : null),
    luckLine: Q.map((mo) => ({ me: mo.me, N: mo.rows.length, bestRaw: r4(mo.bestRaw), lineMedian: r4(mo.luckLine.median), lineP95: r4(mo.luckLine.p95), shareQ10: r4(mo.shareQ10) })),
    perMonth: S.per.map((p) => ({ me: p.me, N: p.N, k: p.k, diff: r6(p.diff), topZvsUniverse: r6(p.topZvsUniverse), topRawvsUniverse: r6(p.topRawvsUniverse) })),
    controls: {
      shuffle: { draws: DRAWS, seed: 21102, medianAbsT: r4(quant(absT, 0.5)), p95AbsT: r4(quant(absT, 0.95)), pass: absT.length === DRAWS && quant(absT, 0.5) < 2 },
      peek: { nwT: r4(peek.nwT), bar, pass: peek.nwT != null && peek.nwT >= bar },
    },
  };
}
function nullCalibration() {
  const t = require("./lib/selection-luck.test.js").run({ quiet: true });
  const c = t.calibration, pass = ["long/flat", "long/short/flat 1.5x"].every((k) => c[k] && c[k].p > 0.05);
  return { pass, libTests: { passed: t.passed, failed: t.failed }, ...c };
}

// ── modes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function monthsIdx(ME) { const out = []; for (let m = FORM; m + HOLD < ME.length; m++) out.push(m); return out; }
async function status() {
  const { day, list } = R.loadStrategies(), state = R.loadState(), gate = R.readGate(list, state), { ME } = R.historyWindow(state);
  const U = await R.buildUniverse({ strategies: list, state }), used = U.singles.filter((x) => !x.exclude);
  const { panel } = panelFor(used, ME, monthsIdx(ME), { countOnly: true });
  const breadth = panel.filter((p) => p.rows.length).map((p) => ({ formationEnd: p.me, names: p.rows.length }));
  const qual = breadth.filter((b) => b.names >= MIN_BREADTH).length, bf = list.filter((s) => state.backfill[s.strategy_id]).length;
  const fwd = forwardSnapshots();
  console.log(`R211 STATUS  strategies ${day} · timelines asOf ${state.asOf}`);
  console.log(`  backfill ${bf}/${list.length} · R188 gate: ${gate.backfilled}/${gate.required} created <= ${gate.lastFormStart} backfilled -> ${gate.missing ? "NOT MET" : "met"}`);
  console.log(`  single-symbol usable ${used.length} of ${U.singles.length}`);
  console.log(`  formation ends (6m history, 3m outcome) ${ME[FORM]}..${ME[ME.length - 1 - HOLD]}: ${qual} with breadth >= ${MIN_BREADTH} (need ${MIN_MONTHS}) -> ${!gate.missing && qual >= MIN_MONTHS ? "READ ALLOWED" : !gate.missing ? "gate met, read would be INCONCLUSIVE" : "READ REFUSED (backfill gate)"}`);
  console.log(`  breadth ${breadth.map((b) => `${b.formationEnd.slice(0, 7)}:${b.names}`).join(" ")}`);
  console.log(`  forward: ${fwd.snaps.length} month-end snapshots of 12 (values days ${fwd.days.length}, ${fwd.days[0] || "-"}..${fwd.days[fwd.days.length - 1] || "-"}) -> accruing`);
  writeJsonAtomic(path.join(D("training"), "r188", "r211-status.json"), { asOf: new Date().toISOString(), gate, usable: used.length, breadth, qualifying: qual, forward: { snapshots: fwd.snaps.length, days: fwd.days.length } });
}

async function readHistorical() {
  const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID); if (!ENTRY) throw new Error(`${ID} not registered`);
  const BAR = ENTRY.bar.tRequired, seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  const { list } = R.loadStrategies(), state = R.loadState(), gate = R.readGate(list, state);
  if (gate.missing || gate.stateAgeDays > 3) { console.error(`${ID} --read REFUSED: R188 backfill gate not met (${gate.missing} of ${gate.required} not backfilled; state age ${gate.stateAgeDays}d)`); process.exit(2); }
  const cal = nullCalibration();
  const { ME } = R.historyWindow(state), U = await R.buildUniverse({ strategies: list, state }), used = U.singles.filter((x) => !x.exclude);
  const { panel, skips } = panelFor(used, ME, monthsIdx(ME));
  const E = evaluate(panel, BAR);
  let verdict, sealable;
  if (E.months < MIN_MONTHS) { verdict = `INCONCLUSIVE (underpowered) — ${E.months} month-ends with breadth >= ${MIN_BREADTH} (< ${MIN_MONTHS}); skill-minus-raw NW t ${E.nwT} vs bar ${BAR}`; sealable = cal.pass; }
  else { verdict = E.nwT != null && E.nwT >= BAR ? `PASS — top skill decile beats top raw decile by ${(100 * E.meanDiff).toFixed(2)}% per 3 months, NW(2) t ${E.nwT} >= ${BAR} over ${E.months} month-ends`
      : `DID NOT PASS — top skill decile minus top raw decile ${E.meanDiff == null ? "n/a" : (100 * E.meanDiff).toFixed(2) + "% per 3 months"}, NW(2) t ${E.nwT} vs bar ${BAR} over ${E.months} month-ends`;
    sealable = cal.pass && E.controls.shuffle.pass && E.controls.peek.pass; }
  writeJsonAtomic(OUT, { id: ID, leg: "historical", readAt: new Date().toISOString(), bar: BAR, gate, universe: { classes: U.byCls, usable: used.length }, skips, nullCalibration: cal, ...E, verdict, sealable, notes: "script header N1-N11" });
  console.log(`  months ${E.months} · meanDiff ${E.meanDiff} · NW t ${E.nwT} · shuffle med|t| ${E.controls.shuffle.medianAbsT} · peek t ${E.controls.peek.nwT} · calibration ${cal.pass}`);
  console.log(`\n  VERDICT: ${verdict}`);
  if (!sealable) { console.log("  controls FAILED — NOT sealed; investigate the harness"); return; }
  seal(ID, "month-ends (6-month formation, 3-month outcome; historical leg)", verdict, `READ ${todayET()} (historical leg) — ${verdict}; forward leg accruing`);
}
function seal(key, unit, verdict, status) {
  const today = todayET(), seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals.tests[key]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[key] = { sealedOn: today, unit, verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = status; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: key, verdict }) + "\n");
  console.log(`  sealed ${key} (${today})`);
}

function forwardSnapshots() {
  const days = fs.readdirSync(R.AI).filter((f) => /^values-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(7, 17)).sort();
  if (!days.length) return { days, snaps: [] };
  const snaps = R.monthEnds(days[0].slice(0, 7), days[days.length - 1].slice(0, 7)).map((me) => ({ me, day: days.filter((d) => d <= me && Date.parse(me) - Date.parse(d) <= 3 * DAY).pop() })).filter((s) => s.day);
  return { days, snaps };
}
async function readForward() {
  const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID); if (!ENTRY) throw new Error(`${ID} not registered`);
  const KEY = "R211-forward", BAR = ENTRY.bar.tRequired, seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals.tests[KEY]) { console.error(`${KEY} already sealed — refusing`); process.exit(2); }
  const fw = forwardSnapshots();
  if (fw.snaps.length < 12) { console.error(`${KEY} REFUSED: accruing — ${fw.snaps.length} of 12 forward month-end snapshots`); process.exit(2); }
  const cache = new Map(), valueOf = (id, me) => { const s = fw.snaps.find((x) => x.me === me); if (!s) return null; if (!cache.has(s.day)) cache.set(s.day, JSON.parse(fs.readFileSync(path.join(R.AI, `values-${s.day}.json`), "utf8")).values); return cache.get(s.day)[id]; };
  const { list } = R.loadStrategies(), state = R.loadState(), { ME: ME0 } = R.historyWindow(state);
  const ME = ME0.concat(fw.snaps.map((s) => s.me).filter((me) => !ME0.includes(me))).sort();
  const months = ME.map((me, m) => m).filter((m) => m >= FORM && m + HOLD < ME.length && fw.snaps.some((s) => s.me === ME[m]) && fw.snaps.some((s) => s.me === ME[m + HOLD]));
  const U = await R.buildUniverse({ strategies: list, state }), used = U.singles.filter((x) => !x.exclude);
  const { panel, skips } = panelFor(used, ME, months, { outcomeValue: valueOf });
  const cal = nullCalibration(), E = evaluate(panel, BAR);
  const verdict = E.months < MIN_MONTHS ? `INCONCLUSIVE (underpowered) — ${E.months} forward month-ends with breadth >= ${MIN_BREADTH}; NW t ${E.nwT} vs ${BAR}`
    : E.nwT >= BAR ? `PASS — forward skill-minus-raw NW(2) t ${E.nwT} >= ${BAR} over ${E.months} month-ends` : `DID NOT PASS — forward skill-minus-raw NW(2) t ${E.nwT} vs ${BAR} over ${E.months} month-ends`;
  const sealable = E.months < MIN_MONTHS ? cal.pass : cal.pass && E.controls.shuffle.pass && E.controls.peek.pass;
  writeJsonAtomic(OUT_F, { id: KEY, leg: "forward", readAt: new Date().toISOString(), bar: BAR, snapshots: fw.snaps, skips, nullCalibration: cal, ...E, verdict, sealable, note: "N10: single-symbol only until the multi-symbol benchmark is amended" });
  console.log(`\n  VERDICT: ${verdict}`); if (!sealable) { console.log("  controls FAILED — NOT sealed"); return; }
  seal(KEY, "forward month-ends (6-month formation, 3-month outcome on our dated values)", verdict, `${ENTRY.status}; FORWARD READ ${todayET()} — ${verdict}`);
}

async function library() {
  const C = require("./ensemble/common.js");
  const lib = C.loadLibrary().filter((e) => e.status === "ok" && e.unit === "daily" && Array.isArray(e.series));
  const spy = C.toRet(await C.spyDaily()), btc = C.toRet(await C.btcDaily()), sessions = new Set([...spy.keys()]);
  const rows = [], list = [], rawList = [];
  for (const e of lib) {
    const live = C.liveMap(e, sessions), mkt = e.calendar === "crypto-24x7" ? btc : spy, d = [], r = [], m = [];
    for (const [day, v] of live) if (mkt.has(day)) { d.push(day); r.push(v); m.push(mkt.get(day)); }
    const ann = e.calendar === "crypto-24x7" ? 365 : 252, mr = L.marketRelative(r, m);
    if (mr.reason) { rows.push({ id: e.id, reason: mr.reason }); continue; }
    rows.push({ id: e.id, calendar: e.calendar, market: e.calendar === "crypto-24x7" ? "BTC-USD" : "SPY", days: r.length, beta: mr.beta, alphaAnnPct: 100 * mr.alphaDaily * ann, tAlphaNW: mr.tAlphaNW, rawSharpe: L.sharpe(r, ann), mrSharpe: L.sharpe(mr.x, ann) });
    list.push({ id: e.id, r: mr.x, d, ann }); rawList.push({ id: e.id, r, d, ann });
  }
  const M = L.sharpeMaxNull(list, 2000, 211, { joint: true }), Mraw = L.sharpeMaxNull(rawList, 2000, 211, { joint: true }), Mind = L.sharpeMaxNull(rawList, 2000, 212, { joint: false });
  const scored = rows.filter((x) => !x.reason), q = L.storeyQ(M.pBySeries);
  scored.forEach((x, i) => { x.pLuck = M.pBySeries[i]; x.z = Math.max(-3.5, Math.min(3.5, L.probit(1 - x.pLuck))); x.q = q.q[i]; x.clearsLuckLine = x.mrSharpe > M.p95; });
  scored.sort((a, b) => b.mrSharpe - a.mrSharpe || (a.id < b.id ? -1 : 1));
  const out = { spec: "selection-luck-library-v1", asOf: new Date().toISOString(), descriptive: true, seals: "nothing; reads no AlphaInsider outcome",
    method: "script header N11; lib/selection-luck.js sharpeMaxNull (sign-flip, joint by date, 2000 sims, seed 211) on market-relative series; Storey q lambda 0.5",
    n: scored.length, excluded: rows.filter((x) => x.reason),
    luckLine: { marketRelative: { median: r4(M.median), p95: r4(M.p95), p99: r4(M.p99) }, raw: { median: r4(Mraw.median), p95: r4(Mraw.p95) }, rawIndependentFlips: { median: r4(Mind.median), p95: r4(Mind.p95) }, pi0: r4(q.pi0) },
    clears: scored.filter((x) => x.clearsLuckLine).map((x) => x.id),
    strategies: scored.map((x) => ({ id: x.id, market: x.market, days: x.days, beta: r4(x.beta), alphaAnnPct: r4(x.alphaAnnPct), tAlphaNW: r4(x.tAlphaNW), rawSharpe: r4(x.rawSharpe), mrSharpe: r4(x.mrSharpe), pLuck: r4(x.pLuck), z: r4(x.z), q: r4(x.q), clearsLuckLine: x.clearsLuckLine })) };
  writeJsonAtomic(LIBOUT, out);
  console.log(`SELECTION LUCK — strategy library (${scored.length} daily series, market-relative; descriptive)`);
  console.log(`  best-of-${scored.length} luck line (market-relative Sharpe): median ${out.luckLine.marketRelative.median}, p95 ${out.luckLine.marketRelative.p95}   | raw: median ${out.luckLine.raw.median}, p95 ${out.luckLine.raw.p95} (independent flips ${out.luckLine.rawIndependentFlips.median}/${out.luckLine.rawIndependentFlips.p95}) · pi0 ${out.luckLine.pi0}`);
  console.log("  id                 mkt      beta   alpha%/yr  tNW    rawSh  mrSh    pLuck   z      q      clears");
  for (const x of out.strategies) console.log(`  ${x.id.padEnd(18)} ${x.market.padEnd(8)} ${String(x.beta).padStart(6)} ${String(x.alphaAnnPct).padStart(9)} ${String(x.tAlphaNW).padStart(6)} ${String(x.rawSharpe).padStart(6)} ${String(x.mrSharpe).padStart(6)} ${String(x.pLuck).padStart(7)} ${String(x.z).padStart(6)} ${String(x.q).padStart(6)}  ${x.clearsLuckLine ? "YES" : ""}`);
  console.log(`  clears the luck line: ${out.clears.length ? out.clears.join(", ") : "none"}  -> data/selection-luck-library.json`);
}

function selftest() {
  const t = require("./lib/selection-luck.test.js").run(); let bad = t.failed;
  // R211 pipeline on fabricated months: 24 month-ends x 120 strategies, each on its own hot/cold asset; the next-3-month outcome is
  // driven by timing skill (planted) or by nothing (null). Same scoring, deciles, NW(2), shuffle and peek as the read.
  const g = L.mulberry(211211), gauss = () => { let u = 0; for (let i = 0; i < 12; i++) u += g(); return u - 6; };
  const build = (planted) => Array.from({ length: 24 }, (_, mi) => ({ me: `m${mi}`, rows: Array.from({ length: 120 }, (_, i) => {
    const skill = planted ? (i % 10 === 0 ? 0.6 : 0.5) : 0.5, drift = 0.004 * gauss(), asset = Array.from({ length: 126 }, () => drift + 0.02 * gauss()), pos = new Array(126);
    let st = 1; for (let d = 0; d < 126; d++) { if (skill > 0.5) st = (asset[d] > 0) === (g() < skill) ? 1 : 0; else if (d && g() > 0.9) st = 1 - st; pos[d] = st; }
    const sc = L.skillScore(asset.map((r, d) => pos[d] * r), asset, { positions: pos, sims: 200, seed: fnv(`${planted}|${mi}|${i}`) });
    return { id: "s" + i, z: sc.z, pLuck: sc.pLuck, raw: sc.raw, out: (skill - 0.5) * 0.3 + 0.03 * gauss() };
  }) }));
  const P = evaluate(build(true), 2.112), N0 = evaluate(build(false), 2.112), lines = [];
  const chk = (name, c, det) => { if (!c) bad++; lines.push(`${c ? "  ok  " : "  FAIL"} ${name} (${det})`); };
  chk("R211 pipeline: planted skill clears 2.112", P.nwT >= 2.112, `t ${P.nwT}, diff ${P.meanDiff}`);
  chk("R211 pipeline: zero-skill universe does not", Math.abs(N0.nwT) < 2.112, `t ${N0.nwT}`);
  chk("R211 shuffle control (median |t| < 2)", P.controls.shuffle.pass && N0.controls.shuffle.pass, `${P.controls.shuffle.medianAbsT} / ${N0.controls.shuffle.medianAbsT}`);
  chk("R211 peek control clears the bar", P.controls.peek.pass && N0.controls.peek.pass, `${P.controls.peek.nwT} / ${N0.controls.peek.nwT}`);
  chk("ties at the z cap broken by seed, not row order", (() => { const rows = Array.from({ length: 100 }, (_, i) => ({ z: 3.5, raw: 0, out: i })); const a = topK(rows, "z", 1).map((r) => r.out), b = topK(rows, "z", 2).map((r) => r.out); return a.join() !== b.join() && a.join() !== "0,1,2,3,4,5,6,7,8,9"; })(), "seeded");
  console.log(`R211 pipeline self-test:`); lines.forEach((l) => console.log(l));
  console.log(`R211 SELF-TEST: ${bad ? bad + " FAILED" : "all passed"} · calibration ${JSON.stringify(t.calibration)}`);
  if (bad) process.exit(1);
}

const argv = process.argv.slice(2);
if (require.main === module) (async () => {
  if (argv.includes("--selftest")) return selftest();
  if (argv.includes("--library")) return library();
  if (argv.includes("--read-forward")) return readForward();
  if (argv.includes("--read")) return readHistorical();
  return status();
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });
module.exports = { scoreAt, monthStat, statistic, evaluate, topK };
