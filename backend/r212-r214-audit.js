#!/usr/bin/env node
/** Audit of the two MINE-6 passes (R212, R214), 2026-09-24. EXPLORATORY — the sealed verdicts stand as sealed; this asks what the
 *  passes are made of. R212: is month-end special among all window positions; does it survive the dollar's own month-to-date move
 *  (EFA is priced in dollars, so the signal carries the dollar); halves; a close-based exit. R214: overnight-only GLD vs simply holding
 *  GLD (alpha on GLD, Sharpe), halves.  node backend/r212-r214-audit.js */
const path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function ols(y, X) { // y ~ X (with intercept); returns coef and t via plain OLS
  const n = y.length, k = X[0].length + 1, A = X.map((r) => [1, ...r]); const XtX = Array.from({ length: k }, () => Array(k).fill(0)), Xty = Array(k).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) { Xty[a] += A[i][a] * y[i]; for (let b = 0; b < k; b++) XtX[a][b] += A[i][a] * A[i][b]; }
  const inv = (M) => { const m = M.length, I = M.map((r, i) => [...r, ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0))]); for (let c = 0; c < m; c++) { let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(I[r][c]) > Math.abs(I[p][c])) p = r; [I[c], I[p]] = [I[p], I[c]]; const v = I[c][c]; for (let j = 0; j < 2 * m; j++) I[c][j] /= v; for (let r = 0; r < m; r++) if (r !== c) { const f = I[r][c]; for (let j = 0; j < 2 * m; j++) I[r][j] -= f * I[c][j]; } } return I.map((r) => r.slice(m)); };
  const Vi = inv(XtX), b = Vi.map((r) => r.reduce((s, v, j) => s + v * Xty[j], 0)); const res = y.map((v, i) => v - A[i].reduce((s, x, j) => s + x * b[j], 0)); const s2 = res.reduce((s, e) => s + e * e, 0) / (n - k);
  return b.map((v, j) => ({ coef: v, t: v / Math.sqrt(s2 * Vi[j][j]) }));
}
(async () => {
  const { bars } = await fetchBars(["SPY", "EFA", "UUP", "GLD"], { start: "2015-11-01", end: "2026-08-31", feed: "sip", adjustment: "all", quiet: true });
  const B = {}; for (const s of Object.keys(bars)) B[s] = bars[s].map((b) => ({ d: b.t.slice(0, 10), o: b.o, c: b.c }));
  const out = {};
  // ---- R212 ----
  { const im = (s) => new Map(B[s].map((b, i) => [b.d, i])), iS = im("SPY"), iE = im("EFA"), U = B.UUP, M = {};
    U.forEach((b, i) => (M[b.d.slice(0, 7)] = M[b.d.slice(0, 7)] || []).push(i)); const keys = Object.keys(M).sort(), ms = keys.filter((m) => m >= "2016-01" && m <= "2026-08");
    function rows(kOf, exitClose) { const o = [];
      for (const m of ms) { const ix = M[m], prev = M[keys[keys.indexOf(m) - 1]]; if (!prev || ix.length < 15) continue; const k = kOf(ix.length); if (k < 1 || k + 3 >= ix.length) continue;
        const e = ix[k], x = ix[k + 3], pl = U[prev[prev.length - 1]].d, ed = U[e].d; const a = (s, I) => B[s][I.get(ed)].c / B[s][I.get(pl)].c - 1;
        if (!iS.has(ed) || !iE.has(ed) || !iS.has(pl) || !iE.has(pl)) continue; const S = a("SPY", iS) - a("EFA", iE), usdMTD = U[e].c / U[prev[prev.length - 1]].c - 1;
        const win = exitClose ? U[ix[k + 2]].c / U[e].c - 1 : U[x].o / U[e].c - 1; const other = ix.filter((j, q) => q !== 0 && (q < k + 1 || q > k + 3)).map((j) => U[j].c / U[j - 1].c - 1);
        const ex = win - (exitClose ? 2 : 3) * mean(other); o.push({ m, S, usdMTD, ex, v: (S > 0 ? -1 : 1) * ex - 0.0004 }); }
      return o; }
    const R = rows((L) => L - 4); const pos = {}; for (let k = 1; k <= 17; k++) { const r = rows(() => k); if (r.length > 100) pos[`start${k}`] = +tOf(r.map((x) => x.v)).toFixed(2); }
    const fromEnd = {}; for (let j = 4; j <= 12; j++) { const r = rows((L) => L - j); fromEnd[`L-${j}`] = +tOf(r.map((x) => x.v)).toFixed(2); }
    const reg1 = ols(R.map((x) => x.ex), R.map((x) => [x.S])), reg2 = ols(R.map((x) => x.ex), R.map((x) => [x.S, x.usdMTD]));
    const usdOnly = R.map((x) => (x.usdMTD > 0 ? -1 : 1) * x.ex - 0.0004); const agree = R.filter((x) => Math.sign(x.S) === -Math.sign(x.usdMTD)).length;
    const h1 = R.filter((x) => x.m < "2021-05"), h2 = R.filter((x) => x.m >= "2021-05");
    out.R212 = { primary_t: +tOf(R.map((x) => x.v)).toFixed(2), windowStartFromMonthStart_t: pos, windowStartFromMonthEnd_t: fromEnd,
      regression_excess_on_S: { slope_t: +reg1[1].t.toFixed(2) }, regression_excess_on_S_and_usdMTD: { S_t: +reg2[1].t.toFixed(2), usdMTD_t: +reg2[2].t.toFixed(2) },
      corr_S_usdMTD: +(() => { const a = R.map((x) => x.S), b = R.map((x) => x.usdMTD), ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; a.forEach((v, i) => { c += (v - ma) * (b[i] - mb); va += (v - ma) ** 2; vb += (b[i] - mb) ** 2; }); return c / Math.sqrt(va * vb); })().toFixed(2),
      usdReversalOnlyRule_t: +tOf(usdOnly).toFixed(2), signAgreement: `${agree}/${R.length}`, half1_t: +tOf(h1.map((x) => x.v)).toFixed(2), half2_t: +tOf(h2.map((x) => x.v)).toFixed(2), closeExit_t: +tOf(rows((L) => L - 4, true).map((x) => x.v)).toFixed(2) }; }
  // ---- R214 ----
  { const G = B.GLD, rows = []; for (let i = 1; i < G.length; i++) if (G[i].d >= "2016-01-01") rows.push({ d: G[i].d, on: G[i].o / G[i - 1].c - 1 - 0.0002, cc: G[i].c / G[i - 1].c - 1 });
    const mo = {}; for (const r of rows) { const m = r.d.slice(0, 7); mo[m] = mo[m] || { on: 1, cc: 1 }; mo[m].on *= 1 + r.on; mo[m].cc *= 1 + r.cc; } const mm = Object.keys(mo).sort(), on = mm.map((m) => mo[m].on - 1), cc = mm.map((m) => mo[m].cc - 1);
    const reg = ols(on, cc.map((x) => [x])); const sh = (a) => (mean(a) / sd(a)) * Math.sqrt(12); const cagr = (a) => (a.reduce((p, x) => p * (1 + x), 1) ** (12 / a.length) - 1) * 100;
    const dd = (a) => { let p = 1, pk = 1, m = 0; for (const x of a) { p *= 1 + x; pk = Math.max(pk, p); m = Math.min(m, p / pk - 1); } return +(100 * m).toFixed(1); };
    const half = (lo, hi) => { const i = mm.map((m, j) => [m, j]).filter(([m]) => m >= lo && m < hi).map(([, j]) => j); const r = ols(i.map((j) => on[j]), i.map((j) => [cc[j]])); return { alpha_t: +r[0].t.toFixed(2), beta: +r[1].coef.toFixed(2) }; };
    out.R214 = { overnightNet: { cagrPct: +cagr(on).toFixed(1), sharpe: +sh(on).toFixed(2), maxDDPct: dd(on) }, holdGLD: { cagrPct: +cagr(cc).toFixed(1), sharpe: +sh(cc).toFixed(2), maxDDPct: dd(cc) },
      alphaOnGLD: { alphaMonthlyPct: +(100 * reg[0].coef).toFixed(3), alpha_t: +reg[0].t.toFixed(2), beta: +reg[1].coef.toFixed(2) }, half2016_2020: half("2016-01", "2021-05"), half2021_2026: half("2021-05", "2026-09") }; }
  writeJsonAtomic(path.join(__dirname, "data", "r212-r214-audit.json"), { ranAt: new Date().toISOString(), exploratory: true, out });
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
