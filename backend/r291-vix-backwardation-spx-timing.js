#!/usr/bin/env node
/**
 * R291 — VIX term-structure inversion as a lead for SPX (Johnson 2017). Registered 2026-09-29 (SCOUT-0929, registry wins).
 *
 * RULE (frozen): at the close of day t, ratio_t = VIX_t / VIX3M_t. State ON = ratio_t > 1.00. Buy SPY at the close of the first
 * day the state turns on; sell at the close of the first day it is off again (so SPY is held for every day whose PRIOR close was
 * in backwardation). T-bill (FRED DTB3) otherwise. One EPISODE = one maximal run of consecutive ON days: entry close t0, exit
 * close t1+1. Episode net excess = compounded SPY return over (t0, t1+1] minus compounded T-bill over the same days minus the
 * round-trip cost. STATISTIC: one-sample t over episodes of net excess; unit = episodes; bar read at run time from the registry entry bar.tRequired (2.574 = best-of-4 at n=15 after the 09-29 pre-evidence amendment).
 * Window: sealed holdout = episodes with entry 2016-01-01..2026-08-31 and exit <= 2026-08-31 (Alpaca SIP, adjustment all).
 * Discovery 2008-01..2015-12 (Yahoo adj close) is reported DESCRIPTIVELY only; it is a motivating sample, never the bar.
 *
 * CONTROLS: (a) falsifier - same rule keyed on VIX above its trailing-252d 80th percentile (known at the close);
 * (b) random-day placebo matched on the VIX level of the entry day, 200 draws, same holding length, contango days only;
 * (c) persistence at 1/5/21 sessions from the entry close; (d) R182 correlation: NOT computed (no per-day R182 series is exposed).
 *
 *   node backend/r291-vix-backwardation-spx-timing.js --selftest   known answers (synthetic; never-in; always-in)
 *   node backend/r291-vix-backwardation-spx-timing.js --data       data coverage only (no outcome statistics)
 *   node backend/r291-vix-backwardation-spx-timing.js --read       the one registered read (refuses if sealed / output exists)
 *
 * NOTES (fixed before any outcome): N1 VIX/VIX3M closes: Yahoo via :3002 (both are CBOE closes published at 16:00 ET); a signal
 * day with either missing is treated as OFF and counted. N2 cost per side = $0.01/share + 2 bps (2 bps = the house no-spread proxy
 * for half the spread), i.e. 0.01/close + 0.0002; sensitivity at 0x / 2x / 5x reported. N3 rf per trading day = DTB3/100 x
 * calendar-days-since-previous-trading-day / 360, last valid DTB3 carried over holidays. N4 this script never writes the seal file
 * or the registry; it refuses to run if R291 is in read-seals.json or its own output exists.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = D("training/r291"), FRED = D("training/fred"), OUT = D("r291-vix-backwardation-spx-timing.json");
const REG = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((x) => x.id === "R291");
if (!REG || !(REG.bar && REG.bar.tRequired > 0)) throw new Error("R291 registry bar missing");
const BAR = REG.bar.tRequired, BAR_VARIANTS = REG.bar.variants, HOLD_FROM = "2016-01-01", HOLD_TO = "2026-08-31", DISC_FROM = "2008-01-01", DISC_TO = "2015-12-31";
const THRESH = 1.0, THRESH2 = 1.05, COST_BPS = 2, COST_SH = 0.01, DRAWS = 200, MATCH_K = 20, PCT_WIN = 252, PCT_Q = 0.8;
const mode = ["--selftest", "--read", "--data"].find((m) => process.argv.includes(m)) || "--selftest";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// ---------- data ----------
async function cached(name, fn) {
  fs.mkdirSync(CACHE, { recursive: true }); const f = path.join(CACHE, name + ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const v = await fn(); fs.writeFileSync(f, JSON.stringify(v)); return v;
}
async function yahoo(sym) {
  return cached("yahoo-" + sym.replace("^", ""), async () => {
    const r = await fetch(`http://localhost:3002/api/yahoo/${encodeURIComponent(sym)}/history?days=9500&interval=1d`, { signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error(`yahoo ${sym} HTTP ${r.status}`); const j = await r.json();
    return (j.bars || []).filter((b) => b.date < "2026-09-29").map((b) => ({ d: b.date, c: b.close, a: b.adjClose }));
  });
}
async function alpaca(sym) {
  return cached("alpaca-" + sym, async () => {
    const { fetchBars } = require("./lib/alpaca-bars.js");
    const r = await fetchBars([sym], { start: "2015-12-01", end: "2026-09-28", timeframe: "1Day", feed: "sip", adjustment: "all" });
    const b = (r.bars || {})[sym]; if (!b || b.length < 2000) throw new Error(`alpaca ${sym} short: ${b && b.length}`);
    return b.map((x) => ({ d: String(x.t).slice(0, 10), c: x.c }));
  });
}
async function fredRf() {
  fs.mkdirSync(FRED, { recursive: true }); const f = path.join(FRED, "DTB3.csv");
  if (!fs.existsSync(f)) { const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3", { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error("DTB3 HTTP " + r.status); fs.writeFileSync(f, await r.text()); }
  const m = new Map(); for (const l of fs.readFileSync(f, "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") m.set(d, +v); }
  return m;
}
/** Trailing-252 VIX 80th-percentile flag per date from a full VIX history [{d,c}]. */
function lvlMapOf(vix) {
  const m = new Map();
  for (let i = PCT_WIN - 1; i < vix.length; i++) { const w = vix.slice(i - PCT_WIN + 1, i + 1).map((b) => b.c).sort((x, y) => x - y); m.set(vix[i].d, vix[i].c > w[Math.floor(PCT_Q * (w.length - 1))]); }
  return m;
}
/** Build aligned series for one price source. px = [{d,p}] ascending. Adds vix, v3 (may be null), rf per day, VIX percentile flag. */
function align(px, vixM, v3M, dtb, lvlMap) {
  const rows = []; let last = null, prevD = null;
  const dates = [...dtb.keys()].sort(); let di = 0, cur = 3;
  for (const b of px) {
    while (di < dates.length && dates[di] <= b.d) { cur = dtb.get(dates[di]); di++; }
    const cal = prevD ? dayDiff(prevD, b.d) : 1; prevD = b.d;
    rows.push({ d: b.d, p: b.p, rf: (cur / 100) * cal / 360, vix: vixM.get(b.d) ?? null, v3: v3M.get(b.d) ?? null });
  }
  // trailing-252 80th percentile of VIX from the FULL VIX history (known at the same close), keyed by date
  for (const r of rows) r.lvl = lvlMap.get(r.d) ?? null;
  return rows;
}
const costSide = (p, mult = 1) => mult * (COST_SH / p + COST_BPS / 1e4);

// ---------- rule engine (pure; used by selftest and read) ----------
/** on[i] booleans -> episodes [{i0, i1, exit}] where entry close = i0, exit close = exit = (last ON index)+1. Open episodes (no exit row) dropped. */
function episodesOf(on) {
  const eps = []; let i = 0;
  while (i < on.length) {
    if (!on[i]) { i++; continue; }
    let j = i; while (j + 1 < on.length && on[j + 1]) j++;
    if (j + 1 < on.length) eps.push({ i0: i, i1: j, exit: j + 1 });
    i = j + 1;
  }
  return eps;
}
/** Grade one episode from rows (rf and price). fixedExit overrides the exit index. */
function gradeEp(rows, i0, exit, cm = 1) {
  let s = 1, r = 1; for (let k = i0 + 1; k <= exit; k++) { s *= rows[k].p / rows[k - 1].p; r *= 1 + rows[k].rf; }
  const gross = s - r, cost = costSide(rows[i0].p, cm) + costSide(rows[exit].p, cm);
  return { entry: rows[i0].d, exit: rows[exit].d, days: exit - i0, spy: s - 1, rf: r - 1, gross, net: gross - cost, cost, entryVix: rows[i0].vix };
}
const summarize = (eps) => {
  const n = eps.map((e) => e.net), g = eps.map((e) => e.gross);
  return { n: eps.length, meanNet: n.length ? mean(n) : null, meanGross: g.length ? mean(g) : null, tNet: tOf(n), tGross: tOf(g), winRate: n.length ? n.filter((x) => x > 0).length / n.length : null };
};
/** daily timing-portfolio returns over a window [a,b] of row indices: SPY on held days, rf otherwise, cost at each switch. */
function dailyPortfolio(rows, eps, lo, hi, cm = 1) {
  const held = new Set(), swCost = new Map();
  for (const e of eps) { for (let k = e.i0 + 1; k <= e.exit; k++) held.add(k); swCost.set(e.i0, costSide(rows[e.i0].p, cm)); swCost.set(e.exit, (swCost.get(e.exit) || 0) + costSide(rows[e.exit].p, cm)); }
  const strat = [], bh = [], rfs = [];
  for (let k = lo + 1; k <= hi; k++) { const spy = rows[k].p / rows[k - 1].p - 1; strat.push((held.has(k) ? spy : rows[k].rf) - (swCost.get(k) || 0)); bh.push(spy); rfs.push(rows[k].rf); }
  return { strat, bh, rfs };
}
const sharpe = (r, rf) => { const x = r.map((v, i) => v - rf[i]); return sd(x) > 0 ? (mean(x) / sd(x)) * Math.sqrt(252) : 0; };
const maxDD = (r) => { let v = 1, pk = 1, dd = 0; for (const x of r) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); } return dd; };

function stateOn(rows, thr) { let miss = 0; const on = rows.map((r) => { if (r.vix == null || r.v3 == null) { miss++; return false; } return r.vix / r.v3 > thr; }); return { on, miss }; }
const inWin = (eps, rows, from, to) => eps.filter((e) => rows[e.i0].d >= from && rows[e.exit].d <= to);

// ---------- selftest ----------
function selftest() {
  let ok = true; const chk = (name, c, extra = "") => { console.log(`  ${c ? "OK  " : "FAIL"} ${name} ${extra}`); if (!c) ok = false; };
  // (1) state machine on a hand-made ratio path
  const ratio = [0.9, 1.1, 1.2, 0.9, 0.9, 1.05, 0.8, 1.3];      // ON at idx 1,2 and 5 and 7(open at end -> dropped)
  const on = ratio.map((x) => x > 1), eps = episodesOf(on);
  chk("episodes = [(1..2 exit 3), (5..5 exit 6)] and trailing open episode dropped", JSON.stringify(eps) === JSON.stringify([{ i0: 1, i1: 2, exit: 3 }, { i0: 5, i1: 5, exit: 6 }]));
  // (2) hand-computed returns: prices 100,100,110,121,121,121,60.5,60.5; rf 0
  const px = [100, 100, 110, 121, 121, 121, 60.5, 60.5], rows = px.map((p, i) => ({ d: "2020-01-0" + (i + 1), p, rf: 0, vix: 20, v3: 20 }));
  const g0 = gradeEp(rows, 1, 3, 0), g1 = gradeEp(rows, 5, 6, 0);
  chk("episode 1 gross = 121/100-1 = 0.21 (entry idx1, exit idx3)", Math.abs(g0.gross - 0.21) < 1e-12, g0.gross);
  chk("episode 2 gross = 60.5/121-1 = -0.5", Math.abs(g1.gross + 0.5) < 1e-12, g1.gross);
  const gc = gradeEp(rows, 1, 3, 1), expCost = 0.01 / 100 + 0.0002 + 0.01 / 121 + 0.0002;
  chk("net = gross - (0.01/px + 2bps) both sides", Math.abs(gc.net - (0.21 - expCost)) < 1e-12, gc.net);
  // (3) never-in rule: portfolio = T-bill exactly; active over rf = 0
  const rf = rows.map(() => 0.0001); rows.forEach((r, i) => (r.rf = rf[i]));
  const nv = dailyPortfolio(rows, [], 0, rows.length - 1); chk("never-in: strategy daily == rf exactly", nv.strat.every((x, i) => Math.abs(x - nv.rfs[i]) < 1e-15));
  // (4) always-in (one episode spanning the sample): gross = SPY total return - rf compounded; net = minus 2 sides
  const all = gradeEp(rows, 0, rows.length - 1, 1); let s = 1, r = 1; for (let k = 1; k < rows.length; k++) { s *= rows[k].p / rows[k - 1].p; r *= 1 + rows[k].rf; }
  chk("always-in: gross = compounded SPY - compounded rf", Math.abs(all.gross - (s - r)) < 1e-12);
  chk("always-in: net = gross - charged cost", Math.abs(all.net - (s - r - costSide(100) - costSide(60.5))) < 1e-12);
  // (5) shuffled signal on an iid synthetic tape gives ~0 mean excess (rf=0, no cost) - deterministic LCG
  let seed = 291291; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const N = 20000, syn = []; let p = 100; for (let i = 0; i < N; i++) { p *= 1 + (rnd() - 0.5) * 0.02; syn.push({ d: "x" + i, p, rf: 0, vix: 20, v3: 20 }); }
  const sh = syn.map(() => rnd() < 0.15), se = episodesOf(sh).map((e) => gradeEp(syn, e.i0, e.exit, 0).gross);
  const tt = tOf(se); chk("shuffled signal on iid tape: |t| < 3", Math.abs(tt) < 3, `t=${tt.toFixed(2)} over ${se.length} episodes`);
  console.log(ok ? "selftest PASSED" : "selftest FAILED"); process.exit(ok ? 0 : 1);
}

// ---------- read ----------
(async () => {
  if (mode === "--selftest") return selftest();
  const [vix, v3, dtb] = await Promise.all([yahoo("^VIX"), yahoo("^VIX3M"), fredRf()]);
  const vixM = new Map(vix.map((b) => [b.d, b.c])), v3M = new Map(v3.map((b) => [b.d, b.c]));
  const tick = {}, lvlMap = lvlMapOf(vix);
  for (const sym of ["SPY", "QQQ"]) {
    const y = await yahoo(sym), a = await alpaca(sym);
    tick[sym] = {
      disc: align(y.filter((b) => b.d <= DISC_TO && b.d >= "2007-12-01" && b.a > 0).map((b) => ({ d: b.d, p: b.a })), vixM, v3M, dtb, lvlMap),
      hold: align(a.map((b) => ({ d: b.d, p: b.c })), vixM, v3M, dtb, lvlMap),
    };
  }
  if (mode === "--data") {
    for (const s of Object.keys(tick)) for (const w of ["disc", "hold"]) { const r = tick[s][w], m = stateOn(r, 1).miss; console.log(`${s} ${w}: ${r.length} rows ${r[0].d}..${r.at(-1).d}; signal-missing days ${m}`); }
    console.log(`VIX ${vix.length} ${vix[0].d}..${vix.at(-1).d}; VIX3M ${v3.length} ${v3[0].d}..${v3.at(-1).d}`); return;
  }
  // --- read-once guard ---
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R291) throw new Error("R291 already sealed - read-once");
  if (fs.existsSync(OUT)) throw new Error("R291 output already exists - read-once");

  const H = tick.SPY.hold, cell = (rows, thr, from, to) => { const st = stateOn(rows, thr); return { st, eps: inWin(episodesOf(st.on), rows, from, to) }; };
  const grade = (rows, eps, cm = 1) => eps.map((e) => gradeEp(rows, e.i0, e.exit, cm));

  // PRIMARY: SPY, ratio > 1.00, sealed holdout
  const prim = cell(H, THRESH, HOLD_FROM, HOLD_TO), pe = grade(H, prim.eps), ps = summarize(pe);
  const midDate = new Date((Date.parse(HOLD_FROM) + Date.parse(HOLD_TO)) / 2).toISOString().slice(0, 10);
  const halfOf = (a) => { const s = summarize(a); return { n: s.n, meanNet: s.meanNet, tNet: s.tNet }; };
  const halves = { split: midDate, first: halfOf(pe.filter((e) => e.entry < midDate)), second: halfOf(pe.filter((e) => e.entry >= midDate)) };
  const sameSign = halves.first.n > 0 && halves.second.n > 0 && Math.sign(halves.first.meanNet) === Math.sign(halves.second.meanNet);
  const sens = Object.fromEntries([0, 1, 2, 5].map((m) => { const s = summarize(grade(H, prim.eps, m)); return ["costx" + m, { meanNetPct: +(100 * s.meanNet).toFixed(4), tNet: +s.tNet.toFixed(3) }]; }));

  // (b) placebo: per episode, draw one contango day (ratio<=1) among the MATCH_K nearest in VIX level, same length; 200 draws
  const valid = []; H.forEach((r, i) => { if (r.d >= HOLD_FROM && r.d <= HOLD_TO && r.vix != null && r.v3 != null && r.vix / r.v3 <= THRESH) valid.push(i); });
  let seed = 291001; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pool = pe.map((e) => { const len = e.days; const c = valid.filter((i) => i + len < H.length && H[i + len].d <= HOLD_TO).sort((a, b) => Math.abs(H[a].vix - e.entryVix) - Math.abs(H[b].vix - e.entryVix)).slice(0, MATCH_K); return { len, c }; });
  const ptS = [], pmS = [];
  for (let k = 0; k < DRAWS; k++) { const xs = pool.map(({ len, c }) => { const i = c[Math.floor(rnd() * c.length)]; return gradeEp(H, i, i + len).net; }); ptS.push(tOf(xs)); pmS.push(mean(xs)); }
  ptS.sort((a, b) => a - b); pmS.sort((a, b) => a - b);
  const p95t = ptS[Math.floor(0.95 * DRAWS)], p95m = pmS[Math.floor(0.95 * DRAWS)];
  const beats = ps.tNet > p95t && ps.meanNet > p95m;

  // (a) falsifier: VIX level alone (above trailing-252d 80th pct)
  const lvlOn = H.map((r) => r.lvl === true), lvlEps = inWin(episodesOf(lvlOn), H, HOLD_FROM, HOLD_TO), ls = summarize(grade(H, lvlEps));
  // (c) persistence from entry close of each term-structure episode (overlap allowed, gross excess over rf, one round-trip net shown)
  const persist = {}; for (const h of [1, 5, 21]) {
    const xs = prim.eps.filter((e) => e.i0 + h < H.length).map((e) => gradeEp(H, e.i0, e.i0 + h)); const s = summarize(xs);
    persist["h" + h] = { n: s.n, meanGrossPct: +(100 * s.meanGross).toFixed(3), tGross: +s.tGross.toFixed(2), meanNetPct: +(100 * s.meanNet).toFixed(3) };
  }
  // secondary statistic: mean next-day SPY return on state-on days (held days) vs all other days in holdout, Welch t + per-episode clustered t
  const heldSet = new Set(); for (const e of prim.eps) for (let k = e.i0 + 1; k <= e.exit; k++) heldSet.add(k);
  const on = [], off = []; for (let k = 1; k < H.length; k++) { if (H[k].d < HOLD_FROM || H[k].d > HOLD_TO) continue; (heldSet.has(k) ? on : off).push(H[k].p / H[k - 1].p - 1); }
  const welch = (mean(on) - mean(off)) / Math.sqrt(sd(on) ** 2 / on.length + sd(off) ** 2 / off.length);
  const epDayMeans = prim.eps.map((e) => { const xs = []; for (let k = e.i0 + 1; k <= e.exit; k++) xs.push(H[k].p / H[k - 1].p - 1); return mean(xs); });
  // portfolio Sharpe vs buy-and-hold, holdout window
  const lo = Math.max(0, H.findIndex((r) => r.d >= HOLD_FROM) - 1), hi = H.map((r) => r.d <= HOLD_TO).lastIndexOf(true), dp = dailyPortfolio(H, prim.eps, lo, hi);
  const years = dayDiff(HOLD_FROM, HOLD_TO) / 365.25;
  const dollarsAt10k = 10000 * pe.reduce((s, e) => s + e.net, 0) / years;
  const exposure = heldSet.size / (hi - lo);

  // other cells (reported, NOT the verdict): SPY>1.05, QQQ>1.00, QQQ>1.05, SPY 5-session non-overlapping
  const others = {};
  for (const [sym, thr] of [["SPY", THRESH2], ["QQQ", THRESH], ["QQQ", THRESH2]]) { const R = tick[sym].hold, c = cell(R, thr, HOLD_FROM, HOLD_TO), s = summarize(grade(R, c.eps)); others[`${sym}>${thr}`] = { episodes: s.n, meanNetPct: s.n ? +(100 * s.meanNet).toFixed(3) : null, tNet: +s.tNet.toFixed(3) }; }
  { const f5 = []; let nextFree = 0; const st = prim.st.on; for (let i = 0; i < H.length; i++) { if (i < nextFree || !st[i] || (i > 0 && st[i - 1])) continue; if (H[i].d < HOLD_FROM || i + 5 >= H.length || H[i + 5].d > HOLD_TO) continue; f5.push(gradeEp(H, i, i + 5)); nextFree = i + 5; } const s = summarize(f5); others["SPY>1.00 first-day, hold 5 sessions non-overlapping"] = { episodes: s.n, meanNetPct: s.n ? +(100 * s.meanNet).toFixed(3) : null, tNet: +s.tNet.toFixed(3) }; }
  // discovery (descriptive)
  const dc = cell(tick.SPY.disc, THRESH, DISC_FROM, DISC_TO), ds = summarize(grade(tick.SPY.disc, dc.eps));
  const bestOf44 = nullBar({ variants: BAR_VARIANTS, n: Math.max(3, ps.n), trials: 20000 }).p95;

  const pass = ps.tNet >= BAR && beats && sameSign;
  const verdictScript = pass ? "PASS" : "DID NOT PASS";
  const out = {
    id: "R291", key: "VIX_BACKWARDATION_SPX_TIMING", readAt: new Date().toISOString(),
    name: "VIX/VIX3M inversion -> long SPY (Johnson 2017)",
    rule: "SPY long from the close of the first day VIX/VIX3M > 1.00 until the first close <= 1.00 (held on days whose prior close was inverted); T-bill (DTB3) otherwise",
    window: `sealed holdout: episodes entered ${HOLD_FROM}..${HOLD_TO} (SPY Alpaca SIP adjustment=all; VIX/VIX3M Yahoo)`, unit: "episodes",
    n: ps.n, statistic: "one-sample t over per-episode net excess return over T-bills (net of cost)", bar: BAR, barRecomputedAtObservedN: +bestOf44.toFixed(3),
    tNet: +ps.tNet.toFixed(3), tGross: +ps.tGross.toFixed(3), meanNet: +ps.meanNet.toFixed(5), meanGross: +ps.meanGross.toFixed(5), winRate: +ps.winRate.toFixed(3),
    placebo: { kind: "random contango-day entry matched on entry-day VIX level (20 nearest), same holding length, 200 draws", p95: +p95t.toFixed(3), p95Mean: +p95m.toFixed(5), observed: +ps.tNet.toFixed(3), observedMean: +ps.meanNet.toFixed(5), beats },
    halves, dollarsAt10k: +dollarsAt10k.toFixed(0), dollarsAt10kNote: "net $/yr over T-bills on $10k deployed only during episodes (incremental to cash), summed over episodes / holdout years",
    maxDD: +maxDD(dp.strat).toFixed(4), exposureFraction: +exposure.toFixed(3),
    portfolio: { sharpeStrategy: +sharpe(dp.strat, dp.rfs).toFixed(3), sharpeBuyHold: +sharpe(dp.bh, dp.rfs).toFixed(3), maxDDBuyHold: +maxDD(dp.bh).toFixed(4) },
    daysStat: { onDays: on.length, offDays: off.length, meanOnPct: +(100 * mean(on)).toFixed(4), meanOffPct: +(100 * mean(off)).toFixed(4), welchT: +welch.toFixed(2), episodeClusteredTonDays: +tOf(epDayMeans).toFixed(2) },
    falsifierVixLevelOnly: { rule: "VIX above trailing-252d 80th pct", episodes: ls.n, meanNetPct: +(100 * ls.meanNet).toFixed(3), tNet: +ls.tNet.toFixed(3), termStructureBeatsLevel: ps.tNet > ls.tNet && ps.meanNet > ls.meanNet },
    persistence: persist, costSensitivity: sens, otherCells: others,
    discoveryDescriptive: { window: `${DISC_FROM}..${DISC_TO} (Yahoo adj close; motivating sample only)`, episodes: ds.n, meanNetPct: +(100 * ds.meanNet).toFixed(3), tNet: +ds.tNet.toFixed(3) },
    missingSignalDays: { holdout: prim.st.miss },
    costModel: `$${COST_SH}/share + ${COST_BPS} bps per side (half-spread proxy), round trip per episode; sensitivity 0x/1x/2x/5x reported`,
    dataSources: ["^VIX and ^VIX3M daily closes, Yahoo via :3002 (cached data/training/r291)", "SPY/QQQ Alpaca SIP daily adjustment=all 2015-12..2026-09 (holdout); Yahoo adj close 2007-12..2015-12 (discovery)", "FRED DTB3"],
    episodeList: pe.map((e) => ({ entry: e.entry, exit: e.exit, days: e.days, spyPct: +(100 * e.spy).toFixed(2), netExcessPct: +(100 * e.net).toFixed(2), entryVix: e.entryVix })),
    knownWeaknesses: [
      "Effective N is a handful of crash episodes; the registry expected 15 and the MDE at that n is far above any plausible edge - NOT-ESTABLISHED is a live outcome.",
      "Episode lengths vary 1..many days; the per-episode t weights a 1-day blip like a 3-month bear market. The days-based secondary statistic is shown beside it.",
      "The paper's estimator (4th principal component of the futures curve, next-QUARTER return) is not this rule; VIX/VIX3M is a cash-index-vol proxy for the futures term structure.",
      "Signal is known at the 16:00 close and the fill is assumed AT that close (MOC); an intraday-executable version would pay a wider spread on exactly the stressed days when the state flips.",
      "Yahoo VIX3M closes are third-party copies of the CBOE index; signal-missing days were treated as OFF (counted above). R182 correlation not computed.",
      "Other cells (SPY>1.05, QQQ, 5-session) were also examined; the verdict is the primary cell only, the bar was sized best-of-4 (own cells) after the 09-29 pre-evidence amendment.",
    ],
    verdictScript,
  };
  writeJsonAtomic(OUT, out);
  console.log(`R291 ${verdictScript}: n=${ps.n} episodes, tNet ${ps.tNet.toFixed(3)} (bar ${BAR}), tGross ${ps.tGross.toFixed(3)}, meanNet ${(100 * ps.meanNet).toFixed(3)}%/episode, win ${(100 * ps.winRate).toFixed(0)}%`);
  console.log(`placebo t p95 ${p95t.toFixed(3)} (beats=${beats}); halves ${halves.first.n}/${halves.second.n} eps meanNet ${(100 * halves.first.meanNet).toFixed(3)}% / ${(100 * halves.second.meanNet).toFixed(3)}% (split ${midDate}, sameSign=${sameSign})`);
  console.log(`falsifier level-only: ${ls.n} eps meanNet ${(100 * ls.meanNet).toFixed(3)}% t ${ls.tNet.toFixed(2)}; persistence ${JSON.stringify(persist)}`);
  console.log(`$/yr on $10k ${dollarsAt10k.toFixed(0)}; maxDD ${(100 * maxDD(dp.strat)).toFixed(1)}%; Sharpe strat ${sharpe(dp.strat, dp.rfs).toFixed(2)} vs B&H ${sharpe(dp.bh, dp.rfs).toFixed(2)}; exposure ${(100 * exposure).toFixed(1)}%`);
  console.log(`other cells ${JSON.stringify(others)}; discovery ${JSON.stringify(out.discoveryDescriptive)}`);
})().catch((e) => { console.error("R291 FAILED:", e.message); process.exit(1); });
