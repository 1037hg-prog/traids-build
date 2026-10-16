#!/usr/bin/env node
/**
 * R216 — MONTH-END DOLLAR REVERSAL on spot FX before 2016 (registered 2026-09-24 by register-r216.js before this file ran; rule frozen).
 * Alpha Vantage FX_DAILY via lib/av-scout-cache.js (cached, key never printed). Sealed once.
 *   node backend/r216-usd-month-end.js [--dry]    (--dry prints sample counts only, seals nothing)
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// [cache name, from, to, +1 if the quote rises when the dollar rises]
const PAIRS = [["EURUSD", "EUR", "USD", -1], ["GBPUSD", "GBP", "USD", -1], ["AUDUSD", "AUD", "USD", -1], ["USDJPY", "USD", "JPY", 1], ["USDCHF", "USD", "CHF", 1], ["USDCAD", "USD", "CAD", 1]];
const COST = 0.0001;
(async () => {
  // Amendment 2026-09-24 (pre-evidence): source = Yahoo daily FX via the local :3002 proxy; bad-tick guard (>5% change fully reversed next day).
  const YF = { EURUSD: "EURUSD=X", GBPUSD: "GBPUSD=X", AUDUSD: "AUDUSD=X", USDJPY: "JPY=X", USDCHF: "CHF=X", USDCAD: "CAD=X" };
  const series = {}, badTicks = {};
  for (const [name, , , sgn] of PAIRS) {
    const j = await (await fetch(`http://localhost:3002/api/yahoo/${encodeURIComponent(YF[name])}/history?days=9000&interval=1d`, { signal: AbortSignal.timeout(60000) })).json();
    if (!j.bars || j.bars.length < 3000) throw new Error(`${name}: short Yahoo series (${j.bars ? j.bars.length : 0})`);
    series[name] = { sgn, px: new Map(j.bars.filter((b) => b.date <= "2026-08-31" && b.close > 0).map((b) => [b.date, b.close])) };
  }
  const dates = [...series.EURUSD.px.keys()].filter((d) => PAIRS.every(([n]) => series[n].px.has(d))).sort();
  // daily dollar change per pair and for the basket; bad ticks dropped per pair (both changes), basket = mean of the pairs left that day
  const raw = {}; for (const [n, , , sgn] of PAIRS) { raw[n] = []; for (let i = 1; i < dates.length; i++) raw[n].push(sgn * Math.log(series[n].px.get(dates[i]) / series[n].px.get(dates[i - 1]))); badTicks[n] = 0;
    for (let i = 0; i + 1 < raw[n].length; i++) { const a = raw[n][i], b = raw[n][i + 1]; if (a != null && b != null && Math.abs(a) > 0.05 && Math.sign(a) !== Math.sign(b) && Math.abs(b) >= 0.8 * Math.abs(a)) { raw[n][i] = null; raw[n][i + 1] = null; badTicks[n]++; } } }
  const chg = { BASKET: [] }; for (const [n] of PAIRS) chg[n] = [];
  for (let i = 1; i < dates.length; i++) { const cs = []; for (const [n] of PAIRS) { const c = raw[n][i - 1]; if (c == null) continue; chg[n].push({ d: dates[i], c }); cs.push(c); } if (cs.length) chg.BASKET.push({ d: dates[i], c: mean(cs) }); }
  function months(key, lo, hi) { const M = {}; for (const x of chg[key]) { const m = x.d.slice(0, 7); if (m >= lo && m <= hi) (M[m] = M[m] || []).push(x.c); } return Object.entries(M).filter(([, a]) => a.length >= 15).sort(); }
  // entry after session index k (close of k), exit close of index xk; signal = sum of changes 0..sigTo
  function rule(key, lo, hi, { kOf = (L) => L - 4, exitOff = 2, sigOff = 0 } = {}) { const out = [];
    for (const [m, a] of months(key, lo, hi)) { const L = a.length, k = kOf(L), xk = k + exitOff; if (xk >= L) continue;
      const sig = a.slice(0, k + 1 - sigOff).reduce((x, y) => x + y, 0), win = a.slice(k + 1, xk + 1).reduce((x, y) => x + y, 0), other = a.filter((_, j) => j <= k || j > xk);
      const ex = win - exitOff * mean(other); out.push({ m, raw: ex, v: (sig > 0 ? -1 : 1) * ex - 2 * COST }); }
    return out; }
  const PRE = ["0000-00", "2015-12"], POST = ["2016-01", "2026-08"];
  const A = rule("BASKET", ...PRE, { exitOff: 2 }), Bv = rule("BASKET", ...PRE, { exitOff: 3 });
  if (process.argv.includes("--dry")) { console.log("DRY (counts only):", JSON.stringify({ firstDate: dates[0], lastDate: dates[dates.length - 1], commonDates: dates.length, badTicks, preMonthsA: A.length, preMonthsB: Bv.length })); return; }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), SEAL = seals.tests || seals;
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), e = reg.preregistered.find((t) => t.id === "R216");
  if (SEAL.R216) { console.error("R216 already sealed — refusing"); process.exit(2); }
  const tA = tOf(A.map((x) => x.v)), tB = tOf(Bv.map((x) => x.v)), best = tA >= tB ? "A" : "B", bestRows = best === "A" ? A : Bv, tBest = Math.max(tA, tB);
  const rng = mulberry(216000), draws = []; for (let k = 0; k < 200; k++) draws.push(tOf(bestRows.map((x) => (rng() < 0.5 ? 1 : -1) * x.raw - 2 * COST))); draws.sort((x, y) => x - y); const p95 = draws[190];
  const res = { preMonths: A.length, firstDate: dates[0], badTicks, variantA_exitL2: { t: +tA.toFixed(3), meanBps: +(1e4 * mean(A.map((x) => x.v))).toFixed(2) }, variantB_exitL1: { t: +tB.toFixed(3), meanBps: +(1e4 * mean(Bv.map((x) => x.v))).toFixed(2) },
    perPairPre_tA: Object.fromEntries(PAIRS.map(([n]) => [n, +tOf(rule(n, ...PRE).map((x) => x.v)).toFixed(2)])), skipDaySignalPre_tA: +tOf(rule("BASKET", ...PRE, { sigOff: 1 }).map((x) => x.v)).toFixed(2),
    midMonthPre_tA: +tOf(rule("BASKET", ...PRE, { kOf: () => 6 }).map((x) => x.v)).toFixed(2), inSample2016_2026_tA: +tOf(rule("BASKET", ...POST).map((x) => x.v)).toFixed(2), placeboP95: +p95.toFixed(3) };
  let verdict;
  if (A.length < 60) verdict = `INCONCLUSIVE — only ${A.length} pre-2016 months`;
  else verdict = `${tBest >= e.bar.tRequired && tBest > p95 ? "PASS" : "DID NOT PASS"} — best variant ${best} t ${tBest.toFixed(3)} vs bar ${e.bar.tRequired}, placebo p95 ${p95.toFixed(3)}`;
  res.verdict = verdict;
  SEAL.R216 = { sealedOn: new Date().toISOString().slice(0, 10), unit: e.bar.unit, verdict }; e.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict;
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R216", verdict }) + "\n");
  writeJsonAtomic(D("read-seals.json"), seals); reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  writeJsonAtomic(D("r216-usd-month-end.json"), { spec: "r216-v1", ranAt: new Date().toISOString(), results: res });
  console.log(JSON.stringify(res, null, 1));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
