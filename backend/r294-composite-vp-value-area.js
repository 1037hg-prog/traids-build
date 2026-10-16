#!/usr/bin/env node
/**
 * R294 — Composite volume profile: today's open vs the prior-N-session value area (Dalton, Mind Over Markets).
 * Registered 2026-09-29 (SCOUT-0929, operator card 11). The registry wins: rule, statistic, unit, bar, window are frozen.
 *
 *   Composite = RTH volume of the prior N sessions, each 1m bar's volume spread uniformly over its [low, high] range in $0.05 bins.
 *   POC = max-volume bin; value area (VA) = contiguous bins around the POC holding 70% of volume (CME two-bin extension, ties go up).
 *   Everything is known at the prior close.  Today: read ONLY the first 30-minute RTH bar (09:30-09:59) to classify.
 *   (A) "80% rule": open outside the VA, first 30-min bar CLOSE back inside -> trade toward the far edge; target = far edge;
 *       stop = open-side edge pushed one $0.05 bin further out.
 *   (B) acceptance break: open outside AND first 30-min close further outside (beyond the edge and beyond the open) -> trade with the break;
 *       stop = the edge itself; target = 1R (B1) / 2R (B2), R = entry - edge.
 *   Flat at the 15:54 bar close (15:55).  At most one trade per session; unit = SESSION (0 when no setup).
 *
 *   node backend/r294-composite-vp-value-area.js --selftest   known answers (synthetic profile + constant-signal + never-trade)
 *   node backend/r294-composite-vp-value-area.js --read       the one registered read (refuses if sealed / output exists)
 *
 * FIXED BEFORE ANY OUTCOME (builder notes):
 *  N1 Primary cell = SPY, N=20, setup A.  Statistic = one-sample t over HOLDOUT sessions 2022-01-01..2026-09 of net session return
 *     (return on entry notional; 0 on no-trade sessions).  Bar = registry bar.tRequired (2.244 after the 09-29 pre-evidence amendment; best-of-4, n=1180).  Discovery 2016-2021 is reported, not tested.
 *  N2 ENTRY = OPEN OF THE 10:00 1-MINUTE BAR (next open after the 09:30-09:59 bar closes) — a look-ahead-clean reading of the registry's
 *     "enter at that close" (they differ by < 1 tick in practice).  Sensitivity (entry at the 09:59 close) is reported.
 *  N3 Fills on 1m bars: stop checked before target inside a bar (conservative); stop fills at the stop price (or the bar open if it gaps past);
 *     target fills at the target price.  Trade skipped when the 10:00 open is already at/through stop or target.
 *  N4 Cost = $0.01/share + half of a 1-cent quoted spread ($0.005) per side = $0.015/share/side (no historical quotes held).  Sensitivity: 2 bps/side.
 *  N5 Raw (unadjusted) SIP prices via lib/equity-bars-1m (cache data/equity-1m, shared house cache); no split in SPY/QQQ; dividend gaps
 *     (~0.3-0.4% four times a year) are inside a 20-session composite untouched — disclosed.
 *  N6 Sessions with no bar at 09:30 / 09:59 / 10:00, or that end before 15:50 (half days), are not traded; they still feed the composite.
 *  N7 Placebo 1 (registered): per session, VA shifted by a random sign x U(0.5,1.5) VA widths, 500 draws, same rule; observed must beat the
 *     draws' p95 of mean net.  Falsifier (registered): the same rule with prior-day RTH high/low as the "value area".
 *  N8 Other cells (QQQ, N=5, B1, B2) are descriptive; only the primary cell carries the registered verdict.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { loadBars } = require("./lib/equity-bars-1m.js");
const D = (f) => path.join(__dirname, "data", f), OUT = D("r294-composite-vp-value-area.json");
const BAR = require("./data/test-registry.json").preregistered.find((x) => x.id === "R294").bar.tRequired;   // read from the registry (amended 2026-09-29 pre-evidence), never hard-coded
const HOLDOUT_FROM = "2022-01-01", DATA_FROM = "2016-01-01", DATA_TO = "2026-09-28";
const BIN = 0.05, VA_FRAC = 0.70, STOP_BUF = BIN, SIDE_COST = 0.015, SIDE_BPS = 0.0002, DRAWS = 500;
const mode = ["--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : 0; };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---------- data: sessions of RTH 1m bars, minute index 0 = 09:30 .. 389 = 15:59 ----------
async function loadSessions(sym) {
  const bars = await loadBars({ symbol: sym, from: DATA_FROM, to: DATA_TO, quiet: true });
  const by = new Map();
  for (const b of bars) {
    if (b.time < "09:30" || b.time >= "16:00") continue;
    const idx = (+b.time.slice(0, 2)) * 60 + (+b.time.slice(3, 5)) - 570;
    let s = by.get(b.date); if (!s) { s = { date: b.date, o: new Float64Array(390).fill(NaN), h: new Float64Array(390).fill(NaN), l: new Float64Array(390).fill(NaN), c: new Float64Array(390).fill(NaN), v: new Float64Array(390), last: -1 }; by.set(b.date, s); }
    s.o[idx] = b.o; s.h[idx] = b.h; s.l[idx] = b.l; s.c[idx] = b.c; s.v[idx] = b.v; if (idx > s.last) s.last = idx;
  }
  const sess = [...by.values()].filter((s) => Number.isFinite(s.o[0])).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const s of sess) {
    s.bins = binVolume(s);
    let hi = -Infinity, lo = Infinity; for (let i = 0; i < 390; i++) if (Number.isFinite(s.h[i])) { if (s.h[i] > hi) hi = s.h[i]; if (s.l[i] < lo) lo = s.l[i]; }
    s.rthHigh = hi; s.rthLow = lo;
    let h30 = -Infinity, l30 = Infinity; for (let i = 0; i < 30; i++) if (Number.isFinite(s.h[i])) { if (s.h[i] > h30) h30 = s.h[i]; if (s.l[i] < l30) l30 = s.l[i]; }
    s.hi30 = h30; s.lo30 = l30;
    let ex = -1; for (let i = 384; i >= 0; i--) if (Number.isFinite(s.c[i])) { ex = i; break; } s.exitIdx = ex;
    s.tradable = Number.isFinite(s.o[0]) && Number.isFinite(s.c[29]) && Number.isFinite(s.o[30]) && ex >= 379;   // exit bar 15:49+ (i.e. not a half day)
  }
  return sess;
}

// ---------- composite profile ----------
const binOf = (p) => Math.floor(p / BIN + 1e-9);
function addBar(map, l, h, v) {
  if (!(v > 0)) return;
  const kl = binOf(l), kh = binOf(h);
  if (kl === kh || h - l < 1e-9) { map.set(kl, (map.get(kl) || 0) + v); return; }
  for (let k = kl; k <= kh; k++) { const ov = Math.min(h, (k + 1) * BIN) - Math.max(l, k * BIN); if (ov > 0) map.set(k, (map.get(k) || 0) + (v * ov) / (h - l)); }
}
function binVolume(s) { const m = new Map(); for (let i = 0; i < 390; i++) if (Number.isFinite(s.h[i])) addBar(m, s.l[i], s.h[i], s.v[i]); return m; }
/** value area from a Map(bin -> volume): { val, vah, poc } as PRICES (bin edges).  CME two-bin extension, ties go up. */
function valueArea(map) {
  let kmin = Infinity, kmax = -Infinity, tot = 0, pocK = null, pocV = -1;
  for (const [k, v] of map) { if (k < kmin) kmin = k; if (k > kmax) kmax = k; tot += v; if (v > pocV || (v === pocV && k < pocK)) { pocV = v; pocK = k; } }
  if (!(tot > 0)) return null;
  const vol = (k) => (k < kmin || k > kmax ? 0 : map.get(k) || 0);
  let lo = pocK, hi = pocK, cum = pocV;
  while (cum < VA_FRAC * tot && (lo > kmin || hi < kmax)) {
    const up = vol(hi + 1) + vol(hi + 2), dn = vol(lo - 1) + vol(lo - 2);
    if (hi < kmax && (up >= dn || lo <= kmin)) { const n = Math.min(2, kmax - hi); hi += n; cum += up; }
    else { const n = Math.min(2, lo - kmin); lo -= n; cum += dn; }
  }
  return { val: lo * BIN, vah: (hi + 1) * BIN, poc: (pocK + 0.5) * BIN };
}
function compositeVA(sess, i, N) {
  if (i < N) return null; const m = new Map();
  for (let j = i - N; j < i; j++) for (const [k, v] of sess[j].bins) m.set(k, (m.get(k) || 0) + v);
  return valueArea(m);
}

// ---------- trade simulation on 1m bars (entry bar idx 30, exit = close of last bar <= idx 384) ----------
function sim(s, dir, entry, stop, target, entryIdx = 30) {
  for (let i = entryIdx; i <= 384; i++) {
    if (!Number.isFinite(s.h[i])) continue;
    const h = s.h[i], l = s.l[i], o = s.o[i];
    if (dir > 0) {
      if (l <= stop) return { exit: Math.min(stop, o), why: "stop" };
      if (h >= target) return { exit: target, why: "target" };
    } else {
      if (h >= stop) return { exit: Math.max(stop, o), why: "stop" };
      if (l <= target) return { exit: target, why: "target" };
    }
  }
  return { exit: s.c[s.exitIdx], why: "time" };
}
/** setup detection for one session against a (val, vah) window.  Returns a trade spec or null. */
function setupTrade(s, va, kind, entryMode = "next") {
  const open = s.o[0], c30 = s.c[29], entry = entryMode === "close" ? c30 : s.o[30], eIdx = entryMode === "close" ? 30 : 30;
  if (kind === "A" || kind === "Awide") {
    if (open > va.vah && c30 <= va.vah && c30 >= va.val) { const stop = kind === "Awide" ? s.hi30 + BIN : va.vah + STOP_BUF; return entry < stop && entry > va.val ? { dir: -1, entry, stop, target: va.val, eIdx } : null; }
    if (open < va.val && c30 >= va.val && c30 <= va.vah) { const stop = kind === "Awide" ? s.lo30 - BIN : va.val - STOP_BUF; return entry > stop && entry < va.vah ? { dir: 1, entry, stop, target: va.vah, eIdx } : null; }
    return null;
  }
  const mult = kind === "B1" ? 1 : 2;
  if (open > va.vah && c30 > va.vah && c30 > open) { const R = entry - va.vah; return R > 0 ? { dir: 1, entry, stop: va.vah, target: entry + mult * R, eIdx } : null; }
  if (open < va.val && c30 < va.val && c30 < open) { const R = va.val - entry; return R > 0 ? { dir: -1, entry, stop: va.val, target: entry - mult * R, eIdx } : null; }
  return null;
}
/** net & gross session return (fraction of entry notional) for one session/window/kind, or null. */
function session(s, va, kind, opt = {}) {
  const t = setupTrade(s, va, kind, opt.entryMode);
  if (!t) return null;
  const r = sim(s, t.dir, t.entry, t.stop, t.target, t.eIdx), pnl = t.dir * (r.exit - t.entry);
  const cost = opt.bps ? 2 * SIDE_BPS * t.entry : 2 * SIDE_COST;
  return { gross: pnl / t.entry, net: (pnl - cost) / t.entry, why: r.why, dir: t.dir };
}

// ---------- grading ----------
function runCell(sess, N, kind, opt = {}) {
  const rows = [];
  for (let i = 0; i < sess.length; i++) {
    const s = sess[i]; if (s.date < DATA_FROM) continue;
    let va = null;
    if (opt.window === "range") { if (i > 0) va = { val: sess[i - 1].rthLow, vah: sess[i - 1].rthHigh }; } else va = compositeVA(sess, i, N);
    let r = null;
    if (va && s.tradable) { if (opt.shift) { const w = va.vah - va.val, off = opt.shift() * w; va = { val: va.val + off, vah: va.vah + off }; } r = session(s, va, kind, opt); }
    rows.push({ date: s.date, gross: r ? r.gross : 0, net: r ? r.net : 0, trade: !!r, why: r && r.why });
  }
  return rows;
}
const summ = (rows) => { const n = rows.map((r) => r.net), g = rows.map((r) => r.gross), tr = rows.filter((r) => r.trade); return { sessions: rows.length, trades: tr.length, meanNet: mean(n), meanGross: mean(g), tNet: tOf(n), tGross: tOf(g), winRate: tr.length ? tr.filter((r) => r.net > 0).length / tr.length : null }; };
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(5) : v]));
function maxDD(rows) { let cum = 0, pk = 0, dd = 0; for (const r of rows) { cum += r.net; pk = Math.max(pk, cum); dd = Math.min(dd, cum - pk); } return dd; }

// ---------- selftest ----------
function selftest(sess) {
  const fails = [];
  // 1 synthetic profile: one bar l=100.00 h=100.20 v=1000 -> 4 bins of 250
  const m1 = new Map(); addBar(m1, 100.0, 100.2, 1000);
  const tot = [...m1.values()].reduce((a, b) => a + b, 0);
  if (Math.abs(tot - 1000) > 1e-6 || m1.size !== 4) fails.push(`bar spread total ${tot} bins ${m1.size}`);
  // 2 value area on [5,30,40,15,10]: POC bin 2, up pair=25 < down pair=35 -> add below -> 75 >= 70 -> bins 0..2
  const k0 = 2000, m2 = new Map([5, 30, 40, 15, 10].map((v, j) => [k0 + j, v]));
  const va = valueArea(m2);
  if (!va || Math.abs(va.val - k0 * BIN) > 1e-9 || Math.abs(va.vah - (k0 + 3) * BIN) > 1e-9) fails.push(`VA ${JSON.stringify(va)}`);
  // 3 constant signal: long every tradable session at the 10:00 open, no stop/target reachable -> instrument's own return less cost
  let maxErr = 0, nT = 0;
  for (const s of sess) {
    if (!s.tradable) continue;
    const t = { dir: 1, entry: s.o[30] }, r = sim(s, 1, t.entry, -1e9, 1e9);
    const expNet = ((s.c[s.exitIdx] - s.o[30]) - 2 * SIDE_COST) / s.o[30];
    const pnl = t.dir * (r.exit - t.entry), net = (pnl - 2 * SIDE_COST) / t.entry;
    maxErr = Math.max(maxErr, Math.abs(net - expNet)); nT++;
  }
  if (!(maxErr < 1e-12) || nT < 500) fails.push(`constant-signal err ${maxErr} over ${nT}`);
  // 4 never-trade rule (VA of zero width far away) -> every session exactly 0
  let nz = 0;
  for (const s of sess.slice(30)) if (s.tradable) { const r = session(s, { val: 1e6, vah: 1e6 + 1 }, "A"); if (r) nz++; }
  // open<val requires c30 back inside [val,vah]: impossible here -> 0 trades
  if (nz) fails.push(`never-trade produced ${nz} trades`);
  // 5 a stop hit in a synthetic session loses exactly the stop distance
  const fake = { o: new Float64Array(390).fill(100), h: new Float64Array(390).fill(100.01), l: new Float64Array(390).fill(99.99), c: new Float64Array(390).fill(100), exitIdx: 384 };
  fake.l[40] = 99.5; const rs = sim(fake, 1, 100, 99.8, 101);
  if (rs.why !== "stop" || Math.abs(rs.exit - 99.8) > 1e-12) fails.push("stop fill");
  fake.h[41] = 101.5; const rt = sim({ ...fake, l: new Float64Array(390).fill(99.99) }, 1, 100, 99.8, 101);
  if (rt.why !== "target" || Math.abs(rt.exit - 101) > 1e-12) fails.push("target fill");
  // 6 look-ahead guard: composite for session i uses only sessions < i (changing session i must not change its VA)
  const i = 300, a = compositeVA(sess, i, 20), keep = sess[i].bins; sess[i].bins = new Map([[1, 1e9]]); const b = compositeVA(sess, i, 20); sess[i].bins = keep;
  if (JSON.stringify(a) !== JSON.stringify(b)) fails.push("composite leaks today's session");
  console.log(`selftest: ${sess.length} SPY sessions ${sess[0].date}..${sess.at(-1).date}; tradable ${nT}; constant-signal maxErr ${maxErr}; ${fails.length ? "FAIL " + fails.join("; ") : "OK"}`);
  return fails.length === 0;
}

(async () => {
  const spy = await loadSessions("SPY");
  if (mode === "--selftest") process.exit(selftest(spy) ? 0 : 1);
  if (!selftest(spy)) throw new Error("selftest failed — no read");
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if ((seals.tests && seals.tests.R294) || fs.existsSync(OUT)) throw new Error("R294 already read/sealed — read-once");
  const qqq = await loadSessions("QQQ"), SY = { SPY: spy, QQQ: qqq };
  const hold = (rows) => rows.filter((r) => r.date >= HOLDOUT_FROM), disc = (rows) => rows.filter((r) => r.date < HOLDOUT_FROM);
  const cells = {};
  for (const sym of ["SPY", "QQQ"]) for (const N of [20, 5]) for (const kind of ["A", "B1", "B2"]) {
    const rows = runCell(SY[sym], N, kind); cells[`${sym}|N${N}|${kind}`] = { discovery: round(summ(disc(rows))), holdout: round(summ(hold(rows))) };
  }
  // ----- primary: SPY, N=20, A -----
  const rows = runCell(spy, 20, "A"), H = hold(rows), Hs = summ(H);
  const half = Math.floor(H.length / 2), h1 = H.slice(0, half), h2 = H.slice(half);
  const sens = { entryAtSignalClose: round(summ(hold(runCell(spy, 20, "A", { entryMode: "close" })))), cost2bpsPerSide: round(summ(hold(runCell(spy, 20, "A", { bps: true })))), wideStop_30minExtreme: round(summ(hold(runCell(spy, 20, "Awide")))) };
  // ----- placebo 1: random-level null -----
  const rand = rng(294294), draws = [];
  for (let d = 0; d < DRAWS; d++) draws.push(mean(hold(runCell(spy, 20, "A", { shift: () => (rand() < 0.5 ? -1 : 1) * (0.5 + rand()) })).map((r) => r.net)));
  draws.sort((a, b) => a - b); const p95 = draws[Math.floor(0.95 * DRAWS)];
  // ----- falsifier: prior-day high/low -----
  const rangeRows = hold(runCell(spy, 20, "A", { window: "range" })), Rs = summ(rangeRows);
  const yrs = H.length / 252, sumNet = H.reduce((s, r) => s + r.net, 0);
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0), m1 = mean(h1.map((r) => r.net)), m2 = mean(h2.map((r) => r.net));
  const beats = Hs.meanNet > p95, sameSign = sign(m1) === sign(m2) && sign(m1) !== 0;
  const verdict = Hs.tNet >= BAR && beats && sameSign ? "PASS" : "DID NOT PASS";
  const out = {
    id: "R294", key: "COMPOSITE_VP_VALUE_AREA", name: "Composite volume profile — open vs prior-N-session value area (80% rule), SPY N=20", readAt: new Date().toISOString(),
    rule: "SPY; composite of prior 20 RTH sessions ($0.05 bins, 1m bar volume spread over its range); VA=70% around POC; open outside VA and first 30-min close back inside -> trade toward far edge, target far edge, stop one bin beyond open-side edge; enter at the 10:00 bar open; flat 15:54 close; one trade/session max.",
    window: `holdout ${H[0].date}..${H.at(-1).date} (discovery 2016-01..2021-12 reported only)`, unit: "sessions", n: H.length, trades: Hs.trades,
    statistic: "one-sample t over holdout sessions of net session return (return on entry notional, 0 when no setup)",
    tNet: +Hs.tNet.toFixed(3), tGross: +Hs.tGross.toFixed(3), bar: BAR, meanNet: +Hs.meanNet.toFixed(6), meanGross: +Hs.meanGross.toFixed(6), winRate: Hs.winRate == null ? null : +Hs.winRate.toFixed(3),
    placebo: { kind: "random-level null (VA shifted by +/-0.5-1.5 widths per session), 500 draws, holdout mean net", p95: +p95.toFixed(6), median: +draws[Math.floor(DRAWS / 2)].toFixed(6), observed: +Hs.meanNet.toFixed(6), beats },
    falsifierPriorDayRange: { note: "same rule with prior-day RTH high/low as the window", holdout: round(Rs), volumeAddsOverRange: Hs.tNet > Rs.tNet },
    halves: { first: { from: h1[0].date, to: h1.at(-1).date, meanNet: +m1.toFixed(6), tNet: +tOf(h1.map((r) => r.net)).toFixed(3), trades: h1.filter((r) => r.trade).length }, second: { from: h2[0].date, to: h2.at(-1).date, meanNet: +m2.toFixed(6), tNet: +tOf(h2.map((r) => r.net)).toFixed(3), trades: h2.filter((r) => r.trade).length } },
    discovery: round(summ(disc(rows))), dollarsAt10k: +((sumNet / yrs) * 1e4).toFixed(0), maxDD: +maxDD(H).toFixed(4),
    exitMix: H.filter((r) => r.trade).reduce((o, r) => ((o[r.why] = (o[r.why] || 0) + 1), o), {}),
    sensitivity: sens, cells,
    costModel: "$0.01/share + $0.005 half-spread per side ($0.03 round trip/share) = registered equity model with an assumed 1-cent quoted spread; sensitivity 2 bps/side shown",
    dataSources: ["Alpaca SIP 1Min raw via lib/equity-bars-1m.js (SPY, QQQ, 2016-01..2026-09-28; cache data/equity-1m)"],
    knownWeaknesses: [
      "Stop 'beyond the open-side edge' is ambiguous; implemented as edge + one $0.05 bin (very tight) — wide-stop variant reported as sensitivity only.",
      "Entry at the 10:00 bar open (next open) rather than the 09:59 close: conservative reading; sensitivity reported.",
      "No historical quotes: half-spread assumed 0.5 cent; market-order stop slippage not modelled beyond the 2 bps sensitivity.",
      "Raw prices: dividend ex-date gaps sit inside composites (minor).",
      "Discovery/holdout are one continuous rule with no tuned parameter; primary N=20 chosen by the scout, other cells descriptive; bar is registry bar.tRequired (best-of-4 after the pre-evidence amendment).",
      "Futures twin (NQ/ES) not built: only ~14 months of futures 1m; descriptive per registry, weightless.",
    ],
    verdictScript: verdict,
  };
  writeJsonAtomic(OUT, out);
  console.log(`R294 ${verdict}: holdout ${out.n} sessions, ${out.trades} trades, tNet ${out.tNet} (gross ${out.tGross}) vs bar ${BAR}; meanNet ${(100 * out.meanNet).toFixed(4)}%/session, win ${out.winRate}`);
  console.log(`placebo p95 ${(100 * p95).toFixed(4)}% vs observed ${(100 * Hs.meanNet).toFixed(4)}% beats=${beats}; range falsifier t ${Rs.tNet.toFixed(2)} (mean ${(100 * Rs.meanNet).toFixed(4)}%)`);
  console.log(`halves ${(100 * m1).toFixed(4)}% / ${(100 * m2).toFixed(4)}%; $/yr on $10k ${out.dollarsAt10k}; maxDD ${(100 * out.maxDD).toFixed(2)}% ; discovery t ${out.discovery.tNet}`);
  console.log("sens", JSON.stringify(Object.fromEntries(Object.entries(sens).map(([k, v]) => [k, { t: v.tNet, m: v.meanNet, n: v.trades }]))));
  for (const [k, v] of Object.entries(cells)) console.log(`  ${k}: hold n=${v.holdout.trades} t=${v.holdout.tNet} mean=${v.holdout.meanNet} | disc t=${v.discovery.tNet}`);
})().catch((e) => { console.error("R294 FAILED:", e.message); process.exit(1); });
