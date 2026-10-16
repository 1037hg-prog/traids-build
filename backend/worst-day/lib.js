"use strict";
/**
 * WORST-DAY PREDICTOR, shared pieces: data loading, point-in-time features, labels, the logistic learner. Read-only; no network.
 * Every input is stamped with the time its last tick could have printed. The decision is made at the 16:00 ET close of day t, for the
 * close-to-close return of day t+1.
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const TR = path.join(ROOT, "data", "training", "worst-day");
const fin = Number.isFinite;
const isWeekend = (d) => { const g = new Date(d + "T12:00:00Z").getUTCDay(); return g === 0 || g === 6; };
const dayNum = (d) => Math.round(Date.parse(d + "T12:00:00Z") / 86400000);

// ── loaders ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function loadYahoo(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(TR, `yahoo-${sym}.json`), "utf8"));
  const out = []; let prev = "";
  for (const r of j.rows) {
    if (!r.date || !fin(r.close) || !fin(r.adjClose) || !(r.close > 0) || !(r.adjClose > 0)) continue;
    if (isWeekend(r.date)) continue;
    if (r.date <= prev) continue;                                   // strictly increasing dates only
    prev = r.date; out.push({ d: r.date, c: r.close, a: r.adjClose, v: r.volume });
  }
  return out;
}
function loadFred(id) {
  const L = fs.readFileSync(path.join(TR, "fred", `${id}.csv`), "utf8").trim().split(/\r?\n/);
  if (L[0] !== `observation_date,${id}`) throw new Error(`FRED ${id}: header ${L[0]}`);
  const out = [];
  for (const l of L.slice(1)) { const [d, v] = l.split(","); const x = Number(v); if (v !== "" && v !== "." && fin(x) && x > 0) out.push({ d, v: x }); }
  return out;
}
/** Schwab r313 daily rows (price only) for one symbol, sessions only. */
function loadSchwab313(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "training", "r313", "bars-schwab-daily-19990101-20261001.json"), "utf8"));
  return j.rows[sym].filter((x) => !isWeekend(x[0])).map((x) => ({ d: x[0], c: x[4] }));
}
function fomcDates() {
  const set = new Set(JSON.parse(fs.readFileSync(path.join(TR, "fed-fomc-2005-2015.json"), "utf8")).meetings);
  // the repo's own list (backend/r196-pre-fomc.js, hard-coded array, read as text: the runner is not executed)
  const src = fs.readFileSync(path.join(ROOT, "r196-pre-fomc.js"), "utf8");
  const a = src.indexOf("const FOMC = ["), b = src.indexOf("].filter", a);
  const r196 = [...src.slice(a, b).matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
  const mc = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "macro-calendar.json"), "utf8")).FOMC;
  const fed = new Set(set);
  for (const d of r196) set.add(d);
  for (const d of mc) set.add(d);
  return { all: [...set].sort(), nFed: fed.size, nR196: r196.length, nMacro: mc.length, r196, macro: mc, fedList: [...fed].sort() };
}

// ── statistics helpers ───────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => { let s = 0, n = 0; for (const x of a) if (fin(x)) { s += x; n++; } return n ? s / n : NaN; };
const sd = (a) => { const m = mean(a); let s = 0, n = 0; for (const x of a) if (fin(x)) { s += (x - m) ** 2; n++; } return n > 1 ? Math.sqrt(s / (n - 1)) : NaN; };
/** nearest-rank quantile: the ceil(p*n)-th smallest */
const qLow = (a, p) => { const s = Float64Array.from(a).sort(); return s[Math.max(0, Math.ceil(p * s.length) - 1)]; };
/** nearest-rank upper quantile: the ceil(p*n)-th LARGEST (p = 0.05 -> the 5% best days boundary) */
const qHigh = (a, p) => { const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, s.length - Math.ceil(p * s.length))]; };

// ── logistic regression, L2, Newton / IRLS ───────────────────────────────────────────────────────────────────────────
function solveLin(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / d; if (!f) continue; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const CLAMP = 5;
/** Fits on rows idx of X (arrays of numbers, NaN allowed) and y (0/1). Standardises with the TRAINING rows only; NaN -> training mean (0 after
 *  standardising). Fixed ridge lambda; the intercept is not penalised. */
function logitFit(X, y, idx, { lambda = 10, iters = 60 } = {}) {
  const p = X[idx[0]].length, mu = new Array(p).fill(0), sg = new Array(p).fill(1);
  for (let f = 0; f < p; f++) { const v = idx.map((i) => X[i][f]).filter(fin); if (v.length) { mu[f] = mean(v); const s = sd(v); sg[f] = s > 1e-9 ? s : 1; } }
  const Z = (x) => { const z = new Array(p + 1); for (let f = 0; f < p; f++) { const v = fin(x[f]) ? (x[f] - mu[f]) / sg[f] : 0; z[f] = Math.max(-CLAMP, Math.min(CLAMP, v)); } z[p] = 1; return z; };
  const Zs = idx.map((i) => Z(X[i])), ys = idx.map((i) => y[i]);
  const w = new Array(p + 1).fill(0); const q = p + 1;
  w[p] = Math.log((mean(ys) + 1e-6) / (1 - mean(ys) + 1e-6));
  for (let it = 0; it < iters; it++) {
    const g = new Array(q).fill(0), H = Array.from({ length: q }, () => new Array(q).fill(0));
    for (let r = 0; r < Zs.length; r++) {
      const z = Zs[r]; let s = 0; for (let a = 0; a < q; a++) s += w[a] * z[a];
      const pr = sigmoid(s), e = pr - ys[r], v = Math.max(pr * (1 - pr), 1e-6);
      for (let a = 0; a < q; a++) { g[a] += e * z[a]; for (let c = 0; c <= a; c++) H[a][c] += v * z[a] * z[c]; }
    }
    for (let a = 0; a < q; a++) for (let c = a + 1; c < q; c++) H[a][c] = H[c][a];
    for (let a = 0; a < p; a++) { g[a] += lambda * w[a]; H[a][a] += lambda; }
    H[p][p] += 1e-9;
    const step = solveLin(H, g); let mx = 0;
    for (let a = 0; a < q; a++) { w[a] -= step[a]; mx = Math.max(mx, Math.abs(step[a])); }
    if (mx < 1e-8) break;
  }
  return { w, Z, mu, sg, p };
}
function logitPredict(m, x) { const z = m.Z(x); let s = 0; for (let a = 0; a <= m.p; a++) s += m.w[a] * z[a]; return sigmoid(s); }

module.exports = { loadYahoo, loadFred, loadSchwab313, fomcDates, mean, sd, qLow, qHigh, logitFit, logitPredict, isWeekend, dayNum, fin, TR, ROOT };
