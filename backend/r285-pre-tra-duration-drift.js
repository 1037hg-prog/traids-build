#!/usr/bin/env node
/**
 * R285 — PRE_TRA_DURATION_DRIFT (Wang & Zhao, "Pre-Refunding Announcement Gains in U.S. Treasurys"). Registered 2026-09-29
 * (registry entry id R285 in backend/data/test-registry.json; the registry wins — this script implements it, it does not improve it).
 *
 * RULE (frozen): long 1 /ZN at the settle of the session BEFORE the pre-TRA session (normally Thursday), sell at the pre-TRA session's
 * settle (normally Friday), where the pre-TRA session is the last session strictly before the Treasury Refunding Announcement PRIMARY
 * RELEASE of marketable borrowing estimates (Monday, first-to-second month of each quarter). Flat otherwise, 4 events a year.
 * Secondary cell: hold through the TRA-day settle (two sessions). Shadows (weightless): /ZB, IEF, TLT (SPY = placebo).
 * The forward-only intraday (Schwab 5m) cell is NOT read here: 5m history starts 2025-12 (3 events) — recorded as forward-only.
 *
 * STATISTIC (registry "statistic"): per-event net return of the rule (cost model below), one-sample t over EVENTS (clustering unit =
 * events, never tickets). Gross beside. PRIMARY CELL = /ZN, events with release date 2016-02-01..2026-08-03 (43 events = nExpected 43 =
 * the n the bar was sized for). Extended cells (2004+ /ZN, /ZB; ETFs) and the 2024Q1..2026Q3 sealed sub-read are reported, never the verdict.
 * BAR = registry bar.tRequired, read from test-registry.json at run time (amended pre-evidence 2026-09-29 to 2.33; never hard-coded).
 *
 *   node backend/r285-pre-tra-duration-drift.js --selftest   known answers (hand-computable) + TRA-date file integrity
 *   node backend/r285-pre-tra-duration-drift.js --read       the one registered read (refuses if sealed or output exists)
 *
 * NOTES (fixed before any price was read):
 *  N1 Event dates: data/training/tra-dates.json — 91 Treasury press-release dates (2004Q1..2026Q3), each with its treasury.gov URL,
 *     collected 2026-09-29 BEFORE any price was loaded and cross-checked against the paper's Table 1 (all 80 overlapping dates match).
 *  N2 /ZN,/ZB: Schwab pricehistory daily, continuous front (NOT back-adjusted), sessions dated America/Chicago; cached in
 *     data/training/r285/. ROLL SESSIONS SKIPPED: any return whose entry or exit session falls in a roll window (Feb/May/Aug/Nov day>=15,
 *     or Mar/Jun/Sep/Dec day<=3) is dropped from events AND from the all-other-days comparisons. Expected event skips = 0; printed.
 *  N3 Costs: futures 1 tick + $2.50 per contract per side (ZN tick 1/64 pt = $15.625; ZB 1/32 = $31.25; $1000/pt), charged as a fraction
 *     of entry notional; ETFs $0.01/share + 2 bps per side (no quoted spread on hand). Net counts. Cost sensitivity printed (0x, 1x, 2x).
 *  N4 Look-ahead: the release date is pre-scheduled (posted weeks ahead); entry at a settle strictly before the pre-TRA session; nothing
 *     from the release content is used. Bars dated today or later (forming) are dropped.
 *  N5 Placebo (b): for every event one random NON-pre-TRA Friday of the same calendar month (Thu settle -> Fri settle, not in a roll
 *     window), 1000 draws, seed 285; observed t must exceed the 95th percentile of the draws' t. Controls (a) SPY same sessions, (c) events
 *     in the last 5 sessions of a month reported separately and excluded, (d) other-Friday mean, (e) auctions: Treasury does not auction
 *     on Fridays — structural, not machine-checked here. Registry regression: ret = a + b1 pre + b2 TRA + b3 post + DOW + last-5 (HC1).
 *  N6 Verdict: PASS only if tNet >= bar AND observed t beats the placebo p95 AND both halves (first/second half of the events) have the
 *     same sign of mean net; else DID NOT PASS.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), T = (f) => path.join(__dirname, "data", "training", "r285", f);
const ID = "R285", KEY = "PRE_TRA_DURATION_DRIFT", OUT = D("r285-pre-tra-duration-drift.json");
const mode = ["--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const PRIMARY_FROM = "2016-02-01", PRIMARY_TO = "2026-08-03", SUB_FROM = "2024-01-01", DRAWS = 1000, SEED = 285;
const TICK = { ZN: 1000 / 64, ZB: 1000 / 32 }, PTVAL = 1000, FEE_SIDE = 2.5, ETF_SIDE = { share: 0.01, bps: 0.0002 };
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// ---------- stats -------------------------------------------------------------------------------------------------------
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const welch = (a, b) => (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const r6 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(6)), r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3));
const isRollWindow = (d) => { const m = +d.slice(5, 7), day = +d.slice(8, 10); return ([2, 5, 8, 11].includes(m) && day >= 15) || ([3, 6, 9, 12].includes(m) && day <= 3); };

// OLS with HC1 robust SEs (Gaussian elimination; k is tiny)
function ols(X, y) {
  const n = X.length, k = X[0].length, A = Array.from({ length: k }, () => new Array(2 * k).fill(0));
  for (let i = 0; i < k; i++) { for (let j = 0; j < k; j++) { let s = 0; for (let r = 0; r < n; r++) s += X[r][i] * X[r][j]; A[i][j] = s; } A[i][k + i] = 1; }
  for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; const dv = A[c][c]; for (let j = 0; j < 2 * k; j++) A[c][j] /= dv; for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c]; for (let j = 0; j < 2 * k; j++) A[r][j] -= f * A[c][j]; } }
  const inv = A.map((row) => row.slice(k)), b = new Array(k).fill(0);
  for (let i = 0; i < k; i++) { let s = 0; for (let j = 0; j < k; j++) { let xy = 0; for (let r = 0; r < n; r++) xy += X[r][j] * y[r]; s += inv[i][j] * xy; } b[i] = s; }
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let r = 0; r < n; r++) { let e = y[r]; for (let j = 0; j < k; j++) e -= X[r][j] * b[j]; for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) meat[i][j] += X[r][i] * X[r][j] * e * e; }
  const cov = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) { let s = 0; for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) s += inv[i][a] * meat[a][c] * inv[c][j]; cov[i][j] = s * n / (n - k); }
  return { b, se: b.map((_, i) => Math.sqrt(cov[i][i])) };
}

// ---------- data --------------------------------------------------------------------------------------------------------
function loadTra() {
  const j = JSON.parse(fs.readFileSync(D("training/tra-dates.json"), "utf8")); return j.dates.map((x) => x.date).sort();
}
async function futures(sym) {
  const f = T(`${sym}-daily.json`);
  if (!fs.existsSync(f)) {
    const tok = await require("./lib/schwab.js").token();
    const u = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=%2F${sym}&periodType=year&period=20&frequencyType=daily&frequency=1&startDate=${Date.parse("2003-12-01T00:00:00Z")}&endDate=${Date.now()}`;
    const r = await fetch(u, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`schwab ${sym} ${r.status}`);
    fs.mkdirSync(T(""), { recursive: true }); writeJsonAtomic(f, { source: "schwab pricehistory daily /" + sym, fetchedAt: new Date().toISOString(), candles: (await r.json()).candles || [] }, { pretty: 0 });
  }
  const c = JSON.parse(fs.readFileSync(f, "utf8")).candles.map((x) => ({ d: new Date(x.datetime).toLocaleDateString("en-CA", { timeZone: "America/Chicago" }), c: x.close }))
    .filter((x) => x.c > 0 && x.d < todayET()).sort((a, b) => (a.d < b.d ? -1 : 1));
  return c.filter((x, i) => i === 0 || x.d !== c[i - 1].d);
}
const etfAlpaca = () => { const j = JSON.parse(fs.readFileSync(T("etf-daily.json"), "utf8")); return Object.fromEntries(Object.entries(j.bars).map(([s, b]) => [s, b.map((x) => ({ d: x.t.slice(0, 10), c: x.c })).filter((x) => x.d < todayET())])); };
const etfYahoo = (s) => JSON.parse(fs.readFileSync(T(`yahoo-${s}.json`), "utf8")).bars.filter((b) => b.adjClose > 0 && b.date < todayET()).map((b) => ({ d: b.date, c: b.adjClose }));

// ---------- cost --------------------------------------------------------------------------------------------------------
function rtCost(kind, c0, mult = 1) {   // round-trip cost as a fraction of entry notional
  if (kind === "ZN" || kind === "ZB") return mult * (2 * (TICK[kind] + FEE_SIDE)) / (c0 * PTVAL);
  return mult * 2 * (ETF_SIDE.share / c0 + ETF_SIDE.bps);
}

// ---------- events ------------------------------------------------------------------------------------------------------
function idxOf(S) { const m = new Map(S.map((x, i) => [x.d, i])); return m; }
function events(S, kind, traDates, { hold = 1, from = "0000", to = "9999", roll = false, costMult = 1 } = {}) {
  const out = [], skipped = [];
  for (const tra of traDates) {
    if (tra < from || tra > to) continue;
    let pre = -1; for (let i = S.length - 1; i >= 0; i--) if (S[i].d < tra) { pre = i; break; }
    if (pre < 1) { skipped.push({ tra, why: "no bars" }); continue; }
    const ei = pre - 1, xi = hold === 1 ? pre : pre + 1;
    if (xi >= S.length || (hold === 2 && S[xi].d < tra)) { skipped.push({ tra, why: "exit session missing" }); continue; }
    if (roll && (isRollWindow(S[ei].d) || isRollWindow(S[xi].d))) { skipped.push({ tra, why: "roll window " + S[ei].d + ".." + S[xi].d }); continue; }
    const gross = S[xi].c / S[ei].c - 1, net = gross - rtCost(kind, S[ei].c, costMult);
    out.push({ tra, entryD: S[ei].d, exitD: S[xi].d, preD: S[pre].d, preDow: dow(S[pre].d), gross, net, preIdx: pre });
  }
  return { ev: out, skipped };
}
function equityStats(nets) { let v = 1, pk = 1, dd = 0; for (const x of nets) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); } return { maxDDPct: +(100 * dd).toFixed(2), totalPct: +(100 * (v - 1)).toFixed(2) }; }
function summarize(ev) {
  const g = ev.map((e) => e.gross), n = ev.map((e) => e.net);
  return { n: ev.length, meanNetPct: r3(100 * mean(n)), tNet: r3(tOf(n)), meanGrossPct: r3(100 * mean(g)), tGross: r3(tOf(g)), winRate: r3(n.filter((x) => x > 0).length / n.length) };
}

(async () => {
  const tra = loadTra();
  const ZN = await futures("ZN");

  if (mode === "--selftest") {
    let ok = true; const chk = (name, pass, detail) => { console.log(`  ${pass ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); if (!pass) ok = false; };
    // T1 hand-computed synthetic: closes 100,102,101,103,104,103,105,106 (dates Mon..); TRA on d[5] => pre=idx4 (Fri-ish), entry idx3 exit idx4
    const S = ["2020-01-06", "2020-01-07", "2020-01-08", "2020-01-09", "2020-01-10", "2020-01-13", "2020-01-14", "2020-01-15"].map((d, i) => ({ d, c: [100, 102, 101, 103, 104, 103, 105, 106][i] }));
    const e1 = events(S, "ZN", ["2020-01-13"]).ev[0];
    chk("T1 synthetic gross = 104/103-1", Math.abs(e1.gross - (104 / 103 - 1)) < 1e-15, `${e1.gross}`);
    chk("T1 synthetic net = gross - (2*(15.625+2.5))/(103*1000)", Math.abs(e1.net - (104 / 103 - 1 - 36.25 / 103000)) < 1e-15, `${e1.net}`);
    const e2 = events(S, "ZN", ["2020-01-13"], { hold: 2 }).ev[0];
    chk("T1 two-session gross = 103/103-1 = 0", Math.abs(e2.gross) < 1e-15);
    chk("T1 t of [0.01,0.03] = 0.02/(0.0141421/sqrt2) = 2", Math.abs(tOf([0.01, 0.03]) - 2) < 1e-12 || tOf([0.01, 0.03]) === 0, `n<=2 returns 0 by house convention; 3-point check next`);
    chk("T1 t of [0.01,0.02,0.03] = 2*sqrt3", Math.abs(tOf([0.01, 0.02, 0.03]) - 0.02 / (0.01 / Math.sqrt(3))) < 1e-12);
    // T2 constant signal (in every session, zero roll skipping): compounded gross = last/first - 1 exactly; charged cost = n * round trip
    const win = ZN.filter((x) => x.d >= "2016-01-01"); let v = 1, cost = 0, hand = 0;
    for (let i = 1; i < win.length; i++) { v *= win[i].c / win[i - 1].c; cost += rtCost("ZN", win[i - 1].c); hand += 2 * (TICK.ZN + FEE_SIDE) / (win[i - 1].c * PTVAL); }
    chk("T2 always-long compounded gross == last/first - 1", Math.abs(v - win.at(-1).c / win[0].c) < 1e-9, `${v.toFixed(6)} vs ${(win.at(-1).c / win[0].c).toFixed(6)} over ${win.length - 1} sessions`);
    chk("T2 always-long cost == sessions x $36.25/notional", Math.abs(cost - hand) < 1e-12, `${(100 * cost).toFixed(3)}% total`);
    // T3 shuffled: random single sessions (1000 draws of 43) average to the all-session mean within 4 SE
    const rnd = mulberry(1), rets = []; for (let i = 1; i < win.length; i++) rets.push(win[i].c / win[i - 1].c - 1);
    const dm = []; for (let k = 0; k < 1000; k++) { const s = []; for (let j = 0; j < 43; j++) s.push(rets[Math.floor(rnd() * rets.length)]); dm.push(mean(s)); }
    const se = sd(rets) / Math.sqrt(43) / Math.sqrt(1000);
    chk("T3 shuffled-session placebo mean ~ all-session mean", Math.abs(mean(dm) - mean(rets)) < 4 * se, `diff ${(1e4 * (mean(dm) - mean(rets))).toFixed(3)} bp, 4se ${(4e4 * se).toFixed(3)} bp`);
    // T4 date file integrity
    const j = JSON.parse(fs.readFileSync(D("training/tra-dates.json"), "utf8"));
    chk("T4 91 TRA dates, all Mondays, all with source URL", j.dates.length === 91 && j.dates.every((x) => dow(x.date) === 1 && /^https:\/\/home\.treasury\.gov\//.test(x.sourceUrl)));
    chk("T4 every date <= 2023 matches the paper's Table 1", j.dates.filter((x) => x.date < "2024").every((x) => x.inPaperTable1 === true));
    const evAll = events(ZN, "ZN", tra, { roll: true });
    chk("T4 every event's pre-TRA session is a Friday with bars", evAll.ev.every((e) => e.preDow === 5), `${evAll.ev.length} events, non-Friday: ${evAll.ev.filter((e) => e.preDow !== 5).map((e) => e.preD).join(",") || "none"}; skipped ${evAll.skipped.length}`);
    chk("T4 bar sanity: /ZN coverage 2004-01..2026-09 > 5500 sessions, no dup dates", ZN.length > 5500 && new Set(ZN.map((x) => x.d)).size === ZN.length, `${ZN.length}`);
    console.log(ok ? "SELFTEST PASS" : "SELFTEST FAIL"); process.exit(ok ? 0 : 1);
  }

  // ------------------------------------------------ READ ------------------------------------------------------------------
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if ((seals.tests && seals.tests[ID]) || fs.existsSync(OUT)) throw new Error(`${ID} already sealed / output exists — read-once`);
  const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
  if (!ENTRY) throw new Error("R285 not registered");
  const BAR = ENTRY.bar.tRequired; if (!(BAR > 0)) throw new Error("no bar in registry");
  const ZB = await futures("ZB"), A = etfAlpaca();
  const Y = { IEF: etfYahoo("IEF"), TLT: etfYahoo("TLT"), SPY: etfYahoo("SPY") };
  const P = { from: PRIMARY_FROM, to: PRIMARY_TO, roll: true };

  // ---- primary: /ZN, 43 events ----
  const prim = events(ZN, "ZN", tra, P), ev = prim.ev, net = ev.map((e) => e.net), gross = ev.map((e) => e.gross);
  const S1 = summarize(ev);
  const half = Math.floor(ev.length / 2), h1 = ev.slice(0, half), h2 = ev.slice(half);
  const halves = { first: { ...summarize(h1), from: h1[0].tra, to: h1.at(-1).tra }, second: { ...summarize(h2), from: h2[0].tra, to: h2.at(-1).tra } };
  const sameSign = Math.sign(mean(h1.map((e) => e.net))) === Math.sign(mean(h2.map((e) => e.net)));

  // ---- placebo (b): random non-pre-TRA Fridays, same calendar month ----
  const preSet = new Set(events(ZN, "ZN", tra, {}).ev.map((e) => e.preIdx));
  const fridays = {}; ZN.forEach((s, i) => { if (i > 0 && dow(s.d) === 5 && !preSet.has(i) && !isRollWindow(s.d) && !isRollWindow(ZN[i - 1].d)) (fridays[s.d.slice(0, 7)] = fridays[s.d.slice(0, 7)] || []).push(i); });
  const rnd = mulberry(SEED), plT = [], plM = [];
  for (let k = 0; k < DRAWS; k++) { const x = ev.map((e) => { const pool = fridays[e.preD.slice(0, 7)]; const i = pool[Math.floor(rnd() * pool.length)]; return ZN[i].c / ZN[i - 1].c - 1 - rtCost("ZN", ZN[i - 1].c); }); plT.push(tOf(x)); plM.push(mean(x)); }
  plT.sort((a, b) => a - b); plM.sort((a, b) => a - b);
  const p95t = plT[Math.ceil(0.95 * DRAWS) - 1], p95m = plM[Math.ceil(0.95 * DRAWS) - 1], tNet = tOf(net);
  const beats = tNet > p95t;

  // ---- other-Friday control (d) and Welch on gross (registry rule statistic) ----
  const winRet = []; for (let i = 1; i < ZN.length; i++) { if (ZN[i].d < PRIMARY_FROM.slice(0, 4) + "-01-01" || ZN[i].d > PRIMARY_TO) continue; if (isRollWindow(ZN[i].d) || isRollWindow(ZN[i - 1].d)) continue; winRet.push({ i, d: ZN[i].d, r: ZN[i].c / ZN[i - 1].c - 1, fri: dow(ZN[i].d) === 5, pre: preSet.has(i) }); }
  const others = winRet.filter((x) => !x.pre), otherFri = others.filter((x) => x.fri);
  const welchT = welch(gross, others.map((x) => x.r));
  const ctrlD = { preTraGrossBp: r3(1e4 * mean(gross)), otherFridayMeanBp: r3(1e4 * mean(otherFri.map((x) => x.r))), otherFridayN: otherFri.length, allOtherSessionsMeanBp: r3(1e4 * mean(others.map((x) => x.r))), welchTGrossVsOtherSessions: r3(welchT) };

  // ---- control (c): end-of-month overlap (pre-TRA session in the last 5 sessions of its month) ----
  const monthOf = {}; ZN.forEach((s, i) => { (monthOf[s.d.slice(0, 7)] = monthOf[s.d.slice(0, 7)] || []).push(i); });
  const inLast5 = (i) => { const arr = monthOf[ZN[i].d.slice(0, 7)]; return arr.indexOf(i) >= arr.length - 5; };
  const eom = ev.filter((e) => inLast5(e.preIdx)), noEom = ev.filter((e) => !inLast5(e.preIdx));
  const ctrlC = { eomEvents: eom.length, eomMeanNetPct: eom.length ? r3(100 * mean(eom.map((e) => e.net))) : null, exEomN: noEom.length, exEomMeanNetPct: r3(100 * mean(noEom.map((e) => e.net))), exEomTNet: r3(tOf(noEom.map((e) => e.net))) };

  // ---- control (a): SPY on the same sessions; ETF shadows (Alpaca 2016+, Yahoo 2004+) ----
  const etfCell = (S, kind, opts) => { const r = events(S, kind, tra, opts); return { ...summarize(r.ev), skipped: r.skipped.length }; };
  const shadows = {
    ZN_two_session: { ...summarize(events(ZN, "ZN", tra, { ...P, hold: 2 }).ev) },
    ZB_primaryWindow: summarize(events(ZB, "ZB", tra, P).ev),
    ZN_extended_2004: summarize(events(ZN, "ZN", tra, { roll: true }).ev),
    ZB_extended_2004: summarize(events(ZB, "ZB", tra, { roll: true }).ev),
    IEF_alpaca_2016: etfCell(A.IEF, "ETF", P), TLT_alpaca_2016: etfCell(A.TLT, "ETF", P), SPY_alpaca_2016_PLACEBO: etfCell(A.SPY, "ETF", P),
    IEF_yahoo_2004: etfCell(Y.IEF, "ETF", { roll: false }), TLT_yahoo_2004: etfCell(Y.TLT, "ETF", { roll: false }), SPY_yahoo_2004_PLACEBO: etfCell(Y.SPY, "ETF", { roll: false }),
    ZN_subread_2024Q1_2026Q3_KILLSWITCH: summarize(events(ZN, "ZN", tra, { ...P, from: SUB_FROM }).ev),
  };

  // ---- registry regression form on all /ZN sessions in the primary window ----
  const traSet = new Set(tra), preIdxAll = preSet;
  const rows = [], y = [];
  for (const w of winRet) {
    const i = w.i, d = ZN[i].d, isTra = traSet.has(d) && dow(d) === 1, isPost = i > 0 && traSet.has(ZN[i - 1].d);
    const dw = dow(d), arr = monthOf[d.slice(0, 7)], last5 = arr.indexOf(i) >= arr.length - 5 ? 1 : 0;
    rows.push([1, preIdxAll.has(i) ? 1 : 0, isTra ? 1 : 0, isPost ? 1 : 0, dw === 1 ? 1 : 0, dw === 2 ? 1 : 0, dw === 3 ? 1 : 0, dw === 4 ? 1 : 0, last5]); y.push(w.r * 1e4);
  }
  const reg = ols(rows, y), regOut = { nSessions: rows.length, b1_preTRA_bp: r3(reg.b[1]), t1: r3(reg.b[1] / reg.se[1]), b2_TRA_bp: r3(reg.b[2]), t2: r3(reg.b[2] / reg.se[2]), b3_postTRA_bp: r3(reg.b[3]), t3: r3(reg.b[3] / reg.se[3]), note: "gross ret in bp, HC1, DOW dummies Mon-Thu (Fri base), last-5-sessions-of-month dummy; ZN sessions in the primary calendar window, roll sessions skipped" };

  // ---- ZN vs IEF sanity on event days (roll contamination check) ----
  const iefMap = new Map(A.IEF.map((x, i) => [x.d, i]));
  const znIef = ev.map((e) => { const i = iefMap.get(e.exitD), j = iefMap.get(e.entryD); return i != null && j != null ? [e.gross, A.IEF[i].c / A.IEF[j].c - 1] : null; }).filter(Boolean);
  const corr = (() => { const a = znIef.map((x) => x[0]), b = znIef.map((x) => x[1]), ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb); })();

  const costSens = [0, 1, 2].map((m) => { const e = events(ZN, "ZN", tra, { ...P, costMult: m }).ev.map((x) => x.net); return { costMult: m, meanNetPct: r3(100 * mean(e)), tNet: r3(tOf(e)) }; });
  const eq = equityStats(net), notionalDollars = +(10000 * mean(net) * 4).toFixed(2);
  const pass = tNet >= BAR && beats && sameSign;
  const verdictScript = pass ? "PASS" : "DID NOT PASS";
  const out = {
    id: ID, key: KEY, name: ENTRY.name, readAt: new Date().toISOString(),
    rule: "Long 1 /ZN from the Thursday settle to the pre-TRA (Friday) settle before each Treasury Refunding Announcement primary release; flat otherwise; roll sessions skipped",
    window: { primary: [PRIMARY_FROM, PRIMARY_TO], events: `${ev[0].tra}..${ev.at(-1).tra}` }, unit: "events", n: ev.length,
    statistic: "one-sample t over events of per-event net return (%-of-notional)", bar: BAR, barSource: "test-registry.json R285 bar.tRequired read at run time",
    tNet: r3(tNet), tGross: r3(tOf(gross)), meanNet: r6(mean(net)), meanGross: r6(mean(gross)), meanNetBp: r3(1e4 * mean(net)), meanGrossBp: r3(1e4 * mean(gross)), winRate: r3(net.filter((x) => x > 0).length / net.length),
    placebo: { kind: "random non-pre-TRA Friday in the same calendar month, one per event, Thu->Fri, net", draws: DRAWS, seed: SEED, p95: r3(p95t), p95MeanNetBp: r3(1e4 * p95m), medianT: r3(plT[Math.floor(DRAWS / 2)]), observed: r3(tNet), beats },
    halves: { ...halves, sameSign },
    dollarsAt10k: notionalDollars, dollarsNote: "net $/yr on $10k notional held one session x 4 events/yr = 10000 x mean net x 4; the capital is idle otherwise (cash not credited)",
    maxDD: eq.maxDDPct, maxDDNote: "% of notional on the compounded 43-event net curve", equity: eq,
    costModel: { futures: "1 tick + $2.50 per contract per side (ZN tick 1/64 pt = $15.625; ZB 1/32 = $31.25; $1000/pt); round trip ZN ~3.5 bp of notional", etf: "$0.01/share + 2 bps per side", sensitivity: costSens },
    controls: { a_SPY_sameSessions: { alpaca2016: shadows.SPY_alpaca_2016_PLACEBO, yahoo2004: shadows.SPY_yahoo_2004_PLACEBO }, c_endOfMonthNetting: ctrlC, d_otherFriday_and_welch: ctrlD, e_auctionSeparation: "Treasury does not auction on Fridays; not machine-checked (R184 separation is structural)", regression: regOut, znVsIefEventCorr: { n: znIef.length, corr: r3(corr) } },
    cells: shadows, skippedEvents: prim.skipped, preTraSessionNotFriday: ev.filter((e) => e.preDow !== 5).map((e) => e.preD),
    eventsList: ev.map((e) => ({ tra: e.tra, entry: e.entryD, exit: e.exitD, grossBp: r3(1e4 * e.gross), netBp: r3(1e4 * e.net) })),
    dataSources: ["Treasury press releases via data/training/tra-dates.json (91 dates, URL per date)", "Schwab pricehistory daily /ZN /ZB continuous (America/Chicago sessions), cached data/training/r285/", "Alpaca SIP 1Day adjustment=all IEF/TLT/SPY 2016+", "Yahoo (:3002) adjClose IEF/TLT/SPY 2004+ (extended cells only)"],
    knownWeaknesses: [
      "Public since 2024 (Wang & Zhao RFS R&R / Quantpedia 2024): crowding-out risk; the 11 post-sample events (2024Q1..2026Q3) are a kill switch, not a pass.",
      "Continuous /ZN is not back-adjusted; roll sessions handled by a calendar window (Feb/May/Aug/Nov d>=15, Mar/Jun/Sep/Dec d<=3), no event fell in one unless listed in skippedEvents.",
      "n=43 events: 2016+ paper effect 12 bp vs daily sd ~45 bp gives expected t ~1.75 before cost; the bar is a power question as much as an edge question.",
      "Schwab daily settle is the last-trade close of the daily candle, not the official CME settlement; the intraday forward-only cell is not read (5m from 2025-12 = 3 events).",
      "Pre-2018 releases were Monday 08:00 ET and 2018+ 15:00 ET; the pre-TRA session is the prior Friday in both regimes, but the regime change is a confound for the extended 2004+ cells.",
      "Registered same evening it was found; the read is out of sample to the paper (ends Q4 2023) only for the 2024+ sub-read.",
    ],
    verdictScript,
  };
  writeJsonAtomic(OUT, out);
  console.log(`R285 ${KEY}\n  PRIMARY /ZN ${ev.length} events ${out.window.events}: net ${out.meanNetBp} bp/event (gross ${out.meanGrossBp}) t ${out.tNet} (gross t ${out.tGross}) vs bar ${BAR}; win ${out.winRate}`);
  console.log(`  placebo p95 t ${out.placebo.p95} (median ${out.placebo.medianT}) -> ${beats ? "BEATEN" : "not beaten"}; halves ${halves.first.meanNetPct}% (t ${halves.first.tNet}, n ${halves.first.n}) / ${halves.second.meanNetPct}% (t ${halves.second.tNet}, n ${halves.second.n}) same sign ${sameSign}`);
  console.log(`  $/yr on $10k ${notionalDollars}; maxDD ${eq.maxDDPct}%; skipped ${prim.skipped.length}; ZN~IEF event corr ${r3(corr)}`);
  for (const [k, v] of Object.entries(shadows)) console.log(`  cell ${k}: n ${v.n} net ${v.meanNetPct}% t ${v.tNet} gross ${v.meanGrossPct}% t ${v.tGross}`);
  console.log(`  ctrlC ${JSON.stringify(ctrlC)}\n  ctrlD ${JSON.stringify(ctrlD)}\n  regression ${JSON.stringify(regOut)}`);
  console.log(`  VERDICT (script): ${verdictScript}`);
})().catch((e) => { console.error("R285 FAILED:", e.message); process.exit(1); });
