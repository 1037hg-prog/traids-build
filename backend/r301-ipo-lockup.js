#!/usr/bin/env node
/**
 * R301 — IPO lock-up expiry (180-day proxy), registered 2026-10-01 (scout key IPO_LOCKUP). The registry wins; this file implements it.
 *
 *   EVENTS  US common-stock IPOs from Alpha Vantage LISTING_STATUS (ipoDate; the cached 2026-09-23 active+delisted CSVs in
 *           backend/data are the one cached call - no AV call is made here), IPOs 2016-01..2026-03, with an Alpaca SIP daily
 *           history from the IPO, price >= $3 and 20-session dollar volume >= $2M at the entry date.
 *   PROXY   lock-up date = ipoDate + 180 calendar days, rolled to the next IWM session (X). Actual lock-up dates and the VC-backed
 *           flag are not in our data (disclosed).
 *   TRADE   SHORT the IPO at the close of the session before X (E), cover at the close of the 2nd session after X (C); long IWM
 *           over the same two closes (the excess = r_IWM - r_stock).
 *   COST    $0.01/share + 10 bps per side on the IPO leg; IWM hedge leg $0.01/share + 2 bps per side (house ETF default, BUILD.md);
 *           borrow 10%/yr on the calendar days held (assumed, NOT measured).
 *   STAT    per-event net excess, clustered by expiry MONTH of X; one-sample t over month-means; bar = registry bar.tRequired
 *           (read at run time). Unit = events.
 *   CONTROL placebo = the SAME names at a random 3-session window 60-120 sessions after the IPO (same cost, same IWM hedge),
 *           >= 500 draws (1,000 here), same month clusters. PASS needs observed month-mean > placebo p95.
 *   PASS    net t >= bar AND placebo beaten AND both halves (first/second half of the expiry months) positive.
 *
 *   node backend/r301-ipo-lockup.js --plan       count the candidate universe and the fetch batches (no network, no outcomes)
 *   node backend/r301-ipo-lockup.js --fetch      resumable Alpaca cache fill (<= 30 requests/min); computes NO outcome
 *   node backend/r301-ipo-lockup.js --coverage   cache coverage + exclusion counts + event counts (NO returns are computed or printed)
 *   node backend/r301-ipo-lockup.js --selftest   hand-computable known answers on a synthetic world (must pass before the read)
 *   node backend/r301-ipo-lockup.js --read       the one registered read (refuses if sealed or if the output exists)
 *
 * DEFINITIONAL CHOICES (fixed in this header BEFORE any outcome was computed; they only decide which rows are "common-stock IPOs of
 * newly public operating names" - the registry phrase - and the literal no-SPAC-handling variant is reported beside the primary):
 *  D1 assetType == Stock, symbol /^[A-Z]{1,5}$/, name not matching warrants/rights/units/preferred/depositary/notes/ETF/ETN/fund/CLO/
 *     debenture/when-issued/senior/subordinated (not common stock).
 *  D2 SPAC handling (PRIMARY excludes, the "literal" sensitivity keeps): AV's ipoDate for a de-SPAC'd company is the SHELL's IPO date,
 *     and a shell has no lock-up at +180d. Excluded as SPAC-like if the name matches acquisition/merger/blank check/SPAC OR the closes of
 *     sessions 1..40 after the first bar span max/min <= 1.08 (a trust-pinned shell; needs >= 30 bars). All known at E (no look-ahead).
 *  D3 "history from the IPO": the first Alpaca bar is within [ipoDate-3d, ipoDate+7d]; any bar in the 62 days before ipoDate-3d means the
 *     ticker traded earlier (spin-off when-issued, relisting, reuse) and the row is excluded as preIpoHistory.
 *  D3c AV stamps ipoDate = 2016-01-04 (the Alpaca history start; 227 plain Stock rows, mostly long-listed names) so rows with ipoDate < 2016-01-12
 *     are excluded as historyFloor (pre-IPO trading cannot be checked there). Found while inspecting the first cached batch, before any outcome.
 *  D4 "20-session dollar volume" = SUM of close*volume over the 20 sessions ending at E (literal reading); average-DV >= $2M reported as a
 *     sensitivity. Price test uses the E close. Filters use the E close/volume (the MOC decision uses the close it trades at - disclosed).
 *  D5 missing bar at E or C (no print that session) => event excluded and counted; if the name is delisted by C (AV delistingDate <= C) and
 *     has a bar at/after E, the last close is the cover price (delisting return included).
 *  D6 prices are Alpaca adjustment=all (total return); $0.01/share is applied to those adjusted prices (conservative for later splits).
 *  D7 halves = the chronologically first / second half of the expiry months that have events (equal month counts).
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const CL = require("./lib/clustered.js");

const ID = "R301", KEY = "IPO_LOCKUP";
const D = (f) => path.join(__dirname, "data", f), CACHE = D("training/r301"), OUT = D("r301-ipo-lockup.json");
const LISTINGS = ["av-listing-status-active-2026-09-23.csv", "av-listing-status-delisted-2026-09-23.csv"];
const IPO_FIRST = "2016-01-01", IPO_LAST = "2026-03-31";
const LOCK_DAYS = 180, ENTRY_BEFORE = 1, COVER_AFTER = 2;
const MIN_PRICE = 3, MIN_DV20 = 2e6, DV_N = 20;
const COST = { bps: 0.0010, borrow: 0.10 };        // IPO leg per side; borrow per year on calendar days held
const SHARE_FEE = 0.01, HEDGE_BPS = 0.0002;
const PLACEBO_LO = 60, PLACEBO_HI = 120, DRAWS = 1000, SEED = 301301;
const FETCH_MIN_INTERVAL_MS = 2100;                // <= 28.5 requests/min (shared-resource cap 30)
const FEED = "sip", END_RFC = "2026-10-01T00:00:00Z"; // explicit RFC-3339 end (today's forming session is never requested)
const PRE_IPO_LOOKBACK = 62, FIRST_BAR_LATE = 7, FIRST_BAR_EARLY = 3, HISTORY_FLOOR = "2016-01-12";   // Alpaca SIP daily starts 2016-01-04; AV stamps 2016-01-04 on already-listed names

const mode = ["--plan", "--fetch", "--coverage", "--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// ───────────────────────────── dates ─────────────────────────────
const dayNum = (s) => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5);
const numDay = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const addDays = (s, n) => numDay(dayNum(s) + n);
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };

// ───────────────────────────── listing ─────────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const h = rows[0]; return rows.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
const EXCL_NAME = /\b(warrants?|rights?|units?|preferred|depositary|notes?|etf|etn|fund|funds|clo|debentures?|when issued|subordinated|senior)\b/i;
const SPAC_NAME = /\b(acquisition|acquisitions|merger|blank check|spac)\b/i;

function loadCandidates() {
  let rows = [];
  for (const f of LISTINGS) rows = rows.concat(parseCsv(fs.readFileSync(D(f), "utf8")).map((r) => ({ ...r, delistingDate: r.delistingDate && r.delistingDate !== "null" ? r.delistingDate : null })));
  const seen = new Map();
  for (const r of rows) {
    if (r.assetType !== "Stock" || !/^[A-Z]{1,5}$/.test(r.symbol) || !r.ipoDate || r.ipoDate < IPO_FIRST || r.ipoDate > IPO_LAST) continue;
    if (EXCL_NAME.test(r.name || "")) continue;
    const k = r.symbol + "|" + r.ipoDate, prev = seen.get(k);
    if (!prev || (!prev.delistingDate && r.delistingDate)) seen.set(k, r);
  }
  const out = [...seen.values()];
  const bySym = {}; for (const r of out) (bySym[r.symbol] = bySym[r.symbol] || []).push(r);
  for (const arr of Object.values(bySym)) {
    arr.sort((a, b) => a.ipoDate.localeCompare(b.ipoDate));
    arr.forEach((r, i) => { const caps = []; if (r.delistingDate) caps.push(r.delistingDate); if (arr[i + 1]) caps.push(addDays(arr[i + 1].ipoDate, -1)); r.validTo = caps.length ? caps.sort()[0] : "9999-12-31"; });
  }
  for (const r of out) r.spacName = SPAC_NAME.test(r.name || "");
  return out.sort((a, b) => a.ipoDate.localeCompare(b.ipoDate) || a.symbol.localeCompare(b.symbol));
}

// ───────────────────────────── cache + fetch ─────────────────────────────
const batchKey = (rows) => rows.map((r) => r.symbol).sort().join(",");
function batchFile(month) { return path.join(CACHE, `bars-${month}.json`); }
function batchSpec(month, rows) {
  const first = month + "-01", lastDay = addDays(addDays(first, 32).slice(0, 7) + "-01", -1);
  const start = addDays(first, -PRE_IPO_LOOKBACK), endDay = addDays(lastDay, LOCK_DAYS + 20);
  return { start: start + "T00:00:00Z", end: endDay + "T00:00:00Z" > END_RFC ? END_RFC : endDay + "T00:00:00Z", symbols: [...new Set(rows.map((r) => r.symbol))] };
}
async function alpacaBars(symbols, start, end) {
  const { fetchBars } = require("./lib/alpaca-bars.js");
  let last;
  for (let a = 0; a < 6; a++) {
    try { const r = await fetchBars(symbols, { start, end, timeframe: "1Day", feed: FEED, adjustment: "all", requireAll: false, minIntervalMs: FETCH_MIN_INTERVAL_MS, quiet: true }); return r.bars; }
    catch (e) { last = e; process.stderr.write(`  [r301] fetch attempt ${a + 1}/6 failed: ${e.message.slice(0, 120)} - waiting ${20 * (a + 1)}s\n`); await nap(20000 * (a + 1)); }
  }
  throw last;
}
const compact = (bars) => Object.fromEntries(Object.entries(bars).map(([s, a]) => [s, a.map((b) => [String(b.t).slice(0, 10), b.c, b.v])]));

async function fillCache(cands) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, "iwm.json");
  if (!fs.existsSync(f)) { const b = await alpacaBars(["IWM"], "2015-12-01T00:00:00Z", END_RFC); if (!b.IWM || b.IWM.length < 2000) throw new Error("IWM benchmark short/missing - cannot run"); writeJsonAtomic(f, { fetchedAt: new Date().toISOString(), bars: compact(b).IWM }); }
  const byMonth = {}; for (const r of cands) (byMonth[r.ipoDate.slice(0, 7)] = byMonth[r.ipoDate.slice(0, 7)] || []).push(r);
  const months = Object.keys(byMonth).sort(); let done = 0, fetched = 0; const failed = [];
  for (const m of months) {
    const spec = batchSpec(m, byMonth[m]), file = batchFile(m);
    let ok = false;
    if (fs.existsSync(file)) { try { const c = JSON.parse(fs.readFileSync(file, "utf8")); ok = c.key === batchKey(byMonth[m]) && c.end === spec.end && c.start === spec.start; } catch { ok = false; } }
    if (!ok) {
      try { const bars = await alpacaBars(spec.symbols, spec.start, spec.end); writeJsonAtomic(file, { month: m, key: batchKey(byMonth[m]), start: spec.start, end: spec.end, fetchedAt: new Date().toISOString(), requested: spec.symbols.length, bars: compact(bars) }); fetched++; }
      catch (e) { failed.push(m); process.stderr.write(`  [r301] batch ${m} FAILED after retries: ${e.message.slice(0, 160)}\n`); }
    }
    done++; if (done % 10 === 0 || done === months.length) console.log(`[r301] batches ${done}/${months.length} (fetched ${fetched} this run, failed ${failed.length})`);
  }
  return { months: months.length, failed };
}
function loadCache(cands) {
  const iwm = JSON.parse(fs.readFileSync(path.join(CACHE, "iwm.json"), "utf8")).bars;
  const barsBySym = {}, byMonth = {}; for (const r of cands) (byMonth[r.ipoDate.slice(0, 7)] = byMonth[r.ipoDate.slice(0, 7)] || []).push(r);
  const missingBatches = [];
  for (const m of Object.keys(byMonth)) {
    const file = batchFile(m);
    if (!fs.existsSync(file)) { missingBatches.push(m); continue; }
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (c.key !== batchKey(byMonth[m])) { missingBatches.push(m); continue; }
    for (const r of byMonth[m]) r.bars = c.bars[r.symbol] || [];
  }
  if (missingBatches.length) throw new Error(`cache incomplete: ${missingBatches.length} month batches missing (${missingBatches.slice(0, 5).join(",")}...) - run --fetch again; a read on partial data is refused`);
  return { iwm };
}

// ───────────────────────────── trade + event logic (pure; shared with --selftest) ─────────────────────────────
function makeCal(iwmBars) { return { dates: iwmBars.map((b) => b[0]), close: iwmBars.map((b) => b[1]) }; }
function costOf(p, cost) {      // total round-trip cost as a fraction of the $1 notional per leg
  return (2 * cost.bps + SHARE_FEE / p.pE + SHARE_FEE / p.pC) + (2 * HEDGE_BPS + SHARE_FEE / p.iE + SHARE_FEE / p.iC) + cost.borrow * p.days / 365;
}
function tradeParts(by, cal, ei, ci, lastBar) {
  const sE = by.get(cal.dates[ei]); let sC = by.get(cal.dates[ci]), delist = false;
  if (!sE) return { reason: "noBarAtEntry" };
  if (!sC) { if (lastBar && lastBar.ret) { sC = lastBar.ret; delist = true; } else return { reason: "noBarAtCover" }; }
  const rs = sC.c / sE.c - 1, ri = cal.close[ci] / cal.close[ei] - 1;
  return { pE: sE.c, pC: sC.c, iE: cal.close[ei], iC: cal.close[ci], days: dayNum(cal.dates[ci]) - dayNum(cal.dates[ei]), gross: ri - rs, delist, dv20: null };
}
function spacPrice(live) {
  const w = live.slice(1, 41); if (w.length < 30) return false;
  let mx = -Infinity, mn = Infinity; for (const b of w) { if (b[1] > mx) mx = b[1]; if (b[1] < mn) mn = b[1]; }
  return mn > 0 && mx / mn <= 1.08;
}
/** One listing row + its bars -> { ev } or { reason }. bars = [[date, close, volume]] sorted ascending. */
function buildEvent(row, bars, cal) {
  const preFrom = addDays(row.ipoDate, -PRE_IPO_LOOKBACK), floor = addDays(row.ipoDate, -FIRST_BAR_EARLY);
  const validTo = row.validTo || "9999-12-31";
  if (row.ipoDate < HISTORY_FLOOR) return { reason: "historyFloor" };   // D3c: pre-IPO trading cannot be ruled out before the history floor
  const own = bars.filter((b) => b[0] >= preFrom && b[0] <= validTo);
  if (own.some((b) => b[0] < floor)) return { reason: "preIpoHistory" };
  const live = own.filter((b) => b[0] >= floor);
  if (!live.length) return { reason: "noBars" };
  if (live[0][0] > addDays(row.ipoDate, FIRST_BAR_LATE)) return { reason: "lateFirstBar" };
  const xi = lowerBound(cal.dates, addDays(row.ipoDate, LOCK_DAYS)), ei = xi - ENTRY_BEFORE, ci = xi + COVER_AFTER;
  if (ci >= cal.dates.length) return { reason: "coverBeyondData" };
  const by = new Map(live.map((b) => [b[0], { c: b[1], v: b[2] }]));
  let lastBar = null;
  const lb = live[live.length - 1];
  if (row.delistingDate && row.delistingDate <= cal.dates[ci] && lb[0] >= cal.dates[ei]) lastBar = { ret: { c: lb[1], v: lb[2] } };
  const p = tradeParts(by, cal, ei, ci, lastBar);
  if (p.reason) return { reason: p.reason };
  if (!(p.pE >= MIN_PRICE)) return { reason: "priceLT3" };
  let dv = 0; for (let j = ei - DV_N + 1; j <= ei; j++) { const s = by.get(cal.dates[j]); if (s) dv += s.c * s.v; }
  p.dv20 = dv;
  if (!(dv >= MIN_DV20)) return { reason: "dvLT2M" };
  const spacP = spacPrice(live);
  return { ev: { symbol: row.symbol, ipoDate: row.ipoDate, X: cal.dates[xi], E: cal.dates[ei], C: cal.dates[ci], month: cal.dates[xi].slice(0, 7), ...p, spacName: !!row.spacName, spacPrice: spacP, spac: !!row.spacName || spacP, i0: lowerBound(cal.dates, row.ipoDate), by, delisted: !!row.delistingDate } };
}
/** all valid placebo net returns for one event, one per candidate k in [PLACEBO_LO, PLACEBO_HI] (same costs, same IWM hedge) */
function placebo(ev, cal, cost) {
  const out = [];
  for (let k = PLACEBO_LO; k <= PLACEBO_HI; k++) {
    const kk = ev.i0 + k, ei = kk - ENTRY_BEFORE, ci = kk + COVER_AFTER;
    if (ci >= cal.dates.length) continue;
    const p = tradeParts(ev.by, cal, ei, ci, null); if (p.reason) continue;
    out.push({ gross: p.gross, net: p.gross - costOf(p, cost) });
  }
  return out;
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const withNet = (evs, cost) => evs.map((e) => ({ ...e, net: e.gross - costOf(e, cost) }));
function stat(rows, key) { const c = CL.clusteredT(rows, (r) => r.month, (r) => r[key]); return { t: c.t, k: c.k, monthMean: c.mean, months: c.keys, monthMeans: c.means }; }
function placeboDraws(evs, cal, cost, draws, seed) {
  const tabs = evs.map((e) => placebo(e, cal, cost)), rnd = rng(seed), usable = tabs.map((t, i) => (t.length ? i : -1)).filter((i) => i >= 0);
  const mm = [], tt = [];
  for (let d = 0; d < draws; d++) {
    const rows = usable.map((i) => ({ month: evs[i].month, v: tabs[i][Math.floor(rnd() * tabs[i].length)].net }));
    const c = CL.clusteredT(rows, (r) => r.month, (r) => r.v); mm.push(c.mean); tt.push(c.t == null ? 0 : c.t);
  }
  const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(p * a.length)];
  return { draws, eventsUsable: usable.length, eventsDropped: evs.length - usable.length, meanOfDraws: mean(mm), p95Mean: q(mm, 0.95), p95T: q(tt, 0.95), meanT: mean(tt), mm };
}
function maxDrawdownUsd(evs, key) {
  const s = [...evs].sort((a, b) => a.C.localeCompare(b.C) || a.symbol.localeCompare(b.symbol)); let cum = 0, pk = 0, dd = 0;
  for (const e of s) { cum += 10000 * e[key]; pk = Math.max(pk, cum); dd = Math.min(dd, cum - pk); }
  return { maxDrawdownUsd: Math.round(dd), endCumUsd: Math.round(cum) };
}
function summarise(evs, cost, label, { withPlacebo, cal }) {
  const rows = withNet(evs, cost);
  const sn = stat(rows, "net"), sg = stat(rows, "gross");
  const months = sn.months, half = Math.ceil(months.length / 2), firstSet = new Set(months.slice(0, half));
  const h1 = rows.filter((r) => firstSet.has(r.month)), h2 = rows.filter((r) => !firstSet.has(r.month));
  const hs = (r) => { if (!r.length) return { n: 0, meanNet: null, t: null, months: 0 }; const s = stat(r, "net"); return { n: r.length, meanNet: s.monthMean, perEventMeanNet: mean(r.map((x) => x.net)), t: s.t, months: s.k }; };
  const span = rows.length ? (dayNum(rows.reduce((m, r) => (r.C > m ? r.C : m), "0000")) - dayNum(rows.reduce((m, r) => (r.E < m ? r.E : m), "9999"))) / 365.25 : 0;
  const net = rows.map((r) => r.net);
  const o = { label, n: rows.length, months: sn.k, tNet: sn.t, tGross: sg.t, meanNet: rows.length ? mean(net) : null, meanGross: rows.length ? mean(rows.map((r) => r.gross)) : null, monthMeanNet: sn.monthMean, monthMeanGross: sg.monthMean,
    winRate: rows.length ? net.filter((x) => x > 0).length / rows.length : null, halves: { first: hs(h1), second: hs(h2), splitAt: months[half] || null },
    dollarsAt10kPerYear: span > 0 ? Math.round(rows.reduce((s, r) => s + 10000 * r.net, 0) / span) : null, dollarsPerEventAt10k: rows.length ? Math.round(10000 * mean(net)) : null, eventsPerYear: span > 0 ? +(rows.length / span).toFixed(1) : null, ...maxDrawdownUsd(rows, "net") };
  if (withPlacebo) {
    const pb = placeboDraws(evs, cal, cost, DRAWS, SEED);
    o.placebo = { p95: pb.p95Mean, observed: sn.monthMean, beats: sn.monthMean > pb.p95Mean, draws: pb.draws, eventsUsable: pb.eventsUsable, eventsDropped: pb.eventsDropped, placeboMeanOfDraws: pb.meanOfDraws, p95T: pb.p95T, observedT: sn.t, fracDrawsAtOrAboveObserved: pb.mm.filter((x) => x >= sn.monthMean).length / pb.draws };
  }
  return o;
}

// ───────────────────────────── selftest ─────────────────────────────
function synthCal(startDate, n, iwmPx) {   // weekday-only calendar
  const bars = []; let d = startDate;
  while (bars.length < n) { const dow = new Date(d + "T00:00:00Z").getUTCDay(); if (dow !== 0 && dow !== 6) bars.push([d, typeof iwmPx === "function" ? iwmPx(bars.length) : iwmPx, 1e7]); d = addDays(d, 1); }
  return bars;
}
function selftest() {
  const res = []; const ok = (name, cond, detail) => { res.push({ name, ok: !!cond, detail }); };
  const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
  // K1: proxy dates, hand-derived. IPO Mon 2019-12-30 + 180d = Sat 2020-06-27 -> X Mon 06-29, E Fri 06-26, C Wed 07-01.
  const cal = makeCal(synthCal("2019-12-30", 420, 100));
  const flat = (px, vol = 1e6, from = "2019-12-30") => cal.dates.filter((d) => d >= from).map((d) => [d, px, vol]);
  const row = (o = {}) => ({ symbol: "TST", name: "Test Inc", ipoDate: "2019-12-30", delistingDate: null, validTo: "9999-12-31", spacName: false, ...o });
  // K2 constant signal: stock flat $50, IWM flat $100 -> gross 0, net = -(costs) by hand = 0.0020+0.0004+0.0004+0.0002+0.10*5/365
  let r = buildEvent(row(), flat(50).map((b, i) => [b[0], 50 + 0.0 * i + (i % 2 ? 0.5 : -0.5) * 0, b[2]]), cal);
  ok("K1 proxy dates X/E/C", r.ev && r.ev.X === "2020-06-29" && r.ev.E === "2020-06-26" && r.ev.C === "2020-07-01", r.ev ? `${r.ev.E}/${r.ev.X}/${r.ev.C}` : r.reason);
  if (r.ev) {
    const hand = 0.0020 + 0.0004 + 0.0004 + 0.0002 + 0.10 * 5 / 365;
    ok("K2 constant signal: gross 0 exactly", approx(r.ev.gross, 0, 1e-15), r.ev.gross);
    ok("K2 net = -(charged cost) = -0.0043699", approx(r.ev.gross - costOf(r.ev, COST), -hand, 1e-12), `${(r.ev.gross - costOf(r.ev, COST)).toFixed(7)} vs ${(-hand).toFixed(7)}`);
  }
  // K3: stock falls exactly 5% over the window (E close 100, C close 95; flat otherwise), IWM flat -> short gross +0.05; net by hand
  const fall = flat(100).map((b) => [b[0], b[0] >= "2020-07-01" ? 95 : 100, b[2]]);
  r = buildEvent(row(), fall, cal);
  if (r.ev) { const hand = 0.05 - (0.0020 + 0.01 / 100 + 0.01 / 95 + 0.0004 + 0.0001 + 0.0001 + 0.10 * 5 / 365); ok("K3 -5% stock: gross +0.05, net by hand", approx(r.ev.gross, 0.05, 1e-12) && approx(r.ev.gross - costOf(r.ev, COST), hand, 1e-12), `${r.ev.gross.toFixed(6)} net ${(r.ev.gross - costOf(r.ev, COST)).toFixed(6)} vs ${hand.toFixed(6)}`); } else ok("K3 -5% stock", false, r.reason);
  // K3b: IWM up 2% across the window with stock flat -> hedge loses nothing, long IWM wins: excess = +0.02 (short stock 0, long IWM +2%)
  const calUp = makeCal(synthCal("2019-12-30", 420, (i) => (i >= 124 ? 102 : 100)));
  const iUp = calUp.dates.indexOf("2020-07-01"); ok("K3b calendar sanity (C index)", iUp > 0, iUp);
  // K4 exclusions
  ok("K4a price $2.50 excluded", buildEvent(row(), flat(2.5, 1e8), cal).reason === "priceLT3");
  ok("K4b dollar volume below $2M excluded", buildEvent(row(), flat(50, 1000), cal).reason === "dvLT2M"); // 50*1000*20=1.0M
  ok("K4c dollar volume at exactly $2M passes (20 x 100k$)", !!buildEvent(row(), flat(50, 2000), cal).ev);   // 50*2000*20=2.0M
  ok("K4d pre-IPO history excluded", buildEvent(row(), [["2019-11-15", 40, 1e6], ...flat(50)], cal).reason === "preIpoHistory");
  ok("K4e late first bar excluded", buildEvent(row(), flat(50, 1e6, "2020-01-20"), cal).reason === "lateFirstBar");
  ok("K4e2 ipoDate before the history floor excluded (AV 2016-01-04 stamp)", buildEvent(row({ ipoDate: "2016-01-04" }), flat(50, 1e6, "2016-01-04"), makeCal(synthCal("2016-01-04", 420, 100))).reason === "historyFloor");
  ok("K4f missing bar at entry excluded", buildEvent(row(), flat(50).filter((b) => b[0] !== "2020-06-26"), cal).reason === "noBarAtEntry");
  ok("K4g missing bar at cover excluded", buildEvent(row(), flat(50).filter((b) => b[0] !== "2020-07-01"), cal).reason === "noBarAtCover");
  const dl = buildEvent(row({ delistingDate: "2020-06-30" }), flat(50).filter((b) => b[0] <= "2020-06-30"), cal);
  ok("K4h delisted before cover uses last close (delisting return)", !!dl.ev && dl.ev.delist === true && dl.ev.pC === 50, dl.reason || "ok");
  ok("K4i SPAC-pinned price path flagged, noisy path not", buildEvent(row(), flat(10.0), cal).ev.spacPrice === true && buildEvent(row(), flat(10).map((b, i) => [b[0], 10 * (1 + 0.04 * Math.sin(i)), b[2]]), cal).ev.spacPrice === false);
  ok("K4j SPAC name flagged", buildEvent(row({ spacName: true }), flat(50), cal).ev.spac === true);
  // K5 cluster statistic: month means 1,2,3 -> t = 2/(1/sqrt3) = 3.4641
  const cs = CL.clusteredT([{ m: "a", v: 1 }, { m: "b", v: 2 }, { m: "c", v: 3 }], (x) => x.m, (x) => x.v); ok("K5 month-clustered t [1,2,3] = 3.464", approx(cs.t, 3.464, 1e-3), cs.t);
  const cs2 = CL.clusteredT([{ m: "a", v: 1 }, { m: "a", v: 3 }, { m: "b", v: 2 }, { m: "c", v: 3 }], (x) => x.m, (x) => x.v); ok("K5b clustering collapses rows to month means (a=2)", approx(cs2.t, 0, 1e-9) === false && cs2.k === 3 && approx(cs2.mean, (2 + 2 + 3) / 3, 1e-4), `${cs2.k} ${cs2.mean}`);
  // K6 placebo on a constant world: every valid window has gross 0 -> placebo net = -cost for every draw, p95 = -cost, observed (-cost) does NOT beat it
  const evs = []; for (let i = 0; i < 12; i++) { const rr = buildEvent(row({ symbol: "T" + i }), flat(50), cal); if (rr.ev) { rr.ev.month = ["2020-06", "2020-07", "2020-08"][i % 3]; evs.push(rr.ev); } }
  const pbd = placeboDraws(evs, cal, COST, 600, 7);
  const base = 0.0020 + 0.0004 + 0.0004 + 0.0002, c3 = base + 0.10 * 3 / 365, c5 = base + 0.10 * 5 / 365;   // a 3-session placebo window holds 3 calendar days (Mon-Thu) or 5 (over a weekend)
  const allPb = []; for (const e of evs) for (const p of placebo(e, cal, COST)) allPb.push(p);
  const inBand = allPb.every((p) => p.gross === 0 && p.net <= -c3 + 1e-12 && p.net >= -c5 - 1e-12) && allPb.some((p) => approx(p.net, -c3, 1e-12)) && allPb.some((p) => approx(p.net, -c5, 1e-12));
  const realNet = withNet(evs, COST).reduce((s, r) => s + r.net, 0) / evs.length;
  ok("K6 constant world: every placebo net is exactly -(charged cost) for its 3- or 5-day hold; p95 within [-c5,-c3]; observed (-c5) does not beat p95", evs.length === 12 && inBand && pbd.p95Mean <= -c3 + 1e-12 && pbd.p95Mean >= -c5 - 1e-12 && !(realNet > pbd.p95Mean), `p95 ${pbd.p95Mean.toFixed(6)} in [${(-c5).toFixed(6)},${(-c3).toFixed(6)}] observed ${realNet.toFixed(6)}; ${allPb.length} placebo windows`);
  ok("K6b placebo window excludes the real window (k<=120 -> cover index < proxy index)", evs[0].i0 + PLACEBO_HI + COVER_AFTER < lowerBound(cal.dates, addDays("2019-12-30", LOCK_DAYS)), "");
  // K7 shuffled world: zero-drift random walks, stock and IWM independent -> |t| of gross small (pre-declared tolerance 3.0), placebo not beaten more often than ~chance
  const rnd = rng(12345), gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
  const walk = (n, sdv) => { let p = 50; const o = []; for (let i = 0; i < n; i++) { p *= Math.exp(sdv * gauss()); o.push(p); } return o; };
  const iw = (() => { let p = 100; return synthCal("2019-12-30", 420, () => (p *= Math.exp(0.01 * gauss()))); })(); const calW = makeCal(iw);
  const evW = []; for (let i = 0; i < 300; i++) { const px = walk(calW.dates.length, 0.03), bars = calW.dates.map((d, j) => [d, px[j], 5e5]); const rr = buildEvent(row({ symbol: "W" + i, ipoDate: addDays("2019-12-30", (i % 60) * 5) }), bars.filter((x) => x[0] >= addDays("2019-12-30", (i % 60) * 5)), calW); if (rr.ev) evW.push(rr.ev); }
  const sW = stat(withNet(evW, { bps: 0, borrow: 0 }), "gross"); const pw = placeboDraws(evW, calW, COST, 500, 99);
  ok("K7 shuffled/random world: |t_gross| < 3 (pre-declared tolerance)", evW.length > 200 && Math.abs(sW.t) < 3, `n ${evW.length} months ${sW.k} t ${sW.t}`);
  ok("K7b placebo machinery live on random world (draws >= 500, usable events > 200)", pw.draws >= 500 && pw.eventsUsable > 200, `${pw.eventsUsable} usable, p95 mean ${pw.p95Mean.toFixed(5)}`);
  // K8 listing parser handles quoted commas
  const pc = parseCsv('symbol,name,ipoDate\nAA,"Foo, Inc.",2020-01-01\nBB,Bar,2021-01-01\n'); ok("K8 CSV parser quoted comma", pc.length === 2 && pc[0].name === "Foo, Inc." && pc[1].ipoDate === "2021-01-01");
  const bad = res.filter((x) => !x.ok);
  for (const x of res) console.log(`  ${x.ok ? "ok  " : "FAIL"} ${x.name}${x.detail !== undefined && x.detail !== "" ? "  [" + x.detail + "]" : ""}`);
  console.log(`selftest: ${res.length - bad.length}/${res.length} known answers ${bad.length ? "FAILED" : "pass"}`);
  return !bad.length;
}

// ───────────────────────────── plan / read ─────────────────────────────
function registryEntry() {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = (reg.preregistered || []).find((x) => x.id === ID);
  if (!t || !t.bar || !(t.bar.tRequired > 0)) throw new Error("R301 registry entry / bar.tRequired missing - cannot read");
  return t;
}
async function main() {
  if (mode === "--selftest") process.exit(selftest() ? 0 : 1);
  const cands = loadCandidates();
  if (mode === "--plan") {
    const byMonth = {}; for (const r of cands) byMonth[r.ipoDate.slice(0, 7)] = (byMonth[r.ipoDate.slice(0, 7)] || 0) + 1;
    console.log(`candidates ${cands.length} (spac-name ${cands.filter((r) => r.spacName).length}, delisted ${cands.filter((r) => r.delistingDate).length}); month batches ${Object.keys(byMonth).length}; est requests ${Object.values(byMonth).reduce((s, n) => s + Math.ceil(n / 25), 0)}`);
    return;
  }
  if (mode === "--fetch") {
    const r = await fillCache(cands);
    console.log(`fetch done: ${r.months} batches, ${r.failed.length} failed${r.failed.length ? " -> " + r.failed.join(",") : ""}`);
    process.exit(r.failed.length ? 2 : 0);
  }
  if (mode === "--coverage") {
    const { iwm } = loadCache(cands), cal = makeCal(iwm); const excl = {}, ev = [], cov = { active: [0, 0], delisted: [0, 0] };
    for (const r of cands) { const has = (r.bars || []).length > 0, k = r.delistingDate ? "delisted" : "active"; cov[k][0]++; if (has) cov[k][1]++; if (!has) { excl.noAlpacaBars = (excl.noAlpacaBars || 0) + 1; continue; } const x = buildEvent(r, r.bars, cal); if (x.reason) excl[x.reason] = (excl[x.reason] || 0) + 1; else ev.push(x.ev); }
    const yr = {}; for (const e of ev) { const y = e.month.slice(0, 4); yr[y] = yr[y] || { all: 0, primary: 0 }; yr[y].all++; if (!e.spac) yr[y].primary++; }
    console.log(JSON.stringify({ iwmFirst: cal.dates[0], iwmLast: cal.dates.at(-1), iwmSessions: cal.dates.length, candidates: cands.length, coverage_active_rows_withBars: cov.active, coverage_delisted_rows_withBars: cov.delisted, exclusions: excl, events: ev.length, primaryEvents: ev.filter((e) => !e.spac).length, spacByName: ev.filter((e) => e.spacName).length, spacByPrice: ev.filter((e) => e.spacPrice).length, delistedEvents: ev.filter((e) => e.delisted).length, delistReturnUsed: ev.filter((e) => e.delist).length, primaryMonths: new Set(ev.filter((e) => !e.spac).map((e) => e.month)).size, eventsByExpiryYear: yr }, null, 1));
    return;
  }
  // ── --read ──
  if (!selftest()) throw new Error("selftest failed - read refused");
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if ((seals.tests && seals.tests[ID]) || fs.existsSync(OUT)) throw new Error("R301 already read/sealed - read-once");
  const reg = registryEntry(), BAR = reg.bar.tRequired;
  const fr = await fillCache(cands); if (fr.failed.length) throw new Error(`fetch incomplete (${fr.failed.length} batches) - re-run; a read on partial data is refused`);
  const { iwm } = loadCache(cands), cal = makeCal(iwm);
  if (cal.dates[0] > "2016-01-04" || cal.dates.length < 2400) throw new Error("IWM calendar short - cannot run");
  const excl = {}, evsAll = [], cover = { rows: cands.length, withBars: 0, delistedRows: 0, delistedWithBars: 0, activeRows: 0, activeWithBars: 0 };
  for (const r of cands) {
    const has = (r.bars || []).length > 0; const dl = !!r.delistingDate;
    cover[dl ? "delistedRows" : "activeRows"]++; if (has) { cover.withBars++; cover[dl ? "delistedWithBars" : "activeWithBars"]++; }
    if (!has) { excl.noAlpacaBars = (excl.noAlpacaBars || 0) + 1; continue; }
    const x = buildEvent(r, r.bars, cal);
    if (x.reason) excl[x.reason] = (excl[x.reason] || 0) + 1; else evsAll.push(x.ev);
  }
  const prim = evsAll.filter((e) => !e.spac), literal = evsAll;
  const P = summarise(prim, COST, "primary: operating-company IPOs (D2 SPAC-like excluded)", { withPlacebo: true, cal });
  const L = summarise(literal, COST, "literal: no SPAC handling (D2 off)", { withPlacebo: true, cal });
  const adv = evsAll.filter((e) => !e.spac && e.dv20 / DV_N >= 2e6);
  const sens = {
    literalNoSpacHandling: L,
    primaryWithAverageDV20_ge_2M: summarise(adv, COST, "primary AND average daily $ volume >= $2M", { withPlacebo: false, cal }),
    primaryNameExclusionOnly: summarise(evsAll.filter((e) => !e.spacName), COST, "SPAC names excluded, price-path rule off", { withPlacebo: false, cal }),
    costGrid: Object.fromEntries([[0.0005, 0], [0.0005, 0.10], [0.0010, 0], [0.0010, 0.10], [0.0010, 0.30], [0.0020, 0.30]].map(([b, br]) => { const s = stat(withNet(prim, { bps: b, borrow: br }), "net"); return [`${b * 1e4}bps_borrow${br * 100}%`, { tNet: s.t, monthMeanNet: s.monthMean, meanNet: mean(withNet(prim, { bps: b, borrow: br }).map((r) => r.net)) }]; })),
  };
  const spacCount = { total: evsAll.length, spacLike: evsAll.filter((e) => e.spac).length, byName: evsAll.filter((e) => e.spacName).length, byPrice: evsAll.filter((e) => e.spacPrice).length };
  const sameSign = P.halves.first.meanNet > 0 && P.halves.second.meanNet > 0;
  const passes = P.tNet != null && P.tNet >= BAR && P.placebo.beats && sameSign;
  const verdict = passes ? "PASS" : "DID NOT PASS";
  const byYear = {}; for (const e of withNet(prim, COST)) { const y = e.month.slice(0, 4); (byYear[y] = byYear[y] || []).push(e.net); }
  const out = {
    id: ID, key: KEY, name: reg.name, rule: reg.rule, readAt: new Date().toISOString(),
    window: { ipos: "2016-01..2026-03", expiriesFirst: prim.reduce((m, e) => (e.X < m ? e.X : m), "9999"), expiriesLast: prim.reduce((m, e) => (e.X > m ? e.X : m), "0000"), discovery: "none registered (single historical read)" },
    unit: "events (net excess = short IPO + long IWM, clustered by expiry month; t over month means)",
    n: P.n, months: P.months, statistic: "month-clustered one-sample t of per-event net excess", bar: BAR, tNet: P.tNet, tGross: P.tGross,
    meanNet: P.meanNet, meanGross: P.meanGross, monthMeanNet: P.monthMeanNet, monthMeanGross: P.monthMeanGross, winRate: P.winRate,
    placebo: P.placebo, halves: P.halves, cells: { primary: P },
    dollarsAt10k: P.dollarsAt10kPerYear, dollarsAt10kNote: "net $/yr if $10k notional is shorted (and $10k IWM bought) on every event, summed, divided by the event span in years; events overlap in time so peak capital is larger than $10k in 2020-21",
    maxDD: P.maxDrawdownUsd, maxDDNote: "USD max peak-to-trough of cumulative net P&L at $10k per event ordered by cover date",
    costModel: `IPO leg $0.01/share + 10 bps per side; IWM hedge leg $0.01/share + 2 bps per side; borrow 10%/yr x calendar days held (assumed, not measured); net = gross - all; cost sensitivity in sensitivities.costGrid`,
    dataSources: ["Alpha Vantage LISTING_STATUS cached CSVs (backend/data/av-listing-status-{active,delisted}-2026-09-23.csv; no new AV call)", "Alpaca SIP daily bars adjustment=all (cached backend/data/training/r301/)", "IWM benchmark = Alpaca SIP daily adjustment=all"],
    exclusions: excl, coverage: { ...cover, spac: spacCount }, byYearMeanNetByExpiryYear: Object.fromEntries(Object.entries(byYear).map(([y, a]) => [y, { n: a.length, meanNet: +mean(a).toFixed(5) }])),
    sensitivities: sens,
    verdictLiteralVariant: (L.tNet != null && L.tNet >= BAR && L.placebo.beats && L.halves.first.meanNet > 0 && L.halves.second.meanNet > 0) ? "PASS" : "DID NOT PASS",
    knownWeaknesses: [
      "Lock-up date is a 180-day PROXY: actual lock-up expiries (early releases, staggered, earnings-linked) and the VC-backed flag (the effect in the literature is VC-only) are not in our data.",
      "AV ipoDate is not a clean IPO date: de-SPAC names carry the shell's IPO date, spin-offs / direct listings / relistings carry an ipoDate with no standard lock-up. SPAC-like names are excluded by D2 (name + price path) but spin-offs, direct listings and de-SPACs whose shell price was not pinned remain as diluting noise.",
      "Borrow is an assumed 10%/yr flat; young small caps are often hard-to-borrow or unborrowable (the short may not be executable at any price) and recall risk is not modelled; 10 bps/side is assumed, not measured.",
      "Filters (price >= $3, dollar volume) use the E close/volume that the MOC order trades at; $0.01/share is applied to adjustment=all prices.",
      "Delisted-name coverage on Alpaca may be incomplete (see coverage.delistedWithBars vs delistedRows); a missing delisted name is a missing short winner, so any shortfall biases AGAINST the rule.",
      "Events cluster in time (2020-21 IPO boom): effective N is expiry MONTHS, and a handful of hot-IPO months may carry the sum; IWM is a small-cap hedge, not a beta-matched hedge for recent-IPO names.",
      "The registered bar (t >= 1.661) is a single-variant bar sized to n=150; sensitivities (literal, ADV, cost grid) are reported but never decide.",
    ],
    verdictScript: verdict,
  };
  writeJsonAtomic(OUT, out);
  const f = (x) => (x == null ? "n/a" : (100 * x).toFixed(3) + "%");
  console.log(`R301 ${verdict}: tNet ${P.tNet} (bar ${BAR}) tGross ${P.tGross}; n ${P.n} events / ${P.months} months; per-event net ${f(P.meanNet)} gross ${f(P.meanGross)}; month-mean net ${f(P.monthMeanNet)}`);
  console.log(`  placebo: observed ${f(P.placebo.observed)} vs p95 ${f(P.placebo.p95)} (placebo mean ${f(P.placebo.placeboMeanOfDraws)}), beats ${P.placebo.beats}; halves first ${f(P.halves.first.meanNet)} (n ${P.halves.first.n}) second ${f(P.halves.second.meanNet)} (n ${P.halves.second.n})`);
  console.log(`  win ${f(P.winRate)}; $/yr at $10k/event ${P.dollarsAt10kPerYear}; maxDD $${P.maxDrawdownUsd}; literal(no SPAC handling) tNet ${L.tNet} meanNet ${f(L.meanNet)}; exclusions ${JSON.stringify(excl)}`);
  console.log(`  output ${OUT}`);
}
main().catch((e) => { console.error("R301 FAILED:", e.message); process.exit(1); });
