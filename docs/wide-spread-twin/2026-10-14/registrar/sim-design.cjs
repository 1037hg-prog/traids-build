#!/usr/bin/env node
"use strict";
/** REGISTRAR SIMULATION (2026-10-14 evening). READ-ONLY on house files; writes nothing. The RESOLVED design's pass rate in synthetic
 *  windows, so the numbers the entry quotes for its gates come from the gates as registered (not the draft's):
 *    graded  t_loss = -t of the per-session sums X_s of band broker dollars >= BAR (2.708)
 *    G1 sum(X) < 0 · G2 without the worst session < 0 · G2b without the worst symbol < 0 · G3 both halves < 0
 *    G4 placebo, ratio of sums (sum pnl / sum notional over all band sessions; each draw: k_s tickets per session drawn without
 *       replacement from all of that session's tickets, pooled the same way), p < 0.10
 *    G5 bootstrap-t of the centred X_s (one-sided), p <= 0.00465 (the 1 - 0.95^(1/11) tail the bar stands for)
 *  Tickets are resampled WHOLE from attack-1-sims/holds.json (the 78 closed mirrored tickets: per-dollar return and symbol together),
 *  centred, shifted per world; band tickets take band notionals, rest tickets rest notionals ("model A"). The null is also run on
 *  "model B" (current-era band-sized dollars as recorded, right-skewed) for the graded t and G5. k_s / m_s band and rest tickets per
 *  band session from the preview's six current-era band sessions. No within-session common factor (a tape factor cancels inside the
 *  placebo), no name-level persistence of returns: both are stated as limits in DEFECTS-RESOLVED.md.
 *    node docs/wide-spread-twin/2026-10-14/registrar/sim-design.cjs [trials=1000] [placeboDraws=200] [bootDraws=1000]   (minutes) */
const fs = require("fs"), path = require("path");
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const H = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "attack-1-sims", "holds.json"), "utf8"));
const TR = +process.argv[2] || 1000, DP = +process.argv[3] || 200, DB = +process.argv[4] || 1000, BAR = 2.708, PMAX = 0.10, BOOTP = 1 - Math.pow(0.95, 1 / 11);
const rng = mulberry(20261015), pick = (a) => a[Math.floor(rng() * a.length)];
const ret = H.map((h) => h.pnl / h.notional), mr = ret.reduce((a, b) => a + b, 0) / ret.length;
const TK = H.map((h) => ({ r: h.pnl / h.notional - mr, sym: h.sym }));
const bandNot = H.filter((h) => h.b === "30-100").map((h) => h.notional), restNot = H.filter((h) => h.b !== "30-100").map((h) => h.notional);
const curBand = H.filter((h) => h.era === "current").map((h) => ({ usd: h.pnl, sym: h.sym })); const mu = curBand.reduce((a, b) => a + b.usd, 0) / curBand.length;
const bandScale = bandNot.reduce((a, b) => a + b, 0) / bandNot.length / (H.filter((h) => h.era === "current").reduce((a, h) => a + h.notional, 0) / curBand.length);
const K = [2, 3, 4, 1, 3, 2], M = [0, 10, 5, 7, 3, 2];
const tOf = (a) => { const n = a.length; let m = 0; for (const x of a) m += x; m /= n; let v = 0; for (const x of a) v += (x - m) ** 2; v /= n - 1; return m / Math.sqrt(v / n); };
function windowOf(n, bs, rs, model) {
  const S = [];
  for (let i = 0; i < n; i++) {
    const k = pick(K), m = pick(M), tot = k + m, P = new Float64Array(tot), N = new Float64Array(tot), Y = [];
    for (let j = 0; j < tot; j++) { const band = j < k;
      if (model === "B" && band) { const t = pick(curBand); N[j] = pick(bandNot); P[j] = (t.usd - mu) * bandScale + bs * N[j]; Y.push(t.sym); }
      else { const t = pick(TK); N[j] = band ? pick(bandNot) : pick(restNot); P[j] = (t.r + (band ? bs : rs)) * N[j]; Y.push(t.sym); } }
    let X = 0; for (let j = 0; j < k; j++) X += P[j];
    S.push({ k, tot, P, N, X, Y });
  }
  return S;
}
function gates(S, withPlacebo) {
  const n = S.length, X = S.map((s) => s.X), tl = -tOf(X), sum = X.reduce((a, b) => a + b, 0);
  const g1 = sum < 0, g2 = sum - Math.min(...X) < 0, h = Math.floor(n / 2), g3 = X.slice(0, h).reduce((a, b) => a + b, 0) < 0 && X.slice(h).reduce((a, b) => a + b, 0) < 0;
  const bySym = {}; for (const s of S) for (let j = 0; j < s.k; j++) bySym[s.Y[j]] = (bySym[s.Y[j]] || 0) + s.P[j];
  const worstSym = Math.min(...Object.values(bySym)), g2b = sum - Math.min(0, worstSym) < 0;
  // G5: bootstrap-t of the centred X_s, one-sided in the loss direction
  const m = sum / n, C = X.map((x) => x - m); let ge = 0;
  for (let b = 0; b < DB; b++) { const Z = new Array(n); for (let i = 0; i < n; i++) Z[i] = C[Math.floor(rng() * n)]; if (-tOf(Z) >= tl) ge++; }
  const g5 = (1 + ge) / (1 + DB) <= BOOTP;
  let pRS = null, pMR = null;
  if (withPlacebo) {
    let PB = 0, NB = 0, yMR = 0; for (const s of S) { let p = 0, q = 0; for (let j = 0; j < s.k; j++) { p += s.P[j]; q += s.N[j]; } PB += p; NB += q; yMR += p / q; }
    const band = PB / NB; yMR /= n; let leRS = 0, leMR = 0; const idx = new Int32Array(32);
    for (let d = 0; d < DP; d++) { let P = 0, N = 0, acc = 0; for (const s of S) { for (let j = 0; j < s.tot; j++) idx[j] = j; let p = 0, q = 0; for (let j = 0; j < s.k; j++) { const r = j + Math.floor(rng() * (s.tot - j)); const t = idx[j]; idx[j] = idx[r]; idx[r] = t; p += s.P[idx[j]]; q += s.N[idx[j]]; } P += p; N += q; acc += p / q; } if (P / N <= band) leRS++; if (acc / n <= yMR) leMR++; }
    pRS = (1 + leRS) / (1 + DP); pMR = (1 + leMR) / (1 + DP);
  }
  return { tl, clear: tl >= BAR, g1, g2, g2b, g3, g5, pRS, pMR };
}
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : "-");
console.log(`REGISTRAR SIM: ${TR} windows a world, placebo ${DP} draws, bootstrap ${DB} draws; bar ${BAR}; G4 p < ${PMAX}; G5 p <= ${BOOTP.toFixed(5)}`);
for (const n of [60, 100]) {
  for (const [lab, bs, rs, model] of [["NULL model A (zero edge, zero cost)", 0, 0, "A"], ["NULL model B (band dollars as recorded, skewed)", 0, 0, "B"], ["COST ONLY band -30 bps", -0.003, 0, "A"], ["COST ONLY band -45 bps", -0.0045, 0, "A"], ["BOARD-WIDE every ticket -30 bps", -0.003, -0.003, "A"], ["BOARD-WIDE every ticket -45 bps", -0.0045, -0.0045, "A"], ["BOARD-WIDE every ticket -60 bps", -0.006, -0.006, "A"]]) {
    let cl = 0, pass = 0, g4rs = 0, g4rs50 = 0, g4mr = 0, g5c = 0, signC = 0, passNoG5 = 0, sdS = 0;
    for (let i = 0; i < TR; i++) { const S = windowOf(n, bs, rs, model); const X = S.map((s) => s.X); const m = X.reduce((a, b) => a + b, 0) / n; sdS += Math.sqrt(X.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
      if (-tOf(X) < BAR) continue; const g = gates(S, true); cl++;
      const sign = g.g1 && g.g2 && g.g2b && g.g3; if (sign) signC++; if (g.pRS < PMAX) g4rs++; if (g.pRS < 0.5) g4rs50++; if (g.pMR < PMAX) g4mr++; if (g.g5) g5c++;
      if (sign && g.pRS < PMAX) passNoG5++; if (sign && g.pRS < PMAX && g.g5) pass++; }
    console.log(`n ${String(n).padStart(3)} ${lab.padEnd(48)} t clears ${pct(cl, TR).padStart(6)} | PASS (all gates) ${pct(pass, TR).padStart(6)} | given a clear: G1-G3+G2b ${pct(signC, cl)}, G4 ratio-of-sums p<0.10 ${pct(g4rs, cl)} (p<0.5 ${pct(g4rs50, cl)}; mean-of-ratios p<0.10 ${pct(g4mr, cl)}), G5 ${pct(g5c, cl)}; PASS without G5 ${pct(passNoG5, TR)} | mean session sd $${(sdS / TR).toFixed(0)}`);
  }
}
