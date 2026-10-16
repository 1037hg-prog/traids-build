#!/usr/bin/env node
/**
 * R292 — CLOSING_AUCTION_DEVIATION_FADE (Bogousslavsky & Muravyev, JFM 2023). Registered 2026-09-29 in
 * backend/data/test-registry.json (the registry wins; bar.tRequired is READ FROM THE REGISTRY at run time —
 * it was amended pre-evidence 3.168 -> 2.395 on 2026-09-29).
 *
 * RULE (registry): universe = top 300 US stocks by 60-day dollar volume (point-in-time, ranked on data through t-1 from
 * data/anomaly-cache-v2). Each session t: d = ln(official close / close of the 15:59 one-minute bar). Eligible when
 * |d| >= 20 bps (variants 10 and 30 reported). Trade B (the registered, tradeable, timing-clean read): enter at 16:10 —
 * the opposite side of d at the last after-hours print (last 1-minute bar in 16:01..16:09 ET; a name with no print in
 * that window cannot be filled and is not traded) — exit at the next session's official open. Statistic: per DAY, the
 * equal-weight mean net return across that day's traded names; one-sample t over days (never per ticket).
 *
 * Diagnostics (not in the verdict): B-close (enter AT the official close, exit next open — the judge's buildNotes
 * wording; UNTRADEABLE, the signal is only known after the print, reported as the upper bound); Trade A (16:10 -> 16:40,
 * names with >= 5 after-hours bars in 16:10..16:39, gross+modelled net); |d|<5bps matched placebo; last-5-minute move as the
 * signal (paper: reverses ~5x less); Fama-MacBeth reversal coefficients 2016-19 (paper -0.85); NYSE vs Nasdaq.
 * Trade C (execution twin on the house book's live MOC exits) is FORWARD-ONLY: it cannot be measured historically.
 *
 * WINDOWS: 2016-03-30..2019-12-31 replication (needs 60 sessions of panel history first); 2020-01-01..2026-09-22 SEALED
 * HOLDOUT = the verdict. (Panel ends 2026-09-22; the last signal day's next open, 09-23, comes from the daily fetch.)
 *
 *   node backend/r292-closing-auction-deviation-fade.js --selftest   known answers on a cached 2024-03 sample
 *   node backend/r292-closing-auction-deviation-fade.js --fetch      resumable data pull only (no statistic computed)
 *   node backend/r292-closing-auction-deviation-fade.js --read       the one registered read (refuses if sealed)
 *
 * NOTES (fixed before any outcome):
 *  N1 prices are Alpaca SIP adjustment=all (total return) for daily AND 1-minute so the close/15:59 ratio and the
 *     close->open return are on one basis. Cost in bps uses the adjusted price (slightly higher bps than raw = conservative).
 *  N2 cost = $0.01/share each side + half-spread each side; we have NO after-hours quotes, so the half-spread is MODELLED:
 *     2 bps per side (BUILD.md default) primary; sensitivity at entry half-spread 5 and 10 bps (open leg stays 2 bps).
 *  N3 a day is valid only if >= 100 universe names have a 15:59 bar (drops early-close sessions structurally).
 *  N4 the panel has no hyphenated tickers (class shares such as BRK.B are absent) — disclosed weakness.
 *  N5 exchange tag = current AV listing exchange (NYSE family vs NASDAQ), not point-in-time.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBars: _fetchBars } = require("./lib/alpaca-bars.js");
// eleven builders share one Alpaca key: when the lib's own retries are exhausted on a 429, wait and retry (cached, resumable)
async function fetchBars(syms, o) {
  for (let a = 0; ; a++) {
    try { return await _fetchBars(syms, o); }
    catch (e) {
      const m = String((e && e.message) || e), is429 = /429/.test(m) || (e && e.status === 429);
      if (!is429 || a >= 400) { console.error("R292 fetch rethrow a=" + a + ": " + m); throw e; }
      if (a % 5 === 0) console.error("R292 429 backoff a=" + a);
      await new Promise((r) => setTimeout(r, 20000 + 3000 * Math.min(a, 10)));
    }
  }
}

const D = (f) => path.join(__dirname, "data", f);
const CACHE = D("training/R292"), DAILY = path.join(CACHE, "daily"), INTRA = path.join(CACHE, "intra");
const OUT = D("r292-closing-auction-deviation-fade.json");
const ID = "R292", KEY = "CLOSING_AUCTION_DEVIATION_FADE";
const TOPN = 300, THR = 0.0020, THRS = [0.0010, 0.0020, 0.0030], PLACEBO_THR = 0.0005, MIN_NAMES = 100;
const CENT = 0.01, HS_OPEN = 0.0002, HS_AH = 0.0002, HS_AH_SENS = [0.0005, 0.0010];
const HOLD_START = "2020-01-01", REPL_END = "2019-12-31", DAILY_START = "2016-01-01", DAILY_END = "2026-09-28";
const DRAWS = 1000, CONC = 2;
const mode = ["--selftest", "--read", "--fetch"].find((m) => process.argv.includes(m)) || "--selftest";

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
let _seed = 292292; const rnd = () => ((_seed = (_seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// ─── calendar ────────────────────────────────────────────────────────────────────────────────────────────────────────
function isEDT(date) {                       // US rule since 2007: 2nd Sunday of March .. 1st Sunday of November
  const y = +date.slice(0, 4);
  const nth = (m, n) => { let c = 0; for (let d = 1; d <= 31; d++) { const x = new Date(Date.UTC(y, m, d)); if (x.getUTCMonth() !== m) break; if (x.getUTCDay() === 0 && ++c === n) return d; } };
  const s = `${y}-03-${String(nth(2, 2)).padStart(2, "0")}`, e = `${y}-11-${String(nth(10, 1)).padStart(2, "0")}`;
  return date >= s && date < e;
}
const utcOf = (date, hh, mm, ss = 0) => { const off = isEDT(date) ? 4 : 5; return `${date}T${String(hh + off).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}Z`; };
const etMin = (date, tIso) => { const off = isEDT(date) ? 240 : 300; return (+tIso.slice(11, 13)) * 60 + (+tIso.slice(14, 16)) - off; };   // ET minute-of-day of a bar START

// ─── panel: point-in-time top-300 by trailing 60-day dollar volume (through t-1) ─────────────────────────────────────────
let PAN = null;
function panel() {
  if (PAN) return PAN;
  const dir = D("anomaly-cache-v2"), meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const T = meta.dates.length, N = meta.symbols.length;
  const rd = (f) => { const b = fs.readFileSync(path.join(dir, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  PAN = { dates: meta.dates, syms: meta.symbols, T, N, C: rd("close.f32"), V: rd("vol.f32") };
  return PAN;
}
function universes() {                       // -> { di: [symIdx...] } for di in [60, T-2]
  const p = panel(), { T, N, C, V } = p, sum = new Float64Array(N), cnt = new Int32Array(N), out = {};
  const dv = (s, t) => { const c = C[s * T + t], v = V[s * T + t]; return c > 0 && v > 0 ? c * v : NaN; };
  for (let t = 0; t < 60; t++) for (let s = 0; s < N; s++) { const x = dv(s, t); if (x === x) { sum[s] += x; cnt[s]++; } }
  for (let di = 60; di <= T - 2; di++) {     // window = sessions di-60..di-1 (nothing from t itself)
    const cand = [];
    for (let s = 0; s < N; s++) if (cnt[s] >= 40 && C[s * T + di] > 0) cand.push([s, sum[s] / cnt[s]]);
    cand.sort((a, b) => b[1] - a[1]); out[di] = cand.slice(0, TOPN).map((x) => x[0]);
    for (let s = 0; s < N; s++) { const a = dv(s, di), b = dv(s, di - 60); if (a === a) { sum[s] += a; cnt[s]++; } if (b === b) { sum[s] -= b; cnt[s]--; } }
  }
  return out;
}

// ─── fetch (resumable, cached under data/training/R292/) ─────────────────────────────────────────────────────────────────
async function ensureDaily(symbols) {
  fs.mkdirSync(DAILY, { recursive: true });
  const need = symbols.filter((s) => !fs.existsSync(path.join(DAILY, s + ".json")));
  for (let i = 0; i < need.length; i += 40) {
    const chunk = need.slice(i, i + 40);
    const r = await fetchBars(chunk, { start: DAILY_START, end: DAILY_END, timeframe: "1Day", feed: "sip", adjustment: "all", chunkSize: 40, requireAll: false, quiet: true });
    for (const s of chunk) { const rows = (r.bars[s] || []).map((b) => [b.t.slice(0, 10), b.o, b.c]); writeJsonAtomic(path.join(DAILY, s + ".json"), { s, rows }, { pretty: 0 }); }
    process.stdout.write(`  [daily] ${Math.min(i + 40, need.length)}/${need.length}\r`);
  }
  if (need.length) process.stdout.write("\n");
}
async function fetchDay(date, symbols) {
  const f = path.join(INTRA, date + ".json"); if (fs.existsSync(f)) return;
  const r = await fetchBars(symbols, { start: utcOf(date, 15, 54), end: utcOf(date, 16, 39, 59), timeframe: "1Min", feed: "sip", adjustment: "all", chunkSize: 300, limit: 10000, minIntervalMs: 1500, requireAll: false, quiet: true });
  const rec = {};
  for (const s of symbols) {
    const rows = r.bars[s]; if (!rows || !rows.length) continue;
    let c1554 = 0, c1559 = 0, ahPx = 0, ahMin = 0, n1 = 0, n2 = 0, exPx = 0;
    for (const b of rows) {
      const m = etMin(date, b.t);
      if (m === 954) c1554 = b.c; else if (m === 959) c1559 = b.c;
      else if (m >= 961 && m <= 969) { n1++; ahPx = b.c; ahMin = m; }       // 16:01..16:09  -> entry-window prints
      else if (m >= 970 && m <= 999) { n2++; exPx = b.c; }                   // 16:10..16:39  -> Trade A exit window
    }
    rec[s] = [c1554, c1559, ahPx, ahMin, n1, n2, exPx];
  }
  writeJsonAtomic(f, { date, n: symbols.length, rec }, { pretty: 0 });
}
async function ensureIntra(items) {          // items: [{date, symbols}]
  fs.mkdirSync(INTRA, { recursive: true });
  const todo = items.filter((x) => !fs.existsSync(path.join(INTRA, x.date + ".json"))).sort((a, b) => (a.date >= HOLD_START) === (b.date >= HOLD_START) ? (a.date < b.date ? -1 : 1) : (a.date >= HOLD_START ? -1 : 1));   // sealed holdout first
  let done = 0, i = 0;
  const worker = async () => { while (i < todo.length) { const x = todo[i++]; await fetchDay(x.date, x.symbols); if (++done % 25 === 0) process.stdout.write(`  [intra] ${done}/${todo.length}\r`); } };
  await Promise.all(Array.from({ length: CONC }, worker));
  if (todo.length) process.stdout.write(`  [intra] ${done}/${todo.length} done\n`);
}

// ─── listing exchange tag ───────────────────────────────────────────────────────────────────────────────────────────────
function exchMap() {
  const s = JSON.parse(fs.readFileSync(D("s2-av-listing-cache.json"), "utf8")), m = {};
  for (const r of s.delisted) m[r.sym] = r.exch;
  for (const r of s.active) m[r.sym] = r.exch;     // active wins on a reused ticker
  return (sym) => { const e = m[sym] || ""; return /^NASDAQ/.test(e) ? "NASDAQ" : /NYSE|AMEX/.test(e) ? "NYSE" : "OTHER"; };
}

// ─── build rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const dailyCache = new Map();
function dailyMap(sym) {
  if (dailyCache.has(sym)) return dailyCache.get(sym);
  const f = path.join(DAILY, sym + ".json"); let m = null;
  if (fs.existsSync(f)) { m = new Map(); for (const [d, o, c] of JSON.parse(fs.readFileSync(f, "utf8")).rows) m.set(d, [o, c]); }
  dailyCache.set(sym, m); return m;
}
/** rows for signal-date indices in [from,to] (panel indices). Requires the caches to exist. */
function buildRows(uni, dateFilter) {
  const p = panel(), tag = exchMap(), rows = [], skippedDays = [];
  for (const di of Object.keys(uni).map(Number)) {
    const date = p.dates[di]; if (!dateFilter(date)) continue;
    const f = path.join(INTRA, date + ".json"); if (!fs.existsSync(f)) throw new Error(`intraday cache missing for ${date} — run --fetch`);
    const rec = JSON.parse(fs.readFileSync(f, "utf8")).rec, next = p.dates[di + 1], day = [];
    for (const si of uni[di]) {
      const sym = p.syms[si], x = rec[sym]; if (!x || !(x[1] > 0)) continue;
      const dm = dailyMap(sym); if (!dm) continue;
      const a = dm.get(date), b = dm.get(next); if (!a || !b || !(a[1] > 0) || !(b[0] > 0)) continue;
      const [c1554, c1559, ahPx, ahMin, n1, n2, exPx] = x;
      day.push({ date, sym, ex: tag(sym), close: a[1], open1: b[0], c1554, c1559, ahPx, ahMin, n1, n2, exPx, d: Math.log(a[1] / c1559), m: c1554 > 0 ? Math.log(c1559 / c1554) : NaN });
    }
    if (day.length < MIN_NAMES) { skippedDays.push(date); continue; }     // early-close / thin day (N3)
    for (const r of day) rows.push(r);
  }
  return { rows, skippedDays };
}

// ─── trade definitions: return { gross, cost } per row for a direction s ───────────────────────────────────────────────────
const costOf = (entryPx, exitPx, hsEntry, hsExit) => CENT / entryPx + CENT / exitPx + hsEntry + hsExit;
const tradeB = (r, s, hsAh = HS_AH) => r.n1 >= 1 && r.ahPx > 0 ? { gross: s * (r.open1 / r.ahPx - 1), cost: costOf(r.ahPx, r.open1, hsAh, HS_OPEN) } : null;
const tradeBclose = (r, s) => ({ gross: s * (r.open1 / r.close - 1), cost: costOf(r.close, r.open1, HS_AH, HS_OPEN) });
const tradeA = (r, s) => r.n1 >= 1 && r.n2 >= 5 && r.ahPx > 0 && r.exPx > 0 ? { gross: s * (r.exPx / r.ahPx - 1), cost: costOf(r.ahPx, r.exPx, HS_AH, HS_AH) } : null;

/** per-day series: rows -> [{date, n, gross, net, cost}] using sig(r) -> direction s (0/NaN = skip) and trade(r,s). */
function daySeries(rows, sig, trade) {
  const by = new Map();
  for (const r of rows) {
    const s = sig(r); if (!s) continue; const t = trade(r, s); if (!t) continue;
    let a = by.get(r.date); if (!a) by.set(r.date, (a = { g: 0, c: 0, n: 0 })); a.g += t.gross; a.c += t.cost; a.n++;
  }
  return [...by.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([date, a]) => ({ date, n: a.n, gross: a.g / a.n, cost: a.c / a.n, net: (a.g - a.c) / a.n }));
}
const fade = (thr) => (r) => (Math.abs(r.d) >= thr ? -Math.sign(r.d) : 0);
const summary = (ser) => ({ nDays: ser.length, nTickets: ser.reduce((s, x) => s + x.n, 0), meanNet: ser.length ? mean(ser.map((x) => x.net)) : 0, meanGross: ser.length ? mean(ser.map((x) => x.gross)) : 0, meanCost: ser.length ? mean(ser.map((x) => x.cost)) : 0, tNet: tOf(ser.map((x) => x.net)), tGross: tOf(ser.map((x) => x.gross)) });
const r5 = (x) => +x.toFixed(6);

/** Fama-MacBeth: per-day cross-sectional OLS slope of y on x, then t over days (day-clustered by construction). */
function fmSlope(rows, xf, yf) {
  const by = new Map();
  for (const r of rows) { const x = xf(r), y = yf(r); if (!Number.isFinite(x) || !Number.isFinite(y)) continue; (by.get(r.date) || by.set(r.date, []).get(r.date)).push([x, y]); }
  const sl = [];
  for (const a of by.values()) { if (a.length < 30) continue; const mx = mean(a.map((z) => z[0])), my = mean(a.map((z) => z[1])); let sxy = 0, sxx = 0; for (const [x, y] of a) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; } if (sxx > 0) sl.push(sxy / sxx); }
  return { days: sl.length, slope: sl.length ? mean(sl) : NaN, t: tOf(sl) };
}

// ─── null draws on the traded set ───────────────────────────────────────────────────────────────────────────────────────────
function tradedRows(rows, thr) { const out = []; for (const r of rows) { if (Math.abs(r.d) < thr) continue; const s = -Math.sign(r.d); const t = tradeB(r, s); if (t) out.push({ date: r.date, s, gb: r.open1 / r.ahPx - 1, cost: t.cost }); } return out; }
function nullDraws(tr) {
  const by = new Map(); for (const x of tr) (by.get(x.date) || by.set(x.date, []).get(x.date)).push(x);
  const days = [...by.values()], flipMeans = [], permMeans = [];
  for (let k = 0; k < DRAWS; k++) {
    let f = 0, pm = 0;
    for (const a of days) {
      const flip = rnd() < 0.5 ? 1 : -1;                                        // (a) day sign flip: whole day's direction
      f += a.reduce((s, x) => s + flip * x.s * x.gb - x.cost, 0) / a.length;
      const dirs = a.map((x) => x.s); for (let i = dirs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [dirs[i], dirs[j]] = [dirs[j], dirs[i]]; }
      pm += a.reduce((s, x, i) => s + dirs[i] * x.gb - x.cost, 0) / a.length;   // (b) permute the day's directions across its names
    }
    flipMeans.push(f / days.length); permMeans.push(pm / days.length);
  }
  const p95 = (a) => a.slice().sort((x, y) => x - y)[Math.floor(0.95 * a.length)];
  return { flipP95: p95(flipMeans), permP95: p95(permMeans), flipMean: mean(flipMeans), permMean: mean(permMeans) };
}

// ─── coverage/plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function plan(dateFilter) {
  const p = panel(), uni = universes(), items = [], syms = new Set();
  for (const di of Object.keys(uni).map(Number)) {
    const date = p.dates[di]; if (!dateFilter(date)) continue;
    const symbols = uni[di].map((s) => p.syms[s]); items.push({ date, symbols }); symbols.forEach((s) => syms.add(s));
  }
  // the next-session open must exist: also need daily for the next date (covered by the full-range daily fetch)
  return { uni, items, syms: [...syms].sort() };
}

// ─── selftest ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function selftest() {
  const inSample = (d) => d >= "2024-03-04" && d <= "2024-03-29";
  const pl = plan(inSample);
  console.log(`selftest sample 2024-03: ${pl.items.length} sessions, ${pl.syms.length} distinct names`);
  await ensureDaily(pl.syms); await ensureIntra(pl.items);
  const { rows, skippedDays } = buildRows(pl.uni, inSample);
  const fails = [], ok = (c, msg) => { console.log(`  ${c ? "OK  " : "FAIL"} ${msg}`); if (!c) fails.push(msg); };
  console.log(`  rows ${rows.length}, days ${new Set(rows.map((r) => r.date)).size}, skipped (thin/early-close) ${skippedDays.join(",") || "none"}`);
  // 1. never-trade rule -> nothing traded, zero
  const none = daySeries(rows, fade(1e9), tradeB); ok(none.length === 0, "never-trade rule (|d| >= 1e9) trades nothing: 0 days, active return 0");
  // 2. constant signal: long-all vs short-all mirror exactly; net = gross - cost; and an INDEPENDENT hand recompute from the raw caches
  const lng = daySeries(rows, () => 1, tradeB), sht = daySeries(rows, () => -1, tradeB);
  let mirror = 0, costId = 0; for (let i = 0; i < lng.length; i++) { mirror = Math.max(mirror, Math.abs(lng[i].gross + sht[i].gross)); costId = Math.max(costId, Math.abs(lng[i].net + sht[i].net + 2 * lng[i].cost)); }
  ok(lng.length > 10 && mirror < 1e-12, `long-all gross + short-all gross = 0 on all ${lng.length} days (max |sum| ${mirror.toExponential(1)})`);
  ok(costId < 1e-12, `net(long)+net(short) = -2 x cost on all days (max err ${costId.toExponential(1)})`);
  const p = panel(), byDate = {};                                 // hand path: raw cache files -> per-day mean of (open1/ahPx-1) over names with a print
  for (const di of Object.keys(pl.uni).map(Number)) {
    const date = p.dates[di]; if (!inSample(date) || skippedDays.includes(date)) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(INTRA, date + ".json"), "utf8")).rec, next = p.dates[di + 1], xs = [];
    for (const si of pl.uni[di]) {
      const sym = p.syms[si], x = rec[sym]; if (!x || !(x[1] > 0) || x[4] < 1) continue;
      const dm = JSON.parse(fs.existsSync(path.join(DAILY, sym + ".json")) ? fs.readFileSync(path.join(DAILY, sym + ".json"), "utf8") : '{"rows":[]}').rows;
      const a = dm.find((r) => r[0] === date), b = dm.find((r) => r[0] === next); if (!a || !b) continue;
      xs.push({ g: b[1] / x[2] - 1, c: 0.01 / x[2] + 0.01 / b[1] + 0.0004 });
    }
    if (xs.length) byDate[date] = { g: mean(xs.map((z) => z.g)), c: mean(xs.map((z) => z.c)) };
  }
  let hand = 0; for (const x of lng) { const h = byDate[x.date]; hand = Math.max(hand, h ? Math.abs(h.g - x.gross) + Math.abs(h.c - x.cost) : 1); }
  ok(hand < 1e-9, `constant-long pipeline reproduces the hand computation from raw caches (gross and cost) on every day (max err ${hand.toExponential(1)})`);
  // 3. shuffled signal ~ 0 (deterministic shuffle of directions across ALL traded rows)
  const tr = rows.filter((r) => r.n1 >= 1 && r.ahPx > 0), dirs = tr.map(() => (rnd() < 0.5 ? 1 : -1)), idx = new Map(tr.map((r, i) => [r, dirs[i]]));
  const shuf = daySeries(tr, (r) => idx.get(r), tradeB), ts = tOf(shuf.map((x) => x.gross));
  ok(Math.abs(ts) < 3, `random-direction gross t = ${ts.toFixed(2)} (|t| < 3)`);
  // 4. alignment: the daily close and the 15:59 bar close are the same price up to microstructure noise
  const ad = rows.map((r) => Math.abs(r.d)).sort((a, b) => a - b), med = ad[Math.floor(ad.length / 2)], share20 = ad.filter((x) => x >= 0.002).length / ad.length, p99 = ad[Math.floor(0.99 * ad.length)];
  ok(med < 0.0015, `alignment: median |d| = ${(med * 1e4).toFixed(2)} bps (paper mean auction deviation 2.7 bps large caps; must be < 15 bps)`);
  console.log(`  info: |d|>=20bps on ${(100 * share20).toFixed(2)}% of stock-days; 99th pct |d| = ${(p99 * 1e4).toFixed(1)} bps (paper 63 bps incl. spread); AH-print available on ${(100 * rows.filter((r) => r.n1 >= 1).length / rows.length).toFixed(1)}% of stock-days`);
  console.log(fails.length ? `SELFTEST FAILED (${fails.length})` : "SELFTEST PASSED"); process.exit(fails.length ? 1 : 0);
}

// ─── read ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function read() {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if ((seals.tests && seals.tests[ID]) || fs.existsSync(OUT)) throw new Error(`${ID} already sealed / output exists — read-once`);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((x) => x.id === ID);
  const BAR = reg.bar.tRequired; if (!(BAR > 0)) throw new Error("registry bar.tRequired missing");
  const HOLD_ONLY = process.argv.includes("--holdout-only");   // time-box escape hatch (BUILD.md): replication window skipped, holdout read in full
  const all = HOLD_ONLY ? (d) => d >= HOLD_START : () => true, pl = plan(all);
  await ensureDaily(pl.syms); await ensureIntra(pl.items);
  const { rows: RA, skippedDays } = buildRows(pl.uni, all);
  const repl = RA.filter((r) => r.date <= REPL_END), hold = RA.filter((r) => r.date >= HOLD_START);
  const holdDates = [...new Set(hold.map((r) => r.date))].sort(), mid = holdDates[Math.floor(holdDates.length / 2)];
  const years = holdDates.length / 252;

  const primary = daySeries(hold, fade(THR), tradeB), S = summary(primary);
  const winDays = primary.filter((x) => x.net > 0).length / primary.length;
  const tickets = tradedRows(hold, THR);
  const ticketWinRate = tickets.filter((x) => x.s * x.gb - x.cost > 0).length / tickets.length;
  const nul = nullDraws(tickets);
  const placeboP95 = Math.max(nul.flipP95, nul.permP95), beats = S.meanNet > placeboP95;
  const first = summary(primary.filter((x) => x.date < mid)), second = summary(primary.filter((x) => x.date >= mid));
  const sameSign = Math.sign(first.meanNet) === Math.sign(second.meanNet) && first.meanNet !== 0;
  let v = 1, pk = 1, dd = 0; const byDate = new Map(primary.map((x) => [x.date, x.net]));
  for (const d of holdDates) { v *= 1 + (byDate.get(d) || 0); pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
  const dollars = 10000 * primary.reduce((s, x) => s + x.net, 0) / years;

  // variants + sensitivities
  const variants = {}; for (const th of THRS) variants[`${th * 1e4}bps`] = summary(daySeries(hold, fade(th), tradeB));
  const sens = {}; for (const hs of HS_AH_SENS) sens[`entryHalfSpread${hs * 1e4}bps`] = summary(daySeries(hold, fade(THR), (r, s) => tradeB(r, s, hs)));
  // diagnostics
  const bClose = summary(daySeries(hold, fade(THR), tradeBclose)), tradeAd = summary(daySeries(hold, fade(THR), tradeA));
  const pl1 = summary(daySeries(hold, (r) => (Math.abs(r.d) < PLACEBO_THR && r.d !== 0 ? -Math.sign(r.d) : 0), tradeB));
  const pl2 = summary(daySeries(hold, (r) => (Math.abs(r.m) >= THR ? -Math.sign(r.m) : 0), tradeB));
  const pl2b = summary(daySeries(repl, (r) => (Math.abs(r.m) >= THR ? -Math.sign(r.m) : 0), tradeB));
  const exch = {}; for (const e of ["NYSE", "NASDAQ"]) exch[e] = summary(daySeries(hold.filter((r) => r.ex === e), fade(THR), tradeB));
  const replTrade = summary(daySeries(repl, fade(THR), tradeB)), replClose = summary(daySeries(repl, fade(THR), tradeBclose));
  const fmRepl = { dOnCloseToOpen: fmSlope(repl, (r) => r.d, (r) => Math.log(r.open1 / r.close)), mOnC1559ToOpen: fmSlope(repl, (r) => r.m, (r) => Math.log(r.open1 / r.c1559)), dOnC1559ToOpen: fmSlope(repl, (r) => r.d, (r) => Math.log(r.open1 / r.c1559)) };
  const fmHold = { dOnCloseToOpen: fmSlope(hold, (r) => r.d, (r) => Math.log(r.open1 / r.close)), mOnC1559ToOpen: fmSlope(hold, (r) => r.m, (r) => Math.log(r.open1 / r.c1559)) };
  const absd = hold.map((r) => Math.abs(r.d)).sort((a, b) => a - b);

  const pass = S.tNet >= BAR && beats && sameSign;
  const verdictScript = pass ? "PASS" : "DID NOT PASS";
  const out = {
    id: ID, key: KEY, holdoutOnly: HOLD_ONLY, name: reg.name.slice(0, 120), readAt: new Date().toISOString(),
    rule: "top-300 PIT by 60d $vol; d = ln(official close / 15:59 bar close); |d| >= 20bps; enter 16:10 at last after-hours print (1m bars 16:01-16:09) opposite side of d, exit next official open; equal-weight per day; one-sample t over days",
    window: `sealed holdout ${holdDates[0]}..${holdDates.at(-1)} (replication 2016-03-30..2019-12-31 reported separately)`,
    unit: "days", n: S.nDays, nTickets: S.nTickets, statistic: "per-day equal-weight mean net return of Trade B, one-sample t over days",
    bar: BAR, barSource: "registry bar.tRequired read at run time",
    tNet: r5(S.tNet), tGross: r5(S.tGross), meanNet: r5(S.meanNet), meanGross: r5(S.meanGross), meanCostPerTicket: r5(S.meanCost),
    meanNetBps: +(S.meanNet * 1e4).toFixed(2), meanGrossBps: +(S.meanGross * 1e4).toFixed(2),
    winRate: +winDays.toFixed(4), ticketWinRate: +ticketWinRate.toFixed(4),
    placebo: { p95: r5(placeboP95), observed: r5(S.meanNet), beats, dayFlipP95: r5(nul.flipP95), withinDayPermutationP95: r5(nul.permP95), dayFlipMeanNull: r5(nul.flipMean), permMeanNull: r5(nul.permMean), draws: DRAWS,
      matchedSmallDeviation_lt5bps: { ...pl1, note: "must show no reversal" }, last5MinuteMoveAsSignal_holdout: { ...pl2 }, last5MinuteMoveAsSignal_2016_19: { ...pl2b }, paperClaim: "last-5-min reverses ~5x less than the auction deviation" },
    halves: { first: { from: holdDates[0], to: mid, ...first }, second: { from: mid, to: holdDates.at(-1), ...second }, sameSign },
    dollarsAt10k: Math.round(dollars), dollarsNote: "net $/yr on $10k gross notional deployed each day the rule trades (equal weight across that day's names), zero on no-trade days",
    maxDD: +dd.toFixed(4), costModel: `$0.01/share each side + modelled half-spread ${HS_AH * 1e4} bps at the after-hours entry and ${HS_OPEN * 1e4} bps at the open (NO after-hours quotes exist in our data; BUILD.md 2 bps default). Sensitivity below.`,
    dataSources: ["Alpaca SIP 1Min raw-window 15:54-16:39 ET, adjustment=all, top-300 names per session (data/training/R292/intra)", "Alpaca SIP 1Day adjustment=all (data/training/R292/daily) — official close and next official open", "data/anomaly-cache-v2 (close x volume) point-in-time universe ranked through t-1", "data/s2-av-listing-cache.json exchange tag"],
    variants, costSensitivity: sens, breakEvenNote: `gross ${(S.meanGross * 1e4).toFixed(2)} bps vs charged cost ${(S.meanCost * 1e4).toFixed(2)} bps per ticket`,
    diagnostics: { tradeB_atOfficialClose_UNTRADEABLE_upperBound: bClose, tradeA_1610_to_1640_needs5AHbars: tradeAd, replication_2016_19: { tradeB: replTrade, tradeB_atOfficialClose: replClose, famaMacBeth: fmRepl, paperCoefficient: -0.85 }, holdout_famaMacBeth: fmHold, exchange: exch, tradeC: "FORWARD-ONLY (house-book MOC execution twin) — cannot be measured historically" },
    sample: { holdoutSessions: holdDates.length, replicationSessions: new Set(repl.map((r) => r.date)).size, thinOrEarlyCloseDaysDropped: skippedDays.length, stockDays: hold.length, shareAbsDge20bps: +(absd.filter((x) => x >= 0.002).length / absd.length).toFixed(4), p99AbsDbps: +(absd[Math.floor(0.99 * absd.length)] * 1e4).toFixed(1), shareWithAHprint: +(hold.filter((r) => r.n1 >= 1).length / hold.length).toFixed(4), tradedTicketsPerDay: +(S.nTickets / S.nDays).toFixed(2) },
    knownWeaknesses: [
      "No 4pm NBBO midpoint or after-hours quotes: d is proxied by close vs the 15:59 bar close (includes ordinary last-minute drift), and the after-hours half-spread is MODELLED (2 bps default), not measured — real after-hours spreads on the traded names are plausibly several times wider; see costSensitivity.",
      "Trade B fills are assumed at the last after-hours print with a limit; names with no print in 16:01-16:09 are dropped, so the traded set is the ~thin after-hours subset, and a limit at the last print may not fill in a stale book.",
      "Panel excludes hyphenated tickers (class shares e.g. BRK.B) and the universe is ranked on split/dividend-adjusted price x volume; exchange tag is current listing, not point-in-time.",
      "Alpaca adjustment=all at fetch time: a dividend going ex after the fetch shifts daily vs 1-minute bases only if fetches straddle it (all fetched within hours here).",
      "Trade C (the execution twin) is forward-only and not read here; Trade A is diagnostic (needs >= 5 after-hours bars, wide unquoted spreads).",
    ],
    verdictScript,
  };
  writeJsonAtomic(OUT, out);
  const pc = (x) => (x * 1e4).toFixed(2) + "bps";
  console.log(`\nR292 ${verdictScript}: Trade B net ${pc(S.meanNet)}/day-ticket-avg (gross ${pc(S.meanGross)}, cost ${pc(S.meanCost)}) t ${S.tNet.toFixed(2)} vs bar ${BAR} over ${S.nDays} days (${S.nTickets} tickets)`);
  console.log(`placebo p95 ${pc(placeboP95)} (flip ${pc(nul.flipP95)}, perm ${pc(nul.permP95)}) beats=${beats}; halves ${pc(first.meanNet)} / ${pc(second.meanNet)} same sign=${sameSign}; $/yr on $10k ${Math.round(dollars)}; maxDD ${(100 * dd).toFixed(1)}%`);
  console.log(`replication 2016-19 FM slope of ln(open/close) on d: ${fmRepl.dOnCloseToOpen.slope.toFixed(3)} (t ${fmRepl.dOnCloseToOpen.t.toFixed(1)}, paper -0.85); last-5-min slope ${fmRepl.mOnC1559ToOpen.slope.toFixed(3)}; B-close upper bound t ${bClose.tNet.toFixed(2)}, net ${pc(bClose.meanNet)}`);
}

(async () => {
  if (mode === "--selftest") return selftest();
  if (mode === "--fetch") { const pl = plan(() => true); console.log(`${pl.items.length} sessions, ${pl.syms.length} names`); await ensureDaily(pl.syms); await ensureIntra(pl.items); return; }
  return read();
})().catch((e) => { console.error(`${ID} FAILED:`, e.stack || e.message); process.exit(1); });
