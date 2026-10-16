#!/usr/bin/env node
/**
 * R203-R206 — FORCED FLOWS ROUND 5 (registered 2026-09-24 before this file ran; rules frozen in the registry).
 *   R203 BNDX month-end, part independent of IEF's (beta on the prior 36 months)   R204 TIP month-end, same
 *   R205 UUP quarter-end squeeze + reversal                                        R206 IEF mid-month coupon window
 * Each read is sealed once; placebo = the same window length at random positions inside each period (200 draws), true t must beat p95.
 *   node backend/r203-r206-flows5.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), T = seals.tests || seals;
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = (id) => reg.preregistered.find((t) => t.id === id);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const COST = 0.0004;
const comp = (a) => a.reduce((p, x) => p * (1 + x), 1) - 1;
(async () => {
  const { bars } = await fetchBars(["IEF", "BNDX", "TIP", "UUP", "TLT"], { start: "2015-12-01", end: "2026-09-01", feed: "sip", adjustment: "all", quiet: true });
  const rets = {}; for (const s of Object.keys(bars)) { rets[s] = []; const b = bars[s]; for (let i = 1; i < b.length; i++) rets[s].push({ d: b[i].t.slice(0, 10), r: b[i].c / b[i - 1].c - 1 }); }
  const byPeriod = (s, key) => { const o = {}; for (const x of rets[s]) { const k = key(x.d); if (k) (o[k] = o[k] || []).push(x); } return o; };
  const month = (d) => (d >= "2016-01" && d.slice(0, 7) <= "2026-08" ? d.slice(0, 7) : null);
  const results = {};
  // --- month-end window excess per month for a symbol; startFn picks the window start index (for the placebo) ---
  const meExcess = (arr, start, len = 5) => comp(arr.slice(start, start + len).map((x) => x.r)) - len * mean([...arr.slice(0, start), ...arr.slice(start + len)].map((x) => x.r)) - COST;
  function independent(sym, startFn) {
    const A = byPeriod(sym, month), I = byPeriod("IEF", month), months = Object.keys(A).filter((m) => I[m] && A[m].length >= 15 && I[m].length >= 15).sort();
    const a = months.map((m) => meExcess(A[m], startFn(A[m], m))), b = months.map((m) => meExcess(I[m], startFn(I[m], m)));
    const out = [];
    for (let k = 0; k < months.length; k++) { const lo = Math.max(0, k - 36), xs = b.slice(lo, k), ys = a.slice(lo, k); let beta;
      if (xs.length >= 12) { const mx = mean(xs), my = mean(ys); let c = 0, v = 0; for (let i = 0; i < xs.length; i++) { c += (xs[i] - mx) * (ys[i] - my); v += (xs[i] - mx) ** 2; } beta = c / v; }
      else { const xx = b.slice(0, Math.max(12, k + 1)), yy = a.slice(0, Math.max(12, k + 1)); const mx = mean(xx), my = mean(yy); let c = 0, v = 0; for (let i = 0; i < xx.length; i++) { c += (xx[i] - mx) * (yy[i] - my); v += (xx[i] - mx) ** 2; } beta = c / v; }   // first 12 months: expanding sample (disclosed; includes the current month's pair only as part of the minimum-12 start)
      out.push(a[k] - beta * b[k]); }
    const mx = mean(b), my = mean(a); let c = 0, v = 0, vy = 0; for (let i = 0; i < a.length; i++) { c += (b[i] - mx) * (a[i] - my); v += (b[i] - mx) ** 2; vy += (a[i] - my) ** 2; }
    return { months: months.length, series: out, raw: a, fullBeta: c / v, corr: c / Math.sqrt(v * vy) };
  }
  const last5 = (arr) => arr.length - 5;
  for (const [id, sym] of [["R203", "BNDX"], ["R204", "TIP"]]) {
    const r = independent(sym, last5), t = tOf(r.series);
    const draws = []; for (let k = 0; k < 200; k++) { const rng = mulberry(203000 + k + (sym === "TIP" ? 500 : 0)); const pick = {}; draws.push(tOf(independent(sym, (arr, m) => (pick[m + arr.length] = pick[m + arr.length] ?? Math.floor(rng() * (arr.length - 4)))).series)); }
    draws.sort((x, y) => x - y); const p95 = draws[190];
    results[id] = { sym, months: r.months, independentMeanPct: +(100 * mean(r.series)).toFixed(3), independentT: +t.toFixed(3), rawMeanPct: +(100 * mean(r.raw)).toFixed(3), rawT: +tOf(r.raw).toFixed(3), fullBetaOnIEF: +r.fullBeta.toFixed(2), corrWithIEF: +r.corr.toFixed(2), placeboP95: +p95.toFixed(3), primaryT: t };
  }
  // --- R205 quarter-end dollar squeeze ---
  { const Q = byPeriod("UUP", (d) => (d >= "2016-01" && d.slice(0, 7) <= "2026-06" ? `${d.slice(0, 4)}Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}` : null)); const qs = Object.keys(Q).sort();
    const legEx = (arr, start) => comp(arr.slice(start, start + 5).map((x) => x.r)) - 5 * mean([...arr.slice(0, start), ...arr.slice(start + 5)].map((x) => x.r)) - COST;
    const series = [], A = [], B = [];
    for (let k = 0; k + 1 < qs.length; k++) { const q = Q[qs[k]], n = Q[qs[k + 1]]; const a = legEx(q, q.length - 5), b = -legEx(n, 0) - 0; A.push(a); B.push(b - COST); series.push(a + b - COST); }
    // non-quarter month-end placebo (same legs at month-ends that are not quarter-ends)
    const M = byPeriod("UUP", month), ms = Object.keys(M).sort(), pl = [];
    for (let k = 0; k + 1 < ms.length; k++) { if (["03", "06", "09", "12"].includes(ms[k].slice(5, 7))) continue; const q = M[ms[k]], n = M[ms[k + 1]]; pl.push(legEx(q, q.length - 5) - legEx(n, 0) - COST); }
    const draws = []; for (let k = 0; k < 200; k++) { const rng = mulberry(205000 + k), s = []; for (let j = 0; j + 1 < qs.length; j++) { const q = Q[qs[j]]; const st = Math.floor(rng() * (q.length - 9)); s.push(legEx(q, st) - legEx(q, st + 5) - COST); } draws.push(tOf(s)); }
    draws.sort((x, y) => x - y); const t = tOf(series);
    results.R205 = { quarters: series.length, meanPct: +(100 * mean(series)).toFixed(3), t: +t.toFixed(3), legA_t: +tOf(A).toFixed(2), legB_t: +tOf(B).toFixed(2), nonQuarterMonthEndPlaceboT: +tOf(pl).toFixed(2), placeboP95: +draws[190].toFixed(3), primaryT: t };
  }
  // --- R206 mid-month coupon window (IEF), month-end window excluded from the baseline ---
  function midMonth(sym, startFn) { const M = byPeriod(sym, month), ms = Object.keys(M).filter((m) => M[m].length >= 15).sort(); const out = [];
    for (const m of ms) { const a = M[m]; let e = a.findIndex((x) => +x.d.slice(8, 10) >= 15); if (e < 2) continue; const s0 = startFn ? startFn(a) : e - 2; const win = a.slice(s0, s0 + 3), meIdx = a.length - 5;
      const base = a.filter((x, i) => (i < s0 || i >= s0 + 3) && i < meIdx).map((x) => x.r); out.push(comp(win.map((x) => x.r)) - 3 * mean(base) - COST); }
    return out; }
  { const s = midMonth("IEF"), t = tOf(s); const draws = []; for (let k = 0; k < 200; k++) { const rng = mulberry(206000 + k); draws.push(tOf(midMonth("IEF", (a) => Math.floor(rng() * (a.length - 8))))); } draws.sort((x, y) => x - y);
    results.R206 = { months: s.length, meanPct: +(100 * mean(s)).toFixed(3), t: +t.toFixed(3), tltT: +tOf(midMonth("TLT")).toFixed(2), placeboP95: +draws[190].toFixed(3), primaryT: t }; }
  // --- verdicts + seals ---
  for (const id of ["R203", "R204", "R205", "R206"]) {
    const r = results[id], e = E(id); if (T[id]) { console.log(`${id} already sealed — skipped`); continue; }
    const pass = r.primaryT >= e.bar.tRequired && r.primaryT > r.placeboP95;
    const verdict = `${pass ? "PASS" : "DID NOT PASS"} — primary t ${r.primaryT.toFixed(3)} vs bar ${e.bar.tRequired}, placebo p95 ${r.placeboP95}`;
    r.verdict = verdict; delete r.primaryT;
    T[id] = { sealedOn: new Date().toISOString().slice(0, 10), unit: e.bar.unit, verdict };
    e.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict;
    fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: id, verdict }) + "\n");
  }
  writeJsonAtomic(D("read-seals.json"), seals); reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  writeJsonAtomic(D("r203-r206-flows5.json"), { spec: "flows5-v1", ranAt: new Date().toISOString(), results });
  console.log(JSON.stringify(results, null, 1));
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
