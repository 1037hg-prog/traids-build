#!/usr/bin/env node
/**
 * R217 — DOLLAR SHORT-TERM REVERSAL, rolling form, on Federal Reserve H.10 rates 1974-01-02..2006-04-30 (DEXGEUS dropped by a pre-evidence amendment 2026-09-24: FRED 404) (registered 2026-09-24 by
 * register-r217-r218.js before this file ran; rule frozen). FRED CSVs cached in data/training/fred/ (no key). Sealed once.
 *   node backend/r217-dollar-reversal-fred.js [--dry]   (--dry prints sample counts only, seals nothing)
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = path.join(__dirname, "data", "training", "fred");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// [series, +1 if the quote rises when the dollar rises, first date used, last date used]
const SER = [["DEXJPUS", 1], ["DEXSZUS", 1], ["DEXCAUS", 1], ["DEXUSUK", -1], ["DEXUSAL", -1], ["DEXUSEU", -1, "1999-01-04", "9999"]];
const LO = "1974-01-02", HI = "2006-04-30", COST = 0.0001;
async function series(id) {
  fs.mkdirSync(CACHE, { recursive: true }); const f = path.join(CACHE, id + ".csv");
  if (!fs.existsSync(f)) { const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`); fs.writeFileSync(f, await r.text()); }
  const rows = fs.readFileSync(f, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v !== "." && +v > 0);
  return rows.map(([d, v]) => [d, +v]);
}
(async () => {
  // per-series daily dollar log change between consecutive valid observations, with the bad-tick guard
  const chg = new Map(), badTicks = {};
  for (const [id, sgn, from = "0000", to = "9999"] of SER) {
    const s = (await series(id)).filter(([d]) => d >= from && d <= to); const c = [];
    for (let i = 1; i < s.length; i++) c.push({ d: s[i][0], c: sgn * Math.log(s[i][1] / s[i - 1][1]) });
    badTicks[id] = 0; for (let i = 0; i + 1 < c.length; i++) { const a = c[i].c, b = c[i + 1].c; if (a != null && b != null && Math.abs(a) > 0.05 && Math.sign(a) !== Math.sign(b) && Math.abs(b) >= 0.8 * Math.abs(a)) { c[i].c = null; c[i + 1].c = null; badTicks[id]++; } }
    for (const x of c) if (x.c != null) (chg.get(x.d) || chg.set(x.d, []).get(x.d)).push(x.c);
  }
  const basket = [...chg.entries()].filter(([, a]) => a.length >= 4).sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, a]) => ({ d, c: mean(a) }));
  function rolling(L, lo, hi, signs) {   // returns per-month sums of net block returns; signs(k) optional override for the placebo
    const B = basket.filter((x) => x.d >= lo && x.d <= hi), M = {}; let k = 0;
    for (let t = L; t + 3 < B.length; t += 3, k++) { const sig = B.slice(t - L, t).reduce((s, x) => s + x.c, 0); if (sig === 0) continue;
      const pos = signs ? signs(k) : -Math.sign(sig), ret = B.slice(t, t + 3).reduce((s, x) => s + x.c, 0); const m = B[t].d.slice(0, 7); M[m] = (M[m] || 0) + pos * ret - 2 * COST; }
    return Object.values(M); }
  function monthEnd(lo, hi) {   // R216 variant B on this data, for continuity
    const M = {}; for (const x of basket.filter((x) => x.d >= lo && x.d <= hi)) (M[x.d.slice(0, 7)] = M[x.d.slice(0, 7)] || []).push(x.c); const out = [];
    for (const a of Object.values(M)) { if (a.length < 15) continue; const L = a.length, k = L - 4, xk = k + 3; const sig = a.slice(0, k + 1).reduce((s, y) => s + y, 0), win = a.slice(k + 1, xk + 1).reduce((s, y) => s + y, 0), other = a.filter((_, j) => j <= k || j > xk); out.push((sig > 0 ? -1 : 1) * (win - 3 * mean(other)) - 2 * COST); }
    return out; }
  const months = { 10: rolling(10, LO, HI), 15: rolling(15, LO, HI), 20: rolling(20, LO, HI) };
  if (process.argv.includes("--dry")) { console.log("DRY (counts only):", JSON.stringify({ basketDates: basket.length, first: basket[0].d, inWindow: basket.filter((x) => x.d >= LO && x.d <= HI).length, months: months[15].length, badTicks })); return; }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), SEAL = seals.tests || seals;
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), e = reg.preregistered.find((t) => t.id === "R217");
  if (SEAL.R217) { console.error("R217 already sealed — refusing"); process.exit(2); }
  const tL = Object.fromEntries(Object.entries(months).map(([L, a]) => [L, tOf(a)])); const bestL = Object.keys(tL).sort((a, b) => tL[b] - tL[a])[0], tBest = tL[bestL];
  const draws = []; for (let k = 0; k < 200; k++) { const rng = mulberry(217000 + k); const cache = []; draws.push(tOf(rolling(+bestL, LO, HI, (i) => (cache[i] ??= rng() < 0.5 ? 1 : -1)))); } draws.sort((a, b) => a - b); const p95 = draws[190];
  const res = { window: `${LO}..${HI}`, months: months[bestL].length, badTicks, byLookback: Object.fromEntries(Object.entries(months).map(([L, a]) => [`L${L}`, { t: +tL[L].toFixed(3), meanMonthlyBps: +(1e4 * mean(a)).toFixed(1) }])), bestL: +bestL,
    halves_bestL: { "1974-1989": +tOf(rolling(+bestL, LO, "1989-12-31")).toFixed(2), "1990-2006": +tOf(rolling(+bestL, "1990-01-01", HI)).toFixed(2) },
    monthEndRuleR216B: +tOf(monthEnd(LO, HI)).toFixed(2), inSample2006_05_on_FRED_L15: +tOf(rolling(15, "2006-05-01", "2026-08-31")).toFixed(2), placeboP95: +p95.toFixed(3) };
  const verdict = `${tBest >= e.bar.tRequired && tBest > p95 ? "PASS" : "DID NOT PASS"} — best L=${bestL} t ${tBest.toFixed(3)} vs bar ${e.bar.tRequired}, placebo p95 ${p95.toFixed(3)}`;
  res.verdict = verdict;
  SEAL.R217 = { sealedOn: new Date().toISOString().slice(0, 10), unit: e.bar.unit, verdict }; e.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict;
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R217", verdict }) + "\n");
  writeJsonAtomic(D("read-seals.json"), seals); reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  writeJsonAtomic(D("r217-dollar-reversal-fred.json"), { spec: "r217-v1", ranAt: new Date().toISOString(), results: res });
  console.log(JSON.stringify(res, null, 1));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
