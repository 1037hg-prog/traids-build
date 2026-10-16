#!/usr/bin/env node
/**
 * TURN_OF_MONTH — month-end cash demand / the turn-of-the-month effect on SPY, pre-registered, sealed holdout.
 *
 * HYPOTHESIS. Equity returns are concentrated around the turn of the month: investors' month-end cash needs (Etula, Rinne, Suominen &
 * Vaittinen 2020, "Dash for Cash: Monthly Market Impact of Institutional Liquidity Needs", Review of Financial Studies 33(1)) depress
 * prices in the days before month end and the release of month-start inflows lifts them in the first days of the new month
 * (Ariel 1987 JFE "A monthly effect in stock returns"; Lakonishok & Smidt 1988 RFS "Are seasonal anomalies real? A ninety-year
 * perspective"; McConnell & Xu 2008 FAJ "Equity returns at the turn of the month"). Prediction: SPY's mean daily return inside the
 * turn-of-month (TOM) window exceeds its mean daily return on the same month's remaining (non-TOM) days.
 *
 * DATA. SPY daily bars, Alpaca SIP, adjustment=all (total return, dividends reinvested), fetched by lib/alpaca-bars.js fetchBars.
 * Daily return r_i = close_i / close_{i-1} - 1 (consecutive trading days). Trading days = the dates SPY printed a daily bar (ET date).
 *
 * EXACT MECHANICAL RULE (single variant, fixed before any computation).
 *   Let month m have trading days d_1..d_N. The TOM window that ENDS in month m opens at the close of the 4th-to-last trading day of
 *   month m-1 and closes at the close of d_3 of month m: long SPY across those 6 daily returns (last 3 days of m-1, first 3 of m), cash
 *   otherwise. The non-TOM days of month m are d_4..d_{N-3} (every month-m day inside neither the window ending in m nor the window
 *   starting in m). The calendar positions are known in advance (the exchange holiday calendar is published ahead), and every close used
 *   for unit m is known by the close of d_{N-3} of month m; positions start at the next available close after the decision.
 *   Per-month unit, labelled by month m (the month the window closes in):
 *       gross_m = mean(r over the 6 TOM-window days) - mean(r over month m's non-TOM days)          [daily-return units]
 *       net_m   = gross_m - 0.0002 / nTOM          (0.02% round trip per month, amortised over the nTOM = 6 holding days)
 *   A unit is formed only if month m-1 and month m are both complete in the fetched data (the first fetched month is never used as m-1;
 *   month m counts as complete only when the last bar ACTUALLY fetched is on/after m's last possible trading day — its last weekday —
 *   and the window calendar end reaches it too) and month m has >= 5 non-TOM days.
 *   Hence the partial month 2026-09 (data end 2026-09-22) forms no unit; the last holdout unit is 2026-08.
 *   FAIL CLOSED (fixes2026_09_23): the fetch must be strictly increasing after dropping exact duplicate bars (a conflicting duplicate or a
 *   bad close refuses); every month the window reads (m-1 of the first unit .. the last unit, edge years 2021 / 2026 included) must be
 *   present and complete with <= 3 missing weekdays and no > 5-day gap; and the window must form EXACTLY its expected unit months.
 *   Any failure exits 2 (REFUSED) rather than silently shortening. Every bar comparison uses unrounded values (summary.raw).
 *
 * STATISTIC. Newey-West t (Bartlett, lag 3) of the monthly net_m series; reported with the mean (bps/day), gross and net, and the means of
 * both halves (first floor(n/2) units / the rest). Context (weightless): mean net TOM-window return per month, compounded.
 *
 * COST MODEL. 0.02% (2 bps) per round trip per month on SPY, charged against the TOM leg as 0.0002/6 per TOM day.
 *
 * WINDOWS. DISCOVERY units 2017-01..2021-12 (60 months; data fetched 2016-10-01..2021-12-31 ONLY). HOLDOUT units 2022-01..2026-09 per the
 * calendar 2022-01-01..2026-09-22 (the 2022-01 unit uses the last three days of 2021-12 — discovery data flowing forward, never the
 * reverse). The holdout fetch is issued only inside --holdout; every other mode fetches with end 2021-12-31 and asserts no later date.
 *
 * PROTOCOL.
 *   --selftest   synthetic known-answer checks (exact window indexing, effect recovery, NW calibration, holdout isolation, controls
 *                machinery, PASS rule). No network, no files. Exits 1 on FAIL.
 *   --controls   on discovery data only: (a) LEAK / NULL — the discovery-window SPY returns, demeaned, redrawn iid WITH replacement
 *                (bootstrap, seed 1701) onto the same calendar; the GROSS NW t must satisfy |t| < 2; (b) POSITIVE CONTROL — the window is
 *                chosen by peeking at the outcome (each month's 6 highest-return days among its TOM + non-TOM days are called "TOM"); gross
 *                NW t must be >= 5. Writes data/hunt/TURN_OF_MONTH-controls.json (a passed controls file is never overwritten).
 *   --discovery  refuses unless controls passed AND backend/data/test-registry.json has a preregistered entry with
 *                script === "backend/hunt/TURN_OF_MONTH.js"; computes discovery-window statistics only; writes
 *                data/hunt/TURN_OF_MONTH-discovery.json once (refuses to overwrite) with the frozen rule and this script's sha256.
 *                Discovery is descriptive: it is not a gate (single variant, the holdout decides).
 *   --holdout    refuses unless discovery exists (and the frozen rule + script hash match); computes the holdout statistic once;
 *                writes data/hunt/TURN_OF_MONTH-holdout.json once (refuses to overwrite).
 *   --status     prints which stages exist.
 *   PASS (holdout only): net mean > 0 AND NW t >= 1.70 (single variant) AND both holdout halves' net means > 0. Otherwise DID NOT PASS.
 *
 * Paper only: no broker calls, no orders. Market data read-only.
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("../lib/atomic-write.js");

const KEY = "TURN_OF_MONTH", SCRIPT = "backend/hunt/TURN_OF_MONTH.js";
const DATA = path.join(__dirname, "..", "data"), HD = path.join(DATA, "hunt");
const CTRL = path.join(HD, `${KEY}-controls.json`), OUTD = path.join(HD, `${KEY}-discovery.json`), OUTH = path.join(HD, `${KEY}-holdout.json`);
const REG = path.join(DATA, "test-registry.json");
const RULE = { preDays: 3, postDays: 3, costRoundTrip: 0.0002, nwLag: 3, barT: 1.70, minNonTom: 5, symbol: "SPY" };
const DISC = { from: "2017-01", to: "2021-12", fetchStart: "2016-10-01", fetchEnd: "2021-12-31T23:59:59Z", calEnd: "2021-12-31" };
const HOLD = { from: "2022-01", to: "2026-09", fetchStart: "2021-10-01", fetchEnd: "2026-09-22T23:59:59Z", calEnd: "2026-09-22" };
const NULL_SEED = 1701;

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a, L = RULE.nwLag) { const n = a.length; if (n < 6) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const lastCalDay = (ym) => { const [y, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
// display-only rounding. NEVER compare a rounded value against a bar (fixes2026_09_23 F1): verdicts read summary.raw.
const r4 = (x, k = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(k));
const ymShift = (ym, k) => { const [y, m] = ym.split("-").map(Number), t = new Date(Date.UTC(y, m - 1 + k, 1)); return t.toISOString().slice(0, 7); };
const monthsBetween = (a, b) => { const out = []; for (let ym = a; ym <= b; ym = ymShift(ym, 1)) out.push(ym); return out; };
// last weekday of a month: the latest date that month's last trading day can be (NYSE never trades weekends). Used as the completeness
// bound for the FINAL fetched month, whose last trading day the fetched data cannot reveal (fail closed if that weekday was a holiday).
const lastWeekday = (ym) => { let d = new Date(lastCalDay(ym) + "T12:00:00Z"); while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - 864e5); return d.toISOString().slice(0, 10); };
const weekdaysIn = (ym, upTo) => { const out = []; for (let d = new Date(ym + "-01T12:00:00Z"); d.toISOString().slice(0, 7) === ym; d = new Date(d.getTime() + 864e5)) { const s = d.toISOString().slice(0, 10), w = d.getUTCDay(); if (s > upTo) break; if (w !== 0 && w !== 6) out.push(s); } return out; };
class Refuse extends Error { constructor(msg) { super(msg); this.exitCode = 2; } }   // fail-closed refusals exit 2

// ---- data --------------------------------------------------------------------------------------------------------------------------
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDate = (iso) => { const p = Object.fromEntries(etFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
// T2: rows in FETCHED order [{d, c}]. Exact duplicates (same ET date, same close) are dropped; a same-date conflict, a bad close, a bad
// date, or any non-increasing date after dedupe is a refusal. Never sorts: an out-of-order fetch is a defect, not something to tidy.
function validateDays(rows, win) {
  if (!Array.isArray(rows) || !rows.length) throw new Refuse("fetch returned no SPY daily bars — fail closed");
  const seen = new Map(), days = []; let dups = 0;
  for (const x of rows) {
    if (!x || typeof x.d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x.d)) throw new Refuse(`malformed bar date ${JSON.stringify(x && x.d)} — fail closed`);
    if (!Number.isFinite(x.c) || x.c <= 0) throw new Refuse(`non-positive or non-finite close on ${x.d} (${x.c}) — fail closed`);
    if (seen.has(x.d)) { if (seen.get(x.d) !== x.c) throw new Refuse(`conflicting duplicate bars for ${x.d} (${seen.get(x.d)} vs ${x.c}) — fail closed`); dups++; continue; }
    seen.set(x.d, x.c); days.push({ d: x.d, c: x.c });
  }
  for (let i = 1; i < days.length; i++) if (!(days[i].d > days[i - 1].d)) throw new Refuse(`dates not strictly increasing in fetch order at ${days[i - 1].d} -> ${days[i].d} — fail closed`);
  if (win && days[days.length - 1].d > win.calEnd) throw new Refuse(`fetched a date past the window calendar end (${win.calEnd}) — refusing`);
  if (win && days[0].d < win.fetchStart) throw new Refuse(`fetched a date before the window fetch start (${win.fetchStart}) — refusing`);
  return { days, dups };
}
// the unit months a window must produce: every month in [from, to] whose last possible trading day is on/before the calendar end
const expectedUnitMonths = (win) => monthsBetween(win.from, win.to).filter((ym) => lastWeekday(ym) <= win.calEnd);
// T1: coverage over EVERY month the window's units read (m-1 of the first unit through the last unit, edge years included). Returns null
// when covered, else the list of problems. Month complete = the last bar actually fetched is on/after the month's last trading day
// (a later-month bar proves it; for the final month the bound is its last weekday). Holes: > 3 missing weekdays in a month (no NYSE month
// since 2001 closed more than 3 weekdays) or > 5 calendar days between consecutive bars.
function checkCoverage(days, win) {
  const exp = expectedUnitMonths(win); if (!exp.length) return [`window ${win.from}..${win.to} has no complete unit month by ${win.calEnd}`];
  const need = monthsBetween(ymShift(exp[0], -1), exp[exp.length - 1]), pre = ymShift(need[0], -1), probs = [];
  const byM = {}; for (const x of days) (byM[x.d.slice(0, 7)] ||= []).push(x.d);
  const lastBar = days.length ? days[days.length - 1].d : "";
  if (!byM[pre]) probs.push(`${pre} has no bars (the month before the first needed month ${need[0]} must be fetched so ${need[0]} is not the partial first month)`);
  for (const ym of need) {
    if (!byM[ym]) { probs.push(`${ym} has no bars`); continue; }
    if (!(lastBar >= lastWeekday(ym))) probs.push(`${ym} incomplete: last fetched bar ${lastBar} < ${ym}'s last possible trading day ${lastWeekday(ym)}`);
    const have = new Set(byM[ym]), miss = weekdaysIn(ym, lastBar < lastWeekday(ym) ? lastBar : lastCalDay(ym)).filter((d) => !have.has(d));
    if (miss.length > 3) probs.push(`${ym} missing ${miss.length} weekdays (> 3 holidays possible): ${miss.slice(0, 6).join(",")}${miss.length > 6 ? ",…" : ""}`);
  }
  const lo = pre + "-01", hi = lastCalDay(need[need.length - 1]);
  for (let i = 1; i < days.length; i++) { if (days[i].d < lo || days[i - 1].d > hi) continue; const g = (Date.parse(days[i].d) - Date.parse(days[i - 1].d)) / 864e5; if (g > 5) probs.push(`gap of ${g} calendar days ${days[i - 1].d} -> ${days[i].d}`); }
  return probs.length ? probs : null;
}
async function fetchSpy(win) {
  const { fetchBars } = require("../lib/alpaca-bars.js");
  const { bars } = await fetchBars([RULE.symbol], { start: win.fetchStart, end: win.fetchEnd, timeframe: "1Day", feed: "sip", adjustment: "all", quiet: true, requireAll: false });
  const { days, dups } = validateDays((bars[RULE.symbol] || []).map((b) => ({ d: etDate(b.t), c: +b.c })), win);
  if (dups) console.error(`${KEY}: dropped ${dups} exact duplicate daily bar(s) from the fetch`);
  const probs = checkCoverage(days, win); if (probs) throw new Refuse(`SPY coverage incomplete for ${win.from}..${win.to} — refusing rather than shortening:\n  ${probs.join("\n  ")}`);
  return days;
}

// ---- the rule ----------------------------------------------------------------------------------------------------------------------
// days: [{d:"YYYY-MM-DD", c}] sorted, one per trading day. calEnd: the data's calendar end (month completeness).
// Returns one unit per eligible month m: {ym, tom:[r...], non:[r...], gross, net}
function buildUnits(days, calEnd, rule = RULE, pick = null) {
  const r = days.map((x, i) => (i === 0 ? NaN : x.c / days[i - 1].c - 1));
  const months = []; for (let i = 0; i < days.length; i++) { const ym = days[i].d.slice(0, 7); if (!months.length || months[months.length - 1].ym !== ym) months.push({ ym, idx: [] }); months[months.length - 1].idx.push(i); }
  // T1: complete only if the last bar ACTUALLY fetched is on/after the month's last possible trading day (a later-month bar proves the
  // month closed; the final fetched month needs a bar on its last weekday) — and the window calendar end reaches it too.
  const lastBar = days.length ? days[days.length - 1].d : "";
  const complete = (ym) => { const lw = lastWeekday(ym); return calEnd >= lw && lastBar >= lw; };
  const units = [];
  for (let k = 1; k < months.length; k++) {
    const prev = months[k - 1], cur = months[k];
    if (k - 1 === 0) continue;                                   // the first fetched month may be partial: never used as m-1
    if (!complete(prev.ym) || !complete(cur.ym)) continue;
    const P = prev.idx, C = cur.idx, N = C.length;
    if (P.length < rule.preDays + 1 || N < rule.postDays + rule.preDays + rule.minNonTom) continue;
    const tomIdx = [...P.slice(P.length - rule.preDays), ...C.slice(0, rule.postDays)];
    const nonIdx = C.slice(rule.postDays, N - rule.preDays);
    let tom = tomIdx.map((i) => r[i]), non = nonIdx.map((i) => r[i]);
    if (tom.some((x) => !Number.isFinite(x)) || non.some((x) => !Number.isFinite(x))) continue;
    if (pick) ({ tom, non } = pick(tom, non));                   // positive control only
    const gross = mean(tom) - mean(non), net = gross - rule.costRoundTrip / tom.length;
    const tomWindowNet = tom.reduce((p, x) => p * (1 + x), 1) - 1 - rule.costRoundTrip;
    units.push({ ym: cur.ym, nTom: tom.length, nNon: non.length, tom, non, gross, net, tomWindowNet, tomDates: tomIdx.map((i) => days[i].d) });
  }
  return units;
}
const inWin = (units, win) => units.filter((u) => u.ym >= win.from && u.ym <= win.to);
// T1: the window's units must be EXACTLY the expected unit months — any missing month is a refusal (exit 2), never a shorter sample
function unitsForWindow(days, win, pick = null) {
  const U = inWin(buildUnits(days, win.calEnd, RULE, pick), win), exp = expectedUnitMonths(win), got = U.map((u) => u.ym);
  if (JSON.stringify(got) !== JSON.stringify(exp)) { const miss = exp.filter((m) => !got.includes(m)), extra = got.filter((m) => !exp.includes(m));
    throw new Refuse(`window ${win.from}..${win.to}: formed ${got.length} units, expected ${exp.length} — missing [${miss.join(",")}]${extra.length ? ` extra [${extra.join(",")}]` : ""} — refusing rather than shortening`); }
  return U;
}
// F1: every bar comparison reads `raw` (unrounded); the rounded fields are display only
function summarise(units) {
  const net = units.map((u) => u.net), gross = units.map((u) => u.gross), h = Math.floor(net.length / 2);
  if (net.length < 6) return { months: net.length, insufficient: true };
  const raw = { netMean: mean(net), grossMean: mean(gross), tNW: nwT(net), tGrossNW: nwT(gross), firstHalfNetMean: mean(net.slice(0, h)), secondHalfNetMean: mean(net.slice(h)) };
  return { months: net.length, first: units[0].ym, last: units[units.length - 1].ym,
    netBpsPerDay: r4(1e4 * raw.netMean), grossBpsPerDay: r4(1e4 * raw.grossMean), tNW: r4(raw.tNW, 3), tGrossNW: r4(raw.tGrossNW, 3),
    firstHalfNetBps: r4(1e4 * raw.firstHalfNetMean), secondHalfNetBps: r4(1e4 * raw.secondHalfNetMean),
    contextTomWindowNetPctPerMonth: r4(100 * mean(units.map((u) => u.tomWindowNet))), raw };
}
const fin = Number.isFinite;
function verdictOf(s, bar = RULE.barT) {
  const r = s && !s.insufficient && s.raw ? s.raw : null;
  return r && fin(bar) && fin(r.netMean) && r.netMean > 0 && fin(r.tNW) && r.tNW >= bar && fin(r.firstHalfNetMean) && r.firstHalfNetMean > 0 && fin(r.secondHalfNetMean) && r.secondHalfNetMean > 0 ? "PASS" : "DID NOT PASS";
}

// ---- controls machinery ------------------------------------------------------------------------------------------------------------
function bootstrapDays(days, seed) {   // demeaned daily returns redrawn iid WITH replacement onto the same calendar; closes rebuilt
  const rets = []; for (let i = 1; i < days.length; i++) rets.push(days[i].c / days[i - 1].c - 1);
  const mu = mean(rets), vals = rets.map((x) => x - mu), rng = mulberry(seed);
  const out = [{ d: days[0].d, c: 100 }]; for (let i = 1; i < days.length; i++) out.push({ d: days[i].d, c: out[i - 1].c * (1 + vals[Math.floor(rng() * vals.length)]) });
  return out;
}
const peekPick = (tom, non) => { const all = [...tom, ...non].sort((a, b) => b - a); return { tom: all.slice(0, tom.length), non: all.slice(tom.length) }; };
// F1: control gates on the UNROUNDED gross t (a raw 1.9996 displays as 2 but passes |t|<2; a raw 4.9996 displays as 5 but fails >=5)
const controlGates = (nullT, peekT) => { const leakOk = fin(nullT) && Math.abs(nullT) < 2, peekOk = fin(peekT) && peekT >= 5; return { leakOk, peekOk, pass: leakOk && peekOk }; };
function runControls(days) {
  const nul = summarise(unitsForWindow(bootstrapDays(days, NULL_SEED), DISC));
  const pk = summarise(unitsForWindow(days, DISC, peekPick));
  const g = controlGates(nul.raw && nul.raw.tGrossNW, pk.raw && pk.raw.tGrossNW);
  return { nullGrossT: nul.tGrossNW, nullMonths: nul.months, peekGrossT: pk.tGrossNW, nullGrossTRaw: nul.raw ? nul.raw.tGrossNW : null, peekGrossTRaw: pk.raw ? pk.raw.tGrossNW : null, ...g };
}
function gateDiscovery(ctrl, reg) {
  if (!ctrl || !ctrl.pass) return "controls have not passed";
  const pre = (reg && Array.isArray(reg.preregistered)) ? reg.preregistered : [];
  if (!pre.some((x) => x && x.script === SCRIPT)) return `no preregistered entry with script === "${SCRIPT}"`;
  return null;
}

// ---- selftest (synthetic only) -----------------------------------------------------------------------------------------------------
function synthCalendar(from = "2016-10-03", to = "2026-09-22") { const out = []; for (let t = Date.parse(from + "T12:00:00Z"); t <= Date.parse(to + "T12:00:00Z"); t += 864e5) { const d = new Date(t), w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); } return out; }
function independentTomSet(cal) {   // written separately from buildUnits: last 3 weekdays of each month + first 3 of each month
  const byM = {}; cal.forEach((d) => (byM[d.slice(0, 7)] ||= []).push(d)); const s = new Set();
  for (const ds of Object.values(byM)) { ds.slice(0, 3).forEach((d) => s.add(d)); ds.slice(-3).forEach((d) => s.add(d)); } return s;
}
function synthDays(cal, retFn) { const out = [{ d: cal[0], c: 100 }]; for (let i = 1; i < cal.length; i++) out.push({ d: cal[i], c: out[i - 1].c * (1 + retFn(cal[i], i)) }); return out; }
function selftest() {
  const res = [], ok = (name, pass, info) => { res.push({ name, pass: !!pass }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`); };
  const cal = synthCalendar(), tomSet = independentTomSet(cal), SYN_END = "2026-09-22";
  // 1. exact indexing: r = 10 bps on TOM days, 0 elsewhere -> gross exactly 10 bps every unit, net 10 - 2/6 bps
  { const days = synthDays(cal, (d) => (tomSet.has(d) ? 0.001 : 0)), U = inWin(buildUnits(days, DISC.calEnd), DISC);
    const exact = U.every((u) => Math.abs(u.gross - 0.001) < 1e-12 && Math.abs(u.net - (0.001 - 0.0002 / 6)) < 1e-12 && u.nTom === 6 && u.tomDates.every((d) => tomSet.has(d)));
    const u1 = U.find((u) => u.ym === "2017-03");
    ok("exact TOM indexing + cost (60 units, gross 10bps, net 9.6667bps)", exact && U.length === 60 && u1 && JSON.stringify(u1.tomDates) === JSON.stringify(["2017-02-24", "2017-02-27", "2017-02-28", "2017-03-01", "2017-03-02", "2017-03-03"]) && u1.nNon === 23 - 6, `units ${U.length}, 2017-03 window ${u1 && u1.tomDates.join(",")}`); }
  // 2. known effect recovery: sd 0.5%/day, +30 bps on TOM days -> gross ~30 bps, t > 5
  { const rng = mulberry(11), days = synthDays(cal, (d) => 0.005 * gauss(rng) + (tomSet.has(d) ? 0.003 : 0)), s = summarise(inWin(buildUnits(days, DISC.calEnd), DISC));
    ok("known effect recovered (true 30 bps/day, t>5)", Math.abs(s.grossBpsPerDay - 30) < 12 && s.tNW > 5 && Math.abs(s.netBpsPerDay - (s.grossBpsPerDay - 2 / 6)) < 1e-3, `gross ${s.grossBpsPerDay}bps net ${s.netBpsPerDay}bps t ${s.tNW}`); }
  // 3. null calibration of the NW t at n=60: rejection rate at |t|>=2 near 5%
  { let rej = 0, M = 400; for (let k = 0; k < M; k++) { const rng = mulberry(1000 + k), days = synthDays(cal, () => 0.01 * gauss(rng)), s = summarise(inWin(buildUnits(days, DISC.calEnd), DISC)); if (Math.abs(s.tGrossNW) >= 2) rej++; }
    ok("NW t calibrated on iid null (rate |t|>=2 in [1%,12%])", rej / M >= 0.01 && rej / M <= 0.12, `rate ${(100 * rej / M).toFixed(1)}% of ${M}`); }
  // 4. holdout isolation: discovery units identical with post-2021 data truncated or corrupted; discovery never forms a 2022 unit
  { const rng = mulberry(21), base = synthDays(cal, () => 0.01 * gauss(rng));
    const trunc = base.filter((x) => x.d <= DISC.calEnd), corrupt = base.map((x, i) => (x.d > DISC.calEnd ? { d: x.d, c: x.c * (1 + (i % 7) * 0.3) } : x));
    const a = JSON.stringify(summarise(inWin(buildUnits(trunc, DISC.calEnd), DISC))), b = JSON.stringify(summarise(inWin(buildUnits(corrupt, SYN_END), DISC))), c = JSON.stringify(summarise(inWin(buildUnits(base, SYN_END), DISC)));
    const noLeak = buildUnits(trunc, DISC.calEnd).every((u) => u.ym <= DISC.to && u.tomDates.every((d) => d <= DISC.calEnd));
    ok("discovery invariant to truncating/corrupting post-2021 data", a === b && b === c && noLeak); }
  // 5. incomplete final month forms no unit; last holdout unit 2026-08; 56 holdout units
  { const rng = mulberry(31), days = synthDays(cal.filter((d) => d >= HOLD.fetchStart), () => 0.01 * gauss(rng)), H = inWin(buildUnits(days, HOLD.calEnd), HOLD);
    ok("partial 2026-09 excluded; holdout = 2022-01..2026-08 (56 units)", H.length === 56 && H[0].ym === "2022-01" && H[H.length - 1].ym === "2026-08" && H[0].tomDates[0].startsWith("2021-12"), `${H.length} units ${H[0].ym}..${H[H.length - 1].ym}`); }
  // 6. controls machinery: bootstrap null kills a planted effect (gross |t|<2), peek control t>=5, on synthetic data
  { const rng = mulberry(41), days = synthDays(cal.filter((d) => d <= DISC.calEnd), (d) => 0.005 * gauss(rng) + (tomSet.has(d) ? 0.003 : 0)), c = runControls(days);
    let rej = 0; for (let k = 0; k < 100; k++) { const s = summarise(inWin(buildUnits(bootstrapDays(days, 5000 + k), DISC.calEnd), DISC)); if (Math.abs(s.tGrossNW) >= 2) rej++; }
    ok("controls: bootstrap null |gross t|<2 and peek t>=5 (planted effect)", c.leakOk && c.peekOk && rej <= 12, `null t ${c.nullGrossT}, peek t ${c.peekGrossT}, null rejection ${rej}/100`); }
  // 7. positive control fires on pure noise too (the peek is what it measures)
  { const rng = mulberry(51), days = synthDays(cal.filter((d) => d <= DISC.calEnd), () => 0.01 * gauss(rng)), c = runControls(days);
    ok("controls on pure noise: null |t|<2, peek t>=5", c.leakOk && c.peekOk, `null t ${c.nullGrossT}, peek t ${c.peekGrossT}`); }
  // 8. PASS rule and gates
  { const mk = (o) => ({ months: 56, raw: { netMean: 5e-4, tNW: 1.8, firstHalfNetMean: 3e-4, secondHalfNetMean: 7e-4, ...o } });
    const v = [verdictOf(mk({})) === "PASS", verdictOf(mk({ tNW: 1.69 })) === "DID NOT PASS", verdictOf(mk({ netMean: -1e-4 })) === "DID NOT PASS", verdictOf(mk({ secondHalfNetMean: -1e-5 })) === "DID NOT PASS", verdictOf(mk({ tNW: null })) === "DID NOT PASS", verdictOf({ months: 3, insufficient: true }) === "DID NOT PASS"];
    const g = [gateDiscovery(null, {}) != null, gateDiscovery({ pass: false }, { preregistered: [{ script: SCRIPT }] }) != null, gateDiscovery({ pass: true }, { preregistered: [{ script: "backend/other.js" }] }) != null, gateDiscovery({ pass: true }, { preregistered: [{ script: SCRIPT }] }) === null];
    ok("PASS rule (mean>0, t>=1.70, both halves>0) and discovery gate", v.every(Boolean) && g.every(Boolean)); }
  // 9. F1: verdict and control gates read UNROUNDED values. Rounded display must not rescue or sink a result.
  { const mk = (o) => ({ months: 56, raw: { netMean: 5e-4, tNW: 1.8, firstHalfNetMean: 3e-4, secondHalfNetMean: 7e-4, ...o } });
    const a = verdictOf(mk({ tNW: 1.6995 })) === "DID NOT PASS", b = verdictOf(mk({ tNW: 1.69996 })) === "DID NOT PASS" && r4(1.69996, 3) === 1.7, c = verdictOf(mk({ tNW: 1.7 })) === "PASS";
    const d = verdictOf(mk({ firstHalfNetMean: -1e-12 })) === "DID NOT PASS", e = verdictOf(mk({ netMean: 1e-12 })) === "PASS" && r4(1e4 * 1e-12) === 0;
    // end to end on a real summarise() output: a bar 1e-9 above the raw t FAILS, a bar exactly at the raw t PASSES (means forced > 0)
    const rng = mulberry(61), days = synthDays(cal.filter((d) => d <= DISC.calEnd), (d) => 0.005 * gauss(rng) + (tomSet.has(d) ? 0.0006 : 0)), s = summarise(unitsForWindow(days, DISC));
    const sp = { ...s, raw: { ...s.raw, netMean: 1e-4, firstHalfNetMean: 1e-4, secondHalfNetMean: 1e-4 } }, eDisp = typeof s.tNW === "number" && s.raw.tNW !== s.tNW;
    const eRaw = verdictOf(sp, s.raw.tNW + 1e-9) === "DID NOT PASS" && verdictOf(sp, s.raw.tNW) === "PASS";
    const cg = controlGates(1.9996, 5.0001).leakOk === true && r4(1.9996, 3) === 2 && controlGates(0, 4.9996).peekOk === false && r4(4.9996, 3) === 5 && controlGates(NaN, 9).pass === false;
    ok("F1 unrounded bars: raw t 1.6995 / 1.69996 FAIL a 1.70 bar; half -1e-12 FAILS; control gates on raw t", a && b && c && d && e && eDisp && eRaw && cg, `a${+a} b${+b} c${+c} d${+d} e${+e} eRaw${+eRaw} cg${+cg}`); }
  // 10. T1: coverage fails closed (exit-2 Refuse) on a truncated final month, a missing mid-window month, a missing edge-year month,
  //     a week-long hole, and a missing pre-month; clean discovery and holdout (partial 2026-09) pass. unitsForWindow refuses to shorten.
  { const rng = mulberry(71), full = synthDays(cal, () => 0.01 * gauss(rng)), dsc = full.filter((x) => x.d <= DISC.calEnd), hld = full.filter((x) => x.d >= HOLD.fetchStart);
    const refuses = (fn) => { try { fn(); return false; } catch (e) { return e instanceof Refuse && e.exitCode === 2; } };
    const cases = {
      cleanDisc: checkCoverage(dsc, DISC) === null && unitsForWindow(dsc, DISC).length === 60,
      cleanHold: checkCoverage(hld, HOLD) === null && unitsForWindow(hld, HOLD).length === 56,
      truncDec2021: checkCoverage(dsc.filter((x) => x.d <= "2021-12-29"), DISC) !== null && refuses(() => unitsForWindow(dsc.filter((x) => x.d <= "2021-12-29"), DISC)),
      missMid: checkCoverage(dsc.filter((x) => !x.d.startsWith("2019-05")), DISC) !== null,
      missEdge2021: checkCoverage(dsc.filter((x) => !x.d.startsWith("2021-11")), DISC) !== null && refuses(() => unitsForWindow(dsc.filter((x) => !x.d.startsWith("2021-11")), DISC)),
      missEdge2026: checkCoverage(hld.filter((x) => !x.d.startsWith("2026-08")), HOLD) !== null,
      truncAug2026: checkCoverage(hld.filter((x) => x.d <= "2026-08-27"), HOLD) !== null && refuses(() => unitsForWindow(hld.filter((x) => x.d <= "2026-08-27"), HOLD)),
      weekHole: checkCoverage(dsc.filter((x) => !(x.d >= "2018-03-12" && x.d <= "2018-03-16")), DISC) !== null,
      missPre: checkCoverage(dsc.filter((x) => x.d >= "2016-12-01"), DISC) !== null,
      oldBugWouldShorten: buildUnits(dsc.filter((x) => x.d <= "2021-12-29"), DISC.calEnd).every((u) => u.ym !== "2021-12"),
      expected: expectedUnitMonths(DISC).length === 60 && expectedUnitMonths(HOLD).length === 56 && expectedUnitMonths(HOLD).slice(-1)[0] === "2026-08" };
    ok("T1 coverage fails closed incl. edge years 2021 / 2026 (exit 2, never shortens)", Object.values(cases).every(Boolean), Object.entries(cases).filter(([, v]) => !v).map(([k]) => k).join(",") || "all cases"); }
  // 11. T2: exact duplicates dropped; conflicting duplicate, out-of-order, bad close, past-calEnd all refuse
  { const refuses = (fn) => { try { fn(); return false; } catch (e) { return e instanceof Refuse && e.exitCode === 2; } };
    const W = { fetchStart: "2016-10-01", calEnd: "2021-12-31" }, A = { d: "2020-01-02", c: 100 }, B = { d: "2020-01-03", c: 101 }, C = { d: "2020-01-06", c: 102 };
    const dd = validateDays([A, B, B, C, B], W), cases = {
      dedupe: dd.dups === 2 && dd.days.length === 3 && dd.days.map((x) => x.d).join() === "2020-01-02,2020-01-03,2020-01-06",
      conflict: refuses(() => validateDays([A, B, { d: B.d, c: 101.5 }, C], W)), outOfOrder: refuses(() => validateDays([A, C, B], W)),
      badClose: refuses(() => validateDays([A, { d: B.d, c: 0 }, C], W)) && refuses(() => validateDays([A, { d: B.d, c: NaN }, C], W)),
      pastEnd: refuses(() => validateDays([A, { d: "2022-01-03", c: 1 }], W)), empty: refuses(() => validateDays([], W)) };
    ok("T2 fetch dates: exact dups dropped, conflicts / non-increasing / bad closes refuse", Object.values(cases).every(Boolean), Object.entries(cases).filter(([, v]) => !v).map(([k]) => k).join(",") || "all cases"); }
  // 12. F2: require() of this script runs no mode (a child process requires it and must print nothing and exit 0)
  { const { spawnSync } = require("child_process"), p = spawnSync(process.execPath, ["-e", `const m=require(${JSON.stringify(__filename)}); if(typeof m.verdictOf!=="function") process.exit(3);`, "--", "--controls"], { encoding: "utf8", timeout: 20000 });
    ok("F2 require() runs no mode (even with --controls in argv)", p.status === 0 && !p.stdout && !p.stderr, `status ${p.status} out ${JSON.stringify((p.stdout || "") + (p.stderr || "")).slice(0, 120)}`); }
  const pass = res.every((x) => x.pass); console.log(`TURN_OF_MONTH selftest: ${pass ? "PASS" : "FAIL"} (${res.filter((x) => x.pass).length}/${res.length})`); return pass;
}

// ---- main --------------------------------------------------------------------------------------------------------------------------
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const scriptHash = () => crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
module.exports = { KEY, SCRIPT, RULE, DISC, HOLD, Refuse, nwT, buildUnits, unitsForWindow, summarise, verdictOf, controlGates, runControls, validateDays, checkCoverage, expectedUnitMonths, gateDiscovery, selftest };
// F2: runs a mode ONLY when executed directly — require() never fetches, writes or reads anything (house rule: never require a runner)
if (require.main === module) (async () => {
  const mode = ["--selftest", "--controls", "--discovery", "--holdout", "--status"].find((m) => process.argv.includes(m)) || "--status";
  if (mode === "--selftest") { process.exit(selftest() ? 0 : 1); }
  if (mode === "--status") { console.log(`${KEY}: controls ${fs.existsSync(CTRL) ? (readJson(CTRL).pass ? "PASSED" : "FAILED") : "pending"} · discovery ${fs.existsSync(OUTD) ? "sealed" : "pending"} · holdout ${fs.existsSync(OUTH) ? "READ" : "sealed/unopened"}`); return; }
  fs.mkdirSync(HD, { recursive: true });
  if (mode === "--controls") {
    const prior = readJson(CTRL); if (prior && prior.pass) { console.error("controls already passed — refusing to overwrite"); process.exit(2); }
    const days = await fetchSpy(DISC); const c = runControls(days);
    writeJsonAtomic(CTRL, { spec: `${KEY}-controls-v1`, asOf: new Date().toISOString(), window: DISC, nullSeed: NULL_SEED, ...c });
    console.log(`${KEY} controls — bootstrap null |gross t|<2: ${c.leakOk ? "PASS" : "FAIL"} (t ${c.nullGrossT}, ${c.nullMonths} months) · positive control gross t ${c.peekGrossT} ${c.peekOk ? "PASS" : "FAIL"}`);
    process.exit(c.pass ? 0 : 1);
  }
  if (mode === "--discovery") {
    if (fs.existsSync(OUTD)) { console.error("discovery already sealed — refusing"); process.exit(2); }
    const why = gateDiscovery(readJson(CTRL), readJson(REG)); if (why) { console.error(`refusing discovery: ${why}`); process.exit(2); }
    const days = await fetchSpy(DISC), s = summarise(unitsForWindow(days, DISC));
    writeJsonAtomic(OUTD, { spec: `${KEY}-discovery-v1`, sealedAt: new Date().toISOString(), window: DISC, rule: RULE, scriptSha256: scriptHash(), results: s, note: "descriptive; single variant — the holdout decides" });
    console.log(`${KEY} DISCOVERY ${DISC.from}..${DISC.to} (sealed) — ${s.months} months · net ${s.netBpsPerDay} bps/day (gross ${s.grossBpsPerDay}) · NW t ${s.tNW} (gross t ${s.tGrossNW}) · halves ${s.firstHalfNetBps}/${s.secondHalfNetBps} · TOM window net ${s.contextTomWindowNetPctPerMonth}%/mo (context)`);
    return;
  }
  if (mode === "--holdout") {
    if (fs.existsSync(OUTH)) { console.error("holdout already read — refusing"); process.exit(2); }
    const disc = readJson(OUTD); if (!disc) { console.error("no sealed discovery — refusing"); process.exit(2); }
    const why = gateDiscovery(readJson(CTRL), readJson(REG)); if (why) { console.error(`refusing holdout: ${why}`); process.exit(2); }
    if (JSON.stringify(disc.rule) !== JSON.stringify(RULE)) { console.error("frozen rule differs from the sealed discovery — refusing"); process.exit(2); }
    if (disc.scriptSha256 !== scriptHash()) { console.error("script changed since discovery was sealed — refusing"); process.exit(2); }
    const days = await fetchSpy(HOLD), s = summarise(unitsForWindow(days, HOLD)), verdict = verdictOf(s, disc.rule.barT);
    writeJsonAtomic(OUTH, { spec: `${KEY}-holdout-v1`, read: true, asOf: new Date().toISOString(), window: HOLD, bar: disc.rule.barT, results: s, verdict });
    console.log(`${KEY} HOLDOUT ${HOLD.from}..${s.last} — ${verdict} (bar t >= ${disc.rule.barT}) · ${s.months} months · net ${s.netBpsPerDay} bps/day (gross ${s.grossBpsPerDay}) · NW t ${s.tNW} · halves ${s.firstHalfNetBps}/${s.secondHalfNetBps} · TOM window net ${s.contextTomWindowNetPctPerMonth}%/mo (context)`);
  }
})().catch((e) => { const refuse = e instanceof Refuse; console.error(`${KEY} ${refuse ? "REFUSED" : "FAILED"}:`, e.message); process.exit(refuse ? 2 : 1); });
