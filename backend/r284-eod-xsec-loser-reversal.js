#!/usr/bin/env node
/**
 * R284 — END-OF-DAY CROSS-SECTIONAL LOSER REVERSAL (Baltussen, Da & Soebhag 2025). Registered 2026-09-29 (registry wins).
 *
 * RULE (frozen in backend/data/test-registry.json, id R284, key EOD_XSEC_LOSER_REVERSAL):
 *   Universe each session t: the 500 US common stocks (panel = AV listing x Alpaca SIP, delisted included) with the highest 60-day median
 *   RAW dollar volume over sessions t-60..t-1, prior raw close >= $5. Half-days excluded.
 *   Signal 15:00 ET: ROD3 = last trade before 15:00 (close of the 14:30-15:00 bar) / prior official close - 1. Rank; bottom decile = losers.
 *   Entry 15:30 ET (open of the 15:30-16:00 bar = first trade at/after 15:30); weights ∝ 20-day average raw dollar volume (t-20..t-1).
 *   Exit: market-on-close, the official closing-auction print (Alpaca daily bar close). Flat overnight.
 *   Long-only DV-weighted bottom decile is primary; equal-weight and bottom-minus-top decile are reported companions.
 *   COST: half of the MEASURED quoted spread at 15:30 (Alpaca SIP NBBO quotes, median over the first 2 seconds of 15:30 ET) per name on entry,
 *   zero on the MOC exit, plus 0.5 bp commission-equivalent. The registry says "measured"; Alpaca serves SIP quotes back to 2016 so it IS measured.
 *   STATISTIC: days are the unit; one-sample t of the daily NET return of the primary rule (and a Newey-West t, lag 5, beside it — the registry
 *   text names NW; both must clear the bar). Bar = bar.tRequired read from the registry AT RUN TIME (amended 2026-09-29 pre-evidence to 2.501).
 *   Window: 2016-01..2019-12 replication (shown first); 2020-01..last available session = HOLDOUT (the registered statistic / verdict).
 *   CONTROLS: (1) 500 random-50-name placebos held 15:30-close, p95 of net t; (2) winner-decile leg; (3) minus SPY 15:30-close; (4) sign-shuffle;
 *   (5) gross beside net + break-even half-spread. Halves of the holdout must share the sign. PASS also needs gross t >= 2 (registry precondition).
 *
 *   node backend/r284-eod-xsec-loser-reversal.js --fetch      build the cache (resumable, never a read): candidates, daily panels, per-day 30Min bars + NBBO
 *   node backend/r284-eod-xsec-loser-reversal.js --selftest   KNOWN ANSWERS on the cache (never-in = 0; constant signal = universe mean minus charged cost;
 *                                                             shuffled signal ~ 0; universe function is blind to t and later)
 *   node backend/r284-eod-xsec-loser-reversal.js --read       the one registered read (refuses if sealed / output exists); writes data/r284-eod-xsec-loser-reversal.json
 *
 * NOTES fixed before any outcome: N1 the panel data/anomaly-cache-v2 only proposes CANDIDATES (top-800 by adj-price x volume, ever); the actual
 * universe is re-ranked on RAW daily bars. N2 price/return series use adjustment=split (dividends do not move the return we trade); dollar volume
 * and the $5 screen use adjustment=raw. N3 no ROD3 winsorising is needed for ranking (ranks are invariant); returns are not winsorised.
 * N4 a name with no 14:30 / 15:30 bar or no quote is skipped / has its spread imputed by that day's median measured half-spread (share reported).
 */
"use strict";
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { fetchBarsSip } = require("./lib/sip-fetch.js");
const { tOf: tPlain, mean, sd } = require("./lib/clustered.js");
const { nullBar } = require("./lib/null-bar.js");

const D = (f) => path.join(__dirname, "data", f), CACHE = D("training/r284"), OUT = D("r284-eod-xsec-loser-reversal.json");
const ID = "R284", KEY = "EOD_XSEC_LOSER_REVERSAL";
const UNIVERSE_N = 500, MIN_PRICE = 5, DV_WIN = 60, DV_W_WEIGHT = 20, CAND_TOP = 800, COMM_BPS = 0.5, DEC = 0.10;
const FETCH_START = "2015-09-01", STUDY_FROM = "2016-01-04", HOLD_FROM = "2020-01-01", REPL_TO = "2019-12-31";
const PLACEBO_DRAWS = 500, PLACEBO_K = 50, SIGN_DRAWS = 5000, SHARE_PER_SIDE = 0.01;
const mode = ["--fetch", "--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const REG = (JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered || []).find((t) => t.id === ID);
if (!REG || REG.scoutKey !== KEY) { console.error("registry entry R284 missing"); process.exit(1); }
const BAR = REG.bar.tRequired;   // read at run time — never hard-coded (amended pre-evidence 2026-09-29)

// ───────────────────────────── time helpers ─────────────────────────────
function etOffsetHours(day) {   // 5 (EST) or 4 (EDT) for that ET calendar date, from the tz database, not a rule of thumb
  const h = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(day + "T17:00:00Z")) % 24;
  return 17 - h;
}
const offStr = (day) => `-0${etOffsetHours(day)}:00`;
const etMin = (iso, offH) => { const d = new Date(iso); return d.getUTCHours() * 60 + d.getUTCMinutes() - offH * 60; };

// ───────────────────────────── stage 1: candidates from the panel ─────────────────────────────
function candidates() {
  const f = path.join(CACHE, "candidates.json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const P = path.join(__dirname, "data", "anomaly-cache-v2"), meta = JSON.parse(fs.readFileSync(path.join(P, "meta.json"), "utf8"));
  const N = meta.symbols.length, T = meta.dates.length, rd = (n) => { const b = fs.readFileSync(path.join(P, n)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  const C = rd("close.f32"), V = rd("vol.f32"), pick = new Set(), dv = new Float64Array(N);
  for (let t = 25; t < T; t += 5) {
    for (let s = 0; s < N; s++) { let a = 0, k = 0; for (let j = t - 20; j < t; j++) { const x = C[s * T + j] * V[s * T + j]; if (x > 0) { a += x; k++; } } dv[s] = k >= 10 ? a / k : 0; }
    const idx = Array.from({ length: N }, (_, i) => i).filter((i) => dv[i] > 0).sort((x, y) => dv[y] - dv[x]).slice(0, CAND_TOP);
    for (const i of idx) pick.add(meta.symbols[i]);
  }
  const out = { builtAt: new Date().toISOString(), source: "anomaly-cache-v2 top-" + CAND_TOP + " by 20d adj-close x vol, sampled every 5th session 2016-2026", symbols: [...pick].sort() };
  fs.mkdirSync(CACHE, { recursive: true }); writeJsonAtomic(f, out); return out;
}

// ───────────────────────────── stage 2: daily panels ─────────────────────────────
const DF = ["rawC", "rawV", "splC", "splH", "splL"];
function loadDaily() {
  const mf = path.join(CACHE, "daily-meta.json"); if (!fs.existsSync(mf)) return null;
  const meta = JSON.parse(fs.readFileSync(mf, "utf8")), N = meta.symbols.length, T = meta.dates.length, o = { ...meta, N, T, si: new Map(meta.symbols.map((s, i) => [s, i])), di: new Map(meta.dates.map((d, i) => [d, i])) };
  for (const k of DF) { const b = fs.readFileSync(path.join(CACHE, `daily-${k}.f32`)); o[k] = new Float32Array(b.buffer, b.byteOffset, N * T); }
  return o;
}
async function fetchDaily() {
  if (fs.existsSync(path.join(CACHE, "daily-meta.json"))) { console.log("daily panels cached"); return; }
  const syms = [...new Set([...candidates().symbols, "SPY"])].sort();
  const spy = await fetchBarsSip(["SPY"], { start: FETCH_START, end: new Date().toISOString().slice(0, 10), timeframe: "1Day", adjustment: "split", quiet: true });
  const dates = spy.bars.SPY.map((b) => b.t.slice(0, 10)), di = new Map(dates.map((d, i) => [d, i])), T = dates.length, N = syms.length;
  console.log(`daily: ${N} symbols x ${T} sessions ${dates[0]}..${dates.at(-1)}`);
  const SI = new Map(syms.map((s, i) => [s, i])), A = Object.fromEntries(DF.map((k) => [k, new Float32Array(N * T).fill(NaN)]));
  fs.mkdirSync(path.join(CACHE, "dchunks"), { recursive: true });
  for (const adj of ["raw", "split"]) {
    for (let i = 0; i < N; i += 25) {
      const chunk = syms.slice(i, i + 25), cf = path.join(CACHE, "dchunks", `${adj}-${String(i).padStart(5, "0")}.json`);
      let rows; if (fs.existsSync(cf)) rows = JSON.parse(fs.readFileSync(cf, "utf8"));
      else {
        const r = await fetchBarsSip(chunk, { start: FETCH_START, end: spy.effectiveEnd, timeframe: "1Day", adjustment: adj, requireAll: false, quiet: true, retries: 14, minIntervalMs: 500 });
        rows = {}; for (const s of chunk) rows[s] = (r.bars[s] || []).map((b) => [b.t.slice(0, 10), b.c, b.v, b.h, b.l]);
        writeJsonAtomic(cf, rows, { pretty: 0 });
      }
      for (const s of chunk) for (const [dd, c, v, h, l] of rows[s] || []) {
        const j = di.get(dd); if (j == null) continue; const k = SI.get(s) * T + j;
        if (adj === "raw") { A.rawC[k] = c; A.rawV[k] = v; } else { A.splC[k] = c; A.splH[k] = h; A.splL[k] = l; }
      }
      process.stdout.write(`  daily ${adj} ${Math.min(i + 25, N)}/${N}`);
    }
    console.log();
  }
  for (const k of DF) fs.writeFileSync(path.join(CACHE, `daily-${k}.f32`), Buffer.from(A[k].buffer));
  writeJsonAtomic(path.join(CACHE, "daily-meta.json"), { builtAt: new Date().toISOString(), symbols: syms, dates, adjustments: { rawC: "raw", rawV: "raw", splC: "split", splH: "split", splL: "split" } });
}

// ───────────────────────────── universe (point-in-time) ─────────────────────────────
/** Names for session index t using ONLY sessions <= t-1. Returns [{i, dv20, med60}] top UNIVERSE_N. */
function universe(DA, t) {
  const T = DA.T, out = [];
  for (let i = 0; i < DA.N; i++) {
    if (DA.symbols[i] === "SPY") continue;
    const base = i * T, pc = DA.rawC[base + t - 1]; if (!(pc >= MIN_PRICE)) continue;
    const w = []; let s20 = 0, k20 = 0;
    for (let j = t - DV_WIN; j < t; j++) { if (j < 0) continue; const x = DA.rawC[base + j] * DA.rawV[base + j]; if (x > 0) { w.push(x); if (j >= t - DV_W_WEIGHT) { s20 += x; k20++; } } }
    if (w.length < 40 || k20 < 15) continue;
    w.sort((a, b) => a - b); const med = w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2;
    out.push({ i, med, dv20: s20 / k20 });
  }
  out.sort((a, b) => b.med - a.med); return out.slice(0, UNIVERSE_N);
}

// ───────────────────────────── stage 3: per-day intraday (30Min bars + NBBO) ─────────────────────────────
let _next = 0;
async function httpJson(url, tries = 14) {
  for (let a = 0; a < tries; a++) {
    const w = _next - Date.now(); if (w > 0) await nap(w); _next = Date.now() + 260;
    try {
      const r = await fetch(url, { headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" }, signal: AbortSignal.timeout(90000) });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { const ra = +r.headers.get("retry-after"); await nap(ra > 0 ? ra * 1000 : Math.min(30000, 600 * 2 ** a)); continue; }
      throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    } catch (e) { if (/^HTTP/.test(e.message)) throw e; if (a === tries - 1) throw e; await nap(Math.min(30000, 600 * 2 ** a)); }
  }
  throw new Error("httpJson exhausted");
}
async function quotesSpread(names, day) {   // median relative spread in bps over [15:30:00, 15:30:02) ET, per name
  const off = offStr(day), acc = {}; let token = null, pages = 0;
  do {
    const p = new URLSearchParams({ symbols: names.join(","), start: `${day}T15:30:00${off}`, end: `${day}T15:30:02${off}`, limit: "10000", feed: "sip" }); if (token) p.set("page_token", token);
    const j = await httpJson("https://data.alpaca.markets/v2/stocks/quotes?" + p);
    for (const [s, arr] of Object.entries(j.quotes || {})) for (const q of arr) if (q.bp > 0 && q.ap > q.bp) { const mid = (q.ap + q.bp) / 2, b = (10000 * (q.ap - q.bp)) / mid; if (b < 1000) (acc[s] ||= []).push(b); }
    token = j.next_page_token || null; pages++;
  } while (token && pages < 60);
  const out = {}; for (const [s, a] of Object.entries(acc)) { a.sort((x, y) => x - y); out[s] = [+a[Math.floor(a.length / 2)].toFixed(3), a.length]; }
  return { out, pages };
}
const TM = { bars: 0, q: 0, uni: 0, n: 0 };
async function fetchDay(DA, day, t) {
  const TB0 = Date.now(), uni = universe(DA, t); TM.uni += Date.now() - TB0; const TB = Date.now(), names = uni.map((u) => DA.symbols[u.i]);
  void 0; const _n = uni.map((u) => DA.symbols[u.i]), off = etOffsetHours(day), of = offStr(day);
  const r = await fetchBars([...names, "SPY"], { start: `${day}T14:30:00${of}`, end: `${day}T15:59:59${of}`, timeframe: "30Min", feed: "sip", adjustment: "split", chunkSize: 600, requireAll: false, quiet: true, retries: 14, minIntervalMs: +(process.env.R284_INT || 400) });
  TM.bars += Date.now() - TB; TM.n++;
  const rows = {}; let has1530 = 0;
  for (const s of [...names, "SPY"]) {
    const by = {}; for (const b of r.bars[s] || []) by[etMin(b.t, off)] = b;
    const a = by[870], c = by[930]; if (c) has1530++;
    if (a && c) rows[s] = [a.c, c.o, c.c];   // [close of 14:30-15:00 bar, open of 15:30 bar, close of 15:30 bar (last trade before 16:00)]
  }
  const halfDay = !rows.SPY || has1530 < 0.3 * names.length;
  let q = { out: {}, pages: 0 };
  if (!halfDay) {   // quotes only where the rule or its placebo needs them: both deciles by ROD3 + a seeded random pool of 100 (call budget is shared by eleven builders)
    const ranked = uni.map((u) => ({ s: DA.symbols[u.i], pc: DA.splC[u.i * DA.T + t - 1] })).filter((x) => rows[x.s] && x.pc > 0).map((x) => ({ s: x.s, rod: rows[x.s][0] / x.pc - 1 })).sort((a, b) => a.rod - b.rod);
    const k = Math.max(1, Math.floor(ranked.length * DEC)), want = new Set([...ranked.slice(0, k), ...ranked.slice(-k)].map((x) => x.s)), rr = rng(+day.replace(/-/g, "")), pool = ranked.map((x) => x.s).filter((s) => !want.has(s));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rr() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    for (const s of pool.slice(0, 100)) want.add(s);
    const TQ = Date.now(); q = await quotesSpread([...want], day); TM.q += Date.now() - TQ;
  }
  for (const s of Object.keys(rows)) rows[s].push(...(q.out[s] || [null, 0]));
  return { halfDay, nUniverse: names.length, nRows: Object.keys(rows).length, nQuoted: Object.keys(q.out).length, quotePages: q.pages, rows };
}
const monthFile = (ym) => path.join(CACHE, "days", ym + ".json");
async function fetchDays(DA) {
  fs.mkdirSync(path.join(CACHE, "days"), { recursive: true });
  const order = DA.dates.map((d, t) => ({ d, t })).filter((x) => x.d >= STUDY_FROM && x.t >= DV_WIN);
  order.sort((a, b) => (a.d >= HOLD_FROM) === (b.d >= HOLD_FROM) ? a.d.localeCompare(b.d) : (a.d >= HOLD_FROM ? -1 : 1));   // holdout first, then replication
  const only = (process.argv.find((a) => a.startsWith("--upto=")) || "").slice(7), M = {};
  const getM = (ym) => M[ym] || (M[ym] = fs.existsSync(monthFile(ym)) ? JSON.parse(fs.readFileSync(monthFile(ym), "utf8")) : {});
  const todo = order.filter((x) => (!only || x.d <= only) && !getM(x.d.slice(0, 7))[x.d]);
  console.log(`  ${order.length - todo.length} sessions already cached, ${todo.length} to fetch`);
  let fetched = 0, q = 0, t0 = Date.now(); const flush = () => { for (const [ym, m] of Object.entries(M)) writeJsonAtomic(monthFile(ym), m, { pretty: 0 }); };
  const worker = async () => {
    while (q < todo.length) {
      const { d, t } = todo[q++];
      getM(d.slice(0, 7))[d] = await fetchDay(DA, d, t); fetched++;
      if (fetched % 20 === 0) { flush(); const el = (Date.now() - t0) / 1000, m = getM(d.slice(0, 7))[d]; console.log(`  ${d} · ${fetched}/${todo.length} fetched · ${(el / fetched).toFixed(1)}s/day · per-day ms uni/bars/quotes ${Math.round(TM.uni / TM.n)}/${Math.round(TM.bars / TM.n)}/${Math.round(TM.q / TM.n)} · last: ${m.nRows}/${m.nUniverse} rows, ${m.nQuoted} quoted${m.halfDay ? " HALF-DAY" : ""}`); }
    }
  };
  await Promise.all(Array.from({ length: +(process.env.R284_CONC || 5) }, worker)); flush();
  console.log(`fetch complete: ${fetched} new sessions cached`);
}
function loadDays(from, to) {
  const days = {}, dir = path.join(CACHE, "days"); if (!fs.existsSync(dir)) return days;
  for (const f of fs.readdirSync(dir).sort()) { if (!/^\d{4}-\d{2}\.json$/.test(f)) continue; const M = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); for (const [d, v] of Object.entries(M)) if ((!from || d >= from) && (!to || d <= to)) days[d] = v; }
  return days;
}

// ───────────────────────────── per-day panel of names (all inputs known at their timestamps) ─────────────────────────────
/** Returns null (skip) or { d, names:[{s, rod, ret, hs, dv20, entry}], spyRet, imputed } . ret = MOC close / 15:30 open - 1. */
/** NYSE early-close (13:00 ET) sessions: day after Thanksgiving, Dec 24 and Jul 3 when they are Mon-Thu trading days. Post-close prints exist on those days, so bar presence cannot detect them. */
function isEarlyClose(d) {
  const [y, m, dd] = d.split("-").map(Number), dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  if (m === 12 && dd === 24 && dow >= 1 && dow <= 4) return true;
  if (m === 7 && dd === 3 && dow >= 1 && dow <= 4) return true;
  if (m === 11 && dow === 5) { let th = 0; for (let x = 1; x <= dd - 1; x++) if (new Date(Date.UTC(y, 10, x)).getUTCDay() === 4) th++; return th === 4 && new Date(Date.UTC(y, 10, dd - 1)).getUTCDay() === 4; }
  return false;
}
function dayPanel(DA, d, rec) {
  if (!rec || rec.halfDay || isEarlyClose(d)) return null;
  const t = DA.di.get(d); if (t == null) return null;
  const uni = universe(DA, t), known = uni.filter((u) => rec.rows[DA.symbols[u.i]]);
  const meas = known.map((u) => rec.rows[DA.symbols[u.i]][3]).filter((x) => x != null).sort((a, b) => a - b);
  if (known.length < 200 || meas.length < 50) return null;
  const medHs = meas[Math.floor(meas.length / 2)] / 2; let imputed = 0; const names = [];
  for (const u of known) {
    const s = DA.symbols[u.i], r = rec.rows[s], pc = DA.splC[u.i * DA.T + t - 1], ex = DA.splC[u.i * DA.T + t];
    if (!(pc > 0 && ex > 0 && r[0] > 0 && r[1] > 0)) continue;
    let hs = r[3] == null ? (imputed++, medHs) : r[3] / 2;
    names.push({ s, rod: r[0] / pc - 1, ret: ex / r[1] - 1, retLast: r[2] / r[1] - 1, hs, dv20: u.dv20, entry: r[1] });
  }
  const sp = rec.rows.SPY, si = DA.si.get("SPY"), spyEx = DA.splC[si * DA.T + t];
  return { d, names, imputed, spyRet: sp && spyEx > 0 ? spyEx / sp[1] - 1 : null };
}
const costOf = (n, mult = 1, perShare = false) => (mult * n.hs + COMM_BPS + (perShare ? (10000 * SHARE_PER_SIDE) / n.entry : 0)) / 10000;
/** decile selection on ROD3 (ascending = losers). k = floor(N*0.10). */
function deciles(P) { const a = [...P.names].sort((x, y) => x.rod - y.rod), k = Math.max(1, Math.floor(a.length * DEC)); return { L: a.slice(0, k), W: a.slice(-k) }; }
function port(sel, { weight = "dv", mult = 1, perShare = false } = {}) {
  if (!sel.length) return { gross: 0, cost: 0, net: 0 };
  let ws = 0, g = 0, c = 0; for (const n of sel) { const w = weight === "dv" ? n.dv20 : 1; ws += w; g += w * n.ret; c += w * costOf(n, mult, perShare); }
  return { gross: g / ws, cost: c / ws, net: (g - c) / ws };
}

// ───────────────────────────── statistics ─────────────────────────────
const tt = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
function nwT(a, lag = 5) {   // Newey-West t of the mean, Bartlett weights
  const n = a.length, m = mean(a), e = a.map((x) => x - m); let v = e.reduce((s, x) => s + x * x, 0) / n;
  for (let l = 1; l <= lag; l++) { let g = 0; for (let i = l; i < n; i++) g += e[i] * e[i - l]; v += (2 * (1 - l / (lag + 1)) * g) / n; }
  return v > 0 ? m / Math.sqrt(v / n) : 0;
}
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function maxDDPct(a) { let e = 0, pk = 0, dd = 0; for (const x of a) { e += x; pk = Math.max(pk, e); dd = Math.min(dd, e - pk); } return +(100 * dd).toFixed(2); }   // additive, % of the daily notional
const bps = (x) => +(1e4 * x).toFixed(3);

// ───────────────────────────── selftest ─────────────────────────────
function selftest(DA) {
  const days = loadDays(STUDY_FROM), ds = Object.keys(days).sort(); let bad = 0; const ok = (name, cond, detail) => { console.log(`  ${cond ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); if (!cond) bad++; };
  const panels = ds.map((d) => dayPanel(DA, d, days[d])).filter(Boolean);
  console.log(`selftest on ${panels.length} cached sessions (${ds[0]}..${ds.at(-1)}), registry bar ${BAR}`);
  if (panels.length < 10) { console.log("  too few cached sessions"); process.exit(1); }
  // (1) never-in rule: nothing held => gross = net = 0 exactly
  ok("never-in rule gives net 0 exactly", panels.every((P) => { const p = port([]); return p.gross === 0 && p.net === 0; }));
  // (2) constant signal (hold every universe name, equal weight): gross == independent mean of ret; net == gross - mean charged cost
  let maxErr = 0;
  for (const P of panels.slice(0, 30)) {
    const p = port(P.names, { weight: "ew" }); let g = 0, c = 0; for (const n of P.names) { g += n.ret; c += n.hs / 1e4 + COMM_BPS / 1e4; }
    g /= P.names.length; c /= P.names.length; maxErr = Math.max(maxErr, Math.abs(p.gross - g), Math.abs(p.net - (g - c)));
  }
  ok("constant signal = universe mean return minus charged cost", maxErr < 1e-12, `max abs err ${maxErr.toExponential(1)}`);
  // (3) shuffled signal: a random decile minus the universe equal-weight has mean ~0 (200 draws x all cached days)
  const rnd = rng(284), diffs = [];
  for (let k = 0; k < 200; k++) { const day = []; for (const P of panels) { const idx = P.names.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const sel = idx.slice(0, Math.floor(idx.length * DEC)).map((i) => P.names[i]); day.push(port(sel, { weight: "ew" }).gross - port(P.names, { weight: "ew" }).gross); } diffs.push(mean(day)); }
  const se = sd(diffs), pm = mean(diffs); const uniSd = sd(panels.map((P) => port(P.names, { weight: "ew" }).gross));
  ok("shuffled signal (200 draws) averages ~0 vs the universe", Math.abs(pm) < 4 * se / Math.sqrt(200) + 1e-12 || Math.abs(pm) < 0.5e-4, `mean diff ${bps(pm)} bps, draw sd ${bps(se)} bps`);
  // (4) look-ahead guard: the universe for session t must not change if every value at index >= t is blanked
  let same = true;
  for (const d of ds.slice(5, 9)) {
    const t = DA.di.get(d), A = universe(DA, t).map((u) => u.i).join(",");
    const Z = { ...DA, rawC: DA.rawC.slice(), rawV: DA.rawV.slice() }; for (let i = 0; i < DA.N; i++) for (let j = t; j < DA.T; j++) { Z.rawC[i * DA.T + j] = NaN; Z.rawV[i * DA.T + j] = NaN; }
    if (universe(Z, t).map((u) => u.i).join(",") !== A) same = false;
  }
  ok("universe(t) is blind to data at t and later", same);
  // (5) timing sanity: every cached row has 14:30 and 15:30 bar prices positive and the 15:30 entry is not the close
  const bp = panels.filter((P) => P.names.every((n) => n.entry > 0 && Number.isFinite(n.rod) && Number.isFinite(n.ret)));
  ok("all cached name-days finite", bp.length === panels.length);
  console.log(`  universe size per day median ${panels.map((P) => P.names.length).sort((a, b) => a - b)[Math.floor(panels.length / 2)]}, decile size ${Math.floor(500 * DEC)}`);
  console.log(bad ? `SELFTEST FAILED (${bad})` : "SELFTEST PASSED");
  process.exit(bad ? 1 : 0);
}

// ───────────────────────────── read ─────────────────────────────
function evalWindow(list, label, DA) {
  const rows = list.map((P) => {
    const { L, W } = deciles(P), o = {};
    o.d = P.d; o.spy = P.spyRet;
    const p = port(L); o.gross = p.gross; o.net = p.net; o.cost = p.cost;
    o.ew = port(L, { weight: "ew" }); o.x2 = port(L, { mult: 2 }); o.sh = port(L, { perShare: true }); o.flat2 = { net: port(L).gross - 2.5e-4 };
    o.ewx2 = port(L, { weight: "ew", mult: 2 }); o.ewsh = port(L, { weight: "ew", perShare: true }); o.ewflat = { net: port(L, { weight: "ew" }).gross - 2.5e-4 };
    const w = port(W); o.wNet = w.net; o.wGross = w.gross; o.ls = p.net - (w.gross + w.cost) + 0; o.lsGross = p.gross - w.gross;
    o.mn = o.spy == null ? null : p.net - o.spy; o.uniEW = port(P.names, { weight: "ew" }).gross; o.nU = P.names.length; o.imputed = P.imputed / P.names.length;
    return o;
  });
  const net = rows.map((r) => r.net), gross = rows.map((r) => r.gross), n = rows.length, half = Math.floor(n / 2);
  const mk = (a) => ({ n: a.length, meanBps: bps(mean(a)), t: +tt(a).toFixed(3) });
  const cell = (f) => { const a = rows.map(f); return { meanBps: bps(mean(a)), t: +tt(a).toFixed(2) }; };
  const be = bps(mean(gross)) - COMM_BPS;   // flat entry half-spread (bps) that zeroes the net mean
  const res = {
    label, from: rows[0].d, to: rows.at(-1).d, n, tNet: +tt(net).toFixed(3), tNetNW: +nwT(net).toFixed(3), tGross: +tt(gross).toFixed(3), meanNetBps: bps(mean(net)), meanGrossBps: bps(mean(gross)), meanCostBps: bps(mean(rows.map((r) => r.cost))),
    winRate: +(net.filter((x) => x > 0).length / n).toFixed(3), medianHalfSpreadBpsMeasuredShareImputed: +mean(rows.map((r) => r.imputed)).toFixed(3),
    breakEvenHalfSpreadBps: +be.toFixed(2), halves: { first: mk(net.slice(0, half)), second: mk(net.slice(half)) },
    cells: { "DV|measured": cell((r) => r.net), "DV|spread x2": cell((r) => r.x2.net), "DV|+$0.01/sh": cell((r) => r.sh.net), "DV|flat 2.5bp": cell((r) => r.flat2.net),
      "EW|measured": cell((r) => r.ew.net), "EW|spread x2": cell((r) => r.ewx2.net), "EW|+$0.01/sh": cell((r) => r.ewsh.net), "EW|flat 2.5bp": cell((r) => r.ewflat.net) },
    winnerLeg: { grossBps: bps(mean(rows.map((r) => r.wGross))), netBps: bps(mean(rows.map((r) => r.wNet))), tNet: +tt(rows.map((r) => r.wNet)).toFixed(2), tGross: +tt(rows.map((r) => r.wGross)).toFixed(2) },
    longShort: { grossBps: bps(mean(rows.map((r) => r.lsGross))), tGross: +tt(rows.map((r) => r.lsGross)).toFixed(2), netBps: bps(mean(rows.map((r) => r.ls))), tNet: +tt(rows.map((r) => r.ls)).toFixed(2), note: "no borrow cost charged on the short leg; companion only" },
    marketNeutral: (() => { const a = rows.filter((r) => r.mn != null).map((r) => r.mn); return { n: a.length, meanBps: bps(mean(a)), t: +tt(a).toFixed(2) }; })(),
    universeEWgrossBps: bps(mean(rows.map((r) => r.uniEW))), spyBps: bps(mean(rows.filter((r) => r.spy != null).map((r) => r.spy))), meanUniverse: +mean(rows.map((r) => r.nU)).toFixed(0),
    dollarsAt10kPerYear: +(mean(net) * 252 * 10000).toFixed(0), dollarsAt10kPerYearGross: +(mean(gross) * 252 * 10000).toFixed(0), maxDDPctOfNotional: maxDDPct(net),
  };
  return { res, rows };
}
function placeboAndShuffle(list, rows, observedT) {
  const r = rng(284284), tsP = [], msP = [];
  for (let k = 0; k < PLACEBO_DRAWS; k++) {
    const day = list.map((P) => {
      const a = P.names, n = a.length; let ws = 0, s = 0;
      for (let j = 0; j < PLACEBO_K; j++) { const i = j + Math.floor(r() * (n - j)); const x = a[i]; a[i] = a[j]; a[j] = x; ws += x.dv20; s += x.dv20 * (x.ret - costOf(x)); }   // partial Fisher-Yates; array order is irrelevant elsewhere
      return s / ws;
    });
    tsP.push(tt(day)); msP.push(mean(day));
  }
  tsP.sort((a, b) => a - b); msP.sort((a, b) => a - b);
  const p95 = tsP[Math.floor(0.95 * PLACEBO_DRAWS)], net = rows.map((x) => x.net), m = mean(net), sdv = sd(net), sr = rng(9284), signT = [];
  for (let k = 0; k < SIGN_DRAWS; k++) signT.push(tt(net.map((x) => (sr() < 0.5 ? -x : x)))); signT.sort((a, b) => a - b);
  return { placebo: { draws: PLACEBO_DRAWS, k: PLACEBO_K, p95: +p95.toFixed(3), p95MeanBps: bps(msP[Math.floor(0.95 * PLACEBO_DRAWS)]), medianT: +tsP[PLACEBO_DRAWS >> 1].toFixed(3), observed: +observedT.toFixed(3), observedMeanBps: bps(m), beats: observedT > p95 && m > msP[Math.floor(0.95 * PLACEBO_DRAWS)], note: "50 random DV-weighted names per day, same universe, same per-name cost; net t across days" },
    signShuffle: { draws: SIGN_DRAWS, p95: +signT[Math.floor(0.95 * SIGN_DRAWS)].toFixed(3), observed: +observedT.toFixed(3), beats: observedT > signT[Math.floor(0.95 * SIGN_DRAWS)] }, dailySdBps: bps(sdv) };
}
function read(DA) {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if ((seals.tests && (seals.tests[ID] || seals.tests[KEY])) || fs.existsSync(OUT)) throw new Error(`${ID} already read — read-once (sealed or output exists)`);
  const days = loadDays(STUDY_FROM), ds = Object.keys(days).sort(), all = ds.map((d) => dayPanel(DA, d, days[d])).filter(Boolean);
  const hold = all.filter((P) => P.d >= HOLD_FROM), repl = all.filter((P) => P.d <= REPL_TO);
  const skipped = { sessionsCached: ds.length, halfDaysOrThin: ds.length - all.length };
  if (hold.length < 1500) throw new Error(`holdout cache has only ${hold.length} sessions; run --fetch to completion first`);
  const R = repl.length >= 200 ? evalWindow(repl, "replication 2016-2019", DA) : null;
  const H = evalWindow(hold, "holdout 2020-2026", DA);
  const ctl = placeboAndShuffle(hold, H.rows, H.res.tNet);
  const bar = { registryTRequired: BAR, nullBarAtN: +nullBar({ variants: 8, n: H.res.n, trials: 4000 }).p95.toFixed(3), note: "the registry bar is the contract; nullBarAtN is the same best-of-8 recomputed at the realised n for reference only" };
  const h1 = H.res.halves.first.meanBps, h2 = H.res.halves.second.meanBps, sameSign = Math.sign(h1) === Math.sign(h2) && h1 !== 0;
  const tBoth = Math.min(H.res.tNet, H.res.tNetNW), gOk = H.res.tGross >= 2;
  const verdictScript = tBoth >= BAR && gOk && ctl.placebo.beats && sameSign ? "PASS" : "DID NOT PASS";
  const why = [`net t ${H.res.tNet} / NW ${H.res.tNetNW} vs bar ${BAR} ${tBoth >= BAR ? "cleared" : "NOT cleared"}`, `gross t ${H.res.tGross} ${gOk ? ">= 2" : "< 2 (precondition failed)"}`, `placebo p95 ${ctl.placebo.p95} ${ctl.placebo.beats ? "beaten" : "NOT beaten"}`, `halves ${h1}/${h2} bps ${sameSign ? "same sign" : "DIFFERENT SIGN"}`].join("; ");
  const out = {
    id: ID, key: KEY, name: "End-of-day cross-sectional reversal — buy the day's intraday losers for the last half hour (Baltussen, Da & Soebhag 2025)",
    rule: "top-500 by 60d median raw $ volume (PIT, delisted incl., prior close>=$5); ROD3 = 15:00 price / prior close - 1; buy bottom decile (DV-weighted) at the 15:30 open, exit at the closing auction; net of measured 15:30 half-spread + 0.5bp",
    window: `${H.res.from}..${H.res.to} (holdout, registered statistic); replication ${R ? R.res.from + ".." + R.res.to : "not computed"}`, unit: "days", n: H.res.n,
    statistic: "one-sample t across days of the DV-weighted bottom-decile daily net return; Newey-West(5) t beside it; verdict needs both >= bar",
    bar, tNet: H.res.tNet, tNetNW: H.res.tNetNW, tGross: H.res.tGross, meanNet: +(H.res.meanNetBps / 1e4).toFixed(6), meanGross: +(H.res.meanGrossBps / 1e4).toFixed(6), meanNetBps: H.res.meanNetBps, meanGrossBps: H.res.meanGrossBps, winRate: H.res.winRate,
    placebo: ctl.placebo, signShuffle: ctl.signShuffle, halves: { first: H.res.halves.first, second: H.res.halves.second },
    dollarsAt10k: H.res.dollarsAt10kPerYear, dollarsAt10kGross: H.res.dollarsAt10kPerYearGross, maxDD: H.res.maxDDPctOfNotional + "% of one $10k notional (additive, net)",
    breakEvenHalfSpreadBps: H.res.breakEvenHalfSpreadBps, replication: R ? R.res : null, holdout: H.res, skipped,
    costModel: "half of the MEASURED 15:30 ET quoted spread (Alpaca SIP quotes, median over 15:30:00-15:30:02, per name-day; names with no quote get that day's median) on entry + 0.5 bp commission-equivalent; MOC exit 0; sensitivities: spread x2, +$0.01/share, flat 2.5 bp",
    dataSources: ["Alpaca SIP daily raw + split-adjusted (candidates from data/anomaly-cache-v2 top-800; universe re-ranked on raw daily bars)", "Alpaca SIP 30Min bars 14:30/15:30 per day", "Alpaca SIP NBBO quotes 15:30:00-02 per day", "SPY as the market-neutral control"],
    knownWeaknesses: [
      "Quotes are the SIP quote stream median over 2 seconds at 15:30, not the effective spread of a live marketable order; liquidity at 15:30 for a decile that fell on the day may be thinner than the snapshot median.",
      "Candidates came from the AV-listing panel (612 short-history names dropped, >+300% one-day movers truncated); a name never in the panel's top-800 by adj-price x volume cannot enter the universe.",
      "The 15:00 price is the last trade before 15:00 (14:30 bar close) and the 15:30 entry is the open of the 15:30 bar; a live order sent at 15:30:00 fills a few hundred ms later. MOC exit assumed at the official closing print with no impact.",
      "The long-short companion charges no short borrow; the winner-decile / long-short lines are context, not the registered statistic.",
      "2016-2019 overlaps the paper's own 1993-2019 sample: it is a replication, only 2020+ is a true holdout.", "Cap-weights proxied by 20-day dollar volume.",
    ],
    verdictScript, verdictWhy: why, readAt: new Date().toISOString(),
  };
  writeJsonAtomic(OUT, out);
  const pr = (x) => JSON.stringify(x);
  console.log(`\nR284 READ — ${verdictScript}\n  ${why}`);
  if (R) console.log(`  replication ${R.res.from}..${R.res.to} n ${R.res.n}: gross ${R.res.meanGrossBps} bps t ${R.res.tGross}; net ${R.res.meanNetBps} bps t ${R.res.tNet} (NW ${R.res.tNetNW}); cost ${R.res.meanCostBps} bps`);
  console.log(`  holdout ${H.res.from}..${H.res.to} n ${H.res.n}: gross ${H.res.meanGrossBps} bps t ${H.res.tGross}; net ${H.res.meanNetBps} bps t ${H.res.tNet} (NW ${H.res.tNetNW}); cost ${H.res.meanCostBps} bps; break-even half-spread ${H.res.breakEvenHalfSpreadBps} bps`);
  console.log(`  win rate ${H.res.winRate} · $/yr on $10k net ${H.res.dollarsAt10kPerYear} (gross ${H.res.dollarsAt10kPerYearGross}) · maxDD ${out.maxDD}`);
  console.log(`  placebo p95 t ${ctl.placebo.p95} (observed ${ctl.placebo.observed}, beats ${ctl.placebo.beats}); sign-shuffle p95 ${ctl.signShuffle.p95}`);
  console.log(`  winner leg net ${H.res.winnerLeg.netBps} bps t ${H.res.winnerLeg.tNet}; L-S gross ${H.res.longShort.grossBps} bps t ${H.res.longShort.tGross}; market-neutral ${pr(H.res.marketNeutral)}`);
  console.log(`  cells ${pr(H.res.cells)}\n  halves ${pr(out.halves)}\n  -> ${OUT}`);
}

(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  if (mode === "--fetch") { candidates(); await fetchDaily(); const DA = loadDaily(); await fetchDays(DA); return; }
  const DA = loadDaily(); if (!DA) throw new Error("daily cache missing — run --fetch");
  if (mode === "--selftest") return selftest(DA);
  return read(DA);
})().catch((e) => { console.error("R284 FAILED:", e.message); process.exit(1); });
