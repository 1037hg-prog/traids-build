#!/usr/bin/env node
/**
 * PENSION_REBAL — FRONT-RUNNING PENSION-FUND REBALANCING AT MONTH END (TRAIDS hunt, pre-registered, paper only).
 *
 * HYPOTHESIS. Balanced funds (the stylised 60/40 pension) rebalance back to target weights around month end. When equities have
 * out-run bonds since the last rebalance, the fund is over-weight equities and must sell equities / buy bonds; the flow is
 * predictable from public prices, so equities should under-perform bonds over the following day(s) (and the reverse when bonds
 * have out-run equities).
 * SOURCE. Campbell R. Harvey, Michele G. Mazzoleni & Alessandro Melone (2025), "The Unintended Consequences of Rebalancing",
 * NBER Working Paper w33554 — https://www.nber.org/papers/w33554
 *
 * DATA. Alpaca SIP daily bars for SPY and TLT, adjustment=all (total-return closes; both legs on the same basis). Only dates on
 * which BOTH trade are used.
 *
 * EXACT MECHANICAL RULE (single variant).
 *   1. Signal days = the last 5 trading days of each calendar month. A month is eligible only when all of its trading days are
 *      known (a later-month date exists in the data, or the loaded window ends on the month's last calendar day); a month that is
 *      still in progress generates no signal.
 *   2. On signal day t: drift = (SPY_close[t] / SPY_close[pme] - 1) - (TLT_close[t] / TLT_close[pme] - 1), pme = the last trading
 *      day of the previous calendar month. Only closes at or before t are used.
 *   3. drift > 0 -> position +1 = SHORT SPY / LONG TLT, equal dollar; drift < 0 -> position -1 = LONG SPY / SHORT TLT; drift == 0 flat.
 *   4. The position is held for the NEXT trading day u = t+1, close-to-close: gross = pos x ((TLT[u]/TLT[t]-1) - (SPY[u]/SPY[t]-1)).
 *      All other days are flat. (Signal days are consecutive, so each trade day carries exactly one position; the trade days are the
 *      last 4 trading days of month m and the first trading day of month m+1.)
 * COST MODEL. 0.02% per leg per day traded, two legs -> net = gross - 0.0004 on every day with a non-zero position; 0 when flat.
 * STATISTIC. Daily net returns on trading days (0 on no-trade days), summed into CALENDAR MONTHS by the date the return is REALISED
 *   (day u). Monthly series -> mean (% per month) and Newey-West t, lag 3. Reported: net and gross mean and t, both-halves net means
 *   (first floor(n/2) months vs the rest), trade days, share of trades short SPY.
 * WINDOWS. DISCOVERY = returns realised 2017-01-01..2021-12-31 (60 months). HOLDOUT = returns realised 2022-01-01..2026-09-22 (57
 *   months; September 2026 carries only the 09-01 trade because the month is still in progress and generates no signal).
 *   The partition is by realisation date: the 2021-12-31 signal's 2022-01-03 trade belongs to the HOLDOUT.
 *   Discovery and controls load prices only through 2021-12-31 (the fetch stops there); the holdout mode loads prices from 2021-10-01.
 *   No holdout-window price is ever fetched, held or computed on in --selftest, --controls or --discovery.
 * PROTOCOL.
 *   --selftest   synthetic known-answer checks only (no network, no real data); prints PASS/FAIL; exit 1 on FAIL.
 *   --controls   on the DISCOVERY window only. LEAK TEST: iid joint BOOTSTRAP (day pairs (r_SPY, r_TLT) drawn WITH replacement from the
 *                discovery-window returns, each series de-meaned, price paths rebuilt on the real calendar) -> GROSS |NW t| < 2 at the
 *                primary seed AND |t| >= 2 in <= 15% of 200 seeds. POSITIVE CONTROL: position = sign of the realised next-day spread
 *                (peeks at the outcome) -> GROSS NW t >= 5. Writes data/hunt/PENSION_REBAL-controls.json.
 *   --discovery  refuses unless controls passed AND backend/data/test-registry.json has a preregistered entry whose script is
 *                "backend/hunt/PENSION_REBAL.js"; computes discovery-window statistics only; writes data/hunt/PENSION_REBAL-discovery.json
 *                once (refuses to overwrite).
 *   --holdout    refuses unless the discovery file exists (and controls/registration hold); computes the holdout statistic ONCE for the
 *                frozen rule; writes data/hunt/PENSION_REBAL-holdout.json once (refuses to overwrite).
 *                PASS = net mean > 0 AND net NW t >= 1.70 (single variant) AND both holdout halves' net means > 0. Otherwise DID NOT PASS.
 *   --status     prints which stages exist; computes nothing.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");

const KEY = "PENSION_REBAL", SCRIPT = "backend/hunt/PENSION_REBAL.js";
const DATA = path.join(__dirname, "..", "data"), HD = path.join(DATA, "hunt");
const CTRL = path.join(HD, `${KEY}-controls.json`), OUTD = path.join(HD, `${KEY}-discovery.json`), OUTH = path.join(HD, `${KEY}-holdout.json`);
const REG = path.join(DATA, "test-registry.json");
const COST_LEG = 0.0002, LEGS = 2, SIGNAL_DAYS = 5, NW_LAG = 3, BAR_T = 1.70;
const DISC = ["2017-01-01", "2021-12-31"], HOLD = ["2022-01-01", "2026-09-22"];
const DISC_FETCH = { start: "2016-10-01", end: "2021-12-31T23:59:59Z", priceEnd: DISC[1], completeThrough: "2021-12" };
const HOLD_FETCH = { start: "2021-10-01", end: "2026-09-22T23:59:59Z", priceEnd: HOLD[1], completeThrough: null };
const BOOT_SEED = 33554, BOOT_SEEDS = 200, BOOT_MAX_REJECT = 0.15;

// ── helpers (house style: r161/r163) ──────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function nwT(a, L = NW_LAG) { const n = a.length; if (n < 6) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ok = (x) => Number.isFinite(x) && x > 0;
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));
const ymOf = (d) => d.slice(0, 7);

// ── the rule ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Calendar-only plan: which indices are signal days and which index is their previous-month-end reference. Uses dates only.
function monthPlan(dates, completeThrough = null) {
  const plan = [];
  let a = 0;
  while (a < dates.length) {
    const ym = ymOf(dates[a]); let b = a; while (b + 1 < dates.length && ymOf(dates[b + 1]) === ym) b++;
    const complete = b + 1 < dates.length || (completeThrough != null && ym <= completeThrough);
    const pme = a - 1;                                           // last trading day of the previous month (must exist in the data)
    if (complete && pme >= 0) for (let t = Math.max(a, b - SIGNAL_DAYS + 1); t <= b; t++) plan.push({ t, pme });
    a = b + 1;
  }
  return plan;
}
// Signals: position at t from closes at t and pme only (never t+1 or later).
function signals(dates, S, T, completeThrough = null) {
  const out = [];
  for (const { t, pme } of monthPlan(dates, completeThrough)) {
    if (!(ok(S[t]) && ok(T[t]) && ok(S[pme]) && ok(T[pme]))) continue;
    const drift = (S[t] / S[pme] - 1) - (T[t] / T[pme] - 1);
    out.push({ t, u: t + 1, drift, pos: drift > 0 ? 1 : drift < 0 ? -1 : 0 });   // +1 = short SPY / long TLT
  }
  return out;
}
// Simulate over a realisation window. peek=true is the POSITIVE CONTROL only (position = sign of the outcome it is paid on).
function simulate(dates, S, T, win, { completeThrough = null, peek = false } = {}) {
  const recs = [];
  for (const sg of signals(dates, S, T, completeThrough)) {
    if (sg.u >= dates.length) continue;
    const d = dates[sg.u]; if (d < win[0] || d > win[1]) continue;
    if (!(ok(S[sg.u]) && ok(T[sg.u]))) continue;
    const spread = (T[sg.u] / T[sg.t] - 1) - (S[sg.u] / S[sg.t] - 1);
    const pos = peek ? Math.sign(spread) : sg.pos;
    const gross = pos * spread, net = gross - (pos ? LEGS * COST_LEG : 0);
    recs.push({ signalDate: dates[sg.t], date: d, drift: sg.drift, pos, gross, net });
  }
  const months = [...new Set(dates.filter((d, i) => d >= win[0] && d <= win[1] && ok(S[i]) && ok(T[i])).map(ymOf))].sort();
  const byM = new Map(months.map((m) => [m, { ym: m, net: 0, gross: 0, trades: 0 }]));
  for (const r of recs) { const m = byM.get(ymOf(r.date)); if (!m) continue; m.net += r.net; m.gross += r.gross; if (r.pos) m.trades++; }
  return { recs, monthly: months.map((m) => byM.get(m)) };
}
function summarise(sim) {
  const net = sim.monthly.map((x) => x.net), gross = sim.monthly.map((x) => x.gross), h = Math.floor(net.length / 2);
  const act = sim.recs.filter((r) => r.pos !== 0);
  return {
    months: net.length, firstMonth: sim.monthly[0]?.ym ?? null, lastMonth: sim.monthly[sim.monthly.length - 1]?.ym ?? null,
    signalDays: sim.recs.length, tradeDays: act.length, shortSpyPct: act.length ? r3(100 * act.filter((r) => r.pos > 0).length / act.length) : null,
    netPctPerMonth: r3(100 * mean(net)), grossPctPerMonth: r3(100 * mean(gross)), tNW: r3(nwT(net)), tGrossNW: r3(nwT(gross)),
    firstHalfPct: r3(100 * mean(net.slice(0, h))), secondHalfPct: r3(100 * mean(net.slice(h))),
    netBpsPerTrade: act.length ? r3(1e4 * mean(act.map((r) => r.net))) : null,
    _net: net, _gross: gross,
  };
}
const publicSummary = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith("_")));

// iid joint bootstrap of day pairs, drawn WITH replacement from the loaded (discovery-only) returns, each series de-meaned,
// price paths rebuilt on the same calendar. Past and future are independent by construction -> any t is leak or estimator bias.
function bootstrapPaths(S, T, seed) {
  const rs = [], rt = [];
  for (let u = 1; u < S.length; u++) if (ok(S[u]) && ok(S[u - 1]) && ok(T[u]) && ok(T[u - 1])) { rs.push(S[u] / S[u - 1] - 1); rt.push(T[u] / T[u - 1] - 1); }
  const ms = mean(rs), mt = mean(rt), rng = mulberry(seed), S2 = new Array(S.length), T2 = new Array(T.length);
  S2[0] = 100; T2[0] = 100;
  for (let u = 1; u < S.length; u++) { const k = Math.floor(rng() * rs.length); S2[u] = S2[u - 1] * (1 + rs[k] - ms); T2[u] = T2[u - 1] * (1 + rt[k] - mt); }
  return { S: S2, T: T2 };
}

// ── real data (fail closed) ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadReal(F, minDaysInWindow, win) {
  const { fetchBars } = require("../lib/alpaca-bars.js");
  const r = await fetchBars(["SPY", "TLT"], { start: F.start, end: F.end, timeframe: "1Day", feed: "sip", adjustment: "all", quiet: true, requireAll: true });
  const mk = (s) => new Map(r.bars[s].map((b) => [String(b.t).slice(0, 10), b.c]));
  const ms = mk("SPY"), mt = mk("TLT");
  const dates = [...ms.keys()].filter((d) => mt.has(d) && d <= F.priceEnd).sort();   // never admit a price past this mode's window
  const S = dates.map((d) => ms.get(d)), T = dates.map((d) => mt.get(d));
  if (!S.every(ok) || !T.every(ok)) throw new Error("non-positive or missing close in loaded data");
  const inWin = dates.filter((d) => d >= win[0] && d <= win[1]).length;
  if (inWin < minDaysInWindow) throw new Error(`only ${inWin} common SPY/TLT days in ${win.join("..")}, need >= ${minDaysInWindow}`);
  for (let i = 1; i < dates.length; i++) { const gap = (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 864e5; if (gap > 5) throw new Error(`calendar gap ${dates[i - 1]} -> ${dates[i]} (${gap}d) — a missing day would misplace the last-5 signal days`); }
  if (ms.size !== mt.size) throw new Error(`SPY ${ms.size} vs TLT ${mt.size} bars — unmatched calendars`);
  return { dates, S, T };
}
function registered() {
  const reg = JSON.parse(fs.readFileSync(REG, "utf8"));
  return (reg.preregistered || []).find((x) => x && x.script === SCRIPT) || null;
}
const readJ = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

// ── selftest (synthetic only) ────────────────────────────────────────────────────────────────────────────────────────────────────
function bizDays(from, to) { const out = []; for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w && w < 6) out.push(d.toISOString().slice(0, 10)); } return out; }
function gauss(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }
// Synthetic SPY/TLT. plant = extra next-day spread paid in the rule's direction on every trade day (known answer).
function synth(dates, seed, { plant = 0, muS = 0, muT = 0, sdS = 0.01, sdT = 0.009, rho = -0.3 } = {}) {
  const rng = mulberry(seed), S = [100], T = [100];
  const isSig = new Map(monthPlan(dates).map((p) => [p.t, p.pme]));
  for (let u = 1; u < dates.length; u++) {
    const z1 = gauss(rng), z2 = gauss(rng); let rs = muS + sdS * z1, rt = muT + sdT * (rho * z1 + Math.sqrt(1 - rho * rho) * z2);
    if (plant && isSig.has(u - 1)) { const t = u - 1, p = isSig.get(t), d = (S[t] / S[p] - 1) - (T[t] / T[p] - 1), sg = Math.sign(d); rt += sg * plant / 2; rs -= sg * plant / 2; }
    S.push(S[u - 1] * (1 + rs)); T.push(T[u - 1] * (1 + rt));
  }
  return { S, T };
}
function selftest() {
  const res = []; const check = (name, pass, detail) => { res.push({ name, pass: !!pass }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
  const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

  // A. hand-computed mechanics
  {
    const dates = bizDays("2018-12-03", "2019-03-05");
    const S = dates.map((d) => (d >= "2019-02-26" ? 108.9 : d >= "2019-02-20" ? 110 : 100)), T = dates.map(() => 100);
    const sig = signals(dates, S, T), sd = sig.map((s) => dates[s.t]);
    check("A1 no December signal (no previous-month reference in data)", !sd.some((d) => d.startsWith("2018-12")), sd.filter((d) => d < "2019").join(","));
    check("A2 January signal days = last 5 trading days", JSON.stringify(sd.filter((d) => d.startsWith("2019-01"))) === JSON.stringify(["2019-01-25", "2019-01-28", "2019-01-29", "2019-01-30", "2019-01-31"]));
    check("A3 February signal days = last 5 trading days", JSON.stringify(sd.filter((d) => d.startsWith("2019-02"))) === JSON.stringify(["2019-02-22", "2019-02-25", "2019-02-26", "2019-02-27", "2019-02-28"]));
    check("A4 in-progress month (March) generates no signal", !sd.some((d) => d.startsWith("2019-03")));
    const feb = sig.filter((s) => dates[s.t].startsWith("2019-02")), jan = sig.filter((s) => dates[s.t].startsWith("2019-01"));
    check("A5 drift referenced to previous month end (Jan drift 0 -> flat; Feb 02-22 drift +0.10 -> short SPY)", jan.every((s) => s.pos === 0) && near(feb[0].drift, 0.10) && feb.every((s) => s.pos === 1));
    const sim = simulate(dates, S, T, ["2019-01-01", "2019-03-31"]), m = Object.fromEntries(sim.monthly.map((x) => [x.ym, x]));
    const r0226 = sim.recs.find((r) => r.date === "2019-02-26");
    check("A6 trade is the NEXT day close-to-close, sign right (SPY -1% while short SPY -> +1% gross)", r0226 && r0226.signalDate === "2019-02-25" && near(r0226.gross, 0.01) && near(r0226.net, 0.0096));
    check("A7 cost 0.02%/leg only on traded days; flat days cost 0", sim.recs.every((r) => near(r.net, r.gross - (r.pos ? 0.0004 : 0))) && near(m["2019-01"].net, 0));
    check("A8 monthly sums by realisation date (Feb 0.0084, Mar -0.0004 from the 02-28 signal)", near(m["2019-02"].net, 0.0084) && near(m["2019-03"].net, -0.0004) && sim.monthly.length === 3, JSON.stringify(sim.monthly.map((x) => [x.ym, +x.net.toFixed(6)])));
    const Sx = S.map((v, i) => (dates[i] > "2019-02-27" ? NaN : v)), Tx = T.map((v, i) => (dates[i] > "2019-02-27" ? NaN : v));
    const simX = simulate(dates, Sx, Tx, ["2019-01-01", "2019-03-31"]);
    check("A9 no price past the load boundary -> those trades are absent, never filled", simX.recs.length === sim.recs.length - 2 && !simX.recs.some((r) => r.date > "2019-02-27"));
    const d2 = bizDays("2018-12-03", "2019-02-28"), S2 = S.slice(0, d2.length), T2 = T.slice(0, d2.length);
    const cNo = signals(d2, S2, T2).filter((s) => d2[s.t].startsWith("2019-02")).length, cYes = signals(d2, S2, T2, "2019-02").filter((s) => d2[s.t].startsWith("2019-02")).length;
    const simC = simulate(d2, S2, T2, ["2019-01-01", "2019-02-28"], { completeThrough: "2019-02" });
    check("A10 completeThrough: a window ending on month end signals the month, last signal has no trade day", cNo === 0 && cYes === 5 && simC.recs.filter((r) => r.signalDate >= "2019-02-01").length === 4);
  }
  const dates = bizDays("2016-10-03", "2021-12-31"), W = DISC;
  // B. look-ahead invariance
  {
    const { S, T } = synth(dates, 7), k = 700, rng = mulberry(8);
    const S2 = S.map((v, i) => (i > k ? v * (0.5 + rng()) : v)), T2 = T.map((v, i) => (i > k ? v * (0.5 + rng()) : v));
    const a = signals(dates, S, T).filter((s) => s.t <= k), b = signals(dates, S2, T2).filter((s) => s.t <= k);
    check("B  signals at t unchanged when every price after t is scrambled", a.length > 100 && a.length === b.length && a.every((s, i) => s.pos === b[i].pos && s.drift === b[i].drift), `${a.length} signals`);
  }
  // C. planted effect: known answer, both signs
  {
    const { S, T } = synth(dates, 11, { plant: 0.006 }), s = summarise(simulate(dates, S, T, W));
    check("C1 planted +0.60%/trade reversal recovered: net t >= 5, net/trade within 20bps of 56bps", s.tNW >= 5 && Math.abs(s.netBpsPerTrade - 56) < 20, `t ${s.tNW}, ${s.netBpsPerTrade} bps/trade, ${s.months} months`);
    check("C2 window = 60 discovery months, every trade realised inside it", s.months === 60 && s.firstMonth === "2017-01" && s.lastMonth === "2021-12");
    const { S: Sm, T: Tm } = synth(dates, 12, { plant: -0.006 }), sm = summarise(simulate(dates, Sm, Tm, W));
    check("C3 planted continuation (opposite sign) reads strongly negative", sm.tNW <= -5, `t ${sm.tNW}`);
  }
  // D. null calibration: no effect -> rejection rate near nominal
  {
    let rej = 0, ts = []; for (let sd = 1; sd <= 300; sd++) { const { S, T } = synth(dates, 1000 + sd), t = summarise(simulate(dates, S, T, W)).tGrossNW; ts.push(t); if (Math.abs(t) >= 1.96) rej++; }
    check("D  null (iid, no effect): |gross t|>=1.96 in 1%..12% of 300 paths, mean t ~ 0", rej / 300 >= 0.01 && rej / 300 <= 0.12 && Math.abs(mean(ts)) < 0.25, `reject ${(100 * rej / 300).toFixed(1)}%, mean t ${mean(ts).toFixed(3)}`);
  }
  // E/F. the controls' own machinery on synthetic data that CONTAINS an effect plus drift
  {
    const { S, T } = synth(dates, 21, { plant: 0.006, muS: 0.0008, muT: -0.0002 });
    const pk = summarise(simulate(dates, S, T, W, { peek: true }));
    check("E  positive control (peek) reads t >= 5", pk.tGrossNW >= 5, `t ${pk.tGrossNW}`);
    let rej = 0, ts = []; for (let sd = 1; sd <= 200; sd++) { const b = bootstrapPaths(S, T, sd), t = summarise(simulate(dates, b.S, b.T, W)).tGrossNW; ts.push(t); if (Math.abs(t) >= 2) rej++; }
    check("F  bootstrap null destroys a planted effect and a drift bias: |t|>=2 in <= 12% of 200 seeds", rej / 200 <= 0.12 && Math.abs(mean(ts)) < 0.35, `reject ${(100 * rej / 200).toFixed(1)}%, mean t ${mean(ts).toFixed(3)}`);
  }
  // G. holdout window shape on a synthetic calendar (in-progress September)
  {
    const hd = bizDays("2021-10-01", "2026-09-22"), { S, T } = synth(hd, 31), s = summarise(simulate(hd, S, T, HOLD));
    check("G  holdout-shaped window: 57 months, 2022-01..2026-09, no signal in in-progress 2026-09", s.months === 57 && s.firstMonth === "2022-01" && s.lastMonth === "2026-09" && !signals(hd, S, T).some((x) => hd[x.t] >= "2026-09-01"));
  }
  const pass = res.every((r) => r.pass);
  console.log(`${KEY} selftest: ${res.filter((r) => r.pass).length}/${res.length} checks — ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const mode = ["--selftest", "--controls", "--discovery", "--holdout", "--status"].find((m) => process.argv.includes(m)) || "--status";
  if (mode === "--selftest") { process.exit(selftest() ? 0 : 1); }
  fs.mkdirSync(HD, { recursive: true });
  if (mode === "--status") { console.log(`${KEY}: registered ${registered() ? "yes" : "NO"} · controls ${fs.existsSync(CTRL) ? (readJ(CTRL).pass ? "PASSED" : "FAILED") : "pending"} · discovery ${fs.existsSync(OUTD) ? "sealed" : "pending"} · holdout ${fs.existsSync(OUTH) ? "READ" : "sealed/unopened"}`); return; }

  if (mode === "--controls") {
    const R = await loadReal(DISC_FETCH, 1200, DISC);
    const opt = { completeThrough: DISC_FETCH.completeThrough };
    const b0 = bootstrapPaths(R.S, R.T, BOOT_SEED), leakT = summarise(simulate(R.dates, b0.S, b0.T, DISC, opt)).tGrossNW;
    let rej = 0; for (let s = 1; s <= BOOT_SEEDS; s++) { const b = bootstrapPaths(R.S, R.T, BOOT_SEED + s), t = summarise(simulate(R.dates, b.S, b.T, DISC, opt)).tGrossNW; if (t != null && Math.abs(t) >= 2) rej++; }
    const rejRate = +(rej / BOOT_SEEDS).toFixed(3), leakOk = leakT != null && Math.abs(leakT) < 2 && rejRate <= BOOT_MAX_REJECT;
    const peekT = summarise(simulate(R.dates, R.S, R.T, DISC, { ...opt, peek: true })).tGrossNW, peekOk = peekT != null && peekT >= 5;
    writeJsonAtomic(CTRL, { spec: `${KEY}-controls-v1`, asOf: new Date().toISOString(), window: DISC, null: "iid joint day-pair bootstrap with replacement, de-meaned, discovery returns only",
      leakGrossT: leakT, leakSeed: BOOT_SEED, leakRejectRate: rejRate, leakSeeds: BOOT_SEEDS, leakOk, peekGrossT: peekT, peekOk, pass: leakOk && peekOk });
    console.log(`${KEY} controls — bootstrap null gross t ${leakT} (|t|>=2 in ${(100 * rejRate).toFixed(1)}% of ${BOOT_SEEDS} seeds): ${leakOk ? "PASS" : "FAIL"} · positive control gross t ${peekT}: ${peekOk ? "PASS" : "FAIL"}`);
    return;
  }

  const ctrl = readJ(CTRL); if (!ctrl || !ctrl.pass) { console.error("controls have not passed — refusing"); process.exit(2); }
  if (!registered()) { console.error(`no preregistered entry with script "${SCRIPT}" in test-registry.json — refusing`); process.exit(2); }

  if (mode === "--discovery") {
    if (fs.existsSync(OUTD)) { console.error("discovery already sealed — refusing to overwrite"); process.exit(2); }
    const R = await loadReal(DISC_FETCH, 1200, DISC);
    const sim = simulate(R.dates, R.S, R.T, DISC, { completeThrough: DISC_FETCH.completeThrough }), s = summarise(sim);
    writeJsonAtomic(OUTD, { spec: `${KEY}-discovery-v1`, sealedAt: new Date().toISOString(), window: DISC, rule: "frozen as in header / spec", barForHoldout: BAR_T,
      result: publicSummary(s), monthly: sim.monthly.map((m) => ({ ym: m.ym, net: +m.net.toFixed(6), gross: +m.gross.toFixed(6), trades: m.trades })) });
    console.log(`${KEY} DISCOVERY ${DISC.join("..")} (sealed) — net ${s.netPctPerMonth}%/mo (gross ${s.grossPctPerMonth}) · NW t ${s.tNW} (gross ${s.tGrossNW}) · halves ${s.firstHalfPct}/${s.secondHalfPct} · ${s.tradeDays} trade days, ${s.shortSpyPct}% short SPY · ${s.netBpsPerTrade} bps/trade net`);
    return;
  }

  if (mode === "--holdout") {
    if (fs.existsSync(OUTH)) { console.error("holdout already read — refusing"); process.exit(2); }
    if (!fs.existsSync(OUTD)) { console.error("discovery not sealed — refusing"); process.exit(2); }
    const disc = readJ(OUTD);
    const R = await loadReal(HOLD_FETCH, 1100, HOLD);
    const s = summarise(simulate(R.dates, R.S, R.T, HOLD, { completeThrough: HOLD_FETCH.completeThrough }));
    const clears = s.netPctPerMonth > 0 && s.tNW != null && s.tNW >= BAR_T && s.firstHalfPct > 0 && s.secondHalfPct > 0;
    const verdict = clears ? "PASS" : "DID NOT PASS";
    writeJsonAtomic(OUTH, { spec: `${KEY}-holdout-v1`, read: true, asOf: new Date().toISOString(), window: HOLD, bar: BAR_T, passRule: "net mean > 0 AND NW t (lag 3) >= 1.70 AND both halves net > 0",
      result: publicSummary(s), discoveryContext: disc.result, verdict });
    console.log(`${KEY} HOLDOUT ${HOLD.join("..")} — ${verdict} (bar t >= ${BAR_T}) · net ${s.netPctPerMonth}%/mo (gross ${s.grossPctPerMonth}) · NW t ${s.tNW} · halves ${s.firstHalfPct}/${s.secondHalfPct} · ${s.tradeDays} trade days`);
  }
})().catch((e) => { console.error(`${KEY} FAILED:`, e.message); process.exit(1); });
