"use strict";
/**
 * PLAN E PROFIT PROGRAM - model library (no printing, no network, no writes). READ-ONLY on the repo.
 *
 * TWO families, both rebuilt from the cache backend/data/profit-program/planE-inputs.json (node backend/profit-program/planE-inputs.js):
 *
 *   RM family  (daily)   risk-manager.js buildBook (+ manage + riskShares), taken VERBATIM from the file's own source text (the slice
 *                        "const W = {" .. "function summary("), run in a sandbox whose fetchBars / coinbase read the cache. Mechanical patches,
 *                        each asserted present:
 *                        (a) W -> 1 so each leg is a raw return (skipped when opts.verbatim),  (b) per-leg on/off flags and the BTC / ETH split,
 *                        (c) rows carry win / edge / ief,  (d) coinbase() reads the cache,
 *                        (e) OPTIONAL (opts.fixWindow) the proposed fix for the month-end-window defect: the window is the last 5 sessions of the
 *                        CALENDAR month, so sessions after the last bar (from planE-inputs.json calendar) are appended before the last 5 are taken.
 *                        risk-manager.js itself is never edited. The ZN leg is the repo proxy 4.2 x 0.79 x IEF adj-close return on the window;
 *                        "financed" (opts.fin in rmDaily) subtracts 4.2 x 0.79 x T-bill per window day (IEF total return includes the carry that a
 *                        future's price return does not).
 *   PY family  (monthly) plan-years.js machinery as refereed 2026-10-05: ZN leg = REAL ZN continuous-futures month-end window
 *                        (backend/data/futures-month-end.json rowsOut.tre, last 5 sessions, 4 bps round trip, roll guard; Sept 2026 recomputed from
 *                        the Schwab ZN daily store). Trend sleeves monthly with 5 bps per flip, crypto 50-day with 25 bps per switch.
 *                        This is the "defensible" 24.2 %/yr model. planE-baseline.js asserts it reproduces E 24.24 / D2 28.16 within 0.05 pt.
 *
 * MEASURED COST (work order 4.13, added 2026-10-16): the three rates the PY family assumes (5 bps a side on a trend flip, 50 bps a crypto
 * round trip, 4 bps a ZN round trip) are named in ASSUMED_COSTS at the foot of this file, and a measured set read from a small JSON file
 * (loadMeasuredCosts / parseMeasuredCosts) can be priced beside them (costCompare / costTableLines). Nothing above changes: with no
 * measured file nothing in this library is called differently and every number it gives is the number it gave before.
 */
const fs = require("fs"), path = require("path");
const BACKEND = path.join(__dirname, "..");
const D = (f) => path.join(BACKEND, "data", f);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : NaN; };
const loadInputs = () => JSON.parse(fs.readFileSync(D("profit-program/planE-inputs.json"), "utf8"));

// ---------------------------------------------------------------------------------------------------------------- RM family
/** the exact text of risk-manager.js between two anchors (for the diff + the patched copy) */
const riskManagerSource = () => fs.readFileSync(path.join(BACKEND, "risk-manager.js"), "utf8");
function rmFactory(opts) {
  const src = riskManagerSource();
  const a = src.indexOf("const W = {"), b = src.indexOf("function summary(");
  if (a < 0 || b < 0) throw new Error("risk-manager.js moved: cannot extract buildBook");
  let s = src.slice(a, b);
  const swap = (from, to) => { if (!s.includes(from)) throw new Error("patch anchor missing in risk-manager.js: " + from.slice(0, 60)); s = s.replace(from, to); };
  if (!opts.verbatim) s = s.replace(/const W = \{[^}]*\}/, "const W = { QQQ: 1, SPY: 1, GLD: 1, EFA: 1, DBMF: 1, BTC: 1, ETH: 1 }");
  swap("if (on && rr(s) != null) {", "leg[s + 'on'] = !!(on && rr(s) != null); if (on && rr(s) != null) {");
  swap('if (rr("DBMF") != null) {', 'leg.DBMFon = rr("DBMF") != null; if (rr("DBMF") != null) {');
  if (!opts.verbatim) swap("leg.CRYPTO = W.BTC * compoundCrypto(cb, p, d) + W.ETH * compoundCrypto(ce, p, d);", "leg.BTCr = compoundCrypto(cb, p, d); leg.ETHr = compoundCrypto(ce, p, d); leg.CRYPTO = W.BTC * leg.BTCr + W.ETH * leg.ETHr;");
  else swap("leg.CRYPTO = W.BTC * compoundCrypto(cb, p, d) + W.ETH * compoundCrypto(ce, p, d);", "leg.BTCr = compoundCrypto(cb, p, d); leg.ETHr = compoundCrypto(ce, p, d); leg.CRYPTO = W.BTC * leg.BTCr + W.ETH * leg.ETHr;");
  swap("rows.push({ d, rf,", "rows.push({ d, rf, win: inWin.has(d), edge: winEdge.has(d), ief: rr('IEF'), leg: { ...leg },");
  swap("async function coinbase(coin, fromIso) {", "async function coinbase(coin, fromIso) { return __cbm(coin); }\nasync function coinbase__unused(coin, fromIso) {");
  // 2026-10-12 (profit fixes B): from that fix on risk-manager.js asks sessionsToCome() for the rest of the month itself. The sandbox answers it from the cached calendar:
  // __future is the sessions still to come with opts.fixWindow and NONE without — which is the as-coded window of before the fix, so the before/after tables keep their
  // numbers. A risk-manager.js from before the fix is patched as it always was.
  if (s.includes("async function sessionsToCome(lastDay) {")) swap("async function sessionsToCome(lastDay) {", "async function sessionsToCome(lastDay) { return __future; }\nasync function sessionsToCome__unused(lastDay) {");
  else if (opts.fixWindow) swap("allDays.forEach((d) => (byMonth[d.slice(0, 7)]", "allDays.concat(__future).forEach((d) => (byMonth[d.slice(0, 7)]");
  return new Function("fs", "D", "fetchBars", "__cbm", "__future", s + "\nreturn { buildBook, manage, riskShares, W, ZN_LEV, ZN_BETA, RULE };");
}

/** RM rows 2019-06-03 .. asOf. opts { fixWindow, asOf:'YYYY-MM-DD', cryptoKey:'crypto'|'cryptoRiskManagerStyle', verbatim } -> { rows, api, lastBar, futureSessions } */
async function rmRows(inp, opts = {}) {
  const asOf = opts.asOf || "9999-12-31";
  const bars = {}; for (const s of ["QQQ", "SPY", "GLD", "EFA", "DBMF", "IEF"]) bars[s] = inp.bars[s].filter((x) => x.t.slice(0, 10) <= asOf);
  const lastBar = bars.SPY[bars.SPY.length - 1].t.slice(0, 10), ym = lastBar.slice(0, 7);
  const cal = inp.calendar[ym] || [];
  const future = opts.fixWindow ? cal.filter((x) => x > lastBar) : [];
  const fetchBars = async () => ({ bars, truncatedStart: [] });
  const todayUtc = new Date().toISOString().slice(0, 10);
  const cbm = async (coin) => { const m = new Map(); for (const [d, c] of Object.entries(inp[opts.cryptoKey || "crypto"][coin])) if (d <= asOf && d < todayUtc) m.set(d, c); return m; };
  const api = rmFactory(opts)(fs, D, fetchBars, cbm, future);
  return { rows: await api.buildBook("2019-06-03"), api, W: api.W, ZN_LEV: api.ZN_LEV, ZN_BETA: api.ZN_BETA, lastBar, futureSessions: future };
}

const E_W = { QQQ: 0.15, SPY: 0.15, GLD: 0.10, EFA: 0.10, DBMF: 0.15, BTC: 0.075, ETH: 0.075 };
const scaleW = (w, k) => Object.fromEntries(Object.entries(w).map(([q, v]) => [q, v * k]));

/**
 * Daily plan return from RM rows (rows built WITHOUT opts.verbatim). P = { w, zn } (zn = notional multiple of NAV, 4.2 = Plan E).
 * opts: fin (charge T-bill on the ZN notional x beta on each window day), znOff, cashYield (fn row -> yield on uninvested cash, default rf).
 */
function rmDaily(rows, P, opts = {}) {
  const w = P.w; let maxUsed = 0;
  const out = rows.map((x) => {
    const L = x.leg; let risky = 0, used = 0; const legs = { EQUITY: 0, GOLD: 0, DBMF: 0, CRYPTO: 0, ZN: 0, CASH: 0 };
    for (const q of ["QQQ", "SPY", "GLD", "EFA"]) if (L[q + "on"]) { const v = w[q] * L[q]; risky += v; used += w[q]; if (q === "GLD") legs.GOLD += v; else legs.EQUITY += v; }
    if (L.DBMFon) { const v = w.DBMF * L.DBMF; risky += v; used += w.DBMF; legs.DBMF += v; }
    const cr = w.BTC * L.BTCr + w.ETH * L.ETHr; risky += cr; used += w.BTC + w.ETH; legs.CRYPTO = cr;
    let zn = opts.znOff ? 0 : (P.zn / 4.2) * L.TSY;                       // L.TSY is the repo proxy at ZN_LEV 4.2 (incl. its 4 bps x 4.2 edge cost)
    if (opts.fin && x.win && !opts.znOff) zn -= P.zn * 0.79 * x.rf;      // financing: a future's price return excludes the carry IEF's total return has
    risky += zn; legs.ZN = zn; maxUsed = Math.max(maxUsed, used);
    const cy = opts.cashYield ? opts.cashYield(x) : x.rf;
    legs.CASH = used <= 1 ? (1 - used) * cy : -(used - 1) * (x.rf + 0.005 / 252);
    return { d: x.d, r: risky + legs.CASH, legs };
  });
  out.maxUsed = maxUsed; return out;
}

// ---------------------------------------------------------------------------------------------------------------- stats
function dailyStats(r) {
  let v = 1, pk = 1, dd = 0, ddAt = null; const rr = r.map((x) => (typeof x === "number" ? x : x.r)), ds = r.map((x) => x.d);
  rr.forEach((x, i) => { v *= 1 + x; pk = Math.max(pk, v); if (v / pk - 1 < dd) { dd = v / pk - 1; ddAt = ds[i]; } });
  return { days: rr.length, cagrPct: +(100 * (v ** (252 / rr.length) - 1)).toFixed(2), maxDDdailyPct: +(100 * dd).toFixed(2), ddAt, sharpe: +((mean(rr) / sd(rr)) * Math.sqrt(252)).toFixed(3), volPct: +(100 * sd(rr) * Math.sqrt(252)).toFixed(2), meanDayPct: +(100 * mean(rr)).toFixed(4) };
}
const toMonthly = (daily) => { const mo = {}; for (const x of daily) { const m = x.d.slice(0, 7); mo[m] = (mo[m] || 1) * (1 + x.r); } return Object.fromEntries(Object.entries(mo).map(([m, g]) => [m, g - 1])); };
function monthlyStats(mo) {
  const ms = Object.keys(mo).sort(), r = ms.map((m) => mo[m]); let v = 1, pk = 1, dd = 0, ddAt = null;
  for (let i = 0; i < r.length; i++) { v *= 1 + r[i]; pk = Math.max(pk, v); if (v / pk - 1 < dd) { dd = v / pk - 1; ddAt = ms[i]; } }
  const wi = r.indexOf(Math.min(...r)), yrs = {}; ms.forEach((m, i) => (yrs[m.slice(0, 4)] = (yrs[m.slice(0, 4)] || 1) * (1 + r[i])));
  return { from: ms[0], to: ms[ms.length - 1], months: r.length, annualReturnPct: +(100 * (v ** (12 / r.length) - 1)).toFixed(2), monthlyMeanPct: +(100 * mean(r)).toFixed(3), monthlySdPct: +(100 * sd(r)).toFixed(3),
    sharpe: +((mean(r) / sd(r)) * Math.sqrt(12)).toFixed(3), worstMonth: [ms[wi], +(100 * r[wi]).toFixed(2)], losingMonths: `${r.filter((x) => x < 0).length}/${r.length}`, maxDDmonthEndPct: +(100 * dd).toFixed(2), ddTroughMonth: ddAt,
    years: Object.fromEntries(Object.entries(yrs).map(([y, g]) => [y, +(100 * (g - 1)).toFixed(2)])) };
}

// ---------------------------------------------------------------------------------------------------------------- PY family
function tbillByMonth() {
  const M = {}; for (const l of fs.readFileSync(D("training/fred/DTB3.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") M[d.slice(0, 7)] = +v / 100; } return M;
}
/** real-ZN month-end windows: stored 2003-01..2026-08 (futures-month-end.json rowsOut) + 2026-09 from the Schwab ZN daily store. */
function znWindows() {
  const j = JSON.parse(fs.readFileSync(D("futures-month-end.json"), "utf8")); const rows = j.rowsOut.map((r) => ({ m: r.m, tb: r.tb, tre: r.tre, src: "futures-month-end.json" }));
  const zn = JSON.parse(fs.readFileSync(D("futures-daily/ZN.json"), "utf8")).bars, tbm = tbillByMonth();
  const sep = zn.filter((b) => b.d.startsWith("2026-09")); const w = sep.slice(-5), prev = sep[sep.length - 6];
  if (!rows.find((r) => r.m === "2026-09") && sep[sep.length - 1].d >= "2026-09-29") {
    let g = 1, pc = prev.c, maxAbs = 0; for (const b of w) { const lr = Math.log(b.c / pc); maxAbs = Math.max(maxAbs, Math.abs(lr)); g *= b.c / pc; pc = b.c; }
    // same arithmetic as futures-month-end.js: exp(sum of log returns) - 1 - 0.0004 (no roll-guard day in this window: max |daily| below)
    rows.push({ m: "2026-09", tb: (tbm["2026-09"] || 0.04) / 12, tre: g - 1 - 0.0004, src: "Schwab ZN.json (window " + w[0].d + ".." + w[w.length - 1].d + ", max |daily| " + (100 * maxAbs).toFixed(2) + "%)" });
  }
  return rows;
}
function trendMonthly(me, TBY, flipCost = 0.0005) {
  const ms = Object.keys(me).sort(), out = {}; let prevOn = null;
  for (let i = 10; i < ms.length; i++) { const on = me[ms[i - 1]] > mean(ms.slice(i - 10, i).map((m) => me[m])); out[ms[i]] = (on ? me[ms[i]] / me[ms[i - 1]] - 1 : (TBY[ms[i]] || 0) / 12) - (prevOn !== null && on !== prevOn ? flipCost : 0); prevOn = on; }
  return out;
}
const holdMonthly = (me) => { const ms = Object.keys(me).sort(), out = {}; for (let i = 1; i < ms.length; i++) out[ms[i]] = me[ms[i]] / me[ms[i - 1]] - 1; return out; };
const monthEnds = (bars, asOf) => { const me = {}; for (const b of bars) if (b.t.slice(0, 10) <= asOf) me[b.t.slice(0, 7)] = b.c; return me; };
/** crypto 50-day rule, daily. lag = extra whole days between the signal close and the position change (0 = the model). Returns Map date -> day return (cost inside). */
function cryptoDailyPY(m, TBY, switchCost = 0.0025, N = 50, lag = 0, band = 0) {
  const ds = Object.keys(m).sort(), out = new Map(), sig = []; let pos = 0;
  for (let i = N; i < ds.length; i++) {
    const r = m[ds[i]] / m[ds[i - 1]] - 1; let v = pos ? r : (TBY[ds[i].slice(0, 7)] || 0) / 365;
    const sma = mean(ds.slice(i - N + 1, i + 1).map((d) => m[d])), px = m[ds[i]], prevSig = sig.length ? sig[sig.length - 1] : 0;
    const on = band ? (prevSig ? (px > sma * (1 - band) ? 1 : 0) : (px > sma * (1 + band) ? 1 : 0)) : (px > sma ? 1 : 0); sig.push(on);
    const eff = sig.length > lag ? sig[sig.length - 1 - lag] : pos;
    if (eff !== pos) v -= switchCost; out.set(ds[i], v); pos = eff;
  }
  return out;
}
/** PY monthly legs. weights w = {L (ZN notional multiple), q,s,c,g,e,db}. opts: znScale, switchCost, trendFlip, lag, asOf, cashYieldMonthly(m,tb)->monthly yield, znRows, cryptoKey */
function pyBuild(inp, opts = {}) {
  const asOf = opts.asOf || "2026-09-30", TBY = tbillByMonth(), tf = opts.trendFlip ?? 0.0005;
  const Q = trendMonthly(monthEnds(inp.bars.QQQ, asOf), TBY, tf), S = trendMonthly(monthEnds(inp.bars.SPY, asOf), TBY, tf);
  const G = trendMonthly(monthEnds(inp.bars.GLD, asOf), TBY, tf), EF = trendMonthly(monthEnds(inp.bars.EFA, asOf), TBY, tf), DB = holdMonthly(monthEnds(inp.bars.DBMF, asOf));
  const cutC = (m) => Object.fromEntries(Object.entries(m).filter(([d]) => d <= asOf));
  const CRY = inp[opts.cryptoKey || "crypto"];
  const cb = cryptoDailyPY(cutC(CRY.BTC), TBY, opts.switchCost ?? 0.0025, opts.cryptoN || 50, opts.lag || 0, opts.band || 0), ce = cryptoDailyPY(cutC(CRY.ETH), TBY, opts.switchCost ?? 0.0025, opts.cryptoN || 50, opts.lag || 0, opts.band || 0);
  const C = {}, CB = {}, CE = {};
  for (const [d, x] of cb) { if (!ce.has(d)) continue; const m = d.slice(0, 7); C[m] = (C[m] || 1) * (1 + 0.5 * x + 0.5 * ce.get(d)); CB[m] = (CB[m] || 1) * (1 + x); CE[m] = (CE[m] || 1) * (1 + ce.get(d)); }
  for (const m in C) { C[m] -= 1; CB[m] -= 1; CE[m] -= 1; }
  const TR = new Map((opts.znRows || znWindows()).map((r) => [r.m, r]));
  const run = (lo, hi, w) => {
    const ms = Object.keys(C).filter((m) => m >= lo && m <= hi && TR.has(m) && Q[m] != null && S[m] != null && G[m] != null && EF[m] != null && DB[m] != null).sort();
    const mo = {}, legs = {};
    for (const m of ms) {
      const t = TR.get(m), inv = w.q + w.s + w.c + w.g + w.e + w.db, cy = opts.cashYieldMonthly ? opts.cashYieldMonthly(m, t.tb) : t.tb;
      const L = { ZN: w.L * (opts.znScale || 1) * t.tre, EQ: w.q * Q[m] + w.s * S[m] + w.e * EF[m], GLD: w.g * G[m], DBMF: w.db * DB[m], CRYPTO: w.c * C[m], CASH: Math.max(0, 1 - inv) * cy };
      legs[m] = L; mo[m] = L.ZN + L.EQ + L.GLD + L.DBMF + L.CRYPTO + L.CASH;
    }
    return { mo, legs, months: ms };
  };
  return { run, TR, C, CB, CE, Q, S, G, EF, DB, TBY };
}
const PYW = {
  E: { L: 4.2, q: 0.15, s: 0.15, c: 0.15, g: 0.10, e: 0.10, db: 0.15 },
  D2: { L: 4.2, q: 0.1875, s: 0.1875, c: 0.1875, g: 0.125, e: 0.125, db: 0.1875 },
};
PYW.D = Object.fromEntries(Object.entries(PYW.E).map(([k, v]) => [k, +(1.2 * v).toFixed(6)]));

// ------------------------------------------------------------------------------------------------- measured trading cost (work order 4.13)
/**
 * The PY family prices every trade from three ASSUMED rates, which is all this repo ever had. They are stated here in ONE unit each so a
 * measured number can be put beside them; nothing below changes what pyBuild does by default.
 *
 *   equityBpsPerSide        the trend sleeves (QQQ, SPY, GLD, EFA) pay trendMonthly's flipCost ONCE per flip, and a flip is ONE side
 *                           (into cash, or back out of it): the as-coded 0.0005 is 5 bps PER SIDE.
 *   cryptoBpsPerRoundTrip   cryptoDailyPY pays switchCost at EVERY switch, and a switch is one side as well: the as-coded 0.0025 is
 *                           25 bps per switch, so 50 bps PER ROUND TRIP. The measured file is read per round trip because that is how a
 *                           fill study reports it; halve it to get the per-switch charge the rule actually pays.
 *   znBpsPerRoundTrip       the real-ZN month-end windows arrive with their cost ALREADY SUBTRACTED from tre (futures-month-end.js takes
 *                           0.0004 off each window, and znWindows() does the same for the month it builds itself): 4 bps PER ROUND TRIP
 *                           of the note position, which is why a measured ZN cost is applied by repriceZnRows below and not by an opt.
 * DBMF is held, never flipped, and pays nothing here; cash pays nothing. The RM proxy family (rmRows / rmDaily) is NOT re-priced: its
 * costs are inside the text of risk-manager.js, which this library reads verbatim and never edits.
 */
const ASSUMED_COSTS = Object.freeze({ equityBpsPerSide: 5, cryptoBpsPerRoundTrip: 50, znBpsPerRoundTrip: 4 });
const COST_SPEC = "planE-measured-costs-v1";
const COST_KEYS = Object.freeze(["equityBpsPerSide", "cryptoBpsPerRoundTrip", "znBpsPerRoundTrip"]);
const COST_META_KEYS = Object.freeze(["spec", "measuredAt", "source", "note"]);
const COST_MAX_BPS = 1000;                                            // a leg costing more than 10 % a trade is a typo, not a measurement
const COST_MULTS = Object.freeze([1, 1.5, 2]);                        // the sensitivity table's multiples, named once and read by every caller

/**
 * Read a measured-cost file's TEXT -> { costs: {the three rates}, meta: { spec, measuredAt, source, note } }. Strict on purpose: a file
 * with a misspelled key would otherwise price that leg at the assumed rate and say nothing, which is the one failure this mode must not
 * have. Throws an Error naming the file and the fault.
 */
function parseMeasuredCosts(text, where = "(text)") {
  const bad = (why) => { throw new Error(`measured-cost file ${where}: ${why}`); };
  let j; try { j = JSON.parse(text); } catch (e) { bad(`it is not JSON (${e.message})`); }
  if (!j || typeof j !== "object" || Array.isArray(j)) bad("it is not a JSON object");
  if (j.spec !== COST_SPEC) bad(`spec must be "${COST_SPEC}" (it is ${JSON.stringify(j.spec)})`);
  const unknown = Object.keys(j).filter((k) => !COST_KEYS.includes(k) && !COST_META_KEYS.includes(k));
  if (unknown.length) bad(`unknown key(s) ${unknown.join(", ")} — it holds exactly ${COST_KEYS.join(", ")} (plus ${COST_META_KEYS.join(", ")})`);
  const costs = {};
  for (const k of COST_KEYS) {
    const v = j[k];
    if (v === undefined) bad(`${k} is missing`);
    if (typeof v !== "number" || !Number.isFinite(v)) bad(`${k} must be a finite number of basis points (it is ${JSON.stringify(v)})`);
    if (v < 0) bad(`${k} is negative (${v}) — a cost is never below zero`);
    if (v > COST_MAX_BPS) bad(`${k} is ${v} bps, above the ${COST_MAX_BPS} bps this reader accepts — check the unit (basis points, not percent)`);
    costs[k] = v;
  }
  for (const k of COST_META_KEYS) if (k !== "spec" && j[k] !== undefined && typeof j[k] !== "string") bad(`${k} must be a string`);
  return { costs: Object.freeze(costs), meta: Object.freeze({ spec: j.spec, measuredAt: j.measuredAt || null, source: j.source || null, note: j.note || null }) };
}
const loadMeasuredCosts = (file) => { let t; try { t = fs.readFileSync(file, "utf8"); } catch (e) { throw new Error(`measured-cost file ${file}: cannot be read (${e.code || e.message})`); } return { ...parseMeasuredCosts(t, file), file }; };
/** the same three rates, every one multiplied by k (the sensitivity table's x1 / x1.5 / x2) */
const scaleCosts = (c, k) => Object.freeze(Object.fromEntries(COST_KEYS.map((q) => [q, c[q] * k])));
/** the pyBuild opts a cost set means: the equity flip charge and the per-switch crypto charge (the ZN rate goes through repriceZnRows) */
const costOpts = (c) => ({ trendFlip: c.equityBpsPerSide / 1e4, switchCost: c.cryptoBpsPerRoundTrip / 2 / 1e4 });
/**
 * ZN windows re-priced: each stored tre already carries carriedBps of round-trip cost, so the row at bps is tre + (carried - bps) / 1e4.
 * At bps === carried the rows come back with their stored tre untouched (never tre + d - d, which would move the last bit).
 */
function repriceZnRows(rows, bps, carriedBps = ASSUMED_COSTS.znBpsPerRoundTrip) {
  const d = (carriedBps - bps) / 1e4;
  return rows.map((r) => (d === 0 ? { ...r } : { ...r, tre: r.tre + d }));
}
/** one cost set, one plan: the three numbers the work order asks for, plus what monthlyStats says around them */
function costScenario(inp, { costs, plan = "E", asOf = "2026-09-30", from = "2019-06", to = "2026-09", znRows = null, weights = null, cryptoKey = null } = {}) {
  const rows = repriceZnRows(znRows || znWindows(), costs.znBpsPerRoundTrip);
  const b = pyBuild(inp, { asOf, znRows: rows, cryptoKey: cryptoKey || undefined, ...costOpts(costs) });
  const s = monthlyStats(b.run(from, to, weights || PYW[plan]).mo);
  return { plan, costs, annualReturnPct: s.annualReturnPct, worstMonth: s.worstMonth[0], worstMonthPct: s.worstMonth[1], maxDDmonthEndPct: s.maxDDmonthEndPct, months: s.months, sharpe: s.sharpe, monthlySdPct: s.monthlySdPct };
}
/**
 * The assumed rates and the measured ones side by side, each at x1 / x1.5 / x2 ->
 *   { assumed, measured, mults, plans, rows: [{ plan, set, mult, annualReturnPct, worstMonth, worstMonthPct, maxDDmonthEndPct }] }
 * The znRows are read ONCE and handed to every scenario, so the only thing that moves between rows is the cost.
 */
function costCompare(inp, { measured, plans = ["E", "D2"], mults = COST_MULTS, asOf = "2026-09-30", from = "2019-06", to = "2026-09", znRows = null, assumed = ASSUMED_COSTS, cryptoKey = null } = {}) {
  const base = znRows || znWindows(), rows = [];
  for (const [set, c0] of [["assumed", assumed], ["measured", measured]]) {
    if (!c0) continue;
    for (const mult of mults) {                                       // one pyBuild per cost set and multiple; every plan reads that build
      const costs = scaleCosts(c0, mult), b = pyBuild(inp, { asOf, znRows: repriceZnRows(base, costs.znBpsPerRoundTrip), cryptoKey, ...costOpts(costs) });
      for (const plan of plans) { const s = monthlyStats(b.run(from, to, PYW[plan]).mo);
        rows.push({ plan, set, mult, costs, annualReturnPct: s.annualReturnPct, worstMonth: s.worstMonth[0], worstMonthPct: s.worstMonth[1], maxDDmonthEndPct: s.maxDDmonthEndPct, months: s.months, sharpe: s.sharpe, monthlySdPct: s.monthlySdPct }); }
    }
  }
  const ord = (r) => plans.indexOf(r.plan) * 100 + (r.set === "assumed" ? 0 : 10) + mults.indexOf(r.mult);
  rows.sort((a, b) => ord(a) - ord(b));
  return { assumed, measured: measured || null, plans, mults, from, to, rows };
}
const bpsWord = (k) => (k === "equityBpsPerSide" ? "bps per side" : "bps per round trip");
const costLeg = (k) => (k === "equityBpsPerSide" ? "equity (trend sleeves)" : k === "cryptoBpsPerRoundTrip" ? "crypto (per switch: half)" : "ZN (month-end window)");
/** the printed block: the two rate sets, then one line per plan / cost set / multiple. Returns the lines; nothing is printed here. */
function costTableLines(cmp) {
  const n2 = (x) => (Math.round(x * 100) / 100).toFixed(2), out = [];
  out.push("measured trading cost: the model's assumed rates beside the measured ones");
  out.push(`  leg                        assumed                     measured${cmp.measured ? "" : " (none given)"}`);
  for (const k of COST_KEYS) out.push(`  ${costLeg(k).padEnd(26)} ${(n2(cmp.assumed[k]) + " " + bpsWord(k)).padEnd(27)} ${cmp.measured ? n2(cmp.measured[k]) + " " + bpsWord(k) : "-"}`);
  out.push("");
  out.push("  plan  cost      mult   yearly%   worst month        worst drop (month-end)%   months");
  for (const r of cmp.rows) out.push(`  ${r.plan.padEnd(5)} ${r.set.padEnd(9)} ${("x" + r.mult).padEnd(5)} ${n2(r.annualReturnPct).padStart(8)}   ${r.worstMonth.padEnd(8)} ${n2(r.worstMonthPct).padStart(7)} ${n2(r.maxDDmonthEndPct).padStart(21)} ${String(r.months).padStart(10)}`);
  const at1 = (plan, set) => cmp.rows.find((r) => r.plan === plan && r.set === set && r.mult === 1);
  for (const plan of cmp.plans) {
    const a = at1(plan, "assumed"), m = at1(plan, "measured");
    const pt = (x) => (x >= 0 ? "+" : "") + n2(x);
    if (a && m) out.push(`  ${plan}: the measured cost moves the year by ${pt(m.annualReturnPct - a.annualReturnPct)} pt (${n2(a.annualReturnPct)} -> ${n2(m.annualReturnPct)}), the worst month by ${pt(m.worstMonthPct - a.worstMonthPct)} pt (${n2(a.worstMonthPct)} -> ${n2(m.worstMonthPct)}), the worst drop by ${pt(m.maxDDmonthEndPct - a.maxDDmonthEndPct)} pt (${n2(a.maxDDmonthEndPct)} -> ${n2(m.maxDDmonthEndPct)})`);
  }
  return out;
}

module.exports = { mean, sd, corr, loadInputs, riskManagerSource, rmFactory, rmRows, rmDaily, E_W, scaleW, dailyStats, toMonthly, monthlyStats, tbillByMonth, znWindows, pyBuild, PYW, D, BACKEND, cryptoDailyPY, trendMonthly, holdMonthly, monthEnds,
  ASSUMED_COSTS, COST_SPEC, COST_KEYS, COST_META_KEYS, COST_MAX_BPS, COST_MULTS, parseMeasuredCosts, loadMeasuredCosts, scaleCosts, costOpts, repriceZnRows, costScenario, costCompare, costTableLines };
