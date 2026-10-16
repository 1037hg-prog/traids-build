"use strict";
/**
 * Shared machinery for the ensemble-architect's measurement (measure-library.js) and the R201 read (read-ensemble-1.js).
 * Read-only on the library; the only files written are caches under backend/data/strategy-library/_cache/ (SPY and BTC daily).
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const LIB = path.join(__dirname, "..", "data", "strategy-library");
const CACHE = path.join(LIB, "_cache", "benchmarks"); if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => { let s = 0; for (const x of a) s += x; return s / a.length; };
const sdOf = (a) => { const m = mean(a); let s = 0; for (const x of a) s += (x - m) ** 2; return Math.sqrt(s / (a.length - 1)); };
/** Newey-West t of the mean, Bartlett weights, lag L. */
function nwT(a, L = 5) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = 0; for (const x of d) v += x * x; v /= n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function corr(a, b) { const n = a.length; if (n < 3) return null; const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; } return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null; }
/** OLS y = X b (X includes the intercept column); returns { b, resid, nwT[] } with Newey-West (lag L) standard errors. */
function ols(y, X, L = 5) {
  const n = y.length, k = X[0].length, XtX = Array.from({ length: k }, () => new Array(k).fill(0)), Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) { Xty[a] += X[i][a] * y[i]; for (let c = 0; c < k; c++) XtX[a][c] += X[i][a] * X[i][c]; }
  const inv = invert(XtX), b = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const e = y.map((yi, i) => yi - X[i].reduce((s, v, j) => s + v * b[j], 0));
  // NW meat: S = sum_l w_l sum_i (x_i e_i)(x_{i-l} e_{i-l})' (+ transpose)
  const S = Array.from({ length: k }, () => new Array(k).fill(0)), u = X.map((xi, i) => xi.map((v) => v * e[i]));
  for (let l = 0; l <= L; l++) { const w = l === 0 ? 1 : 1 - l / (L + 1); for (let i = l; i < n; i++) for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) { const g = u[i][a] * u[i - l][c]; S[a][c] += w * g; if (l > 0) S[c][a] += w * g; } }
  const V = mul(mul(inv, S), inv), se = V.map((row, i) => Math.sqrt(row[i]));
  return { b, resid: e, t: b.map((v, i) => (se[i] > 0 ? v / se[i] : null)), se };
}
function mul(A, B) { return A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0))); }
function invert(M) { const n = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; const d = A[c][c]; if (Math.abs(d) < 1e-300) throw new Error("singular"); for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; } }
  return A.map((r) => r.slice(n)); }
/** Jacobi eigenvalues of a symmetric matrix. */
function eigSym(M) { const n = M.length, A = M.map((r) => [...r]); for (let sweep = 0; sweep < 100; sweep++) { let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2; if (off < 1e-18) break;
  for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) { if (Math.abs(A[p][q]) < 1e-15) continue; const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
    for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; } } }
  return A.map((r, i) => r[i]).sort((a, b) => b - a); }

// ---- benchmarks -------------------------------------------------------------------------------------------------------------
async function spyDaily(end = "2026-09-23") {
  const f = path.join(CACHE, `SPY-${end}.json`); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const { fetchBars } = require("../lib/alpaca-bars.js");
  const { bars } = await fetchBars(["SPY"], { start: "2015-06-01", end: end + "T23:59:59Z", feed: "sip", adjustment: "all", timeframe: "1Day", requireAll: true, quiet: true });
  const rows = bars.SPY.map((b) => ({ d: b.t.slice(0, 10), c: b.c }));
  writeJsonAtomic(f, rows, { pretty: 0 }); return rows;
}
async function btcDaily(end = "2026-09-23") {
  const f = path.join(CACHE, `BTC-${end}.json`); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const all = []; let e = Date.parse(end + "T00:00:00Z") + 864e5; const stop = Date.parse("2015-06-01T00:00:00Z");
  while (e > stop) { const s = Math.max(stop, e - 299 * 864e5);
    const r = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`, { headers: { "User-Agent": "TRAIDS ensemble" }, signal: AbortSignal.timeout(30000) });
    const a = await r.json(); if (!Array.isArray(a)) throw new Error("coinbase candles: " + JSON.stringify(a).slice(0, 120)); all.push(...a); e = s - 864e5; await new Promise((z) => setTimeout(z, 350)); }
  const rows = [...new Map(all.map((x) => [x[0], x])).values()].sort((a, b) => a[0] - b[0]).map((x) => ({ d: new Date(x[0] * 1000).toISOString().slice(0, 10), c: x[4] })).filter((x) => x.d <= end);
  writeJsonAtomic(f, rows, { pretty: 0 }); return rows;
}
const toRet = (rows) => { const m = new Map(); for (let i = 1; i < rows.length; i++) m.set(rows[i].d, rows[i].c / rows[i - 1].c - 1); return m; };

// ---- library ----------------------------------------------------------------------------------------------------------------
function loadLibrary() {
  const out = [];
  for (const f of fs.readdirSync(LIB).filter((x) => x.endsWith(".json") && !x.startsWith("index") && !x.startsWith("correlation") && !x.startsWith("_"))) {
    const e = JSON.parse(fs.readFileSync(path.join(LIB, f), "utf8")); if (e.spec !== "strategy-library-entry-v1") continue; out.push(e);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
/** Every calendar day from a to b inclusive. */
function days(a, b) { const o = []; for (let t = Date.parse(a + "T00:00:00Z"); t <= Date.parse(b + "T00:00:00Z"); t += 864e5) o.push(new Date(t).toISOString().slice(0, 10)); return o; }
/**
 * Dense view: for each entry, a Map date->r over its LIVE dates (inside window AND on its calendar), flat days = 0.
 * sessions = Set of US session dates (SPY bar dates).
 */
function liveMap(e, sessions) {
  const m = new Map(), s = new Map(e.series.map((x) => [x.d, x.r]));
  for (const d of days(e.window[0], e.window[1])) { if (e.calendar === "us-equity" && !sessions.has(d)) continue; m.set(d, s.get(d) || 0); }
  for (const [d] of s) if (!m.has(d)) throw new Error(`${e.id}: series date ${d} not on its calendar`);
  return m;
}
/** Wildcard table lookup: exact id, else "PREFIX-*" / "PREFIX*" patterns. */
function lookup(table, id) {
  if (Array.isArray(table)) return table.some((p) => p === id || (p.endsWith("*") && id.startsWith(p.replace(/\*$/, ""))));
  if (table[id] !== undefined) return table[id];
  for (const k of Object.keys(table)) if (k.endsWith("*") && id.startsWith(k.replace(/\*$/, ""))) return table[k];
  return undefined;
}
module.exports = { mulberry, mean, sdOf, nwT, corr, ols, eigSym, spyDaily, btcDaily, toRet, loadLibrary, liveMap, days, lookup, LIB };
