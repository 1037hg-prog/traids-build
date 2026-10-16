#!/usr/bin/env node
/**
 * R235 — BOOK-1 FORWARD composer (registered 2026-09-25; rule frozen in data/test-registry.json — this file implements it, never changes it).
 * READ-ONLY: places no orders and calls no broker endpoint. Network reads: Coinbase public daily candles (BTC/ETH), Alpaca market-data
 * daily IEF bars (sip, adjustment all) via lib/alpaca-bars.js, and FRED DTB3 (cache refresh only when the month is not yet covered).
 *
 *   book_m   = 5 x tre_m + 0.8 x tb_m + 0.2 x sleeve_m                          (rebalanced monthly in return space)
 *   tre_m    = R219 window net $ / (2 x ZN notional at entry)  -> "R219"
 *              else 0.79 x R186 fill-to-fill IEF window return  -> "FALLBACK"
 *              else 0                                            -> "MISSING"
 *   sleeve_m = R191 paper-book $ P&L on its fixed $20,000 capital, compounded over the month's UTC days (positions replayed from R191's
 *              own fills; every UTC day valued at the Coinbase daily close — the same source R191 marks from — and cross-checked
 *              against R191's marks where it has one), PLUS tb_m x (share of coin-days R191 held no position at the day's start)
 *   tb_m     = FRED DTB3 month-average yield / 100 / 12
 * Controls per month: CONTROL-B (beta-matched 50/50 buy-and-hold), the public-data MODEL book (3.95 x IEF last-5-session window +
 * model 50-day sleeve), the winners-only PEEK book; the 200-book placebo p95 is recomputed over all scored months after each write.
 * The equal-risk split (weightless) = equal volatility contribution from the two legs at the fixed book's trailing-36-month volatility.
 *
 *   node backend/r235-book-1.js --run        close chain, nightly-safe and idempotent: scores each completed calendar month once, in order,
 *                                            from 2026-10; waits (never imputes) until R219/R186's window is closed, R191 has marked
 *                                            through the month's last UTC day and FRED covers the month. Exit 1 = STARVING (> 7 days late).
 *   node backend/r235-book-1.js --status     weightless status (offline)
 *   node backend/r235-book-1.js --selftest   known answer on library history + zero-edge false-positive rate + unit checks (+ online checks)
 *   node backend/r235-book-1.js --read       the one registered read, after the 36th book month; refuses earlier; seals once
 * Output: data/r235-book-1.json (+ data/r235-book-1.jsonl, one row per month), written only through lib/atomic-write.js.
 * Interim kill: month-end book NAV drawdown <= -20% -> the BOOK test is marked STOPPED (registry status + GOVERNANCE line), printed loudly.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic, writeTextAtomic } = require("./lib/atomic-write.js");
const D = (...f) => path.join(__dirname, "data", ...f);
const F = { out: D("r235-book-1.json"), outl: D("r235-book-1.jsonl"), r219: D("r219-zn-month-end.json"), r186: D("r186-month-end.json"), r191: D("r191-crypto-trend.json"),
  dtb3: D("training", "fred", "DTB3.csv"), reg: D("test-registry.json"), seals: D("read-seals.json"), ledger: D("agent-ledger.jsonl"), lib: D("strategy-library"), stress: D("ensemble-book-stress-2026-09-25.json") };
const ID = "R235", FIRST = "2026-10", READ_N = 36, L = 5, X = 0.2, ZN_IEF_BETA = 0.79, ZN_MULT = 1000, ZN_QTY = 2, CAP = 20000, PER_COIN = 10000, COINS = ["BTC", "ETH"];
const KILL = -0.2, TARGET = 0.3, N_PLACEBO = 200, PLACEBO_SEED = 235000, SWITCH_COST = 0.0025, SMA_N = 50, STARVE_DAYS = 7, LIB_LAST = "2026-08", TRAIL = 36;
const KNOWN = { lo: "2018-01", hi: "2026-08", cagrPct: 22.68, maxDDPct: -14.1, tol: 0.1 };
const mode = ["--run", "--status", "--selftest", "--read"].find((m) => process.argv.includes(m)) || "--status";

// ---- small helpers -----------------------------------------------------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const fin = (x, k) => (Number.isFinite(x) ? +x.toFixed(k) : null);
const r6 = (x) => (Number.isFinite(x) ? +x.toFixed(6) : null), pct = (x, k = 2) => (Number.isFinite(x) ? (100 * x).toFixed(k) + "%" : "—");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const lastDay = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const nextYm = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
const addDay = (d, k) => new Date(Date.parse(d + "T00:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const daysOf = (ym) => { const out = []; for (let d = ym + "-01"; d.slice(0, 7) === ym; d = addDay(d, 1)) out.push(d); return out; };
const todayUTC = () => new Date().toISOString().slice(0, 10);
const readJson = (f, dflt) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : dflt);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

// ---- the composition (pure) ----------------------------------------------------------------------------------------------------
const compose = ({ tre, tb, sleeve }) => L * tre + (1 - X) * tb + X * sleeve;
function navStats(books) { let nav = 1, pk = 1, maxDD = 0; const path = []; for (const b of books) { nav *= 1 + b; pk = Math.max(pk, nav); const dd = nav / pk - 1; maxDD = Math.min(maxDD, dd); path.push({ nav, dd }); }
  return { nav, maxDD, path, cagr: books.length ? nav ** (12 / books.length) - 1 : null }; }
const killed = (dd) => dd <= KILL + 1e-12;
function olsSlope(y, x) { const mx = mean(x), my = mean(y); let c = 0, v = 0; x.forEach((xi, i) => { c += (xi - mx) * (y[i] - my); v += (xi - mx) ** 2; }); return c / v; }
function corr(a, b) { const ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; a.forEach((x, i) => { c += (x - ma) * (b[i] - mb); va += (x - ma) ** 2; vb += (b[i] - mb) ** 2; }); return c / Math.sqrt(va * vb); }
// equal-risk split: both legs contribute equal volatility (L*sig_t = x*sig_s), total volatility matched to the fixed book's (weightless)
function equalRisk(tre, slEx) { const st = sd(tre), ss = sd(slEx), rho = corr(tre, slEx), v = (L * st) ** 2 + (X * ss) ** 2 + 2 * L * X * rho * st * ss, a = Math.sqrt(v / (2 + 2 * rho));
  return { L: a / st, x: a / ss, rho }; }

// ---- T-bill ------------------------------------------------------------------------------------------------------------------------
function dtb3Parse(text) { const lines = text.trim().split(/\r?\n/); if (!/^observation_date,DTB3/.test(lines[0])) throw new Error("DTB3: unexpected header " + lines[0].slice(0, 40));
  const M = new Map(); let last = null; for (const l of lines.slice(1)) { const [d, v] = l.split(","); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue; last = d; if (v && v.trim() !== "" && v !== ".") { const m = d.slice(0, 7); (M.get(m) || M.set(m, []).get(m)).push(+v); } }
  return { last, tbOf: (ym) => (M.has(ym) ? mean(M.get(ym)) / 100 / 12 : null), rows: lines.length - 1 }; }
const dtb3Local = () => dtb3Parse(fs.readFileSync(F.dtb3, "utf8"));
async function dtb3For(ym) {   // complete = the cache holds an observation dated after the month (so every day of the month is in)
  let d = dtb3Local(); const done = (x) => x.last > lastDay(ym) && x.tbOf(ym) != null;
  if (done(d)) return { tb: d.tbOf(ym), refreshed: false };
  const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3", { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`FRED DTB3 HTTP ${r.status}`);
  const text = await r.text(), fresh = dtb3Parse(text); if (!(fresh.last >= d.last) || fresh.rows < d.rows) throw new Error("FRED DTB3 download is shorter/older than the cache — refusing to overwrite");
  writeTextAtomic(F.dtb3, text); d = fresh;
  return done(d) ? { tb: d.tbOf(ym), refreshed: true } : { wait: `FRED DTB3 does not cover ${ym} completely yet (latest observation ${d.last})` }; }

// ---- Treasury leg: R219 -> R186 fallback -> MISSING ---------------------------------------------------------------------------
function treasuryLeg(ym, r219, r186) {
  const w = r219 && r219.windows ? r219.windows[ym] : null;
  if (w && w.score && w.entry && w.entry.px > 0 && Number.isFinite(w.score.net)) { const notional = ZN_QTY * w.entry.px * ZN_MULT;
    return { ok: true, tre: w.score.net / notional, source: "R219", detail: { contract: w.contract, entryPx: w.entry.px, exitPx: w.exit ? w.exit.px : null, netUSD: w.score.net, notionalUSD: notional, late: !!w.score.late } }; }
  if (w && w.entry && !w.score) return { ok: false, wait: `R219 ${ym} window still open (bought ${w.contract} at ${w.entry.px}, no scored exit yet)` };
  const why219 = !r219 ? "R219 state file absent" : !w ? "R219 has no window" : w.noEntry ? `R219 no entry (${w.noEntry})` : "R219 has no valid row";
  const v = r186 && r186.windows ? r186.windows[ym] : null;
  if (v && v.score && Number.isFinite(v.score.fillToFill)) return { ok: true, tre: ZN_IEF_BETA * v.score.fillToFill, source: "FALLBACK", detail: { why: why219, r186FillToFill: v.score.fillToFill, beta: ZN_IEF_BETA } };
  if (v && ((v.entryFill != null && v.score == null) || (v.entryCid && v.entryFill == null))) return { ok: false, wait: `${why219}; R186 ${ym} window not closed yet (fallback pending)` };
  return { ok: true, tre: 0, source: "MISSING", detail: { why: why219 + "; " + (!r186 ? "R186 state file absent" : !v ? "R186 has no window" : "R186 has no scored window") } };
}

// ---- crypto leg: R191 replay ------------------------------------------------------------------------------------------------------
const coinOf = (cid) => { const m = /^r191-([A-Z]+)-/.exec(cid || ""); return m ? m[1] : null; };
function r191Ready(ym, s) {
  if (!s) return "R191 state file absent (data/r191-crypto-trend.json)";
  const end = lastDay(ym);
  for (const c of COINS) if (!(s.marks || []).some((m) => m.coin === c && m.d >= end)) return `R191 has no ${c} mark on/after ${end} yet`;
  for (const c of COINS) { const p = s.coins && s.coins[c] && s.coins[c].pending; if (p && !(p.signalDay > end)) return `R191 ${c} order ${p.cid} still pending reconciliation`; }
  return null; }
function r191Sleeve(ym, s, closes /* {BTC: Map d->close, ETH: ...} */, tb) {
  const days = daysOf(ym), base = addDay(days[0], -1), fills = (s.orders || []).filter((f) => COINS.includes(coinOf(f.cid))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const book = (c, tMs) => { let qty = 0, cash = PER_COIN; for (const f of fills) { if (coinOf(f.cid) !== c || !(Date.parse(f.at) < tMs)) continue; if (f.side === "buy") { cash -= f.qty * f.px; qty = f.qty; } else { cash += f.qty * f.px; qty = 0; } } return { qty, cash }; };
  const close = (c, d) => { const v = closes[c].get(d); if (!(v > 0)) throw new Error(`no Coinbase ${c} close for ${d}`); return v; };
  const nav = (d) => COINS.reduce((a, c) => { const b = book(c, Date.parse(addDay(d, 1) + "T00:00:00Z")); return a + b.cash + b.qty * close(c, d); }, 0);
  let prev = nav(base), g = 1, outDays = 0; const navBase = prev;
  for (const d of days) { const n = nav(d); g *= 1 + (n - prev) / CAP; prev = n; for (const c of COINS) if (!(book(c, Date.parse(d + "T00:00:00Z")).qty > 0)) outDays++; }
  const outShare = outDays / (COINS.length * days.length), marks = (s.marks || []).filter((m) => m.d >= base && m.d <= days[days.length - 1]);
  const mismatch = marks.filter((m) => closes[m.coin] && closes[m.coin].has(m.d) && Math.abs(m.close / closes[m.coin].get(m.d) - 1) > 1e-6).map((m) => `${m.coin} ${m.d} mark ${m.close} vs coinbase ${closes[m.coin].get(m.d)}`);
  return { sleeve: g - 1 + tb * outShare, paperReturn: g - 1, pnlUSD: prev - navBase, outShare, fillsInMonth: fills.filter((f) => f.at.slice(0, 7) === ym).length, markedDays: new Set(marks.map((m) => m.d)).size, markMismatch: mismatch }; }

// ---- public data: Coinbase closes, the model 50-day sleeve, IEF windows -----------------------------------------------------------
async function coinbaseCloses(coin, from = "2016-01-01") {
  const endDay = todayUTC(), stop = Date.parse(from + "T00:00:00Z"), all = new Map(); let end = Date.parse(endDay + "T00:00:00Z");
  while (end > stop) { const st = Math.max(stop, end - 299 * 864e5), url = `https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(st).toISOString()}&end=${new Date(end).toISOString()}`; let a;
    for (let k = 0; ; k++) { try { const r = await fetch(url, { headers: { "User-Agent": "TRAIDS R235 composer (read-only)" }, signal: AbortSignal.timeout(20000) }); a = await r.json(); if (!Array.isArray(a)) throw new Error(`coinbase ${coin} HTTP ${r.status}`); break; } catch (e) { if (k >= 3) throw e; await sleep(1500 * (k + 1)); } }
    for (const x of a) { const d = new Date(x[0] * 1000).toISOString().slice(0, 10); if (d < endDay) all.set(d, x[4]); }
    if (!a.length && all.size) break; end = st - 864e5; await sleep(350); }
  const rows = [...all].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, c]) => ({ d, c }));   // 2016 has exchange gaps (kept as-is, as the library did); none tolerated from 2017
  for (let i = 1; i < rows.length; i++) if (rows[i].d >= "2017-01-01" && rows[i].d !== addDay(rows[i - 1].d, 1)) throw new Error(`coinbase ${coin}: gap between ${rows[i - 1].d} and ${rows[i].d} — refusing`);
  return rows; }
// the library construction (crypto-trend-book.js coinDaily, no stop): held[i] = position during day i (decided at close i-1); held has n+1 entries
function modelCoin(rows) { const d = [], r = [], held = []; let pos = 0;
  for (let i = SMA_N; i < rows.length; i++) { d.push(rows[i].d); r.push(rows[i].c / rows[i - 1].c - 1); held.push(pos); const sma = mean(rows.slice(i - SMA_N + 1, i + 1).map((x) => x.c)); pos = rows[i].c > sma ? 1 : 0; }
  held.push(pos); return { d, r, held, idx: new Map(d.map((x, i) => [x, i])) }; }
const shiftFlags = (h, off) => { const n = h.length; return h.map((_, j) => h[(((j - off) % n) + n) % n]); };
const coinDay = (m, h, i) => (h[i] ? m.r[i] : 0) - (h[i + 1] !== h[i] ? SWITCH_COST : 0);
function modelSleeveMonth(ym, M, H, tb) {   // M = {BTC: modelCoin, ETH: ...}, H = {BTC: held[], ETH: held[]}
  let g = 1, out = 0; const days = daysOf(ym);
  for (const d of days) { let r = 0; for (const c of COINS) { const i = M[c].idx.get(d); if (i == null) throw new Error(`model sleeve: no ${c} day ${d}`); r += 0.5 * coinDay(M[c], H[c], i); if (!H[c][i]) out++; } g *= 1 + r; }
  return g - 1 + tb * out / (COINS.length * days.length); }
function bhMonth(ym, closes) { let g = 1; for (const d of daysOf(ym)) { let r = 0; for (const c of COINS) { const a = closes[c].get(d), b = closes[c].get(addDay(d, -1)); if (!(a > 0 && b > 0)) throw new Error(`buy-and-hold: no ${c} close around ${d}`); r += 0.5 * (a / b - 1); } g *= 1 + r; } return g - 1; }
async function iefBars(fromYm, toYm) { const { fetchBars } = require("./lib/alpaca-bars.js");
  const start = addDay(fromYm + "-01", -10), end = lastDay(toYm) + "T23:00:00Z";
  return ((await fetchBars(["IEF"], { start, end, feed: "sip", adjustment: "all", quiet: true })).bars.IEF || []).map((b) => ({ d: b.t.slice(0, 10), c: b.c })); }
function iefSessions(ym, bars) { const i0 = bars.findIndex((b) => b.d.slice(0, 7) === ym); if (i0 < 1) return null; const out = [];
  for (let i = i0; i < bars.length && bars[i].d.slice(0, 7) === ym; i++) out.push(r6(bars[i].c / bars[i - 1].c - 1)); return out; }
const win5 = (sess, st) => sess.slice(st, st + 5).reduce((p, x) => p * (1 + x), 1) - 1;
function modelRow(ym, sess, M, tb) { const ief5 = win5(sess, sess.length - 5), msl = modelSleeveMonth(ym, M, { BTC: M.BTC.held, ETH: M.ETH.held }, tb), tre = ZN_IEF_BETA * ief5;
  const book = compose({ tre, tb, sleeve: msl }), peek = compose({ tre: Math.max(tre, 0), tb, sleeve: Math.max(msl, tb) });
  return { iefSess: sess, ief5: r6(ief5), tre: r6(tre), sleeve: r6(msl), book: r6(book), excess: r6(book - tb), peekExcess: r6(peek - tb) }; }
// 200 placebo books over the given rows: seed 235000+k -> one circular flag offset (30..335 days), then one window start per month in order
function placebo(rows, M) { const means = [];
  for (let k = 0; k < N_PLACEBO; k++) { const rng = mulberry(PLACEBO_SEED + k), off = 30 + Math.floor(rng() * 306), H = { BTC: shiftFlags(M.BTC.held, off), ETH: shiftFlags(M.ETH.held, off) }, ex = [];
    for (const row of rows) { const s = row.model.iefSess, st = Math.floor(rng() * (s.length - 9)); ex.push(compose({ tre: ZN_IEF_BETA * win5(s, st), tb: row.tb, sleeve: modelSleeveMonth(row.m, M, H, row.tb) }) - row.tb); }
    means.push(mean(ex)); }
  means.sort((a, b) => a - b); return { n: N_PLACEBO, p95: means[Math.floor(0.95 * N_PLACEBO)], median: means[N_PLACEBO >> 1] }; }

// ---- library history (known answer, beta and equal-risk history) ---------------------------------------------------------------
function library(tbOf) {
  const lib = (id) => JSON.parse(fs.readFileSync(path.join(F.lib, id + ".json"), "utf8"));
  const tre = new Map(lib("TSY-ZN1X").series.map((x) => [x.d.slice(0, 7), x.r]));
  const e = lib("CRYPTO-T50"), s = new Map(e.series.map((x) => [x.d, x.r])), sleeve = new Map();
  // composer convention on library data: compound the daily sleeve; the library carries no per-coin split, so the out-share is the share of
  // days BOTH coins were out (days omitted from the series) — a lower bound on the coin-day share (disclosed in the selftest output)
  for (let ym = nextYm(e.window[0].slice(0, 7)); ym <= e.window[1].slice(0, 7); ym = nextYm(ym)) { const days = daysOf(ym); let g = 1, out = 0; for (const d of days) { if (s.has(d)) g *= 1 + s.get(d); else out++; }
    const tb = tbOf(ym); if (tb != null) sleeve.set(ym, g - 1 + tb * out / days.length); }
  const bh = new Map(); for (const x of lib("CRYPTO-BH").series) { const m = x.d.slice(0, 7); bh.set(m, (bh.get(m) ?? 1) * (1 + x.r)); } for (const [m, g] of bh) bh.set(m, g - 1);
  return { tre, sleeve, bh }; }
function history(rows, tbOf) {   // monthly sequence: library months (<= LIB_LAST), then scored forward months
  const lb = library(tbOf), seq = [], fwd = new Set(rows.map((r) => r.m));
  for (const [m, sl] of lb.sleeve) if (m <= LIB_LAST && !fwd.has(m) && lb.tre.has(m) && lb.bh.has(m)) seq.push({ m, tre: lb.tre.get(m), slEx: sl - tbOf(m), bhEx: lb.bh.get(m) - tbOf(m) });
  for (const r of rows) seq.push({ m: r.m, tre: r.tre, slEx: r.sleeve - r.tb, bhEx: r.controlB.bh - r.tb });
  return seq.sort((a, b) => (a.m < b.m ? -1 : 1)); }

// ---- state ------------------------------------------------------------------------------------------------------------------------
const loadOut = () => readJson(F.out, { spec: "r235-book-1-v1", test: ID, rule: "see data/test-registry.json R235 (frozen); this file is composer output", months: [], status: {} });
function summarise(out, extra = {}) { const rows = out.months, ns = navStats(rows.map((r) => r.book)), ex = rows.map((r) => r.excess), t = tOf(ex);
  const last12 = rows.length >= 12 ? rows.slice(-12).reduce((p, r) => p * (1 + r.book), 1) - 1 : null;
  out.status = { ...out.status, monthsScored: rows.length, readAfter: READ_N, lastMonth: rows.length ? rows[rows.length - 1].m : null, nav: r6(ns.nav), drawdown: rows.length ? r6(ns.path[ns.path.length - 1].dd) : 0,
    maxDD: r6(ns.maxDD), cagrSinceStart: r6(ns.cagr), trailing12m: r6(last12), vsTarget: ns.cagr == null ? null : `${pct(ns.cagr, 1)} vs ${pct(TARGET, 0)}/yr target (not part of the pass)`,
    meanExcess: rows.length ? r6(mean(ex)) : null, tExcess: t == null ? null : +t.toFixed(3), controlBMeanExcess: rows.length ? r6(mean(rows.map((r) => r.controlB.excess))) : null,
    modelMeanExcess: rows.length ? r6(mean(rows.map((r) => r.model.excess))) : null, peekT: rows.length >= 3 ? +(tOf(rows.map((r) => r.model.peekExcess)) || 0).toFixed(3) : null,
    bothLegsSourced: rows.filter((r) => r.treSource !== "MISSING" && r.sleeveSource === "R191").length, fallbackMonths: rows.filter((r) => r.treSource === "FALLBACK").length,
    missingMonths: rows.filter((r) => r.treSource === "MISSING").length, weightless: "status only — the verdict is --read after month 36", ...extra };
  return out; }
function saveOut(out) { out.asOf = new Date().toISOString(); writeJsonAtomic(F.out, out); writeTextAtomic(F.outl, out.months.map((r) => JSON.stringify(r)).join("\n") + (out.months.length ? "\n" : "")); }
function registryUpdate(fn) { const reg = readJson(F.reg), E = [...(reg.tests || []), ...(reg.preregistered || [])].find((x) => x.id === ID); if (!E) throw new Error(`${ID} not found in the registry`); fn(E, reg); reg.asOf = new Date().toISOString(); writeJsonAtomic(F.reg, reg); return E; }
const governance = (o) => fs.appendFileSync(F.ledger, JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", test: ID, ...o }) + "\n");
function printStatus(out) { const s = out.status || {};
  console.log(`R235 BOOK-1 — ${s.monthsScored || 0}/${READ_N} book months${s.lastMonth ? ` (last ${s.lastMonth})` : ""}${s.monthsScored ? ` · NAV ${s.nav} · DD ${pct(s.drawdown, 1)} (max ${pct(s.maxDD, 1)}) · ${s.vsTarget} · mean excess ${pct(s.meanExcess, 3)}/mo${s.tExcess != null ? ` t ${s.tExcess}` : ""} · control-B ${pct(s.controlBMeanExcess, 3)} · model ${pct(s.modelMeanExcess, 3)}${s.placebo ? ` vs placebo p95 ${pct(s.placebo.p95, 3)}` : ""} · sourced ${s.bothLegsSourced}/${s.monthsScored}, FALLBACK ${s.fallbackMonths}, MISSING ${s.missingMonths}` : ""} · weightless`);
  if (s.stopped) console.log(`  !!! STOPPED by the interim kill at ${s.stopped.month}: drawdown ${pct(s.stopped.dd, 1)} <= -20% !!!`);
  for (const r of out.months.slice(-3)) console.log(`  ${r.m}  tre ${pct(r.tre, 3)} [${r.treSource}]  sleeve ${pct(r.sleeve, 2)} [${r.sleeveSource}]  tb ${pct(r.tb, 3)}  book ${pct(r.book, 2)}  ctrl-B ${pct(r.controlB.value, 2)}  NAV ${r.nav}  DD ${pct(r.dd, 1)}  ER ${r.erSplit.L != null ? r.erSplit.L.toFixed(2) + "x" : "n/a"}/${pct(r.erSplit.x, 1)}${r.flags.length ? "  flags " + r.flags.join(",") : ""}`); }

// ---- --run ------------------------------------------------------------------------------------------------------------------------
async function run() {
  const out = loadOut(), today = todayUTC();
  if (out.status && out.status.stopped) { printStatus(out); return console.log("R235 --run: the BOOK test is STOPPED (interim kill) — no further months are scored; components continue under their own registrations"); }
  const done = new Set(out.months.map((r) => r.m)), due = []; for (let ym = FIRST; lastDay(ym) < today; ym = nextYm(ym)) if (!done.has(ym)) due.push(ym);
  if (!due.length) { printStatus(out); return console.log(`R235 --run: no forward book month is complete yet — ${out.months.length ? `next is ${nextYm(out.status.lastMonth)}` : `first book month ${FIRST}`}; composable after ${lastDay(out.months.length ? nextYm(out.status.lastMonth) : FIRST)} (UTC) once R219/R186 have closed the window, R191 has marked through that day and FRED DTB3 covers the month`); }
  let closes = null, M = null, wrote = 0;
  for (const ym of due) {
    const r219 = readJson(F.r219, null), r186 = readJson(F.r186, null), r191 = readJson(F.r191, null);
    const leg = treasuryLeg(ym, r219, r186), notReady = !leg.ok ? leg.wait : r191Ready(ym, r191);
    const t = notReady ? null : await dtb3For(ym), wait = notReady || (t && t.wait);
    if (wait) { const late = daysBetween(lastDay(ym), today);
      if (late > STARVE_DAYS) { console.error(`R235 STARVING — ${ym} ended ${late} days ago and still cannot be composed: ${wait}`); summarise(out, { waiting: { month: ym, why: wait, since: lastDay(ym), starving: true } }); if (wrote) saveOut(out); process.exitCode = 1; return; }
      console.log(`R235 --run: WAITING on ${ym} — ${wait} (month ended ${late} day(s) ago; never imputed)`); if (wrote) { summarise(out, { waiting: { month: ym, why: wait } }); saveOut(out); } return; }
    const tb = t.tb;
    if (!closes) { closes = {}; M = {}; for (const c of COINS) { const rows = await coinbaseCloses(c); closes[c] = new Map(rows.map((x) => [x.d, x.c])); M[c] = modelCoin(rows); } }
    const sl = r191Sleeve(ym, r191, closes, tb), bh = bhMonth(ym, closes), sess = iefSessions(ym, await iefBars(ym, ym));
    if (!sess || sess.length < 10) throw new Error(`IEF sessions for ${ym}: ${sess ? sess.length : 0} (need >= 10) — refusing`);
    // frozen at the month start: trailing-36 beta of sleeve excess on BH excess, and the equal-risk split
    const dtl = dtb3Local(), hist = history(out.months, (m) => (m === ym ? tb : dtl.tbOf(m))).filter((h) => h.m < ym).slice(-TRAIL);
    const beta = olsSlope(hist.map((h) => h.slEx), hist.map((h) => h.bhEx)), er = equalRisk(hist.map((h) => h.tre), hist.map((h) => h.slEx));
    const book = compose({ tre: leg.tre, tb, sleeve: sl.sleeve }), ctrl = compose({ tre: leg.tre, tb, sleeve: beta * bh + (1 - beta) * tb });
    const prev = navStats(out.months.map((r) => r.book)), ns = navStats([...out.months.map((r) => r.book), book]), last = ns.path[ns.path.length - 1];
    const flags = []; if (leg.source !== "R219") flags.push(leg.source); if (leg.detail.late) flags.push("R219-LATE-EXIT"); if (sl.markMismatch.length) flags.push("R191-MARK-MISMATCH");
    const row = { m: ym, tre: r6(leg.tre), treSource: leg.source, treDetail: leg.detail, sleeve: r6(sl.sleeve), sleeveSource: "R191",
      sleeveDetail: { paperReturn: r6(sl.paperReturn), pnlUSD: +sl.pnlUSD.toFixed(2), outShare: r6(sl.outShare), fillsInMonth: sl.fillsInMonth, markedDays: sl.markedDays, markMismatch: sl.markMismatch, pricing: "positions from R191 fills; every UTC day at the Coinbase daily close (R191's own mark source)" },
      tb: r6(tb), book: r6(book), excess: r6(book - tb), contrib: { treasury: r6(L * leg.tre), tbill: r6((1 - X) * tb), sleeve: r6(X * sl.sleeve) },
      controlB: { beta: r6(beta), betaN: hist.length, betaWindow: [hist[0].m, hist[hist.length - 1].m], bh: r6(bh), value: r6(ctrl), excess: r6(ctrl - tb) },
      model: modelRow(ym, sess, M, tb), nav: r6(last.nav), dd: r6(last.dd), cagrSinceStart: r6(ns.cagr), navBefore: r6(prev.nav),
      erSplit: { L: fin(er.L, 3), x: fin(er.x, 4), rho: fin(er.rho, 3), window: [hist[0].m, hist[hist.length - 1].m], book: r6(er.L * leg.tre + (1 - er.x) * tb + er.x * sl.sleeve), note: "weightless (null when a leg has no variance)" },
      flags, scoredAt: new Date().toISOString() };
    out.months.push(row); wrote++;
    console.log(`R235 scored ${ym}: tre ${pct(row.tre, 3)} [${row.treSource}] · sleeve ${pct(row.sleeve, 2)} (R191 $${row.sleeveDetail.pnlUSD}, out ${pct(row.sleeveDetail.outShare, 0)}) · tb ${pct(tb, 3)} · BOOK ${pct(book, 2)} · control-B ${pct(ctrl, 2)} (beta ${row.controlB.beta}) · model ${pct(row.model.book, 2)} · NAV ${row.nav} · DD ${pct(row.dd, 1)}`);
    if (killed(last.dd)) {
      summarise(out, { stopped: { month: ym, dd: r6(last.dd), at: new Date().toISOString() } }); out.status.placebo = placebo(out.months, M); saveOut(out);
      const msg = `STOPPED ${new Date().toISOString().slice(0, 10)} — INTERIM KILL: month-end book NAV drawdown ${pct(last.dd, 1)} at ${ym} reached the -20% limit (the operator's constraint is breached); components R186/R219/R191 continue under their own registrations`;
      registryUpdate((E) => { E.status = msg; }); governance({ action: "interim-kill", month: ym, drawdown: r6(last.dd), note: msg });
      console.log("\n" + "!".repeat(100) + `\n!!! R235 BOOK-1 ${msg}\n` + "!".repeat(100) + "\n"); return; }
  }
  summarise(out, { waiting: null }); out.status.placebo = placebo(out.months, M); saveOut(out); printStatus(out);
}

// ---- --read (once, after the 36th book month) -------------------------------------------------------------------------------------
async function read() {
  const seals = readJson(F.seals), T = seals.tests || seals; if (T[ID]) return console.error(`${ID} already sealed — refusing`);
  const out = loadOut(), reg = readJson(F.reg), E = [...(reg.tests || []), ...(reg.preregistered || [])].find((x) => x.id === ID), bar = E.bar.tRequired;
  let verdict;
  if (out.status && out.status.stopped) verdict = `STOPPED — interim kill at ${out.status.stopped.month}: book NAV drawdown ${pct(out.status.stopped.dd, 1)} <= -20% (the operator's constraint was breached; no significance verdict)`;
  else {
    if (out.months.length < READ_N) return console.error(`${ID} read condition not met (${out.months.length}/${READ_N} book months; read once after the September 2029 month-end)`);
    const rows = out.months.slice(0, READ_N), ex = rows.map((r) => r.excess), t = tOf(ex), ns = navStats(rows.map((r) => r.book));
    const both = rows.filter((r) => r.treSource !== "MISSING" && r.sleeveSource === "R191").length, fb = rows.filter((r) => r.treSource === "FALLBACK").length;
    const M = {}; for (const c of COINS) M[c] = modelCoin(await coinbaseCloses(c));
    const pl = placebo(rows, M), modelMean = mean(rows.map((r) => r.model.excess)), peekT = tOf(rows.map((r) => r.model.peekExcess)), ctrlMean = mean(rows.map((r) => r.controlB.excess));
    const c = { t: t >= bar, dd: ns.maxDD > KILL, controlB: mean(ex) > ctrlMean, placebo: modelMean > pl.p95 };
    const facts = `t ${t.toFixed(3)} vs ${bar}; maxDD ${pct(ns.maxDD, 1)}; mean excess ${pct(mean(ex), 3)} vs control-B ${pct(ctrlMean, 3)}; model ${pct(modelMean, 3)} vs placebo p95 ${pct(pl.p95, 3)}; CAGR ${pct(ns.cagr, 1)} vs 30%/yr target (not part of the pass); ${both}/36 months both legs sourced, ${fb} FALLBACK${fb > 6 ? " (MORE THAN 6 — disclosed prominently)" : ""}`;
    if (both < 34) verdict = `INVALID — only ${both}/36 months had both legs sourced (need 34); no verdict · ${facts}`;
    else if (!(peekT >= 3)) verdict = `INVALID — peek (winners-only look-ahead) t ${peekT == null ? "n/a" : peekT.toFixed(2)} < 3: the pipeline cannot see an edge that is certainly there; no verdict · ${facts}`;
    else if (Object.values(c).every(Boolean)) verdict = `PASS — ${facts}`;
    else verdict = `DID NOT PASS (${Object.entries(c).filter(([, v]) => !v).map(([k]) => ({ t: "t below bar", dd: "drawdown <= -20%", controlB: "did not beat the beta-matched control", placebo: "model book did not beat placebo p95" })[k]).join("; ")}) — ${facts}`;
  }
  T[ID] = { sealedOn: new Date().toISOString().slice(0, 10), unit: "months", verdict }; writeJsonAtomic(F.seals, seals);
  registryUpdate((X_) => { X_.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; });
  governance({ action: "seal-read", verdict }); console.log(`${ID} READ — ${verdict}`);
}

// ---- --selftest -------------------------------------------------------------------------------------------------------------------
async function selftest() {
  const res = []; const check = (name, ok, detail) => { res.push({ name, ok }); console.log(`${ok === true ? "PASS   " : ok === false ? "FAIL   " : "UNKNOWN"} ${name} — ${detail}`); };
  const reg = readJson(F.reg), E = [...(reg.tests || []), ...(reg.preregistered || [])].find((x) => x.id === ID), BAR = E.bar.tRequired, dt = dtb3Local();
  // 1. known answer on library history
  const lb = library(dt.tbOf), ms = []; for (let m = KNOWN.lo; m <= KNOWN.hi; m = nextYm(m)) ms.push(m);
  const books = ms.map((m) => compose({ tre: lb.tre.get(m), tb: dt.tbOf(m), sleeve: lb.sleeve.get(m) })), ns = navStats(books), cagr = 100 * ns.cagr, mdd = 100 * ns.maxDD;
  const stress = readJson(F.stress, null), srow = stress && stress.stress.find((z) => z.window.startsWith("2018-01") && z.sleeve === "CRYPTO-T50" && z.cryptoWeight === 0.2 && z.sleeveCAGR === "hist" && z.treasury === "as measured");
  check("known answer: library TSY-ZN1X + CRYPTO-T50, 2018-01..2026-08, L=5 x=0.2", Math.abs(cagr - KNOWN.cagrPct) <= KNOWN.tol && Math.abs(mdd - KNOWN.maxDDPct) <= KNOWN.tol,
    `composer CAGR ${cagr.toFixed(2)}% (registered ${KNOWN.cagrPct}%${srow ? `, book-stress json ${srow.cagrPct}%` : ""}), maxDD ${mdd.toFixed(2)}% (registered ${KNOWN.maxDDPct}%${srow ? `, json ${srow.maxDDPct}%` : ""}), ${ms.length} months, tolerance ${KNOWN.tol} pt; library sleeve cash = tb x share of days both coins out`);
  // 2. zero-edge false-positive rate: 1,000 seeded 36-month synthetic books with zero expected excess, composed by the same function
  { const rng = mulberry(2350), nrm = () => { let u = 0; while (!u) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }; let hit = 0;
    for (let p = 0; p < 1000; p++) { const ex = []; for (let i = 0; i < READ_N; i++) { const tb = 0.003, tre = 0.0067 * nrm(), sig = 0.22, sleeve = tb + (Math.exp(sig * nrm() - sig * sig / 2) - 1); ex.push(compose({ tre, tb, sleeve }) - tb); } if (tOf(ex) > BAR) hit++; }
    check("zero-edge false-positive rate (1,000 paths x 36 months, seed 2350; tre N(0,0.67%), sleeve lognormal-zero-mean excess sd~22%)", hit >= 30 && hit <= 70, `${hit}/1000 = ${(hit / 10).toFixed(1)}% exceed the bar ${BAR} (required 3-7%)`); }
  // 3. unit checks on the composer's own pieces
  { const tbX = 0.003, closes = { BTC: new Map(), ETH: new Map() }; closes.BTC.set("2031-02-28", 100); closes.ETH.set("2031-02-28", 50); daysOf("2031-03").forEach((d, k) => { closes.BTC.set(d, 101 + k); closes.ETH.set(d, 50); });
    const st = { orders: [{ cid: "r191-BTC-20310310-buy", side: "buy", qty: 100, px: 110, at: "2031-03-10T21:00:00Z" }], marks: [{ coin: "BTC", d: "2031-03-31", close: 131 }, { coin: "ETH", d: "2031-03-31", close: 50 }], coins: { BTC: {}, ETH: {} } };
    const got = r191Sleeve("2031-03", st, closes, tbX), want = 1.005 ** 21 - 1 + tbX * 41 / 62;
    check("R191 replay: buy 100 BTC at 110 on 03-10, +$100/day for 21 days, ETH never held", Math.abs(got.sleeve - want) < 1e-12 && Math.abs(got.pnlUSD - 2100) < 1e-9 && r191Ready("2031-03", st) === null, `sleeve ${got.sleeve.toFixed(8)} vs ${want.toFixed(8)}, P&L $${got.pnlUSD}, out-share ${got.outShare.toFixed(4)} (41/62)`);
    const a = treasuryLeg("2031-03", { windows: { "2031-03": { entry: { px: 112 }, score: { net: 1115 }, exit: { px: 112.6 } } } }, null), b = treasuryLeg("2031-03", { windows: { "2031-03": { noEntry: "stale quote" } } }, { windows: { "2031-03": { score: { fillToFill: 0.01 } } } });
    const c = treasuryLeg("2031-03", null, null), w = treasuryLeg("2031-03", { windows: { "2031-03": { entry: { px: 112 } } } }, null);
    check("Treasury leg: R219 per-notional / R186 fallback / MISSING / open-window wait", a.source === "R219" && Math.abs(a.tre - 1115 / 224000) < 1e-15 && b.source === "FALLBACK" && Math.abs(b.tre - 0.0079) < 1e-15 && c.source === "MISSING" && c.tre === 0 && w.ok === false,
      `R219 ${a.tre.toFixed(6)}, FALLBACK ${b.tre.toFixed(4)}, MISSING ${c.tre}, open -> "${w.wait}"`);
    const kp = navStats([0.05, -0.1, -0.12]).path, kq = navStats([0.05, -0.1, -0.1]).path;
    check("interim kill trigger at -20% month-end drawdown", killed(kp[2].dd) && !killed(kq[2].dd), `path DD ${pct(kp[2].dd, 2)} -> kill; ${pct(kq[2].dd, 2)} -> no kill`);
    const hist = history([], dt.tbOf).slice(-TRAIL), er = equalRisk(hist.map((h) => h.tre), hist.map((h) => h.slEx)), beta = olsSlope(hist.map((h) => h.slEx), hist.map((h) => h.bhEx));
    check("equal-risk split + control-B beta at the first book month (trailing 36 library months)", er.L > 3 && er.L < 7 && er.x > 0.1 && er.x < 0.35 && beta > 0 && beta < 1.5,
      `ER ${er.L.toFixed(2)}x / ${pct(er.x, 1)} (registry: ~4.7x / ~22%), rho ${er.rho.toFixed(2)}; beta ${beta.toFixed(3)}; window ${hist[0].m}..${hist[hist.length - 1].m} (2026-09 is in neither the library nor the forward book)`); }
  // 4. online: the model sleeve from Coinbase reproduces the library CRYPTO-T50 series; model/peek/placebo pipeline on IEF history
  try {
    const rowsC = {}, M = {}; for (const c of COINS) { rowsC[c] = await coinbaseCloses(c); M[c] = modelCoin(rowsC[c]); }
    const libS = new Map(JSON.parse(fs.readFileSync(path.join(F.lib, "CRYPTO-T50.json"), "utf8")).series.map((x) => [x.d, x.r])); let n = 0, bad = 0, maxd = 0;
    for (let d = "2018-01-01"; d <= "2026-08-31"; d = addDay(d, 1)) { let r = 0; for (const c of COINS) r += 0.5 * coinDay(M[c], M[c].held, M[c].idx.get(d)); const l = libS.get(d) || 0, df = Math.abs(r - l); n++; maxd = Math.max(maxd, df); if (df > 1e-6) bad++; }
    check("model sleeve (Coinbase, composer code) vs library CRYPTO-T50 daily, 2018-01..2026-08", bad / n < 0.005, `${n - bad}/${n} days within 1e-6 (max abs diff ${maxd.toExponential(2)})`);
    const bars = await iefBars(KNOWN.lo, KNOWN.hi), rows = [];
    for (const m of ms) { const s = iefSessions(m, bars); if (!s || s.length < 10) continue; rows.push({ m, tb: dt.tbOf(m), model: modelRow(m, s, M, dt.tbOf(m)) }); }
    const peekT = tOf(rows.map((r) => r.model.peekExcess)), p36 = tOf(rows.slice(-36).map((r) => r.model.peekExcess));
    check("peek control (winners-only look-ahead model book) t >= 3", peekT >= 3 && p36 >= 3, `t ${peekT.toFixed(2)} over ${rows.length} history months; t ${p36.toFixed(2)} over the last 36`);
    const pl = placebo(rows.slice(-36), M), mm = mean(rows.slice(-36).map((r) => r.model.excess)), ns2 = navStats(rows.map((r) => r.model.book));
    console.log(`INFO    model book on history (3.95 x IEF last-5 + model sleeve): CAGR ${pct(ns2.cagr, 2)}, maxDD ${pct(ns2.maxDD, 1)}; last 36 months mean excess ${pct(mm, 3)} vs placebo p95 ${pct(pl.p95, 3)} (median ${pct(pl.median, 3)}) — informational, weightless`);
  } catch (e) { check("online checks (Coinbase candles, Alpaca IEF bars)", null, `could not run: ${e.message}`); }
  const fail = res.filter((r) => r.ok === false).length, unk = res.filter((r) => r.ok == null).length;
  console.log(`\nR235 selftest: ${res.length - fail - unk}/${res.length} PASS${fail ? `, ${fail} FAIL` : ""}${unk ? `, ${unk} UNKNOWN` : ""}`); if (fail) process.exitCode = 1; else if (unk) process.exitCode = 2;
}

(async () => { if (mode === "--run") return run(); if (mode === "--selftest") return selftest(); if (mode === "--read") return read();
  const out = loadOut(); printStatus(out); if (out.status && out.status.waiting) console.log(`  waiting: ${out.status.waiting.month} — ${out.status.waiting.why}`);
})().catch((e) => { console.error("r235 FAILED:", e.message); process.exit(1); });
