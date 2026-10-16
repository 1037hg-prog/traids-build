#!/usr/bin/env node
"use strict";
/**
 * PART B — REBALANCING CADENCE for the core (Plan E) book. 2026-10-02.
 *
 * DESIGN ANALYSIS of a known allocation rule (operator 09-25: known allocation rules are book building blocks and are never
 * registered as tests). This script registers nothing, sends no orders, and does not touch backend/book-etf-rebalancer.js or
 * any live runner. It only reads market data and writes JSON + markdown into this folder.
 *
 * WHAT IT SIMULATES (daily, dollars, fractional shares)
 *   Book = Plan E as coded in backend/book-etf-rebalancer.js: QQQ 15, SPY 15, GLD 10, EFA 10 (trend sleeves), DBMF 15 (always),
 *   JAAA 8 (always), all /73 of NAV; an OUT trend sleeve parks its weight in SGOV. Start NAV $73,000 (nominal; the $500 band
 *   floor is in nominal dollars, as in the live code).
 *   (a) static weights (no trend rule) rebalanced monthly / quarterly / semiannual / annual / never
 *   (b) static weights with tolerance bands: 5 / 10 / 20 % relative and 5-point absolute, checked daily or at month-end;
 *       on a breach the WHOLE book goes back to target ("full"); plus "partial" variants (only breached sleeves trade, as Plan E)
 *   (c) Plan E trend rule, signal evaluated weekly / monthly / quarterly:
 *       literal  = at each evaluation recompute signals and rebalance every sleeve to target (what the live code does at month-end)
 *       flip     = at each evaluation recompute signals and trade only sleeves whose signal flipped (+ SGOV)
 *       each with the live daily band (|gap| > max(10% x max(target,held), $500), breached sleeves only) or with no band
 *
 * CONVENTIONS (all stated in results.json -> assumptions)
 *   - completed daily closes only; last session 2026-10-01 (run on 10-02 before the close)
 *   - decision at close t, fill at close t+1 (1-session lag; live code fills at the next open). Lag-0 run as a sensitivity.
 *   - cost 5 bps of traded notional per trade (ETFs); 0/10/25 bps sensitivity. Initial funding trade is free for every schedule.
 *   - uninvested cash (residual of partial trades) earns 0% (Alpaca paper cash earns nothing)
 *   - Sharpe vs FRED DTB3 (3-month T-bill, daily rate = DTB3/100/252, forward-filled)
 *   - worst 12 months = worst rolling 252-session return
 *   - turnover = sum |traded $| / NAV at the time, two-sided, per year
 *
 *   node "docs/core-model-2026-10-02/partB/cadence-backtest.cjs" [--refresh]
 */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..");
const BACKEND = path.join(ROOT, "backend");
const { fetchBars } = require(path.join(BACKEND, "lib", "alpaca-bars.js"));
const OUT = __dirname, CACHE = path.join(OUT, "data-cache.json");
const END = "2026-10-01";
const REFRESH = process.argv.includes("--refresh");
const NAV0 = 73000;

// ───────────────────────────────────────────── data ─────────────────────────────────────────────
const YAHOO_SYMS = ["SPY", "QQQ", "GLD", "EFA", "BIL", "DBMF", "SGOV", "JAAA", "AQMIX", "RYMFX"];
const ALPACA_SYMS = ["SPY", "QQQ", "GLD", "EFA", "BIL", "DBMF", "SGOV", "JAAA"];

async function yahoo(sym) {
  const r = await fetch(`http://localhost:3002/api/yahoo/${sym}/history?days=8200&interval=1d`, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`yahoo ${sym} HTTP ${r.status}`);
  const j = await r.json();
  if (j.degraded) throw new Error(`yahoo ${sym} served degraded (${j.source}) — refusing`);
  const bars = (j.bars || []).filter((b) => b.date <= END && b.adjClose > 0);
  const raw = bars.filter((b) => b.adjSource !== "dividend-adjusted");
  if (raw.length) throw new Error(`yahoo ${sym}: ${raw.length} bars are raw close, not dividend-adjusted — refusing`);
  if (!bars.length || bars[bars.length - 1].date !== END) throw new Error(`yahoo ${sym}: last bar ${bars.length ? bars[bars.length - 1].date : "none"} != ${END}`);
  const m = new Map(); for (const b of bars) m.set(b.date, b.adjClose);   // de-dup by date
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function alpaca() {
  const r = await fetchBars(ALPACA_SYMS, { start: "2015-12-01", end: `${END}T16:00:00-04:00`, feed: "sip", adjustment: "all", quiet: true });
  const out = {};
  for (const s of ALPACA_SYMS) {
    const b = r.bars[s] || []; if (!b.length) throw new Error(`alpaca ${s}: no bars`);
    const last = b[b.length - 1].t.slice(0, 10); if (last !== END) throw new Error(`alpaca ${s}: last bar ${last} != ${END}`);
    out[s] = b.map((x) => [x.t.slice(0, 10), x.c]);
  }
  return out;
}
function tbill() {
  const M = []; for (const l of fs.readFileSync(path.join(BACKEND, "data", "training", "fred", "DTB3.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== "." && d >= "2004-01-01") M.push([d, +v]); }
  return M;
}
async function loadData() {
  if (!REFRESH && fs.existsSync(CACHE)) { const c = JSON.parse(fs.readFileSync(CACHE, "utf8")); if (c.end === END) return c; }
  const y = {}; for (const s of YAHOO_SYMS) { y[s] = await yahoo(s); process.stdout.write(`  yahoo ${s} ${y[s].length} bars from ${y[s][0][0]}\n`); }
  const a = await alpaca(); for (const s of ALPACA_SYMS) process.stdout.write(`  alpaca ${s} ${a[s].length} bars from ${a[s][0][0]}\n`);
  const c = { end: END, fetchedAt: new Date().toISOString(), yahoo: y, alpaca: a, dtb3: tbill() };
  fs.writeFileSync(CACHE, JSON.stringify(c));
  return c;
}

// ───────────────────────────────────────────── helpers ─────────────────────────────────────────────
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const r2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));
const pct = (x, d = 2) => r2(100 * x, d);
const ym = (d) => d.slice(0, 7);
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const dayNum = (d) => Date.parse(d + "T12:00:00Z") / 864e5;
function corr(a, b) { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); }
function spearman(a, b) { const rk = (v) => { const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length); idx.forEach(([, i], k) => (r[i] = k)); return r; }; return corr(rk(a), rk(b)); }

/** dataset: aligned calendar (SPY dates), ffilled adjusted prices, spliced sleeve returns, T-bill daily rate */
function buildDataset(name, src, chains, opts) {
  const dates = src.SPY.map((x) => x[0]).filter((d) => d <= END && d >= (opts.calStart || "0000"));
  const N = dates.length, P = {}, first = {};
  for (const [s, rows] of Object.entries(src)) {
    const m = new Map(rows); const arr = new Array(N).fill(null); let last = null, f = null;
    for (let i = 0; i < N; i++) { const v = m.get(dates[i]); if (v != null) { last = v; if (f == null) f = i; } arr[i] = last; }
    P[s] = arr; first[s] = f;
  }
  // T-bill daily rate, forward-filled
  const tb = new Map(opts.dtb3); let lastT = null; const rf = new Array(N);
  const tbKeys = opts.dtb3.map((x) => x[0]); let k = 0;
  for (let i = 0; i < N; i++) { while (k < tbKeys.length && tbKeys[k] <= dates[i]) { lastT = tb.get(tbKeys[k]); k++; } rf[i] = lastT == null ? 0 : lastT / 100 / 252; }
  // sleeve returns through splice chains: first source in the chain with genuine prices at i-1 and i
  const R = {}, srcUse = {};
  for (const [sleeve, chain] of Object.entries(chains)) {
    const r = new Float64Array(N); const use = new Array(N).fill(null); const cnt = {};
    for (let i = 1; i < N; i++) {
      for (const s of chain) { const p = P[s]; if (!p || first[s] == null || i - 1 < first[s]) continue; r[i] = p[i] / p[i - 1] - 1; use[i] = s; break; }
      if (use[i]) cnt[use[i]] = (cnt[use[i]] || 0) + 1;
    }
    R[sleeve] = r; srcUse[sleeve] = { use, cnt };
  }
  // month-end flags from the calendar (the next trading date is known in advance: calendar knowledge, not look-ahead)
  const isME = dates.map((d, i) => (i === N - 1 ? false : ym(dates[i + 1]) !== ym(d)));
  const isWE = dates.map((d, i) => (i === N - 1 ? false : dayNum(dates[i + 1]) - dayNum(d) >= 7 || dow(dates[i + 1]) <= dow(d)));
  return { name, dates, N, P, first, R, rf, srcUse, isME, isWE, chains };
}

// ───────────────────────────────────────────── Plan E sleeves ─────────────────────────────────────────────
const TREND = ["QQQ", "SPY", "GLD", "EFA"];
const SLEEVES = ["QQQ", "SPY", "GLD", "EFA", "DBMF", "JAAA", "SGOV"];
const BASE_E = { QQQ: 15, SPY: 15, GLD: 10, EFA: 10, DBMF: 15, JAAA: 8, SGOV: 0 };
function baseWeights(dropMF) { const b = { ...BASE_E }; if (dropMF) b.DBMF = 0; const tot = Object.values(b).reduce((x, y) => x + y, 0); const w = {}; for (const k of SLEEVES) w[k] = b[k] / tot; return w; }

/** Plan E 10-month rule at index i: close_i > mean(9 prior month-end closes + close_i) on adjusted closes */
function makeSignalFn(ds) {
  const meIdx = {}; for (const s of TREND) { const list = []; for (let i = 0; i < ds.N; i++) if (ds.isME[i] && ds.P[s][i] != null) list.push(i); meIdx[s] = list; }
  return (i) => {
    const sig = {};
    for (const s of TREND) {
      const m = ym(ds.dates[i]), prior = meIdx[s].filter((j) => ym(ds.dates[j]) < m).slice(-9);
      if (prior.length < 9) return null;
      const c = ds.P[s][i], avg = (prior.reduce((a, j) => a + ds.P[s][j], 0) + c) / 10;
      sig[s] = c > avg;
    }
    return sig;
  };
}
function targetW(base, sig) {
  const w = { ...base }; if (!sig) return w;
  let park = 0; for (const s of TREND) if (!sig[s]) { park += base[s]; w[s] = 0; }
  w.SGOV = base.SGOV + park; return w;
}

// ───────────────────────────────────────────── schedules ─────────────────────────────────────────────
const PLANE_BAND = { type: "rel", x: 0.10, floorUsd: 500 };
function schedules() {
  const S = [];
  for (const [cal, lab] of [["M", "monthly"], ["Q", "quarterly"], ["S", "semiannual"], ["A", "annual"], [null, "never"]]) S.push({ id: `a-static-${lab}`, fam: "a", kind: "static", cal, label: `static, rebalance ${lab}` });
  for (const check of ["daily", "monthly"]) for (const b of [{ type: "rel", x: 0.05 }, { type: "rel", x: 0.10 }, { type: "rel", x: 0.20 }, { type: "abs", x: 0.05 }]) {
    const bl = b.type === "rel" ? `${b.x * 100}% rel` : `${b.x * 100}pt abs`;
    S.push({ id: `b-band-${b.type}${b.x * 100}-${check}-full`, fam: "b", kind: "static", band: b, check, bandMode: "full", label: `static, ${bl} band checked ${check}, breach -> whole book to target` });
  }
  S.push({ id: "b-band-rel10-daily-partial", fam: "b", kind: "static", band: PLANE_BAND, check: "daily", bandMode: "partial", label: "static, Plan E band (10% rel, $500 floor) daily, breached sleeves only" });
  S.push({ id: "b-band-rel20-daily-partial", fam: "b", kind: "static", band: { type: "rel", x: 0.20, floorUsd: 500 }, check: "daily", bandMode: "partial", label: "static, 20% rel band ($500 floor) daily, breached sleeves only" });
  for (const [ev, lab] of [["W", "weekly"], ["M", "monthly"], ["Q", "quarterly"]]) {
    S.push({ id: `c-trend-${lab}-literal-band10`, fam: "c", kind: "trend", ev, mode: "literal", band: PLANE_BAND, label: `Plan E trend, signal ${lab}, full rebalance at each evaluation, daily 10% band` });
    S.push({ id: `c-trend-${lab}-literal-noband`, fam: "c", kind: "trend", ev, mode: "literal", band: null, label: `Plan E trend, signal ${lab}, full rebalance at each evaluation, no band` });
    S.push({ id: `c-trend-${lab}-flip-band10`, fam: "c", kind: "trend", ev, mode: "flip", band: PLANE_BAND, label: `Plan E trend, signal ${lab}, trade only flipped sleeves, daily 10% band` });
  }
  return S;
}
const isCal = (ds, i, cal) => { if (!ds.isME[i]) return false; const mo = +ds.dates[i].slice(5, 7); return cal === "M" || (cal === "Q" && mo % 3 === 0) || (cal === "S" && mo % 6 === 0) || (cal === "A" && mo === 12); };
const isEval = (ds, i, ev) => (ev === "W" ? ds.isWE[i] || ds.isME[i] : isCal(ds, i, ev));   // weekly evaluation also fires at month-end (the live month-end close is always evaluated)

function breached(sched, band, h, cash, tw, nav) {
  const out = [];
  for (const k of SLEEVES) {
    const tgt = tw[k] * nav, held = h[k];
    if (tgt === 0 && held === 0) continue;
    if (tgt === 0 && held > 1) { out.push(k); continue; }
    let hit;
    if (band.type === "abs") hit = Math.abs(held / nav - tw[k]) > band.x;
    else hit = Math.abs(tgt - held) > Math.max(band.x * Math.max(tgt, held), band.floorUsd || 0);
    if (hit) out.push(k);
  }
  return out;
}

// ───────────────────────────────────────────── engine ─────────────────────────────────────────────
function simulate(ds, sched, o) {
  const { i0, costBps = 5, lag = 1, dropMF = false, minTradeUsd = 100 } = o;
  const base = baseWeights(dropMF), sigFn = makeSignalFn(ds), c = costBps / 1e4;
  let sig = sched.kind === "trend" ? sigFn(i0) : null; if (sched.kind === "trend" && !sig) throw new Error(`${ds.name}: no signal at start`);
  let tw = targetW(base, sig);
  const h = {}; for (const k of SLEEVES) h[k] = tw[k] * NAV0; let cash = 0;
  const nav = new Float64Array(ds.N).fill(NaN); nav[i0] = NAV0;
  let pending = null, nTrades = 0, turn = 0, costPaid = 0, flips = 0, cashSum = 0, scaledBuys = 0, inDays = {}; for (const s of TREND) inDays[s] = 0;
  const tradeLog = [], yearTrades = {};
  let costFrac = 0;
  const execute = (i, p) => {
    const N = SLEEVES.reduce((a, k) => a + h[k], 0) + cash; let tot = 0, cnt = 0;
    const list = p.full ? SLEEVES : p.syms;
    let trades = list.map((k) => [k, p.tw[k] * N - h[k]]).filter(([, t]) => Math.abs(t) >= (p.full ? minTradeUsd : 1));
    if (!p.full) {
      // live-code cash rule: buys are limited to book cash + this batch's sell proceeds (scaled pro rata), so a partial
      // (breached-sleeves-only) trade can never lever the book. Full rebalances are self-funding by construction.
      const sells = trades.filter(([, t]) => t < 0).reduce((a, [, t]) => a - t, 0), buys = trades.filter(([, t]) => t > 0).reduce((a, [, t]) => a + t, 0);
      const cap = Math.max(0, (cash + sells * (1 - c)) / (1 + c));
      if (buys > cap) { const sc = buys > 0 ? cap / buys : 0; trades = trades.map(([k, t]) => [k, t > 0 ? t * sc : t]).filter(([, t]) => Math.abs(t) >= 1); scaledBuys++; }
    }
    for (const [k, t] of trades) { h[k] += t; cash -= t; tot += Math.abs(t); cnt++; }
    const cost = tot * c; cash -= cost; costPaid += cost; costFrac += cost / N; turn += tot / N; nTrades += cnt;
    const y = ds.dates[i].slice(0, 4); yearTrades[y] = (yearTrades[y] || 0) + cnt;
    if (cnt) tradeLog.push({ d: ds.dates[i], n: cnt, usd: Math.round(tot), full: !!p.full });
  };
  for (let i = i0; i < ds.N; i++) {
    if (i > i0) {
      for (const k of SLEEVES) h[k] *= 1 + ds.R[k][i];
      if (pending) { execute(i, pending); pending = null; }
    }
    const navNow = SLEEVES.reduce((a, k) => a + h[k], 0) + cash;
    // decision at close i
    let dec = null;
    if (i > i0) {
      if (sched.kind === "static") {
        if (sched.cal !== undefined && !sched.band) { if (sched.cal && isCal(ds, i, sched.cal)) dec = { full: true, tw }; }
        else if (sched.band && (sched.check === "daily" || ds.isME[i])) {
          const b = breached(sched, sched.band, h, cash, tw, navNow);
          if (b.length) dec = sched.bandMode === "full" ? { full: true, tw } : { syms: b, tw };
        }
      } else {
        if (isEval(ds, i, sched.ev)) {
          const ns = sigFn(i); const changed = TREND.filter((s) => ns[s] !== sig[s]); flips += changed.length; sig = ns; tw = targetW(base, sig);
          if (sched.mode === "literal") dec = { full: true, tw };
          else { const set = new Set(changed.length ? [...changed, "SGOV"] : []); if (sched.band) for (const k of breached(sched, sched.band, h, cash, tw, navNow)) set.add(k); if (set.size) dec = { syms: [...set], tw }; }
        } else if (sched.band) {
          const b = breached(sched, sched.band, h, cash, tw, navNow); if (b.length) dec = { syms: b, tw };
        }
      }
    }
    if (dec) { if (lag === 0) execute(i, dec); else pending = dec; }
    nav[i] = SLEEVES.reduce((a, k) => a + h[k], 0) + cash;
    if (i > i0) { cashSum += cash / nav[i]; if (sig) for (const s of TREND) if (sig[s]) inDays[s]++; }
  }
  const days = ds.N - 1 - i0, years = (dayNum(ds.dates[ds.N - 1]) - dayNum(ds.dates[i0])) / 365.25;
  return { nav, i0, years, nTrades, turnPerYr: turn / years, tradesPerYr: nTrades / years, costPaid, costDragPerYr: costFrac / years, scaledBuys, flipsPerYr: flips / years, avgCashPct: (100 * cashSum) / days, inPct: Object.fromEntries(Object.entries(inDays).map(([k, v]) => [k, r2((100 * v) / days, 1)])), tradeLog, yearTrades };
}

/** metrics from a NAV path between indices s..e */
function metrics(ds, nav, s, e) {
  const r = [], ex = [];
  for (let i = s + 1; i <= e; i++) { const x = nav[i] / nav[i - 1] - 1; r.push(x); ex.push(x - ds.rf[i]); }
  const years = (dayNum(ds.dates[e]) - dayNum(ds.dates[s])) / 365.25;
  const cagr = (nav[e] / nav[s]) ** (1 / years) - 1, vol = sd(r) * Math.sqrt(252), sharpe = (mean(ex) / sd(ex)) * Math.sqrt(252);
  let pk = nav[s], pkI = s, dd = 0, ddPk = s, ddTr = s;
  for (let i = s; i <= e; i++) { if (nav[i] > pk) { pk = nav[i]; pkI = i; } const d = nav[i] / pk - 1; if (d < dd) { dd = d; ddPk = pkI; ddTr = i; } }
  let w12 = Infinity, w12I = null; for (let i = s + 252; i <= e; i++) { const x = nav[i] / nav[i - 252] - 1; if (x < w12) { w12 = x; w12I = i; } }
  // month-end returns
  const me = []; for (let i = s; i <= e; i++) if (i === s || ds.isME[i] || i === e) me.push(i);
  const mr = []; for (let k = 1; k < me.length; k++) mr.push(nav[me[k]] / nav[me[k - 1]] - 1);
  return { cagr, vol, sharpe, maxDD: dd, ddPeak: ds.dates[ddPk], ddTrough: ds.dates[ddTr], worst12m: w12 === Infinity ? null : w12, worst12mEnd: w12I == null ? null : ds.dates[w12I], monthlyMean: mean(mr), monthlyWinRate: mr.filter((x) => x > 0).length / mr.length, nMonths: mr.length, years };
}
function monthlyReturns(ds, nav, s, e) { const me = []; for (let i = s; i <= e; i++) if (i === s || ds.isME[i] || i === e) me.push(i); const out = []; for (let k = 1; k < me.length; k++) out.push(nav[me[k]] / nav[me[k - 1]] - 1); return { r: out, idx: me }; }
function paired(ds, a, b, s, e) {
  const A = monthlyReturns(ds, a, s, e).r, B = monthlyReturns(ds, b, s, e).r, d = A.map((x, i) => x - B[i]);
  const nz = d.filter((x) => Math.abs(x) > 1e-5);
  const m = mean(d), t = sd(d) > 0 ? (m / sd(d)) * Math.sqrt(d.length) : 0;
  return { meanDiffPctPerYr: pct(m * 12, 3), tStat: r2(t, 2), monthsWon: nz.filter((x) => x > 0).length, monthsLost: nz.filter((x) => x < 0).length, monthsTied: d.length - nz.length, winRateOfDecidedMonths: nz.length ? pct(nz.filter((x) => x > 0).length / nz.length, 1) : null, n: d.length };
}

function fmtRun(ds, sched, run, gross, metricsNet, metricsGross) {
  return {
    id: sched.id, fam: sched.fam, label: sched.label,
    cagrPct: pct(metricsNet.cagr), volPct: pct(metricsNet.vol), sharpe: r2(metricsNet.sharpe, 3),
    maxDDPct: pct(metricsNet.maxDD), maxDDPeak: metricsNet.ddPeak, maxDDTrough: metricsNet.ddTrough,
    worst12mPct: pct(metricsNet.worst12m), worst12mEnd: metricsNet.worst12mEnd,
    monthlyMeanPct: pct(metricsNet.monthlyMean, 3), monthlyWinRatePct: pct(metricsNet.monthlyWinRate, 1),
    turnoverPctPerYr: pct(run.turnPerYr, 1), tradesPerYr: r2(run.tradesPerYr, 1),
    costDragPctPerYr: r2(100 * run.costDragPerYr, 3), grossCagrPct_zeroCostRun: pct(metricsGross.cagr, 3), daysBuysCutForLackOfCash: run.scaledBuys,
    signalFlipsPerYr: sched.kind === "trend" ? r2(run.flipsPerYr, 2) : null, trendInPct: sched.kind === "trend" ? run.inPct : null,
    avgUninvestedCashPct: r2(run.avgCashPct, 2), endNav: Math.round(run.nav[ds.N - 1]),
  };
}

// ───────────────────────────────────────────── analysis per dataset ─────────────────────────────────────────────
function rankArr(vals) { const idx = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]); const r = new Array(vals.length); idx.forEach(([, i], k) => (r[i] = k + 1)); return r; }

function analyse(ds, i0, opt) {
  const S = schedules(), runs = {}, gross = {}, table = [];
  for (const sc of S) {
    runs[sc.id] = simulate(ds, sc, { i0, costBps: opt.costBps ?? 5, lag: opt.lag ?? 1, dropMF: opt.dropMF });
    gross[sc.id] = simulate(ds, sc, { i0, costBps: 0, lag: opt.lag ?? 1, dropMF: opt.dropMF });
    const mN = metrics(ds, runs[sc.id].nav, i0, ds.N - 1), mG = metrics(ds, gross[sc.id].nav, i0, ds.N - 1);
    table.push(fmtRun(ds, sc, runs[sc.id], gross[sc.id], mN, mG));
  }
  // paired vs family baselines
  const baseOf = (sc) => (sc.fam === "c" ? "c-trend-monthly-literal-band10" : "a-static-monthly");
  for (const row of table) { const sc = S.find((x) => x.id === row.id); const b = baseOf(sc); row.vsBaseline = b === row.id ? null : { baseline: b, ...paired(ds, runs[row.id].nav, runs[b].nav, i0, ds.N - 1) }; }
  // rolling 3-year windows (month-end starts, 36 months), net of cost
  const me = []; for (let i = i0; i < ds.N; i++) if (i === i0 || ds.isME[i]) me.push(i);
  const wins = []; for (let k = 0; k + 36 < me.length; k++) wins.push([me[k], me[k + 36]]);
  // ranking families. The no-band trend variants are near-duplicates of their band10 twins (they differ in <2% of months), so they are
  // left out of the c rankings — duplicates would split first places arbitrarily.
  const fams = {
    a_staticCalendar: S.filter((x) => x.fam === "a").map((x) => x.id),
    b_staticAll: S.filter((x) => x.fam !== "c").map((x) => x.id),
    c_literal_WMQ: ["c-trend-weekly-literal-band10", "c-trend-monthly-literal-band10", "c-trend-quarterly-literal-band10"],
    c_flip_WMQ: ["c-trend-weekly-flip-band10", "c-trend-monthly-flip-band10", "c-trend-quarterly-flip-band10"],
    c_band10_all: S.filter((x) => x.fam === "c" && /band10$/.test(x.id)).map((x) => x.id),
  };
  const W = wins.map(([s, e]) => { const o = {}; for (const sc of S) { const m = metrics(ds, runs[sc.id].nav, s, e); o[sc.id] = { cagr: m.cagr, sharpe: m.sharpe, dd: m.maxDD }; } return { s: ds.dates[s], e: ds.dates[e], o }; });
  const fullSharpe = Object.fromEntries(table.map((r) => [r.id, r.sharpe]));
  const rolling = {};
  for (const [fam, ids] of Object.entries(fams)) {
    const per = Object.fromEntries(ids.map((id) => [id, { ranksSharpe: [], ranksCagr: [], beatBaseSharpe: 0, beatBaseCagr: 0, shallowerDD: 0, cagrs: [] }]));
    const rhoFull = [];
    const baseId = fam.startsWith("c") ? "c-trend-monthly-literal-band10" : "a-static-monthly";
    for (const w of W) {
      const sh = ids.map((id) => w.o[id].sharpe), cg = ids.map((id) => w.o[id].cagr), rS = rankArr(sh), rC = rankArr(cg);
      ids.forEach((id, j) => { per[id].ranksSharpe.push(rS[j]); per[id].ranksCagr.push(rC[j]); per[id].cagrs.push(w.o[id].cagr); if (w.o[id].sharpe > w.o[baseId].sharpe) per[id].beatBaseSharpe++; if (w.o[id].cagr > w.o[baseId].cagr) per[id].beatBaseCagr++; if (w.o[id].dd > w.o[baseId].dd) per[id].shallowerDD++; });
      rhoFull.push(spearman(sh, ids.map((id) => fullSharpe[id])));
    }
    // rank stability between NON-overlapping windows (start 36 months apart)
    const rhoNonOverlap = []; for (let k = 0; k + 36 < W.length; k++) rhoNonOverlap.push(spearman(ids.map((id) => W[k].o[id].sharpe), ids.map((id) => W[k + 36].o[id].sharpe)));
    const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
    rolling[fam] = {
      baseline: baseId, nWindows: W.length, firstWindow: W.length ? `${W[0].s}..${W[0].e}` : null, lastWindow: W.length ? `${W[W.length - 1].s}..${W[W.length - 1].e}` : null,
      spearmanWindowVsFullSample: { median: r2(q(rhoFull, 0.5), 2), p10: r2(q(rhoFull, 0.1), 2), shareNegative: pct(rhoFull.filter((x) => x < 0).length / rhoFull.length, 1) },
      spearmanWindowVsWindow36mLater: rhoNonOverlap.length ? { median: r2(q(rhoNonOverlap, 0.5), 2), p10: r2(q(rhoNonOverlap, 0.1), 2), shareNegative: pct(rhoNonOverlap.filter((x) => x < 0).length / rhoNonOverlap.length, 1), n: rhoNonOverlap.length } : null,
      bySchedule: Object.fromEntries(ids.map((id) => { const p = per[id]; return [id, { medianRankSharpe: q(p.ranksSharpe, 0.5), meanRankSharpe: r2(mean(p.ranksSharpe), 2), pctWindowsRank1Sharpe: pct(p.ranksSharpe.filter((x) => x === 1).length / W.length, 1), pctWindowsLastSharpe: pct(p.ranksSharpe.filter((x) => x === ids.length).length / W.length, 1), pctWindowsRank1Cagr: pct(p.ranksCagr.filter((x) => x === 1).length / W.length, 1), pctWindowsTopThirdSharpe: pct(p.ranksSharpe.filter((x) => x <= Math.ceil(ids.length / 3)).length / W.length, 1), medianRankCagr: q(p.ranksCagr, 0.5), pctWindowsBeatBaselineSharpe: id === baseId ? null : pct(p.beatBaseSharpe / W.length, 1), pctWindowsBeatBaselineCagr: id === baseId ? null : pct(p.beatBaseCagr / W.length, 1), pctWindowsShallowerMaxDDThanBaseline: id === baseId ? null : pct(p.shallowerDD / W.length, 1), worst3yCagrPct: pct(Math.min(...p.cagrs)), median3yCagrPct: pct(q(p.cagrs, 0.5)) }]; })),
    };
  }
  return { table, runs, gross, rolling, i0 };
}

// ───────────────────────────────────────────── main ─────────────────────────────────────────────
(async () => {
  const D = await loadData();
  // ---- data validation: Yahoo adjClose vs Alpaca adjustment=all on the overlap
  const validation = { yahooVsAlpaca: {}, proxies: {}, bigMoves: {} };
  for (const s of ALPACA_SYMS) {
    const ya = new Map(D.yahoo[s]), al = D.alpaca[s]; const ry = [], ra = [];
    for (let i = 1; i < al.length; i++) { const d0 = al[i - 1][0], d1 = al[i][0]; if (ya.has(d0) && ya.has(d1)) { ry.push(ya.get(d1) / ya.get(d0) - 1); ra.push(al[i][1] / al[i - 1][1] - 1); } }
    const ann = (r) => r.reduce((p, x) => p * (1 + x), 1) ** (252 / r.length) - 1;
    validation.yahooVsAlpaca[s] = { days: ry.length, from: al[0][0], corrDaily: r2(corr(ry, ra), 5), annRetYahooPct: pct(ann(ry)), annRetAlpacaPct: pct(ann(ra)), maxAbsDailyDiffPct: pct(Math.max(...ry.map((x, i) => Math.abs(x - ra[i]))), 3) };
  }
  // big daily moves (data-error screen)
  for (const s of YAHOO_SYMS) { const rows = D.yahoo[s]; const big = []; for (let i = 1; i < rows.length; i++) { const x = rows[i][1] / rows[i - 1][1] - 1; if (Math.abs(x) > (["BIL", "SGOV", "JAAA"].includes(s) ? 0.02 : 0.12)) big.push([rows[i][0], pct(x)]); } validation.bigMoves[s] = big.slice(0, 15); }
  // proxy quality on overlaps (month-end returns)
  const meRet = (rows, from) => { const me = {}; for (const [d, p] of rows) if (d >= from) me[ym(d)] = p; const ks = Object.keys(me).sort(); const o = {}; for (let k = 1; k < ks.length; k++) o[ks[k]] = me[ks[k]] / me[ks[k - 1]] - 1; return o; };
  const cmp = (a, b, from, label) => { const A = meRet(D.yahoo[a], from), B = meRet(D.yahoo[b], from); const ks = Object.keys(A).filter((k) => B[k] != null && k < "2026-10"); const x = ks.map((k) => A[k]), y = ks.map((k) => B[k]); const ann = (r) => r.reduce((p, v) => p * (1 + v), 1) ** (12 / r.length) - 1; return { label, months: ks.length, from: ks[0], corrMonthly: r2(corr(x, y), 3), [`${a}AnnRetPct`]: pct(ann(x)), [`${b}AnnRetPct`]: pct(ann(y)), [`${a}VolPct`]: pct(sd(x) * Math.sqrt(12)), [`${b}VolPct`]: pct(sd(y) * Math.sqrt(12)) }; };
  validation.proxies = { DBMF_vs_AQMIX: cmp("DBMF", "AQMIX", "2019-05-31", "DBMF actual vs AQMIX proxy"), DBMF_vs_RYMFX: cmp("DBMF", "RYMFX", "2019-05-31", "DBMF actual vs RYMFX proxy"), AQMIX_vs_RYMFX: cmp("AQMIX", "RYMFX", "2010-01-29", "AQMIX vs RYMFX (bridge 2010-01)"), SGOV_vs_BIL: cmp("SGOV", "BIL", "2020-06-30", "SGOV actual vs BIL proxy"), JAAA_vs_BIL: cmp("JAAA", "BIL", "2020-10-30", "JAAA actual vs BIL proxy") };

  // ---- datasets
  const yahooChains = { QQQ: ["QQQ"], SPY: ["SPY"], GLD: ["GLD"], EFA: ["EFA"], DBMF: ["DBMF", "AQMIX", "RYMFX"], JAAA: ["JAAA", "BIL"], SGOV: ["SGOV", "BIL"] };
  const dsY = buildDataset("yahoo-long", D.yahoo, yahooChains, { dtb3: D.dtb3, calStart: "2005-01-01" });
  // DBMF in the Alpaca runs comes from Yahoo: Alpaca adjustment=all misses DBMF's 2019-12-30 distribution (prints -9.04% that day vs
  // Yahoo -0.91%), which alone costs ~1.1%/yr over the overlap; 2020-2025 calendar-year returns of the two sources agree within 0.3%.
  const alSrc = { ...D.alpaca, DBMF: D.yahoo.DBMF, AQMIX: D.yahoo.AQMIX };
  const dsA = buildDataset("alpaca-2016", alSrc, { QQQ: ["QQQ"], SPY: ["SPY"], GLD: ["GLD"], EFA: ["EFA"], DBMF: ["DBMF", "AQMIX"], JAAA: ["JAAA", "BIL"], SGOV: ["SGOV", "BIL"] }, { dtb3: D.dtb3, calStart: "2016-01-04" });
  const idx = (ds, d) => { const i = ds.dates.indexOf(d); if (i < 0) throw new Error(`${ds.name}: ${d} not a session`); if (!ds.isME[i]) throw new Error(`${ds.name}: ${d} is not a month-end`); return i; };
  const START_LONG = "2007-05-31", START_ALP = "2016-10-31", START_REAL = "2020-10-30";
  // every chain must have a genuine price at the start
  for (const [ds, st] of [[dsY, START_LONG], [dsA, START_ALP], [dsA, START_REAL]]) { const i = ds.dates.indexOf(st); for (const [k, ch] of Object.entries(ds.chains)) if (!ch.some((s) => ds.first[s] != null && ds.first[s] <= i)) throw new Error(`${ds.name}: ${k} has no source at ${st}`); }

  const runsCfg = [
    { key: "MAIN_long_2007", ds: dsY, start: START_LONG, opt: {}, note: "Yahoo dividend-adjusted closes 2007-05-31..2026-10-01; DBMF = RYMFX (to 2010-01-05) -> AQMIX (to 2019-05-08) -> DBMF; SGOV/JAAA = BIL before inception" },
    { key: "NO_MF_long_2007", ds: dsY, start: START_LONG, opt: { dropMF: true }, note: "same as MAIN but DBMF dropped and the remaining weights renormalised over 58/73 (QQQ 15/58, SPY 15/58, GLD 10/58, EFA 10/58, JAAA 8/58)" },
    { key: "ALPACA_2016", ds: dsA, start: START_ALP, opt: {}, note: "Alpaca SIP adjustment=all 2016-10-31..2026-10-01 (first month-end with 10 Alpaca month-ends for the trend rule); DBMF = Yahoo DBMF (Alpaca's adjustment=all misses the 2019-12-30 distribution) and AQMIX (Yahoo) before 2019-05-08; SGOV/JAAA = BIL (Alpaca) before inception" },
    { key: "REAL_ONLY_2020", ds: dsA, start: START_REAL, opt: {}, note: "Alpaca SIP adjustment=all 2020-10-30..2026-10-01: every sleeve is the actual instrument, no proxies (JAAA's first month-end); DBMF prices from Yahoo (see ALPACA_2016)" },
    { key: "MAIN_lag0", ds: dsY, start: START_LONG, opt: { lag: 0 }, note: "MAIN with fills at the decision close (no lag) — execution-timing sensitivity" },
  ];
  const results = {};
  for (const rc of runsCfg) {
    const i0 = idx(rc.ds, rc.start); const a = analyse(rc.ds, i0, rc.opt);
    const srcDays = Object.fromEntries(Object.entries(rc.ds.srcUse).map(([k, v]) => { const c = {}; for (let i = i0 + 1; i < rc.ds.N; i++) { const s = v.use[i]; c[s] = (c[s] || 0) + 1; } return [k, c]; }));
    results[rc.key] = { note: rc.note, start: rc.start, end: END, sessions: rc.ds.N - 1 - i0, sourceDaysBySleeve: srcDays, table: a.table, rolling3y: a.rolling, _runs: a.runs, _gross: a.gross, _ds: rc.ds, _i0: i0 };
    process.stdout.write(`  ran ${rc.key}: ${a.table.length} schedules, ${rc.ds.N - 1 - i0} sessions\n`);
  }
  // ---- cost sensitivity on MAIN (0/5/10/25 bps) and break-even costs for key pairs
  const costSens = {};
  for (const bps of [0, 5, 10, 25]) {
    const ds = dsY, i0 = idx(dsY, START_LONG);
    costSens[`${bps}bps`] = schedules().map((sc) => { const run = simulate(ds, sc, { i0, costBps: bps }); const m = metrics(ds, run.nav, i0, ds.N - 1); return { id: sc.id, cagrPct: pct(m.cagr, 3), sharpe: r2(m.sharpe, 3) }; });
  }
  const M = results.MAIN_long_2007.table, row = (id) => M.find((r) => r.id === id);
  const breakEven = (a, b) => { const A = row(a), B = row(b); const dT = (A.turnoverPctPerYr - B.turnoverPctPerYr) / 100; const dG = (A.grossCagrPct_zeroCostRun - B.grossCagrPct_zeroCostRun) / 100; return { a, b, grossCagrDiffPct: r2(100 * dG, 3), turnoverDiffPctPerYr: r2(100 * dT, 1), breakEvenCostBps: dT !== 0 ? r2((dG / dT) * 1e4, 1) : null, reading: dT !== 0 && dG / dT > 0 ? `${a} keeps its gross edge over ${b} up to ~${r2((dG / dT) * 1e4, 0)} bps per trade` : `${a} has no gross edge over ${b} that extra trading pays for (gross diff ${r2(100 * dG, 3)}%/yr on ${r2(100 * dT, 0)}% more turnover)` }; };
  const breakEvens = [
    breakEven("a-static-monthly", "a-static-annual"), breakEven("a-static-monthly", "a-static-quarterly"), breakEven("a-static-quarterly", "a-static-annual"),
    breakEven("b-band-rel10-daily-full", "a-static-annual"), breakEven("c-trend-weekly-literal-band10", "c-trend-monthly-literal-band10"), breakEven("c-trend-weekly-flip-band10", "c-trend-monthly-flip-band10"),
    breakEven("c-trend-monthly-literal-band10", "c-trend-quarterly-literal-band10"), breakEven("c-trend-monthly-literal-band10", "c-trend-monthly-flip-band10"), breakEven("c-trend-monthly-literal-band10", "c-trend-monthly-literal-noband"),
  ];
  // ---- key paired comparisons across datasets
  const keyPairs = [["c-trend-weekly-literal-band10", "c-trend-monthly-literal-band10"], ["c-trend-quarterly-literal-band10", "c-trend-monthly-literal-band10"], ["c-trend-monthly-flip-band10", "c-trend-monthly-literal-band10"], ["c-trend-monthly-literal-noband", "c-trend-monthly-literal-band10"], ["c-trend-monthly-literal-band10", "a-static-monthly"], ["a-static-annual", "a-static-monthly"], ["a-static-quarterly", "a-static-monthly"], ["a-static-never", "a-static-monthly"], ["b-band-rel20-daily-full", "a-static-monthly"], ["b-band-rel10-daily-full", "a-static-monthly"]];
  const pairs = {};
  for (const k of ["MAIN_long_2007", "NO_MF_long_2007", "ALPACA_2016", "REAL_ONLY_2020"]) { const R = results[k]; pairs[k] = keyPairs.map(([a, b]) => ({ a, b, ...paired(R._ds, R._runs[a].nav, R._runs[b].nav, R._i0, R._ds.N - 1) })); }
  // ---- calendar-year returns for the core candidates on MAIN
  const yearly = {}; { const R = results.MAIN_long_2007; for (const id of ["a-static-monthly", "a-static-quarterly", "a-static-annual", "b-band-rel20-daily-full", "c-trend-weekly-literal-band10", "c-trend-monthly-literal-band10", "c-trend-quarterly-literal-band10", "c-trend-monthly-flip-band10"]) { const nav = R._runs[id].nav, ds = R._ds; const o = {}; let prev = R._i0; for (let i = R._i0 + 1; i < ds.N; i++) if (ds.isME[i] && ds.dates[i].slice(5, 7) === "12" || i === ds.N - 1) { o[ds.dates[i].slice(0, 4)] = pct(nav[i] / nav[prev] - 1, 1); prev = i; } yearly[id] = o; } }
  // ---- sub-periods on MAIN (start-date sensitivity in plain blocks)
  const subPeriods = {}; { const R = results.MAIN_long_2007, ds = R._ds; const blocks = [["2007-05-31", "2012-12-31"], ["2012-12-31", "2019-12-31"], ["2019-12-31", END]];
    for (const [a, b] of blocks) { const s = ds.dates.findIndex((d) => d >= a), e = ds.dates.reduce((acc, d, i) => (d <= b ? i : acc), -1); const k = `${ds.dates[s]}..${ds.dates[e]}`; subPeriods[k] = {};
      for (const sc of schedules()) { const m = metrics(ds, R._runs[sc.id].nav, s, e); subPeriods[k][sc.id] = { cagrPct: pct(m.cagr), sharpe: r2(m.sharpe, 3), maxDDPct: pct(m.maxDD) }; } } }
  // ---- trend-signal whipsaw by evaluation cadence (MAIN)
  const sigStats = {}; { const R = results.MAIN_long_2007; for (const id of ["c-trend-weekly-literal-band10", "c-trend-monthly-literal-band10", "c-trend-quarterly-literal-band10"]) { const t = R.table.find((r) => r.id === id); sigStats[id] = { flipsPerYr: t.signalFlipsPerYr, inPct: t.trendInPct }; } }

  const assumptions = [
    "Book weights exactly as backend/book-etf-rebalancer.js: QQQ 15, SPY 15, GLD 10, EFA 10, DBMF 15, JAAA 8 (/73); OUT trend weight parks in SGOV.",
    "Trend rule exactly as the live code: adjusted close > mean of the last 10 month-end closes including the current one; weekly evaluation uses that week's last close as the 'current month' close, quarterly evaluation only at Mar/Jun/Sep/Dec month-ends; the weekly cadence also evaluates at every month-end.",
    "Static schedules (a)/(b) use the same 15/15/10/10/15/8 weights with no trend rule and no SGOV.",
    "Decision at the close of day t, fill at the close of day t+1 (one-session lag). The live book fills at the next open; a lag-0 run (fill at the decision close) is reported as MAIN_lag0.",
    "Cost 5 bps of traded notional per trade on every ETF trade (commission-free broker; 5 bps covers half-spread + slippage on these liquid ETFs). 0/10/25 bps sensitivity in costSensitivityMAIN. Initial funding is free for every schedule.",
    "Fractional shares; full rebalances skip trades under $100 (one-share-ish); the live $500 floor applies only where stated (Plan E band and the two 'partial' static variants).",
    "Relative band definition copied from the live code: |target$ - held$| > x * max(target$, held$). Absolute band: |held weight - target weight| > 5 percentage points.",
    "Band 'full' mode: any breach sends the whole book back to target. 'partial' mode (the live code's daily behaviour): only breached sleeves trade; the residual sits in cash at 0% until the next full rebalance or a buy-side breach.",
    "Total-return prices: Yahoo adjClose (dividend-adjusted, verified per bar via adjSource) for the long run; Alpaca SIP adjustment=all for the 2016 and 2020 runs. Yahoo vs Alpaca agreement on 2016-2026 is reported in dataValidation.yahooVsAlpaca.",
    "Managed-futures proxy before DBMF (2019-05-08): AQMIX (AQR Managed Futures Strategy I, from 2010-01-05) and before that RYMFX (Rydex/Guggenheim Managed Futures Strategy H, from 2007-02-22). Both are real mutual funds net of their (higher) fees; they are proxies for the sleeve's behaviour, not for DBMF's exact return. NO_MF_long_2007 drops the sleeve entirely.",
    "SGOV and JAAA before their inceptions (2020-05/06 and 2020-10-19): BIL. BIL understates JAAA's yield (JAAA carries a AAA-CLO spread); that is a level effect on an always-held sleeve and barely touches cadence comparisons.",
    "Sharpe = mean daily excess return over FRED DTB3/252 (forward-filled) x sqrt(252) / stdev. Vol = daily stdev x sqrt(252). Worst 12 months = worst rolling 252-session return. CAGR on calendar time.",
    "Turnover = sum of |traded $| / NAV at the time, both sides, per year. Trades/yr counts one per sleeve per fill day. Cost drag = sum of (cost / NAV) per year on the net path (= turnover x 5 bps); grossCagrPct_zeroCostRun is a separate zero-cost simulation (its path can differ slightly because band triggers are path-dependent).",
    "Data quirk: Alpaca SIP daily closes differ from the official close on a handful of volatile days (9 SPY days, mostly March 2020: 2020-03-12 Alpaca -6.93% vs Yahoo -9.57%, official close 248.11 vs 274.23 = -9.5%); Yahoo matches the official close there. Effects on the 2016+ runs are small and symmetric across schedules.",
    "Win rates: monthlyWinRatePct = share of months with a positive return; vsBaseline.winRateOfDecidedMonths = share of months (|diff| > 0.1 bp) the schedule beat its family baseline (static monthly for a/b, live Plan E monthly for c); rolling3y = share of 36-month windows (monthly starts, overlapping) won.",
    "Rolling 3-year windows slice one continuous path per schedule (state is not reset at the window start); windows overlap, so their counts are not independent observations.",
  ];
  const strip = (r) => { const { _runs, _gross, _ds, _i0, ...rest } = r; return rest; };
  const out = {
    part: "B", title: "Rebalancing cadence for the core (Plan E) book", ranAt: new Date().toISOString(), lastSession: END, script: path.relative(ROOT, __filename),
    designAnalysisNotATest: "Known allocation rule (operator 09-25): nothing registered, no orders, no live runner edited.",
    assumptions, dataValidation: validation,
    results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, strip(v)])),
    pairedVsBaseline: pairs, costSensitivityMAIN: costSens, breakEvenCostsMAIN: breakEvens, calendarYearReturnsMAIN: yearly, subPeriodsMAIN: subPeriods, trendSignalWhipsawMAIN: sigStats,
  };
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(out, null, 1));
  // console digest
  for (const k of Object.keys(results)) {
    console.log(`\n== ${k} (${results[k].start}..${END}, ${results[k].sessions} sessions)`);
    console.log("id".padEnd(36) + "CAGR   vol    Shrp   maxDD  (trough)    w12m   turn%  trd/yr drag   mWin%");
    for (const r of results[k].table) console.log(`${r.id.padEnd(36)}${String(r.cagrPct).padEnd(7)}${String(r.volPct).padEnd(7)}${String(r.sharpe).padEnd(7)}${String(r.maxDDPct).padEnd(7)}${String(r.maxDDTrough).padEnd(12)}${String(r.worst12mPct).padEnd(7)}${String(r.turnoverPctPerYr).padEnd(7)}${String(r.tradesPerYr).padEnd(7)}${String(r.costDragPctPerYr).padEnd(7)}${r.monthlyWinRatePct}`);
  }
  console.log("\nwrote", path.join(OUT, "results.json"));
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
