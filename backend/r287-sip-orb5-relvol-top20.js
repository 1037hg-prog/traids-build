#!/usr/bin/env node
/**
 * R287 — SIP_ORB5_RELVOL_TOP20: Stocks-in-Play 5-minute opening-range breakout (Zarattini, Barbon & Aziz 2024),
 * sealed 2024-01-02..2026-09-28 holdout, one read. Registered 2026-09-29 (registry entry R287 wins; nothing here improves it).
 *
 * RULE (registry text, implemented as written):
 *   Universe per day (all known by 09:35:00): US common stocks (delisted included; anomaly-cache-v2 point-in-time panel),
 *   (a) 09:30 open > $5, (b) 14-session average daily volume >= 1,000,000 shares, (c) 14-session ATR > $0.50.
 *   RVol = volume of the 09:30-09:35 ET bar / mean 09:30-09:35 volume of the prior 14 sessions. Keep RVol >= 1.0, take the
 *   TOP 20 by RVol. Direction = sign(close-open) of that bar (doji = no trade). Entry at the open of the 09:35 1-minute bar.
 *   Stop = 10% of ATR14 from entry. No target. Exit market-on-close (close of the last RTH 1-minute bar). One trade per name
 *   per day, no overnight. Sizing: 1% NAV at risk at the stop, subject to 4x gross leverage (positions scaled pro rata).
 *   Statistic: daily net return on NAV (NAV = 1 every day, non-compounding); one-sample t over DAYS. Bar = registry bar.tRequired.
 *
 *   node backend/r287-sip-orb5-relvol-top20.js --selftest   engine known answers + 2019/2023 replication of the paper's gross sign
 *   node backend/r287-sip-orb5-relvol-top20.js --read       the ONE registered holdout read (refuses if selftest not passed / already read)
 *
 * NOTES (fixed before any outcome):
 *  N1 COST (primary): $0.01/share per side + half a spread per side, spread proxy = the (high-low) of the 1-minute bar the order fills in
 *     (entry: the 09:35 bar; stop: the bar that stops; MOC: the last bar). This is an OVERESTIMATE of a quoted spread (registry buildNotes
 *     specify the bar-range proxy). Sensitivity reported: gross (0), primary, 2x primary, and a 2 bps-half-spread + $0.01 variant.
 *  N2 Stop fills: stop-market; if a later bar opens beyond the stop the fill is that open. Entry bar itself can stop out (entry is at its open).
 *  N3 Sizing: notional_i = 1%/stopFrac_i (NAV multiples); if the sum exceeds 4x, all positions are scaled by 4/sum.
 *  N4 Prices/volumes are RAW (as traded). Name-days within 15 sessions of a split (raw close ratio vs panel close ratio differ > 10%) are skipped.
 *  N5 Panel excludes class-share/preferred tickers with '-' or '.' (e.g. BRK.B) and 612 too-short names; disclosed in knownWeaknesses.
 *  N6 Universe pre-screen: daily filters use only sessions before the day (ADV14, ATR14); the first-5-minute bars are fetched for a loose
 *     superset (ADV14>=500k, prior close>=3, OR true on any of the next 14 sessions so that RVol denominators exist), then the strict rule applies.
 *  N7 Control (falsifier): 20 names drawn at random (seeded) from RVol<1 with a non-doji bar, same rule.
 *  N8 Placebo: 1,000 within-day permutations of the direction labels among the day's 20 names (preserves each day's long/short count),
 *     compared with the observed mean daily net return; plus a coin-flip direction variant reported beside it.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBars: fetchBarsRaw } = require("./lib/alpaca-bars.js");
// eleven builders share one Alpaca key: on a 429/5xx/network failure the lib gives up after 4 retries, so back off and retry here (never returns partial data)
async function fetchBars(syms, opts) { for (let a = 0; ; a++) { try { return await fetchBarsRaw(syms, opts); } catch (e) { if (!/429|5dd|failed after/.test(e.message) || a >= 40) throw e; const w = Math.min(120000, 15000 * (a + 1)); console.error(`  [r287] ${e.message.slice(0, 60)} - waiting ${w / 1000}s (attempt ${a + 1})`); await new Promise((r) => setTimeout(r, w)); } } }
const { tOf: tPlain } = require("./lib/clustered.js");

const D = (...f) => path.join(__dirname, "data", ...f);
const TR = D("training", "r287"), OUT = D("r287-sip-orb5-relvol-top20.json"), SELFTEST_OUT = D("r287-selftest.json");
const ID = "R287", KEY = "SIP_ORB5_RELVOL_TOP20";
const HOLDOUT = { from: "2024-01-02", to: "2026-09-28" };
const KNOWN = [{ from: "2019-01-02", to: "2019-12-31" }, { from: "2023-01-03", to: "2023-12-29" }];
const MIN_PRICE = 5, MIN_ADV = 1e6, MIN_ATR = 0.5, LOOK = 14, TOPN = 20, STOP_ATR = 0.10, RISK = 0.01, LEV = 4, SHARE_FEE = 0.01, TWO_BPS = 0.0002;
const LOOSE_ADV = 5e5, LOOSE_PX = 3, DRAWS = 1000, CHUNK = 400;
const mode = ["--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
function nwT(a, L = 5) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return v > 0 ? m / Math.sqrt(v / n) : 0; }
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- calendar / time ----------
function nthSunday(y, m, n) { const d = new Date(Date.UTC(y, m - 1, 1)); const first = (7 - d.getUTCDay()) % 7; return 1 + first + 7 * (n - 1); }
function isDST(date) { const y = +date.slice(0, 4), m = +date.slice(5, 7), dd = +date.slice(8, 10); if (m > 3 && m < 11) return true; if (m === 3) return dd >= nthSunday(y, 3, 2); if (m === 11) return dd < nthSunday(y, 11, 1); return false; }
const offStr = (date) => (isDST(date) ? "-04:00" : "-05:00");

// ---------- daily universe ----------
const dailyDir = path.join(TR, "daily");
async function ensureDaily() {
  fs.mkdirSync(dailyDir, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(D("anomaly-cache-v2", "meta.json"), "utf8"));
  const N = meta.dates.length, S = meta.symbols.length;
  const rd = (f) => { const b = fs.readFileSync(D("anomaly-cache-v2", f)); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
  const pvol = rd("vol.f32");
  const d0 = meta.dates.findIndex((d) => d >= "2018-11-01");
  const cands = [];
  for (let s = 0; s < S; s++) {
    let ok = false;
    for (let d = d0 + 20; d < N && !ok; d++) { let a = 0, n = 0; for (let k = 1; k <= LOOK; k++) { const v = pvol[s * N + d - k]; if (v === v) { a += v; n++; } } if (n >= 10 && a / n >= LOOSE_ADV) ok = true; }
    if (ok) cands.push(meta.symbols[s]);
  }
  const syms = ["SPY", ...cands.filter((s) => s !== "SPY")];
  log(`daily: ${syms.length} candidate symbols from the panel (ADV14>=${LOOSE_ADV} on any day since 2018-11)`);
  const CH = 100, nch = Math.ceil(syms.length / CH), out = {};
  for (let c = 0; c < nch; c++) {
    const f = path.join(dailyDir, `c${String(c).padStart(3, "0")}.json`);
    let obj;
    if (fs.existsSync(f)) obj = JSON.parse(fs.readFileSync(f, "utf8"));
    else {
      let r, end = HOLDOUT.to;
      for (let back = 0; ; back++) { try { r = await fetchBars(syms.slice(c * CH, (c + 1) * CH), { start: "2018-11-01", end, timeframe: "1Day", feed: "sip", adjustment: "raw", requireAll: false, quiet: true, chunkSize: 25 }); break; } catch (e) { if (!/403/.test(e.message) || back > 5) throw e; end = new Date(Date.parse(end + "T12:00:00Z") - 864e5).toISOString().slice(0, 10); } }
      obj = { end, bars: {} };
      for (const [s, rows] of Object.entries(r.bars)) obj.bars[s] = rows.map((b) => [b.t.slice(0, 10), b.o, b.h, b.l, b.c, b.v]);
      writeJsonAtomic(f, obj);
      if (c % 5 === 0) log(`daily chunk ${c + 1}/${nch}`);
    }
    Object.assign(out, obj.bars);
  }
  return { bars: out, panel: { meta, N, S, pcl: rd("close.f32") } };
}

// per-symbol arrays aligned to the calendar
function buildTables(daily) {
  const spy = daily.bars.SPY; if (!spy || spy.length < 1500) throw new Error("SPY daily missing; cannot form calendar");
  const cal = spy.map((r) => r[0]), P = cal.length, ix = new Map(cal.map((d, i) => [d, i]));
  const pmeta = daily.panel.meta, pIx = new Map(pmeta.dates.map((d, i) => [d, i])), sIx = new Map(pmeta.symbols.map((s, i) => [s, i]));
  const tab = {};
  for (const [sym, rows] of Object.entries(daily.bars)) {
    const o = new Float32Array(P).fill(NaN), h = new Float32Array(P).fill(NaN), l = new Float32Array(P).fill(NaN), c = new Float32Array(P).fill(NaN), v = new Float32Array(P).fill(NaN);
    for (const r of rows) { const i = ix.get(r[0]); if (i == null) continue; o[i] = r[1]; h[i] = r[2]; l[i] = r[3]; c[i] = r[4]; v[i] = r[5]; }
    // split flag: raw close ratio vs panel (total-return adjusted) close ratio
    const flag = new Uint8Array(P), si = sIx.get(sym);
    if (si != null) {
      let prevRaw = NaN, prevPan = NaN;
      for (let i = 0; i < P; i++) {
        const pi = pIx.get(cal[i]); const pc = pi == null ? NaN : daily.panel.pcl[si * daily.panel.N + pi];
        if (c[i] === c[i] && pc === pc && prevRaw === prevRaw && prevPan === prevPan) { const rr = c[i] / prevRaw, pr = pc / prevPan; if (pr > 0 && Math.abs(rr / pr - 1) > 0.10) flag[i] = 1; }
        if (c[i] === c[i] && pc === pc) { prevRaw = c[i]; prevPan = pc; }
      }
    }
    tab[sym] = { o, h, l, c, v, flag };
  }
  return { cal, P, ix, tab };
}
// prior-window metrics at calendar position p (uses sessions p-14..p-1 only)
function priorMetrics(t, p) {
  let sv = 0, nv = 0, str = 0, ntr = 0, lastC = NaN, flagged = false;
  // previous valid close before the window
  for (let j = p - LOOK - 1; j >= Math.max(0, p - LOOK - 6); j--) if (t.c[j] === t.c[j]) { lastC = t.c[j]; break; }
  for (let j = p - LOOK; j < p; j++) {
    if (t.flag[j]) flagged = true;
    if (t.c[j] !== t.c[j]) continue;
    sv += t.v[j]; nv++;
    const pc = lastC === lastC ? lastC : t.o[j]; const trj = Math.max(t.h[j] - t.l[j], Math.abs(t.h[j] - pc), Math.abs(t.l[j] - pc)); str += trj; ntr++; lastC = t.c[j];
  }
  if (t.flag[p]) flagged = true;
  return { n: nv, adv: nv ? sv / nv : 0, atr: ntr ? str / ntr : 0, lastClose: lastC, flagged };
}

// ---------- first-5-minute bars ----------
const f5Dir = path.join(TR, "first5"), m1Dir = path.join(TR, "m1");
async function getFirst5(date, syms) {
  fs.mkdirSync(f5Dir, { recursive: true });
  const f = path.join(f5Dir, date + ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const off = offStr(date), rows = {};
  const r = await fetchBars(syms, { start: `${date}T09:30:00${off}`, end: `${date}T09:34:59${off}`, timeframe: "5Min", feed: "sip", adjustment: "raw", requireAll: false, quiet: true, chunkSize: CHUNK });
  for (const [s, a] of Object.entries(r.bars)) { const b = a.find((x) => x.t.slice(11, 16) === (isDST(date) ? "13:30" : "14:30")); if (b) rows[s] = [b.o, b.h, b.l, b.c, b.v]; }
  const obj = { date, requested: syms.length, returned: Object.keys(rows).length, rows };
  writeJsonAtomic(f, obj); return obj;
}
async function getM1(date, syms) {
  fs.mkdirSync(m1Dir, { recursive: true });
  const f = path.join(m1Dir, date + ".json");
  let obj = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { date, rows: {} };
  const need = syms.filter((s) => !(s in obj.rows)); if (!need.length) return obj;
  const off = offStr(date), base = (isDST(date) ? 13 : 14) * 60 + 30;
  const r = await fetchBars(need, { start: `${date}T09:30:00${off}`, end: `${date}T15:59:59${off}`, timeframe: "1Min", feed: "sip", adjustment: "raw", requireAll: false, quiet: true, chunkSize: 25 });
  for (const s of need) obj.rows[s] = (r.bars[s] || []).map((b) => { const u = +b.t.slice(11, 13) * 60 + +b.t.slice(14, 16); return [u - base, b.o, b.h, b.l, b.c, b.v]; });
  writeJsonAtomic(f, obj); return obj;
}

// ---------- trade engine ----------
/** bars: [[minute since 09:30, o,h,l,c,v]] ascending. dir: +1 long / -1 short. Returns null if not enterable. */
function simulate(bars, dir, atr) {
  let e = bars.findIndex((b) => b[0] >= 5); if (e < 0 || bars[e][0] > 20) return null;
  const eb = bars[e], entry = eb[1], stopDist = STOP_ATR * atr; if (!(stopDist > 0) || !(entry > 0)) return null;
  const stop = entry - dir * stopDist;
  let exitPx = bars[bars.length - 1][4], xb = bars[bars.length - 1], stopped = false;
  for (let i = e; i < bars.length; i++) {
    const b = bars[i];
    if (dir > 0 ? b[3] <= stop : b[2] >= stop) { exitPx = dir > 0 ? Math.min(stop, b[1]) : Math.max(stop, b[1]); if (i === e) exitPx = stop; xb = b; stopped = true; break; }
  }
  const hsE = 0.5 * (eb[2] - eb[3]), hsX = 0.5 * (xb[2] - xb[3]);
  const gross = dir * (exitPx - entry);
  const net1 = gross - 2 * SHARE_FEE - hsE - hsX, net2 = gross - 2 * SHARE_FEE - 2 * (hsE + hsX), netB = gross - 2 * SHARE_FEE - 2 * TWO_BPS * entry;
  return { gross: gross / entry, net: net1 / entry, net2x: net2 / entry, net2bp: netB / entry, R: gross / stopDist, RnetProxy: net1 / stopDist, stopFrac: stopDist / entry, stopped };
}
const COSTS = ["gross", "net", "net2x", "net2bp"];
/** day return on NAV=1 under risk-based sizing with the 4x cap; trades: [{leg:{...}}] where leg already picked by direction */
function dayReturn(legs, key) {
  if (!legs.length) return 0;
  const notl = legs.map((l) => RISK / l.stopFrac), tot = notl.reduce((s, x) => s + x, 0), sc = Math.min(1, LEV / tot);
  return legs.reduce((s, l, i) => s + sc * notl[i] * l[key], 0);
}

// ---------- day selection ----------
function buildSchedule(T, from, to) {
  const days = T.cal.filter((d) => d >= from && d <= to);
  return days;
}
/** loose fetch set for each needed calendar position */
function looseFlags(T, syms, pFrom, pTo) {
  const loose = new Map();  // sym -> Uint8Array over [pFrom-.. pTo+LOOK]
  for (const s of syms) {
    const t = T.tab[s], a = new Uint8Array(T.P);
    for (let p = Math.max(LOOK + 6, pFrom - LOOK); p <= Math.min(T.P - 1, pTo); p++) {
      if (t.c[p] !== t.c[p]) continue;
      const m = priorMetrics(t, p); if (m.n >= 10 && m.adv >= LOOSE_ADV && m.lastClose >= LOOSE_PX) a[p] = 1;
    }
    loose.set(s, a);
  }
  return loose;
}
async function selectDays(T, window, note) {
  const syms = Object.keys(T.tab).filter((s) => s !== "SPY");
  const pFrom = T.cal.findIndex((d) => d >= window.from), pTo = T.cal.reduce((acc, d, i) => (d <= window.to ? i : acc), -1);
  if (pFrom < 0 || pTo < pFrom) throw new Error("window not in calendar " + JSON.stringify(window));
  const loose = looseFlags(T, syms, pFrom, pTo);
  const fetchPos = [];
  for (let p = pFrom - LOOK; p <= pTo; p++) fetchPos.push(p);
  // day p's fetch set = loose on any of p..p+LOOK (bounded by pTo)
  const f5 = {};
  let done = 0;
  for (const p of fetchPos) {
    const set = syms.filter((s) => { const a = loose.get(s); for (let q = p; q <= Math.min(pTo, p + LOOK); q++) if (q >= 0 && a[q]) return true; return false; });
    const date = T.cal[p], obj = await getFirst5(date, set);
    if (obj.returned < 0.5 * obj.requested) throw new Error(`coverage failure ${date}: ${obj.returned}/${obj.requested}`);
    f5[p] = obj; if (++done % 50 === 0) log(`${note}: first-5m ${done}/${fetchPos.length} days (${date}, ${obj.returned}/${obj.requested})`);
  }
  // selection
  const rng = mulberry(287287), days = [], skip = { split: 0, denom: 0 };
  for (let p = pFrom; p <= pTo; p++) {
    const obj = f5[p], cand = [], low = [];
    for (const [s, r] of Object.entries(obj.rows)) {
      const t = T.tab[s]; if (!t) continue;
      if (!(r[0] > MIN_PRICE)) continue;
      const m = priorMetrics(t, p); if (m.n < 10 || m.adv < MIN_ADV || !(m.atr > MIN_ATR)) continue;
      if (m.flagged) { skip.split++; continue; }
      let sv = 0; for (let q = p - LOOK; q < p; q++) { const pr = f5[q] && f5[q].rows[s]; sv += pr ? pr[4] : 0; }
      const den = sv / LOOK; if (!(den > 0)) { skip.denom++; continue; }
      const rvol = r[4] / den, dir = r[3] > r[0] ? 1 : r[3] < r[0] ? -1 : 0; if (!dir) continue;
      (rvol >= 1 ? cand : low).push({ s, rvol, dir, atr: m.atr, open: r[0] });
    }
    cand.sort((a, b) => b.rvol - a.rvol || (a.s < b.s ? -1 : 1));
    const top = cand.slice(0, TOPN);
    const lo = low.slice().sort((a, b) => (a.s < b.s ? -1 : 1)); for (let i = lo.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [lo[i], lo[j]] = [lo[j], lo[i]]; }
    days.push({ date: T.cal[p], eligible: cand.length + low.length, nCand: cand.length, top, ctl: lo.slice(0, TOPN) });
  }
  return { days, skip };
}
async function tradeDays(days, note) {
  let k = 0;
  for (const d of days) {
    const syms = [...d.top, ...d.ctl].map((x) => x.s), m1 = await getM1(d.date, syms);
    for (const grp of [d.top, d.ctl]) for (const x of grp) { const b = m1.rows[x.s]; x.long = b && b.length ? simulate(b, 1, x.atr) : null; x.short = b && b.length ? simulate(b, -1, x.atr) : null; }
    if (++k % 50 === 0) log(`${note}: 1m ${k}/${days.length}`);
  }
}

// ---------- aggregation ----------
function legsOf(group, dirOf) { const out = []; for (const x of group) { const l = dirOf(x) > 0 ? x.long : x.short; if (l) out.push(l); } return out; }
function seriesOf(days, which, dirOf, key) { return days.map((d) => dayReturn(legsOf(d[which], dirOf), key)); }
const ownDir = (x) => x.dir;
function tradeStats(days, which, dirOf) { const R = [], Rn = []; let win = 0, n = 0; for (const d of days) for (const l of legsOf(d[which], dirOf)) { R.push(l.R); Rn.push(l.RnetProxy); n++; if (l.net > 0) win++; } return { n, meanRgross: R.length ? mean(R) : NaN, meanRnet: Rn.length ? mean(Rn) : NaN, winRate: n ? win / n : NaN }; }
function maxDD(r) { let c = 0, pk = 0, dd = 0; for (const x of r) { c += x; pk = Math.max(pk, c); dd = Math.min(dd, c - pk); } return dd; }

// ---------- self-test: engine known answers ----------
function engineSelfTest() {
  const flat = (n, px) => Array.from({ length: n }, (_, i) => [i, px, px, px, px, 1000]);
  const fails = [];
  // 1. flat tape: gross 0, net = -(2 x $0.01)/price, exactly
  let s = simulate(flat(390, 100), 1, 2); if (!s || Math.abs(s.gross) > 1e-12 || Math.abs(s.net + 0.02 / 100) > 1e-12) fails.push("flat tape");
  // 2. rising tape 100 -> 101 (no bar range, stop never touched): long gross = +1%, short hits stop
  const rise = Array.from({ length: 390 }, (_, i) => { const p = 100 + i / 389; return [i, p, p, p, p, 1000]; });
  s = simulate(rise, 1, 2); const entryPx = rise[5][1]; if (!s || Math.abs(s.gross - (101 - entryPx) / entryPx) > 1e-12) fails.push("rising long");
  s = simulate(rise, -1, 2); if (!s || !s.stopped || Math.abs(s.R + 1) > 0.05) fails.push("rising short must stop near -1R: " + (s && s.R));
  // 3. gap through the stop: fill at the bar open, R < -1
  const gap = flat(390, 100).map((b, i) => (i >= 50 ? [i, 90, 90, 90, 90, 1000] : b)); s = simulate(gap, 1, 2); if (!s || Math.abs(s.gross - (-0.10)) > 1e-12 || s.R > -1) fails.push("gap stop");
  // 4. never-trade day gives return 0 exactly
  if (dayReturn([], "net") !== 0) fails.push("empty day");
  // 5. sizing cap: 20 identical legs, stopFrac 0.3% -> risk notional 3.33 each, total 66.7 -> scaled to 4x; net return on NAV = 4 x leg return
  const leg = { stopFrac: 0.003, net: 0.001, gross: 0.001 }; const dr = dayReturn(Array(20).fill(leg), "net"); if (Math.abs(dr - 4 * 0.001) > 1e-12) fails.push("leverage cap " + dr);
  // 6. shuffled direction on a symmetric tape: long+short gross cancel exactly
  const osc = Array.from({ length: 390 }, (_, i) => { const p = 100 + (i % 2 ? 0.01 : -0.01) * 0; return [i, p, p, p, p, 1000]; });
  const a = simulate(osc, 1, 2), b = simulate(osc, -1, 2); if (Math.abs(a.gross + b.gross) > 1e-12) fails.push("long/short symmetry");
  return fails;
}

// ---------- reporting core ----------
function report(days, label, barT) {
  const net = seriesOf(days, "top", ownDir, "net"), gross = seriesOf(days, "top", ownDir, "gross");
  const net2x = seriesOf(days, "top", ownDir, "net2x"), net2bp = seriesOf(days, "top", ownDir, "net2bp");
  const ctlNet = seriesOf(days, "ctl", ownDir, "net"), ctlGross = seriesOf(days, "ctl", ownDir, "gross");
  const rndNet = seriesOf(days, "top", (x) => -x.dir, "net");            // reversed direction (the mirror image)
  const half = Math.floor(net.length / 2);
  const ts = tradeStats(days, "top", ownDir), tc = tradeStats(days, "ctl", ownDir);
  // placebo: within-day permutation of direction labels
  const rng = mulberry(287001), obs = mean(net), draws = [], drawsFlip = [];
  for (let k = 0; k < DRAWS; k++) {
    const r1 = [], r2 = [];
    for (const d of days) {
      const dirs = d.top.map((x) => x.dir); for (let i = dirs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [dirs[i], dirs[j]] = [dirs[j], dirs[i]]; }
      const m = new Map(d.top.map((x, i) => [x, dirs[i]]));
      r1.push(dayReturn(legsOf(d.top, (x) => m.get(x)), "net"));
      r2.push(dayReturn(legsOf(d.top, () => (rng() < 0.5 ? 1 : -1)), "net"));
    }
    draws.push(mean(r1)); drawsFlip.push(mean(r2));
  }
  draws.sort((a, b) => a - b); drawsFlip.sort((a, b) => a - b);
  const p95 = draws[Math.floor(0.95 * DRAWS)], p95f = drawsFlip[Math.floor(0.95 * DRAWS)];
  const half1 = net.slice(0, half), half2 = net.slice(half);
  const perYear = (x) => mean(x) * 252 * 10000;
  return {
    label, days: days.length, nTrades: ts.n, meanTradesPerDay: ts.n / days.length,
    meanNet: mean(net), meanGross: mean(gross), tNet: tOf(net), tGross: tOf(gross), tNetNW5: nwT(net), tCheck: tPlain(net),
    meanNet2x: mean(net2x), tNet2x: tOf(net2x), meanNet2bp: mean(net2bp), tNet2bp: tOf(net2bp),
    winRate: ts.winRate, perTradeRgross: ts.meanRgross, perTradeRnetProxy: ts.meanRnet,
    control: { n: tc.n, meanNet: mean(ctlNet), tNet: tOf(ctlNet), meanGross: mean(ctlGross), tGross: tOf(ctlGross), perTradeRgross: tc.meanRgross },
    reversedDirection: { meanNet: mean(rndNet), tNet: tOf(rndNet) },
    placebo: { observed: obs, p95, beats: obs > p95, draws: DRAWS, coinFlipP95: p95f, coinFlipBeats: obs > p95f },
    halves: { first: { days: half1.length, meanNet: mean(half1), t: tOf(half1) }, second: { days: half2.length, meanNet: mean(half2), t: tOf(half2) } },
    dollarsAt10k: { net: perYear(net), gross: perYear(gross), net2x: perYear(net2x), net2bp: perYear(net2bp) },
    maxDD: maxDD(net), barT,
  };
}

(async () => {
  const daily = await ensureDaily(); const T = buildTables(daily);
  log(`calendar ${T.cal[0]}..${T.cal.at(-1)} (${T.P} sessions), ${Object.keys(T.tab).length} symbols loaded`);
  const bar = require("./data/test-registry.json").preregistered.find((e) => e.id === ID).bar.tRequired;   // never hard-coded (amended pre-evidence 2026-09-29: 3.075 -> 2.223)

  if (mode === "--selftest") {
    const fails = engineSelfTest();
    console.log(`engine known answers: ${fails.length ? "FAIL " + fails.join("; ") : "OK (flat tape / rising tape / gap stop / empty day / leverage cap / long-short symmetry)"}`);
    if (fails.length) process.exit(1);
    const rep = [];
    let allDays = [], skips = {};
    for (const w of KNOWN) { const { days, skip } = await selectDays(T, w, "known " + w.from.slice(0, 4)); await tradeDays(days, "known " + w.from.slice(0, 4)); allDays = allDays.concat(days); skips[w.from.slice(0, 4)] = skip; rep.push(report(days, w.from.slice(0, 4), bar)); }
    const pooled = report(allDays, "2019+2023", bar);
    const ok = pooled.perTradeRgross > 0 && pooled.control.perTradeRgross < pooled.perTradeRgross;
    const out = { id: ID, at: new Date().toISOString(), engineOK: true, paperExpectedGrossRperTrade: 0.08, pooled, byYear: rep, skips, pass: ok, criterion: "pooled top-20 gross per-trade R > 0 AND above the RVol<1 control's gross per-trade R (paper: +0.08R vs -0.02R)" };
    writeJsonAtomic(SELFTEST_OUT, out);
    for (const r of [...rep, pooled]) console.log(`  ${r.label}: ${r.days} days ${r.nTrades} trades, gross R/trade ${r.perTradeRgross.toFixed(3)} (net-proxy ${r.perTradeRnetProxy.toFixed(3)}), control gross R/trade ${r.control.perTradeRgross.toFixed(3)}, daily gross ${(100 * r.meanGross).toFixed(3)}% net ${(100 * r.meanNet).toFixed(3)}%`);
    console.log(`selftest known-answer replication (paper +0.08R vs -0.02R): ${ok ? "PASS" : "FAIL"} -> ${SELFTEST_OUT}`);
    process.exit(ok ? 0 : 2);
  }

  // ---- --read ----
  if (!fs.existsSync(SELFTEST_OUT) || !JSON.parse(fs.readFileSync(SELFTEST_OUT, "utf8")).pass) throw new Error("selftest has not passed — the holdout stays sealed");
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if ((seals.tests && seals.tests[ID]) || fs.existsSync(OUT)) throw new Error("R287 already read — read-once");
  const { days, skip } = await selectDays(T, HOLDOUT, "holdout");
  await tradeDays(days, "holdout");
  const r = report(days, "holdout", bar);
  const passVerdict = r.tNet >= bar && r.placebo.beats && Math.sign(r.halves.first.meanNet) === Math.sign(r.halves.second.meanNet) && r.halves.first.meanNet > 0;
  const kw = [
    "Spread is a PROXY: the 1-minute bar (high-low) at the fill, an overestimate of a quoted half-spread; the 2 bps + $0.01 variant is reported beside it (registry R141 measured ~54 bps median on gappers at 09:35).",
    "Universe from anomaly-cache-v2: excludes '-'/'.' tickers (BRK.B, preferreds), 612 too-short names and names truncated after a >300% move; ATR/ADV on raw daily bars; split-window name-days skipped (" + skip.split + ").",
    "Entry is the open of the 09:35 1-minute bar (a stop order at the range would fill at the same price only when the first minute continues the direction); no queue/slippage beyond the proxy; no borrow cost on shorts; no halts modelled.",
    "4x leverage cap binds almost every day (stop is 10% of ATR, tiny), so daily return is ~4x the mean per-trade return: results are leverage-amplified, and the sample is one strategy in one 2.7-year window.",
    "Holdout is post-publication (paper posted 2024-02) but the known-answer window 2016-2023 is in-sample to the paper; MOC modelled at the close of the last 1-minute bar, not the auction print.",
  ];
  const out = {
    id: ID, key: KEY, name: "Stocks-in-Play 5-minute ORB, top-20 by 5-minute RVol (Zarattini/Barbon/Aziz) - sealed 2024-2026 holdout",
    rule: "RVol>=1 top-20 by 09:30-09:35 relative volume; long/short by first-bar sign; enter 09:35 open; stop 10% ATR14; MOC; 1% risk/4x cap",
    window: `${days[0].date}..${days.at(-1).date}`, unit: "days", n: r.days, statistic: "mean daily net return on NAV, one-sample t over days",
    tNet: r.tNet, tGross: r.tGross, tNetNewey5: r.tNetNW5, meanNet: r.meanNet, meanGross: r.meanGross, winRate: r.winRate, nTrades: r.nTrades, meanTradesPerDay: r.meanTradesPerDay,
    perTradeRgross: r.perTradeRgross, perTradeRnetProxy: r.perTradeRnetProxy,
    placebo: r.placebo, halves: r.halves, controlRVolLow: r.control, reversedDirection: r.reversedDirection,
    costSensitivity: { primary: { meanNet: r.meanNet, tNet: r.tNet }, doubleProxy: { meanNet: r.meanNet2x, tNet: r.tNet2x }, twoBpsPlusCent: { meanNet: r.meanNet2bp, tNet: r.tNet2bp }, gross: { meanNet: r.meanGross, tNet: r.tGross } },
    dollarsAt10k: r.dollarsAt10k.net, dollarsAt10kByCost: r.dollarsAt10k, maxDD: r.maxDD, maxDDNote: "cumulative sum of daily net return on NAV (non-compounding), fraction of NAV",
    bar: { tRequired: bar, source: "registry bar.tRequired read at runtime" },
    costModel: "$0.01/share/side + half the 1-minute bar range at the fill per side (primary); gross/2x/2bps variants reported",
    dataSources: ["Alpaca SIP 1Day raw (universe filters)", "Alpaca SIP 5Min raw window 09:30-09:34:59 per day (RVol)", "Alpaca SIP 1Min raw RTH for the 20+20 names/day", "anomaly-cache-v2 panel (split flag, candidate list)"],
    skipped: skip, meanEligiblePerDay: mean(days.map((d) => d.eligible)), meanRVolGe1PerDay: mean(days.map((d) => d.nCand)),
    selftest: JSON.parse(fs.readFileSync(SELFTEST_OUT, "utf8")).pooled && { pooledGrossRperTrade: JSON.parse(fs.readFileSync(SELFTEST_OUT, "utf8")).pooled.perTradeRgross, controlGrossRperTrade: JSON.parse(fs.readFileSync(SELFTEST_OUT, "utf8")).pooled.control.perTradeRgross },
    knownWeaknesses: kw, readAt: new Date().toISOString(),
    verdictScript: passVerdict ? "PASS" : "DID NOT PASS",
  };
  writeJsonAtomic(OUT, out);
  console.log(`${out.verdictScript}: tNet ${r.tNet.toFixed(2)} (bar ${bar}), tGross ${r.tGross.toFixed(2)}, NW5 ${r.tNetNW5.toFixed(2)}, n=${r.days} days, ${r.nTrades} trades`);
  console.log(`  mean daily net ${(100 * r.meanNet).toFixed(3)}% gross ${(100 * r.meanGross).toFixed(3)}%; $ per yr on 10k net ${r.dollarsAt10k.net.toFixed(0)} gross ${r.dollarsAt10k.gross.toFixed(0)}; maxDD ${(100 * r.maxDD).toFixed(1)}% NAV`);
  console.log(`  placebo observed ${(100 * r.placebo.observed).toFixed(3)}% vs p95 ${(100 * r.placebo.p95).toFixed(3)}% beats=${r.placebo.beats}; halves ${(100 * r.halves.first.meanNet).toFixed(3)}% / ${(100 * r.halves.second.meanNet).toFixed(3)}%`);
  console.log(`  control RVol<1: daily net ${(100 * r.control.meanNet).toFixed(3)}% t ${r.control.tNet.toFixed(2)}; reversed direction net ${(100 * r.reversedDirection.meanNet).toFixed(3)}%; per-trade gross R ${r.perTradeRgross.toFixed(3)}`);
  console.log(`  cost sens: 2x proxy t ${r.tNet2x.toFixed(2)}, 2bps+cent t ${r.tNet2bp.toFixed(2)}  -> ${OUT}`);
})().catch((e) => { console.error("R287 FAILED:", e.stack || e.message); process.exit(1); });
