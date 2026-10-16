#!/usr/bin/env node
/**
 * R199 — QUARTER-END WINDOW DRESSING. Registered 2026-09-24 (family FLOWS-4, best-of-4 bar) BEFORE this file existed; rule,
 * statistic, bar, controls and decision rule are frozen in data/test-registry.json (preregistered[id=R199]); the bar is read from
 * there at run time.
 *
 *   node backend/r199-window-dressing.js --coverage   event counts, universe and decile sizes only (no returns); writes nothing
 *   node backend/r199-window-dressing.js              the ONE read -> data/r199-window-dressing.json; seals if the bootstrap passes
 *
 * IMPLEMENTATION NOTES (every choice fixed before any R199 return was computed; none chosen on results)
 *  N1 Panel data/anomaly-cache-v2 (adjusted close/open/volume, symbol-major Float32, NaN = no bar; 2016-01-04..2026-09-22). A
 *     quarter-end = the last panel session of Mar/Jun/Sep/Dec. Quarters 2016Q1..2026Q2 (42).
 *  N2 Timing. tq = the quarter's last session. "The close 6 trading days before quarter-end" is read as the 6th-to-last session of
 *     the quarter, f = tq-5: the close immediately before "the last 5 trading days of the quarter" (sessions tq-4..tq), so the
 *     ranking close is also Leg A's entry close with no gap. Leg A = close f -> close tq. Leg B = close tq -> close tq+5 (the
 *     first 5 sessions of the next quarter).
 *  N3 Quarter-to-date return = c(f) / quarter-start price - 1, quarter-start price = the close of the prior quarter's last
 *     session. For 2016Q1 that close (2015-12-31) is outside the panel; the 2016-01-04 OPEN is used instead (disclosed).
 *  N4 Universe at f (as R175/R194): 20-session median dollar volume (adj close x adj volume) >= $25M with >= 15 finite sessions
 *     in the 20; c(f) > 0 and the quarter-start price > 0. Dollar-volume screen only (registry).
 *  N5 Deciles: sort by QTD return ascending with a seeded random tie key (mulberry32, seed per event), never row order;
 *     top = the floor(n/10) highest, bottom = the floor(n/10) lowest. The SAME two deciles are used for Leg B.
 *  N6 Returns, equal weight. Leg A gross = mean(top) - mean(bottom) over f -> tq; Leg B gross = -(mean(top) - mean(bottom)) over
 *     tq -> tq+5. A name with no bar at the exit session exits at its last finite close inside the leg (0 if none) — no delisting
 *     return is modelled (R194 convention). A name with no close at tq cannot enter Leg B and is dropped from it (counted).
 *  N7 Cost "20 bps per side per leg" — read with the house convention of R194 (same registrant, same day, same phrase): each of
 *     the long and short books pays 20 bps in and 20 bps out, full turnover: leg net = gross - 4 x 0.0020 = gross - 0.0080, in
 *     BOTH Leg A and Leg B. Primary per quarter = LegA net + LegB net = (A+B gross) - 0.0160. The lighter reading (20 bps per side
 *     per Leg A/B, gross - 0.0080 per quarter) is REPORTED, not gated.
 *  N8 Statistic: plain t over quarters (non-overlapping 10-session windows; no NW registered). Reported: Leg A alone, Leg B alone
 *     (net and gross), and by-year.
 *  N9 Placebo (VERDICT input): the identical rule at non-quarter month-ends (Jan/Feb/Apr/May/Jul/Aug/Oct/Nov), 2016-01..2026-05.
 *     "Identical" is taken literally: the ranking return runs from the prior QUARTER's last close (calendar quarter-to-date), the
 *     same code with only the anchor month changed. 2016-01 and 2016-02 anchor on the 2016-01-04 open (N3); 2016-01 fails the
 *     15-session universe screen at f and drops out. Beaten = placebo t < bar (the mechanism predicts no effect there, R183
 *     convention) AND the quarter-end mean > the placebo mean. Welch t of (quarter - placebo) reported. Reported variant: a
 *     lookback-matched placebo (anchor = the close of the month-end three months earlier).
 *  N10 Bootstrap (SEAL gate, house leak test as R194): each stock's real daily simple returns between consecutive finite closes are
 *     demeaned (arithmetic drift = 0) and redrawn iid with replacement; closes rebuilt from the stock's first finite close, NaN
 *     pattern kept (names still enter/leave when they really did); the REAL universe (real dollar volume) is kept; ranking and
 *     returns run on the scrambled closes through the identical pipeline (for 2016Q1 the anchor is the rebuilt first close, the
 *     open is not rebuilt). 20 seeded draws; statistic = the GROSS A+B t over quarters; passes when the MEDIAN |t| < 2 (a single
 *     draw fails 5% of the time by chance; the median catches a systematic leak). All 20 t's reported.
 *  N11 Seal: the bootstrap passes and 42 quarters are measured. PASS = primary t >= bar AND placebo beaten. A DID NOT PASS is the
 *     decision rule's 'fail'.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), PANEL = D("anomaly-cache-v2"), ID = "R199", OUT = D("r199-window-dressing.json");
const COVERAGE = process.argv.includes("--coverage");
{ const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID] && !COVERAGE) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
const ENTRY0 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
if (!ENTRY0) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = ENTRY0.bar.tRequired;
const meta = JSON.parse(fs.readFileSync(path.join(PANEL, "meta.json"), "utf8")), DATES = meta.dates, SYMS = meta.symbols, T = DATES.length, N = SYMS.length;
const rd = (f) => { const b = fs.readFileSync(path.join(PANEL, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
const C = rd("close.f32"), O = rd("open.f32"), V = rd("vol.f32");
const MIN_DV = 25e6, COST_LEG = 4 * 0.002, COST_LIGHT_Q = 2 * 2 * 0.002, BOOT_DRAWS = 20, BOOT_SEED = 199100;
const FIRST_Q = "2016-03", LAST_Q = "2026-06", PLAC_FIRST = "2016-01", PLAC_LAST = "2026-05";

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN);
const welchT = (a, b) => (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sortKeyed(items, val, seed) { const rng = mulberry(seed); const k = items.map((x) => ({ x, v: val(x), r: rng() })); k.sort((a, b) => a.v - b.v || a.r - b.r); return k.map((z) => z.x); }
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null), pct = (x) => (Number.isFinite(x) ? +(100 * x).toFixed(3) : null);

// ---- month-ends and events ---------------------------------------------------------------------------------------------------
const ME = new Map(); for (let t = 0; t < T; t++) { const m = DATES[t].slice(0, 7); if (t === T - 1 || DATES[t + 1].slice(0, 7) !== m) ME.set(m, t); }
const addMonths = (m, k) => { let y = +m.slice(0, 4), mo = +m.slice(5, 7) + k; while (mo > 12) { mo -= 12; y++; } while (mo < 1) { mo += 12; y--; } return `${y}-${String(mo).padStart(2, "0")}`; };
const isQ = (m) => ["03", "06", "09", "12"].includes(m.slice(5, 7));
const priorQuarterEnd = (m) => { let k = m; do { k = addMonths(k, -1); } while (!isQ(k)); return k; };
function makeEvent(m, anchorMonth) {
  const tq = ME.get(m); if (tq == null || tq + 5 >= T) return null;
  const ta = ME.get(anchorMonth);   // undefined when the anchor precedes the panel -> first-session open (N3)
  return { m, tq, f: tq - 5, ta: ta == null ? null : ta };
}
const QUARTERS = [], PLACEBO = [], PLACEBO_LB = [];
for (const m of ME.keys()) {
  if (isQ(m) && m >= FIRST_Q && m <= LAST_Q) QUARTERS.push(makeEvent(m, priorQuarterEnd(m)));
  if (!isQ(m) && m >= PLAC_FIRST && m <= PLAC_LAST) { PLACEBO.push(makeEvent(m, priorQuarterEnd(m))); PLACEBO_LB.push(makeEvent(m, addMonths(m, -3))); }
}

// ---- universe (real data; N4) --------------------------------------------------------------------------------------------------
function median20(s, t) { const a = []; for (let k = t - 19; k <= t; k++) { if (k < 0) continue; const cl = C[s * T + k], x = cl * V[s * T + k]; if (cl > 0 && Number.isFinite(x)) a.push(x); } if (a.length < 15) return NaN; a.sort((x, y) => x - y); return a[a.length >> 1]; }
const uniCache = new Map();
function universe(f) { if (uniCache.has(f)) return uniCache.get(f); const u = []; for (let s = 0; s < N; s++) if (C[s * T + f] > 0 && median20(s, f) >= MIN_DV) u.push(s); uniCache.set(f, u); return u; }

// ---- the rule on a close array (real or bootstrapped) ---------------------------------------------------------------------------
function legRet(P, s, t0, t1) {   // close t0 -> close t1, exit at last finite close if missing at t1 (0 if none)
  const p0 = P[s * T + t0]; let last = p0; for (let t = t0 + 1; t <= t1; t++) { const x = P[s * T + t]; if (x > 0) last = x; }
  return last / p0 - 1;
}
function runEvent(ev, P, boot, seedBase, idx) {
  const U = [];
  for (const s of universe(ev.f)) {
    const anchor = ev.ta != null ? P[s * T + ev.ta] : (boot ? P[s * T + 0] : O[s * T + 0]);
    const cf = P[s * T + ev.f]; if (!(anchor > 0) || !(cf > 0)) continue;
    U.push({ s, q: cf / anchor - 1 });
  }
  const n = U.length, dec = Math.floor(n / 10); if (dec < 5) return null;
  const srt = sortKeyed(U, (x) => x.q, seedBase + idx), bot = srt.slice(0, dec).map((x) => x.s), top = srt.slice(n - dec).map((x) => x.s);
  const A = mean(top.map((s) => legRet(P, s, ev.f, ev.tq))) - mean(bot.map((s) => legRet(P, s, ev.f, ev.tq)));
  const topB = top.filter((s) => P[s * T + ev.tq] > 0), botB = bot.filter((s) => P[s * T + ev.tq] > 0);
  const B = -(mean(topB.map((s) => legRet(P, s, ev.tq, ev.tq + 5))) - mean(botB.map((s) => legRet(P, s, ev.tq, ev.tq + 5))));
  return { m: ev.m, f: DATES[ev.f], tq: DATES[ev.tq], exitB: DATES[ev.tq + 5], anchor: ev.ta != null ? DATES[ev.ta] : DATES[0] + " open", universe: n, perDecile: dec,
    droppedFromLegB: (top.length - topB.length) + (bot.length - botB.length), aGross: A, bGross: B, aNet: A - COST_LEG, bNet: B - COST_LEG, net: A + B - 2 * COST_LEG, gross: A + B };
}
const runSet = (evs, P, boot, seedBase) => evs.map((e, i) => (e ? runEvent(e, P, boot, seedBase, i) : null)).filter(Boolean);
const summ = (rows, key) => { const a = rows.map((r) => r[key]); return { n: a.length, meanPct: pct(mean(a)), t: r3(tOf(a)), hitPct: r3(100 * a.filter((x) => x > 0).length / a.length) }; };

if (COVERAGE) {
  const cq = QUARTERS.map((e) => (e ? { m: e.m, f: DATES[e.f], tq: DATES[e.tq], universe: universe(e.f).length } : null));
  const cp = PLACEBO.map((e) => (e ? { m: e.m, universe: universe(e.f).length } : null));
  console.log(JSON.stringify({ quarters: cq.filter(Boolean).length, quarterDetail: cq, placeboMonths: cp.filter((x) => x && x.universe >= 50).length, placeboDetail: cp }, null, 0));
  process.exit(0);
}

// ---- the read ------------------------------------------------------------------------------------------------------------------
const Q = runSet(QUARTERS, C, false, 1990000), PL = runSet(PLACEBO, C, false, 1991000), PLB = runSet(PLACEBO_LB, C, false, 1992000);
const primary = { ...summ(Q, "net"), grossMeanPct: summ(Q, "gross").meanPct, grossT: summ(Q, "gross").t };
const legs = { legA: { net: summ(Q, "aNet"), gross: summ(Q, "aGross") }, legB: { net: summ(Q, "bNet"), gross: summ(Q, "bGross") } };
const lightCost = summ(Q.map((r) => ({ v: r.gross - COST_LIGHT_Q })), "v");
const plac = { ...summ(PL, "net"), grossT: summ(PL, "gross").t, legA: summ(PL, "aNet"), legB: summ(PL, "bNet") };
const placLB = { ...summ(PLB, "net"), grossT: summ(PLB, "gross").t };
const placeboBeaten = Number.isFinite(plac.t) && plac.t < BAR && mean(Q.map((r) => r.net)) > mean(PL.map((r) => r.net));
const diffWelch = r3(welchT(Q.map((r) => r.net), PL.map((r) => r.net)));
const byYear = {}; for (const y of [...new Set(Q.map((r) => r.m.slice(0, 4)))]) byYear[y] = summ(Q.filter((r) => r.m.startsWith(y)), "net");

// ---- bootstrap leak test (N10) -------------------------------------------------------------------------------------------------
console.log(`R199 primary computed over ${Q.length} quarters; running ${BOOT_DRAWS} bootstrap draws ...`);
const bootTs = [];
for (let d = 0; d < BOOT_DRAWS; d++) {
  const rng = mulberry(BOOT_SEED + d), P = new Float32Array(N * T).fill(NaN);
  for (let s = 0; s < N; s++) {
    const base = s * T, rets = []; let prev = NaN, first = -1;
    for (let t = 0; t < T; t++) { const x = C[base + t]; if (x > 0) { if (prev > 0) rets.push(x / prev - 1); else if (first < 0) first = t; prev = x; } }
    if (first < 0) continue;
    if (!rets.length) { for (let t = 0; t < T; t++) if (C[base + t] > 0) P[base + t] = C[base + t]; continue; }
    const mu = mean(rets), dm = rets.map((r) => r - mu); let cur = C[base + first]; P[base + first] = cur;
    for (let t = first + 1; t < T; t++) { if (C[base + t] > 0) { cur = cur * (1 + dm[Math.floor(rng() * dm.length)]); if (!(cur > 0)) cur = 1e-6; P[base + t] = cur; } }
  }
  const rows = runSet(QUARTERS, P, true, 1993000 + d * 100);
  bootTs.push(r3(tOf(rows.map((r) => r.gross))));
  process.stdout.write(`  bootstrap ${d + 1}/${BOOT_DRAWS} t ${bootTs[d]}\r`);
}
console.log("");
const medAbs = [...bootTs].map(Math.abs).sort((a, b) => a - b); const bootMedianAbsT = (medAbs[9] + medAbs[10]) / 2;
const bootstrap = { draws: BOOT_DRAWS, seed: BOOT_SEED, ts: bootTs, medianAbsT: r3(bootMedianAbsT), countAbsGe2: bootTs.filter((t) => Math.abs(t) >= 2).length, pass: bootMedianAbsT < 2 };

const pass = Number.isFinite(primary.t) && primary.t >= BAR && placeboBeaten;
const verdict = `${pass ? "PASS" : "DID NOT PASS"} — rank on QTD at the 6th-to-last session; long top/short bottom decile into quarter-end, reversed for the first 5 sessions of the next quarter: net ${primary.meanPct}% per quarter (gross ${primary.grossMeanPct}%, cost 1.6%), t ${primary.t} vs bar ${BAR} over ${primary.n} quarters; Leg A net t ${legs.legA.net.t}, Leg B net t ${legs.legB.net.t}; non-quarter month-end placebo t ${plac.t} (${placeboBeaten ? "beaten" : "not beaten"}); bootstrap median |t| ${bootstrap.medianAbsT}`;
const sealable = bootstrap.pass && Q.length === 42;
const out = { id: ID, spec: "r199-window-dressing-v1", readOn: new Date().toISOString(), rule: ENTRY0.rule, statistic: ENTRY0.statistic, controls: ENTRY0.controls, bar: ENTRY0.bar,
  panel: { spec: meta.spec, builtAt: meta.builtAt, dates: [DATES[0], DATES[T - 1]], symbols: N },
  primary, legs, lightCostVariant: { note: "20 bps per side per Leg A/B (gross - 0.8%/quarter); reported only (N7)", ...lightCost },
  placebo: { rule: "identical rule at non-quarter month-ends, calendar QTD anchor (N9)", ...plac, beaten: placeboBeaten, criterion: "placebo t < bar AND quarter mean > placebo mean", quarterMinusPlaceboWelchT: diffWelch },
  placeboLookbackMatched: { note: "reported only", ...placLB }, bootstrap, byYear,
  quarters: Q.map((r) => ({ ...r, aGross: pct(r.aGross), bGross: pct(r.bGross), aNet: pct(r.aNet), bNet: pct(r.bNet), net: pct(r.net), gross: pct(r.gross) })),
  placeboMonths: PL.map((r) => ({ m: r.m, universe: r.universe, net: pct(r.net) })), sealable, verdict };
writeJsonAtomic(OUT, out);
console.log(verdict);
console.log(`  legs: A gross ${legs.legA.gross.meanPct}% t ${legs.legA.gross.t} · B gross ${legs.legB.gross.meanPct}% t ${legs.legB.gross.t} · light-cost t ${lightCost.t} · placebo n ${plac.n} mean ${plac.meanPct}% · lookback placebo t ${placLB.t} · Welch Q-P t ${diffWelch}`);
console.log(`  bootstrap: ${JSON.stringify(bootstrap)}`);
if (!sealable) { console.error("validity gate failed (bootstrap or quarter count) — written, NOT sealed"); process.exit(3); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) { console.error(`${ID} sealed meanwhile — refusing`); process.exit(2); }
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
seals.tests[ID] = { sealedOn: today, unit: "quarters", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
console.log(`${ID} sealed.`);
