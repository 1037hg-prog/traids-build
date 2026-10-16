"use strict";
/**
 * AI-BUBBLE CONTINGENCY LADDER — the B1 and B2 rungs, as arithmetic over stored daily closes. READ-ONLY: this file reads
 * series files and computes; it writes nothing, opens no socket, and knows nothing about orders, positions or accounts.
 *
 * WHERE THE RULES COME FROM. The contingency plan's own write-up (docs/ai-bubble-contingency-plan-2026-10-07.md) is a
 * markdown file and is NOT in this code-only copy, so every rule below is taken from the CODE of the 10-07 measurement
 * lenses in docs/ai-bubble-2026-10/, line by line. Nothing here is a new rule:
 *
 *   B1 — THE FAST RUNG: the daily 200-day band tripwire.
 *        docs/ai-bubble-2026-10/plan-sizing.cjs:23-24   "tripwire: QQQ 200d -2% band" and the band exit printed for
 *                                                       QQQ, SPY and SMH: 0.98 x (1 + SMA/P - 1) - 1 from the close
 *        docs/ai-bubble-2026-10/plan-review/precedent.cjs:9   "band exit 0.98*sma ... band re-entry 1.02*sma"
 *        docs/ai-bubble-2026-10/bust/triggers.js:51-57  dailyTrend(S, 200, 0.02), signal 'b2 200-day +/-2% band':
 *                                                       held -> out when close < SMA x (1 - 0.02); out -> held when
 *                                                       close > SMA x (1 + 0.02); otherwise the reading carries forward.
 *        ARMED here = that rule reads OUT. The band is hysteresis, so the reading depends on the run of sessions before
 *        it, not on the last close alone: it is rebuilt from the first session with 200 closes behind it, every time.
 *
 *   B2 — THE SLOW RUNG: the monthly 10-month trend flip.
 *        docs/ai-bubble-2026-10/bust/triggers.js:50      tenMonth: at a month-end, IN iff the month-end close is
 *                                                        STRICTLY ABOVE the mean of the last 10 month-end closes
 *                                                        INCLUDING the current one; carried forward between month-ends
 *        docs/ai-bubble-2026-10/plan-review/flip-levels.cjs:1-10   the same rule, and the flip level X* = the mean of
 *                                                        the 9 COMPLETED month-ends, for QQQ, SPY and VWEHX/VFITX
 *        docs/ai-bubble-2026-10/dalio-plan/trend-lag.cjs:3-5, dalio-hedge/trend-status.cjs:3-4, and the live
 *                                                        backend/book-etf-rebalancer.js:64 (the Plan E sleeves' rule)
 *        ARMED here = that rule reads OUT. Equality arms it: IN needs STRICTLY above (triggers.js `S[i] > mean`).
 *
 *   THE RUNGS (LADDER below) are the series those lenses measure: B1 on QQQ, SPY and SMH (plan-sizing.cjs:24), B2 on
 *   QQQ, SPY and the credit ratio VWEHX/VFITX (flip-levels.cjs:12-15).
 *
 * MONTH-ENDS. A session is a month-end iff it is not the last session of the series and the next session falls in a
 * different calendar month (bust/triggers.js:41 isME, bust/now.js:8 monthEnds). So the last session is never a
 * month-end: the current month is still forming. B2 therefore reads the LAST COMPLETED month-end, and reports the
 * provisional reading beside it (bust/now.js:15): what the rule would say if the month ended at the latest close.
 *
 * SERIES. Dividend-adjusted daily closes, the `a` field of the stored rows, as every lens in docs/ai-bubble-2026-10/
 * reads them (bust/now.js:6 `ser`, triggers.js:32 `Y`). Rows are { d: "YYYY-MM-DD", c: close, a: adjusted close };
 * rows with a null `a` are dropped (bust/now.js:6). No splice to an index proxy is done here: the band needs 200
 * sessions and the flip 10 month-ends, both inside the ETF era.
 */
const fs = require("fs"), path = require("path");

/** the ladder: one entry per rung, in the order the summary prints them */
const LADDER = Object.freeze([
  Object.freeze({ id: "B1-QQQ", level: "B1", kind: "band200", sym: "QQQ", n: 200, band: 0.02,
    what: "QQQ daily close vs its 200-day SMA, +/-2% band", source: "bust/triggers.js:51-57 dailyTrend(S,200,0.02); plan-sizing.cjs:24" }),
  Object.freeze({ id: "B1-SPY", level: "B1", kind: "band200", sym: "SPY", n: 200, band: 0.02,
    what: "SPY daily close vs its 200-day SMA, +/-2% band", source: "bust/triggers.js:51-57 dailyTrend(S,200,0.02); plan-sizing.cjs:24" }),
  Object.freeze({ id: "B1-SMH", level: "B1", kind: "band200", sym: "SMH", n: 200, band: 0.02,
    what: "SMH daily close vs its 200-day SMA, +/-2% band", source: "bust/triggers.js:51-57 dailyTrend(S,200,0.02); plan-sizing.cjs:24" }),
  Object.freeze({ id: "B2-QQQ", level: "B2", kind: "tenMonth", sym: "QQQ", n: 10,
    what: "QQQ month-end close vs the mean of the last 10 month-ends", source: "bust/triggers.js:50 tenMonth; plan-review/flip-levels.cjs:12" }),
  Object.freeze({ id: "B2-SPY", level: "B2", kind: "tenMonth", sym: "SPY", n: 10,
    what: "SPY month-end close vs the mean of the last 10 month-ends", source: "bust/triggers.js:50 tenMonth; plan-review/flip-levels.cjs:12" }),
  Object.freeze({ id: "B2-CREDIT", level: "B2", kind: "tenMonth", ratio: Object.freeze(["VWEHX", "VFITX"]), n: 10,
    what: "VWEHX/VFITX month-end ratio vs the mean of its last 10 month-ends", source: "bust/triggers.js:50,83 ('d5'); plan-review/flip-levels.cjs:13-15" }),
]);

/** every series file a run of the whole ladder needs, once each */
const SYMBOLS = Object.freeze([...new Set(LADDER.flatMap((r) => (r.ratio ? [...r.ratio] : [r.sym])))]);

const STATUS_SPEC = "ai-bubble-ladder-status-v1";

// ───────────────────────────────────────────────── the arithmetic ─────────────────────────────────────────────────

/** the mean of the n values ending at i, or null when there are not n of them (bust/triggers.js:44 sma) */
function sma(values, i, n) {
  if (!Number.isInteger(i) || i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) { const v = values[k]; if (!Number.isFinite(v)) return null; s += v; }
  return s / n;
}

/**
 * the indices of the month-end sessions: a session whose NEXT session falls in another month. The last session of the
 * series is never one — the current month is still forming (bust/triggers.js:41, bust/now.js:8).
 */
function monthEndIdx(dates) {
  const out = [];
  for (let i = 0; i < dates.length - 1; i++) if (String(dates[i]).slice(0, 7) !== String(dates[i + 1]).slice(0, 7)) out.push(i);
  return out;
}

/**
 * the 200-day band reading at every session: 0 = armed (the rule is OUT), 1 = not armed (IN), null = not yet available.
 * Exactly bust/triggers.js:51-57 dailyTrend(S, n, band): the first reading with n closes behind it is the plain
 * close-vs-SMA test, and from then on the band holds the reading until the close clears the far side of it.
 */
function bandTrend(values, n, band) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const m = sma(values, i, n), v = values[i];
    if (m == null || !Number.isFinite(v)) { out[i] = prev; continue; }
    let r;
    if (band === 0 || prev == null) r = v > m ? 1 : 0;
    else if (prev === 1) r = v < m * (1 - band) ? 0 : 1;
    else r = v > m * (1 + band) ? 1 : 0;
    out[i] = prev = r;
  }
  return out;
}

/**
 * the 10-month reading at every session: 0 = armed (OUT), 1 = not armed (IN), null = not yet available. Exactly
 * bust/triggers.js:45-50: judged at month-ends only — IN iff the month-end value is STRICTLY ABOVE the mean of the
 * last n month-end values INCLUDING it — and carried forward over the days between.
 */
function tenMonthTrend(values, dates, n) {
  const out = new Array(values.length).fill(null), me = monthEndIdx(dates), meSet = new Set(me);
  let cur = null, seen = 0;
  for (let i = 0; i < values.length; i++) {
    if (meSet.has(i)) {
      seen++;
      if (seen >= n) {
        const win = me.slice(seen - n, seen).map((k) => values[k]);
        if (win.every((x) => Number.isFinite(x))) cur = values[i] > win.reduce((a, b) => a + b, 0) / n ? 1 : 0;
      }
    }
    out[i] = cur;
  }
  return out;
}

/** the date the current run of readings started (the first session of the last unbroken run of `reading`), or null */
function runStart(readings, dates, i) {
  const want = readings[i];
  if (want == null) return null;
  let k = i;
  while (k > 0 && readings[k - 1] === want) k--;
  return dates[k];
}

// ───────────────────────────────────────────────── reading the store ─────────────────────────────────────────────────

/**
 * one stored series -> { sym, dates, values, rows, from, to, path }. `a` (the dividend-adjusted close) is the value,
 * rows without a finite `a` are dropped, and rows after `cut` (inclusive bound, a YYYY-MM-DD string) are left out —
 * the lenses' CUT (bust/triggers.js:22). Throws when the file is missing, is not JSON, or holds no usable row.
 */
function readSeries(dir, sym, cut) {
  const file = path.join(dir, `${sym}.json`);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new Error(`${sym}: cannot read ${file} (${e.code || e.message})`); }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${sym}: ${file} is not JSON (${e.message})`); }
  if (!Array.isArray(raw)) throw new Error(`${sym}: ${file} is not an array of rows`);
  const rows = [];
  for (const r of raw) {
    if (!r || typeof r.d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.d)) continue;
    if (cut && r.d > cut) continue;
    if (!Number.isFinite(r.a)) continue;
    rows.push({ d: r.d, a: r.a });
  }
  rows.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
  if (!rows.length) throw new Error(`${sym}: ${file} holds no row with a finite adjusted close${cut ? ` on or before ${cut}` : ""}`);
  for (let i = 1; i < rows.length; i++) if (rows[i].d === rows[i - 1].d) throw new Error(`${sym}: ${file} holds two rows for ${rows[i].d}`);
  return { sym, path: file, dates: rows.map((r) => r.d), values: rows.map((r) => r.a), rows: rows.length, from: rows[0].d, to: rows[rows.length - 1].d };
}

/** every series the ladder needs -> { [sym]: series }. Throws on the first one that cannot be read. */
function readStore(dir, cut, symbols = SYMBOLS) {
  const out = {};
  for (const s of symbols) out[s] = readSeries(dir, s, cut);
  return out;
}

/**
 * a ratio series from two stored series, on the dates BOTH have (plan-review/flip-levels.cjs:13-14):
 * value = numerator / denominator.
 */
function ratioSeries(a, b) {
  const m = new Map(b.dates.map((d, i) => [d, b.values[i]]));
  const dates = [], values = [];
  for (let i = 0; i < a.dates.length; i++) {
    const d = a.dates[i], q = m.get(d);
    if (!Number.isFinite(q) || q === 0) continue;
    dates.push(d); values.push(a.values[i] / q);
  }
  return { sym: `${a.sym}/${b.sym}`, path: `${a.path} / ${b.path}`, dates, values, rows: dates.length, from: dates[0] || null, to: dates[dates.length - 1] || null };
}

/** the series one rung reads, built from the store */
function seriesFor(rung, store) {
  if (rung.ratio) return ratioSeries(store[rung.ratio[0]], store[rung.ratio[1]]);
  return store[rung.sym];
}

/** a series with every session after `cut` left off (same shape; the same object when nothing is cut) */
function trimSeries(s, cut) {
  if (!cut || !s.dates.length || s.dates[s.dates.length - 1] <= cut) return s;
  let n = s.dates.length;
  while (n > 0 && s.dates[n - 1] > cut) n--;
  const dates = s.dates.slice(0, n), values = s.values.slice(0, n);
  return { ...s, dates, values, rows: n, from: dates[0] || null, to: dates[n - 1] || null };
}

// ───────────────────────────────────────────────── one rung ─────────────────────────────────────────────────

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
const r6 = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);

/**
 * one rung's status: whether it is ARMED, the value it read, and the threshold that value is judged against.
 *
 *   B1  value = the latest adjusted close; sma = its 200-day mean; armThreshold = 0.98 x sma (a close STRICTLY BELOW
 *       it arms the rung from not-armed); disarmThreshold = 1.02 x sma (a close STRICTLY ABOVE it disarms it);
 *       threshold = whichever of the two the CURRENT reading is judged against, so distanceToThresholdPct says how
 *       far the close is from changing the rung's state.
 *   B2  value = the last COMPLETED month-end's close; threshold = the mean of the last 10 month-end closes INCLUDING
 *       it; armed iff value <= threshold. `provisional` is the same test with the forming month replaced by the
 *       latest close (bust/now.js:15): its threshold is the flip level X*, the mean of the 9 completed month-ends
 *       (plan-review/flip-levels.cjs:8).
 *
 * `available` is false when the series is too short for the rule (fewer than 200 closes, fewer than 10 month-ends);
 * `armed` is then null — never false. An unavailable rung is a rung that was not read, not a rung that is quiet.
 */
function computeRung(rung, store) {
  const s = seriesFor(rung, store);
  const out = { id: rung.id, level: rung.level, kind: rung.kind, what: rung.what, source: rung.source, series: s.sym,
    sessions: s.rows, seriesFrom: s.from, seriesTo: s.to, available: false, armed: null, value: null, threshold: null, note: null };
  const i = s.values.length - 1;
  if (i < 0) { out.note = "the series is empty"; return out; }

  if (rung.kind === "band200") {
    const readings = bandTrend(s.values, rung.n, rung.band), reading = readings[i], m = sma(s.values, i, rung.n);
    out.asOf = s.dates[i];
    out.value = r4(s.values[i]);
    out.sma = r4(m);
    out.smaSessions = rung.n;
    out.bandPct = rung.band;
    if (reading == null || m == null) { out.note = `fewer than ${rung.n} closes (${s.rows}) — the 200-day mean cannot be taken`; return out; }
    out.available = true;
    out.armed = reading === 0;
    out.armThreshold = r4(m * (1 - rung.band));
    out.disarmThreshold = r4(m * (1 + rung.band));
    out.threshold = out.armed ? out.disarmThreshold : out.armThreshold;
    out.thresholdIs = out.armed
      ? `disarm level 1.02 x the 200-day mean — a close STRICTLY ABOVE it would disarm this rung`
      : `arm level 0.98 x the 200-day mean — a close STRICTLY BELOW it would arm this rung`;
    out.distanceToThresholdPct = r6((out.value / out.threshold - 1) * 100);
    out.armedSince = out.armed ? runStart(readings, s.dates, i) : null;
    out.notArmedSince = out.armed ? null : runStart(readings, s.dates, i);
    return out;
  }

  if (rung.kind === "tenMonth") {
    const me = monthEndIdx(s.dates);
    out.asOf = s.dates[i];
    out.monthEnds = me.length;
    out.latestClose = r4(s.values[i]);
    if (me.length < rung.n) { out.note = `fewer than ${rung.n} completed month-ends (${me.length}) — the 10-month mean cannot be taken`; return out; }
    const last = me[me.length - 1], win = me.slice(-rung.n).map((k) => s.values[k]), mean = win.reduce((a, b) => a + b, 0) / rung.n;
    out.available = true;
    out.monthEnd = s.dates[last];
    out.value = r4(s.values[last]);
    out.threshold = r4(mean);
    out.thresholdIs = `the mean of the last ${rung.n} month-end closes INCLUDING ${s.dates[last]} — a month-end close STRICTLY ABOVE it is not armed, equal or below arms it`;
    out.armed = out.value <= out.threshold;
    out.distanceToThresholdPct = r6((out.value / out.threshold - 1) * 100);
    const readings = tenMonthTrend(s.values, s.dates, rung.n);
    out.armedSince = out.armed ? runStart(readings, s.dates, i) : null;
    out.notArmedSince = out.armed ? null : runStart(readings, s.dates, i);
    // the provisional reading: the forming month replaced by the latest close (bust/now.js:15); its threshold is the
    // flip level X* = the mean of the 9 completed month-ends (plan-review/flip-levels.cjs:8)
    const prior = me.slice(-(rung.n - 1)).map((k) => s.values[k]), star = prior.reduce((a, b) => a + b, 0) / (rung.n - 1);
    const provValue = r4(s.values[i]), provThreshold = r4(star);
    out.provisional = { asOf: s.dates[i], value: provValue, threshold: provThreshold,
      thresholdIs: `the flip level X* = the mean of the ${rung.n - 1} completed month-ends — the level the NEXT month-end close is judged against`,
      armedIfMonthEndedToday: provValue <= provThreshold, distanceToThresholdPct: r6((provValue / provThreshold - 1) * 100) };
    return out;
  }

  out.note = `unknown rung kind ${rung.kind}`;
  return out;
}

// ───────────────────────────────────────────────── the whole ladder ─────────────────────────────────────────────────

/**
 * the dated status of the whole ladder. o: { store, dataDir, cut, computedAt, ladder }.
 *
 * `date` — the status's date — is the OLDEST last session over the store, so every rung is read as of the one day all
 * of its series reach: a series that runs further is trimmed to it rather than letting one rung speak for a later day
 * than another. A series that lags is named in `behind`.
 */
function computeStatus({ store, dataDir = null, cut = null, computedAt = null, ladder = LADDER }) {
  const tos = Object.values(store).map((s) => s.to).filter(Boolean);
  const date = tos.length ? tos.slice().sort()[0] : null;
  const read = Object.fromEntries(Object.entries(store).map(([k, s]) => [k, trimSeries(s, date)]));
  const rungs = ladder.map((r) => computeRung(r, read));
  const armed = rungs.filter((r) => r.armed === true).map((r) => r.id);
  const unavailable = rungs.filter((r) => !r.available).map((r) => r.id);
  const newest = tos.length ? tos.slice().sort().pop() : null;
  const behind = Object.values(store).filter((s) => s.to && s.to < newest).map((s) => `${s.sym} ends ${s.to}`);
  const st = { spec: STATUS_SPEC, date, computedAt: computedAt || new Date().toISOString(), cut: cut || null, dataDir,
    series: Object.fromEntries(Object.values(store).map((s) => [s.sym, { rows: s.rows, from: s.from, to: s.to, readTo: read[s.sym] ? read[s.sym].to : null }])),
    behind, rungs, armed, armedCount: armed.length, available: rungs.length - unavailable.length, unavailable, readOnly: true };
  st.summary = summaryLines(st);
  return st;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "--");
const sgn = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) + "%" : "--");

/** the plain summary: a header, one line per rung, one closing line. No colour, no table drawing, nothing to decode. */
function summaryLines(st) {
  const L = [];
  L.push(`AI-BUBBLE LADDER — status for ${st.date || "(no date: no series)"} (read-only; nothing was ordered and nothing was changed)`);
  L.push(`  data ${st.dataDir || "(in memory)"}${st.cut ? ` · cut ${st.cut}` : ""} · computed ${st.computedAt}`);
  if ((st.behind || []).length) L.push(`  one or more series lag the newest: ${st.behind.join(", ")} — every rung was read as of ${st.date}`);
  for (const r of st.rungs) {
    if (!r.available) { L.push(`  ${pad(r.id, 10)} NOT READ   ${r.what} — ${r.note}`); continue; }
    const head = `  ${pad(r.id, 10)} ${r.armed ? "ARMED    " : "not armed"}  ${pad(r.what, 58)}`;
    if (r.kind === "band200") {
      L.push(`${head} close ${num(r.value)} vs ${r.armed ? "disarm" : "arm"} level ${num(r.threshold)} (${sgn(r.distanceToThresholdPct)}) · 200d mean ${num(r.sma)} · ${r.asOf}`);
    } else {
      L.push(`${head} month-end ${r.monthEnd} ${num(r.value)} vs 10-mo mean ${num(r.threshold)} (${sgn(r.distanceToThresholdPct)})`);
      L.push(`  ${pad("", 10)} ${pad("", 11)} provisional: latest close ${num(r.provisional.value)} (${r.provisional.asOf}) vs flip level X* ${num(r.provisional.threshold)} (${sgn(r.provisional.distanceToThresholdPct)}) -> ${r.provisional.armedIfMonthEndedToday ? "would ARM if the month ended today" : "would not arm if the month ended today"}`);
    }
  }
  L.push(`  ${st.armedCount} of ${st.available} read rung(s) ARMED${st.armed.length ? ": " + st.armed.join(", ") : ""}${st.unavailable.length ? ` · not read: ${st.unavailable.join(", ")}` : ""}`);
  L.push("  This is a reading, not an instruction: no order was placed, no position was changed, no switch was set.");
  return L;
}

/**
 * the day's status merged into a status document: one key per date, the day written replacing only its own key.
 * doc may be null (a new document). Returns a NEW document; nothing is written here.
 */
function mergeStatus(doc, st) {
  const prev = doc && doc.spec === STATUS_SPEC && doc.days && typeof doc.days === "object" ? doc.days : {};
  if (!st.date) throw new Error("the status has no date — refusing to write it");
  const days = { ...prev, [st.date]: st };
  const keys = Object.keys(days).sort();
  return { spec: STATUS_SPEC, updatedAt: st.computedAt, dates: keys, days: Object.fromEntries(keys.map((k) => [k, days[k]])) };
}

module.exports = { LADDER, SYMBOLS, STATUS_SPEC, sma, monthEndIdx, bandTrend, tenMonthTrend, runStart,
  readSeries, readStore, ratioSeries, seriesFor, trimSeries, computeRung, computeStatus, summaryLines, mergeStatus };
