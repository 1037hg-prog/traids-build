#!/usr/bin/env node
/**
 * FOMC_DAYS — MACRO-ANNOUNCEMENT EXPOSURE: does SPY earn more on scheduled FOMC statement days than on ordinary days?
 *
 * HYPOTHESIS. Equity risk premia are earned disproportionately on scheduled macro-announcement days, FOMC above all.
 *   Savor, P. & Wilson, M. (2013), "How Much Do Investors Care About Macroeconomic Risk? Evidence from Scheduled Economic
 *     Announcements", Journal of Financial and Quantitative Analysis 48(2), 343-375.
 *   Ai, H., Bansal, R. & Guo, H. (2023), "Macroeconomic Announcement Premium", NBER Working Paper w31923.
 *   (Related, NOT the rule tested here: Lucca & Moench (2015) pre-FOMC drift, 2pm(t-1) -> 2pm(t).)
 *
 * EXACT MECHANICAL RULE (single variant, fixed before any computation).
 *   Hold SPY close(t-1) -> close(t) on each SCHEDULED FOMC statement day t (the last day of a regular meeting), cash otherwise.
 *   The schedule is published a year or more ahead, so the decision to hold on day t is known at the close of t-1; the position
 *   starts at the next available price (the t-1 close) and ends at the t close. Unscheduled/emergency actions are NOT events.
 *   Per meeting m with statement day t:
 *     rF(m)    = SPY adjusted close(t) / adjusted close(t-1) - 1        (Alpaca SIP daily bars, adjustment=all)
 *     base(m)  = mean close-to-close SPY return over the 20 trading days immediately before t that are NOT event days
 *                (event days = every scheduled statement day 2016-2026, plus the two unscheduled 2020 announcement days below)
 *     gross(m) = rF(m) - base(m)                                         (the FOMC-day excess; unit = meeting)
 *     net(m)   = gross(m) - 0.0002                                       (cost 0.02% round trip per meeting)
 *   Every input to meeting m is known by t's close; base(m) uses only days strictly before t.
 *
 * STATISTIC. Mean of net(m) over the meetings in a window; plain t = mean / (sd / sqrt(n)) over meetings (meetings are ~6 weeks
 *   apart, treated as independent). Reported beside it, weightless: gross mean, raw FOMC-day return, NW t (lag 3) as a check, and
 *   the mean of net over the first and second halves of the window (split by meeting count).
 *
 * COST MODEL. 0.02% (2 bps) round trip per meeting, subtracted from each meeting's excess.
 *
 * WINDOWS. DISCOVERY 2017-01-01..2021-12-31 (39 scheduled statement days — 2020-03-18 was cancelled). HOLDOUT 2022-01-01..2026-09-22
 *   (38 statement days; 2026-10-28 and later are outside). The 2016 dates exist only to keep them out of early-2017 baselines.
 *
 * PROTOCOL (registered before any statistic on real data).
 *   --selftest   synthetic known-answer checks only (no real data touched); PASS/FAIL, exit 1 on FAIL.
 *   --datacheck  fetches SPY daily bars and prints COUNTS ONLY (bars, first/last date, statement days present per window). No returns.
 *   --controls   on discovery-window data only: (a) leak test — SPY daily returns iid-BOOTSTRAPPED with replacement onto the same
 *                calendar, the full pipeline run on the discovery meetings; GROSS |t| < 2 on the fixed seed AND the |t| >= 1.96 rate
 *                over 500 bootstrap draws <= 10% (the plain t is calibrated on noise); (b) positive control that PEEKS at the outcome —
 *                per meeting, hold the best-returning day in [t-2, t+2] instead of t; GROSS t >= 5 required. Writes
 *                data/hunt/FOMC_DAYS-controls.json. Caches SPY closes to data/hunt/FOMC_DAYS-spy-daily.json on first run.
 *   --discovery  refuses unless controls passed AND backend/data/test-registry.json has a preregistered entry with
 *                script === "backend/hunt/FOMC_DAYS.js". Discovery-window data only (bars sliced to <= 2021-12-31 before any
 *                arithmetic). Writes data/hunt/FOMC_DAYS-discovery.json once; refuses to overwrite. Discovery is descriptive: the rule
 *                is a single literature rule, not selected here, so the holdout is read regardless of the discovery sign.
 *   --holdout    refuses unless discovery exists (and controls + registration). Computes the frozen rule once on the holdout meetings;
 *                writes data/hunt/FOMC_DAYS-holdout.json once; refuses to overwrite.
 *                PASS: net mean > 0 AND plain t >= 1.70 (single variant) AND both holdout halves' net means > 0. Else DID NOT PASS.
 *   The holdout meetings are unreachable from every other mode: they are filtered out by window, and the price series is truncated at
 *   the discovery end before any return is computed in --controls / --discovery.
 *
 * FOMC DATES. Compiled 2026-09-23 from the Federal Reserve's pages: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *   (2021-2026) and https://www.federalreserve.gov/monetarypolicy/fomchistorical2016.htm .. fomchistorical2020.htm. Statement day = the
 *   last day of each regular two-day meeting. Excluded as events: 2019-10-04 (unscheduled conference call), 2020-03-02/03 (unscheduled,
 *   cut announced 2020-03-03), 2020-03-15 (unscheduled Sunday meeting; market reaction 2020-03-16), 2020-03-17/18 (scheduled meeting
 *   CANCELLED), notation votes (2020-03-19/23/31, 2020-08-27, 2025-08-22). 2020-03-03 and 2020-03-16 are also kept OUT of baselines.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const DATA = path.join(__dirname, "..", "data"), HUNT = path.join(DATA, "hunt"), KEY = "FOMC_DAYS", SCRIPT = "backend/hunt/FOMC_DAYS.js";
const F = (s) => path.join(HUNT, `${KEY}-${s}.json`), CACHE = F("spy-daily"), CTRL = F("controls"), OUTD = F("discovery"), OUTH = F("holdout");
const DISC = ["2017-01-01", "2021-12-31"], HOLD = ["2022-01-01", "2026-09-22"], COST = 0.0002, BASE_N = 20, BAR_T = 1.70;

// Scheduled FOMC statement days (source above). 2020 has 7: the 03-17/18 meeting was cancelled.
const SCHEDULED = [
  "2016-01-27", "2016-03-16", "2016-04-27", "2016-06-15", "2016-07-27", "2016-09-21", "2016-11-02", "2016-12-14",
  "2017-02-01", "2017-03-15", "2017-05-03", "2017-06-14", "2017-07-26", "2017-09-20", "2017-11-01", "2017-12-13",
  "2018-01-31", "2018-03-21", "2018-05-02", "2018-06-13", "2018-08-01", "2018-09-26", "2018-11-08", "2018-12-19",
  "2019-01-30", "2019-03-20", "2019-05-01", "2019-06-19", "2019-07-31", "2019-09-18", "2019-10-30", "2019-12-11",
  "2020-01-29", "2020-04-29", "2020-06-10", "2020-07-29", "2020-09-16", "2020-11-05", "2020-12-16",
  "2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16", "2021-07-28", "2021-09-22", "2021-11-03", "2021-12-15",
  "2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15", "2022-07-27", "2022-09-21", "2022-11-02", "2022-12-14",
  "2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14", "2023-07-26", "2023-09-20", "2023-11-01", "2023-12-13",
  "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18",
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
];
const UNSCHEDULED_REACTION_DAYS = ["2020-03-03", "2020-03-16"];            // not events; kept out of baselines only
const EXCLUDE_FROM_BASE = new Set([...SCHEDULED, ...UNSCHEDULED_REACTION_DAYS]);
const meetingsIn = (w, list = SCHEDULED) => list.filter((d) => d >= w[0] && d <= w[1]);

// ── statistics ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function plainT(a) { const n = a.length; if (n < 3) return null; const m = mean(a); const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1); return v > 0 ? m / Math.sqrt(v / n) : null; }
function nwT(a, L = 3) { const n = a.length; if (n < 6) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (rng) => { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(6)), r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));

// ── core pipeline ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// days: [{d, r}] sorted ascending, r = close(d)/close(prev trading day) - 1. events: statement days to evaluate.
// exclude: Set of dates kept out of every baseline. pick(i): optional override of the held day index (positive control only).
function computeMeetings(days, events, exclude = EXCLUDE_FROM_BASE, pick = null) {
  const idx = new Map(days.map((x, i) => [x.d, i])), rows = [];
  for (const d of events) {
    const i = idx.get(d); if (i == null) throw new Error(`${KEY}: statement day ${d} missing from the price series — fail closed`);
    const base = []; for (let j = i - 1; j >= 1 && base.length < BASE_N; j--) { if (exclude.has(days[j].d)) continue; if (Number.isFinite(days[j].r)) base.push(days[j].r); }
    if (base.length < BASE_N) throw new Error(`${KEY}: only ${base.length} baseline days before ${d} — fail closed`);
    const h = pick ? pick(i) : i, rF = days[h].r; if (!Number.isFinite(rF)) throw new Error(`${KEY}: no return on ${days[h].d}`);
    const b = mean(base), gross = rF - b; rows.push({ d, rF, base: b, gross, net: gross - COST });
  }
  return rows;
}
function summarize(rows) {
  const net = rows.map((x) => x.net), gross = rows.map((x) => x.gross), h = Math.floor(rows.length / 2);
  return { meetings: rows.length, netMean: r6(mean(net)), tPlain: r3(plainT(net)), grossMean: r6(mean(gross)), tGrossPlain: r3(plainT(gross)),
    tNW3: r3(nwT(net)), rawFomcDayMean: r6(mean(rows.map((x) => x.rF))), firstHalfNetMean: r6(mean(net.slice(0, h))), secondHalfNetMean: r6(mean(net.slice(h))),
    firstHalf: [rows[0]?.d, rows[h - 1]?.d], secondHalf: [rows[h]?.d, rows[rows.length - 1]?.d] };
}
const passes = (s, bar = BAR_T) => s.netMean > 0 && s.tPlain != null && s.tPlain >= bar && s.firstHalfNetMean > 0 && s.secondHalfNetMean > 0;
const toDays = (bars) => bars.map((b, i) => ({ d: b.d, r: i > 0 && bars[i - 1].c > 0 && b.c > 0 ? b.c / bars[i - 1].c - 1 : NaN }));
function bootstrapDays(days, rng) {                    // iid draw WITH replacement from the finite returns, same calendar
  const pool = days.map((x) => x.r).filter(Number.isFinite);
  return days.map((x, i) => ({ d: x.d, r: i === 0 ? NaN : pool[Math.floor(rng() * pool.length)] }));
}
const peekPick = (days) => (i) => { let best = i; for (let k = i - 2; k <= i + 2; k++) if (k >= 1 && k < days.length && Number.isFinite(days[k].r) && days[k].r > days[best].r) best = k; return best; };
function runControls(days) {                           // days must already be truncated to the discovery end
  const ev = meetingsIn(DISC);
  const leakRows = computeMeetings(bootstrapDays(days, mulberry(2013)), ev), leakT = plainT(leakRows.map((x) => x.gross));
  let rej = 0; const DRAWS = 500; for (let s = 1; s <= DRAWS; s++) { const t = plainT(computeMeetings(bootstrapDays(days, mulberry(10000 + s)), ev).map((x) => x.gross)); if (t != null && Math.abs(t) >= 1.96) rej++; }
  const peekT = plainT(computeMeetings(days, ev, EXCLUDE_FROM_BASE, peekPick(days)).map((x) => x.gross));
  const leakOk = leakT != null && Math.abs(leakT) < 2, calOk = rej / DRAWS <= 0.10, peekOk = peekT != null && peekT >= 5;
  return { leakGrossT: r3(leakT), leakOk, bootstrapRejectRate: +(rej / DRAWS).toFixed(4), bootstrapDraws: DRAWS, calibrationOk: calOk, peekGrossT: r3(peekT), peekOk, pass: leakOk && calOk && peekOk };
}

// ── data (network only for prices; nothing here computes an outcome) ──────────────────────────────────────────────────────────
const etDate = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
async function fetchSpy() {
  const { fetchBars } = require("../lib/alpaca-bars.js");
  const { bars } = await fetchBars(["SPY"], { start: "2016-01-01", end: "2026-09-22T23:59:59Z", timeframe: "1Day", feed: "sip", adjustment: "all", quiet: true, requireAll: true });
  const out = (bars.SPY || []).map((b) => ({ d: etDate(b.t), c: b.c })).filter((b) => b.d <= HOLD[1]);
  if (out.length < 2000) throw new Error(`${KEY}: SPY returned ${out.length} daily bars — fail closed`);
  return out;
}
async function loadSpy(cutoff) {                       // cutoff applied BEFORE any return is computed
  let bars;
  if (fs.existsSync(CACHE)) bars = JSON.parse(fs.readFileSync(CACHE, "utf8")).bars;
  else { bars = await fetchSpy(); fs.mkdirSync(HUNT, { recursive: true }); writeJsonAtomic(CACHE, { key: KEY, source: "Alpaca SIP 1Day adjustment=all", fetchedAt: new Date().toISOString(), bars }); }
  return toDays(bars.filter((b) => b.d <= cutoff));
}
const registered = () => { const reg = JSON.parse(fs.readFileSync(path.join(DATA, "test-registry.json"), "utf8")); return (reg.preregistered || []).find((x) => x.script === SCRIPT) || null; };
const readJ = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

// ── selftest (synthetic only) ─────────────────────────────────────────────────────────────────────────────────────────────────
function synthCalendar() { const out = []; for (let t = Date.parse("2016-01-04T12:00:00Z"); t <= Date.parse("2026-09-22T12:00:00Z"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); } return out; }
function selftest() {
  const res = [], ok = (name, cond, info = "") => { res.push(cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${info ? " — " + info : ""}`); };
  const cal = synthCalendar(), evD = meetingsIn(DISC), evH = meetingsIn(HOLD);
  // 1 window hygiene
  ok("windows: 39 discovery / 38 holdout statement days, disjoint, holdout ends <= 2026-09-22", evD.length === 39 && evH.length === 38 && evD.every((d) => d <= DISC[1]) && evH.every((d) => d >= HOLD[0] && d <= HOLD[1]), `${evD.length}/${evH.length}`);
  ok("unscheduled/cancelled dates are not events", !["2019-10-04", "2020-03-03", "2020-03-15", "2020-03-16", "2020-03-18", "2025-08-22"].some((d) => SCHEDULED.includes(d)));
  ok("every statement day is a weekday and dates are sorted/unique", SCHEDULED.every((d) => new Date(d + "T12:00:00Z").getUTCDay() % 6 !== 0) && SCHEDULED.every((d, i) => i === 0 || d > SCHEDULED[i - 1]));
  // 2 constant returns: excess known exactly
  const cst = cal.map((d, i) => ({ d, r: i === 0 ? NaN : SCHEDULED.includes(d) ? 0.004 : 0.001 }));
  const sc = summarize(computeMeetings(cst, evD));
  ok("constant known answer: gross 0.003, net 0.0028 per meeting", Math.abs(sc.grossMean - 0.003) < 1e-9 && Math.abs(sc.netMean - 0.0028) < 1e-9, `gross ${sc.grossMean} net ${sc.netMean}`);
  // 3 baseline excludes earlier event days (two events 10 days apart on a toy calendar)
  const toy = Array.from({ length: 60 }, (_, k) => ({ d: `T${String(k).padStart(3, "0")}`, r: k === 0 ? NaN : (k === 25 || k === 35) ? 0.01 : k * 1e-4 }));
  const ex = new Set(["T025", "T035"]), row = computeMeetings(toy, ["T035"], ex)[0];
  const want = [...Array.from({ length: 9 }, (_, j) => 34 - j), ...Array.from({ length: 11 }, (_, j) => 24 - j)].map((k) => k * 1e-4);
  ok("baseline = 20 prior NON-event days (skips the earlier event)", want.length === 20 && Math.abs(row.base - mean(want)) < 1e-12 && Math.abs(row.gross - (0.01 - mean(want))) < 1e-12, `base ${row.base.toFixed(6)}`);
  // 4 look-ahead: scrambling every return after the last discovery event leaves discovery untouched; the day after an event never matters
  const rngN = mulberry(7), noise = cal.map((d, i) => ({ d, r: i === 0 ? NaN : 0.01 * gauss(rngN) }));
  const a = computeMeetings(noise, evD), last = evD[evD.length - 1], pert = noise.map((x) => (x.d > last ? { d: x.d, r: 0.2 * (rngN() - 0.5) } : x));
  ok("no look-ahead: post-window returns cannot move discovery", JSON.stringify(a) === JSON.stringify(computeMeetings(pert, evD)));
  const iEv = noise.findIndex((x) => x.d === evD[5]), p2 = noise.map((x, i) => (i === iEv + 1 ? { d: x.d, r: 0.5 } : x));
  ok("no look-ahead: the day after an event does not affect that event", JSON.stringify(computeMeetings(noise, [evD[5]])) === JSON.stringify(computeMeetings(p2, [evD[5]])));
  // 5 injected premium recovered; null premium not
  const rngI = mulberry(11), inj = cal.map((d, i) => ({ d, r: i === 0 ? NaN : 0.01 * gauss(rngI) + (SCHEDULED.includes(d) ? 0.005 : 0) }));
  const si = summarize(computeMeetings(inj, evD));
  ok("injected +0.50%/meeting recovered (0.2%..0.8%) with t > 1.7", si.grossMean > 0.002 && si.grossMean < 0.008 && si.tPlain > 1.7, `gross ${si.grossMean} t ${si.tPlain}`);
  // 6 controls machinery on synthetic noise: leak |t|<2 & calibrated, peek t>=5
  const synDisc = noise.filter((x) => x.d <= DISC[1]), c = runControls(synDisc);
  ok("controls on synthetic noise: leak |t|<2, reject rate <=10%, positive control t>=5", c.pass, `leak t ${c.leakGrossT} · reject ${c.bootstrapRejectRate} · peek t ${c.peekGrossT}`);
  const cr = runControls(noise.filter((x) => x.d <= DISC[1]).map((x) => x));
  ok("controls are deterministic (fixed seeds)", JSON.stringify(c) === JSON.stringify(cr));
  // 7 PASS rule
  const base = { netMean: 0.001, tPlain: 1.8, firstHalfNetMean: 0.001, secondHalfNetMean: 0.0005 };
  ok("PASS rule: all four conditions required", passes(base) && !passes({ ...base, netMean: -1e-6 }) && !passes({ ...base, tPlain: 1.69 }) && !passes({ ...base, firstHalfNetMean: -1e-6 }) && !passes({ ...base, secondHalfNetMean: 0 }) && passes({ ...base, tPlain: 1.70 }));
  // 8 missing statement day fails closed
  let threw = false; try { computeMeetings(cst.filter((x) => x.d !== evD[3]), evD); } catch { threw = true; }
  ok("missing statement day fails closed", threw);
  const pass = res.every(Boolean); console.log(`${KEY} selftest: ${pass ? "PASS" : "FAIL"} (${res.filter(Boolean).length}/${res.length})`); return pass;
}

// ── modes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) (async () => {
  const mode = ["--selftest", "--datacheck", "--controls", "--discovery", "--holdout", "--status"].find((m) => process.argv.includes(m)) || "--status";
  if (mode === "--selftest") process.exit(selftest() ? 0 : 1);
  if (mode === "--status") { console.log(`${KEY}: registered ${registered() ? "yes" : "NO"} · controls ${fs.existsSync(CTRL) ? "done" : "pending"} · discovery ${fs.existsSync(OUTD) ? "sealed" : "pending"} · holdout ${fs.existsSync(OUTH) ? "READ" : "sealed/unopened"}`); return; }
  if (mode === "--datacheck") {                        // COUNTS ONLY — never a return
    const bars = await fetchSpy(), have = new Set(bars.map((b) => b.d)), d = meetingsIn(DISC), h = meetingsIn(HOLD);
    console.log(`${KEY} datacheck: SPY ${bars.length} daily bars ${bars[0].d}..${bars[bars.length - 1].d} · discovery statement days present ${d.filter((x) => have.has(x)).length}/${d.length} · holdout ${h.filter((x) => have.has(x)).length}/${h.length} · missing: ${[...d, ...h].filter((x) => !have.has(x)).join(",") || "none"}`);
    return;
  }
  fs.mkdirSync(HUNT, { recursive: true });
  if (mode === "--controls") {
    const days = await loadSpy(DISC[1]), c = runControls(days);
    writeJsonAtomic(CTRL, { key: KEY, spec: "fomc-days-controls-v1", asOf: new Date().toISOString(), window: DISC, ...c });
    console.log(`${KEY} controls — leak (iid bootstrap) GROSS t ${c.leakGrossT} ${c.leakOk ? "PASS" : "FAIL"} · |t|>=1.96 rate ${c.bootstrapRejectRate} over ${c.bootstrapDraws} ${c.calibrationOk ? "PASS" : "FAIL"} · positive control (peek) t ${c.peekGrossT} ${c.peekOk ? "PASS" : "FAIL"} · ${c.pass ? "CONTROLS PASS" : "CONTROLS FAIL"}`);
    if (!c.pass) process.exit(1); return;
  }
  const reg = registered(); if (!reg) { console.error(`${KEY}: no preregistered entry with script === "${SCRIPT}" — refusing`); process.exit(2); }
  const ctrl = readJ(CTRL); if (!ctrl || !ctrl.pass) { console.error(`${KEY}: controls have not passed — refusing`); process.exit(2); }
  if (mode === "--discovery") {
    if (fs.existsSync(OUTD)) { console.error(`${KEY}: discovery already sealed — refusing`); process.exit(2); }
    const days = await loadSpy(DISC[1]), rows = computeMeetings(days, meetingsIn(DISC)), s = summarize(rows);
    writeJsonAtomic(OUTD, { key: KEY, registryId: reg.id || null, spec: "fomc-days-discovery-v1", sealedAt: new Date().toISOString(), window: DISC, costPerMeeting: COST, summary: s,
      holdoutBar: BAR_T, note: "descriptive — the single literature rule goes to the holdout regardless of sign", meetings: rows.map((x) => ({ d: x.d, rF: r6(x.rF), base: r6(x.base), net: r6(x.net) })) });
    console.log(`${KEY} DISCOVERY ${DISC.join("..")} (sealed) — ${s.meetings} meetings · net ${s.netMean} (gross ${s.grossMean}) · t ${s.tPlain} (NW3 ${s.tNW3}) · halves ${s.firstHalfNetMean}/${s.secondHalfNetMean} · raw FOMC-day ${s.rawFomcDayMean}`);
    return;
  }
  if (mode === "--holdout") {
    if (fs.existsSync(OUTH)) { console.error(`${KEY}: holdout already read — refusing`); process.exit(2); }
    const disc = readJ(OUTD); if (!disc) { console.error(`${KEY}: discovery not sealed — refusing`); process.exit(2); }
    const days = await loadSpy(HOLD[1]), rows = computeMeetings(days, meetingsIn(HOLD)), s = summarize(rows), verdict = passes(s, BAR_T) ? "PASS" : "DID NOT PASS";
    writeJsonAtomic(OUTH, { key: KEY, registryId: reg.id || null, spec: "fomc-days-holdout-v1", read: true, asOf: new Date().toISOString(), window: HOLD, bar: BAR_T, costPerMeeting: COST, summary: s, verdict,
      meetings: rows.map((x) => ({ d: x.d, rF: r6(x.rF), base: r6(x.base), net: r6(x.net) })) });
    console.log(`${KEY} HOLDOUT ${HOLD.join("..")} — ${verdict} (bar t >= ${BAR_T}) · ${s.meetings} meetings · net ${s.netMean} (gross ${s.grossMean}) · t ${s.tPlain} · halves ${s.firstHalfNetMean}/${s.secondHalfNetMean}`);
    return;
  }
})().catch((e) => { console.error(`${KEY} FAILED:`, e.message); process.exit(1); });

module.exports = { computeMeetings, summarize, passes, meetingsIn, SCHEDULED };
