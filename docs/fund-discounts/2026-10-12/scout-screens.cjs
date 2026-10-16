"use strict";
// STEP 3 (offline, no request): three integrity screens on the cached series. DATES AND COUNTS ONLY.
//  A. UNIT SCREEN: on how many rows is price / NAV outside 0.5 .. 2.0? A fund does not trade at half or double its assets for long, so a
//     block of such rows means the two series are not in the same units (one adjusted for a share split and the other not). No ratio
//     value is printed; only the count and the dates of the block. This is a check of the data, not a measurement of any discount.
//  B. STALE-FEED SCREEN: on which market days are many funds inside a run of 5+ identical NAV rows at once (a feed-wide stale stretch)?
//  C. START SCREEN: does the NAV history start when the fund's price history starts, or later (history cut off at the front)?
const fs = require("fs"), path = require("path");
const { CACHE } = require("./scout-lib.cjs");
const U = JSON.parse(fs.readFileSync(path.join(__dirname, "scout-universe.json"), "utf8")).funds;
const cal = JSON.parse(fs.readFileSync(path.join(CACHE, "calendar.json"), "utf8")).days;
const load = (s) => JSON.parse(fs.readFileSync(path.join(CACHE, "series", s + ".json"), "utf8"));
const both = U.filter((f) => f.priceRows && f.navRows);
const flatCount = new Map(); const unit = [], same = [];
for (const f of both) {
  const P = load(f.ticker), V = load(f.navSymbol), pm = new Map(P.idx.map((i, k) => [i, P.close[k]]));
  // D. IDENTITY SCREEN: on what share of rows is the "NAV" exactly the price? A real NAV almost never equals the price to the cent.
  { let eq = 0, m = 0; for (let k = 0; k < V.idx.length; k++) { const p = pm.get(V.idx[k]); if (p == null) continue; m++; if (Math.abs(p - V.close[k]) < 1e-9) eq++; } same.push({ t: f.ticker, nav: f.navSymbol, share: eq / Math.max(1, m), eq, m }); }
  // A
  let out = 0, n = 0, first = null, last = null; const blocks = []; let cur = null;
  for (let k = 0; k < V.idx.length; k++) { const p = pm.get(V.idx[k]); if (p == null || !(V.close[k] > 0)) continue; n++; const r = p / V.close[k];
    if (r < 0.5 || r > 2) { out++; if (!first) first = cal[V.idx[k]]; last = cal[V.idx[k]]; if (cur && V.idx[k] - cur.endIdx <= 3) { cur.endIdx = V.idx[k]; cur.rows++; } else { cur = { startIdx: V.idx[k], endIdx: V.idx[k], rows: 1, side: r < 0.5 ? "price under half of NAV" : "price over double NAV" }; blocks.push(cur); } } }
  if (out) unit.push({ ticker: f.ticker, nav: f.navSymbol, out, n, first, last, blocks: blocks.map((b) => `${cal[b.startIdx]}..${cal[b.endIdx]} (${b.rows} rows, ${b.side})`) });
  // B
  let runStart = 0;
  for (let k = 1; k <= V.idx.length; k++) if (k === V.idx.length || V.close[k] !== V.close[k - 1]) { if (k - runStart >= 5) for (let m = runStart + 1; m < k; m++) flatCount.set(V.idx[m], (flatCount.get(V.idx[m]) || 0) + 1); runStart = k; }
}
console.log("A. UNIT SCREEN: funds with any row where price/NAV is outside 0.5..2.0:", unit.length, "of", both.length);
for (const u of unit.sort((a, b) => b.out - a.out)) console.log(`   ${u.ticker}/${u.nav}: ${u.out} of ${u.n} rows, ${u.first}..${u.last}; blocks: ${u.blocks.slice(0, 6).join("; ")}${u.blocks.length > 6 ? `; +${u.blocks.length - 6} more` : ""}`);
same.sort((a, b) => b.share - a.share);
console.log(`\nD. IDENTITY SCREEN: share of rows where the NAV series equals the price exactly: median ${(100 * same[same.length >> 1].share).toFixed(2)}%, highest: ${same.slice(0, 6).map((s) => `${s.t}/${s.nav} ${(100 * s.share).toFixed(1)}% (${s.eq}/${s.m})`).join(" | ")}`);
// B: how many funds alive (both series) on each day, to express the stale count as a share
const alive = new Array(cal.length).fill(0); for (const f of both) { const a = cal.indexOf(f.navFirst), b = cal.indexOf(f.navLast); for (let i = a; i <= b; i++) alive[i]++; }
const days = [...flatCount.entries()].map(([i, c]) => ({ i, c, share: c / alive[i] })).filter((d) => alive[d.i] >= 20);
console.log("\nB. STALE-FEED SCREEN: market days with the largest SHARE of funds inside a 5+ row flat NAV run:");
console.log("   " + days.sort((a, b) => b.share - a.share).slice(0, 30).map((d) => `${cal[d.i]}:${d.c}/${alive[d.i]}`).join(" "));
const big = days.filter((d) => d.share >= 0.25).sort((a, b) => a.i - b.i); const stretches = []; let s = null;
for (const d of big) { if (s && d.i - s.end <= 2) { s.end = d.i; s.max = Math.max(s.max, d.share); } else { s = { start: d.i, end: d.i, max: d.share }; stretches.push(s); } }
console.log("   stretches where 25%+ of funds are flat at once:", stretches.map((x) => `${cal[x.start]}..${cal[x.end]} (peak ${(100 * x.max).toFixed(0)}%)`).join(" | ") || "none");
const byYear = {}; for (const d of days) { const y = cal[d.i].slice(0, 4); byYear[y] = byYear[y] || { fundDays: 0, alive: 0 }; byYear[y].fundDays += d.c; } for (let i = 0; i < cal.length; i++) { const y = cal[i].slice(0, 4); if (byYear[y]) byYear[y].alive += alive[i]; }
console.log("   share of fund-days inside a 5+ row flat NAV run, by year:", Object.entries(byYear).sort().map(([y, v]) => `${y}:${(100 * v.fundDays / v.alive).toFixed(1)}%`).join(" "));
// C
const gapDays = (f) => Math.round((Date.parse(f.navFirst) - Date.parse(f.priceFirst)) / 864e5);
const within = both.filter((f) => Math.abs(gapDays(f)) <= 90), later = both.filter((f) => gapDays(f) > 90), earlier = both.filter((f) => gapDays(f) < -90);
console.log(`\nC. START SCREEN: NAV history starts within 90 days of the price history: ${within.length}; NAV starts more than 90 days AFTER the price: ${later.length}; NAV starts more than 90 days BEFORE the price (was unlisted or another kind of fund first): ${earlier.length} [${earlier.map((f) => `${f.ticker} nav ${f.navFirst} price ${f.priceFirst}`).join("; ")}]`);
const lt = {}; for (const f of later) lt[f.navFirst.slice(0, 7)] = (lt[f.navFirst.slice(0, 7)] || 0) + 1; console.log("   NAV-starts-late funds, by the month their NAV history begins (top):", Object.entries(lt).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}:${v}`).join(" "));
const exact = {}; for (const f of both) exact[f.navFirst] = (exact[f.navFirst] || 0) + 1; console.log("   most common NAV first dates:", Object.entries(exact).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(" "));
console.log("   list inception vs price first (price history cut off at the front, by more than a year):", U.filter((f) => f.priceRows && f.inception && Date.parse(f.priceFirst) - Date.parse(f.inception) > 366 * 864e5).map((f) => `${f.ticker}(inc ${f.inception}, price ${f.priceFirst})`).join(" "));
