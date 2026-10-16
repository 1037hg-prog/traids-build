#!/usr/bin/env node
"use strict";
/** ATTACK 1, step 3. READ-ONLY. How often the drafted placebo gate G4 (p < 0.5) passes GIVEN the graded t clears, in a world
 *  where the spread does not matter and the whole board loses at the broker ("board-wide"), against a world where only the band
 *  pays a cost ("cost only"). Same placebo as rule [10]: per band session draw k_s tickets without replacement from all of that
 *  session's tickets, Y_s = sum pnl / sum notional, average over band sessions, p = (1 + #draws <= band) / (1 + D).
 *  Tickets: centred per-dollar returns of the 78 closed mirrored tickets, plus a shift; band notionals from the band, rest from
 *  the rest; k_s band and m_s rest tickets per session from the preview's six current-era band sessions. Stricter variants shown
 *  beside: p < 0.10, and the paired per-session band-minus-rest contrast (bps) with t >= 1.282 / 1.657.
 *  Assumes no common within-session factor (a tape factor cancels inside the placebo, so the true conditional rate lies between
 *  50% and the printed figure).
 *    node docs/wide-spread-twin/2026-10-14/attack-1-sims/3-g4-conditional.cjs [n=60] [trials=3000] [bar=2.708]   (minutes)   */
const fs = require("fs"), path = require("path");
const { mulberry, tOf } = require("./_root.cjs");
const H = JSON.parse(fs.readFileSync(path.join(__dirname, "holds.json"), "utf8"));
const n = +process.argv[2] || 60, TR = +process.argv[3] || 3000, BAR = +process.argv[4] || 2.708, D = 200;
const rng = mulberry(9191), pick = (a) => a[Math.floor(rng() * a.length)];
const ret = H.map((h) => h.pnl / h.notional), m = ret.reduce((a, b) => a + b, 0) / ret.length, cret = ret.map((r) => r - m);
const bandNot = H.filter((h) => h.b === "30-100").map((h) => h.notional), restNot = H.filter((h) => h.b !== "30-100").map((h) => h.notional);
const K = [2, 3, 4, 1, 3, 2], M = [0, 10, 5, 7, 3, 2];   // band and rest counted tickets in the preview's band sessions 10-01 .. 10-08
function trial(bs, rs) {
  const S = [];
  for (let i = 0; i < n; i++) {
    const k = pick(K), mm = pick(M), tot = k + mm, P = new Float64Array(tot), N = new Float64Array(tot);
    for (let j = 0; j < tot; j++) { const band = j < k; N[j] = band ? pick(bandNot) : pick(restNot); P[j] = (pick(cret) + (band ? bs : rs)) * N[j]; }
    let X = 0, NB = 0, XR = 0, NR = 0; for (let j = 0; j < tot; j++) { if (j < k) { X += P[j]; NB += N[j]; } else { XR += P[j]; NR += N[j]; } }
    S.push({ k, tot, P, N, X, yb: X / NB, yr: NR > 0 ? XR / NR : null });
  }
  const X = S.map((s) => s.X), tl = -tOf(X);
  let ybar = 0; for (const s of S) ybar += s.yb; ybar /= n;
  let le = 0; const idx = new Int32Array(20);
  for (let d = 0; d < D; d++) { let acc = 0; for (const s of S) { for (let j = 0; j < s.tot; j++) idx[j] = j; for (let j = 0; j < s.k; j++) { const r = j + Math.floor(rng() * (s.tot - j)); const t = idx[j]; idx[j] = idx[r]; idx[r] = t; } let P = 0, N = 0; for (let j = 0; j < s.k; j++) { P += s.P[idx[j]]; N += s.N[idx[j]]; } acc += P / N; } if (acc / n <= ybar) le++; }
  const diffs = S.filter((s) => s.yr != null).map((s) => s.yr - s.yb);
  let mu = 0, sd = 0; for (const x of X) mu += x; mu /= n; for (const x of X) sd += (x - mu) ** 2; sd = Math.sqrt(sd / (n - 1));
  return { tl, p: (1 + le) / (1 + D), tc: diffs.length > 2 ? tOf(diffs) : 0, sd };
}
const worlds = [["NULL: band = rest = 0", 0, 0], ["COST ONLY: band -30 bps, rest 0", -0.003, 0], ["COST ONLY: band -45 bps, rest 0", -0.0045, 0], ["BOARD-WIDE: every ticket -30 bps", -0.003, -0.003], ["BOARD-WIDE: every ticket -45 bps", -0.0045, -0.0045], ["BOARD-WIDE: every ticket -60 bps", -0.006, -0.006]];
for (const [lab, bs, rs] of worlds) {
  let cl = 0, g4 = 0, a = 0, b = 0, c = 0, d = 0, sdS = 0;
  for (let i = 0; i < TR; i++) { const r = trial(bs, rs); sdS += r.sd; if (r.p < 0.5) g4++; if (r.tl >= BAR) { cl++; if (r.p < 0.5) a++; if (r.p < 0.1) b++; if (r.tc >= 1.282) c++; if (r.tc >= 1.657) d++; } }
  const f = (x) => (cl ? (100 * x / cl).toFixed(0) + "%" : "-");
  console.log(`${lab.padEnd(34)} n ${n} bar ${BAR}: G4 alone ${(100 * g4 / TR).toFixed(0)}% | t clears ${(100 * cl / TR).toFixed(1)}% | GIVEN a clear: G4 (p<0.5) ${f(a)} | p<0.10 ${f(b)} | contrast t>=1.282 ${f(c)} | t>=1.657 ${f(d)} | mean session sd $${(sdS / TR).toFixed(0)}`);
}
