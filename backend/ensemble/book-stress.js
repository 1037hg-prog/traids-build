#!/usr/bin/env node
/**
 * BOOK STRESS — Treasury ZN 5x month-end overlay + a BTC/ETH 50-day trend sleeve + T-bills (ensemble-architect, 2026-09-25).
 * EXPLORATORY decision support. Seals nothing, registers nothing, reads no forward data.
 * Question (operator 2026-09-25): can what we actually have deliver ~30%/yr at <= 20% max drawdown, and how much of it is crypto drift?
 *
 * INPUTS (library, regenerated and reproduction-matched):
 *   TSY-ZN1X   monthly ZN month-end window net (tre), 2003-01..2026-08, with the T-bill (tb) from data/futures-month-end.json
 *   CRYPTO-T50 / -S10 / -S15 / -S20 / -S25   daily 50/50 BTC/ETH trend sleeve, cash at 0% (T-bill added here on out-of-market days)
 *   CRYPTO-BH  50/50 buy-and-hold benchmark
 * BOOK (monthly, the crypto-trend-book.js construction): r = L * tre + (1 - x) * tb + x * sleeve_with_cash_tbill; L = 5 (also 3), x in {0.1,0.2,0.3}.
 * Sharpe is reported on EXCESS over the T-bill (crypto-trend-book.js reports raw-return Sharpe; both shown for the reproduction row).
 *
 * STRESS (the sleeve keeps its own historical monthly path, volatility and drawdown shape; only its drift is replaced):
 *   log-return shift: l'_m = l_m - mean(l) + ln(1 + g) / 12, g in {0%, 10%, 20%} CAGR; "hist" = unshifted. Windows: 2017-01..2026-08
 *   (reproduction of the operator's figure), 2018-01..2026-08 (2017 excluded), 2021-01..2026-08.
 *   Treasury sensitivity: tre with its mean halved (publication decay), volatility unchanged.
 * BOOTSTRAP: circular moving-block bootstrap of the joint monthly rows (tre, tb, sleeve) inside a window, 60-month paths, 20,000
 *   paths per cell, block 12 months (6 and 24 reported), seed 235001 (mulberry32). P(max drawdown <= -20% within 5 years),
 *   P(5-year CAGR >= 30%), median 5-year CAGR. A second design samples Treasury blocks from 2003-2026 and crypto blocks from
 *   2018-2026 INDEPENDENTLY (measured monthly corr 0.04), so the Treasury tail includes 2003-2015.
 *   node backend/ensemble/book-stress.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const LIB = path.join(__dirname, "..", "data", "strategy-library");
const lib = (id) => JSON.parse(fs.readFileSync(path.join(LIB, id + ".json"), "utf8"));
const FME = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "futures-month-end.json"), "utf8")).rowsOut;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null), r1 = (x) => (Number.isFinite(x) ? +x.toFixed(1) : null);
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- monthly inputs --------------------------------------------------------------------------------------------------------
const TB = new Map(FME.map((r) => [r.m, r.tb])), TRE = new Map(FME.map((r) => [r.m, r.tre]));
const DTB3 = (() => { const M = {}; for (const l of fs.readFileSync(path.join(__dirname, "..", "data", "training", "fred", "DTB3.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") M[d.slice(0, 7)] = +v / 100 / 365; } return M; })();
function sleeveMonthly(id) {   // compound daily; out-of-market (absent) days earn the daily T-bill, as crypto-trend-book.js does
  const e = lib(id), s = new Map(e.series.map((x) => [x.d, x.r])), M = new Map();
  for (let t = Date.parse(e.window[0] + "T00:00:00Z"); t <= Date.parse(e.window[1] + "T00:00:00Z"); t += 864e5) { const d = new Date(t).toISOString().slice(0, 10), m = d.slice(0, 7);
    const r = s.has(d) ? s.get(d) : DTB3[m] || 0; M.set(m, (M.get(m) ?? 1) * (1 + r)); }
  return new Map([...M].map(([m, g]) => [m, g - 1])); }
const SLEEVES = ["CRYPTO-T50", "CRYPTO-T50-S10", "CRYPTO-T50-S15", "CRYPTO-T50-S20", "CRYPTO-T50-S25"];
const SL = Object.fromEntries(SLEEVES.map((id) => [id, sleeveMonthly(id)]));
const BH = (() => { const e = lib("CRYPTO-BH"), M = new Map(); for (const x of e.series) M.set(x.d.slice(0, 7), (M.get(x.d.slice(0, 7)) ?? 1) * (1 + x.r)); return new Map([...M].map(([m, g]) => [m, g - 1])); })();
const monthsIn = (lo, hi) => FME.map((r) => r.m).filter((m) => m >= lo && m <= hi && SL["CRYPTO-T50"].has(m));

function stats(r, tb) { const w = r.reduce((p, x) => p * (1 + x), 1); let pk = 1, v = 1, dd = 0, ddStart = null, ddEnd = null, curPk = 0, i = 0; for (const x of r) { v *= 1 + x; if (v > pk) { pk = v; curPk = i + 1; } const d = v / pk - 1; if (d < dd) { dd = d; ddStart = curPk; ddEnd = i + 1; } i++; }
  const ex = r.map((x, k) => x - tb[k]); let w12 = Infinity; for (let k = 12; k <= r.length; k++) w12 = Math.min(w12, r.slice(k - 12, k).reduce((p, x) => p * (1 + x), 1) - 1);
  return { cagrPct: r2(100 * (w ** (12 / r.length) - 1)), volPct: r2(100 * sd(r) * Math.sqrt(12)), sharpeExcess: r2(mean(ex) / sd(ex) * Math.sqrt(12)), sharpeRaw: r2(mean(r) / sd(r) * Math.sqrt(12)), maxDDPct: r1(100 * dd), worst12mPct: r1(100 * w12), _dd: [ddStart, ddEnd] }; }
const shiftTo = (arr, g) => { if (g == null) return arr.slice(); const l = arr.map((x) => Math.log(1 + x)), mu = mean(l), tgt = Math.log(1 + g) / 12; return l.map((x) => Math.exp(x - mu + tgt) - 1); };
function bookRows(ms, { sleeve = "CRYPTO-T50", x = 0.2, L = 5, g = null, treHalf = false } = {}) {
  const tre = ms.map((m) => TRE.get(m)), tb = ms.map((m) => TB.get(m)), trM = mean(tre), s = shiftTo(ms.map((m) => SL[sleeve].get(m)), g);
  return { r: ms.map((m, k) => L * (treHalf ? tre[k] - 0.5 * trM : tre[k]) + (1 - x) * tb[k] + x * s[k]), tb, s, tre }; }

const out = { spec: "ensemble-book-stress-v1", ranAt: new Date().toISOString(), exploratory: true, construction: "see header of backend/ensemble/book-stress.js" };
const W = { "2017-01..2026-08": ["2017-01", "2026-08"], "2018-01..2026-08 (2017 excluded)": ["2018-01", "2026-08"], "2021-01..2026-08": ["2021-01", "2026-08"] };

// ---- 0. reproduction of the operator's figure (crypto-trend-book.json: 29.9% / Sharpe 1.53 raw / -14.0) ----
{ const ms = monthsIn("2017-01", "2026-08"), b = bookRows(ms); out.reproduction = { window: "2017-01..2026-08", months: ms.length, ...stats(b.r, b.tb), persisted: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "crypto-trend-book.json"), "utf8")).res.book["Treasury 5x + 20% crypto [trend50 (no stop)]"] }; delete out.reproduction._dd; }

// ---- 1. the legs alone, per window ----
out.legs = {};
for (const [wn, [lo, hi]] of Object.entries(W)) { const ms = monthsIn(lo, hi), tb = ms.map((m) => TB.get(m));
  const t5 = ms.map((m, k) => 5 * TRE.get(m) + tb[k]); out.legs[wn] = { months: ms.length, tbillCAGRPct: stats(tb, tb).cagrPct, "Treasury 5x + T-bills": stats(t5, tb), "Treasury 3x + T-bills": stats(ms.map((m, k) => 3 * TRE.get(m) + tb[k]), tb),
    ...Object.fromEntries(SLEEVES.map((id) => [id + " (sleeve alone, T-bill when out)", stats(ms.map((m) => SL[id].get(m)), tb)])), "CRYPTO-BH (50/50 buy-and-hold)": stats(ms.map((m) => BH.get(m)), tb),
    corrTreVsSleeve: r2((() => { const a = ms.map((m) => TRE.get(m)), b = ms.map((m) => SL["CRYPTO-T50"].get(m)), ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; a.forEach((v, i) => { c += (v - ma) * (b[i] - mb); va += (v - ma) ** 2; vb += (b[i] - mb) ** 2; }); return c / Math.sqrt(va * vb); })()) };
  for (const k of Object.keys(out.legs[wn])) if (out.legs[wn][k] && out.legs[wn][k]._dd) delete out.legs[wn][k]._dd; }
{ const all = FME.map((r) => r.m), tb = all.map((m) => TB.get(m)), s = stats(all.map((m, k) => 5 * TRE.get(m) + tb[k]), tb); out.legs["Treasury 5x, 2003-01..2026-08"] = { ...s, maxDDFrom: all[s._dd[0]] || all[0], maxDDTrough: all[s._dd[1] - 1] }; delete out.legs["Treasury 5x, 2003-01..2026-08"]._dd; }

// ---- 1b. crypto sleeve alpha vs 50/50 buy-and-hold (monthly, NW lag 3) per window ----
function alphaVsBH(ms, id) { const y = ms.map((m) => SL[id].get(m) - TB.get(m)), x = ms.map((m) => BH.get(m) - TB.get(m)), mx = mean(x), my = mean(y); let c = 0, v = 0; x.forEach((xi, i) => { c += (xi - mx) * (y[i] - my); v += (xi - mx) ** 2; }); const b = c / v, a = my - b * mx, e = y.map((yi, i) => yi - a - b * x[i]);
  const n = e.length; let s0 = 0; for (const z of e) s0 += z * z; s0 /= n; let s = s0; for (let l = 1; l <= 3; l++) { let g = 0; for (let i = l; i < n; i++) g += e[i] * e[i - l]; s += 2 * (1 - l / 4) * g / n; }
  const sxx = v / n; return { beta: r2(b), alphaAnnPct: r2(1200 * a), alphaT_NW3_approx: r2(a / Math.sqrt(s / n * (1 + mx * mx / sxx))) }; }
out.sleeveAlphaVsBuyHold = Object.fromEntries(Object.entries(W).map(([wn, [lo, hi]]) => [wn, Object.fromEntries(SLEEVES.map((id) => [id, alphaVsBH(monthsIn(lo, hi), id)]))]));

// ---- 2. stress table ----
out.stress = [];
for (const [wn, [lo, hi]] of Object.entries(W)) { const ms = monthsIn(lo, hi);
  for (const sleeve of SLEEVES) for (const x of [0.1, 0.2, 0.3]) for (const g of [null, 0, 0.1, 0.2]) for (const treHalf of [false, true]) {
    if (treHalf && (sleeve !== "CRYPTO-T50" || x !== 0.2)) continue;
    const b = bookRows(ms, { sleeve, x, g, treHalf }), s = stats(b.r, b.tb); delete s._dd;
    out.stress.push({ window: wn, sleeve, cryptoWeight: x, sleeveCAGR: g == null ? "hist" : `${100 * g}%`, sleeveRealisedCAGRPct: stats(b.s, b.tb).cagrPct, sleeveMaxDDPct: stats(b.s, b.tb).maxDDPct, treasury: treHalf ? "edge halved" : "as measured", ...s }); } }
// required sleeve CAGR for a 30% book (bisection on g), T50, per window and weight
out.requiredSleeveCAGRFor30 = {};
for (const [wn, [lo, hi]] of Object.entries(W)) { const ms = monthsIn(lo, hi); out.requiredSleeveCAGRFor30[wn] = {};
  for (const x of [0.2, 0.3, 0.5]) { let a = -0.5, b = 20; for (let k = 0; k < 80; k++) { const mid = (a + b) / 2, c = stats(bookRows(ms, { x, g: mid }).r, ms.map((m) => TB.get(m))).cagrPct; if (c < 30) a = mid; else b = mid; }
    const bk = bookRows(ms, { x, g: b }), s = stats(bk.r, bk.tb); out.requiredSleeveCAGRFor30[wn][`x=${x}`] = { sleeveCAGRPct: r1(100 * b), bookMaxDDPct: s.maxDDPct, bookSharpeExcess: s.sharpeExcess }; } }

// ---- 3. block bootstrap ----
function bootstrap({ rows, blocks = 12, paths = 20000, H = 60, seed = 235001, indepTre = null }) {
  const rng = mulberry(seed), n = rows.length; let dd20 = 0, c30 = 0, c0 = 0; const cagr = [], mdd = [];
  for (let p = 0; p < paths; p++) { const path = []; while (path.length < H) { const st = Math.floor(rng() * n); for (let k = 0; k < blocks && path.length < H; k++) path.push({ ...rows[(st + k) % n] }); }
    if (indepTre) { let i = 0; while (i < H) { const st = Math.floor(rng() * indepTre.length); for (let k = 0; k < blocks && i < H; k++, i++) { const t = indepTre[(st + k) % indepTre.length]; path[i].tre = t.tre; path[i].tb = t.tb; } } }
    let v = 1, pk = 1, dd = 0; for (const z of path) { v *= 1 + z.L * z.tre + (1 - z.x) * z.tb + z.x * z.s; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
    const cg = v ** (12 / H) - 1; cagr.push(cg); mdd.push(dd); if (dd <= -0.2) dd20++; if (cg >= 0.3) c30++; if (cg < 0) c0++; }
  cagr.sort((a, b) => a - b); mdd.sort((a, b) => a - b);
  return { pMaxDD20pct: r2(100 * dd20 / paths), pCAGR30pct: r2(100 * c30 / paths), pLossOver5yPct: r2(100 * c0 / paths), medianCAGRPct: r1(100 * cagr[paths >> 1]), p5CAGRPct: r1(100 * cagr[Math.floor(0.05 * paths)]), medianMaxDDPct: r1(100 * mdd[paths >> 1]), p5MaxDDPct: r1(100 * mdd[Math.floor(0.05 * paths)]) }; }
out.bootstrap = [];
const treAll = FME.map((r) => ({ tre: r.tre, tb: r.tb }));
for (const [wn, [lo, hi]] of Object.entries({ "2018-01..2026-08 (2017 excluded)": W["2018-01..2026-08 (2017 excluded)"], "2021-01..2026-08": W["2021-01..2026-08"] })) { const ms = monthsIn(lo, hi);
  for (const x of [0, 0.1, 0.2, 0.3]) for (const g of [null, 0, 0.1, 0.2]) { if (x === 0 && g !== null) continue; for (const L of [5, 3]) { if (L === 3 && x !== 0.2) continue;
    const s = shiftTo(ms.map((m) => SL["CRYPTO-T50"].get(m)), g), rows = ms.map((m, k) => ({ tre: TRE.get(m), tb: TB.get(m), s: s[k], x, L }));
    for (const blocks of [12, 6, 24]) { if (blocks !== 12 && !(x === 0.2 && L === 5)) continue;
      out.bootstrap.push({ window: wn, design: "joint", treasuryL: L, cryptoWeight: x, sleeveCAGR: x === 0 ? "n/a" : g == null ? "hist" : `${100 * g}%`, blockMonths: blocks, ...bootstrap({ rows, blocks }) });
      if (blocks === 12) out.bootstrap.push({ window: wn + " crypto; Treasury 2003-01..2026-08", design: "independent", treasuryL: L, cryptoWeight: x, sleeveCAGR: x === 0 ? "n/a" : g == null ? "hist" : `${100 * g}%`, blockMonths: 12, ...bootstrap({ rows, blocks, indepTre: treAll }) }); } } } }
writeJsonAtomic(path.join(__dirname, "..", "data", "ensemble-book-stress-2026-09-25.json"), out);

// ---- print ----
console.log("REPRODUCTION", JSON.stringify(out.reproduction));
for (const [wn, v] of Object.entries(out.legs)) console.log("LEGS", wn, JSON.stringify(v));
console.log("SLEEVE ALPHA vs 50/50 B&H", JSON.stringify(out.sleeveAlphaVsBuyHold));
console.log("REQUIRED sleeve CAGR for a 30% book", JSON.stringify(out.requiredSleeveCAGRFor30));
for (const s of out.stress.filter((z) => z.sleeve === "CRYPTO-T50")) console.log("STRESS", s.window.padEnd(34), `x=${s.cryptoWeight}`, `g=${s.sleeveCAGR}`.padEnd(7), s.treasury.padEnd(12), `sleeve ${s.sleeveRealisedCAGRPct}%/${s.sleeveMaxDDPct}`, `| book CAGR ${s.cagrPct} vol ${s.volPct} ShX ${s.sharpeExcess} maxDD ${s.maxDDPct} w12 ${s.worst12mPct}`);
for (const b of out.bootstrap) console.log("BOOT", b.design.padEnd(11), b.window.slice(0, 40).padEnd(40), `L=${b.treasuryL} x=${b.cryptoWeight} g=${b.sleeveCAGR} blk=${b.blockMonths}`.padEnd(30), `P(DD<=-20%) ${b.pMaxDD20pct}% P(CAGR>=30%) ${b.pCAGR30pct}% P(loss) ${b.pLossOver5yPct}% medCAGR ${b.medianCAGRPct} p5CAGR ${b.p5CAGRPct} medDD ${b.medianMaxDDPct} p5DD ${b.p5MaxDDPct}`);
