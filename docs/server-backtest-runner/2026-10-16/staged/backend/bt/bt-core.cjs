"use strict";
/**
 * BT-CORE — the arithmetic of the server backtest runner (bt-run.cjs). 2026-10-16 (docs/server-backtest-runner/2026-10-16). NO AI, NO NETWORK,
 * NO I/O except reading bar files: pure functions over stored daily bars.
 *
 * REUSED, NOT REWRITTEN. Every function marked "R313 verbatim" is the text of backend/r313-ibs-etfs.js (the sealed PASS of the dip-buy family,
 * 2026-10-03; its own pieces come from r310-qs-rsi5.js and R150) — the package selftest compares each one's source text with r313's, so a
 * difference fails it. The null bar is backend/lib/null-bar.js (nullBar) where present, else the research server's verbatim port
 * (factory/lib/nullbar.cjs, docs/server/wave6-agents) — loadNullBar() says which one it loaded and its sha256.
 * NEW here (the generic parts): bar-file loading and checking, the rule's signal arrays from its JSON (prepRule), a time-capped simulate for a
 * rule with maxHoldDays, the data-driven gate counts (decideRule) and the best-of-variants bar (barFor = R313's barAtN, generalised).
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const fin = Number.isFinite, dateOf = (t) => String(t).slice(0, 10);
const r4 = (x) => (x == null || !fin(x) ? null : +x.toFixed(4)), r3 = (x) => (x == null || !fin(x) ? null : +x.toFixed(3)), r1 = (x) => (x == null || !fin(x) ? null : +x.toFixed(1));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ── R313 verbatim: the rule pieces ───────────────────────────────────────────────────────────────────────────────────────
const ibsOf = (b) => (fin(b.h) && fin(b.l) && fin(b.c) && b.h > b.l ? (b.c - b.l) / (b.h - b.l) : NaN);
function mkTrade(P, sym, t, u) {
  const last = P.n - 1, x = u === null ? last : u;
  return { sym, t, u, entryDate: P.d[t], exitDate: u === null ? null : P.d[u], month: P.d[t].slice(0, 7), entry: P.c[t], exit: u === null ? null : P.c[u],
    hold: x - t, gross: P.c[x] / P.c[t] - 1, ...(u === null ? { markDate: P.d[last], mark: P.c[last] } : {}) };
}
function simulate(P, sym) {
  const { n, d, sig, ex, from, to } = P, closed = [], open = []; let pos = null, ignored = 0;
  const inWin = (i) => d[i] >= from && d[i] <= to;
  for (let i = 0; i < n; i++) {
    if (pos !== null) {
      if (ex[i]) { closed.push(mkTrade(P, sym, pos, i)); pos = null; }
      else if (sig[i] && inWin(i)) ignored++;
      continue;                                                    // an exit day has IBS > 0.9, so it can never also be an entry
    }
    if (sig[i] && inWin(i)) pos = i;
  }
  if (pos !== null) open.push(mkTrade(P, sym, pos, null));
  return { closed, open, ignored };
}
function sma(a, n) { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; o[i] = s / n; } return o; }
function rmaSeeded(a, n, first) { const o = new Array(a.length).fill(NaN); if (a.length < first + n) return o; let s = 0; for (let i = first; i < first + n; i++) s += a[i]; o[first + n - 1] = s / n; for (let i = first + n; i < a.length; i++) o[i] = (a[i] + (n - 1) * o[i - 1]) / n; return o; }
function rsiWilder(c, n) {
  const N = c.length, up = new Array(N).fill(NaN), dn = new Array(N).fill(NaN), out = new Array(N).fill(NaN);
  for (let i = 1; i < N; i++) { const ch = c[i] - c[i - 1]; up[i] = Math.max(ch, 0); dn[i] = Math.max(-ch, 0); }
  const ru = rmaSeeded(up, n, 1), rd = rmaSeeded(dn, n, 1);
  for (let i = 0; i < N; i++) { const u = ru[i], d = rd[i]; if (fin(u) && fin(d)) out[i] = d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d); }
  return out;
}

// ── R313 verbatim: statistics ────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function monthlySeries(items, monthOf, valOf) { const by = new Map(); for (const x of items) { const k = monthOf(x); (by.get(k) || by.set(k, []).get(k)).push(valOf(x)); } const keys = [...by.keys()].sort(); return { keys, series: keys.map((k) => mean(by.get(k))) }; }
function summarise(items, { netOf = (x) => x.net, monthOf = (x) => x.month } = {}) {
  if (!items.length) return { trades: 0, months: 0, meanNet: null, meanNetPctPerMonth: null, tNet: null, tNetRaw: null, winRate: null, winRatePct: null, meanPerTradePct: null, halves: null };
  const { keys, series } = monthlySeries(items, monthOf, netOf), h = Math.floor(series.length / 2), nets = items.map(netOf), m = mean(series), t = nwT(series), w = nets.filter((x) => x > 0).length / nets.length;
  const half = (s, k) => (s.length ? { meanNet: mean(s), meanNetPctPerMonth: r4(100 * mean(s)), months: s.length, from: k[0], to: k[k.length - 1] } : { meanNet: null, meanNetPctPerMonth: null, months: 0 });
  return { trades: items.length, months: keys.length, meanNet: m, meanNetPctPerMonth: r4(100 * m), tNet: r4(t), tNetRaw: t, winRate: w, winRatePct: r1(100 * w), meanPerTradePct: r4(100 * mean(nets)),
    halves: { first: half(series.slice(0, h), keys.slice(0, h)), second: half(series.slice(h), keys.slice(h)) }, _keys: keys, _series: series };
}
const strip = (s) => { if (!s) return s; const { _keys, _series, ...rest } = s; return rest; };
function nearestRank(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
function scramble(bars, seed, key, demean = false) {
  const rng = mulberry(seed * 1000003 + hash(key)), p = [];
  for (let i = 1; i < bars.length; i++) { const x = bars[i]; p.push([x.o / bars[i - 1].c, x.h / x.o, x.l / x.o, x.c / x.o, x.v]); }
  if (demean && p.length) { const mu = p.reduce((s, x) => s + Math.log(x[0] * x[3]), 0) / p.length, k = Math.exp(-mu); for (const x of p) x[0] *= k; }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const out = [{ ...bars[0] }]; let c = bars[0].c;
  for (let i = 1; i < bars.length; i++) { const [go, gh, gl, gc, v] = p[i - 1], o = c * go; c = o * gc; out.push({ ...bars[i], o, h: o * gh, l: o * gl, c, v }); }
  return out;
}
const shiftMonth = (ym, k) => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, "0")}`; };
function placeboPrepC(trades, PS) {
  const elig = new Map();
  const eligOf = (sym) => {
    if (elig.has(sym)) return elig.get(sym);
    const P = PS[sym], m = new Map();
    for (let i = 0; i < P.n; i++) {
      if (P.d[i] < P.from || P.d[i] > P.to || P.sig[i] || P.synth[i]) continue;
      const k = P.d[i].slice(0, 7); (m.get(k) || m.set(k, []).get(k)).push(i);
    }
    elig.set(sym, m); return m;
  };
  const slots = trades.map((x) => { const m = eligOf(x.sym); return { sym: x.sym, month: x.month, t: x.t, u: x.u, same: m.get(x.month) || [],
    wide: [shiftMonth(x.month, -1), x.month, shiftMonth(x.month, 1)].flatMap((k) => m.get(k) || []) }; });
  return { slots, holdPool: trades.map((x) => [x.sym, x.hold]), symbolsInPool: new Set(trades.map((x) => x.sym)).size };
}
function placeboRunC(pp, PS, { draws, seed, cost, record = null }) {
  const rng = mulberry(seed), keys = [...new Set(pp.slots.map((s) => s.month))].sort(), M = keys.length, mi = new Map(keys.map((k, i) => [k, i]));
  const stat = [], acc = new Float64Array(M), accN = new Uint32Array(M), slotMi = pp.slots.map((s) => mi.get(s.month)); let widened = 0, dropped = 0;
  for (let k = 0; k < draws; k++) {
    const s = new Float64Array(M), n = new Uint32Array(M);
    for (let q = 0; q < pp.slots.length; q++) {
      const sl = pp.slots[q], P = PS[sl.sym]; let H;
      if (pp.symbolsInPool >= 2) do { const h = pp.holdPool[Math.floor(rng() * pp.holdPool.length)]; if (h[0] !== sl.sym) H = h[1]; } while (H === undefined);
      if (H === undefined) { dropped++; continue; }                                   // a one-ETF pool has no independent hold
      const last = P.n - 1, lo = sl.t - 3, hi = sl.u, sc = P.synthCum;
      const ok = (i) => i + H <= last && (i + H < lo || i > hi) && sc[i + H] === sc[i];
      let arr = sl.same, cnt = 0, wide = false;
      for (const i of arr) if (ok(i)) cnt++;
      if (!cnt) { arr = sl.wide; wide = true; for (const i of arr) if (ok(i)) cnt++; }
      if (!cnt) { dropped++; continue; }
      if (wide) widened++;
      let j = Math.floor(rng() * cnt), i = -1;
      for (const x of arr) if (ok(x)) { if (j === 0) { i = x; break; } j--; }
      const v = P.c[i + H] / P.c[i] - 1 - cost, mq = slotMi[q];
      s[mq] += v; n[mq]++; if (record) record(sl, i, H, v, wide);
    }
    let tot = 0, m = 0; for (let i = 0; i < M; i++) if (n[i]) { const mm = s[i] / n[i]; tot += mm; m++; acc[i] += mm; accN[i]++; }
    stat.push(m ? tot / m : NaN);
  }
  const sorted = stat.filter(fin).sort((a, b) => a - b);
  return { draws, seed, months: M, p95: sorted.length ? sorted[Math.floor(0.95 * sorted.length)] : null, p50: sorted.length ? sorted[Math.floor(0.5 * sorted.length)] : null,
    p05: sorted.length ? sorted[Math.floor(0.05 * sorted.length)] : null, meanOfDraws: sorted.length ? mean(sorted) : null, monthKeys: keys,
    monthPlaceboMean: Array.from(acc, (x, i) => (accN[i] ? x / accN[i] : NaN)), widenedPerDraw: widened / draws, droppedPerDraw: dropped / draws, slots: pp.slots.length };
}
function pairedDiffs(S, pl) { if (!S._keys) return []; const byM = new Map(S._keys.map((k, i) => [k, S._series[i]])); return pl.monthKeys.map((k, i) => byM.get(k) - pl.monthPlaceboMean[i]).filter(fin); }
function floorGate(S, fl, bar) {
  const t = S._series && fl && fin(fl.p50) ? nwT(S._series.map((x) => x - fl.p50)) : null;
  const meanAboveP95 = S.meanNet != null && fl && fin(fl.p95) && S.meanNet > fl.p95, tOk = t != null && t >= bar;
  return { p50: fl ? fl.p50 : null, p95: fl ? fl.p95 : null, p50PctPerMonth: fl ? r4(100 * fl.p50) : null, p95PctPerMonth: fl ? r4(100 * fl.p95) : null, meanAboveP95: !!meanAboveP95, tVsP50: r4(t), tVsP50Raw: t, tVsP50AtLeastBar: tOk, clears: !!meanAboveP95 && tOk };
}

// ── NEW: bar files ───────────────────────────────────────────────────────────────────────────────────────────────────────
const isWeekend = (d) => { const g = new Date(String(d).slice(0, 10) + "T12:00:00Z").getUTCDay(); return g === 0 || g === 6; };
/**
 * one symbol's daily bars from <dir>/<SYM>.json ([{ t|d|date, o, h, l, c, v }] or { bars: [...] }) or <dir>/<SYM>.csv (header with
 * date,open,high,low,close[,volume]) -> { bars: [{ t, o, h, l, c, v }], sha, file, weekendDropped }; THROWS on anything it cannot trust:
 * absent, unparseable, a price not finite and > 0, high < low, dates not strictly increasing (a duplicate included), a malformed date.
 */
function loadBars(dir, sym, { lastBar = null, coverTo = null, maxGapDays = null } = {}) {
  if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) throw new Error(`bad symbol ${JSON.stringify(sym)}`);
  const fj = path.join(dir, sym + ".json"), fc = path.join(dir, sym + ".csv"), file = fs.existsSync(fj) ? fj : fs.existsSync(fc) ? fc : null;
  if (!file) throw new Error(`${sym}: no bar file (${sym}.json or ${sym}.csv) in ${dir}`);
  const buf = fs.readFileSync(file); let rows;
  if (file.endsWith(".json")) {
    let j; try { j = JSON.parse(buf.toString("utf8")); } catch (e) { throw new Error(`${sym}: ${path.basename(file)} does not parse (${e.message.slice(0, 60)})`); }
    const a = Array.isArray(j) ? j : j && Array.isArray(j.bars) ? j.bars : null; if (!a) throw new Error(`${sym}: ${path.basename(file)} holds no bar array`);
    rows = a.map((b) => ({ t: dateOf(b.t != null ? b.t : b.d != null ? b.d : b.date), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: b.v == null ? null : +b.v }));
  } else {
    const L = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim()), hd = L[0].toLowerCase().split(",").map((x) => x.trim()), ix = (k) => hd.indexOf(k);
    for (const k of ["date", "open", "high", "low", "close"]) if (ix(k) < 0) throw new Error(`${sym}: ${path.basename(file)} header has no ${k}`);
    rows = L.slice(1).map((l) => { const x = l.split(","); return { t: dateOf(x[ix("date")].trim()), o: +x[ix("open")], h: +x[ix("high")], l: +x[ix("low")], c: +x[ix("close")], v: ix("volume") >= 0 ? +x[ix("volume")] : null }; });
  }
  let weekendDropped = 0, afterLastDropped = 0; const bars = [];
  for (const [i, b] of rows.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.t) || !fin(Date.parse(b.t + "T00:00:00Z")) || new Date(b.t + "T00:00:00Z").toISOString().slice(0, 10) !== b.t) throw new Error(`${sym}: row ${i + 1} has a bad date ${JSON.stringify(b.t)}`);
    if (![b.o, b.h, b.l, b.c].every((x) => fin(x) && x > 0)) throw new Error(`${sym}: ${b.t} has a price that is not a finite number > 0`);
    if (b.h < b.l) throw new Error(`${sym}: ${b.t} high ${b.h} < low ${b.l}`);
    const tol = 1e-9 * b.h;
    if (b.o > b.h + tol || b.o < b.l - tol || b.c > b.h + tol || b.c < b.l - tol) throw new Error(`${sym}: ${b.t} open or close outside [low, high] (IBS would leave [0, 1])`);
    if (isWeekend(b.t)) { weekendDropped++; continue; }
    if (lastBar && b.t > lastBar) { afterLastDropped++; continue; }   // the forming-bar guard: nothing after window.lastBar is used
    if (bars.length && b.t <= bars[bars.length - 1].t) throw new Error(`${sym}: ${b.t} is not after ${bars[bars.length - 1].t} (dates must strictly increase; duplicates refused)`);
    bars.push(b);
  }
  if (bars.length < 2) throw new Error(`${sym}: fewer than 2 bars`);
  // coverage: the file must reach the window's end (within 7 days); a symbol whose data stop early is refused, never silently thinner
  if (coverTo) { const end = Date.parse(coverTo + "T00:00:00Z"), last = Date.parse(bars[bars.length - 1].t + "T00:00:00Z"); if (last < end - 7 * 86400000) throw new Error(`${sym}: its bars end ${bars[bars.length - 1].t}, before the window's end ${coverTo} (coverage)`); }
  // the largest calendar gap between consecutive bars (reported; refused above maxGapDays): a hole of months would book a whole move as one trade
  let maxGap = 0, gapAt = null; for (let i = 1; i < bars.length; i++) { const g = (Date.parse(bars[i].t + "T00:00:00Z") - Date.parse(bars[i - 1].t + "T00:00:00Z")) / 86400000; if (g > maxGap) { maxGap = g; gapAt = bars[i - 1].t; } }
  if (maxGapDays != null && maxGap > maxGapDays) throw new Error(`${sym}: a gap of ${maxGap} calendar days after ${gapAt} (more than ${maxGapDays}: missing data)`);
  return { bars, sha: sha256(buf), file: path.basename(file), weekendDropped, afterLastDropped, maxGapDays: maxGap, maxGapAfter: gapAt };
}

// ── NEW: the rule's signals ──────────────────────────────────────────────────────────────────────────────────────────────
const FAMILIES = ["ibs-dip", "rsi-dip"];
/** R313's control thresholds (registry: leak test t_NW < 2, positive control t_NW >= 3) */
const LEAK_T_MAX = 2, POSITIVE_T_MIN = 3;
const leakPasses = (t) => t != null && fin(t) && t < LEAK_T_MAX, positivePasses = (t) => t != null && fin(t) && t >= POSITIVE_T_MIN;
/** the most drift-kept seeds that CAN pass the whole rule (checker cycle 3): every pass needs "mean above the leave-one-out floor's p95",
 *  which by construction (nearest rank) at most N - ceil(0.95 (N - 1)) of N seeds can satisfy; at N = 20 / 40 / 60 that is exactly 5%,
 *  so R313's "<= 5%" calibration can never hold a read there — a property of the registered design, reported, never changed here */
const calibrationCeiling = (N) => (N >= 2 ? N - Math.ceil(0.95 * (N - 1)) : N);
/** validate a bt-rule-v1 (throws with every problem it finds) */
function checkRule(R) {
  const bad = [], e = (s) => bad.push(s), P = (R && R.params) || {}, en = P.entry || {}, ex = P.exit || {};
  if (!R || R.schema !== "bt-rule-v1") e('schema must be "bt-rule-v1"');
  if (!R || typeof R.id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(R.id)) e("id: 1-64 of [A-Za-z0-9_.-]");
  if (!R || !FAMILIES.includes(R.family)) e(`family must be one of ${FAMILIES.join(", ")}`);
  if (!R || !Array.isArray(R.universe) || !R.universe.length || new Set(R.universe).size !== R.universe.length) e("universe: a non-empty list of distinct symbols");
  if (R && R.family === "ibs-dip" && !(fin(en.ibsBelow) && en.ibsBelow > 0 && en.ibsBelow < 1)) e("ibs-dip: params.entry.ibsBelow in (0, 1)");
  if (R && R.family === "rsi-dip" && !(fin(en.rsiBelow) && Number.isInteger(en.rsiN) && en.rsiN >= 2)) e("rsi-dip: params.entry.rsiBelow and an integer params.entry.rsiN >= 2");
  for (const k of ["closeBelowSma", "trendSma"]) if (en[k] != null && !(Number.isInteger(en[k]) && en[k] >= 2)) e(`params.entry.${k}: an integer >= 2`);
  const exits = ["ibsAbove", "rsiAbove", "closeAboveSma"].filter((k) => ex[k] != null);
  if (!exits.length && P.maxHoldDays == null) e("params.exit: at least one of ibsAbove, rsiAbove (+ rsiN), closeAboveSma, or params.maxHoldDays");
  if (ex.ibsAbove != null && !(fin(ex.ibsAbove) && ex.ibsAbove > 0 && ex.ibsAbove < 1)) e("params.exit.ibsAbove in (0, 1)");
  if (ex.rsiAbove != null && !(fin(ex.rsiAbove) && Number.isInteger(ex.rsiN) && ex.rsiN >= 2)) e("params.exit.rsiAbove needs an integer params.exit.rsiN >= 2");
  if (ex.closeAboveSma != null && !(Number.isInteger(ex.closeAboveSma) && ex.closeAboveSma >= 2)) e("params.exit.closeAboveSma: an integer >= 2");
  if (P.maxHoldDays != null && !(Number.isInteger(P.maxHoldDays) && P.maxHoldDays >= 1)) e("params.maxHoldDays: an integer >= 1");
  const W = (R && R.window) || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(W.from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(W.to || "") || !(W.from < W.to)) e("window: from < to, both YYYY-MM-DD");
  if (W.lastBar != null && !(/^\d{4}-\d{2}-\d{2}$/.test(W.lastBar) && W.lastBar >= W.to && Date.parse(W.lastBar + "T00:00:00Z") - Date.parse(W.to + "T00:00:00Z") <= 10 * 86400000)) e("window.lastBar: YYYY-MM-DD, on or after window.to and at most 10 days after it (bars after it are dropped: the forming-bar guard; frozen at registration)");
  if (W.maxGapDays != null && !(Number.isInteger(W.maxGapDays) && W.maxGapDays >= 4)) e("window.maxGapDays: an integer >= 4 (calendar days)");
  const C = (R && R.costs) || {};
  if (!(fin(C.roundTrip) && C.roundTrip >= 0 && C.roundTrip < 0.05)) e("costs.roundTrip: a fraction in [0, 0.05) (0.0006 = 0.06%)");
  if (!(fin(C.stress) && C.stress >= C.roundTrip)) e("costs.stress: a fraction >= costs.roundTrip (the 2x-cost gate)");
  if (!R || R.unit !== "month") e('unit must be "month" (calendar month of entry, the dip-buy family\'s registered clustering unit; nothing else is implemented)');
  const B = (R && R.bar) || {};
  if (!(fin(B.tRequired) || (Number.isInteger(B.variants) && B.variants >= 1))) e("bar: tRequired (registered) or variants (computed best-of-variants)");
  const G = (R && R.gates) || {};
  if (!(Number.isInteger(G.minTrades) && G.minTrades >= 1 && Number.isInteger(G.minMonths) && G.minMonths >= 3)) e("gates: integer minTrades >= 1 and minMonths >= 3");
  const C2 = (R && R.controls) || {};
  if (!(Number.isInteger(C2.placeboDraws) && C2.placeboDraws >= 10 && Number.isInteger(C2.placeboSeed))) e("controls: integer placeboDraws >= 10 and placeboSeed");
  if (!(Number.isInteger(C2.floorSeeds) && C2.floorSeeds >= 5)) e("controls.floorSeeds: an integer >= 5");
  if (C2.maxWholeRuleFalsePass != null && !(fin(C2.maxWholeRuleFalsePass) && C2.maxWholeRuleFalsePass >= 0 && C2.maxWholeRuleFalsePass <= 0.05)) e("controls.maxWholeRuleFalsePass in [0, 0.05] (R313's limit is 0.05; a rule may be stricter, never looser)");
  if (!(Array.isArray(C2.leakSeeds) && C2.leakSeeds.length >= 1 && C2.leakSeeds.every(Number.isInteger))) e("controls.leakSeeds: a list of integer seeds");
  if (bad.length) throw new Error("the rule is refused:\n  - " + bad.join("\n  - "));
  return R;
}
/** entries from Jan 1 of the first FULL calendar year of data (first bar on/before Jan 4), never before window.from (R313 entryFromOf, generalised) */
function entryFromOf(firstBar, from) { const y = +firstBar.slice(0, 4), full = firstBar.slice(5) <= "01-04" ? y : y + 1, f = `${full}-01-01`; return f > from ? f : from; }
/** R313's prep with the signal arrays made from the rule: sig[i] (all entry conditions true at the close of i), ex[i] (any exit condition) */
function prepRule(bars, R) {
  const n = bars.length, d = bars.map((b) => dateOf(b.t)), o = bars.map((b) => b.o), h = bars.map((b) => b.h), l = bars.map((b) => b.l), c = bars.map((b) => b.c);
  const en = R.params.entry, ex = R.params.exit || {}, ibs = bars.map(ibsOf);
  const rE = en.rsiN ? rsiWilder(c, en.rsiN) : null, rX = ex.rsiN ? rsiWilder(c, ex.rsiN) : null;
  const sB = en.closeBelowSma ? sma(c, en.closeBelowSma) : null, sT = en.trendSma ? sma(c, en.trendSma) : null, sX = ex.closeAboveSma ? sma(c, ex.closeAboveSma) : null;
  const sig = new Array(n), exv = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = true;
    if (en.ibsBelow != null) s = s && fin(ibs[i]) && ibs[i] < en.ibsBelow;
    if (en.rsiBelow != null) s = s && fin(rE[i]) && rE[i] < en.rsiBelow;
    if (sB) s = s && fin(sB[i]) && c[i] < sB[i];
    if (sT) s = s && fin(sT[i]) && c[i] > sT[i];
    sig[i] = s;
    exv[i] = (ex.ibsAbove != null && fin(ibs[i]) && ibs[i] > ex.ibsAbove) || (ex.rsiAbove != null && fin(rX[i]) && rX[i] > ex.rsiAbove) || (sX != null && fin(sX[i]) && c[i] > sX[i]);
  }
  const synth = bars.map((b) => b.v === 0 && b.o === b.h && b.h === b.l && b.l === b.c), synthCum = new Array(n);
  for (let i = 0, k = 0; i < n; i++) { if (synth[i]) k++; synthCum[i] = k; }
  return { n, d, o, h, l, c, ibs, sig, ex: exv, synth, synthCum, from: entryFromOf(d[0], R.window.from), to: R.window.to };
}
/** simulate with a time cap: as simulate (R313), and a position still open maxHold sessions after its entry is closed at that close */
function simulateCapped(P, sym, maxHold) {
  const { n, d, sig, ex, from, to } = P, closed = [], open = []; let pos = null, ignored = 0;
  const inWin = (i) => d[i] >= from && d[i] <= to;
  for (let i = 0; i < n; i++) {
    if (pos !== null) {
      if (ex[i] || i - pos >= maxHold) { closed.push({ ...mkTrade(P, sym, pos, i), capped: !ex[i] }); pos = null; }
      else if (sig[i] && inWin(i)) ignored++;
      continue;
    }
    if (sig[i] && inWin(i)) pos = i;
  }
  if (pos !== null) open.push(mkTrade(P, sym, pos, null));
  return { closed, open, ignored };
}
const simulateRule = (P, sym, R) => (R.params.maxHoldDays == null ? simulate(P, sym) : simulateCapped(P, sym, R.params.maxHoldDays));

// ── NEW: the decision (R313 decide, with the rule's own counts) ──────────────────────────────────────────────────────────
function decideRule({ trades, months, meanNet, tNW, halfFirst, halfSecond, meanNet2x, placeboPairedT, floorMeanAboveP95, floorTVsP50AtLeastBar, leakPass, positivePass, bar, minTrades, minMonths }) {
  const gates = {
    tradesAtLeastMin: trades >= minTrades, monthsAtLeastMin: months >= minMonths, meanNetPositive: meanNet != null && meanNet > 0, tAtLeastBar: tNW != null && tNW >= bar,
    correctedPlaceboPairedTAtLeastBar: placeboPairedT != null && placeboPairedT >= bar, floorMeanAboveP95: !!floorMeanAboveP95, floorTVsP50AtLeastBar: !!floorTVsP50AtLeastBar,
    bothHalvesPositive: halfFirst != null && halfSecond != null && halfFirst > 0 && halfSecond > 0, cost2xMeanPositive: meanNet2x != null && meanNet2x > 0,
    leakTestPassed: !!leakPass, positiveControlPassed: !!positivePass };
  const why = [];
  if (!gates.tradesAtLeastMin) why.push(`${trades} trades < ${minTrades}`); if (!gates.monthsAtLeastMin) why.push(`${months} months < ${minMonths}`);
  if (!gates.leakTestPassed) why.push("leak test failed"); if (!gates.positiveControlPassed) why.push("positive control failed");
  const failed = Object.keys(gates).filter((k) => !gates[k]);
  return { gates, failed, verdict: why.length ? `CANNOT MEASURE — ${why.join("; ")}` : failed.length ? "DID NOT PASS" : "PASS" };
}

// ── the null bar: backend/lib/null-bar.js, else the research server's verbatim port ─────────────────────────────────────
function loadNullBar(extra = []) {
  const here = __dirname, tries = [...extra, path.join(here, "..", "lib", "null-bar.js"), path.join(here, "..", "..", "factory", "lib", "nullbar.cjs"),
    path.join(here, "..", "..", "docs", "server", "wave6-agents", "server", "factory", "lib", "nullbar.cjs")];
  const why = [];
  for (const f of tries) {
    if (!fs.existsSync(f)) continue;
    try { const m = require(f); if (typeof m.nullBar === "function") return { nullBar: m.nullBar, path: f, sha: sha256(fs.readFileSync(f)) }; why.push(`${f}: no nullBar`); } catch (e) { why.push(`${f}: ${e.message.split("\n")[0].slice(0, 80)}`); }
  }
  throw new Error(`no null bar found (backend/lib/null-bar.js or factory/lib/nullbar.cjs)${why.length ? ": " + why.join("; ") : ""}`);
}
/**
 * the bar for n months and V variants when the rule does not carry a registered one: max(p95 of the best-of-V NW lag-1 t on uniform noise,
 * nullBar's best-of-V p95), both seeded — R313's barAtN (seed 313, 50000 / 20000 trials, n = 320 gave 1.66 / 1.658 -> 1.66), generalised to V.
 */
function barFor(n, { variants = 1, seed = 313, trialsNw = 50000, trialsIid = 20000, NB = null } = {}) {
  const rng = mulberry(seed), mx = [];
  for (let t = 0; t < trialsNw; t++) { let best = -Infinity; for (let v = 0; v < variants; v++) { const s = []; for (let i = 0; i < n; i++) s.push(rng() * 2 - 1); const x = nwT(s); if (x > best) best = x; } mx.push(best); }
  mx.sort((a, b) => a - b);
  const nb = NB || loadNullBar(), iid = nb.nullBar({ variants, n, trials: trialsIid, rng: mulberry(seed) }).p95, nw = mx[Math.floor(0.95 * trialsNw)];
  return { n, variants, seed, trialsNw, trialsIid, nwSim: r3(nw), iid: r3(iid), bar: r3(Math.max(nw, iid)), nullBarFile: nb.path || null, nullBarSha: nb.sha || null };
}

module.exports = { LEAK_T_MAX, POSITIVE_T_MIN, leakPasses, positivePasses, calibrationCeiling, fin, r4, r3, r1, sha256, ibsOf, mkTrade, simulate, sma, rmaSeeded, rsiWilder, mean, nwT, monthlySeries, summarise, strip, nearestRank, mulberry, hash, scramble,
  shiftMonth, placeboPrepC, placeboRunC, pairedDiffs, floorGate, isWeekend, loadBars, FAMILIES, checkRule, entryFromOf, prepRule, simulateCapped, simulateRule, decideRule, loadNullBar, barFor };
