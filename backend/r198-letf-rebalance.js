#!/usr/bin/env node
/**
 * R198 — LEVERAGED-ETF CLOSE REBALANCING ON BIG DAYS (SPY/QQQ). Registered 2026-09-24 (family FLOWS-4, best-of-4) BEFORE this file
 * existed; rule, statistic, bar and controls are frozen in data/test-registry.json (preregistered[id=R198]); the bar is read from
 * there at run time.
 *
 * RULE (registry): Alpaca SIP 1-minute (mine3 cache + lib/mine3-minute.js). Day's move m = return from the prior close to 15:30 ET.
 * On days with |m| >= 1.0% only: at 15:30 take the direction of m in SPY and QQQ (equal weight), exit at the close (15:59 bar close,
 * as R193). Cost 1 bp per side. Full sessions only. Window 2016-01-01..2026-08-31 (SPY; QQQ from 2018-08 in the existing cache).
 * STATISTIC: per qualifying day, the pooled net last-half-hour return in the direction of m; t over qualifying days. Reported:
 * thresholds 0.5% and 2.0%, and the unconditional (all days) version for contrast with R193.
 * BAR: t >= ENTRY.bar.tRequired (2.26). CONTROLS: signShuffle (direction signs shuffled across qualifying days, 200 draws, the true
 * mean must beat the 95th percentile); peek (sign of the last half-hour itself must clear the bar).
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed; conventions mirror r193-intraday-momentum.js):
 *  N1. Data: lib/mine3-minute.js cache only — SPY 2016-01-01..2026-08-31, QQQ 2018-08-01..2026-08-31 (the registered "existing
 *      cache"; nothing new is fetched for minutes). Sessions/half-days from the cached Alpaca calendar. Eligible = calendar sessions
 *      in the window with open 09:30 and close 16:00. The prior close may be a half-day (its own calendar close). 2016-01-04 has no
 *      prior close in the cache (SIP minutes start 2016-01-01) and is excluded and counted; QQQ's first priced day is 2018-08-02.
 *  N2. Price at HH:MM = close of the bar labelled HH:MM-1, else last earlier in-session bar up to 5 min stale, else the leg is
 *      unpriced that day. 15:30 = 15:29 bar close; close = 15:59 bar close; prior close = the prior session's (close-1) bar close.
 *  N3. "Day's move m" is read PER ETF (each leg uses its own prior-close->15:30 move — R193's per-asset convention, and the LETF
 *      mechanism: SSO/UPRO rebalance in S&P exposure, QQQ-linked LETFs in Nasdaq-100 exposure). A leg is ACTIVE iff its own
 *      |m| >= threshold; position = sign(m); an inactive leg is flat (0 return, no cost) — R193's "0 -> flat" convention. A day
 *      QUALIFIES iff at least one available leg is active. Pooled day value = equal-weight mean over the legs AVAILABLE that day
 *      (both after QQQ's cache start, SPY alone before it — the registered data window). A day in QQQ's era enters only if both
 *      legs are priced. Leg net = pos x (P_close/P_1530 - 1) - 2 x 1bp.
 *      Reported (not gated): common-SPY-m variant (SPY's m decides qualification and direction for both legs), active-legs-only
 *      mean, both-legs era only (2018-08-02+), SPY alone (full window), QQQ alone, 2 bps/side, gross, SIP daily-close exit, dividend
 *      add-back in m, by year.
 *  N4. The registry says "t over qualifying days" (no HAC named, unlike R193): primary t = plain one-sample t, mean/(sd/sqrt(n)),
 *      sd with n-1. Newey-West lag-1 t is reported beside it, never gated.
 *  N5. Sign-shuffle: each qualifying day's vector of leg positions (including 0 for an inactive leg) is permuted across qualifying
 *      days, stratified by leg-availability era (SPY-only days among themselves, two-leg days among themselves) so a vector is
 *      never applied to a day with a different leg set; seeded Fisher-Yates (seed 198); pooled net mean recomputed with the same
 *      cost rule; 200 draws. Beaten = true mean strictly > sorted[ceil(0.95*200)-1]. Numeric sort only; no row-order tie-break
 *      anywhere affects a value.
 *  N6. Peek: same qualifying days and the same active legs, pos = sign(last half-hour return), same cost; plain t must be >= bar
 *      (harness power check).
 *  N7. Dividends: adjustment "split" puts the ex-dividend drop inside m on ex-dates; the primary follows the registered data spec,
 *      a variant adds the dividend back (yield from Alpaca SIP daily bars, all-adjusted/split-adjusted return ratio - 1).
 *  N8. Seal gate (validity): SPY priced on >= 95% of eligible sessions AND QQQ priced on >= 95% of its-era eligible sessions,
 *      peek clears the bar, shuffle finite. VERDICT: PASS = primary t >= bar AND shuffle beaten (peek is a validity gate).
 *
 *   node backend/r198-letf-rebalance.js [--dry]  -> data/r198-letf-rebalance.json (refuses if R198 is already sealed)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { calendar, minuteCloses, priceAt } = require("./lib/mine3-minute.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry");
const ID = "R198", OUT = D("r198-letf-rebalance.json");
{ const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
if (!ENTRY) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = ENTRY.bar.tRequired, START = "2016-01-01", END = "2026-08-31", QQQ_FROM = "2018-08-01";
const COST = 0.0001, COST2 = 0.0002, TH = 0.01, DRAWS = 200, SEED = 198, SYMS = ["SPY", "QQQ"];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function tPlain(a) { const n = a.length, m = mean(a); const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1); return m / Math.sqrt(v / n); }
function nwT(a) {
  const n = a.length, m = mean(a); let g0 = 0, g1 = 0;
  for (let i = 0; i < n; i++) { const e = a[i] - m; g0 += e * e; if (i) g1 += e * (a[i - 1] - m); }
  g0 /= n; g1 /= n; return m / Math.sqrt((g0 + g1) / n);
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3)), bps = (x) => r3(x * 1e4);
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/**
 * Conditional run. For each day: legs = available legs (filtered by `legs`); per leg signal s = sigFn(L, d); active iff |s| >= th
 * (th = 0 -> every nonzero s); pos = sign(s) or 0. Day qualifies iff any leg active. Day value = mean over legs (inactive = 0) or,
 * with activeOnly, mean over active legs. dirFn overrides the direction (peek).
 */
function run(days, { th = TH, sigFn = (L) => L.m, cost = COST, legs = SYMS, exit = "p16", common = false, activeOnly = false, dirFn = null, filter = null } = {}) {
  const vals = [];
  for (const d of days) {
    if (filter && !filter(d)) continue;
    const avail = legs.filter((s) => d[s]); if (!avail.length) continue;
    const lv = [], pos = {};
    for (const s of avail) {
      const L = d[s], sig = common ? sigFn(d.SPY, d) : sigFn(L, d);
      const active = sig != null && Math.abs(sig) >= th && sig !== 0;
      const p = active ? (dirFn ? sgn(dirFn(L)) : sgn(sig)) : 0; pos[s] = p;
      const px = L[exit]; if (px == null) { lv.length = 0; break; }
      lv.push({ v: p * (px / L.p1530 - 1) - (p ? 2 * cost : 0), active });
    }
    if (lv.length !== avail.length || !lv.some((x) => x.active)) continue;
    const use = activeOnly ? lv.filter((x) => x.active) : lv;
    vals.push({ date: d.date, v: mean(use.map((x) => x.v)), pos, era: avail.length });
  }
  const a = vals.map((x) => x.v);
  return { n: a.length, meanBps: a.length ? bps(mean(a)) : null, t: a.length > 2 ? r3(tPlain(a)) : null, tNW: a.length > 2 ? r3(nwT(a)) : null, hit: a.length ? r3(a.filter((x) => x > 0).length / a.length) : null, vals };
}
const summ = (r) => ({ n: r.n, meanBps: r.meanBps, t: r.t, tNW: r.tNW, hitRate: r.hit });

(async () => {
  console.log(`${ID} — leveraged-ETF close rebalancing on big days · bar t >= ${BAR}`);
  const cal = await calendar("2015-12-01", "2026-08-31");
  const idx = cal.findIndex((s) => s.date >= START), sess = cal.slice(idx - 1).filter((s) => s.date <= END);
  const eligible = sess.slice(1).filter((s) => s.open === 570 && s.close === 960);
  const halfDays = sess.slice(1).filter((s) => !(s.open === 570 && s.close === 960)).map((s) => s.date);
  const mc = { SPY: await minuteCloses("SPY", START, END), QQQ: await minuteCloses("QQQ", QQQ_FROM, END) };
  const dly = {};
  for (const adj of ["split", "all"]) {
    const { bars } = await fetchBars(SYMS, { start: "2015-12-01", end: END + "T23:59:59Z", timeframe: "1Day", feed: "sip", adjustment: adj, requireAll: true, quiet: true });
    for (const s of SYMS) for (const b of bars[s]) ((dly[s] || (dly[s] = {}))[b.t.slice(0, 10)] || (dly[s][b.t.slice(0, 10)] = {}))[adj] = b.c;
  }

  const prevOf = new Map(); for (let i = 1; i < sess.length; i++) prevOf.set(sess[i].date, sess[i - 1]);
  const days = [], legMiss = { SPY: [], QQQ: [] }, qqqEraEligible = eligible.filter((s) => s.date > QQQ_FROM).length;
  const stale = { maxMin: 0, count: 0 }, closeDiff = [], droppedTwoLegEra = [];
  for (const s of eligible) {
    const p = prevOf.get(s.date), rec = { date: s.date };
    for (const sym of SYMS) {
      if (sym === "QQQ" && s.date <= QQQ_FROM) continue;                       // outside QQQ's cached era (prior close unavailable)
      const M = mc[sym].get(s.date), MP = mc[sym].get(p.date);
      const q = { prev: priceAt(MP, p.close, p.open), p1530: priceAt(M, 930, 570), p16: priceAt(M, 960, 570) };
      if (Object.values(q).some((v) => v == null)) { legMiss[sym].push(s.date); continue; }
      for (const v of Object.values(q)) if (v.stale) { stale.count++; stale.maxMin = Math.max(stale.maxMin, v.stale); }
      const dd = dly[sym][s.date], dp = dly[sym][p.date];
      const L = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.p]));
      L.dClose = dd?.split ?? null; L.dPrevClose = dp?.split ?? null;
      L.divYield = dd && dp && dd.all && dp.all ? (dd.all / dp.all) / (dd.split / dp.split) - 1 : 0;
      if (L.dClose) closeDiff.push(Math.abs(L.dClose / L.p16 - 1));
      L.m = L.p1530 / L.prev - 1; L.r13 = L.p16 / L.p1530 - 1;
      rec[sym] = L;
    }
    // In QQQ's era a day enters only with both legs priced (N3).
    if (s.date > QQQ_FROM && !(rec.SPY && rec.QQQ)) { if (rec.SPY || rec.QQQ) droppedTwoLegEra.push(s.date); continue; }
    if (rec.SPY) days.push(rec);
  }
  const spyPriced = eligible.length - legMiss.SPY.length, qqqPriced = qqqEraEligible - legMiss.QQQ.length;
  const coverage = { eligibleSessions: eligible.length, halfDaysExcluded: halfDays.length, daysInSample: days.length,
    spy: { priced: spyPriced, of: eligible.length, frac: r3(spyPriced / eligible.length), missing: legMiss.SPY },
    qqq: { from: "2018-08-02", priced: qqqPriced, of: qqqEraEligible, frac: r3(qqqPriced / qqqEraEligible), missing: legMiss.QQQ },
    twoLegEraDaysDroppedForOneLegMissing: droppedTwoLegEra, spyOnlyEraDays: days.filter((d) => !d.QQQ).length, twoLegDays: days.filter((d) => d.QQQ).length,
    staleFallbacks: stale, first: days[0]?.date, last: days[days.length - 1]?.date,
    medianAbsDaily_vs_1559_bps: bps([...closeDiff].sort((a, b) => a - b)[Math.floor(closeDiff.length / 2)]) };
  console.log(`  coverage: SPY ${spyPriced}/${eligible.length} · QQQ ${qqqPriced}/${qqqEraEligible} (from 2018-08-02) · ${days.length} days in sample (${coverage.spyOnlyEraDays} SPY-only era, ${coverage.twoLegDays} two-leg) ${coverage.first}..${coverage.last}; ${halfDays.length} half-days excluded`);

  // ---- primary --------------------------------------------------------------------------------------------------------------------
  const prim = run(days);
  console.log(`  PRIMARY |m|>=1%: ${prim.n} qualifying days, pooled net ${prim.meanBps} bps/day, t ${prim.t} (bar ${BAR}), NW t ${prim.tNW}, hit ${prim.hit}`);
  const both = (d) => !!d.QQQ;
  const variants = {
    th0_5pct: summ(run(days, { th: 0.005 })),
    th2_0pct: summ(run(days, { th: 0.02 })),
    unconditionalAllDays: summ(run(days, { th: 0 })),
    cost2bps: summ(run(days, { cost: COST2 })),
    gross: summ(run(days, { cost: 0 })),
    commonSpyMove: summ(run(days, { common: true })),
    activeLegsOnlyMean: summ(run(days, { activeOnly: true })),
    twoLegEraOnly: summ(run(days, { filter: both })),
    spyOnly: summ(run(days, { legs: ["SPY"] })),
    qqqOnly: summ(run(days, { legs: ["QQQ"] })),
    exitAtDailyClose: summ(run(days.filter((d) => SYMS.every((s) => !d[s] || (d[s].dClose && d[s].dPrevClose))).map((d) => { const o = { date: d.date }; for (const s of SYMS) if (d[s]) o[s] = { ...d[s], p16: d[s].dClose, mx: d[s].p1530 / d[s].dPrevClose - 1 }; return o; }), { sigFn: (L) => L.mx })),
    dividendAddBack: summ(run(days, { sigFn: (L) => (L.p1530 * (1 + L.divYield)) / L.prev - 1 })),
  };
  const byYear = {}; for (const y of [...new Set(prim.vals.map((x) => x.date.slice(0, 4)))]) { const a = prim.vals.filter((x) => x.date.startsWith(y)).map((x) => x.v); byYear[y] = { n: a.length, meanBps: bps(mean(a)), t: a.length > 2 ? r3(tPlain(a)) : null }; }
  // up vs down days, by the day's first active leg's direction (reported only)
  const side = (k) => { const a = prim.vals.filter((x) => k * (x.pos.SPY || x.pos.QQQ) > 0).map((x) => x.v); return { n: a.length, meanBps: bps(mean(a)), t: r3(tPlain(a)), hitRate: r3(a.filter((x) => x > 0).length / a.length) }; };
  const upDown = { up: side(1), down: side(-1) };
  console.log(`  thresholds: 0.5% n ${variants.th0_5pct.n} ${variants.th0_5pct.meanBps}bps t ${variants.th0_5pct.t} · 2.0% n ${variants.th2_0pct.n} ${variants.th2_0pct.meanBps}bps t ${variants.th2_0pct.t} · all days n ${variants.unconditionalAllDays.n} ${variants.unconditionalAllDays.meanBps}bps t ${variants.unconditionalAllDays.t}`);
  console.log(`  variants: 2bps t ${variants.cost2bps.t} · gross ${variants.gross.meanBps}bps t ${variants.gross.t} · common-SPY-m t ${variants.commonSpyMove.t} · active-only t ${variants.activeLegsOnlyMean.t} · two-leg era t ${variants.twoLegEraOnly.t} (${variants.twoLegEraOnly.n}) · SPY t ${variants.spyOnly.t} · QQQ t ${variants.qqqOnly.t} · daily-close t ${variants.exitAtDailyClose.t} · div add-back t ${variants.dividendAddBack.t}`);
  console.log(`  up days n ${upDown.up.n} ${upDown.up.meanBps}bps t ${upDown.up.t} · down days n ${upDown.down.n} ${upDown.down.meanBps}bps t ${upDown.down.t}`);

  // ---- controls ---------------------------------------------------------------------------------------------------------------------
  const rnd = mulberry(SEED), dayBy = new Map(days.map((d) => [d.date, d]));
  const Q = prim.vals.map((x) => ({ era: x.era, pos: x.pos, legs: Object.fromEntries(Object.keys(x.pos).map((s) => [s, dayBy.get(x.date)[s].r13])) }));
  const strata = [1, 2].map((e) => Q.map((q, i) => (q.era === e ? i : -1)).filter((i) => i >= 0));
  const shuf = [];
  for (let k = 0; k < DRAWS; k++) {
    const assign = new Array(Q.length);
    for (const st of strata) { const perm = [...st]; for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; } st.forEach((dst, i) => (assign[dst] = perm[i])); }
    let s = 0;
    for (let i = 0; i < Q.length; i++) { const ps = Q[assign[i]].pos, L = Q[i].legs; s += mean(Object.keys(L).map((sym) => ps[sym] * L[sym] - (ps[sym] ? 2 * COST : 0))); }
    shuf.push(s / Q.length);
  }
  const ss = [...shuf].sort((a, b) => a - b), shP95 = ss[Math.ceil(0.95 * DRAWS) - 1], trueMean = mean(prim.vals.map((x) => x.v)), shuffleBeaten = trueMean > shP95;
  const peek = run(days, { dirFn: (L) => L.r13 }), peekClears = peek.t >= BAR;
  console.log(`  SIGN-SHUFFLE (${DRAWS}, era-stratified): p50 ${bps(ss[Math.ceil(0.5 * DRAWS) - 1])} p95 ${bps(shP95)} bps -> true ${prim.meanBps} ${shuffleBeaten ? "BEATS" : "does NOT beat"} p95`);
  console.log(`  PEEK (sign of last half-hour, same days/legs): ${peek.meanBps} bps/day t ${peek.t} -> ${peekClears ? "clears" : "FAILS"} the bar`);

  // ---- verdict ------------------------------------------------------------------------------------------------------------------------
  const primaryClears = prim.t >= BAR, pass = primaryClears && shuffleBeaten;
  const verdict = `${pass ? "PASS" : "DID NOT PASS"} — SPY/QQQ |prior close->15:30| >= 1% -> same direction 15:30->close, pooled net ${prim.meanBps} bps/day, t ${prim.t} vs bar ${BAR} over ${prim.n} qualifying days (2016-01..2026-08; QQQ from 2018-08); sign-shuffle p95 ${bps(shP95)} bps (${shuffleBeaten ? "beaten" : "not beaten"}); peek t ${peek.t}; 0.5% t ${variants.th0_5pct.t}, 2.0% t ${variants.th2_0pct.t}, all days t ${variants.unconditionalAllDays.t}`;
  const controlsValid = spyPriced >= 0.95 * eligible.length && qqqPriced >= 0.95 * qqqEraEligible && peekClears && Number.isFinite(shP95);
  const out = { spec: "r198-letf-rebalance-v1", test: ID, asOf: new Date().toISOString(), window: [START, END], qqqFrom: "2018-08-02", bar: BAR, threshold: TH, costPerSide: COST,
    coverage, primary: { n: prim.n, meanNetBpsPerDay: prim.meanBps, t: prim.t, tNW: prim.tNW, hitRate: prim.hit, clearsBar: primaryClears }, variants, upVsDown: upDown, byYear,
    controls: { signShuffle: { draws: DRAWS, seed: SEED, stratifiedBy: "leg-availability era", p50Bps: bps(ss[Math.ceil(0.5 * DRAWS) - 1]), p95Bps: bps(shP95), maxBps: bps(ss[DRAWS - 1]), trueBps: prim.meanBps, beaten: shuffleBeaten, allBps: shuf.map(bps) },
      peek: { ...summ(peek), clearsBar: peekClears } },
    daily: prim.vals.map((x) => ({ date: x.date, netBps: bps(x.v), pos: x.pos })), verdict, pass, controlsValid };
  writeJsonAtomic(DRY ? OUT.replace(/.json$/, ".dry.json") : OUT, out);
  console.log(`\n  VERDICT: ${verdict}`);
  if (DRY) { console.log("  --dry: harness check only, NOT sealed"); return; }
  if (!controlsValid) { console.log("  controls invalid — NOT sealed"); return; }
  const today = todayET();
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[ID] = { sealedOn: today, unit: "events (qualifying days)", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });
