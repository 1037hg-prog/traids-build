#!/usr/bin/env node
/**
 * R314 — BTC FUNDING-RATE EXTREMES (registered 2026-10-02; operator: "test whats outstanding"; idea from Coinbase's Oct-2026
 * positioning report, local only). The frozen spec is the R314 entry of data/test-registry.json (preregistered); this runner
 * implements that entry and nothing else. Harness pattern copied from r310-qs-rsi5.js: selftest -> controls run -> one --read.
 *
 *   SOURCE   registered order, first that serves >= 5 years of free public funding history without login / bot-check bypass:
 *            Binance USDT-M fapi fundingRate BTCUSDT -> Bybit v5 linear BTCUSDT funding history -> BitMEX XBTUSD funding.
 *            A 451/403 (geo-block) moves to the next source; never a proxy. The attempts, the source used and its first/last
 *            print are recorded. BTC/ETH daily candles: Coinbase Exchange public candles (granularity 86400, paged by 300).
 *            Everything is fetched ONCE into data/training/r314/ (one file, sha256 recorded); the read never refetches.
 *   DAILY    funding of UTC day d = sum of the prints stamped in d. A day is COMPLETE only when its prints' funding intervals sum
 *            to exactly 24 h (3 x 8 h, or 1 x 24 h in BitMEX's 2016 daily era); an incomplete day (a missing print, an interval
 *            change day, the delisting day) is MISSING (NaN) — never a short sum read as low funding.
 *   SIGNAL   F7[d] = mean of daily funding d-6..d (all 7 present). z[d] = (F7[d] - mean F7[d-90..d-1]) / sd F7[d-90..d-1]
 *            (window excludes d; all 90 present; sample sd, n-1; sd <= 1e-12 -> z undefined). The last print of d is stamped
 *            <= 20:00 UTC (BitMEX) / 16:00 (Binance/Bybit), so z[d] is known before the Coinbase close of d (00:00 UTC d+1).
 *   RULE     when flat, ENTER at the Coinbase close of the first day d with z[d] <= -1.5; HOLD exactly 14 calendar days; EXIT at
 *            the close of d+14. No entry while holding (days d+1..d+13). The exit day may re-enter at the same close after the
 *            exit (house convention, r310 simulate()); the next-day re-entry and crossing-only readings are reported as
 *            sensitivities. net = exit/entry - 1 - 0.0050. A trade whose exit is after the last complete candle is OPEN:
 *            reported, not counted.
 *   WINDOW   entries from the first day with 90 + 7 days of funding history (first print day + 96) through 2026-09-30 —
 *            the registered procedural definition, applied to the source that served (see implementationNotes).
 *   STAT     unit TRADE; mean net; plain one-sample t (sd n-1). Bar read from the registry (bar.tRequired).
 *   GATES    >= 25 trades, mean > 0, t >= bar, random-hold placebo p95 beaten, both halves (by date) > 0, leak calibration
 *            (whole-rule false-pass on >= 200 30-day block shuffles of funding) <= 5%, positive control t >= 3.
 *            CANNOT MEASURE if no listed source serves >= 5 years, or < 25 trades.
 *   CALIBRATION (controls run, no real-funding statistic): the whole rule on 2,000 30-day block shuffles of BTC funding (registered
 *            leak test; seeds s*7919+3140) and every circular shift k in [365, len-365] (diagnostic), real prices. If the gate set in
 *            force false-passes > 5%, the read is HELD and the controls file carries proposedAmendment (runnerGates "placebo:p975": the
 *            same placebo, gate at p97.5). Reported beside it: the exclusion ablation (placebo with no exclusion; observed trades
 *            de-clustered to one per back-to-back episode) that locates the miscalibration in the same-year-minus-real-windows pool.
 *            The gate set in force is read from the registry (amendments[].runnerGates, preEvidence: true) at controls AND read time;
 *            the read refuses unless the controls file was produced by this runner, on this cache, under the same tokens.
 *
 *   node backend/r314-btc-funding-extremes.js --selftest | (no flag: controls run, prints READY / NOT READY) | --read
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R314", STEM = "r314-btc-funding-extremes", READ = process.argv.includes("--read"), SELFTEST_ONLY = process.argv.includes("--selftest");
const OUT = D(`${STEM}.json`), CTRL = D(`${STEM}-controls.json`);
const CACHE_DIR = path.join(__dirname, "data", "training", "r314"), CACHE = path.join(CACHE_DIR, "funding-candles-to-20261001.json");
const CACHE_REL = "backend/data/training/r314/funding-candles-to-20261001.json";
const FUND_START_ISO = "2016-01-01T00:00:00.000Z", FUND_END_MS = Date.UTC(2026, 9, 1);       // prints stamped before 2026-10-01 00:00 UTC
const CANDLE_START = "2015-07-01", LAST_BAR = "2026-10-01", ENTRY_TO = "2026-09-30";
const HOLD = 14, Z_ENTRY = -1.5, Z_HIGH = 1.5, F_WIN = 7, Z_WIN = 90, COST = 0.005;
const MIN_TRADES = 25, MIN_YEARS = 5, POS_T = 3, LEAK_MAX = 0.05;
// leak shuffles: seeds s*7919+3140 (s = 1..2000) — NOT the s*7919+314 (s = 1..500) family the p97.5 amendment was chosen on (repair
// 2026-10-02), so the controls file calibrates the amended gate set out of sample. Circular diagnostic: every shift k in [365, len-365].
const PLACEBO_DRAWS = 1000, PLACEBO_SEED = 314, LEAK_SHUFFLES = 2000, LEAK_SEED = (s) => s * 7919 + 3140, LEAK_BLOCK = 30, SHIFT_MIN = 365;
const SD_EPS = 1e-12, DAY = 86400000, H8 = 8 * 3600000;
// Pre-read decision tokens the runner understands (registry amendments[] { date, preEvidence: true, field, was, becomes, why,
// runnerGates }). With no token the registered gates and window are in force. Unknown / malformed -> the read is refused.
// The controls run calibrates the gate set IN FORCE; a changed token set requires a fresh controls run before the read.
const RUNNER_GATES = {
  "placebo:p975": "placebo gate = observed mean > the random-hold placebo p97.5 (sorted[floor(0.975*draws)]) instead of p95; p95 still reported",
  "window:entries-from-YYYY-MM-DD": "entries (and placebo days) only from that date (>= the registered window start)",
};
const PLACEBO_Q = { p95: 0.95, p975: 0.975, p99: 0.99 };
const fin = Number.isFinite;
const r4 = (x) => (x == null || !fin(x) ? null : +x.toFixed(4)), r3 = (x) => (x == null || !fin(x) ? null : +x.toFixed(3)), r1 = (x) => (x == null || !fin(x) ? null : +x.toFixed(1));
const pct = (x) => (x == null || !fin(x) ? null : +(100 * x).toFixed(4));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10), dayMs = (d) => Date.parse(d + "T00:00:00Z");
function dayRange(a, b) { const out = []; for (let t = dayMs(a), e = dayMs(b); t <= e; t += DAY) out.push(dayOf(t)); return out; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function sdS(a) { const n = a.length; if (n < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1)); }
function tStat(a) { const n = a.length; if (n < 2) return null; const s = sdS(a); return s > 0 ? mean(a) / (s / Math.sqrt(n)) : null; }
const nearestRank = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null);

// ── funding rows -> daily funding ─────────────────────────────────────────────────────────────────────────────────────────
// BitMEX fundingInterval is an offset from 2000-01-01T00:00Z ("2000-01-01T08:00:00.000Z" = 8 h, "2000-01-02T00:00:00.000Z" = 24 h).
const parseIntervalMs = (s) => Date.parse(s) - Date.UTC(2000, 0, 1);
// rows [[timeMs, rate, intervalMs]] -> deduplicated by time (identical duplicates only; a conflicting duplicate throws), sorted,
// prints stamped at or after FUND_END_MS dropped.
function normalizeFunding(rows, endMs = FUND_END_MS) {
  const by = new Map();
  for (const [t, r, iv] of rows) {
    if (!fin(t) || !fin(r) || !fin(iv) || iv <= 0) throw new Error(`funding row not finite: ${JSON.stringify([t, r, iv])}`);
    if (t >= endMs) continue;
    if (by.has(t)) { const p = by.get(t); if (p[1] !== r || p[2] !== iv) throw new Error(`conflicting funding prints at ${new Date(t).toISOString()}`); continue; }
    by.set(t, [t, r, iv]);
  }
  return [...by.values()].sort((a, b) => a[0] - b[0]);
}
function dailyFunding(rows, days) {
  const idx = new Map(days.map((d, i) => [d, i])), sum = new Array(days.length).fill(0), hrs = new Array(days.length).fill(0), cnt = new Array(days.length).fill(0);
  for (const [t, r, iv] of rows) { const i = idx.get(dayOf(t)); if (i === undefined) continue; sum[i] += r; hrs[i] += iv; cnt[i]++; }
  const fund = new Array(days.length).fill(NaN), incomplete = [];
  let first = -1, last = -1;
  for (let i = 0; i < days.length; i++) if (cnt[i]) { if (first < 0) first = i; last = i; }
  for (let i = 0; i < days.length; i++) {
    if (hrs[i] === DAY) fund[i] = sum[i];
    else if (first >= 0 && i >= first && i <= last) incomplete.push({ day: days[i], prints: cnt[i], hours: hrs[i] / 3600000 });
  }
  return { fund, incomplete, firstPrintIdx: first, lastPrintIdx: last };
}
// F7 and the trailing-90 z of F7 (window d-90..d-1, today excluded), every input present, sample sd.
function f7z(fund) {
  const N = fund.length, F7 = new Array(N).fill(NaN), z = new Array(N).fill(NaN), sd = new Array(N).fill(NaN);
  for (let i = F_WIN - 1; i < N; i++) { let s = 0, ok = true; for (let k = i - F_WIN + 1; k <= i; k++) { if (!fin(fund[k])) { ok = false; break; } s += fund[k]; } if (ok) F7[i] = s / F_WIN; }
  for (let i = Z_WIN; i < N; i++) {
    if (!fin(F7[i])) continue;
    let s = 0, ok = true; for (let k = i - Z_WIN; k < i; k++) { if (!fin(F7[k])) { ok = false; break; } s += F7[k]; }
    if (!ok) continue;
    const m = s / Z_WIN; let v = 0; for (let k = i - Z_WIN; k < i; k++) v += (F7[k] - m) * (F7[k] - m);
    const sdv = Math.sqrt(v / (Z_WIN - 1)); sd[i] = sdv;
    if (sdv > SD_EPS) z[i] = (F7[i] - m) / sdv;
  }
  return { F7, z, sd };
}
// One coin: a contiguous UTC calendar from the first funding print day to LAST_BAR; daily funding, z, Coinbase close.
function buildCoin(fundRows, candleRows, { lastBar = LAST_BAR } = {}) {
  if (!fundRows.length) throw new Error("no funding rows");
  const days = dayRange(dayOf(fundRows[0][0]), lastBar), idx = new Map(days.map((d, i) => [d, i]));
  const df = dailyFunding(fundRows, days), close = new Array(days.length).fill(NaN);
  for (const r of candleRows) { const i = idx.get(r[0]); if (i !== undefined) close[i] = r[4]; }
  const { F7, z, sd } = f7z(df.fund);
  return { days, idx, fund: df.fund, close, F7, z, sd, incomplete: df.incomplete, firstPrintIdx: df.firstPrintIdx, lastPrintIdx: df.lastPrintIdx };
}
const withFunding = (S, fund) => { const { F7, z, sd } = f7z(fund); return { ...S, fund, F7, z, sd }; };
// the registered window: first day with 90 + 7 days of funding history (first print day + 96) .. ENTRY_TO; optional later start
function windowOf(S, dec = { from: null }) {
  const reg = 96, toIdx = Math.min(S.days.length - 1, S.idx.has(ENTRY_TO) ? S.idx.get(ENTRY_TO) : S.days.length - 1);
  let from = reg;
  if (dec && dec.from) { const k = S.idx.get(dec.from); if (k === undefined || k < reg) throw new Error(`window token date ${dec.from} is outside the calendar or before the registered start ${S.days[reg]}`); from = k; }
  return { from, to: toIdx, fromDate: S.days[from], toDate: S.days[toIdx], registeredFromDate: S.days[reg] };
}

// ── the rule ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const zLE = (S, th) => (i) => fin(S.z[i]) && S.z[i] <= th;
const zGE = (S, th) => (i) => fin(S.z[i]) && S.z[i] >= th;
const crossLE = (S, th) => (i) => fin(S.z[i]) && S.z[i] <= th && !(i > 0 && fin(S.z[i - 1]) && S.z[i - 1] <= th);
// reentry "exit-day": the exit day's close may open the next trade (house convention); "next-day": first day after the exit day.
function simulate(S, sig, { from, to, hold = HOLD, cost = COST, reentry = "exit-day" } = {}) {
  const last = S.days.length - 1, closed = [], open = [], unpriced = []; let noCandle = 0, i = from;
  while (i <= to) {
    if (!sig(i)) { i++; continue; }
    if (!fin(S.close[i])) { noCandle++; i++; continue; }
    const u = i + hold, base = { t: i, entryDate: S.days[i], year: S.days[i].slice(0, 4), entry: S.close[i] };
    if (u > last) { open.push({ ...base, markDate: S.days[last], mark: S.close[last], markGross: fin(S.close[last]) ? S.close[last] / S.close[i] - 1 : null }); break; }
    if (!fin(S.close[u])) unpriced.push({ ...base, u, exitDate: S.days[u] });
    else { const gross = S.close[u] / S.close[i] - 1; closed.push({ ...base, u, exitDate: S.days[u], exit: S.close[u], gross, net: gross - cost }); }
    i = reentry === "next-day" ? u + 1 : u;
  }
  return { closed, open, unpriced, noCandle };
}
// The same entry loop on z and dates only — no price is read (outcome-free count for the controls run).
function entriesOutcomeFree(S, { from, to, hold = HOLD } = {}) {
  const last = S.days.length - 1, sig = zLE(S, Z_ENTRY); let n = 0, closable = 0, open = 0, episodes = 0, prev = -Infinity, i = from; const years = {}, ts = [];
  while (i <= to) { if (!sig(i)) { i++; continue; } n++; ts.push(i); if (i !== prev + hold) episodes++; prev = i; years[S.days[i].slice(0, 4)] = (years[S.days[i].slice(0, 4)] || 0) + 1; if (i + hold > last) { open++; break; } closable++; i += hold; }
  return { entries: n, closable, open, episodes, byYear: years, ts };
}
// back-to-back episodes: a trade entered on the previous trade's exit day continues that episode
const episodesOf = (closed) => closed.filter((x, k) => !(k > 0 && x.t === closed[k - 1].u)).length;
function summarise(trades) {
  const nets = trades.map((x) => x.net), n = nets.length;
  if (!n) return { n: 0, meanNet: null, tNet: null, winRate: null, halves: { first: { n: 0, meanNet: null }, second: { n: 0, meanNet: null } } };
  const srt = [...trades].sort((a, b) => a.t - b.t), h = Math.floor(n / 2), A = srt.slice(0, h), B = srt.slice(h);
  const half = (s) => (s.length ? { n: s.length, meanNet: mean(s.map((x) => x.net)), meanNetPct: pct(mean(s.map((x) => x.net))), from: s[0].entryDate, to: s[s.length - 1].entryDate } : { n: 0, meanNet: null });
  return { n, meanNet: mean(nets), meanNetPct: pct(mean(nets)), sdNet: sdS(nets), tNet: tStat(nets), winRate: nets.filter((x) => x > 0).length / n, halves: { first: half(A), second: half(B) } };
}

// ── random 14-day-hold placebo (as registered) ───────────────────────────────────────────────────────────────────────────
// Per real counted trade (entry year Y): a day i of the SAME calendar year, inside the window [from, to], with both closes present
// and i + hold <= last bar, whose return window (i, i+hold] does not overlap ANY real trade window (t, t+hold] — closed, unpriced or
// open (an open window runs to the end of the data). Draws are independent across trades (placebo entries may overlap each other).
// Statistic = mean net over the drawn holds; 1,000 draws; p95 = sorted[floor(0.95 * draws)] (r310 convention). A trade whose year has
// no eligible day is dropped from every draw (recorded). exclude: false (ablation in the controls run only, never a gate) keeps the
// real windows in the pool — the same calendar year, no blocking.
function placeboPrep(S, sim, { from, to, hold = HOLD, exclude = true } = {}) {
  const N = S.days.length, last = N - 1, blocked = new Uint8Array(N);
  if (exclude) for (const x of [...sim.closed, ...sim.unpriced]) for (let i = Math.max(0, x.t - hold + 1); i <= Math.min(last, x.t + hold - 1); i++) blocked[i] = 1;
  if (exclude) for (const x of sim.open) for (let i = Math.max(0, x.t - hold + 1); i <= last; i++) blocked[i] = 1;
  const byYear = new Map();
  for (let i = from; i <= to; i++) {
    if (blocked[i] || i + hold > last || !fin(S.close[i]) || !fin(S.close[i + hold])) continue;
    const y = S.days[i].slice(0, 4); (byYear.get(y) || byYear.set(y, []).get(y)).push(i);
  }
  const slots = [], dropped = [];
  for (const x of sim.closed) { const c = byYear.get(x.year) || []; if (!c.length) { dropped.push({ entryDate: x.entryDate, year: x.year }); continue; } slots.push({ year: x.year, t: x.t, cands: c, gross: c.map((i) => S.close[i + hold] / S.close[i] - 1) }); }
  return { slots, dropped, eligibleByYear: Object.fromEntries([...byYear.entries()].map(([y, c]) => [y, c.length])) };
}
function placeboRun(pp, { draws = PLACEBO_DRAWS, seed = PLACEBO_SEED, cost = COST, record = null } = {}) {
  if (!pp.slots.length) return { draws, seed, p95: null, p975: null, p99: null, p50: null, p05: null, meanOfDraws: null, slots: 0, sdOfDraws: null };
  const rng = mulberry(seed), stat = new Array(draws);
  for (let k = 0; k < draws; k++) { let s = 0; for (const sl of pp.slots) { const j = Math.floor(rng() * sl.cands.length), v = sl.gross[j] - cost; s += v; if (record) record(sl, sl.cands[j], v); } stat[k] = s / pp.slots.length; }
  const sorted = [...stat].sort((a, b) => a - b), q = (p) => sorted[Math.floor(p * draws)];
  return { draws, seed, slots: pp.slots.length, p95: q(0.95), p975: q(0.975), p99: q(0.99), p50: q(0.5), p05: q(0.05), meanOfDraws: mean(stat), sdOfDraws: Math.sqrt(stat.reduce((s, x) => s + (x - mean(stat)) ** 2, 0) / draws) };
}
// the per-sample gates of decisionRule.pass (leak calibration and positive control are global and applied in the read);
// q = the placebo quantile in force ("p95" registered, "p975" under placebo:p975)
const placeboGateKey = (q) => (q === "p95" ? "placeboP95Beaten" : `placebo${q.toUpperCase()}Beaten`);
function sampleGates(S, sim, win, bar, { draws = PLACEBO_DRAWS, seed = PLACEBO_SEED, q = "p95" } = {}) {
  const sm = summarise(sim.closed), pp = placeboPrep(S, sim, win), pl = placeboRun(pp, { draws, seed });
  const core = { tradesAtLeast25: sm.n >= MIN_TRADES, meanNetPositive: sm.meanNet != null && sm.meanNet > 0, tAtLeastBar: sm.tNet != null && sm.tNet >= bar,
    bothHalvesPositive: sm.halves.first.meanNet != null && sm.halves.second.meanNet != null && sm.halves.first.meanNet > 0 && sm.halves.second.meanNet > 0 };
  const beats = Object.fromEntries(Object.keys(PLACEBO_Q).map((k) => [k, sm.meanNet != null && pl[k] != null && sm.meanNet > pl[k]]));
  const gates = { tradesAtLeast25: core.tradesAtLeast25, meanNetPositive: core.meanNetPositive, tAtLeastBar: core.tAtLeastBar, [placeboGateKey(q)]: beats[q], bothHalvesPositive: core.bothHalvesPositive };
  const corePass = Object.values(core).every(Boolean);
  return { sm, pp, pl, gates, pass: Object.values(gates).every(Boolean), corePass, beats, passAt: Object.fromEntries(Object.keys(PLACEBO_Q).map((k) => [k, corePass && beats[k]])) };
}
function verdictOf(gates, { coverageYears }) {
  const why = [];
  if (!(coverageYears >= MIN_YEARS)) why.push(`no listed source served >= ${MIN_YEARS} years of funding history (${r3(coverageYears)} y)`);
  if (!gates.tradesAtLeast25) why.push(`fewer than ${MIN_TRADES} counted trades`);
  if (why.length) return `CANNOT MEASURE — ${why.join("; ")}`;
  return Object.values(gates).every(Boolean) ? "PASS" : "DID NOT PASS";
}

// ── no-edge transforms of the funding series ─────────────────────────────────────────────────────────────────────────────
function blockShuffle(a, block, rng) { const b = []; for (let i = 0; i < a.length; i += block) b.push(a.slice(i, i + block)); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b.flat(); }
const circularShift = (a, k) => a.map((_, i) => a[(i + k) % a.length]);
// the longest run of present daily funding (the shuffles act on it only, so a missing day is never moved into the evidence window)
function longestRun(fund) { let best = [0, -1], s = -1; for (let i = 0; i <= fund.length; i++) { if (i < fund.length && fin(fund[i])) { if (s < 0) s = i; } else if (s >= 0) { if (i - 1 - s > best[1] - best[0]) best = [s, i - 1]; s = -1; } } return { a: best[0], b: best[1] }; }
function onSegment(fund, seg, f) { const out = [...fund], mid = f(fund.slice(seg.a, seg.b + 1)); for (let i = 0; i < mid.length; i++) out[seg.a + i] = mid[i]; return out; }

// ── pre-read decision (window token only) ────────────────────────────────────────────────────────────────────────────────
function preReadDecision(entry) {
  const am = (entry && Array.isArray(entry.amendments) ? entry.amendments : []).filter((a) => a && Array.isArray(a.runnerGates));
  if (!am.length) return { decided: true, tokens: [], from: null, q: "p95", meaning: "no runnerGates amendment: the registered window and gates are in force" };
  if (am.some((a) => a.preEvidence !== true)) return { decided: false, why: "a runnerGates amendment is not marked preEvidence: true" };
  const tokens = [...new Set(am.flatMap((a) => a.runnerGates))].sort(), win = tokens.filter((g) => /^window:entries-from-\d{4}-\d{2}-\d{2}$/.test(g));
  const unknown = tokens.filter((g) => !win.includes(g) && g !== "placebo:p975"); if (unknown.length) return { decided: false, why: `unknown runnerGates ${JSON.stringify(unknown)}` };
  if (win.length > 1) return { decided: false, why: `more than one window token ${JSON.stringify(win)}` };
  const from = win.length ? win[0].slice("window:entries-from-".length) : null;
  if (from && (!fin(dayMs(from)) || dayOf(dayMs(from)) !== from)) return { decided: false, why: `malformed date in ${win[0]}` };
  return { decided: true, tokens, from, q: tokens.includes("placebo:p975") ? "p975" : "p95", dates: am.map((a) => a.date || null),
    meaning: tokens.map((g) => `${g}: ${RUNNER_GATES[g.startsWith("window:") ? "window:entries-from-YYYY-MM-DD" : g]}`) };
}

// ── known-answer selftest (runs before any fetch, in every mode) ─────────────────────────────────────────────────────────
function synthS(n, start, closeFn) { const days = dayRange(start, dayOf(dayMs(start) + (n - 1) * DAY)); return { days, idx: new Map(days.map((d, i) => [d, i])), close: days.map((_, i) => closeFn(i)), z: new Array(n).fill(NaN) }; }
function selftest() {
  const checks = {}, detail = {}, T = (d, hh, mm = 0, ss = 0, ms = 0) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), hh, mm, ss, ms);
  // (a) BitMEX interval encoding
  checks.a_intervalParse = parseIntervalMs("2000-01-01T08:00:00.000Z") === H8 && parseIntervalMs("2000-01-02T00:00:00.000Z") === DAY;
  // (b) daily funding: 3x8h complete; 1x24h complete; 2x8h incomplete; 24h+8h (interval change) incomplete; 23:59:59.999 belongs to its day;
  //     00:00:00.000 to the next; a print at FUND_END dropped; identical duplicate kept once; conflicting duplicate throws
  { const rows = normalizeFunding([
      [T("2020-01-01", 4), 0.0001, H8], [T("2020-01-01", 12), 0.0002, H8], [T("2020-01-01", 20), 0.0003, H8], [T("2020-01-01", 20), 0.0003, H8],
      [T("2020-01-02", 12), 0.0009, DAY], [T("2020-01-03", 4), 0.0001, H8], [T("2020-01-03", 12), 0.0001, H8],
      [T("2020-01-04", 12), 0.0005, DAY], [T("2020-01-04", 20), 0.0001, H8], [T("2020-01-05", 23, 59, 59, 999), 0.0001, H8],
      [T("2020-01-06", 0), 0.0001, H8], [T("2020-01-06", 8), 0.0001, H8], [T("2020-01-06", 16), 0.0002, H8], [Date.UTC(2020, 0, 7), 0.0009, H8]], Date.UTC(2020, 0, 7));
    const df = dailyFunding(rows, dayRange("2019-12-31", "2020-01-07")), f = df.fund;
    let threw = false; try { normalizeFunding([[1, 0.1, H8], [1, 0.2, H8]]); } catch (e) { threw = true; }
    checks.b_dailyFundingCompleteness = rows.length === 12 && !fin(f[0]) && Math.abs(f[1] - 0.0006) < 1e-15 && f[2] === 0.0009 && !fin(f[3]) && !fin(f[4]) && !fin(f[5]) && Math.abs(f[6] - 0.0004) < 1e-15 && !fin(f[7])
      && df.incomplete.length === 3 && df.incomplete.map((x) => x.day).join() === "2020-01-03,2020-01-04,2020-01-05" && df.incomplete[1].hours === 32 && df.firstPrintIdx === 1 && df.lastPrintIdx === 6 && threw;
    detail.b_fund = f; }
  // (c) F7 / z by hand: daily[i] = i -> F7[i] = i-3; the 90 prior F7 are 90 consecutive integers (mean i-48.5, sample var 90*91/12)
  //     -> z = 45.5 / sqrt(682.5) from index 96 (90 + 7 days of history) on; a missing day blanks F7 for 7 days and z for 97;
  //     a constant series has sd 0 -> z undefined
  { const a = Array.from({ length: 300 }, (_, i) => i), r = f7z(a), zk = 45.5 / Math.sqrt(682.5);
    const b = [...a]; b[150] = NaN; const rb = f7z(b), rc = f7z(new Array(200).fill(0.0003));
    checks.c_f7zHandComputed = !fin(r.F7[5]) && r.F7[6] === 3 && r.F7[200] === 197 && !fin(r.z[95]) && Math.abs(r.z[96] - zk) < 1e-12 && Math.abs(r.z[299] - zk) < 1e-12
      && fin(rb.z[149]) && rb.z.slice(150, 247).every((x) => !fin(x)) && fin(rb.z[247]) && rc.z.every((x) => !fin(x)) && Math.abs(r.sd[96] - Math.sqrt(682.5)) < 1e-9;
    detail.c_z96 = r.z[96]; }
  // (d) simulation: entry on the first flat day with z <= -1.5 (inclusive); signals while holding ignored; exit-day re-entry (house);
  //     next-day and crossing-only readings; no entry outside [from, to]; no entry without a close; missing exit close -> unpriced; open at end
  { const S = synthS(100, "2020-01-01", (i) => 100 + i + (i % 3)); S.close[70] = NaN; S.close[89] = NaN;
    for (const [i, v] of [[3, -5], [10, -2], [11, -2], [24, -1.6], [38, -1.5], [51, -2], [52, -2], [60, -1.49], [70, -2], [75, -2], [90, -3]]) S.z[i] = v;
    const w = { from: 5, to: 95 }, a = simulate(S, zLE(S, -1.5), w), b = simulate(S, zLE(S, -1.5), { ...w, reentry: "next-day" }), c = simulate(S, crossLE(S, -1.5), w);
    const ts = (s) => s.closed.map((x) => x.t).join();
    checks.d_simulateDefault = ts(a) === "10,24,38,52" && a.closed.every((x) => x.u === x.t + 14 && x.gross === S.close[x.u] / S.close[x.t] - 1 && x.net === x.gross - COST)
      && a.unpriced.length === 1 && a.unpriced[0].t === 75 && a.noCandle === 1 && a.open.length === 1 && a.open[0].t === 90;
    checks.d_simulateReadings = ts(b) === "10,38" && b.open.length === 1 && ts(c) === "10,24,38" && c.open[0].t === 90 && b.unpriced.length === 1 && b.unpriced[0].t === 75;
    const oc = entriesOutcomeFree(S, w);
    // price-blind: day 70 (no candle) counts as an entry 70 -> 84, so 75 is inside that hold: entries 10, 24, 38, 52, 70, 90(open)
    // episodes: 10 -> 24 -> 38 -> 52 back-to-back (one), 70 (two), 90 (three); closed-trade episodes of the default run: 10..52 = one
    checks.d_outcomeFreeCountMatches = oc.entries === 6 && oc.closable === 5 && oc.open === 1 && oc.episodes === 3 && oc.ts.join() === "10,24,38,52,70,90" && episodesOf(a.closed) === 1;
    detail.d = { def: ts(a), next: ts(b), cross: ts(c), oc }; }
  // (e) t by hand; halves by date (n=5 -> 2 / 3)
  { const tr = [5, 1, 4, 2, 3].map((v, k) => ({ t: [4, 0, 3, 1, 2][k], entryDate: `2020-01-0${[4, 0, 3, 1, 2][k] + 1}`, net: v }));
    const sm = summarise(tr);
    checks.e_tAndHalves = Math.abs(tStat([1, 2, 3, 4]) - 3.872983346207417) < 1e-12 && tStat([1, 1, 1]) === null && sm.n === 5 && sm.halves.first.n === 2 && sm.halves.first.meanNet === 1.5 && sm.halves.second.meanNet === 4 && sm.winRate === 1; }
  // (f) placebo: same calendar year, inside the window, disjoint from every real window (closed / unpriced / open), value exact;
  //     a year with no eligible day drops its trade; p95 index = floor(0.95 * draws)
  { const S = synthS(90, "2018-12-01", (i) => 100 + i + (i % 3) * 0.7), W = { from: 0, to: 89 };
    const sim = { closed: [{ t: 5, year: "2018", entryDate: S.days[5] }, { t: 40, year: "2019", entryDate: S.days[40] }], unpriced: [], open: [{ t: 70 }] };
    const pp = placeboPrep(S, sim, W); let ok = true, n = 0; const seen = { 2018: new Set(), 2019: new Set() };
    const pl = placeboRun(pp, { draws: 400, seed: 7, record: (sl, i, v) => { n++; if (S.days[i].slice(0, 4) !== sl.year) ok = false; if (Math.abs(v - (S.close[i + 14] / S.close[i] - 1 - COST)) > 1e-15) ok = false; seen[sl.year].add(i); } });
    const want18 = [19, 20, 21, 22, 23, 24, 25, 26], want19 = [54, 55, 56];
    checks.f_placeboEligibilityExact = ok && n === 800 && pp.dropped.length === 0 && [...seen[2018]].sort((x, y) => x - y).join() === want18.join() && [...seen[2019]].sort((x, y) => x - y).join() === want19.join();
    const pp2 = placeboPrep(S, { ...sim, open: [{ t: 45 }] }, W);
    checks.f_placeboDropsEmptyYear = pp2.dropped.length === 1 && pp2.dropped[0].year === "2019" && pp2.slots.length === 1;
    // ablation pool (exclude: false): the whole same-year window, i + 14 <= last -> 2018 = days 0..30, 2019 = days 31..75
    const pp3 = placeboPrep(S, sim, { ...W, exclude: false });
    checks.f_placeboNoExclusionAblation = pp3.slots.length === 2 && pp3.slots[0].cands.join() === Array.from({ length: 31 }, (_, i) => i).join() && pp3.slots[1].cands.join() === Array.from({ length: 45 }, (_, i) => 31 + i).join();
    const st = []; const rng = mulberry(7); for (let k = 0; k < 400; k++) { let s = 0; for (const sl of pp.slots) s += sl.gross[Math.floor(rng() * sl.cands.length)] - COST; st.push(s / 2); }
    checks.f_placeboP95Convention = pl.p95 === [...st].sort((x, y) => x - y)[380]; }
  // (g) 30-day block shuffle: same multiset, every output block is one whole input block, deterministic, seed-dependent; segment only
  { const a = Array.from({ length: 95 }, (_, i) => i), s1 = blockShuffle(a, 30, mulberry(1)), s1b = blockShuffle(a, 30, mulberry(1)), s2 = blockShuffle(a, 30, mulberry(2));
    let ok = s1.length === 95 && [...s1].sort((x, y) => x - y).every((x, i) => x === i), p = 0;
    while (ok && p < s1.length) { const v = s1[p]; if (v % 30 !== 0) { ok = false; break; } const len = Math.min(30, 95 - v); for (let k = 0; k < len; k++) if (s1[p + k] !== v + k) ok = false; p += len; }
    const seg = onSegment([NaN, ...a, NaN], { a: 1, b: 95 }, (x) => blockShuffle(x, 30, mulberry(1)));
    checks.g_blockShuffle = ok && s1.join() === s1b.join() && s1.join() !== s2.join() && s1.join() !== a.join() && !fin(seg[0]) && !fin(seg[96]) && seg.slice(1, 96).join() === s1.join(); }
  // (h) circular shift; longest present run
  checks.h_shiftAndRun = circularShift([0, 1, 2, 3, 4], 2).join() === "2,3,4,0,1" && (({ a, b }) => a === 3 && b === 7)(longestRun([1, NaN, NaN, 1, 1, 1, 1, 1, NaN, 1, 1]));
  // (i) verdict logic
  { const G = { tradesAtLeast25: true, meanNetPositive: true, tAtLeastBar: true, placeboP95Beaten: true, bothHalvesPositive: true, leak: true, pc: true };
    checks.i_verdictLogic = verdictOf(G, { coverageYears: 10 }) === "PASS" && verdictOf({ ...G, placeboP95Beaten: false }, { coverageYears: 10 }) === "DID NOT PASS"
      && verdictOf({ ...G, tradesAtLeast25: false }, { coverageYears: 10 }).startsWith("CANNOT MEASURE") && verdictOf(G, { coverageYears: 4.9 }).startsWith("CANNOT MEASURE"); }
  // (j) pre-read window decision parser
  { const A = preReadDecision({}), B = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["window:entries-from-2019-12-15"] }] });
    const C = preReadDecision({ amendments: [{ preEvidence: false, runnerGates: ["window:entries-from-2019-12-15"] }] }), E = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:other"] }] });
    const F = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["window:entries-from-2019-02-30"] }] }), G2 = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["window:entries-from-2019-01-01", "window:entries-from-2020-01-01"] }] });
    const P = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:p975"] }, { preEvidence: true, runnerGates: ["placebo:p975"] }] });
    checks.j_preReadParser = A.decided && A.from === null && A.q === "p95" && B.decided && B.from === "2019-12-15" && B.q === "p95" && !C.decided && !E.decided && !F.decided && !G2.decided
      && P.decided && P.q === "p975" && P.tokens.length === 1 && P.from === null; }
  // (n) placebo quantiles: p975 / p99 at floor(q * draws); the gate in force switches with q; a mean between p95 and p975 passes p95 only
  { const S = synthS(90, "2018-12-01", (i) => 100 + i + (i % 3) * 0.7), sim = { closed: [{ t: 5, year: "2018", entryDate: S.days[5], net: 0 }, { t: 40, year: "2019", entryDate: S.days[40], net: 0 }], unpriced: [], open: [{ t: 70 }] };
    const W = { from: 0, to: 89 }, pp = placeboPrep(S, sim, W), pl = placeboRun(pp, { draws: 400, seed: 7 }), st = []; const rng = mulberry(7);
    for (let k = 0; k < 400; k++) { let s = 0; for (const sl of pp.slots) s += sl.gross[Math.floor(rng() * sl.cands.length)] - COST; st.push(s / 2); } st.sort((x, y) => x - y);
    const mid = (pl.p95 + pl.p975) / 2, simM = { ...sim, closed: sim.closed.map((x) => ({ ...x, net: mid })) };
    const g95 = sampleGates(S, simM, W, 1.691, { draws: 400, seed: 7 }), g975 = sampleGates(S, simM, W, 1.691, { draws: 400, seed: 7, q: "p975" });
    checks.n_placeboQuantilesAndGateSwitch = pl.p975 === st[390] && pl.p99 === st[396] && pl.p95 < pl.p975 && g95.gates.placeboP95Beaten === true && g975.gates.placeboP975Beaten === false
      && !("placeboP95Beaten" in g975.gates) && g95.beats.p95 && !g95.beats.p975 && placeboGateKey("p975") === "placeboP975Beaten"; }
  // (k) positive control machinery: look-ahead entries on a random walk -> every counted trade is a gross winner and t >= 3
  { const g = mulberry(99), c = [100]; for (let i = 1; i < 2000; i++) c.push(c[i - 1] * Math.exp((g() - 0.5) * 0.08));
    const S = synthS(2000, "2017-01-01", (i) => c[i]), last = 1999, sig = (i) => i + 14 <= last && c[i + 14] / c[i] - 1 > 0, s = simulate(S, sig, { from: 0, to: 1985 }), sm = summarise(s.closed);
    checks.k_positiveControlMachinery = s.closed.length > 30 && s.closed.every((x) => x.gross > 0) && sm.tNet >= 3; detail.k = { n: sm.n, t: r3(sm.tNet) }; }
  // (l) Coinbase candle packing: [time, low, high, open, close, volume] -> [day, o, h, l, c, v], ascending; days after LAST_BAR dropped and counted
  { const raw = [[dayMs("2026-10-02") / 1000, 1, 3, 2, 2.5, 9], [dayMs("2026-10-01") / 1000, 1, 3, 2, 2.4, 8], [dayMs("2026-09-30") / 1000, 1, 3, 2, 2.3, 7], [dayMs("2026-09-30") / 1000, 1, 3, 2, 2.3, 7]];
    const p = packCandles("X", raw, { start: "2026-09-01", lastBar: "2026-10-01" }); let threw = false; try { packCandles("X", [[dayMs("2026-09-30") / 1000, 1, 3, 0, 2, 1]], { start: "2026-09-01", lastBar: "2026-10-01" }); } catch (e) { threw = true; }
    checks.l_candlePacking = p.rows.length === 2 && p.rows[0].join() === "2026-09-30,2,3,1,2.3,7" && p.rows[1][4] === 2.4 && p.droppedAfterLastBar === 1 && threw; }
  // (m) window: registered start = first print day + 96; a token date before it throws
  { const S = synthS(200, "2016-05-14", () => 1); const w = windowOf(S); let threw = false; try { windowOf(S, { from: "2016-06-01" }); } catch (e) { threw = true; }
    checks.m_windowStart = w.from === 96 && w.fromDate === "2016-08-18" && windowOf(S, { from: "2016-09-01" }).from === S.idx.get("2016-09-01") && threw; }
  return { pass: Object.values(checks).every(Boolean), checks, detail };
}

// ── data: fetch once, cache, hash ────────────────────────────────────────────────────────────────────────────────────────
const UA = { "User-Agent": "traids-research/1.0", Accept: "application/json" };
async function getJson(url) {
  for (let tries = 0; ; tries++) {
    let res; try { res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) }); } catch (e) { if (tries >= 4) return { status: 0, error: e.message }; await sleep(3000 * (tries + 1)); continue; }
    if ((res.status === 429 || res.status >= 500) && tries < 5) { await sleep(10000 * (tries + 1)); continue; }
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ }
    return { status: res.status, json, text: res.ok ? null : text.slice(0, 200) };
  }
}
const GEO = (s) => s === 451 || s === 403;
const FUND_SOURCES = [
  { name: "binance-usdtm-fapi", btc: "BTCUSDT", eth: ["ETHUSDT"], async all(sym) {
      const rows = []; let start = 0, calls = 0;
      for (;;) { const r = await getJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${start}&endTime=${FUND_END_MS - 1}&limit=1000`); calls++;
        if (r.status !== 200 || !Array.isArray(r.json)) return { status: r.status, calls, rows, detail: r.text || r.error };
        for (const x of r.json) rows.push([+x.fundingTime, +x.fundingRate, H8]);
        if (r.json.length < 1000) break; start = +r.json[r.json.length - 1].fundingTime + 1; await sleep(300); }
      return { status: 200, calls, rows }; } },
  { name: "bybit-v5-linear", btc: "BTCUSDT", eth: ["ETHUSDT"], async all(sym) {
      const rows = []; let end = FUND_END_MS - 1, calls = 0;
      for (;;) { const r = await getJson(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&endTime=${end}&limit=200`); calls++;
        const list = r.json && r.json.result && r.json.result.list;
        if (r.status !== 200 || !Array.isArray(list)) return { status: r.status, calls, rows, detail: r.text || r.error || (r.json && r.json.retMsg) };
        for (const x of list) rows.push([+x.fundingRateTimestamp, +x.fundingRate, H8]);
        if (list.length < 200) break; end = Math.min(...list.map((x) => +x.fundingRateTimestamp)) - 1; await sleep(300); }
      return { status: 200, calls, rows }; } },
  { name: "bitmex", btc: "XBTUSD", eth: ["ETHUSD", "ETHUSDT"], async all(sym) {
      const rows = []; let start = FUND_START_ISO, calls = 0;
      for (;;) { const r = await getJson(`https://www.bitmex.com/api/v1/funding?symbol=${sym}&count=500&reverse=false&startTime=${encodeURIComponent(start)}`); calls++;
        if (r.status !== 200 || !Array.isArray(r.json)) return { status: r.status, calls, rows, detail: r.text || r.error };
        for (const x of r.json) rows.push([Date.parse(x.timestamp), +x.fundingRate, parseIntervalMs(x.fundingInterval)]);
        if (r.json.length < 500) break; const lastT = Date.parse(r.json[r.json.length - 1].timestamp); if (lastT >= FUND_END_MS) break; start = new Date(lastT + 1).toISOString(); await sleep(500); }
      return { status: 200, calls, rows }; } },
];
const yearsOf = (rows) => (rows.length ? (rows[rows.length - 1][0] - rows[0][0]) / (365.25 * DAY) : 0);
const fundMeta = (sym, rows) => ({ symbol: sym, prints: rows.length, firstPrint: rows.length ? new Date(rows[0][0]).toISOString() : null, lastPrint: rows.length ? new Date(rows[rows.length - 1][0]).toISOString() : null, years: r3(yearsOf(rows)) });
function packCandles(product, raw, { start = CANDLE_START, lastBar = LAST_BAR } = {}) {
  const by = new Map(); let dropped = 0;
  for (const [t, lo, hi, op, cl, vol] of raw) {
    const d = dayOf(t * 1000);
    if (![lo, hi, op, cl].every((x) => fin(x) && x > 0)) throw new Error(`${product}: non-finite or non-positive price on ${d}`);
    if (d > lastBar) { dropped++; continue; }                                                          // forming / post-cutoff candle
    if (d < start) throw new Error(`${product}: candle dated ${d} before ${start}`);
    by.set(d, [d, op, hi, lo, cl, vol]);
  }
  return { rows: [...by.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), droppedAfterLastBar: dropped };
}
async function coinbaseDaily(product) {
  const raw = []; let calls = 0;
  for (let s = dayMs(CANDLE_START), e0 = dayMs(LAST_BAR); s <= e0; s += 300 * DAY) {
    const e = Math.min(e0, s + 299 * DAY), r = await getJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`); calls++;
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`coinbase ${product} HTTP ${r.status} ${r.text || r.error || ""}`);
    raw.push(...r.json); await sleep(350);
  }
  const p = packCandles(product, raw), days = p.rows.map((x) => x[0]), full = dayRange(days[0], days[days.length - 1]), have = new Set(days);
  return { product, calls, rows: p.rows, droppedAfterLastBar: p.droppedAfterLastBar, firstDay: days[0], lastDay: days[days.length - 1], missingDays: full.filter((d) => !have.has(d)) };
}
async function loadOrFetch(allowFetch) {
  if (fs.existsSync(CACHE)) {
    const buf = fs.readFileSync(CACHE), j = JSON.parse(buf.toString("utf8"));
    if (j.spec !== "r314-cache-v1" || j.lastBar !== LAST_BAR || j.fundEndMs !== FUND_END_MS || j.candleStart !== CANDLE_START) throw new Error("cache metadata does not match the R314 spec — refusing to use it");
    return { cache: j, sha: sha256(buf), fetched: false };
  }
  if (!allowFetch) throw new Error(`cache missing (${CACHE_REL}) — the controls run creates it; the read never refetches`);
  if (Date.now() < dayMs(LAST_BAR) + DAY) throw new Error(`the ${LAST_BAR} candle is not complete yet (forming-bar guard)`);
  const attempts = []; let used = null, btcRows = null;
  for (const src of FUND_SOURCES) {
    console.log(`R314 funding: trying ${src.name} ${src.btc} ...`);
    const r = await src.all(src.btc), rows = r.rows.length ? normalizeFunding(r.rows) : [];
    const a = { source: src.name, symbol: src.btc, status: r.status, calls: r.calls, served: r.status === 200 && rows.length > 0, ...fundMeta(src.btc, rows) };
    if (GEO(r.status)) a.reason = `geo-blocked (HTTP ${r.status}) — moved to the next source, no proxy`;
    else if (r.status !== 200) a.reason = `did not serve (HTTP ${r.status}) ${r.detail || ""}`.trim();
    else if (yearsOf(rows) < MIN_YEARS) a.reason = `served ${r3(yearsOf(rows))} years < ${MIN_YEARS}`;
    attempts.push(a); console.log(`  ${a.status} ${a.reason || `served ${a.prints} prints ${a.firstPrint} .. ${a.lastPrint}`}`);
    if (a.served && yearsOf(rows) >= MIN_YEARS) { used = src; btcRows = rows; break; }
  }
  const funding = {};
  if (used) {
    funding.BTC = { ...fundMeta(used.btc, btcRows), rows: btcRows };
    for (const sym of used.eth) { const r = await used.all(sym), rows = r.rows.length ? normalizeFunding(r.rows) : []; funding[`ETH:${sym}`] = { ...fundMeta(sym, rows), status: r.status, rows }; console.log(`  ETH ${sym}: ${r.status} ${rows.length} prints`); }
  }
  const candles = {}; for (const p of ["BTC-USD", "ETH-USD"]) { candles[p] = await coinbaseDaily(p); console.log(`  coinbase ${p}: ${candles[p].rows.length} candles ${candles[p].firstDay} .. ${candles[p].lastDay}, missing ${candles[p].missingDays.length}, dropped after ${LAST_BAR}: ${candles[p].droppedAfterLastBar}`); }
  const obj = { spec: "r314-cache-v1", id: ID, fetchedAt: new Date().toISOString(), lastBar: LAST_BAR, fundEndMs: FUND_END_MS, fundEnd: new Date(FUND_END_MS).toISOString(), candleStart: CANDLE_START,
    rowsFunding: "[timeMs, fundingRate, fundingIntervalMs]", rowsCandles: "[day, o, h, l, c, v] (Coinbase [time, low, high, open, close, volume] reordered)",
    attempts, fundingSource: used ? { name: used.name, btc: used.btc, eth: used.eth } : null, funding, candles };
  fs.mkdirSync(CACHE_DIR, { recursive: true }); writeJsonAtomic(CACHE, obj, { pretty: 0 });
  const buf = fs.readFileSync(CACHE);
  return { cache: JSON.parse(buf.toString("utf8")), sha: sha256(buf), fetched: true };
}
function coverageOf(cache, S, win) {
  const f = cache.funding.BTC, c = cache.candles["BTC-USD"];
  const inWin = (d) => d >= win.fromDate && d <= LAST_BAR;
  return { fundingSource: cache.fundingSource, attempts: cache.attempts.map(({ source, symbol, status, served, prints, firstPrint, lastPrint, years, reason }) => ({ source, symbol, status, served, prints, firstPrint, lastPrint, years, reason })),
    btcFunding: { symbol: f.symbol, prints: f.prints, firstPrint: f.firstPrint, lastPrint: f.lastPrint, years: f.years, completeDays: S.fund.filter(fin).length, incompleteDays: S.incomplete.length, incompleteList: S.incomplete.slice(0, 40), lastCompleteDay: S.days[S.fund.map(fin).lastIndexOf(true)] },
    ethFunding: Object.fromEntries(Object.entries(cache.funding).filter(([k]) => k.startsWith("ETH:")).map(([k, v]) => [k, { symbol: v.symbol, status: v.status, prints: v.prints, firstPrint: v.firstPrint, lastPrint: v.lastPrint, years: v.years }])),
    candles: Object.fromEntries(Object.entries(cache.candles).map(([k, v]) => [k, { n: v.rows.length, firstDay: v.firstDay, lastDay: v.lastDay, missingDays: v.missingDays.length, missingInWindow: v.missingDays.filter(inWin), droppedAfterLastBar: v.droppedAfterLastBar }])),
    window: win, zDefinedFrom: S.days[S.z.findIndex(fin)], zDefinedTo: S.days[S.z.map(fin).lastIndexOf(true)], btcCandlesMissingInWindow: c.missingDays.filter(inWin).length };
}

// ── controls: calibration on no-edge funding transforms (real prices, funding decoupled) ─────────────────────────────────
// One no-edge family: the whole rule on each transform, the gate set IN FORCE (q) decides `pass`; the other placebo quantiles and the
// block-shuffle null (each sample's mean vs the p95 of the OTHER samples' means, leave-one-out) are calibrated beside it.
// Exclusion ablation (reported, never a gate): the same placebo with no exclusion (pool = the whole same calendar year), and the observed
// trades de-clustered to the first trade of each back-to-back episode (placebo blocks only the kept windows). If the dispersion sd falls
// to ~1 without the exclusion but not with de-clustering, the miscalibration is the same-year-minus-real-windows pool, not clustering.
const poolMean = (pp, cost = COST) => (pp.slots.length ? mean(pp.slots.map((sl) => mean(sl.gross))) - cost : null);
const zOf = (m, pl) => (pl.sdOfDraws > 0 && m != null ? (m - pl.meanOfDraws) / pl.sdOfDraws : null);
function corr(a, b) { const k = a.map((x, i) => [x, b[i]]).filter(([x, y]) => fin(x) && fin(y)); if (k.length < 3) return null; const mx = mean(k.map((p) => p[0])), my = mean(k.map((p) => p[1])); let sxy = 0, sx = 0, sy = 0; for (const [x, y] of k) { sxy += (x - mx) * (y - my); sx += (x - mx) ** 2; sy += (y - my) ** 2; } return sx > 0 && sy > 0 ? sxy / Math.sqrt(sx * sy) : null; }
function calibrate(S, win, bar, { family, n, transform, q = "p95" }) {
  const rows = [];
  for (let s = 1; s <= n; s++) {
    const S2 = withFunding(S, transform(s)), sim = simulate(S2, zLE(S2, Z_ENTRY), win), g = sampleGates(S2, sim, win, bar, { q });
    const ppN = placeboPrep(S2, sim, { ...win, exclude: false }), plN = placeboRun(ppN, {});
    const dc = sim.closed.filter((x, k) => !(k > 0 && x.t === sim.closed[k - 1].u)), smDc = summarise(dc), plDc = placeboRun(placeboPrep(S2, { ...sim, closed: dc }, win), {});
    rows.push({ seed: s, n: g.sm.n, meanNet: g.sm.meanNet, meanNetPct: pct(g.sm.meanNet), t: r3(g.sm.tNet), placeboP95Pct: pct(g.pl.p95), placeboP975Pct: pct(g.pl.p975),
      zVsPlacebo: zOf(g.sm.meanNet, g.pl), zNoExclusion: zOf(g.sm.meanNet, plN), zDeclustered: zOf(smDc.meanNet, plDc), poolMeanReg: poolMean(g.pp), poolMeanNoExcl: poolMean(ppN),
      noExclBeats: { p95: g.sm.meanNet != null && plN.p95 != null && g.sm.meanNet > plN.p95, p975: g.sm.meanNet != null && plN.p975 != null && g.sm.meanNet > plN.p975 },
      episodes: episodesOf(sim.closed),
      gates: g.gates, pass: g.pass, corePass: g.corePass, beats: g.beats, passAt: g.passAt, open: sim.open.length, unpriced: sim.unpriced.length, dropped: g.pl.slots ? g.sm.n - g.pl.slots : null });
  }
  const N = rows.length, share = (f) => rows.filter(f).length / N, keys = Object.keys(rows[0].gates), srt = (a) => a.filter(fin).sort((x, y) => x - y);
  const dist = (a) => { const s = srt(a); return s.length ? { min: s[0], p05: nearestRank(s, 0.05), p50: nearestRank(s, 0.5), p95: nearestRank(s, 0.95), max: s[s.length - 1] } : null; };
  const k = rows.filter((r) => r.pass).length, se = Math.sqrt(Math.max(k, 0.5) * (N - k) / N) / N, pk = placeboGateKey(q);
  const ms = rows.map((r) => r.meanNet), looP95 = rows.map((_, j) => { const o = ms.filter((x, i) => i !== j && fin(x)).sort((a, b) => a - b); return o[Math.floor(0.95 * o.length)]; });
  const zs = rows.map((r) => r.zVsPlacebo).filter(fin), zm = zs.length ? mean(zs) : null;
  return { family, shuffles: N, gateSetInForce: q === "p95" ? "registered (placebo p95)" : `amended (placebo ${q})`, perGatePassRate: Object.fromEntries(keys.map((g) => [g, r4(share((r) => r.gates[g]))])),
    wholeRuleFalsePass: r4(k / N), wholeRuleFalsePassCount: k, binomialSE: r4(se), atMost5pct: k / N <= LEAK_MAX,
    byPlaceboQuantile: Object.fromEntries(Object.keys(PLACEBO_Q).map((qq) => [qq, { placeboAloneFalsePass: r4(share((r) => r.beats[qq])), wholeRuleFalsePass: r4(share((r) => r.passAt[qq])) }])),
    coreGatesOnlyPass: r4(share((r) => r.corePass)),
    blockShuffleNullLOO: { note: "reported alternative: each sample's mean vs the p95 of the other samples' means (leave-one-out)", aloneFalsePass: r4(share((r, j) => fin(r.meanNet) && r.meanNet > looP95[j])),
      withCoreFalsePass: r4(share((r, j) => r.corePass && r.meanNet > looP95[j])) },
    placeboDispersion: { note: "(observed mean - placebo mean) / placebo sd across no-edge samples; sd 1 = calibrated, > 1 = the placebo is too narrow (same-year pool minus the real trade windows: observed and pool means are negatively correlated)", mean: r3(zm), sd: zs.length > 1 ? r3(sdS(zs)) : null },
    placeboExclusionAblation: (() => { const sdz = (k) => { const a = rows.map((r) => r[k]).filter(fin); return a.length > 1 ? r3(sdS(a)) : null; }, ep = rows.filter((r) => r.episodes > 0);
      return { note: "reported, never a gate: dispersion sd of the registered placebo vs the same placebo with no exclusion (whole same-year pool) vs the observed trades de-clustered to one per back-to-back episode; and the correlation, across no-edge samples, of the observed mean with the placebo pool mean",
        dispersionSd: { registered: sdz("zVsPlacebo"), noExclusion: sdz("zNoExclusion"), declustered: sdz("zDeclustered") },
        corrObservedVsPoolMean: { registeredExclusion: r3(corr(rows.map((r) => r.meanNet), rows.map((r) => r.poolMeanReg))), noExclusion: r3(corr(rows.map((r) => r.meanNet), rows.map((r) => r.poolMeanNoExcl))),
          deviationsFromSameYearMean: r3(corr(rows.map((r) => r.meanNet - r.poolMeanNoExcl), rows.map((r) => r.poolMeanReg - r.poolMeanNoExcl))) },
        noExclusionFalsePass: { placeboP95Alone: r4(share((r) => r.noExclBeats.p95)), wholeRuleAtP95: r4(share((r) => r.corePass && r.noExclBeats.p95)), wholeRuleAtP975: r4(share((r) => r.corePass && r.noExclBeats.p975)) },
        tradesPerEpisodeMean: ep.length ? r3(mean(ep.map((r) => r.n / r.episodes))) : null }; })(),
    conditional: { placeboBeatenGivenTAtLeastBar: (() => { const a = rows.filter((r) => r.gates.tAtLeastBar); return a.length ? r4(a.filter((r) => r.gates[pk]).length / a.length) : null; })(),
      placeboBeatenGiven25Trades: (() => { const a = rows.filter((r) => r.gates.tradesAtLeast25); return a.length ? r4(a.filter((r) => r.gates[pk]).length / a.length) : null; })() },
    trades: dist(rows.map((r) => r.n)), t: dist(rows.map((r) => r.t)), meanNetPct: dist(rows.map((r) => r.meanNetPct)), placeboP95Pct: dist(rows.map((r) => r.placeboP95Pct)),
    placeboDroppedTotal: rows.reduce((s, r) => s + (r.dropped || 0), 0), rows };
}
function controlsRun(cache, dec, bar) {
  const S = buildCoin(cache.funding.BTC.rows, cache.candles["BTC-USD"].rows), win = windowOf(S, dec), seg = longestRun(S.fund);
  const leak = calibrate(S, win, bar, { family: `30-day block shuffle of BTC daily funding (mulberry seeds s*7919+3140, s = 1..${LEAK_SHUFFLES}; not the s*7919+314 seeds the p97.5 amendment was chosen on) on the longest present run ${S.days[seg.a]}..${S.days[seg.b]}; real Coinbase prices; z recomputed`, n: LEAK_SHUFFLES,
    transform: (s) => onSegment(S.fund, seg, (x) => blockShuffle(x, LEAK_BLOCK, mulberry(LEAK_SEED(s)))), q: dec.q });
  const segLen = seg.b - seg.a + 1, shifts = []; for (let k = SHIFT_MIN; k <= segLen - SHIFT_MIN; k++) shifts.push(k);
  const circ = calibrate(S, win, bar, { family: `circular shift of the same run by every k in [${SHIFT_MIN}, len-${SHIFT_MIN}] days (${shifts.length} shifts, exhaustive; keeps the signal's clustering) — diagnostic, not a registered gate`, n: shifts.length,
    transform: (s) => onSegment(S.fund, seg, (x) => circularShift(x, shifts[s - 1])), q: dec.q });
  // positive control: entries on days whose own forward 14-day return > 0 (outcome look-ahead), same simulator, window and cost
  const last = S.days.length - 1, pcSig = (i) => i + HOLD <= last && fin(S.close[i]) && fin(S.close[i + HOLD]) && S.close[i + HOLD] / S.close[i] - 1 > 0;
  const pcSim = simulate(S, pcSig, win), pcG = sampleGates(S, pcSim, win, bar, { q: dec.q });
  const pc = { method: "entries (when flat) on days whose own forward 14-day gross return > 0 — outcome look-ahead; same simulator, window, 0.50% cost", requirement: `t >= ${POS_T}`,
    n: pcG.sm.n, meanNetPct: pcG.sm.meanNetPct, t: r3(pcG.sm.tNet), winRatePct: r1(100 * pcG.sm.winRate), pass: pcG.sm.tNet != null && pcG.sm.tNet >= POS_T,
    wholeRuleGatesOnLookAhead: pcG.gates, wholeRulePassOnLookAhead: pcG.pass, placeboP95Pct: pct(pcG.pl.p95), placeboP975Pct: pct(pcG.pl.p975),
    placeboNote: "the look-ahead trades cover most up-windows, so the non-overlapping placebo pool is mostly down-windows (hence a negative p95) — expected, not a defect" };
  // outcome-free diagnostics of the REAL signal (z and dates only; no price is read)
  const ofc = entriesOutcomeFree(S, win), sigDays = []; for (let i = win.from; i <= win.to; i++) if (fin(S.z[i]) && S.z[i] <= Z_ENTRY) sigDays.push(i);
  const sdBps = sigDays.map((i) => S.sd[i] * 1e4).sort((a, b) => a - b), belowBps = sigDays.map((i) => -S.z[i] * S.sd[i] * 1e4).sort((a, b) => a - b);   // mean - F7 = -z * sd
  // same-year excluded share of the real signal (dates only): per entry, the share of its calendar year's pool days (in window, both closes
  // present, i + 14 <= last) blocked by the real windows; averaged over entries — the quantity the placebo miscalibration scales with
  const blocked = new Uint8Array(S.days.length), ey = {}, by = {}; for (const t of ofc.ts) for (let j = Math.max(0, t - HOLD + 1); j <= (t + HOLD > last ? last : t + HOLD - 1); j++) blocked[j] = 1;   // an open window blocks to the end (placeboPrep)
  for (let j = win.from; j <= win.to; j++) { if (j + HOLD > last || !fin(S.close[j]) || !fin(S.close[j + HOLD])) continue; const y = S.days[j].slice(0, 4); ey[y] = (ey[y] || 0) + 1; if (blocked[j]) by[y] = (by[y] || 0) + 1; }
  const exclTW = ofc.ts.length ? mean(ofc.ts.map((t) => (by[S.days[t].slice(0, 4)] || 0) / (ey[S.days[t].slice(0, 4)] || 1))) : null;
  // venue diagnostics (funding only): share of 8 h prints at exactly the 0.0100% default, by year; entries that fire with F7 >= 0
  const defaultByYear = {}; for (const [t, r, iv] of cache.funding.BTC.rows) { const y = dayOf(t).slice(0, 4), d = (defaultByYear[y] = defaultByYear[y] || { prints: 0, atDefault: 0 }); d.prints++; if (iv === H8 && Math.abs(r - 0.0001) < 1e-12) d.atDefault++; }
  for (const d of Object.values(defaultByYear)) d.pct = r1(100 * d.atDefault / d.prints);
  const f7NonNeg = ofc.ts.filter((t) => S.F7[t] >= 0).map((t) => ({ entryDate: S.days[t], f7BpsPerDay: r3(S.F7[t] * 1e4), z: r3(S.z[t]) }));
  const outcomeFree = { note: "computed from funding and dates only — no price or return is read", entries: ofc.entries, closable: ofc.closable, openAtEnd: ofc.open, byYear: ofc.byYear,
    episodes: ofc.episodes, tradesPerEpisode: ofc.episodes ? r3(ofc.entries / ofc.episodes) : null, sameYearExcludedShareTradeWeighted: r4(exclTW),
    venue: { note: "BitMEX XBTUSD: share of 8 h prints at exactly the 0.0100% default (3 bps/day), by year; entries whose F7 is still >= 0 (a dip from the default, not negative funding)", defaultPrintShareByYear: defaultByYear, entriesWithF7AtOrAboveZero: f7NonNeg },
    signalDays: sigDays.length, zDefinedDays: S.z.slice(win.from, win.to + 1).filter(fin).length,
    signalDaySd90Bps: sdBps.length ? { min: r4(sdBps[0]), p10: r4(nearestRank(sdBps, 0.1)), p50: r4(nearestRank(sdBps, 0.5)), max: r4(sdBps[sdBps.length - 1]) } : null,
    signalDaysWithSd90Below0p1Bps: sdBps.filter((x) => x < 0.1).length,
    signalDayF7BelowMeanBps: belowBps.length ? { min: r4(belowBps[0]), p50: r4(nearestRank(belowBps, 0.5)), max: r4(belowBps[belowBps.length - 1]) } : null };
  return { S, win, seg, leak, circ, pc, outcomeFree };
}

// ── the read computation (pure; main writes OUT once) ────────────────────────────────────────────────────────────────────
function ruleBlock(S, win, bar, { th = Z_ENTRY, hold = HOLD, sigKind = "le", reentry = "exit-day" } = {}) {
  const sig = sigKind === "ge" ? zGE(S, th) : sigKind === "cross" ? crossLE(S, th) : zLE(S, th), sim = simulate(S, sig, { ...win, hold, reentry });
  const sm = summarise(sim.closed), pl = placeboRun(placeboPrep(S, sim, { ...win, hold }), {});
  return { n: sm.n, meanNetPct: sm.meanNetPct, t: r3(sm.tNet), winRatePct: sm.winRate == null ? null : r1(100 * sm.winRate), halvesPct: [sm.halves.first.meanNetPct, sm.halves.second.meanNetPct],
    placeboP95Pct: pct(pl.p95), placeboP975Pct: pct(pl.p975), placeboBeatenP95: sm.meanNet != null && pl.p95 != null && sm.meanNet > pl.p95, placeboBeatenP975: sm.meanNet != null && pl.p975 != null && sm.meanNet > pl.p975,
    open: sim.open.length, unpriced: sim.unpriced.length, tAtLeastBar: sm.tNet != null && sm.tNet >= bar };
}
function computeRead({ cache, sha, ctrl, dec, bar }) {
  const S = buildCoin(cache.funding.BTC.rows, cache.candles["BTC-USD"].rows), win = windowOf(S, dec), coverageYears = yearsOf(cache.funding.BTC.rows);
  const sim = simulate(S, zLE(S, Z_ENTRY), win), sm = summarise(sim.closed), pp = placeboPrep(S, sim, win), pl = placeboRun(pp, {});
  const q = dec.q || "p95", beatsAt = (k) => sm.meanNet != null && pl[k] != null && sm.meanNet > pl[k];
  const placebo = { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, p95: pl.p95, p95Pct: pct(pl.p95), p975: pl.p975, p975Pct: pct(pl.p975), p99Pct: pct(pl.p99), p50Pct: pct(pl.p50), p05Pct: pct(pl.p05), meanOfDrawsPct: pct(pl.meanOfDraws),
    observed: sm.meanNet, observedPct: sm.meanNetPct, beats: beatsAt("p95"), beatsP975: beatsAt("p975"), gateQuantile: q, gateBeaten: beatsAt(q), slots: pl.slots, dropped: pp.dropped, eligibleDaysByYear: pp.eligibleByYear,
    method: `per counted trade, a uniform day of the same calendar year inside the window whose (i, i+14] does not overlap any real trade window (closed, unpriced or open), both closes present; independent draws; 0.50% cost; statistic = mean net; 1,000 draws seed 314; pQ = sorted[floor(Q*draws)]; gate quantile in force ${q}` };
  // reported only: the block-shuffle null from the controls run (same prices, same signal clustering) — observed vs the p95 of the shuffle means
  const shufMeans = (ctrl.leakTest.allRows || []).map((r) => r[2]).filter(fin).sort((a, b) => a - b);
  placebo.blockShuffleNull = shufMeans.length ? { shuffles: shufMeans.length, p50Pct: shufMeans[Math.floor(0.5 * shufMeans.length)], p95Pct: shufMeans[Math.floor(0.95 * shufMeans.length)], observedPct: sm.meanNetPct,
    beats: sm.meanNetPct != null && sm.meanNetPct > shufMeans[Math.floor(0.95 * shufMeans.length)], gate: false, note: "REPORTED ONLY: whole-rule false pass with the core gates in the controls file (blockShuffleNullLOO)" } : null;
  const gates = { tradesAtLeast25: sm.n >= MIN_TRADES, meanNetPositive: sm.meanNet != null && sm.meanNet > 0, tAtLeastBar: sm.tNet != null && sm.tNet >= bar, [placeboGateKey(q)]: placebo.gateBeaten,
    bothHalvesPositive: sm.halves.first.meanNet != null && sm.halves.second.meanNet != null && sm.halves.first.meanNet > 0 && sm.halves.second.meanNet > 0,
    leakCalibrationAtMost5pct: !!(ctrl.leakTest && ctrl.leakTest.pass), positiveControlPassed: !!(ctrl.positiveControl && ctrl.positiveControl.pass), fundingSourceAtLeast5Years: coverageYears >= MIN_YEARS };
  const verdictScript = verdictOf(gates, { coverageYears });
  // reported (never gated)
  const last = S.days.length - 1, fwd = (i) => (i + HOLD <= last && fin(S.close[i]) && fin(S.close[i + HOLD]) ? S.close[i + HOLD] / S.close[i] - 1 : NaN);
  const allFwd = [], highFwd = []; for (let i = win.from; i <= win.to; i++) { const f = fwd(i); if (!fin(f)) continue; allFwd.push(f); if (fin(S.z[i]) && S.z[i] >= Z_HIGH) highFwd.push(f); }
  const firstC = S.close.findIndex((c, i) => i >= win.from && fin(c)), lastC = S.close.map(fin).lastIndexOf(true), yrs = (lastC - firstC) / 365.25;
  const eth = {}; for (const [k, v] of Object.entries(cache.funding).filter(([k]) => k.startsWith("ETH:"))) {
    if (!v.rows.length) { eth[k] = { status: v.status, note: "no funding served" }; continue; }
    const E = buildCoin(v.rows, cache.candles["ETH-USD"].rows), ew = windowOf(E); eth[k] = { symbol: v.symbol, window: [ew.fromDate, ew.toDate], fundingYears: v.years, ...ruleBlock(E, ew, bar) };
  }
  const { nullBar } = require("./lib/null-bar.js");
  const reported = {
    eth, zThresholds: { "-1.0": ruleBlock(S, win, bar, { th: -1.0 }), "-2.0": ruleBlock(S, win, bar, { th: -2.0 }) },
    holds: { "7": ruleBlock(S, win, bar, { hold: 7 }), "28": ruleBlock(S, win, bar, { hold: 28 }) },
    highBucket: { note: "z >= +1.5 ('stand aside')", tradeForm: ruleBlock(S, win, bar, { th: Z_HIGH, sigKind: "ge" }),
      dayForm: { days: highFwd.length, meanFwd14GrossPct: highFwd.length ? pct(mean(highFwd)) : null, allDaysMeanFwd14GrossPct: allFwd.length ? pct(mean(allFwd)) : null, allDays: allFwd.length, note: "overlapping daily forward 14-day returns; descriptive only" } },
    buyAndHold: { from: S.days[firstC], to: S.days[lastC], totalReturnPct: pct(S.close[lastC] / S.close[firstC] - 1), cagrPct: pct(Math.pow(S.close[lastC] / S.close[firstC], 1 / yrs) - 1), meanFwd14GrossAllDaysPct: allFwd.length ? pct(mean(allFwd)) : null },
    readings: { note: "implementation readings of 'first day z <= -1.5' — reported, never gated", reentryNextDay: ruleBlock(S, win, bar, { reentry: "next-day" }), crossingOnly: ruleBlock(S, win, bar, { sigKind: "cross" }) },
    barAtObservedN: sm.n >= 3 ? { n: sm.n, iidP95: r3(nullBar({ variants: 1, n: sm.n, trials: 20000, rng: mulberry(314) }).p95), registered: bar, note: "the registered bar applies unchanged" } : null,
    source: coverageOf(cache, S, win), openAtEnd: sim.open, unpriced: sim.unpriced, noCandleSignals: sim.noCandle,
  };
  const out = { id: ID, spec: "r314-read-v1", read: true, asOf: new Date().toISOString(), unit: "trades", n: sm.n, tNet: r4(sm.tNet), tNetRaw: sm.tNet, meanNet: sm.meanNet, meanNetPct: sm.meanNetPct, winRate: sm.winRate,
    placebo, halves: { first: sm.halves.first, second: sm.halves.second }, gates, verdictScript, bar, barSource: "test-registry.json R314 bar.tRequired", preReadDecision: dec, window: win,
    controls: { file: `backend/data/${STEM}-controls.json`, asOf: ctrl.asOf, leakWholeRuleFalsePass: ctrl.leakTest.wholeRuleFalsePass, positiveControlT: ctrl.positiveControl.t },
    trades: sim.closed.map((x) => ({ entryDate: x.entryDate, exitDate: x.exitDate, entry: x.entry, exit: x.exit, z: r3(S.z[x.t]), netPct: pct(x.net) })),
    reported, cache: { file: CACHE_REL, sha256: sha },
    implementationNotes: implementationNotes(S, win) };
  const lines = [`R314 READ — ${verdictScript} (bar t >= ${bar})`,
    `  trades ${sm.n} · mean net ${sm.meanNetPct}% · t ${r3(sm.tNet)} · win ${sm.winRate == null ? null : r1(100 * sm.winRate)}% · window ${win.fromDate}..${win.toDate}`,
    `  placebo (gate ${q}) p95 ${placebo.p95Pct}% / p97.5 ${placebo.p975Pct}% vs observed ${placebo.observedPct}% -> ${placebo.gateBeaten ? "BEATEN" : "not beaten"} · halves ${sm.halves.first.meanNetPct}% / ${sm.halves.second.meanNetPct}%`,
    `  gates ${JSON.stringify(gates)}`];
  return { out, lines };
}
function implementationNotes(S, win) {
  return [
    `Window: the registered procedural start (first day with 90 + 7 days of funding history = first print day + 96) applied to the source that served gives ${win.registeredFromDate}; the registry's "(expected late 2019)" and the name's "2019-2026" assumed Binance (first funding Sept 2019).${win.fromDate !== win.registeredFromDate ? ` A pre-read window token moved the start to ${win.fromDate}.` : ""}`,
    "Daily funding counts a day only when its prints' intervals sum to 24 h; incomplete days (interval-change days, missing prints, the delisting day) are missing, so F7/z are undefined around them rather than reading a short sum as low funding.",
    "z uses the sample sd (n-1) of the 90 prior F7 values; sd <= 1e-12 (a pinned series) leaves z undefined.",
    "Exit-day re-entry follows the house simulator (r310): after the day-14 exit close, a z <= -1.5 on that same day opens the next trade. Next-day and crossing-only readings are in reported.readings.",
    "Placebo draws are independent per trade (they may overlap one another) and come from days inside the evidence window; real windows are blocked as return intervals (i, i+14] vs (t, t+14].",
    `BitMEX settled its perpetuals on 2026-09-16 (last print 12:00 UTC; that day is incomplete), so the last complete funding day is ${S.days[S.fund.map(fin).lastIndexOf(true)]} and no entry is possible after it; the late-September 2026 reading in the source report is outside the data.`,
    "Venue: BitMEX XBTUSD funding sat at the 0.0100% default on 51-61% of prints in 2020, 2021, 2024 and 2025, and 6 of the 44 entries (registered window) fire with F7 >= 0 (a dip from the 3 bps/day default, not negative funding); from 2020 BitMEX is a minor BTC perp venue, so this reads BitMEX funding extremes rather than market-wide positioning, and XBTUSD settled 2026-09-16, so any PASS needs a live-venue re-test before a forward rule. (Counts: controls file outcomeFreeRealSignal.venue.)",
    "Placebo calibration: the registered same-year placebo with real windows excluded is too narrow (the observed mean and the excluded-pool mean are negatively correlated under no edge); the gate quantile in force is preReadDecision.q (p975 under the 2026-10-02 pre-evidence placebo:p975 amendment) and the p95 comparison is always reported. Exclusion ablation: controls file leakTest.placeboExclusionAblation.",
  ];
}

// The amendment's "why": this run's numbers (computed) + the 2026-10-02 repair audit (scratch, no-edge data only; fixed text, not
// recomputed here). Mechanism per the review: the same-year-minus-real-windows pool, not clustering.
const REPAIR_AUDIT = {
  firstRun: "The first controls run (seeds s*7919+314, s = 1..500 — the seeds p97.5 was chosen on) gave 5.4% (27/500) at p95 and 4.0% (20/500) at p97.5; a repair audit of 20,000 further block-30 shuffles (ten seed families) gives 6.55% (SE 0.17) at p95, 4.14% (SE 0.14) at p97.5 and 2.19% at p99",
  terciles: "on 6,000 shuffles the dispersion sd rises from 1.143 to 1.209 between the low and high terciles of same-year excluded share and is flat across back-to-back terciles (1.178 / 1.186 / 1.152)",
  matched: "3.7% (166/4,478) on block-30 scrambles whose same-year excluded share is within ±0.03 of the real signal's",
  power: "edge injected into the price path on scrambled funding, 1,000 runs at +4%/trade: whole-rule power 47.0% at p97.5 vs 33.5% at p99 (57.0% at the miscalibrated p95); dropping the exclusion instead calibrates but has less power (44.3%)",
  altNulls: "Disclosed: p97.5 is marginal under no-edge constructions other than the registered leak test — 45-day blocks 4.1% / 5.2% (repair audit, 1,500 / reviewer audit, other seeds), 60-day 4.1% / 5.4%, 75-day 6.5% / 6.4%, stationary bootstrap L=60 4.9% / 5.5% (L=30 4.6%), 20- and 90-day blocks 3.6% / 2.9% — so under a longer-persistence null the amended rule could still false-pass at 5-6%; p99 stays <= 3.8% under all of them",
};
function proposedWhy(C, L, Cq, pp1) {
  const A = C.leak.placeboExclusionAblation, Ac = C.circ.placeboExclusionAblation, of = C.outcomeFree;
  return `Registered leak calibration, run before any real-funding statistic, on ${C.leak.shuffles} 30-day block shuffles of BTC daily funding (seeds s*7919+3140, s = 1..${C.leak.shuffles}) on the real Coinbase price path: the registered rule false-passes ${pp1(C.leak.wholeRuleFalsePass)}% (${C.leak.wholeRuleFalsePassCount}/${C.leak.shuffles}, SE ${pp1(C.leak.binomialSE)}) > 5%, so the read is held as registered. ${REPAIR_AUDIT.firstRun}. `
    + `Cause: the placebo pool is the entry's calendar year MINUS every day whose 14-day window overlaps a real trade window, so under no edge the observed mean and the pool mean split the same year's returns and are negatively correlated (corr ${A.corrObservedVsPoolMean.registeredExclusion} here, vs ${A.corrObservedVsPoolMean.noExclusion} against the whole same-year pool); the placebo's draw sd misses that covariance and is too narrow. (observed - placebo mean)/placebo sd has sd ${A.dispersionSd.registered} as registered vs ${A.dispersionSd.noExclusion} with no exclusion and ${A.dispersionSd.declustered} with the observed trades de-clustered to one per back-to-back episode (calibrated = 1), so clustering is not the cause; ${REPAIR_AUDIT.terciles}. `
    + `At p97.5 the whole rule false-passes ${pp1(L.p975.wholeRuleFalsePass)}% (${Math.round(L.p975.wholeRuleFalsePass * C.leak.shuffles)}/${C.leak.shuffles}) on these seeds, which p97.5 was not chosen on; ${pp1(Cq.p975.wholeRuleFalsePass)}% over all ${C.circ.shuffles} circular shifts of the funding run (which keep the signal's clustering: ${Ac.tradesPerEpisodeMean} trades per back-to-back episode vs ${of.tradesPerEpisode} for the real signal); ${REPAIR_AUDIT.matched} ${of.sameYearExcludedShareTradeWeighted} (computed from z and dates only). `
    + `p99 would be ${pp1(L.p99.wholeRuleFalsePass)}% at a power cost (${REPAIR_AUDIT.power}; no exclusion at p95 false-passes ${pp1(A.noExclusionFalsePass.wholeRuleAtP95)}% here). ${REPAIR_AUDIT.altNulls}. Rule, threshold, hold, cost, bar and window unchanged.`;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function registryEntry() { const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); return [...(reg.preregistered || []), ...(reg.tests || [])].find((x) => x.id === ID) || null; }
async function main() {
  const st = selftest();
  console.log(`R314 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`);
  if (!st.pass) { console.log(`  detail ${JSON.stringify(st.detail)}`); process.exit(1); }
  if (SELFTEST_ONLY) return;
  const entry = registryEntry();
  if (!entry) { console.error(`${ID} not registered — refusing`); process.exit(2); }
  const bar = Number(entry.bar && entry.bar.tRequired); if (!fin(bar)) { console.error(`${ID} registry entry has no numeric bar.tRequired — refusing`); process.exit(2); }
  const dec = preReadDecision(entry);
  if (!dec.decided) { console.error(`${ID} pre-read decision not usable (${dec.why}) — refusing`); process.exit(2); }

  if (!READ) {
    // CONTROLS RUN — no-edge funding transforms on real prices, the look-ahead positive control, and outcome-free counts of the real
    // signal. No statistic of the real rule on the real funding is computed or written.
    const { cache, sha, fetched } = await loadOrFetch(true);
    if (!cache.fundingSource) {
      writeJsonAtomic(CTRL, { spec: "r314-controls-v1", id: ID, asOf: new Date().toISOString(), runner: { file: `backend/${STEM}.js`, sha256: sha256(fs.readFileSync(__filename)) }, cache: { file: CACHE_REL, sha256: sha }, attempts: cache.attempts, pass: false, ready: false, holdWhy: "no listed source served >= 5 years — CANNOT MEASURE" });
      console.log("R314 NOT READY — no listed funding source served >= 5 years (CANNOT MEASURE)"); return;
    }
    console.log(`R314 data ${fetched ? "fetched + cached" : "from cache"} — funding ${cache.fundingSource.name} ${cache.fundingSource.btc}; sha256 ${sha}`);
    console.log(`R314 calibrating: ${LEAK_SHUFFLES} block shuffles + every circular shift in [${SHIFT_MIN}, len-${SHIFT_MIN}] (placebo ${PLACEBO_DRAWS} draws each, plus the exclusion ablation) ...`);
    const C = controlsRun(cache, dec, bar), cov = coverageOf(cache, C.S, C.win), years = yearsOf(cache.funding.BTC.rows);
    const leakPass = C.leak.shuffles >= 200 && C.leak.atMost5pct, pass = leakPass && C.pc.pass && years >= MIN_YEARS;
    const L = C.leak.byPlaceboQuantile, Cq = C.circ.byPlaceboQuantile, pp1 = (x) => (x == null ? null : +(100 * x).toFixed(1));
    // a miscalibrated registered gate set -> the exact pre-evidence amendment that calibrates (computed from the no-edge runs above)
    const proposedAmendment = !leakPass && dec.q === "p95" && L.p975.wholeRuleFalsePass <= LEAK_MAX && Cq.p975.wholeRuleFalsePass <= LEAK_MAX ? {
      date: "2026-10-02", preEvidence: true, field: "controls.placebo / decisionRule.pass",
      was: { placebo: "RANDOM 14-DAY HOLDS: the same number of entries drawn uniformly from days of the SAME calendar year whose 14-day windows do not overlap any real trade window, same cost, 1,000 draws; GATE: observed mean > placebo p95.",
        pass: "PASS only if >= 25 trades AND mean net > 0 AND t >= 1.691 AND the random-hold placebo p95 is beaten AND both halves > 0 AND the leak calibration <= 5% AND the positive control passed." },
      becomes: { placebo: "AMENDED 2026-10-02 (pre-evidence): RANDOM 14-DAY HOLDS as registered (same calendar year, windows disjoint from every real trade window, same 0.50% cost, 1,000 draws, seed 314); GATE: observed mean > placebo p97.5 (sorted[floor(0.975 x draws)]). The p95 comparison is still reported.",
        pass: "PASS only if >= 25 trades AND mean net > 0 AND t >= 1.691 AND the random-hold placebo p97.5 is beaten AND both halves > 0 AND the leak calibration <= 5% AND the positive control passed." },
      why: proposedWhy(C, L, Cq, pp1),
      runnerGates: ["placebo:p975"] } : null;
    const holdWhy = !pass ? [!leakPass && `whole-rule false pass ${pp1(C.leak.wholeRuleFalsePass)}% > 5% on the leak calibration of the gate set in force — held for an amendment${proposedAmendment ? " (proposedAmendment: placebo:p975)" : ""}`,
      !C.pc.pass && "positive control failed", years < MIN_YEARS && "source < 5 years"].filter(Boolean).join("; ") : null;
    const strip = (c) => { const { rows, ...rest } = c; return { ...rest, rowsSample: rows.slice(0, 5).map(({ meanNet, ...r }) => r) }; };
    writeJsonAtomic(CTRL, { spec: "r314-controls-v1", id: ID, asOf: new Date().toISOString(), runner: { file: `backend/${STEM}.js`, sha256: sha256(fs.readFileSync(__filename)) },
      cache: { file: CACHE_REL, sha256: sha, fetchedAt: cache.fetchedAt }, coverage: cov, selftest: st, bar, preReadDecision: dec, window: C.win,
      leakTest: { method: C.leak.family, requirement: "whole-rule false-pass rate <= 5% on >= 200 shuffles (registered controls.leakTest), for the gate set in force", pass: leakPass, ...strip(C.leak),
        allRows: C.leak.rows.map((r) => [r.seed, r.n, r.meanNetPct, r.t, r.placeboP95Pct, r.placeboP975Pct, r.pass ? 1 : 0]), allRowsColumns: ["seed", "trades", "meanNetPct", "t", "placeboP95Pct", "placeboP975Pct", "wholeRulePassInForce"] },
      circularShiftDiagnostic: strip(C.circ), positiveControl: C.pc, outcomeFreeRealSignal: C.outcomeFree, implementationNotes: implementationNotes(C.S, C.win),
      pass, ready: pass, holdWhy, proposedAmendment,
      howToRecordTheDecision: { where: "backend/data/test-registry.json, the R314 entry: append proposedAmendment to amendments[] (create it) BEFORE the read, plus a dated change-registry entry; then re-run this controls mode", tokens: RUNNER_GATES },
      note: "Summarised: no-edge funding transforms on real prices, the outcome look-ahead positive control, and outcome-free counts of the real signal. No mean / t / win of the real rule on the real funding is computed or written." });
    const g = C.leak.perGatePassRate, gc = C.circ.perGatePassRate, p = pp1, pk = placeboGateKey(dec.q);
    console.log(`R314 source: attempts ${cov.attempts.map((a) => `${a.source} ${a.status}${a.served ? " served" : ""}`).join(" | ")}`);
    console.log(`  BTC funding ${cov.btcFunding.symbol} ${cov.btcFunding.firstPrint} .. ${cov.btcFunding.lastPrint} (${cov.btcFunding.years} y), incomplete days ${cov.btcFunding.incompleteDays}, last complete ${cov.btcFunding.lastCompleteDay} · window ${C.win.fromDate}..${C.win.toDate} · z defined ${cov.zDefinedFrom}..${cov.zDefinedTo}`);
    console.log(`  candles BTC-USD ${cov.candles["BTC-USD"].firstDay}..${cov.candles["BTC-USD"].lastDay} missing in window ${cov.btcCandlesMissingInWindow} · ETH funding ${JSON.stringify(Object.fromEntries(Object.entries(cov.ethFunding).map(([k, v]) => [k, `${v.firstPrint && v.firstPrint.slice(0, 10)}..${v.lastPrint && v.lastPrint.slice(0, 10)}`])))}`);
    console.log(`  outcome-free real signal: ${C.outcomeFree.entries} entries (${C.outcomeFree.closable} closable, ${C.outcomeFree.openAtEnd} open), ${C.outcomeFree.signalDays} signal days, sd90 p50 ${C.outcomeFree.signalDaySd90Bps && C.outcomeFree.signalDaySd90Bps.p50} bps`);
    console.log(`  gate set in force: ${C.leak.gateSetInForce} ${JSON.stringify(dec.tokens)}`);
    console.log(`  LEAK (block shuffle, ${C.leak.shuffles}): per-gate pass% trades>=25 ${p(g.tradesAtLeast25)} · mean>0 ${p(g.meanNetPositive)} · t>=bar ${p(g.tAtLeastBar)} · ${pk} ${p(g[pk])} · halves ${p(g.bothHalvesPositive)} · WHOLE RULE ${p(C.leak.wholeRuleFalsePass)}% (SE ${p(C.leak.binomialSE)}) -> ${leakPass ? "PASS" : "FAIL"}`);
    console.log(`     trades p50 ${C.leak.trades.p50} [${C.leak.trades.min}..${C.leak.trades.max}] · t p50 ${C.leak.t.p50} · placebo beaten | t>=bar ${p(C.leak.conditional.placeboBeatenGivenTAtLeastBar)}% · placebo dispersion sd ${C.leak.placeboDispersion.sd}`);
    console.log(`     by placebo quantile (alone / whole rule): p95 ${p(L.p95.placeboAloneFalsePass)} / ${p(L.p95.wholeRuleFalsePass)} · p97.5 ${p(L.p975.placeboAloneFalsePass)} / ${p(L.p975.wholeRuleFalsePass)} · p99 ${p(L.p99.placeboAloneFalsePass)} / ${p(L.p99.wholeRuleFalsePass)} · shuffle-null LOO alone ${p(C.leak.blockShuffleNullLOO.aloneFalsePass)} / with core ${p(C.leak.blockShuffleNullLOO.withCoreFalsePass)}`);
    { const A = C.leak.placeboExclusionAblation; console.log(`     exclusion ablation: dispersion sd registered ${A.dispersionSd.registered} · no exclusion ${A.dispersionSd.noExclusion} · de-clustered ${A.dispersionSd.declustered} · corr(obs, pool mean) ${A.corrObservedVsPoolMean.registeredExclusion} vs ${A.corrObservedVsPoolMean.noExclusion} no-excl · no-excl whole rule p95 ${p(A.noExclusionFalsePass.wholeRuleAtP95)}% · trades/episode ${A.tradesPerEpisodeMean} (real ${C.outcomeFree.tradesPerEpisode})`); }
    console.log(`  CIRCULAR (diagnostic, ${C.circ.shuffles}): trades>=25 ${p(gc.tradesAtLeast25)} · mean>0 ${p(gc.meanNetPositive)} · t>=bar ${p(gc.tAtLeastBar)} · ${pk} ${p(gc[pk])} · halves ${p(gc.bothHalvesPositive)} · WHOLE RULE ${p(C.circ.wholeRuleFalsePass)}% · dispersion sd ${C.circ.placeboDispersion.sd}`);
    console.log(`     by placebo quantile (alone / whole rule): p95 ${p(Cq.p95.placeboAloneFalsePass)} / ${p(Cq.p95.wholeRuleFalsePass)} · p97.5 ${p(Cq.p975.placeboAloneFalsePass)} / ${p(Cq.p975.wholeRuleFalsePass)} · p99 ${p(Cq.p99.placeboAloneFalsePass)} / ${p(Cq.p99.wholeRuleFalsePass)}`);
    if (proposedAmendment) console.log(`  PROPOSED pre-evidence amendment (not recorded): runnerGates ${JSON.stringify(proposedAmendment.runnerGates)} — see proposedAmendment in ${path.basename(CTRL)}`);
    console.log(`  POSITIVE CONTROL (look-ahead): n ${C.pc.n} · mean ${C.pc.meanNetPct}% · t ${C.pc.t} -> ${C.pc.pass ? "PASS" : "FAIL"} · whole rule on look-ahead ${C.pc.wholeRulePassOnLookAhead ? "PASS" : "FAIL"}`);
    console.log(pass ? `R314 READY — the one read is: node backend/${STEM}.js --read` : `R314 NOT READY — ${holdWhy}`);
    return;
  }

  // ── THE READ (once) ──
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || seals)[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error(`${ID} already read — seal it, do not re-read`); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null;
  if (!ctrl || ctrl.spec !== "r314-controls-v1" || !ctrl.pass) { console.error(`${ID} controls have not passed${ctrl && ctrl.holdWhy ? ` (${ctrl.holdWhy})` : ""} — refusing`); process.exit(2); }
  const runnerSha = sha256(fs.readFileSync(__filename));
  if (!ctrl.runner || ctrl.runner.sha256 !== runnerSha) { console.error(`${ID} controls were produced by a different runner (${ctrl.runner && ctrl.runner.sha256} vs ${runnerSha}) — re-run the controls`); process.exit(2); }
  const { cache, sha } = await loadOrFetch(false);
  if (!ctrl.cache || ctrl.cache.sha256 !== sha) { console.error(`${ID} cache sha256 ${sha} differs from the controls run's ${ctrl.cache && ctrl.cache.sha256} — refusing`); process.exit(2); }
  if (JSON.stringify(ctrl.preReadDecision && ctrl.preReadDecision.tokens) !== JSON.stringify(dec.tokens) || ctrl.bar !== bar) { console.error(`${ID} registry window/bar changed since the controls run — re-run the controls`); process.exit(2); }
  if (!cache.fundingSource) { console.error(`${ID} no funding source in the cache — CANNOT MEASURE is recorded by the controls file`); process.exit(2); }
  const { out, lines } = computeRead({ cache, sha, ctrl, dec, bar });
  writeJsonAtomic(OUT, out);
  for (const l of lines) console.log(l);
}
// Run only when invoked directly. A require() gets the pure functions and never reaches main: no fetch, no write.
if (require.main === module) main().catch((e) => { console.error("R314 FAILED:", e.message); process.exit(1); });
else module.exports = { controlsRun, normalizeFunding, dailyFunding, f7z, buildCoin, withFunding, windowOf, simulate, entriesOutcomeFree, summarise, tStat, placeboPrep, placeboRun, sampleGates, verdictOf,
  blockShuffle, circularShift, longestRun, onSegment, preReadDecision, selftest, packCandles, computeRead, mulberry, parseIntervalMs, zLE, zGE, crossLE, CACHE, COST, HOLD, Z_ENTRY, fin };
